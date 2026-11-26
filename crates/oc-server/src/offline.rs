// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Offline copies on the person's device (OFF-01/02/07, ADR-063/064, docs/34 §3).
//!
//! The server keeps **no content** for offline editing. It holds `[host.offline]` (checked at
//! start-up), signs the offline grant (an ES256 JWS the editor keeps with the copy and uses
//! only locally, never as a credential), and stores one generation number per host and user
//! (`offline_generation`): `POST /api/v1/offline/revoke` raises it, and a device whose grants
//! carry a lower number deletes its copies at the next session answer. `GET /v1/offline/clear`
//! is the sign-out page a host loads in a hidden iframe to clear the device.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use p256::ecdsa::signature::{Signer as _, Verifier as _};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::SharedState;
use crate::grant::{Grant, Role};
use crate::hosts::HostConfig;

/// Queued files per canvas (docs/34 §3.3; not configurable).
pub const UPLOAD_FILES: u32 = 20;
/// The JWS `typ` of an offline grant.
pub const GRANT_TYP: &str = "oc-offline+jwt";

/// `[host.offline]`, checked (docs/05 §2, docs/34 §3.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OfflineCfg {
    /// The host allows offline copies at all (default false).
    pub enabled: bool,
    /// Keep the last N opened canvases without asking (0 = ask per canvas).
    pub auto_recent: u32,
    /// Offline grant lifetime in days, 1-30 (default 7).
    pub grant_days: u32,
    /// The highest role an offline copy keeps (default edit).
    pub max_role: Role,
    /// Canvases per person per host per device (default 50).
    pub max_canvases: u32,
    /// MB of every copy of one person on one device (default 200).
    pub max_mb: u32,
    /// MB of queued uploads per canvas (default 50; at most 20 files).
    pub uploads_mb: u32,
    /// MB of unsent changes per canvas before editing pauses (default 5).
    pub unsent_mb: u32,
}

impl Default for OfflineCfg {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_recent: 0,
            grant_days: 7,
            max_role: Role::Edit,
            max_canvases: 50,
            max_mb: 200,
            uploads_mb: 50,
            unsent_mb: 5,
        }
    }
}

fn int(k: &str, v: &toml::Value, lo: i64, hi: i64) -> anyhow::Result<u32> {
    v.as_integer()
        .filter(|n| (lo..=hi).contains(n))
        .map(|n| n as u32)
        .ok_or_else(|| anyhow::anyhow!("[host.offline] {k} is a whole number {lo}-{hi}"))
}

impl OfflineCfg {
    pub fn parse(t: &toml::Table) -> anyhow::Result<Self> {
        let mut c = Self::default();
        for (k, v) in t {
            match k.as_str() {
                "enabled" => {
                    c.enabled = v.as_bool().ok_or_else(|| {
                        anyhow::anyhow!("[host.offline] enabled takes true or false")
                    })?
                }
                "auto_recent" => c.auto_recent = int(k, v, 0, 50)?,
                "grant_days" => c.grant_days = int(k, v, 1, 30)?,
                "max_role" => {
                    c.max_role = v.as_str().and_then(Role::parse).ok_or_else(|| {
                        anyhow::anyhow!(
                            "[host.offline] max_role takes \"edit\", \"comment\" or \"view\""
                        )
                    })?
                }
                "max_canvases" => c.max_canvases = int(k, v, 1, 500)?,
                "max_mb" => c.max_mb = int(k, v, 1, 2000)?,
                "uploads_mb" => c.uploads_mb = int(k, v, 0, 500)?,
                "unsent_mb" => c.unsent_mb = int(k, v, 1, 50)?,
                other => anyhow::bail!(
                    "[host.offline] has no setting {other:?} (enabled, auto_recent, grant_days, \
                     max_role, max_canvases, max_mb, uploads_mb, unsent_mb)"
                ),
            }
        }
        if c.auto_recent > c.max_canvases {
            anyhow::bail!("[host.offline] auto_recent cannot exceed max_canvases");
        }
        Ok(c)
    }

    pub fn of(host: &HostConfig) -> Self {
        Self::parse(&host.offline).unwrap_or_default()
    }
}

