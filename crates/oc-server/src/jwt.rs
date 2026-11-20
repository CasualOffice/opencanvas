//! Launch token verification (docs/05 §3, docs/07 §2).

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;
use serde_json::Value;

use crate::grant::{FileRef, Grant, Perms, Role, User, derive_color, room_id};
use crate::hosts::{HostConfig, Hosts};

pub const AUDIENCE: &str = "opencanvas";
pub const MAX_TTL_SECS: i64 = 10 * 3600;

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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchClaims {
    pub iss: String,
    pub exp: i64,
    pub jti: String,
    file: FileClaim,
    user: UserClaim,
    role: Role,
    #[serde(default)]
    perms: Option<Perms>,
    #[serde(default)]
    callback_token: Option<String>,
}

impl LaunchClaims {
    pub fn into_grant(self) -> Grant {
        let version = self.file.version.and_then(|v| match v {
            Value::String(s) => Some(s),
            Value::Null => None,
            other => Some(other.to_string()),
        });
        let mut perms = self.perms.unwrap_or(Perms {
            export: true,
            download: true,
            comment: true,
        });
        if self.role == Role::View {
            perms.comment = false;
        }
        Grant {
            room: room_id(&self.iss, &self.file.id),
            host_id: self.iss,
            role: self.role,
            user: User {
                color: self
                    .user
                    .color
                    .filter(|c| c.starts_with('#') && c.len() <= 9)
                    .unwrap_or_else(|| derive_color(&self.user.id)),
                name: self.user.name.unwrap_or_else(|| self.user.id.clone()),
                avatar: self.user.avatar,
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

fn peek_issuer(token: &str) -> Result<String, JwtError> {
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

/// Verifies signature (algorithm pinned by host config), `iss`, `aud`, `exp`, `nbf` and max lifetime.
/// The caller enforces single-use `jti`.
pub fn verify(
    token: &str,
    hosts: &Hosts,
    now: i64,
) -> Result<(Arc<HostConfig>, LaunchClaims), JwtError> {
    let host = hosts
        .get(&peek_issuer(token)?)
        .ok_or(JwtError::UnknownHost)?;
    let (alg, key) = key_for(&host)?;
    let mut v = Validation::new(alg);
    v.set_audience(&[AUDIENCE]);
    v.set_issuer(&[host.id.as_str()]);
    v.set_required_spec_claims(&["exp", "iss", "aud"]);
    v.validate_nbf = true;
    v.leeway = 30;
    let data =
        decode::<LaunchClaims>(token, &key, &v).map_err(|e| JwtError::Invalid(e.to_string()))?;
    if data.claims.exp - now > MAX_TTL_SECS {
        return Err(JwtError::TooLong);
    }
    if data.claims.jti.is_empty() {
        return Err(JwtError::Invalid("missing jti".into()));
    }
    Ok((host, data.claims))
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use serde_json::json;

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

    #[test]
    fn rejects_garbage_and_bad_role() {
        assert_eq!(
            verify("not-a-jwt", &hosts(), now()).err(),
            Some(JwtError::Malformed)
        );
        assert!(check(&claims("owner")).is_err());
    }
}
