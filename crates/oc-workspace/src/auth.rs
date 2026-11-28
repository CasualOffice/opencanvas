// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Accounts (WS-05, docs/40 §4.2): Argon2id passwords, server-side sessions in `HttpOnly`
//! `SameSite=Lax` cookies, CSRF (a custom header plus the Origin check), rate limits and the
//! 15-minute lockout after 10 failures per account and per address.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode, header};
use sqlx::Row;

use crate::Ws;
use crate::access::Instance;
use crate::util::{ApiError, now_ms, sha256_hex};

pub const SESSION_COOKIE: &str = "ws_session";
pub const SESSION_DAYS: i64 = 30;
pub const LOCK_AFTER: i64 = 10;
pub const LOCK_MS: i64 = 15 * 60 * 1000;
pub const MIN_PASSWORD: usize = 10;
/// The header every state-changing API call carries (cross-site forms cannot set it).
pub const CSRF_HEADER: &str = "x-requested-with";
pub const CSRF_VALUE: &str = "opencanvas-workspace";

fn argon() -> Argon2<'static> {
    // OWASP's Argon2id baseline: 19 MiB, 2 passes, 1 lane.
    Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(19 * 1024, 2, 1, None).expect("params"),
    )
}

pub fn hash_password(pw: &str) -> anyhow::Result<String> {
    let salt = SaltString::encode_b64(&crate::util::random_bytes(16))
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(argon()
        .hash_password(pw.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .to_string())
}

/// A real Argon2id hash to check against when there is no account, so a missing account
/// costs the same time as a wrong password.
pub fn dummy_hash() -> &'static str {
    static H: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    H.get_or_init(|| hash_password("no such account here").unwrap_or_default())
}

pub fn verify_password(pw: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|h| argon().verify_password(pw.as_bytes(), &h).is_ok())
}

/// A small bundled list of leaked passwords that pass the length rule. A full list (the
/// "known leaked password" check of docs/40 §4.2) can be mounted with `WS_BREACHED_LIST`.
const BREACHED: &[&str] = &[
    "1234567890",
    "12345678910",
    "123456789a",
    "0123456789",
    "1q2w3e4r5t",
    "qwertyuiop",
    "password123",
    "password1234",
    "passw0rd123",
    "1qaz2wsx3edc",
    "qwerty12345",
    "qwerty123456",
    "iloveyou123",
    "abcdefghij",
    "abcd123456",
    "a1b2c3d4e5",
    "1111111111",
    "0000000000",
    "9876543210",
    "letmein123",
    "welcome123",
    "football123",
    "princess123",
    "sunshine123",
    "monkey12345",
    "dragon12345",
    "baseball123",
    "superman123",
    "trustno1234",
    "administrator",
    "changeme123",
    "qazwsxedcrfv",
    "zaq12wsxcde",
    "asdfghjkl1",
    "asdfghjkl;",
    "zxcvbnm123",
    "1234qwerasdf",
    "mypassword1",
    "password!23",
    "p@ssw0rd123",
    "opencanvas123",
];

/// Why a password is refused, in words for the form; `None` = fine.
pub fn password_problem(pw: &str, email: &str) -> Option<&'static str> {
    if pw.chars().count() < MIN_PASSWORD {
        return Some("Use at least 10 characters.");
    }
    if pw.len() > 256 {
        return Some("Use at most 256 characters.");
    }
    let lower = pw.to_lowercase();
    let listed = BREACHED.contains(&lower.as_str())
        || std::env::var("WS_BREACHED_LIST").ok().is_some_and(|p| {
            std::fs::read_to_string(p)
                .is_ok_and(|s| s.lines().any(|l| l.trim().eq_ignore_ascii_case(&lower)))
        });
    if listed {
        return Some("That password is on a list of leaked passwords. Choose another.");
    }
    if !email.is_empty() && lower.contains(&email.to_lowercase()) {
        return Some("Don't use your e-mail address in the password.");
    }
    if lower.chars().all(|c| lower.starts_with(c)) {
        return Some("Choose a password that isn't one repeated character.");
    }
    None
}

pub fn normalize_email(e: &str) -> Option<String> {
    let e = e.trim().to_lowercase();
    let (local, domain) = e.split_once('@')?;
    (!local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && e.len() <= 254
        && !e
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '<' || c == '>'))
    .then_some(e)
}

/// Failed sign-ins per address, in a sliding 15-minute window (per account: the users table).
#[derive(Default)]
pub struct Limiter {
    by_ip: Mutex<HashMap<IpAddr, (i64, i64)>>,
}

