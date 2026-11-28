// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The Workspace's side of the host contract (docs/05): launch tokens (§3), callback tokens and
//! signatures (§5), and the server-to-server calls (§7). Nothing here uses the engine's code:
//! it is the same HTTP an external host speaks, so the single-process build tests the contract.

use std::time::Duration;

use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::Sha256;

use crate::util::{ct_eq, now_ms};

type HmacSha256 = Hmac<Sha256>;

fn hmac_hex(key: &[u8], parts: &[&[u8]]) -> String {
    let mut m = HmacSha256::new_from_slice(key).expect("any key length");
    for p in parts {
        m.update(p);
    }
    hex::encode(m.finalize().into_bytes())
}

/// A callback token binds a person (or a link visitor) to one file: `<subject>.<mac>`.
/// The engine sends it back on every callback (docs/05 §5); it is opaque to the engine.
pub fn callback_token(key: &[u8], file: &str, subject: &str) -> String {
    let mac = hmac_hex(key, &[b"cb:", file.as_bytes(), b":", subject.as_bytes()]);
    format!("{subject}.{}", &mac[..40])
}

/// The subject of a valid callback token for `file`.
pub fn check_callback_token(key: &[u8], file: &str, token: &str) -> Option<String> {
    let (subject, _) = token.rsplit_once('.')?;
    let want = callback_token(key, file, subject);
    ct_eq(want.as_bytes(), token.as_bytes()).then(|| subject.to_string())
}

/// Verifies `X-OpenCanvas-Signature` v2 (docs/05 §5): HMAC-SHA256 over
/// `"<ts>.<METHOD>.<path?query>.<body>"`, at most 5 minutes off.
pub fn check_signature(
    secret: &str,
    header: &str,
    method: &str,
    path_query: &str,
    body: &[u8],
) -> bool {
    let mut t = None;
    let mut v2 = None;
    for part in header.split(',') {
        match part.trim().split_once('=') {
            Some(("t", x)) => t = Some(x),
            Some(("v2", x)) => v2 = Some(x),
            _ => {}
        }
    }
    let (Some(t), Some(v2)) = (t, v2) else {
        return false;
    };
    let Ok(ts) = t.parse::<i64>() else {
        return false;
    };
    if (now_ms() / 1000 - ts).abs() > 300 {
        return false;
    }
    let want = hmac_hex(
        secret.as_bytes(),
        &[
            t.as_bytes(),
            b".",
            method.as_bytes(),
            b".",
            path_query.as_bytes(),
            b".",
            body,
        ],
    );
    ct_eq(want.as_bytes(), v2.as_bytes())
}

/// Signs a request the way the engine does (tests and the conformance suite).
pub fn sign(secret: &str, method: &str, path_query: &str, body: &[u8]) -> String {
    let t = (now_ms() / 1000).to_string();
    let v2 = hmac_hex(
        secret.as_bytes(),
        &[
            t.as_bytes(),
            b".",
            method.as_bytes(),
            b".",
            path_query.as_bytes(),
            b".",
            body,
        ],
    );
    let v1 = hmac_hex(secret.as_bytes(), &[t.as_bytes(), b".", body]);
    format!("t={t},v1={v1},v2={v2}")
}

#[derive(Serialize, Clone, Debug)]
pub struct Person {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Serialize)]
struct FileClaim<'a> {
    id: &'a str,
    name: &'a str,
    version: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    ftype: Option<&'a str>,
}

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    aud: &'a str,
    iat: i64,
    exp: i64,
    jti: String,
    file: FileClaim<'a>,
    user: &'a Person,
    #[serde(skip_serializing_if = "Option::is_none")]
    members: Option<&'a [Person]>,
    role: &'a str,
    mode: &'a str,
    perms: serde_json::Value,
    #[serde(rename = "callbackToken")]
    callback_token: String,
}

pub struct Launch<'a> {
    pub host_id: &'a str,
    pub secret: &'a str,
    pub token_key: &'a [u8],
    pub file_id: &'a str,
    pub file_name: &'a str,
    pub version: i64,
    pub ftype: &'a str,
    pub user: &'a Person,
    pub members: Option<&'a [Person]>,
    /// The engine role: view | comment | edit.
    pub role: &'a str,
    /// A link visitor: no history, no mentions, no automations.
    pub visitor: bool,
}