/// Start-up check of `[host.offline]`: valid settings, and JWT hosts only in v0.3 (a WOPI
/// launch has no `perms.offline` claim, ADR-064).
pub fn check_host(h: &HostConfig) -> anyhow::Result<()> {
    let c = OfflineCfg::parse(&h.offline)?;
    if c.enabled && h.wopi_only() {
        anyhow::bail!(
            "[host.offline] needs a JWT host: WOPI hosts have no perms.offline claim in v0.3"
        );
    }
    Ok(())
}

fn min_role(a: Role, b: Role) -> Role {
    let rank = |r: Role| match r {
        Role::View => 0,
        Role::Comment => 1,
        Role::Edit => 2,
    };
    if rank(a) <= rank(b) { a } else { b }
}

/// The ES256 key that signs offline grants: from `OC_OFFLINE_KEY` (base64 of a 32-byte P-256
/// secret scalar), else derived from `OC_KEK` (every node derives the same key), else a fresh
/// key for this process (development without `OC_KEK`).
pub struct GrantKey {
    key: SigningKey,
    kid: String,
    jwk: Value,
}

impl std::fmt::Debug for GrantKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "GrantKey({})", self.kid)
    }
}

impl GrantKey {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        // A seed outside the curve order (probability ~2^-32) is rehashed until it fits.
        let mut s = seed;
        let key = loop {
            match SigningKey::from_slice(&s) {
                Ok(k) => break k,
                Err(_) => s = Sha256::digest(s).into(),
            }
        };
        let point = VerifyingKey::from(&key).to_encoded_point(false);
        let (x, y) = (
            B64.encode(point.x().expect("uncompressed")),
            B64.encode(point.y().expect("uncompressed")),
        );
        let kid = hex::encode(&Sha256::digest(format!("{x}.{y}"))[..8]);
        let jwk = json!({"kty": "EC", "crv": "P-256", "x": x, "y": y, "alg": "ES256",
                         "use": "sig", "kid": kid});
        Self { key, kid, jwk }
    }

    pub fn load(env: Option<&str>, kek: Option<&crate::crypto::Kek>) -> anyhow::Result<Self> {
        if let Some(v) = env.map(str::trim).filter(|v| !v.is_empty()) {
            let raw = base64::engine::general_purpose::STANDARD
                .decode(v)
                .map_err(|_| anyhow::anyhow!("OC_OFFLINE_KEY is not valid base64"))?;
            let seed: [u8; 32] = raw
                .try_into()
                .map_err(|_| anyhow::anyhow!("OC_OFFLINE_KEY must decode to 32 bytes"))?;
            return Ok(Self::from_seed(seed));
        }
        if let Some(k) = kek {
            return Ok(Self::from_seed(k.derive("opencanvas offline grant v1")));
        }
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|e| anyhow::anyhow!("no randomness: {e}"))?;
        Ok(Self::from_seed(seed))
    }

    /// The public key as a JWK (the editor checks the grant's signature with it).
    pub fn jwk(&self) -> &Value {
        &self.jwk
    }

    /// A compact JWS (ES256, `r ‖ s`) over `claims`.
    pub fn sign(&self, claims: &Value) -> String {
        let head = json!({"alg": "ES256", "typ": GRANT_TYP, "kid": self.kid});
        let input = format!(
            "{}.{}",
            B64.encode(head.to_string()),
            B64.encode(claims.to_string())
        );
        let sig: Signature = self.key.sign(input.as_bytes());
        format!("{input}.{}", B64.encode(sig.to_bytes()))
    }

    /// The claims of a grant this key signed, or `None` (tests and tools; the server never
    /// accepts a grant as a credential).
    pub fn verify(&self, jws: &str) -> Option<Value> {
        let (input, sig) = jws.rsplit_once('.')?;
        let sig = Signature::from_slice(&B64.decode(sig).ok()?).ok()?;
        VerifyingKey::from(&self.key)
            .verify(input.as_bytes(), &sig)
            .ok()?;
        let (head, body) = input.split_once('.')?;
        let head: Value = serde_json::from_slice(&B64.decode(head).ok()?).ok()?;
        if head["alg"] != "ES256" || head["typ"] != GRANT_TYP {
            return None;
        }
        serde_json::from_slice(&B64.decode(body).ok()?).ok()
    }
}

