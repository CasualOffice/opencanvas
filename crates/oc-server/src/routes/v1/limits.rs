// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Rate limits on `/api/v1` (docs/27 §4.2, HAPI-04): every authenticated request takes a
//! token from its subject's bucket, and every write (POST/DELETE on a file) one from the file's
//! bucket too. Answers carry `RateLimit-Policy` and `RateLimit` (IETF httpapi ratelimit
//! headers); an empty bucket is `429 RATE_LIMITED` with `Retry-After`. MCP takes from the same
//! subject bucket ([`subject_key`]).

use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use super::problem::Problem;
use crate::SharedState;
use crate::authz::Principal;
use crate::ratelimit::{Decision, file_policy, subject_policy};

/// The bucket of a caller, shared by the API and MCP: the host key, or the token's subject.
pub fn subject_key(p: &Principal) -> String {
    match p.via {
        crate::authz::Via::HostKey => format!("key:{}", p.host.id),
        _ => format!("sub:{}:{}", p.host.id, p.sub),
    }
}

/// The file id of a write, if this request is one.
fn written_file(req: &Request) -> Option<String> {
    if !matches!(*req.method(), Method::POST | Method::DELETE) {
        return None;
    }
    let rest = req.uri().path().strip_prefix("/api/v1/files/")?;
    let id = rest.split('/').next().filter(|s| !s.is_empty())?;
    Some(id.to_string())
}

fn headers(res: &mut Response, decisions: &[Decision]) {
    let policy = decisions
        .iter()
        .map(|d| d.policy.header_item())
        .collect::<Vec<_>>()
        .join(", ");
    // `RateLimit` reports the bucket closest to empty.
    let tightest = decisions
        .iter()
        .min_by_key(|d| (d.ok, d.remaining))
        .map(Decision::header_item);
    let h = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&policy) {
        h.insert("ratelimit-policy", v);
    }
    if let Some(v) = tightest.and_then(|t| HeaderValue::from_str(&t).ok()) {
        h.insert("ratelimit", v);
    }
}

pub async fn layer(State(state): State<SharedState>, req: Request, next: Next) -> Response {
    let Ok(p) = Principal::from_headers(&state, req.headers()).await else {
        return next.run(req).await;
    };
    if !p.host.api_v1() {
        return next.run(req).await;
    }
    let mut decisions = vec![
        state
            .limiter
            .check(&subject_key(&p), subject_policy(&p.host))
            .await,
    ];
    if let Some(file) = written_file(&req)
        && decisions[0].ok
    {
        let key = format!("file:{}:{file}", p.host.id);
        decisions.push(state.limiter.check(&key, file_policy(&p.host)).await);
    }
    if let Some(d) = decisions.iter().find(|d| !d.ok) {
        let mut res = Problem::new(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            format!("too many requests ({} limit); retry later", d.policy.name),
        )
        .header(header::RETRY_AFTER, &d.retry_after.to_string())
        .into_response();
        headers(&mut res, &decisions);
        return res;
    }
    let mut res = next.run(req).await;
    headers(&mut res, &decisions);
    res
}
