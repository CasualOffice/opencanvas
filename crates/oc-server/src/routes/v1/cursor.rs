// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Opaque, signed paging cursors for `/api/v1` (docs/27 §4.2, HAPI-04).
//!
//! A cursor is `base64url(payload) "." base64url(hmac)`: the payload names what it pages
//! (`k`), the file (`f`), a hash of the filter and sort (`q`), the position (`i`: a Yjs sticky
//! index for blocks, the last row id for database rows) and its expiry (`x`, 1 h). It is
//! signed with the host's signing secret, so it cannot be forged, moved to another host, file
//! or query, or decoded into anything meaningful by a client. Expired: `410 CURSOR_EXPIRED`;
//! anything else wrong: `400 CURSOR_INVALID`.

use axum::http::StatusCode;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::problem::Problem;
use crate::hosts::HostConfig;

/// How long a cursor stays valid.
pub const TTL_SECS: i64 = 3600;

fn mac(host: &HostConfig) -> Hmac<Sha256> {
    let mut m = Hmac::<Sha256>::new_from_slice(host.signing_secret()).expect("any key length");
    m.update(b"oc-cursor-v1\0");
    m.update(host.id.as_bytes());
    m.update(b"\0");
    m
}

/// A short hash of the parts of a query that a cursor must not outlive.
pub fn query_hash(parts: &[&str]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update((p.len() as u64).to_be_bytes());
        h.update(p.as_bytes());
    }
    hex::encode(&h.finalize()[..12])
}

pub fn sign(host: &HostConfig, kind: &str, file: &str, q: &str, pos: Value, now: i64) -> String {
    let payload = json!({"k": kind, "f": file, "q": q, "i": pos, "x": now + TTL_SECS}).to_string();
    let mut m = mac(host);
    m.update(payload.as_bytes());
    format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(payload.as_bytes()),
        URL_SAFE_NO_PAD.encode(m.finalize().into_bytes())
    )
}

fn invalid() -> Problem {
    Problem::bad_request("CURSOR_INVALID", "the cursor is not valid for this request")
}

/// The position inside a cursor made by [`sign`] for the same host, kind, file and query.
pub fn open(
    host: &HostConfig,
    cursor: &str,
    kind: &str,
    file: &str,
    q: &str,
    now: i64,
) -> Result<Value, Problem> {
    let (p, s) = cursor.split_once('.').ok_or_else(invalid)?;
    let payload = URL_SAFE_NO_PAD.decode(p).map_err(|_| invalid())?;
    let sig = URL_SAFE_NO_PAD.decode(s).map_err(|_| invalid())?;
    let mut m = mac(host);
    m.update(&payload);
    m.verify_slice(&sig).map_err(|_| invalid())?;
    let v: Value = serde_json::from_slice(&payload).map_err(|_| invalid())?;
    if v["k"] != kind || v["f"] != file || v["q"] != q {
        return Err(invalid());
    }
    if v["x"].as_i64().is_none_or(|x| x < now) {
        return Err(Problem::new(
            StatusCode::GONE,
            "CURSOR_EXPIRED",
            "the cursor has expired; start again without one",
        ));
    }
    Ok(v["i"].clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(id: &str, secret: &str) -> HostConfig {
        let mut h: HostConfig = toml::from_str(&format!(
            "id = \"{id}\"\nname = \"x\"\ncallback_base = \"http://h\"\njwt_secret = \"{secret}\""
        ))
        .unwrap();
        h.jwt_secret = Some(secret.into());
        h
    }

    #[test]
    fn signed_bound_and_expiring() {
        let a = host("a", "s1");
        let c = sign(&a, "blocks", "f1", "q", json!("pos"), 1_000);
        assert_eq!(
            open(&a, &c, "blocks", "f1", "q", 1_000).unwrap(),
            json!("pos")
        );
        assert_eq!(
            open(&a, &c, "blocks", "f1", "q", 1_000 + TTL_SECS + 1)
                .unwrap_err()
                .code,
            "CURSOR_EXPIRED"
        );
        for (k, f, q) in [
            ("rows", "f1", "q"),
            ("blocks", "f2", "q"),
            ("blocks", "f1", "other"),
        ] {
            assert_eq!(
                open(&a, &c, k, f, q, 1_000).unwrap_err().code,
                "CURSOR_INVALID"
            );
        }
        assert_eq!(
            open(&host("b", "s1"), &c, "blocks", "f1", "q", 1_000)
                .unwrap_err()
                .code,
            "CURSOR_INVALID"
        );
        assert_eq!(
            open(&host("a", "s2"), &c, "blocks", "f1", "q", 1_000)
                .unwrap_err()
                .code,
            "CURSOR_INVALID"
        );
        // A payload edited by the client fails the signature.
        let (p, s) = c.split_once('.').unwrap();
        let mut payload: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(p).unwrap()).unwrap();
        payload["x"] = json!(i64::MAX);
        let forged = format!("{}.{s}", URL_SAFE_NO_PAD.encode(payload.to_string()));
        assert_eq!(
            open(&a, &forged, "blocks", "f1", "q", 1_000)
                .unwrap_err()
                .code,
            "CURSOR_INVALID"
        );
        assert_eq!(
            open(&a, "garbage", "blocks", "f1", "q", 1_000)
                .unwrap_err()
                .code,
            "CURSOR_INVALID"
        );
    }
}
