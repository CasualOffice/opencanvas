// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Launch token verification (docs/05 §3, docs/07 §2).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jsonwebtoken::jwk::{AlgorithmParameters, JwkSet};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde::Deserialize;
use serde_json::Value;

use crate::grant::{FileRef, Grant, Perms, Role, User, derive_color, room_id};
use crate::hosts::{HostConfig, Hosts};

pub const AUDIENCE: &str = "opencanvas";
pub const MAX_TTL_SECS: i64 = 10 * 3600;
/// How long a fetched JWKS is trusted.
pub const JWKS_TTL: Duration = Duration::from_secs(600);
/// An unknown `kid` refetches the set at most this often (key rotation without a stampede).
const JWKS_MIN_REFRESH: Duration = Duration::from_secs(30);

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum JwtError {
    #[error("malformed token")]
    Malformed,
    #[error("unknown issuer")]
    UnknownHost,
    #[error("host has no usable key")]
    NoKey,
    #[error("token rejected: {0}")]
    Invalid(String),
    #[error("token lifetime exceeds 10h")]
    TooLong,
    /// An access token past its `exp` (HAPI-02: answered as `TOKEN_EXPIRED`).
    #[error("token expired")]
    Expired,
}

#[derive(Debug, Deserialize)]
struct FileClaim {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    version: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct UserClaim {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    detail: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchClaims {
    pub iss: String,
    pub exp: i64,
    /// Issued at (Unix seconds); a host role call made after it overrides `role`.
    #[serde(default)]
    pub iat: Option<i64>,
    pub jti: String,
    file: FileClaim,
    user: UserClaim,
    role: Role,
    #[serde(default)]
    perms: Option<Perms>,
    #[serde(default)]
    callback_token: Option<String>,
    /// docs/21 revision 2: the people with access to this canvas; read leniently, at most 500.
    #[serde(default)]
    members: Option<Value>,
    /// ADR-048: `"page"` opens a new canvas straight into the page, without the template
    /// picker. Any other value is ignored. Read leniently: a non-string never fails a launch.
    #[serde(default)]
    start: Option<Value>,
    /// LIVE-01: `[{fileId, role}]`, live files this person may see read-only when the host has
    /// no `/access` callback. Read leniently: bad entries are dropped, at most 50 kept.
    #[serde(default)]
    live: Option<Value>,
    /// OFF-01: why offline copies are unavailable for this launch (shown to the person).
    /// Read leniently: a non-string is ignored.
    #[serde(default)]
    offline_reason: Option<Value>,
}

impl LaunchClaims {
    /// ADR-048: whether the host asked to skip the start screen (`"start": "page"`).
    pub fn start_page(&self) -> bool {
        self.start.as_ref().and_then(Value::as_str) == Some("page")
    }

    pub fn into_grant(self) -> Grant {
        let version = self.file.version.and_then(|v| match v {
            Value::String(s) => Some(s),
            Value::Null => None,
            other => Some(other.to_string()),
        });
        let mut perms = self.perms.unwrap_or(Perms {
            history: None,
            restore: true,
            commit_message: true,
            export: true,
            download: true,
            comment: true,
            print: true,
            live: false,
            offline: false,
            offline_reason: None,
            automate: false,
        });
        if self.role == Role::View {
            perms.comment = false;
        }
        perms.offline_reason = self
            .offline_reason
            .as_ref()
            .and_then(Value::as_str)
            .map(|r| r.trim().chars().take(200).collect::<String>())
            .filter(|r| !r.is_empty());
        // The same rules as every other user object (docs/21): trimmed, http(s) avatars only.
        let me = crate::people::user_from_json(&serde_json::json!({
            "id": self.user.id, "name": self.user.name, "detail": self.user.detail,
            "avatar": self.user.avatar, "color": self.user.color,
        }));
        let members = crate::people::members_from_json(self.members.as_ref());
        Grant {
            ext_blocks: false,
            live: crate::grant::LiveGrant {
                claims: live_claims(self.live.as_ref()),
                ..Default::default()
            },
            wopi_history: None,
            members,
            room: room_id(&self.iss, &self.file.id),
            host_id: self.iss,
            role: self.role,
            user: User {
                color: self
                    .user
                    .color
                    .filter(|c| is_hex_color(c))
                    .unwrap_or_else(|| derive_color(&self.user.id)),
                name: me
                    .as_ref()
                    .map_or_else(|| self.user.id.clone(), |u| u.name.clone()),
                avatar: me.as_ref().and_then(|u| u.avatar.clone()),
                detail: me.as_ref().and_then(|u| u.detail.clone()),
                id: self.user.id,
            },
            file: FileRef {
                name: self.file.name.unwrap_or_else(|| self.file.id.clone()),
                id: self.file.id,
                version,
            },
            perms,
            callback_token: self.callback_token.unwrap_or_default(),
        }
    }
}

use crate::grant::is_hex_color;

/// The token's `live` claim (LIVE-01): `[{fileId, role}]`, entries with a 1-1024 byte file id
/// and a known role; anything else is dropped, at most 50 kept.
fn live_claims(v: Option<&Value>) -> Vec<crate::grant::LiveClaim> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|e| {
                    let file_id = e["fileId"].as_str()?;
                    let role = Role::parse(e["role"].as_str()?)?;
                    (!file_id.is_empty() && file_id.len() <= 1024).then(|| {
                        crate::grant::LiveClaim {
                            file_id: file_id.to_string(),
                            role,
                        }
                    })
                })
                .take(50)
                .collect()
        })
        .unwrap_or_default()
}