/// The `offline` member of the session answer (docs/34 §3.4). Every answer for a host with
/// `[host.offline]` carries the person's generation, so a revoked device learns it at any
/// contact; the grant only when this launch may keep the canvas offline.
pub async fn session_json(
    state: &SharedState,
    host: &HostConfig,
    grant: &Grant,
    wopi: bool,
) -> anyhow::Result<Value> {
    let c = OfflineCfg::of(host);
    if !c.enabled {
        return Ok(json!({"enabled": false, "allowed": false}));
    }
    let gen_no = state.store.offline_gen(&host.id, &grant.user.id).await?;
    let now = state.clock.now_secs();
    let mut out = json!({
        "enabled": true,
        "gen": gen_no,
        "maxDays": c.grant_days,
        "autoRecent": c.auto_recent,
        "limits": {
            "maxCanvases": c.max_canvases, "maxMb": c.max_mb, "uploadsMb": c.uploads_mb,
            "uploadsFiles": UPLOAD_FILES, "unsentMb": c.unsent_mb,
        },
        "key": state.offline_key.jwk(),
    });
    let reason = if wopi {
        Some("wopi".to_string())
    } else if !grant.perms.offline {
        Some(
            grant
                .perms
                .offline_reason
                .clone()
                .unwrap_or_else(|| "not-allowed".into()),
        )
    } else {
        None
    };
    match reason {
        Some(r) => {
            out["allowed"] = json!(false);
            out["reason"] = json!(r);
        }
        None => {
            let role = min_role(grant.role, c.max_role);
            let exp = now + i64::from(c.grant_days) * 86_400;
            let claims = json!({
                "iss": "opencanvas", "host": host.id, "sub": grant.user.id,
                "file": grant.file.id, "role": role, "iat": now, "exp": exp, "gen": gen_no,
                "perms": {"download": grant.perms.download, "comment": grant.perms.comment},
            });
            out["allowed"] = json!(true);
            out["role"] = json!(role);
            out["exp"] = json!(exp);
            out["grant"] = json!(state.offline_key.sign(&claims));
        }
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeBody {
    pub user_id: String,
}

/// A host or user id fit for the clear page and the generation key: 1-256 printable bytes.
pub fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && s.bytes()
            .all(|b| b.is_ascii_graphic() && !matches!(b, b'<' | b'>' | b'"' | b'\'' | b'&'))
}

#[derive(Debug, Deserialize)]
pub struct ClearQuery {
    pub host: Option<String>,
    pub user: Option<String>,
}

/// The clear page's script (a file, so the page needs no inline script under the CSP).
pub const CLEAR_JS: &str = include_str!("offline_clear.js");

/// `GET /v1/offline/clear[?host=<id>[&user=<id>]]`: a page for a hidden iframe on the host's
/// sign-out page (docs/05 §4c). It deletes the device keys first, then the databases, for that
/// host (and person; without `host`, every host) in this browser partition, and posts
/// `{"type":"OC_OfflineCleared", removed}` to the parent.
pub async fn clear_page(state: State<SharedState>, q: Query<ClearQuery>) -> Response {
    frame_page(state, q, "clear")
}

/// `GET /v1/offline/files?host=<id>&user=<id>`: the same kind of page for
/// `OpenCanvas.offlineFiles()`; posts `{"type":"OC_OfflineFiles", files}` (id, title, size,
/// unsent changes, last sent, valid until) to the parent. Titles are read on the device only.
pub async fn files_page(state: State<SharedState>, q: Query<ClearQuery>) -> Response {
    if q.host.is_none() || q.user.is_none() {
        return (StatusCode::BAD_REQUEST, "host and user are required").into_response();
    }
    frame_page(state, q, "files")
}

fn frame_page(
    State(state): State<SharedState>,
    Query(q): Query<ClearQuery>,
    mode: &str,
) -> Response {
    // Without `host`: every host's copies in this browser partition (the host's own site).
    let host = q.host.unwrap_or_default();
    if !host.is_empty() && (!valid_id(&host) || state.hosts.get(&host).is_none()) {
        return (StatusCode::NOT_FOUND, "no such host").into_response();
    }
    if host.is_empty() && q.user.is_some() {
        return (StatusCode::BAD_REQUEST, "user needs host").into_response();
    }
    if q.user.as_deref().is_some_and(|u| !valid_id(u)) {
        return (StatusCode::BAD_REQUEST, "bad user").into_response();
    }
    let user = q.user.unwrap_or_default();
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>OpenCanvas</title>\
         <meta name=\"robots\" content=\"noindex\"></head><body>\
         <script src=\"/v1/offline/clear.js\" data-mode=\"{mode}\" data-host=\"{host}\" data-user=\"{user}\"></script>\
         </body></html>"
    );
    let mut res = (
        [(header::CACHE_CONTROL, "no-store")],
        axum::response::Html(html),
    )
        .into_response();
    res.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_str(&clear_csp(&state, &host)).unwrap_or(HeaderValue::from_static(
            "default-src 'none'; script-src 'self'",
        )),
    );
    res
}