impl Limiter {
    pub fn blocked(&self, ip: Option<IpAddr>) -> bool {
        let Some(ip) = ip else { return false };
        let now = now_ms();
        let m = self.by_ip.lock().unwrap();
        m.get(&ip)
            .is_some_and(|(n, since)| *n >= LOCK_AFTER && now - since < LOCK_MS)
    }
    pub fn fail(&self, ip: Option<IpAddr>) {
        let Some(ip) = ip else { return };
        let now = now_ms();
        let mut m = self.by_ip.lock().unwrap();
        if m.len() > 100_000 {
            m.retain(|_, (_, since)| now - *since < LOCK_MS);
        }
        let e = m.entry(ip).or_insert((0, now));
        if now - e.1 >= LOCK_MS {
            *e = (0, now);
        }
        e.0 += 1;
    }
    pub fn success(&self, ip: Option<IpAddr>) {
        if let Some(ip) = ip {
            self.by_ip.lock().unwrap().remove(&ip);
        }
    }
}

/// The caller's address: the socket peer, or the first `X-Forwarded-For` hop when the operator
/// says a proxy is in front (`WS_TRUST_PROXY=1`).
pub fn client_ip(parts_ext: &axum::http::Extensions, headers: &HeaderMap) -> Option<IpAddr> {
    if std::env::var("WS_TRUST_PROXY").is_ok_and(|v| v == "1")
        && let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .and_then(|v| v.trim().parse().ok())
    {
        return Some(ip);
    }
    parts_ext.get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip())
}

/// From the same machine, with no proxy in between (the setup code is skipped, docs/40 §9.3).
pub fn is_loopback(parts_ext: &axum::http::Extensions, headers: &HeaderMap) -> bool {
    let peer = parts_ext.get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip());
    peer.is_some_and(|ip| ip.is_loopback())
        && !headers.contains_key("x-forwarded-for")
        && !headers.contains_key("forwarded")
        && !headers.contains_key("x-real-ip")
}

pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|kv| {
            let (k, v) = kv.trim().split_once('=')?;
            (k == name).then(|| v.to_string())
        })
}

pub fn session_cookie(value: &str, secure: bool, max_age_secs: i64) -> String {
    format!(
        "{SESSION_COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_secs}{}",
        if secure { "; Secure" } else { "" }
    )
}

/// Starts a session; returns the cookie value (only its hash is stored).
pub async fn create_session(ws: &Ws, user_id: &str, agent: &str) -> anyhow::Result<String> {
    let token = crate::util::token(32);
    let now = now_ms();
    sqlx::query("INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, agent) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(sha256_hex(&token))
        .bind(user_id)
        .bind(now)
        .bind(now + SESSION_DAYS * 86_400_000)
        .bind(now)
        .bind(agent.chars().take(200).collect::<String>())
        .execute(&ws.db.pool)
        .await?;
    Ok(token)
}

/// A signed-in person (the session cookie checked against the database).
#[derive(Clone, Debug)]
pub struct Me {
    pub id: String,
    pub name: String,
    pub email: String,
    pub role: Instance,
    pub color: String,
    pub session_hash: String,
}

impl FromRequestParts<Ws> for Me {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, ws: &Ws) -> Result<Self, Self::Rejection> {
        let token =
            cookie_value(&parts.headers, SESSION_COOKIE).ok_or_else(ApiError::unauthorized)?;
        let hash = sha256_hex(&token);
        let now = now_ms();
        let row = sqlx::query(
            "SELECT u.id, u.name, u.email, u.role, u.color, u.status, s.expires_at, s.last_seen_at \
             FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?",
        )
        .bind(&hash)
        .fetch_optional(&ws.db.pool)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
        let status: String = row.try_get(5)?;
        let expires: i64 = row.try_get(6)?;
        if status != "active" || expires < now {
            return Err(ApiError::unauthorized());
        }
        let seen: i64 = row.try_get(7)?;
        let id: String = row.try_get(0)?;
        if now - seen > 5 * 60 * 1000 {
            // Sliding expiry, written at most every 5 minutes.
            let _ = sqlx::query(
                "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?",
            )
            .bind(now)
            .bind(now + SESSION_DAYS * 86_400_000)
            .bind(&hash)
            .execute(&ws.db.pool)
            .await;
            let _ = sqlx::query("UPDATE users SET last_active_at = ? WHERE id = ?")
                .bind(now)
                .bind(&id)
                .execute(&ws.db.pool)
                .await;
        }
        let role: String = row.try_get(3)?;
        Ok(Me {
            id,
            name: row.try_get(1)?,
            email: row.try_get(2)?,
            role: Instance::parse(&role).unwrap_or(Instance::Guest),
            color: row.try_get(4)?,
            session_hash: hash,
        })
    }
}