pub fn peek_issuer(token: &str) -> Result<String, JwtError> {
    let payload = token.split('.').nth(1).ok_or(JwtError::Malformed)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| JwtError::Malformed)?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| JwtError::Malformed)?;
    v.get("iss")
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or(JwtError::Malformed)
}

fn pinned_alg(host: &HostConfig) -> Result<Algorithm, JwtError> {
    match host.jwt_alg.as_str() {
        "HS256" => Ok(Algorithm::HS256),
        "RS256" => Ok(Algorithm::RS256),
        "EdDSA" => Ok(Algorithm::EdDSA),
        _ => Err(JwtError::NoKey),
    }
}

fn key_for(host: &HostConfig) -> Result<(Algorithm, DecodingKey), JwtError> {
    let pem = || {
        host.jwt_public_key
            .as_deref()
            .ok_or(JwtError::NoKey)
            .map(str::as_bytes)
    };
    Ok(match host.jwt_alg.as_str() {
        "HS256" => (
            Algorithm::HS256,
            DecodingKey::from_secret(
                host.jwt_secret
                    .as_deref()
                    .ok_or(JwtError::NoKey)?
                    .as_bytes(),
            ),
        ),
        "RS256" => (
            Algorithm::RS256,
            DecodingKey::from_rsa_pem(pem()?).map_err(|_| JwtError::NoKey)?,
        ),
        "EdDSA" => (
            Algorithm::EdDSA,
            DecodingKey::from_ed_pem(pem()?).map_err(|_| JwtError::NoKey)?,
        ),
        _ => return Err(JwtError::NoKey),
    })
}

/// Verifies a token for a host whose key is in its config (HS256 secret or PEM).
/// Signature (algorithm pinned by host config), `iss`, `aud`, `exp`, `nbf` and max lifetime are
/// checked; the caller enforces single-use `jti`. JWKS hosts go through [`Jwks::verify`].
pub fn verify(
    token: &str,
    hosts: &Hosts,
    now: i64,
) -> Result<(Arc<HostConfig>, LaunchClaims), JwtError> {
    let host = hosts
        .get(&peek_issuer(token)?)
        .ok_or(JwtError::UnknownHost)?;
    let (alg, key) = key_for(&host)?;
    check(token, host, alg, &key, now)
}

fn check(
    token: &str,
    host: Arc<HostConfig>,
    alg: Algorithm,
    key: &DecodingKey,
    now: i64,
) -> Result<(Arc<HostConfig>, LaunchClaims), JwtError> {
    let mut v = Validation::new(alg);
    v.set_audience(&[AUDIENCE]);
    v.set_issuer(&[host.id.as_str()]);
    v.set_required_spec_claims(&["exp", "iss", "aud"]);
    v.validate_nbf = true;
    v.leeway = 30;
    let data =
        decode::<LaunchClaims>(token, key, &v).map_err(|e| JwtError::Invalid(e.to_string()))?;
    if data.claims.exp - now > MAX_TTL_SECS {
        return Err(JwtError::TooLong);
    }
    if data.claims.jti.is_empty() {
        return Err(JwtError::Invalid("missing jti".into()));
    }
    Ok((host, data.claims))
}

