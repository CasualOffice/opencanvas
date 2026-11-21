//! `POST|GET /v1/launch` (JWT, or WOPI with `?WOPISrc=`), `GET /v1/sessions/:ticket` (docs/15 §2)
//! and the WOPI discovery endpoints (docs/05 §6).

use std::time::Instant;

use axum::Json;
use axum::extract::{Form, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use super::{ApiError, session};
use crate::host_client::HostError;
use crate::metrics::Metrics;
use crate::util::{now_ms, now_secs};
use crate::wopi;
use crate::{SharedState, TicketUse};

#[derive(Deserialize)]
pub struct LaunchParams {
    #[serde(default)]
    token: String,
    /// Open the canvas at this block (UX-02); passed on as `&block=` in the app fragment.
    #[serde(default)]
    block: Option<String>,
}

/// Form fields of a launch POST: a JWT `token`, or WOPI `access_token` + `access_token_ttl`.
#[derive(Deserialize)]
pub struct LaunchForm {
    #[serde(default)]
    token: String,
    #[serde(default)]
    access_token: String,
    /// WOPI: expiry as milliseconds since the epoch; 0 / absent = unknown.
    #[serde(default)]
    access_token_ttl: Option<String>,
    #[serde(default)]
    block: Option<String>,
}

/// Query of a launch POST; `WOPISrc` selects WOPI mode. Other WOPI placeholders hosts append
/// (`ui`, `rs`, …) are ignored.
#[derive(Deserialize)]
pub struct LaunchQuery {
    #[serde(rename = "WOPISrc", default)]
    wopi_src: Option<String>,
    #[serde(default)]
    block: Option<String>,
}

/// Appends `&block=<id>` to a launch redirect when `block` is a plain id (`[A-Za-z0-9_-]`,
/// at most 64); anything else is dropped.
fn with_block(mut res: Response, block: Option<&str>) -> Response {
    let Some(b) = block.filter(|b| {
        !b.is_empty()
            && b.len() <= 64
            && b.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    }) else {
        return res;
    };
    if res.status() != StatusCode::SEE_OTHER {
        return res;
    }
    let loc = res
        .headers()
        .get(header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(|l| format!("{l}&block={b}"));
    if let Some(v) = loc.and_then(|l| header::HeaderValue::from_str(&l).ok()) {
        res.headers_mut().insert(header::LOCATION, v);
    }
    res
}

pub async fn launch_post(
    State(state): State<SharedState>,
    Query(q): Query<LaunchQuery>,
    Form(p): Form<LaunchForm>,
) -> Response {
    let res = match q.wopi_src {
        Some(src) => launch_wopi(&state, &src, &p).await,
        None => launch(&state, &p.token).await,
    };
    let block = p.block.as_deref().or(q.block.as_deref());
    with_block(res.unwrap_or_else(IntoResponse::into_response), block)
}

pub async fn launch_get(
    State(state): State<SharedState>,
    Query(p): Query<LaunchParams>,
) -> Response {
    let res = launch(&state, &p.token)
        .await
        .unwrap_or_else(IntoResponse::into_response);
    with_block(res, p.block.as_deref())
}

fn rejected(state: &SharedState, status: StatusCode, code: &'static str, msg: String) -> ApiError {
    Metrics::inc(&state.metrics.launches_rejected_total);
    tracing::info!(reason = %msg, "launch rejected");
    ApiError::new(status, code, msg)
}

fn redirect_to_app(ticket: &str) -> Response {
    (
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, format!("/app/#t={ticket}")),
            (header::CACHE_CONTROL, "no-store".into()),
        ],
    )
        .into_response()
}

/// WOPI launch (docs/05 §6): allowlist `WOPISrc`, CheckFileInfo with the opaque access
/// token, then a session like a JWT launch. The token is never logged.
async fn launch_wopi(
    state: &SharedState,
    src: &str,
    form: &LaunchForm,
) -> Result<Response, ApiError> {
    let now = now_secs();
    let Some((host, src)) = state.hosts.wopi_host_for(src) else {
        return Err(rejected(
            state,
            StatusCode::FORBIDDEN,
            "WOPISRC_NOT_ALLOWED",
            "WOPISrc is not in any host's wopi_allowlist".into(),
        ));
    };
    if form.access_token.is_empty() || form.access_token.len() > 4096 {
        return Err(rejected(
            state,
            StatusCode::UNAUTHORIZED,
            "TOKEN_INVALID",
            "access_token missing".into(),
        ));
    }
    let ttl_ms = form
        .access_token_ttl
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::parse::<i64>)
        .transpose()
        .map_err(|_| {
            rejected(
                state,
                StatusCode::BAD_REQUEST,
                "TTL_INVALID",
                "access_token_ttl must be milliseconds since the epoch".into(),
            )
        })?
        .unwrap_or(0);
    let exp = if ttl_ms > 0 {
        ttl_ms / 1000
    } else {
        now + wopi::DEFAULT_TTL_SECS
    };
    if exp <= now {
        return Err(rejected(
            state,
            StatusCode::UNAUTHORIZED,
            "TOKEN_INVALID",
            "access_token_ttl has passed".into(),
        ));
    }
    let info = match wopi::check_file_info(state.host.wopi_http(), &src, &form.access_token).await {
        Ok(info) => info,
        Err(HostError::Status(s)) if s.is_client_error() => {
            return Err(rejected(
                state,
                StatusCode::UNAUTHORIZED,
                "TOKEN_INVALID",
                format!("CheckFileInfo answered {s}"),
            ));
        }
        Err(e) => return Err(ApiError::host(e)),
    };
    state.host.remember_wopi_name(&src, &info.base_file_name);
    let grant = info.grant(&host.id, &src, &form.access_token);
    let ticket = ulid::Ulid::new().to_string();
    state
        .store
        .insert_session(&ticket, &grant, exp, now_ms())
        .await
        .map_err(ApiError::internal)?;
    Metrics::inc(&state.metrics.launches_total);
    tracing::info!(host = %host.id, room = %grant.room, role = grant.role.as_str(), "WOPI launch accepted");
    Ok(redirect_to_app(&ticket))
}

