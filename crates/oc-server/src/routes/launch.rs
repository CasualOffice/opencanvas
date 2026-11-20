//! `POST|GET /v1/launch` and `GET /v1/sessions/:ticket` (docs/15 §2).

use std::time::Instant;

use axum::Json;
use axum::extract::{Form, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use super::{ApiError, session};
use crate::metrics::Metrics;
use crate::util::{now_ms, now_secs};
use crate::{SharedState, TicketUse};

#[derive(Deserialize)]
pub struct LaunchParams {
    token: String,
}

pub async fn launch_post(
    State(state): State<SharedState>,
    Form(p): Form<LaunchParams>,
) -> Response {
    launch(&state, &p.token)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

pub async fn launch_get(
    State(state): State<SharedState>,
    Query(p): Query<LaunchParams>,
) -> Response {
    launch(&state, &p.token)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

async fn launch(state: &SharedState, token: &str) -> Result<Response, ApiError> {
    let now = now_secs();
    let reject = |code, msg: String| {
        Metrics::inc(&state.metrics.launches_rejected_total);
        tracing::info!(reason = %msg, "launch rejected");
        ApiError::new(StatusCode::UNAUTHORIZED, code, msg)
    };
    let (host, claims) = state
        .jwks
        .verify(token, &state.hosts, now)
        .await
        .map_err(|e| reject("TOKEN_INVALID", e.to_string()))?;
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
    Ok((
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, format!("/app/#t={ticket}")),
            (header::CACHE_CONTROL, "no-store".into()),
        ],
    )
        .into_response())
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