/// Launch-token verifier with a per-URL JWKS cache (`jwt_jwks_url`, 10 min, `kid` match).
pub struct Jwks {
    http: reqwest::Client,
    cache: tokio::sync::Mutex<HashMap<String, (Instant, JwkSet)>>,
}

impl Default for Jwks {
    fn default() -> Self {
        Self::new()
    }
}

impl Jwks {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::limited(3))
            .build()
            .expect("http client");
        Self {
            http,
            cache: tokio::sync::Mutex::default(),
        }
    }

    async fn fetch(&self, url: &str) -> Result<JwkSet, JwtError> {
        let res = self
            .http
            .get(url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|e| {
                tracing::warn!(error = %e, "JWKS fetch failed");
                JwtError::NoKey
            })?;
        res.json::<JwkSet>().await.map_err(|e| {
            tracing::warn!(error = %e, "JWKS is not a valid key set");
            JwtError::NoKey
        })
    }

    /// The key for `kid` from the host's JWKS; the key type must fit the pinned algorithm.
    async fn key(&self, url: &str, alg: Algorithm, kid: &str) -> Result<DecodingKey, JwtError> {
        let mut cache = self.cache.lock().await;
        let fresh = |at: &Instant, ttl| at.elapsed() < ttl;
        let stale = cache.get(url).is_none_or(|(at, set)| {
            !fresh(at, JWKS_TTL) || (set.find(kid).is_none() && !fresh(at, JWKS_MIN_REFRESH))
        });
        if stale {
            let set = self.fetch(url).await?;
            cache.insert(url.to_string(), (Instant::now(), set));
        }
        let jwk = cache
            .get(url)
            .and_then(|(_, set)| set.find(kid))
            .ok_or(JwtError::NoKey)?;
        let fits = matches!(
            (&jwk.algorithm, alg),
            (AlgorithmParameters::RSA(_), Algorithm::RS256)
                | (AlgorithmParameters::OctetKeyPair(_), Algorithm::EdDSA)
        );
        let alg_ok = jwk
            .common
            .key_algorithm
            .is_none_or(|a| a.to_string() == format!("{alg:?}"));
        if !fits || !alg_ok {
            return Err(JwtError::Invalid(
                "key does not match the host algorithm".into(),
            ));
        }
        DecodingKey::from_jwk(jwk).map_err(|_| JwtError::NoKey)
    }

    /// Like [`verify`], also for hosts that publish their keys as a JWKS.
    pub async fn verify(
        &self,
        token: &str,
        hosts: &Hosts,
        now: i64,
    ) -> Result<(Arc<HostConfig>, LaunchClaims), JwtError> {
        let host = hosts
            .get(&peek_issuer(token)?)
            .ok_or(JwtError::UnknownHost)?;
        let alg = pinned_alg(&host)?;
        let url = host
            .jwt_jwks_url
            .clone()
            .filter(|_| alg != Algorithm::HS256 && host.jwt_public_key.is_none());
        let Some(url) = url else {
            let (alg, key) = key_for(&host)?;
            return check(token, host, alg, &key, now);
        };
        let header = decode_header(token).map_err(|_| JwtError::Malformed)?;
        if header.alg != alg {
            return Err(JwtError::Invalid(
                "algorithm not allowed for this host".into(),
            ));
        }
        let kid = header
            .kid
            .ok_or_else(|| JwtError::Invalid("token has no kid".into()))?;
        let key = self.key(&url, alg, &kid).await?;
        check(token, host, alg, &key, now)
    }
}

/// docs/24 §7.1: an MCP access token minted by the host (or its authorization server). The
/// headless API's user-scoped tokens (docs/27 §4.2, HAPI-02) have the same claims and are
/// verified by the same code, with the API audience.
#[derive(Debug, Clone, Deserialize)]
pub struct McpClaims {
    /// The user the call acts for (`svc:<name>` for a backend job).
    pub sub: String,
    /// Space-separated `canvas:read canvas:comment canvas:write canvas:write:direct`.
    #[serde(default)]
    pub scope: String,
    pub exp: i64,
    /// The user's role on the files this token covers, as the host decides it (Flow B).
    /// Absent means `view`. The `POST /access` callback comes with phase 2.
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// Optional allow-list of file ids.
    #[serde(default)]
    pub files: Option<Vec<String>>,
    #[serde(default)]
    pub client_id: Option<String>,
}

