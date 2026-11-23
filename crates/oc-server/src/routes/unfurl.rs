// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Link previews (UNF-01): `GET /v1/unfurl?ticket=&url=` (edit role) answers
//! `{url, title, description, siteName, image, favicon}`; `GET /v1/unfurl/image?ticket=&url=`
//! (any role) proxies a card image. The fetching rules live in [`crate::unfurl`].
//!
//! Gate: `[host.flags] unfurl` (absent: on) and `OC_UNFURL=off` for all.

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use super::{ApiError, session};
use crate::SharedState;
use crate::grant::Role;
use crate::hosts::HostConfig;
use crate::unfurl::{FetchError, Limited};

#[derive(Deserialize)]
pub struct UnfurlParams {
    #[serde(default)]
    ticket: String,
    #[serde(default)]
    url: String,
}

/// Whether link cards of this host may unfurl (session `unfurl`).
pub fn enabled(state: &SharedState, host: &HostConfig) -> bool {
    !state.cfg.unfurl.off && host.unfurl_enabled()
}

fn off() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "UNFURL_OFF", "link previews are off")
}

fn limited(l: Limited) -> Response {
    let msg = match l {
        Limited::Ticket => "too many link previews; try again in a minute",
        Limited::Node => "the server is fetching too many link previews; try again in a minute",
    };
    let mut res =
        ApiError::new(StatusCode::TOO_MANY_REQUESTS, "UNFURL_RATE_LIMITED", msg).into_response();
    res.headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("60"));
    res
}

fn fetch_error(e: FetchError) -> ApiError {
    // Only the kind is logged: URLs are document content (AGENTS.md rule 9).
    tracing::debug!(kind = ?std::mem::discriminant(&e), "unfurl refused or failed");
    let (status, code) = match e {
        FetchError::Invalid(_) => (StatusCode::BAD_REQUEST, "UNFURL_INVALID"),
        FetchError::Blocked => (StatusCode::FORBIDDEN, "UNFURL_BLOCKED"),
        FetchError::WrongType => (StatusCode::UNSUPPORTED_MEDIA_TYPE, "UNFURL_TYPE"),
        FetchError::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "UNFURL_TOO_LARGE"),
        FetchError::TooManyRedirects | FetchError::Unavailable(_) => {
            (StatusCode::BAD_GATEWAY, "UNFURL_FAILED")
        }
    };
    ApiError::new(status, code, e.to_string())
}

/// `GET /v1/unfurl?ticket=&url=`.
pub async fn unfurl(
    State(state): State<SharedState>,
    Query(p): Query<UnfurlParams>,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &p.ticket).await?;
    if !enabled(&state, &host) {
        return Err(off());
    }
    if grant.role != Role::Edit {
        return Err(ApiError::forbidden("link previews need the edit role"));
    }
    if let Err(l) = state.unfurl.allow_ticket(&p.ticket) {
        return Ok(limited(l));
    }
    match state.unfurl.preview(&p.url).await {
        Err(l) => Ok(limited(l)),
        Ok(Err(e)) => Err(fetch_error(e)),
        Ok(Ok(preview)) => {
            let mut res = Json(preview).into_response();
            res.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=600"),
            );
            Ok(res)
        }
    }
}

/// `GET /v1/unfurl/image?ticket=&url=`: PNG, JPEG, GIF, WebP or ICO only (never SVG), served
/// sandboxed and never sniffed.
pub async fn image(
    State(state): State<SharedState>,
    Query(p): Query<UnfurlParams>,
) -> Result<Response, ApiError> {
    let (host, _grant) = session(&state, &p.ticket).await?;
    if !enabled(&state, &host) {
        return Err(off());
    }
    if let Err(l) = state.unfurl.allow_ticket(&p.ticket) {
        return Ok(limited(l));
    }
    match state.unfurl.image(&p.url).await {
        Err(l) => Ok(limited(l)),
        Ok(Err(e)) => Err(fetch_error(e)),
        Ok(Ok(img)) => Ok((
            [
                (header::CONTENT_TYPE, img.mime),
                (header::CONTENT_DISPOSITION, "inline".to_string()),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
                (
                    header::CONTENT_SECURITY_POLICY,
                    "default-src 'none'; sandbox".into(),
                ),
                (header::CACHE_CONTROL, "private, max-age=86400".into()),
            ],
            img.body,
        )
            .into_response()),
    }
}
