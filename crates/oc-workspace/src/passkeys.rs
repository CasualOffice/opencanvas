// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Passkeys (WS-06, docs/40 §4.2): WebAuthn registration and sign-in, usable as someone's only
//! sign-in. Discoverable credentials, `none` attestation, ES256 (P-256) signatures checked with
//! the RustCrypto `p256` crate. The protocol parsing (client data, authenticator data, the small
//! CBOR subset WebAuthn uses) is here; the cryptography is not.

use base64::Engine;
use sha2::{Digest, Sha256};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

pub fn b64(b: &[u8]) -> String {
    B64.encode(b)
}

pub fn unb64(s: &str) -> Option<Vec<u8>> {
    B64.decode(s.trim_end_matches('=')).ok()
}

/// The CBOR values WebAuthn uses (RFC 8949 major types 0-5).
#[derive(Debug, Clone, PartialEq)]
pub enum Cbor {
    Int(i64),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<Cbor>),
    Map(Vec<(Cbor, Cbor)>),
    Other,
}

impl Cbor {
    pub fn get(&self, key: &Cbor) -> Option<&Cbor> {
        match self {
            Cbor::Map(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    fn bytes(&self) -> Option<&[u8]> {
        match self {
            Cbor::Bytes(b) => Some(b),
            _ => None,
        }
    }
}

/// Decodes one CBOR item; returns it and the bytes after it. Depth and sizes are bounded.
pub fn cbor(b: &[u8]) -> Option<(Cbor, &[u8])> {
    cbor_at(b, 0)
}

fn cbor_at(b: &[u8], depth: usize) -> Option<(Cbor, &[u8])> {
    if depth > 8 {
        return None;
    }
    let (&first, rest) = b.split_first()?;
    let major = first >> 5;
    let info = first & 0x1f;
    let (n, rest) = match info {
        0..=23 => (info as u64, rest),
        24 => (*rest.first()? as u64, &rest[1..]),
        25 => (
            u16::from_be_bytes(rest.get(..2)?.try_into().ok()?) as u64,
            &rest[2..],
        ),
        26 => (
            u32::from_be_bytes(rest.get(..4)?.try_into().ok()?) as u64,
            &rest[4..],
        ),
        27 => (
            u64::from_be_bytes(rest.get(..8)?.try_into().ok()?),
            &rest[8..],
        ),
        _ => return None,
    };
    let len = |n: u64| usize::try_from(n).ok().filter(|n| *n <= 1 << 20);
    Some(match major {
        0 => (Cbor::Int(i64::try_from(n).ok()?), rest),
        1 => (Cbor::Int(-1 - i64::try_from(n).ok()?), rest),
        2 => {
            let l = len(n)?;
            (Cbor::Bytes(rest.get(..l)?.to_vec()), &rest[l..])
        }
        3 => {
            let l = len(n)?;
            (
                Cbor::Text(String::from_utf8(rest.get(..l)?.to_vec()).ok()?),
                &rest[l..],
            )
        }
        4 => {
            let mut v = Vec::new();
            let mut r = rest;
            for _ in 0..len(n).filter(|n| *n <= 64)? {
                let (x, r2) = cbor_at(r, depth + 1)?;
                v.push(x);
                r = r2;
            }
            (Cbor::Array(v), r)
        }
        5 => {
            let mut v = Vec::new();
            let mut r = rest;
            for _ in 0..len(n).filter(|n| *n <= 64)? {
                let (k, r2) = cbor_at(r, depth + 1)?;
                let (x, r3) = cbor_at(r2, depth + 1)?;
                v.push((k, x));
                r = r3;
            }
            (Cbor::Map(v), r)
        }
        _ => (Cbor::Other, rest),
    })
}

/// Parsed authenticator data (WebAuthn §6.1).
#[derive(Debug)]
pub struct AuthData {
    pub rp_id_hash: [u8; 32],
    pub flags: u8,
    pub sign_count: u32,
    /// Registration only: the credential id and its COSE public key.
    pub credential: Option<(Vec<u8>, Cbor)>,
}

pub fn auth_data(b: &[u8]) -> Option<AuthData> {
    let rp_id_hash: [u8; 32] = b.get(..32)?.try_into().ok()?;
    let flags = *b.get(32)?;
    let sign_count = u32::from_be_bytes(b.get(33..37)?.try_into().ok()?);
    let credential = if flags & 0x40 != 0 {
        let rest = b.get(37 + 16..)?; // after the AAGUID
        let l = u16::from_be_bytes(rest.get(..2)?.try_into().ok()?) as usize;
        if l > 1023 {
            return None;
        }
        let id = rest.get(2..2 + l)?.to_vec();
        let (key, _) = cbor(rest.get(2 + l..)?)?;
        Some((id, key))
    } else {
        None
    };
    Some(AuthData {
        rp_id_hash,
        flags,
        sign_count,
        credential,
    })
}

/// A COSE ES256 key as uncompressed SEC1 bytes (what we store).
pub fn es256_public(cose: &Cbor) -> Option<Vec<u8>> {
    let kty = cose.get(&Cbor::Int(1))?;
    let alg = cose.get(&Cbor::Int(3))?;
    let crv = cose.get(&Cbor::Int(-1))?;
    if kty != &Cbor::Int(2) || alg != &Cbor::Int(-7) || crv != &Cbor::Int(1) {
        return None;
    }
    let x = cose.get(&Cbor::Int(-2))?.bytes()?;
    let y = cose.get(&Cbor::Int(-3))?.bytes()?;
    if x.len() != 32 || y.len() != 32 {
        return None;
    }
    let mut k = vec![4u8];
    k.extend_from_slice(x);
    k.extend_from_slice(y);
    // Must be a point on the curve.
    p256::ecdsa::VerifyingKey::from_sec1_bytes(&k).ok()?;
    Some(k)
}

/// Checks an ES256 assertion signature over `authenticatorData || SHA-256(clientDataJSON)`.
pub fn es256_verify(
    public_sec1: &[u8],
    auth_data: &[u8],
    client_data: &[u8],
    der_sig: &[u8],
) -> bool {
    use p256::ecdsa::signature::Verifier;
    let Ok(key) = p256::ecdsa::VerifyingKey::from_sec1_bytes(public_sec1) else {
        return false;
    };
    let Ok(sig) = p256::ecdsa::Signature::from_der(der_sig) else {
        return false;
    };
    let mut msg = auth_data.to_vec();
    msg.extend_from_slice(&Sha256::digest(client_data));
    key.verify(&msg, &sig).is_ok()
}

/// What `clientDataJSON` must say: the ceremony, our challenge and our origin.
pub fn check_client_data(
    raw: &[u8],
    kind: &str,
    challenge: &[u8],
    origins: &[String],
) -> Result<(), &'static str> {
    let v: serde_json::Value =
        serde_json::from_slice(raw).map_err(|_| "client data is not JSON")?;
    if v["type"].as_str() != Some(kind) {
        return Err("wrong ceremony");
    }
    let got = v["challenge"]
        .as_str()
        .and_then(unb64)
        .ok_or("no challenge")?;
    if !crate::util::ct_eq(&got, challenge) {
        return Err("wrong challenge");
    }
    let origin = v["origin"].as_str().unwrap_or("");
    if !origins.iter().any(|o| o == origin) {
        return Err("wrong origin");
    }
    if v["crossOrigin"].as_bool() == Some(true) {
        return Err("cross-origin");
    }
    Ok(())
}

pub fn rp_id_hash(rp_id: &str) -> [u8; 32] {
    Sha256::digest(rp_id.as_bytes()).into()
}

/// The relying party id: the public address's host (no port), else the request's.
pub fn rp_id(public_base: &str, host_header: &str) -> String {
    let from = if public_base.is_empty() {
        host_header.to_string()
    } else {
        public_base.split("://").nth(1).unwrap_or("").to_string()
    };
    from.split('/')
        .next()
        .unwrap_or("")
        .rsplit_once(':')
        .map(|(h, p)| {
            if p.chars().all(|c| c.is_ascii_digit()) {
                h.to_string()
            } else {
                format!("{h}:{p}")
            }
        })
        .unwrap_or_else(|| from.split('/').next().unwrap_or("").to_string())
}

// ---------------------------------------------------------------- the API

use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;

use crate::Ws;
use crate::auth::Me;
use crate::util::{ApiError, ApiResult, now_ms, sha256_hex};

const CHALLENGE_MS: i64 = 5 * 60 * 1000;

pub fn router() -> Router<Ws> {
    Router::new()
        .route("/passkeys", get(list))
        .route("/passkeys/{id}", delete(remove))
        .route("/passkeys/register/options", post(register_options))
        .route("/passkeys/register", post(register))
        .route("/passkeys/login/options", post(login_options))
        .route("/passkeys/login", post(login))
}

/// Our relying party id and the origins a ceremony may come from.
async fn rp(ws: &Ws, h: &HeaderMap) -> (String, Vec<String>) {
    let public = ws.public_base().await;
    let host = h
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost")
        .to_string();
    let origins = if public.is_empty() {
        vec![format!("http://{host}"), format!("https://{host}")]
    } else {
        vec![public.clone()]
    };
    (rp_id(&public, &host), origins)
}

async fn new_challenge(ws: &Ws, purpose: &str, user: Option<&str>) -> ApiResult<String> {
    let c = b64(&crate::util::random_bytes(32));
    let now = now_ms();
    sqlx::query("DELETE FROM webauthn_challenges WHERE expires_at < ?")
        .bind(now)
        .execute(&ws.db.pool)
        .await?;
    sqlx::query("INSERT INTO webauthn_challenges (challenge_hash, purpose, user_id, expires_at) VALUES (?, ?, ?, ?)")
        .bind(sha256_hex(&c))
        .bind(purpose)
        .bind(user)
        .bind(now + CHALLENGE_MS)
        .execute(&ws.db.pool)
        .await?;
    Ok(c)
}

/// Takes the challenge named in `clientDataJSON` (single use); returns its raw bytes and owner.
async fn take_challenge(
    ws: &Ws,
    client_data: &[u8],
    purpose: &str,
) -> ApiResult<(Vec<u8>, Option<String>)> {
    let bad = || ApiError::bad("CHALLENGE", "This sign-in request expired. Try again.");
    let v: serde_json::Value = serde_json::from_slice(client_data).map_err(|_| bad())?;
    let c = v["challenge"].as_str().ok_or_else(bad)?.to_string();
    let row = sqlx::query("SELECT user_id, expires_at FROM webauthn_challenges WHERE challenge_hash = ? AND purpose = ?")
        .bind(sha256_hex(&c))
        .bind(purpose)
        .fetch_optional(&ws.db.pool)
        .await?
        .ok_or_else(bad)?;
    let n = sqlx::query("DELETE FROM webauthn_challenges WHERE challenge_hash = ?")
        .bind(sha256_hex(&c))
        .execute(&ws.db.pool)
        .await?
        .rows_affected();
    let exp: i64 = row.try_get(1)?;
    if n != 1 || exp < now_ms() {
        return Err(bad());
    }
    Ok((unb64(&c).ok_or_else(bad)?, row.try_get(0)?))
}

async fn register_options(
    State(ws): State<Ws>,
    me: Me,
    h: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    let (rp_id, _) = rp(&ws, &h).await;
    let (s, _) = crate::settings::Settings::load(&ws.db, &ws.cfg).await?;
    let challenge = new_challenge(&ws, "register", Some(&me.id)).await?;
    let existing: Vec<String> = sqlx::query_scalar("SELECT id FROM passkeys WHERE user_id = ?")
        .bind(&me.id)
        .fetch_all(&ws.db.pool)
        .await?;
    Ok(Json(json!({"publicKey": {
        "challenge": challenge,
        "rp": {"id": rp_id, "name": s.org_name},
        "user": {"id": b64(me.id.as_bytes()), "name": me.email, "displayName": me.name},
        "pubKeyCredParams": [{"type": "public-key", "alg": -7}],
        "authenticatorSelection": {"residentKey": "required", "userVerification": "preferred"},
        "excludeCredentials": existing.iter().map(|id| json!({"type": "public-key", "id": id})).collect::<Vec<_>>(),
        "attestation": "none",
        "timeout": CHALLENGE_MS,
    }})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredResponse {
    #[serde(rename = "clientDataJSON")]
    client_data_json: String,
    attestation_object: Option<String>,
    authenticator_data: Option<String>,
    signature: Option<String>,
}

#[derive(Deserialize)]
struct Cred {
    id: String,
    name: Option<String>,
    response: CredResponse,
}

async fn register(
    State(ws): State<Ws>,
    me: Me,
    h: HeaderMap,
    Json(c): Json<Cred>,
) -> ApiResult<Json<serde_json::Value>> {
    let bad = |m: &'static str| ApiError::bad("PASSKEY", m);
    let cd = unb64(&c.response.client_data_json).ok_or(bad("Unreadable response"))?;
    let (challenge, owner) = take_challenge(&ws, &cd, "register").await?;
    if owner.as_deref() != Some(me.id.as_str()) {
        return Err(bad("This request was for someone else."));
    }
    let (rp_id, origins) = rp(&ws, &h).await;
    check_client_data(&cd, "webauthn.create", &challenge, &origins).map_err(bad)?;
    let att = unb64(c.response.attestation_object.as_deref().unwrap_or(""))
        .ok_or(bad("No attestation"))?;
    let (obj, _) = cbor(&att).ok_or(bad("Unreadable attestation"))?;
    let ad = obj
        .get(&Cbor::Text("authData".into()))
        .and_then(Cbor::bytes)
        .ok_or(bad("No authenticator data"))?;
    let ad = auth_data(ad).ok_or(bad("Unreadable authenticator data"))?;
    if ad.rp_id_hash != rp_id_hash(&rp_id) || ad.flags & 0x01 == 0 {
        return Err(bad("This passkey is for another site."));
    }
    let (id, key) = ad.credential.ok_or(bad("No credential"))?;
    if unb64(&c.id).as_deref() != Some(id.as_slice()) {
        return Err(bad("Credential mismatch"));
    }
    let public = es256_public(&key).ok_or(bad(
        "This kind of passkey isn't supported yet (ES256 only).",
    ))?;
    let name = crate::util::clean_name(c.name.as_deref().unwrap_or("Passkey"), 60);
    sqlx::query("INSERT INTO passkeys (id, user_id, public_key, sign_count, name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(b64(&id))
        .bind(&me.id)
        .bind(hex::encode(&public))
        .bind(ad.sign_count as i64)
        .bind(if name.is_empty() { "Passkey".to_string() } else { name })
        .bind(now_ms())
        .execute(&ws.db.pool)
        .await
        .map_err(|_| bad("This passkey is already added."))?;
    Ok(Json(json!({"ok": true})))
}

async fn login_options(State(ws): State<Ws>, h: HeaderMap) -> ApiResult<Json<serde_json::Value>> {
    let (rp_id, _) = rp(&ws, &h).await;
    let challenge = new_challenge(&ws, "login", None).await?;
    Ok(Json(
        json!({"publicKey": {"challenge": challenge, "rpId": rp_id, "userVerification": "preferred", "allowCredentials": [], "timeout": CHALLENGE_MS}}),
    ))
}

async fn login(State(ws): State<Ws>, req: axum::extract::Request) -> ApiResult<Response> {
    let ip = crate::auth::client_ip(req.extensions(), req.headers());
    let h = req.headers().clone();
    let agent = h
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = axum::body::to_bytes(req.into_body(), 64 * 1024)
        .await
        .map_err(|_| ApiError::bad("BODY", "Body too large"))?;
    let c: Cred =
        serde_json::from_slice(&bytes).map_err(|e| ApiError::bad("JSON", e.to_string()))?;
    let no = || {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "PASSKEY",
            "That passkey didn't work. Try again or use your password.",
        )
    };
    if ws.limiter.blocked(ip) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "LOCKED",
            "Too many tries. Wait 15 minutes.",
        ));
    }
    let r = async {
        let cd = unb64(&c.response.client_data_json).ok_or_else(no)?;
        let (challenge, _) = take_challenge(&ws, &cd, "login").await.map_err(|_| no())?;
        let (rp_id, origins) = rp(&ws, &h).await;
        check_client_data(&cd, "webauthn.get", &challenge, &origins).map_err(|_| no())?;
        let row = sqlx::query("SELECT p.user_id, p.public_key, p.sign_count, u.status FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ?")
            .bind(&c.id)
            .fetch_optional(&ws.db.pool)
            .await?
            .ok_or_else(no)?;
        let ad_raw = unb64(c.response.authenticator_data.as_deref().unwrap_or("")).ok_or_else(no)?;
        let sig = unb64(c.response.signature.as_deref().unwrap_or("")).ok_or_else(no)?;
        let ad = auth_data(&ad_raw).ok_or_else(no)?;
        let public = hex::decode(row.try_get::<String, _>(1)?).map_err(|_| no())?;
        if ad.rp_id_hash != rp_id_hash(&rp_id) || ad.flags & 0x01 == 0 || !es256_verify(&public, &ad_raw, &cd, &sig) {
            return Err(no());
        }
        let old: i64 = row.try_get(2)?;
        // A counter that goes backwards means a cloned authenticator (WebAuthn §6.1.1).
        if (ad.sign_count != 0 || old != 0) && (ad.sign_count as i64) <= old {
            return Err(no());
        }
        if row.try_get::<String, _>(3)? != "active" {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "SUSPENDED", "This account is suspended. Ask an admin."));
        }
        sqlx::query("UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?").bind(ad.sign_count as i64).bind(now_ms()).bind(&c.id).execute(&ws.db.pool).await?;
        Ok::<String, ApiError>(row.try_get(0)?)
    }
    .await;
    let uid = match r {
        Ok(u) => u,
        Err(e) => {
            ws.limiter.fail(ip);
            return Err(e);
        }
    };
    ws.limiter.success(ip);
    let token = crate::auth::create_session(&ws, &uid, &agent).await?;
    let mut res = Json(json!({"ok": true})).into_response();
    let cookie = crate::auth::session_cookie(
        &token,
        ws.secure_cookies().await,
        crate::auth::SESSION_DAYS * 86_400,
    );
    res.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|_| no())?,
    );
    Ok(res)
}