/// Longest MCP token lifetime we accept (docs/24 §7.1: ≤ 15 min).
pub const MCP_MAX_TTL_SECS: i64 = 15 * 60;

impl Jwks {
    /// Verifies an MCP access token for `host`: the host's pinned algorithm and keys (PEM,
    /// secret or JWKS, as for launch tokens), `iss` = `issuer`, `aud` = `audience` (this host's
    /// MCP resource URI), `exp`/`nbf`, and a lifetime of at most 15 minutes.
    pub async fn verify_mcp(
        &self,
        token: &str,
        host: &HostConfig,
        issuer: &str,
        audience: &str,
        now: i64,
    ) -> Result<McpClaims, JwtError> {
        let alg = pinned_alg(host)?;
        let url = host
            .jwt_jwks_url
            .clone()
            .filter(|_| alg != Algorithm::HS256 && host.jwt_public_key.is_none());
        let key = match url {
            None => key_for(host)?.1,
            Some(url) => {
                let header = decode_header(token).map_err(|_| JwtError::Malformed)?;
                if header.alg != alg {
                    return Err(JwtError::Invalid(
                        "algorithm not allowed for this host".into(),
                    ));
                }
                let kid = header
                    .kid
                    .ok_or_else(|| JwtError::Invalid("token has no kid".into()))?;
                self.key(&url, alg, &kid).await?
            }
        };
        let mut v = Validation::new(alg);
        v.set_audience(&[audience]);
        v.set_issuer(&[issuer]);
        v.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        v.validate_nbf = true;
        v.leeway = 30;
        let data = decode::<McpClaims>(token, &key, &v).map_err(|e| match e.kind() {
            jsonwebtoken::errors::ErrorKind::ExpiredSignature => JwtError::Expired,
            _ => JwtError::Invalid(e.to_string()),
        })?;
        if data.claims.exp - now > MCP_MAX_TTL_SECS + 30 {
            return Err(JwtError::TooLong);
        }
        Ok(data.claims)
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use serde_json::json;

    /// SEC-12: the colour is copied into other people's cursors and CSS; only `#rgb`,
    /// `#rrggbb` or `#rrggbbaa` hex is accepted, anything else falls back to a derived one.
    #[test]
    fn user_color_must_be_plain_hex() {
        let claims = |color: &str| -> LaunchClaims {
            serde_json::from_value(json!({
                "iss": "sample", "exp": 1, "jti": "j",
                "file": {"id": "f"}, "user": {"id": "u", "color": color}, "role": "edit"
            }))
            .unwrap()
        };
        assert_eq!(claims("#7a45f0").into_grant().user.color, "#7a45f0");
        assert_eq!(claims("#abc").into_grant().user.color, "#abc");
        for bad in ["#;}*{x", "#fff;x:y", "#12345g", "red", "#1234567"] {
            let c = claims(bad).into_grant().user.color;
            assert_ne!(c, bad, "{bad}");
            assert!(
                c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit()),
                "{c}"
            );
        }
    }

    pub const SECRET: &str = "dev-secret-change-me";

    pub fn hosts() -> Hosts {
        Hosts::parse(
            &format!(
                "[[host]]\nid = \"sample\"\nname = \"Sample\"\njwt_secret = \"{SECRET}\"\ncallback_base = \"http://127.0.0.1:9/api\"\nallowed_origins = [\"http://localhost:4000\"]\n"
            ),
            None,
        )
        .unwrap()
    }

    pub fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    pub fn claims(role: &str) -> Value {
        json!({
            "iss": "sample", "aud": "opencanvas", "exp": now() + 600, "jti": ulid::Ulid::new().to_string(),
            "file": {"id": "doc_1", "name": "Doc one", "version": "0"},
            "user": {"id": "u_1", "name": "Asha Rao"},
            "role": role, "perms": {"export": true, "download": true, "comment": true},
            "callbackToken": "cb-token"
        })
    }