/// The clear page may be framed by the host's own pages: its allowed origins and frame
/// ancestors.
fn clear_csp(state: &SharedState, host: &str) -> String {
    let mut fa = String::from("frame-ancestors 'self'");
    let hosts: Vec<_> = match state.hosts.get(host) {
        Some(h) => vec![h],
        None => state.hosts.iter().cloned().collect(),
    };
    for h in hosts {
        for o in h.allowed_origins.iter().chain(&h.frame_ancestors) {
            if o.bytes()
                .all(|b| b.is_ascii_graphic() && !matches!(b, b';' | b',' | b'\'' | b'"'))
            {
                fa.push(' ');
                fa.push_str(o);
            }
        }
    }
    format!("default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'; {fa}")
}

pub async fn clear_js(_h: HeaderMap) -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        CLEAR_JS,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> toml::Table {
        toml::from_str(s).unwrap()
    }

    #[test]
    fn defaults_and_bounds() {
        let c = OfflineCfg::parse(&t("")).unwrap();
        assert!(!c.enabled);
        assert_eq!(
            (
                c.grant_days,
                c.max_canvases,
                c.max_mb,
                c.uploads_mb,
                c.unsent_mb
            ),
            (7, 50, 200, 50, 5)
        );
        assert!(OfflineCfg::parse(&t("grant_days = 31")).is_err());
        assert!(OfflineCfg::parse(&t("grant_days = 0")).is_err());
        assert!(OfflineCfg::parse(&t("max_role = \"owner\"")).is_err());
        assert!(OfflineCfg::parse(&t("enabled = \"yes\"")).is_err());
        assert!(OfflineCfg::parse(&t("cache = 1")).is_err());
        assert!(OfflineCfg::parse(&t("auto_recent = 60")).is_err());
        let c =
            OfflineCfg::parse(&t("enabled = true\ngrant_days = 30\nmax_role = \"view\"")).unwrap();
        assert_eq!(
            (c.enabled, c.grant_days, c.max_role),
            (true, 30, Role::View)
        );
    }

    #[test]
    fn grants_verify_and_tampering_fails() {
        let k = GrantKey::from_seed([9; 32]);
        let jws = k.sign(&json!({"sub": "u_1", "exp": 5}));
        assert_eq!(k.verify(&jws).unwrap()["sub"], "u_1");
        let (head, rest) = jws.split_once('.').unwrap();
        let (_, sig) = rest.split_once('.').unwrap();
        let forged = format!("{head}.{}.{sig}", B64.encode(r#"{"sub":"u_1","exp":99}"#));
        assert!(k.verify(&forged).is_none());
        assert!(
            GrantKey::from_seed([8; 32]).verify(&jws).is_none(),
            "another key"
        );
        assert_eq!(k.jwk()["crv"], "P-256");
        assert_eq!(
            GrantKey::from_seed([9; 32]).jwk(),
            k.jwk(),
            "same seed, same key"
        );
    }

    #[test]
    fn ids_for_the_clear_page() {
        assert!(valid_id("acme"));
        assert!(!valid_id(""));
        assert!(!valid_id("a\"b"));
        assert!(!valid_id("a b"));
        assert!(!valid_id("<x>"));
    }
}