/// `GET /hosting/discovery` (WOPI discovery XML).
pub async fn discovery(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let public = public_base(&state, &headers);
    // Derived from the request's Host header unless OC_PUBLIC_URL is set: never let a shared
    // cache keep a copy someone built with a forged Host (SEC-06).
    let cache = if state.cfg.public_url.is_some() {
        "public, max-age=3600"
    } else {
        "private, no-store"
    };
    (
        [
            (header::CONTENT_TYPE, "text/xml; charset=utf-8"),
            (header::CACHE_CONTROL, cache),
        ],
        wopi::discovery_xml(&public),
    )
        .into_response()
}

/// `GET /hosting/capabilities`.
pub async fn capabilities() -> Response {
    Json(wopi::capabilities()).into_response()
}

/// `OC_PUBLIC_URL`, else the request's own origin.
fn public_base(state: &SharedState, headers: &HeaderMap) -> String {
    if let Some(base) = &state.cfg.public_url {
        return base.clone();
    }
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost:8080");
    let secure = headers
        .get("x-forwarded-proto")
        .and_then(|h| h.to_str().ok())
        == Some("https");
    format!("{}://{host}", if secure { "https" } else { "http" })
}

async fn launch(state: &SharedState, token: &str) -> Result<Response, ApiError> {
    let now = now_secs();
    let reject = |code, msg: String| rejected(state, StatusCode::UNAUTHORIZED, code, msg);
    let (host, claims) = state
        .jwks
        .verify(token, &state.hosts, now)
        .await
        .map_err(|e| reject("TOKEN_INVALID", e.to_string()))?;
    if host.wopi_only() {
        return Err(reject(
            "TOKEN_INVALID",
            "this host launches through WOPI only".into(),
        ));
    }
    let exp = claims.exp;
    if !state
        .store
        .use_jti(&host.id, &claims.jti, exp)
        .await
        .map_err(ApiError::internal)?
    {
        return Err(reject("TOKEN_REUSED", "launch token already used".into()));
    }
    let grant = claims.into_grant();
    let ticket = ulid::Ulid::new().to_string();
    state
        .store
        .insert_session(&ticket, &grant, exp, now_ms())
        .await
        .map_err(ApiError::internal)?;
    Metrics::inc(&state.metrics.launches_total);
    tracing::info!(host = %host.id, room = %grant.room, role = grant.role.as_str(), "launch accepted");
    Ok(redirect_to_app(&ticket))
}

fn ws_url(state: &SharedState, headers: &HeaderMap) -> String {
    if let Some(base) = &state.cfg.public_url {
        let base = base
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        return format!("{base}/v1/collab");
    }
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost:8080");
    let secure = headers
        .get("x-forwarded-proto")
        .and_then(|h| h.to_str().ok())
        == Some("https");
    format!("{}://{host}/v1/collab", if secure { "wss" } else { "ws" })
}

pub async fn session_info(
    State(state): State<SharedState>,
    Path(ticket): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &ticket).await?;
    let info = state
        .rooms
        .info(&host, &grant)
        .await
        .map_err(ApiError::host)?;
    state
        .tickets
        .lock()
        .expect("tickets lock")
        .entry(ticket.clone())
        .or_insert(TicketUse {
            first_seen: Instant::now(),
            connected: false,
        });
    let body = json!({
        "ticket": ticket,
        "room": grant.room,
        "role": grant.role,
        "user": grant.user,
        "file": {"id": grant.file.id, "name": grant.file.name},
        "host": {"id": host.id, "name": host.name},
        "perms": grant.perms,
        "isNew": info.is_new,
        "wsUrl": ws_url(&state, &headers),
    });
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response())
}
