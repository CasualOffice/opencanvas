//! Server-to-server REST for hosts (docs/05 §7), authenticated with the host `api_key`:
//! `X-OpenCanvas-Host: <host id>` + `X-OpenCanvas-Key: <api_key>`.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::ApiError;
use crate::SharedState;
use crate::grant::{Role, room_id};
use crate::hosts::HostConfig;

fn unauthorized() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "API_KEY_INVALID",
        "missing or wrong X-OpenCanvas-Host / X-OpenCanvas-Key",
    )
}

/// Compares digests so the check takes the same time whatever the key.
fn same_key(a: &str, b: &str) -> bool {
    let (x, y) = (Sha256::digest(a.as_bytes()), Sha256::digest(b.as_bytes()));
    x.iter()
        .zip(y.iter())
        .fold(0u8, |acc, (p, q)| acc | (p ^ q))
        == 0
}

fn authenticate(state: &SharedState, headers: &HeaderMap) -> Result<Arc<HostConfig>, ApiError> {
    let header = |k: &str| headers.get(k).and_then(|v| v.to_str().ok());
    let host = header("x-opencanvas-host")
        .and_then(|id| state.hosts.get(id))
        .ok_or_else(unauthorized)?;
    let expected = host.api_key.as_deref().filter(|k| !k.is_empty());
    match (expected, header("x-opencanvas-key")) {
        (Some(want), Some(got)) if same_key(want, got) => Ok(host),
        _ => Err(unauthorized()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleBody {
    user_id: String,
    role: String,
}

/// `POST /v1/files/:fileId/role {"userId","role":"view|comment|edit|none"}`: the user's open
/// connections switch role immediately (`none` disconnects them); their tickets follow.
pub async fn set_role(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<RoleBody>,
) -> Result<Json<Value>, ApiError> {
    let host = authenticate(&state, &headers)?;
    let role = match body.role.as_str() {
        "none" => None,
        r => Some(Role::parse(r).ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "ROLE_INVALID",
                "role must be view, comment, edit or none",
            )
        })?),
    };
    let room = room_id(&host.id, &file_id);
    let sessions = state
        .store
        .set_session_role(&room, &body.user_id, role)
        .await
        .map_err(ApiError::internal)?;
    let connections = state.rooms.set_role(&room, &body.user_id, role).await;
    tracing::info!(host = %host.id, room = %room, role = %body.role, connections, sessions, "role API");
    Ok(Json(
        json!({"connections": connections, "sessions": sessions}),
    ))
}

/// `DELETE /v1/files/:fileId/session`: final save, disconnect everyone, drop all tickets.
pub async fn close_session(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let host = authenticate(&state, &headers)?;
    let room = room_id(&host.id, &file_id);
    let sessions = state
        .store
        .delete_room_sessions(&room)
        .await
        .map_err(ApiError::internal)?;
    let closed = state.rooms.close(&room).await;
    tracing::info!(host = %host.id, room = %room, closed, sessions, "session closed by host");
    Ok(Json(json!({"closed": closed, "sessions": sessions})))
}