    pub fn sign(claims: &Value, secret: &str, alg: Algorithm) -> String {
        encode(
            &Header::new(alg),
            claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap()
    }

    fn check(c: &Value) -> Result<(Arc<HostConfig>, LaunchClaims), JwtError> {
        verify(&sign(c, SECRET, Algorithm::HS256), &hosts(), now())
    }

    #[test]
    fn accepts_valid_token() {
        let (host, c) = check(&claims("edit")).unwrap();
        assert_eq!(host.id, "sample");
        let g = c.into_grant();
        assert_eq!(g.role, Role::Edit);
        assert_eq!(g.file.version.as_deref(), Some("0"));
        assert!(g.user.color.starts_with('#'));
        assert_eq!(g.callback_token, "cb-token");
    }

    #[test]
    fn rejects_bad_signature() {
        let t = sign(&claims("edit"), "wrong", Algorithm::HS256);
        assert!(matches!(
            verify(&t, &hosts(), now()),
            Err(JwtError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_algorithm_not_pinned_by_host() {
        let t = sign(&claims("edit"), SECRET, Algorithm::HS512);
        assert!(matches!(
            verify(&t, &hosts(), now()),
            Err(JwtError::Invalid(_))
        ));
        // alg=none: header {"alg":"none"} with an empty signature
        let body = URL_SAFE_NO_PAD.encode(claims("edit").to_string());
        let none = format!(
            "{}.{body}.",
            URL_SAFE_NO_PAD.encode(r#"{"alg":"none","typ":"JWT"}"#)
        );
        assert!(verify(&none, &hosts(), now()).is_err());
    }

    #[test]
    fn rejects_expired_wrong_audience_unknown_issuer_and_long_lived() {
        let mut c = claims("edit");
        c["exp"] = json!(now() - 120);
        assert!(matches!(check(&c), Err(JwtError::Invalid(_))));
        let mut c = claims("edit");
        c["aud"] = json!("someone-else");
        assert!(matches!(check(&c), Err(JwtError::Invalid(_))));
        let mut c = claims("edit");
        c["iss"] = json!("intruder");
        assert_eq!(check(&c).err(), Some(JwtError::UnknownHost));
        let mut c = claims("edit");
        c["exp"] = json!(now() + MAX_TTL_SECS + 3600);
        assert_eq!(check(&c).err(), Some(JwtError::TooLong));
        let mut c = claims("edit");
        c["nbf"] = json!(now() + 3600);
        assert!(check(&c).is_err());
    }

    const RSA_PRIV: &str = include_str!("../tests/keys/rsa.pem");
    const RSA_PUB: &str = include_str!("../tests/keys/rsa.pub");
    const ED_PRIV: &str = include_str!("../tests/keys/ed.pem");
    const ED_PUB: &str = include_str!("../tests/keys/ed.pub");
    const JWKS: &str = include_str!("../tests/keys/jwks.json");

    fn pem_host(alg: &str, public_key: &str) -> Hosts {
        Hosts::parse(
            &format!(
                "[[host]]\nid = \"sample\"\nname = \"Sample\"\njwt_alg = \"{alg}\"\njwt_public_key = '''{public_key}'''\ncallback_base = \"http://127.0.0.1:9/api\"\n"
            ),
            None,
        )
        .unwrap()
    }

    fn jwks_host(alg: &str, url: &str) -> Hosts {
        Hosts::parse(
            &format!(
                "[[host]]\nid = \"sample\"\nname = \"Sample\"\njwt_alg = \"{alg}\"\njwt_jwks_url = \"{url}\"\ncallback_base = \"http://127.0.0.1:9/api\"\n"
            ),
            None,
        )
        .unwrap()
    }

    fn sign_with(c: &Value, alg: Algorithm, key: &EncodingKey, kid: Option<&str>) -> String {
        let mut h = Header::new(alg);
        h.kid = kid.map(String::from);
        encode(&h, c, key).unwrap()
    }

    fn rsa() -> EncodingKey {
        EncodingKey::from_rsa_pem(RSA_PRIV.as_bytes()).unwrap()
    }

    fn ed() -> EncodingKey {
        EncodingKey::from_ed_pem(ED_PRIV.as_bytes()).unwrap()
    }

    #[test]
    fn rs256_with_pem_key() {
        let hosts = pem_host("RS256", RSA_PUB);
        let t = sign_with(&claims("edit"), Algorithm::RS256, &rsa(), None);
        assert!(verify(&t, &hosts, now()).is_ok());
        let forged = sign_with(&claims("edit"), Algorithm::EdDSA, &ed(), None);
        assert!(verify(&forged, &hosts, now()).is_err(), "other algorithm");
    }

    #[test]
    fn eddsa_with_pem_key() {
        let hosts = pem_host("EdDSA", ED_PUB);
        let t = sign_with(&claims("edit"), Algorithm::EdDSA, &ed(), None);
        assert!(verify(&t, &hosts, now()).is_ok());
        let forged = sign_with(&claims("edit"), Algorithm::RS256, &rsa(), None);
        assert!(verify(&forged, &hosts, now()).is_err());
    }

    #[test]
    fn hs256_token_against_rs256_host_is_rejected() {
        // Classic alg confusion: HMAC-sign with the (public) RSA key as the secret.
        let hosts = pem_host("RS256", RSA_PUB);
        let t = sign(&claims("edit"), RSA_PUB, Algorithm::HS256);
        assert!(matches!(
            verify(&t, &hosts, now()),
            Err(JwtError::Invalid(_))
        ));
        let ed_hosts = pem_host("EdDSA", ED_PUB);
        let t = sign(&claims("edit"), ED_PUB, Algorithm::HS256);
        assert!(verify(&t, &ed_hosts, now()).is_err());
    }

    #[test]
    fn asymmetric_host_needs_a_key() {
        let src = "[[host]]\nid = \"x\"\nname = \"X\"\njwt_alg = \"RS256\"\ncallback_base = \"http://h\"\n";
        assert!(Hosts::parse(src, None).is_err());
    }

    /// Serves `tests/keys/jwks.json`, counting fetches.
    async fn jwks_server() -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        let app = axum::Router::new().route(
            "/.well-known/jwks.json",
            axum::routing::get(move || {
                h.fetch_add(1, Ordering::SeqCst);
                async { ([("content-type", "application/json")], JWKS) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}/.well-known/jwks.json"), hits)
    }

    #[tokio::test]
    async fn jwks_rs256_matches_kid_and_caches() {
        use std::sync::atomic::Ordering;
        let (url, hits) = jwks_server().await;
        let hosts = jwks_host("RS256", &url);
        let jwks = Jwks::new();
        let t = sign_with(&claims("edit"), Algorithm::RS256, &rsa(), Some("rsa-1"));
        assert!(jwks.verify(&t, &hosts, now()).await.is_ok());
        let t = sign_with(&claims("view"), Algorithm::RS256, &rsa(), Some("rsa-1"));
        assert!(jwks.verify(&t, &hosts, now()).await.is_ok());
        assert_eq!(hits.load(Ordering::SeqCst), 1, "cached");

        let unknown = sign_with(&claims("edit"), Algorithm::RS256, &rsa(), Some("rsa-9"));
        assert_eq!(
            jwks.verify(&unknown, &hosts, now()).await.err(),
            Some(JwtError::NoKey)
        );
        let no_kid = sign_with(&claims("edit"), Algorithm::RS256, &rsa(), None);
        assert!(jwks.verify(&no_kid, &hosts, now()).await.is_err());
        // The Ed25519 key in the set must not verify for an RS256 host.
        let wrong = sign_with(&claims("edit"), Algorithm::EdDSA, &ed(), Some("ed-1"));
        assert!(jwks.verify(&wrong, &hosts, now()).await.is_err());
        // Alg confusion through JWKS: HS256 with the RSA public key as secret.
        let mut h = Header::new(Algorithm::HS256);
        h.kid = Some("rsa-1".into());
        let hs = encode(
            &h,
            &claims("edit"),
            &EncodingKey::from_secret(RSA_PUB.as_bytes()),
        )
        .unwrap();
        assert!(jwks.verify(&hs, &hosts, now()).await.is_err());
    }

    #[tokio::test]
    async fn jwks_eddsa() {
        let (url, _) = jwks_server().await;
        let hosts = jwks_host("EdDSA", &url);
        let jwks = Jwks::new();
        let t = sign_with(&claims("edit"), Algorithm::EdDSA, &ed(), Some("ed-1"));
        assert!(jwks.verify(&t, &hosts, now()).await.is_ok());
        let t = sign_with(&claims("edit"), Algorithm::RS256, &rsa(), Some("rsa-1"));
        assert!(jwks.verify(&t, &hosts, now()).await.is_err());
    }

    #[test]
    fn rejects_garbage_and_bad_role() {
        assert_eq!(
            verify("not-a-jwt", &hosts(), now()).err(),
            Some(JwtError::Malformed)
        );
        assert!(check(&claims("owner")).is_err());
    }
}