async fn list(State(ws): State<Ws>, me: Me) -> ApiResult<Json<serde_json::Value>> {
    let rows = sqlx::query("SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at").bind(&me.id).fetch_all(&ws.db.pool).await?;
    let list: Vec<_> = rows
        .iter()
        .map(|r| json!({"id": r.try_get::<String, _>(0).ok(), "name": r.try_get::<String, _>(1).ok(), "createdAt": r.try_get::<i64, _>(2).ok(), "lastUsedAt": r.try_get::<Option<i64>, _>(3).ok().flatten()}))
        .collect();
    Ok(Json(json!({"passkeys": list})))
}

async fn remove(State(ws): State<Ws>, me: Me, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let has_pw: Option<String> = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?")
        .bind(&me.id)
        .fetch_one(&ws.db.pool)
        .await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM passkeys WHERE user_id = ?")
        .bind(&me.id)
        .fetch_one(&ws.db.pool)
        .await?;
    if has_pw.is_none() && count <= 1 {
        return Err(ApiError::bad(
            "LAST",
            "This is your only way to sign in. Set a password or add another passkey first.",
        ));
    }
    sqlx::query("DELETE FROM passkeys WHERE id = ? AND user_id = ?")
        .bind(&id)
        .bind(&me.id)
        .execute(&ws.db.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
pub mod testkit {
    //! A software authenticator for tests: makes attestation objects and assertions.
    use super::*;
    use p256::ecdsa::signature::Signer;

    pub struct Authenticator {
        pub key: p256::ecdsa::SigningKey,
        pub id: Vec<u8>,
        pub count: u32,
    }

    fn cbor_head(major: u8, n: usize, out: &mut Vec<u8>) {
        if n < 24 {
            out.push(major << 5 | n as u8);
        } else if n < 256 {
            out.push(major << 5 | 24);
            out.push(n as u8);
        } else {
            out.push(major << 5 | 25);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
    }
    fn int(i: i64, out: &mut Vec<u8>) {
        if i >= 0 {
            cbor_head(0, i as usize, out)
        } else {
            cbor_head(1, (-1 - i) as usize, out)
        }
    }
    fn bytes(b: &[u8], out: &mut Vec<u8>) {
        cbor_head(2, b.len(), out);
        out.extend_from_slice(b);
    }
    fn text(s: &str, out: &mut Vec<u8>) {
        cbor_head(3, s.len(), out);
        out.extend_from_slice(s.as_bytes());
    }

    impl Default for Authenticator {
        fn default() -> Self {
            Self::new()
        }
    }

    impl Authenticator {
        pub fn new() -> Self {
            let mut seed = [0u8; 32];
            seed.copy_from_slice(&crate::util::random_bytes(32));
            seed[0] |= 1;
            Self {
                key: p256::ecdsa::SigningKey::from_slice(&seed).unwrap(),
                id: crate::util::random_bytes(16),
                count: 0,
            }
        }
        fn cose(&self) -> Vec<u8> {
            let p = self.key.verifying_key().to_sec1_point(false);
            let p = p.as_bytes();
            let mut o = Vec::new();
            cbor_head(5, 5, &mut o);
            int(1, &mut o);
            int(2, &mut o);
            int(3, &mut o);
            int(-7, &mut o);
            int(-1, &mut o);
            int(1, &mut o);
            int(-2, &mut o);
            bytes(&p[1..33], &mut o);
            int(-3, &mut o);
            bytes(&p[33..65], &mut o);
            o
        }
        pub fn client_data(kind: &str, challenge: &str, origin: &str) -> Vec<u8> {
            serde_json::json!({"type": kind, "challenge": challenge, "origin": origin, "crossOrigin": false}).to_string().into_bytes()
        }
        /// `navigator.credentials.create`: (clientDataJSON, attestationObject).
        pub fn create(&mut self, rp_id: &str, challenge: &str, origin: &str) -> (Vec<u8>, Vec<u8>) {
            let mut ad = rp_id_hash(rp_id).to_vec();
            ad.push(0x01 | 0x04 | 0x40);
            ad.extend_from_slice(&0u32.to_be_bytes());
            ad.extend_from_slice(&[0u8; 16]);
            ad.extend_from_slice(&(self.id.len() as u16).to_be_bytes());
            ad.extend_from_slice(&self.id);
            ad.extend_from_slice(&self.cose());
            let mut att = Vec::new();
            cbor_head(5, 3, &mut att);
            text("fmt", &mut att);
            text("none", &mut att);
            text("attStmt", &mut att);
            cbor_head(5, 0, &mut att);
            text("authData", &mut att);
            bytes(&ad, &mut att);
            (Self::client_data("webauthn.create", challenge, origin), att)
        }
        /// `navigator.credentials.get`: (clientDataJSON, authenticatorData, signature).
        pub fn get(
            &mut self,
            rp_id: &str,
            challenge: &str,
            origin: &str,
        ) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
            self.count += 1;
            let mut ad = rp_id_hash(rp_id).to_vec();
            ad.push(0x01 | 0x04);
            ad.extend_from_slice(&self.count.to_be_bytes());
            let cd = Self::client_data("webauthn.get", challenge, origin);
            let mut msg = ad.clone();
            msg.extend_from_slice(&Sha256::digest(&cd));
            let sig: p256::ecdsa::Signature = self.key.sign(&msg);
            (cd, ad, sig.to_der().as_bytes().to_vec())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_and_assertion_verify_and_tampering_fails() {
        let mut a = testkit::Authenticator::new();
        let ch = crate::util::random_bytes(32);
        let (cd, att) = a.create(
            "canvas.acme.example",
            &b64(&ch),
            "https://canvas.acme.example",
        );
        check_client_data(
            &cd,
            "webauthn.create",
            &ch,
            &["https://canvas.acme.example".into()],
        )
        .unwrap();
        assert_eq!(
            check_client_data(
                &cd,
                "webauthn.create",
                &ch,
                &["https://evil.example".into()]
            ),
            Err("wrong origin")
        );
        assert_eq!(
            check_client_data(
                &cd,
                "webauthn.get",
                &ch,
                &["https://canvas.acme.example".into()]
            ),
            Err("wrong ceremony")
        );
        let (obj, _) = cbor(&att).unwrap();
        let ad = auth_data(
            obj.get(&Cbor::Text("authData".into()))
                .unwrap()
                .bytes()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(ad.rp_id_hash, rp_id_hash("canvas.acme.example"));
        let (id, key) = ad.credential.unwrap();
        assert_eq!(id, a.id);
        let public = es256_public(&key).unwrap();
        let (cd, adata, sig) = a.get(
            "canvas.acme.example",
            &b64(&ch),
            "https://canvas.acme.example",
        );
        assert!(es256_verify(&public, &adata, &cd, &sig));
        let mut bad = adata.clone();
        bad[33] ^= 1;
        assert!(!es256_verify(&public, &bad, &cd, &sig));
        assert!(!es256_verify(&public, &adata, b"{}", &sig));
    }

    #[test]
    fn cbor_rejects_truncated_and_deep_input() {
        assert!(cbor(&[0x58, 10, 1, 2]).is_none());
        assert!(cbor(&[0x81; 20]).is_none());
        assert_eq!(cbor(&[0x20]).unwrap().0, Cbor::Int(-1));
    }

    #[test]
    fn rp_id_is_the_host_without_port() {
        assert_eq!(
            rp_id("https://canvas.acme.example", ""),
            "canvas.acme.example"
        );
        assert_eq!(rp_id("", "localhost:8080"), "localhost");
        assert_eq!(rp_id("http://127.0.0.1:8080/x", ""), "127.0.0.1");
    }
}

#[cfg(test)]
mod flow_tests {
    //! WS-06 end to end through the API: add a passkey, sign in with it (no password), a
    //! replayed or foreign assertion fails, and a passkey-only account comes from an invite.
    use super::testkit::Authenticator;
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, header};
    use serde_json::{Value, json};
    use tower::ServiceExt;

    const ORIGIN: &str = "http://localhost";

    async fn call(
        app: &axum::Router,
        method: &str,
        path: &str,
        cookie: Option<&str>,
        body: Value,
    ) -> (u16, Value, Option<String>) {
        let mut b = Request::builder()
            .method(method)
            .uri(path)
            .header("x-requested-with", "opencanvas-workspace")
            .header(header::HOST, "localhost")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(c) = cookie {
            b = b.header(header::COOKIE, format!("ws_session={c}"));
        }
        let mut r = b.body(Body::from(body.to_string())).unwrap();
        r.extensions_mut().insert(axum::extract::ConnectInfo(
            "127.0.0.1:1".parse::<std::net::SocketAddr>().unwrap(),
        ));
        let res = app.clone().oneshot(r).await.unwrap();
        let st = res.status().as_u16();
        let ck = res
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("ws_session="))
            .map(|v| v.split(';').next().unwrap().to_string());
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            st,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            ck,
        )
    }

    #[tokio::test]
    async fn add_a_passkey_and_sign_in_with_it() {
        let dir = std::env::temp_dir().join(format!("ws-pk-{}", crate::util::token(6)));
        let ws = crate::WsState::new(
            crate::config::WsConfig::for_tests(&dir),
            crate::secrets::Secrets::for_tests(),
        )
        .await
        .unwrap();
        let app = crate::router(ws);
        let setup = json!({"orgName": "Acme", "adminName": "Priya", "adminEmail": "priya@acme.example", "adminPassword": "plum orbit lantern", "workspaceName": "Product", "sample": false});
        let (st, _, owner) = call(&app, "POST", "/api/ws/setup", None, setup).await;
        assert_eq!(st, 200);
        let owner = owner.unwrap();
        // Register.
        let (st, opts, _) = call(
            &app,
            "POST",
            "/api/ws/passkeys/register/options",
            Some(&owner),
            json!({}),
        )
        .await;
        assert_eq!(st, 200, "{opts}");
        assert_eq!(opts["publicKey"]["rp"]["id"], "localhost");
        let ch = opts["publicKey"]["challenge"].as_str().unwrap().to_string();
        let mut a = Authenticator::new();
        let (cd, att) = a.create("localhost", &ch, ORIGIN);
        let reg = json!({"id": b64(&a.id), "name": "This Mac", "response": {"clientDataJSON": b64(&cd), "attestationObject": b64(&att)}});
        let (st, r, _) = call(
            &app,
            "POST",
            "/api/ws/passkeys/register",
            Some(&owner),
            reg.clone(),
        )
        .await;
        assert_eq!(st, 200, "{r}");
        let (_, list, _) = call(&app, "GET", "/api/ws/passkeys", Some(&owner), json!({})).await;
        assert_eq!(list["passkeys"][0]["name"], "This Mac");
        // The same challenge cannot register twice.
        let (st, _, _) = call(&app, "POST", "/api/ws/passkeys/register", Some(&owner), reg).await;
        assert_eq!(st, 400);
        // Sign in without a session or a password.
        let (_, o, _) = call(
            &app,
            "POST",
            "/api/ws/passkeys/login/options",
            None,
            json!({}),
        )
        .await;
        let ch = o["publicKey"]["challenge"].as_str().unwrap().to_string();
        let (cd, ad, sig) = a.get("localhost", &ch, ORIGIN);
        let body = json!({"id": b64(&a.id), "response": {"clientDataJSON": b64(&cd), "authenticatorData": b64(&ad), "signature": b64(&sig)}});
        let (st, r, cookie) =
            call(&app, "POST", "/api/ws/passkeys/login", None, body.clone()).await;
        assert_eq!(st, 200, "{r}");
        let (st, me, _) = call(&app, "GET", "/api/ws/me", cookie.as_deref(), json!({})).await;
        assert_eq!((st, me["name"].as_str()), (200, Some("Priya")));
        // A replay (same challenge, same counter) fails.
        let (st, _, _) = call(&app, "POST", "/api/ws/passkeys/login", None, body).await;
        assert_eq!(st, 401);
        // Another authenticator's signature with our credential id fails.
        let (_, o, _) = call(
            &app,
            "POST",
            "/api/ws/passkeys/login/options",
            None,
            json!({}),
        )
        .await;
        let ch = o["publicKey"]["challenge"].as_str().unwrap().to_string();
        let mut other = Authenticator::new();
        let (cd, ad, sig) = other.get("localhost", &ch, ORIGIN);
        let forged = json!({"id": b64(&a.id), "response": {"clientDataJSON": b64(&cd), "authenticatorData": b64(&ad), "signature": b64(&sig)}});
        let (st, _, _) = call(&app, "POST", "/api/ws/passkeys/login", None, forged).await;
        assert_eq!(st, 401);
        // A passkey-only account from an invite: sign up without a password, then add the passkey.
        let (_, inv, _) = call(
            &app,
            "POST",
            "/api/ws/invites",
            Some(&owner),
            json!({"kind": "org", "role": "member"}),
        )
        .await;
        let su = json!({"invite": inv["token"], "name": "Lena", "email": "lena@acme.example", "passkey": true});
        let (st, r, lena) = call(&app, "POST", "/api/ws/auth/signup", None, su).await;
        assert_eq!(st, 200, "{r}");
        let lena = lena.unwrap();
        let (_, opts, _) = call(
            &app,
            "POST",
            "/api/ws/passkeys/register/options",
            Some(&lena),
            json!({}),
        )
        .await;
        let mut b = Authenticator::new();
        let (cd, att) = b.create(
            "localhost",
            opts["publicKey"]["challenge"].as_str().unwrap(),
            ORIGIN,
        );
        let reg = json!({"id": b64(&b.id), "response": {"clientDataJSON": b64(&cd), "attestationObject": b64(&att)}});
        let (st, _, _) = call(&app, "POST", "/api/ws/passkeys/register", Some(&lena), reg).await;
        assert_eq!(st, 200);
        let _ = std::fs::remove_dir_all(dir);
    }
}
