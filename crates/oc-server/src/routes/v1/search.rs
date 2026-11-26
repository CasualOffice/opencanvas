// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `POST /api/v1/extract` and `GET /api/v1/search` (SRCH-02/03, ADR-065, docs/34 §4.3).
//!
//! - Extract is stateless: it reads a `.ocanvas` (or Markdown) body and answers its
//!   `search.json`; nothing is kept. Size and archive limits as imports (FC-10), a 2 s budget.
//! - Search proxies the host's `GET /search` callback for a **user** token (a host key gets
//!   400 `USER_TOKEN_REQUIRED`: no "search as everyone"), 10 a minute per user.

use std::time::Duration;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use super::problem::Problem;
use super::{Answer, caller};
use crate::SharedState;
use crate::authz::Via;
use crate::search::{SearchError, Searcher};

/// Largest body `POST /api/v1/extract` takes.
pub const MAX_EXTRACT_BYTES: usize = 100 * 1024 * 1024;
/// Time budget for one extraction.
pub const EXTRACT_BUDGET: Duration = Duration::from_secs(2);

impl From<SearchError> for Problem {
    fn from(e: SearchError) -> Self {
        match e {
            SearchError::Unavailable => Problem::not_found(
                "SEARCH_UNAVAILABLE",
                "the host has no search callback ([host.search] callback)",
            ),
            SearchError::BadQuery(m) => Problem::bad_request("BAD_INPUT", m),
            SearchError::RateLimited(after) => Problem::new(
                StatusCode::TOO_MANY_REQUESTS,
                "RATE_LIMITED",
                "too many searches; at most 10 a minute",
            )
            .header(header::RETRY_AFTER, &after.to_string()),
            SearchError::Timeout => Problem::new(
                StatusCode::GATEWAY_TIMEOUT,
                "HOST_TIMEOUT",
                "the host did not answer the search in time",
            ),
            SearchError::Host(m) => Problem::new(StatusCode::BAD_GATEWAY, "HOST_ERROR", m),
        }
    }
}

/// The `search.json` of a `.ocanvas` or Markdown body, computed off the async threads.
pub async fn extract_bytes(
    body: Bytes,
    markdown: bool,
    opts: oc_model::search::Options,
) -> Result<serde_json::Value, Problem> {
    if body.len() > MAX_EXTRACT_BYTES {
        return Err(Problem::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "BODY_TOO_LARGE",
            "the body is over 100 MB",
        ));
    }
    let work = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let doc = if markdown {
            let src = std::str::from_utf8(&body).map_err(|_| "Markdown must be UTF-8")?;
            let doc = oc_model::new_doc();
            oc_model::import::apply_markdown(&doc, src);
            doc
        } else {
            if !oc_model::ocanvas::is_zip(&body) {
                return Err("the body is not a .ocanvas file".into());
            }
            oc_model::read_ocanvas(&body)
                .map_err(|e| format!("not a readable .ocanvas: {e}"))?
                .doc
        };
        Ok(oc_model::search::search_json(
            &oc_model::doc_to_json(&doc),
            opts,
        ))
    });
    match tokio::time::timeout(EXTRACT_BUDGET, work).await {
        Err(_) => Err(Problem::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "EXTRACT_TOO_SLOW",
            "the file took longer than 2 s to read",
        )),
        Ok(Err(e)) => Err(Problem::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            e.to_string(),
        )),
        Ok(Ok(Err(m))) => Err(Problem::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "NOT_OCANVAS",
            m,
        )),
        Ok(Ok(Ok(v))) => Ok(v),
    }
}

/// `POST /api/v1/extract`: host key or a token with `canvas:read` (every token has it).
pub async fn extract(State(state): State<SharedState>, headers: HeaderMap, body: Bytes) -> Answer {
    let p = caller(&state, &headers).await?;
    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let markdown = match ct.as_str() {
        "application/vnd.opencanvas+zip" | "application/zip" | "application/octet-stream" => false,
        "text/markdown" | "text/x-markdown" | "text/plain" => true,
        _ => {
            return Err(Problem::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "UNSUPPORTED_MEDIA_TYPE",
                "send application/vnd.opencanvas+zip or text/markdown",
            ));
        }
    };
    let v = extract_bytes(body, markdown, p.host.search().model_options()).await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(v)).into_response())
}

#[derive(Deserialize, Default)]
pub struct SearchQ {
    pub q: Option<String>,
    pub scope: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

/// `GET /api/v1/search?q=&scope=&cursor=&limit=`: the host's search as the token's user.
pub async fn search(
    State(state): State<SharedState>,
    Query(q): Query<SearchQ>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    let out = api_search(&state, &p, q).await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(out)).into_response())
}

/// The search shared by the API and MCP (parity: the same items for the same user).
pub async fn api_search(
    state: &SharedState,
    p: &crate::authz::Principal,
    q: SearchQ,
) -> Result<serde_json::Value, Problem> {
    if p.via == Via::HostKey {
        return Err(Problem::bad_request(
            "USER_TOKEN_REQUIRED",
            "search needs a user token; a host key cannot search as everyone",
        ));
    }
    let out = crate::search::run(
        state,
        &p.host,
        Searcher {
            user_id: &p.sub,
            token: &p.callback_token,
        },
        crate::search::Query {
            q: q.q.unwrap_or_default(),
            scope: q.scope,
            cursor: q.cursor,
            limit: q.limit.unwrap_or(20),
        },
    )
    .await?;
    Ok(out)
}

/// An answer for the editor route ([`crate::routes`]): same as the API.
pub fn editor_answer(r: Result<serde_json::Value, SearchError>) -> Response {
    match r {
        Ok(v) => ([(header::CACHE_CONTROL, "no-store")], Json(v)).into_response(),
        Err(e) => Problem::from(e).into_response(),
    }
}

#[derive(Deserialize)]
pub struct EditorQ {
    pub ticket: String,
    #[serde(flatten)]
    pub q: SearchQ,
}

/// `GET /v1/search?ticket=&q=&scope=&cursor=`: "Search all canvases" in the editor, as the
/// session's person with their callback token (SRCH-04). Any role may search.
pub async fn editor_search(
    State(state): State<SharedState>,
    Query(q): Query<EditorQ>,
) -> Result<Response, crate::routes::ApiError> {
    let (host, grant) = crate::routes::session(&state, &q.ticket).await?;
    let r = crate::search::run(
        &state,
        &host,
        Searcher {
            user_id: &grant.user.id,
            token: &grant.callback_token,
        },
        crate::search::Query {
            q: q.q.q.unwrap_or_default(),
            scope: q.q.scope,
            cursor: q.q.cursor,
            limit: q.q.limit.unwrap_or(20),
        },
    )
    .await;
    Ok(editor_answer(r))
}