/// A launch token (docs/05 §3), valid 10 minutes, single use.
pub fn launch_token(l: &Launch) -> anyhow::Result<String> {
    let now = now_ms() / 1000;
    let edit = l.role == "edit";
    let claims = Claims {
        iss: l.host_id,
        aud: "opencanvas",
        iat: now,
        exp: now + 600,
        jti: crate::util::token(16),
        file: FileClaim {
            id: l.file_id,
            name: l.file_name,
            version: l.version.to_string(),
            // docs/05 §2f: only typed files say so; servers without app mode ignore it.
            ftype: (l.ftype != "document").then_some(l.ftype),
        },
        user: l.user,
        members: l.members,
        role: l.role,
        mode: if l.role == "view" { "view" } else { "edit" },
        perms: serde_json::json!({
            "export": !l.visitor || l.role != "view",
            "download": !l.visitor,
            "print": true,
            "comment": l.role != "view",
            "mention": !l.visitor,
            "history": !l.visitor && edit,
            "restore": !l.visitor && edit,
            "commitMessage": edit,
            "live": !l.visitor && edit,
            "automate": !l.visitor && edit,
        }),
        callback_token: callback_token(l.token_key, l.file_id, &l.user.id),
    };
    Ok(jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(l.secret.as_bytes())?,
    )?)
}

/// Server-to-server calls to the engine (docs/05 §7).
#[derive(Clone)]
pub struct EngineClient {
    pub base: String,
    host_id: String,
    api_key: String,
    http: reqwest::Client,
}

