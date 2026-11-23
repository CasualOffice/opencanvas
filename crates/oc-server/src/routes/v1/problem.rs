// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! RFC 9457 problem details for `/api/v1` (docs/27 §4.2, ADR-041): every error is
//! `application/problem+json` with `type`, `title`, `status`, `detail` and a `code` extension
//! carrying the machine code the 0.1 routes already use (`BLOCK_NOT_FOUND`, `STALE_BLOCK`, …).

use axum::body::Body;
use axum::http::{HeaderValue, Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use crate::ai::tools::ToolError;
use crate::routes::ApiError;

pub const PROBLEM_JSON: &str = "application/problem+json";

/// One problem: the HTTP status, the machine `code`, a human `detail`, and extensions.
#[derive(Debug)]
pub struct Problem {
    pub status: StatusCode,
    pub code: String,
    pub detail: String,
    pub ext: serde_json::Map<String, Value>,
    pub headers: Vec<(header::HeaderName, HeaderValue)>,
}

/// `urn:opencanvas:problem:block-not-found` for `BLOCK_NOT_FOUND`: stable, not a URL that
/// has to resolve (RFC 9457 §3.1.1 allows any URI).
pub fn type_uri(code: &str) -> String {
    format!(
        "urn:opencanvas:problem:{}",
        code.to_ascii_lowercase().replace('_', "-")
    )
}

impl Problem {
    pub fn new(status: StatusCode, code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            detail: detail.into(),
            ext: Default::default(),
            headers: vec![],
        }
    }

    pub fn with(mut self, key: &str, value: Value) -> Self {
        self.ext.insert(key.into(), value);
        self
    }

    pub fn header(mut self, name: header::HeaderName, value: &str) -> Self {
        if let Ok(v) = HeaderValue::from_str(value) {
            self.headers.push((name, v));
        }
        self
    }

    pub fn not_found(code: &str, detail: &str) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, detail)
    }

    pub fn bad_request(code: &str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, detail)
    }

    pub fn body(&self) -> Value {
        let mut v = json!({
            "type": type_uri(&self.code),
            "title": self.status.canonical_reason().unwrap_or("Error"),
            "status": self.status.as_u16(),
            "detail": self.detail,
            "code": self.code,
        });
        for (k, x) in &self.ext {
            v[k] = x.clone();
        }
        v
    }
}

impl IntoResponse for Problem {
    fn into_response(self) -> Response {
        let body = self.body().to_string();
        let mut res = (
            self.status,
            [(header::CONTENT_TYPE, HeaderValue::from_static(PROBLEM_JSON))],
            body,
        )
            .into_response();
        for (k, v) in self.headers {
            res.headers_mut().insert(k, v);
        }
        res
    }
}

impl From<ApiError> for Problem {
    fn from(e: ApiError) -> Self {
        Problem::new(e.status, e.code, e.message)
    }
}

/// Splits `"SCOPE_REQUIRED: canvas_patch needs …"` into its leading code, when it has one.
fn leading_code(message: &str) -> Option<&str> {
    let (code, _) = message.split_once(':')?;
    (code.len() >= 3
        && code
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b == b'_' || b.is_ascii_digit()))
    .then_some(code)
}

impl From<ToolError> for Problem {
    fn from(e: ToolError) -> Self {
        let message = e.message();
        let code = leading_code(&message).unwrap_or(e.code()).to_string();
        match e {
            ToolError::Forbidden(_) => Problem::new(StatusCode::FORBIDDEN, code, message),
            ToolError::BadInput(_) => Problem::new(StatusCode::BAD_REQUEST, code, message),
            ToolError::NotFound(_) => Problem::new(StatusCode::NOT_FOUND, code, message),
            // docs/27 §4.2: a stale block is a failed precondition, with the fresh block.
            ToolError::Stale(fresh) => Problem::new(StatusCode::PRECONDITION_FAILED, code, message)
                .with("fresh", fresh.get("data").cloned().unwrap_or(fresh)),
            ToolError::ConfirmationRequired(_) => Problem::new(StatusCode::CONFLICT, code, message),
            ToolError::Unavailable(_) => {
                Problem::new(StatusCode::SERVICE_UNAVAILABLE, code, message)
                    .header(header::RETRY_AFTER, "2")
            }
            ToolError::Internal(_) => {
                tracing::warn!(error = %message, "api v1 operation failed");
                Problem::new(StatusCode::INTERNAL_SERVER_ERROR, code, message)
            }
        }
    }
}

/// Last line of defence for `/api/v1`: an error answer that is not already a problem (an
/// extractor rejection, an unknown path, a wrong method) becomes one, so clients only ever
/// parse one error format.
pub async fn ensure_problem(req: Request<Body>, next: axum::middleware::Next) -> Response {
    let res = next.run(req).await;
    let status = res.status();
    if !(status.is_client_error() || status.is_server_error()) {
        return res;
    }
    let is_problem = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with(PROBLEM_JSON));
    if is_problem {
        return res;
    }
    let (parts, body) = res.into_parts();
    let bytes = axum::body::to_bytes(body, 64 * 1024)
        .await
        .unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes).trim().to_string();
    let code = match status {
        StatusCode::NOT_FOUND => "NOT_FOUND",
        StatusCode::METHOD_NOT_ALLOWED => "METHOD_NOT_ALLOWED",
        StatusCode::PAYLOAD_TOO_LARGE => "BODY_TOO_LARGE",
        StatusCode::UNSUPPORTED_MEDIA_TYPE => "UNSUPPORTED_MEDIA_TYPE",
        StatusCode::UNPROCESSABLE_ENTITY | StatusCode::BAD_REQUEST => "BAD_INPUT",
        StatusCode::UNAUTHORIZED => "UNAUTHORIZED",
        StatusCode::FORBIDDEN => "FORBIDDEN",
        StatusCode::TOO_MANY_REQUESTS => "RATE_LIMITED",
        _ if status.is_server_error() => "INTERNAL",
        _ => "ERROR",
    };
    let detail = if text.is_empty() {
        status.canonical_reason().unwrap_or("error").to_string()
    } else {
        text
    };
    let mut out = Problem::new(status, code, detail).into_response();
    // Keep what the handler set (Allow, Retry-After, WWW-Authenticate, rate-limit fields).
    for (k, v) in parts.headers.iter() {
        if k != header::CONTENT_TYPE && k != header::CONTENT_LENGTH {
            out.headers_mut().insert(k, v.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_errors_map_to_statuses_and_keep_leading_codes() {
        let p: Problem = ToolError::Forbidden("SCOPE_REQUIRED: needs canvas:write".into()).into();
        assert_eq!(p.status, StatusCode::FORBIDDEN);
        assert_eq!(p.code, "SCOPE_REQUIRED");
        let p: Problem = ToolError::NotFound("BLOCK_NOT_FOUND: no block".into()).into();
        assert_eq!(
            (p.status, p.code.as_str()),
            (StatusCode::NOT_FOUND, "BLOCK_NOT_FOUND")
        );
        let p: Problem = ToolError::Stale(json!({"data": {"stale": []}})).into();
        assert_eq!(p.status, StatusCode::PRECONDITION_FAILED);
        assert_eq!(p.body()["fresh"], json!({"stale": []}));
        let p: Problem = ToolError::BadInput("lower: case".into()).into();
        assert_eq!(p.code, "BAD_INPUT");
        let b = p.body();
        assert_eq!(b["type"], "urn:opencanvas:problem:bad-input");
        assert_eq!(b["status"], 400);
        assert_eq!(b["title"], "Bad Request");
    }
}
