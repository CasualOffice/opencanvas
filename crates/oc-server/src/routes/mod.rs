// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! HTTP surface (docs/15 §2, §3, §6).

mod api;
pub(crate) mod collab;
mod export;
mod history;
pub mod icons;
pub mod import;
mod launch;
pub mod mcp;
mod ops;
pub mod preview;
mod proxy;
mod templates;
pub mod unfurl;
pub mod v1;

pub use collab::write_frames;

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderValue, Method, Request, StatusCode, header};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
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

/// The `X-OpenCanvas-Callback-Token` a host API call carries (empty when absent).
pub fn callback_token_of(headers: &axum::http::HeaderMap) -> String {
    api::callback_token(headers)
}

/// The collaboration WebSocket base URL for a request (as `/v1/sessions` answers it).
pub fn ws_url_of(state: &SharedState, headers: &axum::http::HeaderMap) -> String {
    launch::ws_url(state, headers)
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
/// `'wasm-unsafe-eval'` lets the lazy formula engine (ADR-078) compile; it does not allow
/// `eval` or inline script.
fn default_csp(frame_ancestors: &str, blocks_origin: &str) -> String {
    format!(
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; \
         form-action 'self'; img-src 'self' https: http: data: blob:; \
         media-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; \
         font-src 'self' data:; connect-src 'self' ws: wss:; frame-src https:{blocks_origin}; \
         worker-src 'self' blob:; {frame_ancestors}"
    )
}

/// The `h` query parameter of an editor URL (percent-decoded), naming the launching host.
/// It only selects the frame-ancestors policy configured for that host and grants nothing:
/// the editor holds no cookies, its session is the ticket in the fragment.
fn app_host(query: Option<&str>) -> Option<String> {
    let raw = query?.split('&').find_map(|p| p.strip_prefix("h="))?;
    let b = raw.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
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
    // BSDK-03: SDK block frames come from the block origin (http only in development).
    let blocks_src = state
        .blocks
        .origin()
        .filter(|o| o.starts_with("http://"))
        .map(|o| format!(" {o}"))
        .unwrap_or_default();
    let default = HeaderValue::from_str(&default_csp(&fa, &blocks_src))
        .unwrap_or_else(|_| HeaderValue::from_static("frame-ancestors 'self'"));
    // Hosts with their own `frame_ancestors`: the editor page `/app/?h=<id>` gets the
    // server-wide list plus theirs (MX-01). Nothing else changes for anyone.
    let per_host: Arc<HashMap<String, HeaderValue>> = Arc::new(
        state
            .hosts
            .iter()
            .filter(|h| !h.frame_ancestors.is_empty())
            .filter_map(|h| {
                let mut o = origins.clone();
                o.extend(h.frame_ancestors.iter().cloned());
                let v =
                    HeaderValue::from_str(&default_csp(&frame_ancestors(&o), &blocks_src)).ok()?;
                Some((h.id.clone(), v))
            })
            .collect(),
    );
    // Patch / convert bodies: up to the document cap (at least 1 MB).
    let body_limit = state.cfg.rooms.max_doc_bytes.max(1024 * 1024);
    let web = &state.cfg.web_dir;
    // The editor build writes a `.gz` next to each text asset (vite.config.ts): served to
    // browsers that accept gzip, so the initial JS goes out at its budgeted size (BENCH-03).
    let spa = ServeDir::new(web)
        .precompressed_gzip()
        .fallback(ServeFile::new(web.join("index.html")).precompressed_gzip());
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
        .route("/v1/preview", get(preview::preview))
        .route("/v1/export/{fmt}", get(export::export))
        .route("/v1/export/board/{file}", get(export::export_board))
        .route("/v1/assets", post(proxy::upload_asset).layer(DefaultBodyLimit::max(MAX_ASSET_BYTES)))
        .route("/v1/assets/fetch", get(proxy::fetch_asset))
        .route("/v1/assets/{id}", get(proxy::get_asset))
        .route("/v1/unfurl", get(unfurl::unfurl))
        .route("/v1/unfurl/image", get(unfurl::image))
        .route("/v1/members", get(proxy::members))
        .route("/v1/search", get(v1::search::editor_search))
        .route("/v1/offline/clear", get(crate::offline::clear_page))
        .route("/v1/offline/clear.js", get(crate::offline::clear_js))
        .route("/v1/automations/runs", get(v1::automation::editor_runs))
        .route("/v1/automations/test", post(v1::automation::editor_test))
        .route("/v1/offline/files", get(crate::offline::files_page))
        .route("/hosting/discovery", get(launch::discovery))
        .route("/hosting/capabilities", get(launch::capabilities))
        .route("/v1/import", post(import::import).layer(DefaultBodyLimit::max(import::MAX_IMPORT_BYTES)))
        .route("/v1/history", get(history::list))
        .route("/v1/history/diff", get(history::diff))
        .route("/v1/history/name", post(history::name))
        .route("/v1/history/restore/undo", post(history::undo))
        .route("/v1/history/{v}", get(history::version))
        .route("/v1/history/{v}/restore", post(history::restore))
        .route("/v1/icons", post(icons::upload).layer(DefaultBodyLimit::max(icons::MAX_BODY)))
        .route("/v1/icons/{id}", post(icons::change))
        // LIVE-01/02/04: derived sessions, projections, refresh and "Make live" (docs/27 §2).
        .route("/v1/live/session", post(crate::live::open_session))
        .route("/v1/live/projection", get(crate::live::projection))
        .route("/v1/live/refresh", post(crate::live::refresh))
        .route("/v1/live/make", post(crate::live::make))
        .route("/v1/live/audience", get(crate::live::audience))
        .route("/v1/templates", get(templates::index))
        .route("/v1/templates/undo", post(templates::undo))
        .route("/v1/templates/{id}/apply", post(templates::apply))
        .route("/mcp/{host_id}", post(mcp::mcp).layer(DefaultBodyLimit::max(body_limit)))
        .route("/.well-known/oauth-protected-resource/mcp/{host_id}", get(mcp::resource_metadata))
        // Headless API v1 and the 0.1 host routes it keeps as aliases (docs/27 §4).
        .merge(v1::router(state.clone(), body_limit))
        // BSDK-03: block frames and package files, answered on the block origin only.
        .route("/blocks/frame/{host}/{ty}", get(crate::blocks::frame))
        .route("/blocks/{ty}/{version}/{*path}", get(crate::blocks::file))
        .route("/healthz", get(ops::healthz))
        .route("/readyz", get(ops::readyz))
        .route("/metrics", get(ops::metrics))
        .route("/", get(|| async { Redirect::temporary("/app/") }))
        .route("/app", get(|| async { Redirect::permanent("/app/") }))
        .nest_service("/app/", spa)
        // Host pages load the embed SDK from here (docs/05 §4).
        .route_service("/sdk/embed.js", ServeFile::new(web.join("sdk/embed.js")))
        // OFF-03: the editor's service worker, at the root so its scope covers `/v1/launch`.
        .route_service("/sw.js", ServeFile::new(web.join("sw.js")))
        .layer(cors)
        .layer(axum::middleware::from_fn(
            move |req: Request<axum::body::Body>, next: axum::middleware::Next| {
                let (fa, default, per_host) = (fa.clone(), default.clone(), per_host.clone());
                async move {
                    let own = if req.uri().path().starts_with("/app/") {
                        app_host(req.uri().query()).and_then(|h| per_host.get(&h).cloned())
                    } else {
                        None
                    };
                    let res = next.run(req).await;
                    security_headers(fa, own.unwrap_or(default), res).await
                }
            },
        ))
        .layer({
            // OPS-01: `oc_http_responses_total{code}` by status class.
            let m = state.metrics.clone();
            axum::middleware::from_fn(
                move |req: Request<axum::body::Body>, next: axum::middleware::Next| {
                    let m = m.clone();
                    async move {
                        let res = next.run(req).await;
                        let class = crate::metrics::status_class(res.status().as_u16());
                        m.http_responses
                            .inc(crate::metrics::labels(&[("code", class)]));
                        res
                    }
                },
            )
        })
        .layer(TraceLayer::new_for_http().make_span_with(|req: &Request<_>| {
            tracing::info_span!("http", method = %req.method(), path = %redacted_path(req.uri().path()))
        }))
        .with_state(state)
}

#[cfg(test)]
mod csp_tests {
    use super::default_csp;

    /// The sources of one directive in a policy.
    fn directive<'a>(csp: &'a str, name: &str) -> Vec<&'a str> {
        csp.split(';')
            .map(str::trim)
            .find_map(|d| d.strip_prefix(name).filter(|r| r.starts_with(' ')))
            .map(|r| r.split_whitespace().collect())
            .unwrap_or_default()
    }

    /// ADR-078: the formula engine is WebAssembly, which browsers only compile under
    /// `'wasm-unsafe-eval'`. That allows WASM compilation alone: no `eval`, no inline script.
    #[test]
    fn editor_csp_allows_wasm_but_not_eval_or_inline_script() {
        let csp = default_csp("frame-ancestors 'self'", "");
        let script = directive(&csp, "script-src");
        assert_eq!(script, ["'self'", "'wasm-unsafe-eval'"], "{csp}");
        assert!(!script.contains(&"'unsafe-eval'"), "{csp}");
        assert!(!script.contains(&"'unsafe-inline'"), "{csp}");
        assert!(
            !script.iter().any(|s| s.starts_with("'nonce-") || *s == "*"),
            "{csp}"
        );
        assert_eq!(directive(&csp, "object-src"), ["'none'"], "{csp}");
    }
}