impl EngineClient {
    pub fn new(base: &str, host_id: &str, api_key: &str) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            host_id: host_id.to_string(),
            api_key: api_key.to_string(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("http client"),
        }
    }

    async fn post(
        &self,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> anyhow::Result<reqwest::StatusCode> {
        let mut r = self
            .http
            .post(format!("{}{path}", self.base))
            .header("x-opencanvas-host", &self.host_id)
            .header("x-opencanvas-key", &self.api_key);
        if let Some(b) = body {
            r = r.json(&b);
        }
        Ok(r.send().await?.status())
    }

    fn enc(id: &str) -> String {
        id.bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b == b'_' || b == b'-' {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect()
    }

    /// The person's role on a file changed: open sessions switch (or close with `none`) at once.
    pub async fn set_role(&self, file: &str, user: &str, role: &str) {
        let path = format!("/v1/files/{}/role", Self::enc(file));
        match self
            .post(
                &path,
                Some(serde_json::json!({"userId": user, "role": role})),
            )
            .await
        {
            Ok(s) if s.is_success() => {}
            Ok(s) => tracing::warn!(file, user, role, status = %s, "role API refused"),
            Err(e) => tracing::warn!(file, user, role, error = %e, "role API unreachable"),
        }
    }

    pub async fn invalidate_members(&self, file: &str) {
        let path = format!("/v1/files/{}/members/invalidate", Self::enc(file));
        if let Err(e) = self.post(&path, None).await {
            tracing::warn!(file, error = %e, "members invalidate unreachable");
        }
    }

    /// The file was deleted or moved out of reach: final save, then every session closes.
    pub async fn close_sessions(&self, file: &str) {
        let r = self
            .http
            .delete(format!(
                "{}/v1/files/{}/session",
                self.base,
                Self::enc(file)
            ))
            .header("x-opencanvas-host", &self.host_id)
            .header("x-opencanvas-key", &self.api_key)
            .send()
            .await;
        if let Err(e) = r {
            tracing::warn!(file, error = %e, "session close unreachable");
        }
    }
}

/// The Workspace's `[[host]]` entry in the engine (docs/05 §2), generated from the secrets.
/// `public_url` is the address people use (the operator's, else the one chosen at setup); the
/// engine reads hosts at start, so a new address applies after a restart (docs/40 §11).
pub fn host_toml(
    cfg: &crate::config::WsConfig,
    s: &crate::secrets::Secrets,
    public_url: &str,
) -> String {
    let port = cfg.bind.rsplit(':').next().unwrap_or("8080");
    let mut origins = vec![
        format!("http://localhost:{port}"),
        format!("http://127.0.0.1:{port}"),
    ];
    let public = public_url.trim_end_matches('/');
    if !public.is_empty() {
        origins.push(public.to_string());
    }
    if let Ok(extra) = std::env::var("WS_EXTRA_ORIGINS") {
        origins.extend(
            extra
                .split(',')
                .map(|o| o.trim().trim_end_matches('/').to_string())
                .filter(|o| !o.is_empty()),
        );
    }
    let q = |v: &str| format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""));
    format!(
        "[[host]]\nid = {}\nname = \"OpenCanvas Workspace\"\nmode = \"jwt\"\njwt_alg = \"HS256\"\njwt_secret = {}\napi_key = {}\n\
         callback_base = {}\nallowed_origins = [{}]\nasset_origins = [{}]\n\n[host.flags]\non_conflict = \"copy\"\nteam_templates = true\nhistory = true\napi_v1 = true\n\n\
         [host.search]\ncallback = true\n\n[host.editor]\nchrome = \"host\"\n",
        q(&cfg.host_id),
        q(&s.host_secret),
        q(&s.host_api_key),
        q(&cfg.callback_base),
        origins.iter().map(|o| q(o)).collect::<Vec<_>>().join(", "),
        // Images in exports: our asset URLs are on the public address (docs/05 §7).
        if public.is_empty() {
            String::new()
        } else {
            q(public)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_tokens_bind_the_file() {
        let k = b"key";
        let t = callback_token(k, "c_1", "u_1");
        assert_eq!(check_callback_token(k, "c_1", &t).as_deref(), Some("u_1"));
        assert_eq!(check_callback_token(k, "c_2", &t), None);
        assert_eq!(check_callback_token(b"other", "c_1", &t), None);
        assert_eq!(check_callback_token(k, "c_1", "u_2.abc"), None);
    }

    #[test]
    fn signatures_bind_method_path_and_body() {
        let h = sign("s", "PUT", "/api/ws/oc/files/c_1", b"body");
        assert!(check_signature(
            "s",
            &h,
            "PUT",
            "/api/ws/oc/files/c_1",
            b"body"
        ));
        assert!(!check_signature(
            "s",
            &h,
            "GET",
            "/api/ws/oc/files/c_1",
            b"body"
        ));
        assert!(!check_signature(
            "s",
            &h,
            "PUT",
            "/api/ws/oc/files/c_2",
            b"body"
        ));
        assert!(!check_signature(
            "s",
            &h,
            "PUT",
            "/api/ws/oc/files/c_1",
            b"other"
        ));
        assert!(!check_signature(
            "x",
            &h,
            "PUT",
            "/api/ws/oc/files/c_1",
            b"body"
        ));
        let stale = format!("t=1,v2={}", h.rsplit("v2=").next().unwrap());
        assert!(!check_signature(
            "s",
            &stale,
            "PUT",
            "/api/ws/oc/files/c_1",
            b"body"
        ));
    }

    #[test]
    fn launch_tokens_carry_the_contract_claims() {
        let user = Person {
            id: "u_1".into(),
            name: "Asha".into(),
            detail: None,
            color: None,
        };
        let t = launch_token(&Launch {
            host_id: "workspace",
            secret: "0123456789abcdef0123456789abcdef",
            token_key: b"k",
            file_id: "c_1",
            file_name: "Plan",
            version: 3,
            ftype: "spreadsheet",
            user: &user,
            members: None,
            role: "comment",
            visitor: false,
        })
        .unwrap();
        use base64::Engine;
        let body = t.split('.').nth(1).unwrap();
        let v: serde_json::Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(body)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(v["iss"], "workspace");
        assert_eq!(v["aud"], "opencanvas");
        assert_eq!(v["file"]["type"], "spreadsheet");
        assert_eq!(v["file"]["version"], "3");
        assert_eq!(v["role"], "comment");
        assert_eq!(v["perms"]["history"], false);
        assert!(check_callback_token(b"k", "c_1", v["callbackToken"].as_str().unwrap()).is_some());
    }
}