/// An admin (Owner or Admin).
pub struct Admin(pub Me);

impl FromRequestParts<Ws> for Admin {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, ws: &Ws) -> Result<Self, Self::Rejection> {
        let me = Me::from_request_parts(parts, ws).await?;
        if !me.role.is_admin() {
            return Err(ApiError::forbidden("Only admins can do that."));
        }
        Ok(Admin(me))
    }
}

/// CSRF for the cookie-authenticated API: state-changing calls need the custom header, and an
/// `Origin`, when sent, must be this site's.
pub fn csrf_ok(method: &axum::http::Method, headers: &HeaderMap, public_url: Option<&str>) -> bool {
    if matches!(
        *method,
        axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
    ) {
        return true;
    }
    if headers.get(CSRF_HEADER).and_then(|v| v.to_str().ok()) != Some(CSRF_VALUE) {
        return false;
    }
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let same_host = origin
        .split_once("://")
        .is_some_and(|(_, rest)| rest.trim_end_matches('/') == host);
    same_host || public_url.is_some_and(|u| u.trim_end_matches('/') == origin)
}

pub fn forbidden_csrf() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "CSRF",
        "Refused: missing request header or foreign origin",
    )
}

/// A stable presence colour per person (the editor derives one otherwise).
pub fn color_for(seed: &str) -> String {
    const COLORS: &[&str] = &[
        "#2a5ad7", "#7a45f0", "#e5602a", "#0e9a78", "#d63f78", "#b7791f", "#0f6b5f", "#6538c4",
    ];
    let h = seed
        .bytes()
        .fold(0u32, |a, b| a.wrapping_mul(31).wrapping_add(b as u32));
    COLORS[h as usize % COLORS.len()].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passwords_hash_with_argon2id_and_verify() {
        let h = hash_password("correct horse battery").unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(verify_password("correct horse battery", &h));
        assert!(!verify_password("wrong horse battery", &h));
        assert!(!verify_password("x", "not a hash"));
    }

    #[test]
    fn password_rules() {
        assert!(password_problem("short", "").is_some());
        assert!(password_problem("1234567890", "").is_some());
        assert!(password_problem("Password123", "").is_some());
        assert!(password_problem("aaaaaaaaaaaa", "").is_some());
        assert!(password_problem("lena@acme.example!", "lena@acme.example").is_some());
        assert_eq!(
            password_problem("plum orbit lantern", "lena@acme.example"),
            None
        );
    }

    #[test]
    fn emails_are_normalized() {
        assert_eq!(
            normalize_email(" Lena@Acme.Example ").as_deref(),
            Some("lena@acme.example")
        );
        for bad in [
            "",
            "lena",
            "@acme.example",
            "lena@acme",
            "a b@acme.example",
            "lena@.example",
        ] {
            assert_eq!(normalize_email(bad), None, "{bad}");
        }
    }

    #[test]
    fn lockout_after_ten_failures_per_address() {
        let l = Limiter::default();
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        for _ in 0..9 {
            l.fail(Some(ip));
        }
        assert!(!l.blocked(Some(ip)));
        l.fail(Some(ip));
        assert!(l.blocked(Some(ip)));
        assert!(!l.blocked(Some("10.0.0.2".parse().unwrap())));
        l.success(Some(ip));
        assert!(!l.blocked(Some(ip)));
    }

    #[test]
    fn csrf_needs_the_header_and_a_same_origin() {
        use axum::http::{HeaderValue, Method};
        let mut h = HeaderMap::new();
        assert!(csrf_ok(&Method::GET, &h, None));
        assert!(!csrf_ok(&Method::POST, &h, None));
        h.insert(CSRF_HEADER, HeaderValue::from_static(CSRF_VALUE));
        assert!(csrf_ok(&Method::POST, &h, None));
        h.insert(
            header::HOST,
            HeaderValue::from_static("canvas.acme.example"),
        );
        h.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://evil.example"),
        );
        assert!(!csrf_ok(&Method::POST, &h, None));
        h.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://canvas.acme.example"),
        );
        assert!(csrf_ok(&Method::POST, &h, None));
    }
}
