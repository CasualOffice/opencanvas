// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! HTTP surface (docs/15 §2, §3, §6).

mod api;
pub(crate) mod collab;
mod export;
pub mod import;
mod launch;
pub mod mcp;
mod ops;
mod proxy;
mod templates;

pub use collab::write_frames;

use std::sync::Arc;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderValue, Method, Request, StatusCode, header};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{delete, get, post};
use serde_json::json;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use crate::SharedState;
use crate::grant::Grant;
use crate::hosts::HostConfig;
use crate::util::now_secs;

pub const MAX_ASSET_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
    pub fn ticket() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "TICKET_INVALID",
            "unknown or expired ticket",
        )
    }
    pub fn forbidden(message: &str) -> Self {
        Self::new(StatusCode::FORBIDDEN, "FORBIDDEN", message)
    }
    pub fn internal(e: impl std::fmt::Display) -> Self {
        tracing::error!(error = %e, "internal error");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            "internal error",
        )
    }
    pub fn host(e: impl std::fmt::Display) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "HOST_UNAVAILABLE", e.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            axum::Json(json!({"error": {"code": self.code, "message": self.message}})),
        )
            .into_response()
    }
}

/// Resolves a ticket into its grant and host; expired or unknown tickets are rejected.
pub async fn session(
    state: &SharedState,
    ticket: &str,
) -> Result<(Arc<HostConfig>, Grant), ApiError> {
    if ticket.is_empty() || ticket.len() > 64 {
        return Err(ApiError::ticket());
    }
    let (grant, exp) = state
        .store
        .session(ticket)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(ApiError::ticket)?;
    if exp < now_secs() {
        return Err(ApiError::ticket());
    }
    let host = state
        .hosts
        .get(&grant.host_id)
        .ok_or_else(ApiError::ticket)?;
    Ok((host, grant))
}

fn redacted_path(path: &str) -> &str {
    if path.starts_with("/v1/sessions/") {
        "/v1/sessions/:ticket"
    } else {
        path
    }
}

/// `frame-ancestors 'self' <every host's allowed_origins>` (docs/07 §2, clickjacking).
fn frame_ancestors(origins: &[String]) -> String {
    let mut v = String::from("frame-ancestors 'self'");
    for o in origins {
        // A stray quote, semicolon or space would end the directive or add another one.
        if o.bytes()
            .all(|b| b.is_ascii_graphic() && !matches!(b, b';' | b',' | b'\'' | b'"'))
        {
            v.push(' ');
            v.push_str(o);
        }
    }
    v
}

/// Policy for the SPA and every response without its own: scripts only from this origin,
/// no plugins, no `<base>` hijack, forms post only here. Images and embeds stay open
/// (documents show images from the host and provider iframes, docs/07 §2).
fn default_csp(frame_ancestors: &str) -> String {
    format!(
        "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; \
         form-action 'self'; img-src 'self' https: http: data: blob:; \
         media-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; \
         font-src 'self' data:; connect-src 'self' ws: wss:; frame-src https:; \
         worker-src 'self' blob:; {frame_ancestors}"
    )
}

/// Baseline headers (SEC-01). A handler's own CSP (sandboxed assets and exports) is kept and
/// only gets `frame-ancestors` appended; everything else gets [`default_csp`].
async fn security_headers(
    frame_ancestors: Arc<str>,
    default: HeaderValue,
    mut res: Response,
) -> Response {
    let h = res.headers_mut();
    let own = h
        .get(header::CONTENT_SECURITY_POLICY)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let csp = match own {
        Some(own) if own.contains("frame-ancestors") => None,
        Some(own) => HeaderValue::from_str(&format!("{own}; {frame_ancestors}")).ok(),
        None => Some(default),
    };
    if let Some(csp) = csp {
        h.insert(header::CONTENT_SECURITY_POLICY, csp);
    }
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.entry(header::X_CONTENT_TYPE_OPTIONS)
        .or_insert(HeaderValue::from_static("nosniff"));
    res
}

pub fn router(state: SharedState) -> Router {
    let origins = state.hosts.allowed_origins();
    let fa: Arc<str> = frame_ancestors(&origins).into();
    let default = HeaderValue::from_str(&default_csp(&fa))
        .unwrap_or_else(|_| HeaderValue::from_static("frame-ancestors 'self'"));
    // Patch / convert bodies: up to the document cap (at least 1 MB).
    let body_limit = state.cfg.rooms.max_doc_bytes.max(1024 * 1024);
    let web = &state.cfg.web_dir;
    let spa = ServeDir::new(web).fallback(ServeFile::new(web.join("index.html")));
    let cors_origins: Vec<HeaderValue> = origins
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(cors_origins))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE]);

    Router::new()
        .route("/v1/launch", post(launch::launch_post).get(launch::launch_get))
        .route("/v1/sessions/{ticket}", get(launch::session_info))
        .route("/v1/collab/{room}", get(collab::upgrade))
        .route("/v1/export/{fmt}", get(export::export))
        .route("/v1/export/board/{file}", get(export::export_board))
        .route("/v1/assets", post(proxy::upload_asset).layer(DefaultBodyLimit::max(MAX_ASSET_BYTES)))
        .route("/v1/assets/fetch", get(proxy::fetch_asset))
        .route("/v1/assets/{id}", get(proxy::get_asset))
        .route("/v1/members", get(proxy::members))
        .route("/hosting/discovery", get(launch::discovery))
        .route("/hosting/capabilities", get(launch::capabilities))
        .route("/v1/files/{file_id}/role", post(api::set_role))
        .route("/v1/files/{file_id}/session", delete(api::close_session))
        .route("/v1/files/{file_id}/members/invalidate", post(api::invalidate_members))
        .route("/v1/files/{file_id}/patch", post(api::patch).layer(DefaultBodyLimit::max(body_limit)))
        .route("/v1/files/{file_id}/commit", post(api::commit))
        .route("/v1/import", post(import::import).layer(DefaultBodyLimit::max(import::MAX_IMPORT_BYTES)))
        .route("/v1/files/{file_id}/import", post(import::host_import).layer(DefaultBodyLimit::max(import::MAX_IMPORT_BYTES)))
        .route("/v1/templates", get(templates::index))
        .route("/v1/templates/undo", post(templates::undo))
        .route("/v1/templates/{id}/apply", post(templates::apply))
        .route("/v1/convert", post(api::convert).layer(DefaultBodyLimit::max(body_limit)))
        .route("/mcp/{host_id}", post(mcp::mcp).layer(DefaultBodyLimit::max(body_limit)))
        .route("/.well-known/oauth-protected-resource/mcp/{host_id}", get(mcp::resource_metadata))
        .route("/healthz", get(ops::healthz))
        .route("/readyz", get(ops::readyz))
        .route("/metrics", get(ops::metrics))
        .route("/", get(|| async { Redirect::temporary("/app/") }))
        .route("/app", get(|| async { Redirect::permanent("/app/") }))
        .nest_service("/app/", spa)
        // Host pages load the embed SDK from here (docs/05 §4).
        .route_service("/sdk/embed.js", ServeFile::new(web.join("sdk/embed.js")))
        .layer(cors)
        .layer(axum::middleware::map_response(move |res: Response| {
            security_headers(fa.clone(), default.clone(), res)
        }))
        .layer(TraceLayer::new_for_http().make_span_with(|req: &Request<_>| {
            tracing::info_span!("http", method = %req.method(), path = %redacted_path(req.uri().path()))
        }))
        .with_state(state)
}
