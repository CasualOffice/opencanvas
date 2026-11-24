// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! RFC 9457 problems as typed errors. The kind comes from the machine `code` first, then the
//! HTTP status, as in the TypeScript client.

use reqwest::header::HeaderMap;
use serde_json::Value;

/// What went wrong, as a program would act on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProblemKind {
    BadRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    Gone,
    PreconditionFailed,
    /// A block (or the document) changed since it was read; see [`ApiError::fresh`].
    StaleBlock,
    TooLarge,
    Unprocessable,
    IdempotencyKeyReused,
    IdempotencyInProgress,
    CursorExpired,
    RateLimited,
    Unavailable,
    Server,
    Problem,
}

impl ProblemKind {
    /// The kind of a problem: by `code` when it has its own, else by status.
    pub fn of(status: u16, code: &str) -> Self {
        use ProblemKind::*;
        match code {
            "STALE_BLOCK" => return StaleBlock,
            "IDEMPOTENCY_KEY_REUSED" => return IdempotencyKeyReused,
            "IDEMPOTENCY_IN_PROGRESS" => return IdempotencyInProgress,
            "CURSOR_EXPIRED" => return CursorExpired,
            "RATE_LIMITED" => return RateLimited,
            _ => {}
        }
        match status {
            400 => BadRequest,
            401 => Unauthorized,
            403 => Forbidden,
            404 => NotFound,
            409 => Conflict,
            410 => Gone,
            412 => PreconditionFailed,
            413 => TooLarge,
            422 => Unprocessable,
            429 => RateLimited,
            503 => Unavailable,
            s if s >= 500 => Server,
            _ => Problem,
        }
    }

    pub fn as_str(self) -> &'static str {
        use ProblemKind::*;
        match self {
            BadRequest => "BadRequest",
            Unauthorized => "Unauthorized",
            Forbidden => "Forbidden",
            NotFound => "NotFound",
            Conflict => "Conflict",
            Gone => "Gone",
            PreconditionFailed => "PreconditionFailed",
            StaleBlock => "StaleBlock",
            TooLarge => "TooLarge",
            Unprocessable => "Unprocessable",
            IdempotencyKeyReused => "IdempotencyKeyReused",
            IdempotencyInProgress => "IdempotencyInProgress",
            CursorExpired => "CursorExpired",
            RateLimited => "RateLimited",
            Unavailable => "Unavailable",
            Server => "Server",
            Problem => "Problem",
        }
    }
}

/// An error answer: an `application/problem+json` body and its headers.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    /// `BLOCK_NOT_FOUND`, `STALE_BLOCK`, `ROLE_FORBIDDEN`, `RATE_LIMITED`, … (`HTTP_<status>`
    /// when the body was not a problem, e.g. a proxy's page).
    pub code: String,
    pub kind: ProblemKind,
    /// The whole problem body (extensions included).
    pub problem: Value,
    pub headers: HeaderMap,
    /// `Retry-After` in seconds.
    pub retry_after_secs: Option<u64>,
}

impl ApiError {
    pub fn new(status: u16, body: &[u8], headers: HeaderMap) -> Self {
        let parsed: Option<Value> = serde_json::from_slice(body).ok();
        let problem = match parsed {
            Some(v) if v.get("code").is_some_and(Value::is_string) => v,
            _ => serde_json::json!({
                "type": "about:blank",
                "title": format!("HTTP {status}"),
                "status": status,
                "code": format!("HTTP_{status}"),
                "detail": String::from_utf8_lossy(&body[..body.len().min(500)]),
            }),
        };
        let code = problem["code"].as_str().unwrap_or_default().to_string();
        let retry_after_secs = headers
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse().ok());
        Self {
            status,
            kind: ProblemKind::of(status, &code),
            code,
            problem,
            headers,
            retry_after_secs,
        }
    }

    pub fn type_uri(&self) -> &str {
        self.problem["type"].as_str().unwrap_or_default()
    }

    pub fn title(&self) -> &str {
        self.problem["title"].as_str().unwrap_or_default()
    }

    pub fn detail(&self) -> Option<&str> {
        self.problem["detail"].as_str()
    }

    /// `STALE_BLOCK`: the current state to retry against.
    pub fn fresh(&self) -> Option<&Value> {
        self.problem.get("fresh")
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} {}: {}",
            self.status,
            self.code,
            self.detail().unwrap_or(self.title())
        )
    }
}

/// Every error of this crate.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The server answered with an error.
    #[error("{0}")]
    Api(Box<ApiError>),
    /// No answer (DNS, connection, TLS, timeout).
    #[error("network error: {0}")]
    Network(#[source] reqwest::Error),
    /// An answer that does not parse as the expected type.
    #[error("unexpected answer: {0}")]
    Decode(String),
    /// A call this client refuses to send (a missing path parameter, an unknown operation).
    #[error("invalid call: {0}")]
    Invalid(String),
    /// An events stream ended for good: 4001 (token expired), 4003 (revoked), or another
    /// close code the client does not reconnect after.
    #[error("events stream closed ({code}): {reason}")]
    StreamClosed { code: u16, reason: String },
}

impl Error {
    /// The problem, when the server answered with one.
    pub fn api(&self) -> Option<&ApiError> {
        match self {
            Error::Api(e) => Some(e),
            _ => None,
        }
    }

    /// The problem kind, when the server answered with one.
    pub fn kind(&self) -> Option<ProblemKind> {
        self.api().map(|e| e.kind)
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
