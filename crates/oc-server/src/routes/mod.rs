//! HTTP surface (docs/15 §2, §3, §6).

mod api;
mod collab;
mod export;
mod launch;
mod ops;
mod proxy;

use std::sync::Arc;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderValue, Method, Request, StatusCode, header};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{delete, get, post};
use serde_json::json;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
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

fn csp(origins: &[String]) -> HeaderValue {
    let mut v = String::from("frame-ancestors 'self'");
    for o in origins {
        v.push(' ');
        v.push_str(o);
    }
    HeaderValue::from_str(&v).unwrap_or_else(|_| HeaderValue::from_static("frame-ancestors 'self'"))
}

pub fn router(state: SharedState) -> Router {
    let origins = state.hosts.allowed_origins();
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
        .route("/v1/users", get(proxy::users))
        .route("/v1/files/{file_id}/role", post(api::set_role))
        .route("/v1/files/{file_id}/session", delete(api::close_session))
        .route("/v1/files/{file_id}/patch", post(api::patch).layer(DefaultBodyLimit::max(body_limit)))
        .route("/v1/files/{file_id}/commit", post(api::commit))
        .route("/v1/convert", post(api::convert).layer(DefaultBodyLimit::max(body_limit)))
        .route("/healthz", get(ops::healthz))
        .route("/readyz", get(ops::readyz))
        .route("/metrics", get(ops::metrics))
        .route("/", get(|| async { Redirect::temporary("/app/") }))
        .route("/app", get(|| async { Redirect::permanent("/app/") }))
        .nest_service("/app/", spa)
        // Host pages load the embed SDK from here (docs/05 §4).
        .route_service("/sdk/embed.js", ServeFile::new(web.join("sdk/embed.js")))
        .layer(cors)
        .layer(SetResponseHeaderLayer::overriding(header::CONTENT_SECURITY_POLICY, csp(&origins)))
        .layer(SetResponseHeaderLayer::overriding(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")))
        .layer(TraceLayer::new_for_http().make_span_with(|req: &Request<_>| {
            tracing::info_span!("http", method = %req.method(), path = %redacted_path(req.uri().path()))
        }))
        .with_state(state)
}
