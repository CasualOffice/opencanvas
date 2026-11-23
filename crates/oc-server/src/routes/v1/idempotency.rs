// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `Idempotency-Key` for `POST /api/v1/files/…` (docs/27 §4.2, HAPI-03; the IETF
//! httpapi-idempotency-key-header draft).
//!
//! The key is scoped to (host, subject): the same key from two users is two keys. The store
//! keeps `sha256(host, subject, key)`, the request hash (method, path, query, body) and, once
//! the request succeeded, its 2xx answer, for 24 h. A replay answers that with
//! `Idempotency-Replayed: true`; the same key with another request is `422
//! IDEMPOTENCY_KEY_REUSED`; a duplicate while the first still runs, on any node, is `409
//! IDEMPOTENCY_IN_PROGRESS` with `Retry-After: 1`. Failed requests free the key, so a retry
//! runs again. A running claim holds the key for at most [`LEASE_SECS`] (a crashed node frees
//! it). Stored answers are write results (ids, counts, revisions), never document content
//! (ADR-001); `POST /api/v1/convert` returns a document, so it takes no key.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::problem::Problem;
use crate::SharedState;
use crate::authz::Principal;
use crate::store::IdemBegin;

pub const HEADER: &str = "idempotency-key";
/// How long a stored answer is replayed.
pub const TTL_SECS: i64 = 24 * 3600;
/// How long a running request holds its key without finishing.
pub const LEASE_SECS: i64 = 60;
/// Longest answer stored; a longer one is not stored (the key is freed instead).
const MAX_STORED: usize = 256 * 1024;

fn sha(parts: &[&[u8]]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update((p.len() as u64).to_be_bytes());
        h.update(p);
    }
    hex::encode(h.finalize())
}

/// A key is 1-255 visible ASCII characters (as Stripe's; the draft's sf-string).
pub fn valid_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 255 && k.bytes().all(|b| (0x20..0x7f).contains(&b))
}

fn applies(req: &Request) -> bool {
    req.method() == Method::POST && req.uri().path().starts_with("/api/v1/files/")
}

pub async fn layer(
    State((state, limit)): State<(SharedState, usize)>,
    req: Request,
    next: Next,
) -> Response {
    if !applies(&req) {
        return next.run(req).await;
    }
    let Some(key) = req
        .headers()
        .get(HEADER)
        .map(|v| v.to_str().map(str::to_string))
    else {
        return next.run(req).await;
    };
    let Some(key) = key.ok().filter(|k| valid_key(k)) else {
        return Problem::bad_request(
            "IDEMPOTENCY_KEY_INVALID",
            "Idempotency-Key must be 1-255 visible ASCII characters",
        )
        .into_response();
    };
    // Unauthenticated or API off: the handler gives the answer, nothing is stored.
    let Ok(p) = Principal::from_headers(&state, req.headers()).await else {
        return next.run(req).await;
    };
    if !p.host.api_v1() {
        return next.run(req).await;
    }
    let (parts, body) = req.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, limit).await else {
        return Problem::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "BODY_TOO_LARGE",
            "the request body is too large",
        )
        .into_response();
    };
    let target = parts
        .uri
        .path_and_query()
        .map_or(parts.uri.path(), |p| p.as_str());
    let request_hash = sha(&[parts.method.as_str().as_bytes(), target.as_bytes(), &bytes]);
    let id = sha(&[p.host.id.as_bytes(), p.sub.as_bytes(), key.as_bytes()]);
    let host = p.host.id.clone();
    let now = state.clock.now_secs();
    let begun = state
        .store
        .idem_begin(&id, &host, &request_hash, now, LEASE_SECS)
        .await;
    match begun {
        Err(e) => {
            tracing::warn!(host = %host, error = %e, "idempotency store unavailable");
            return Problem::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "UNAVAILABLE",
                "the idempotency store is unavailable; retry",
            )
            .header(header::RETRY_AFTER, "1")
            .into_response();
        }
        Ok(IdemBegin::Mismatch) => {
            return Problem::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "IDEMPOTENCY_KEY_REUSED",
                "this Idempotency-Key was used with a different request",
            )
            .into_response();
        }
        Ok(IdemBegin::InProgress) => {
            return Problem::new(
                StatusCode::CONFLICT,
                "IDEMPOTENCY_IN_PROGRESS",
                "a request with this Idempotency-Key is still running",
            )
            .header(header::RETRY_AFTER, "1")
            .into_response();
        }
        Ok(IdemBegin::Replay { status, response }) => return replay(status, &response),
        Ok(IdemBegin::Started) => {}
    }
    let res = next
        .run(Request::from_parts(parts, Body::from(bytes)))
        .await;
    if !res.status().is_success() {
        if let Err(e) = state.store.idem_release(&id, &host, &request_hash).await {
            tracing::warn!(host = %host, error = %e, "idempotency key release failed");
        }
        return res;
    }
    let (rparts, rbody) = res.into_parts();
    let Ok(body) = axum::body::to_bytes(rbody, MAX_STORED).await else {
        let _ = state.store.idem_release(&id, &host, &request_hash).await;
        return Problem::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            "the answer was too large to keep for Idempotency-Key replays",
        )
        .into_response();
    };
    let keep = |h: header::HeaderName| {
        rparts
            .headers
            .get(&h)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let stored = json!({
        "ct": keep(header::CONTENT_TYPE),
        "etag": keep(header::ETAG),
        "body": String::from_utf8_lossy(&body),
    })
    .to_string();
    if let Err(e) = state
        .store
        .idem_finish(
            &id,
            &host,
            &request_hash,
            rparts.status.as_u16(),
            &stored,
            TTL_SECS,
            state.clock.now_secs(),
        )
        .await
    {
        tracing::warn!(host = %host, error = %e, "storing an idempotent answer failed");
    }
    Response::from_parts(rparts, Body::from(body))
}

fn replay(status: u16, stored: &str) -> Response {
    let v: Value = serde_json::from_str(stored).unwrap_or_default();
    let mut res = (
        StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
        v["body"].as_str().unwrap_or_default().to_string(),
    )
        .into_response();
    let h = res.headers_mut();
    for (name, k) in [(header::CONTENT_TYPE, "ct"), (header::ETAG, "etag")] {
        if let Some(val) = v[k].as_str().and_then(|s| HeaderValue::from_str(s).ok()) {
            h.insert(name, val);
        }
    }
    h.insert("idempotency-replayed", HeaderValue::from_static("true"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_hashes() {
        assert!(valid_key("a") && valid_key(&"k".repeat(255)));
        assert!(!valid_key("") && !valid_key(&"k".repeat(256)) && !valid_key("tab\tkey"));
        // Length-prefixed: moving bytes between parts changes the hash.
        assert_ne!(sha(&[b"ab", b"c"]), sha(&[b"a", b"bc"]));
    }
}
