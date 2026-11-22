// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Server-to-server REST for hosts (docs/05 §7), authenticated with the host `api_key`:
//! `X-OpenCanvas-Host: <host id>` + `X-OpenCanvas-Key: <api_key>`.

use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use oc_model::patch::{PatchError, PatchOp};
use serde::Deserialize;
use serde_json::{Value, json};

use super::ApiError;
use crate::SharedState;
use crate::cluster::bus::MembersEvent;
use crate::grant::{FileRef, Grant, Perms, Role, User, derive_color, room_id};
use crate::hosts::HostConfig;
use crate::room::{CommitResult, PatchFailure};

fn unauthorized() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "API_KEY_INVALID",
        "missing or wrong X-OpenCanvas-Host / X-OpenCanvas-Key",
    )
}

pub(super) fn authenticate(
    state: &SharedState,
    headers: &HeaderMap,
) -> Result<Arc<HostConfig>, ApiError> {
    let header = |k: &str| headers.get(k).and_then(|v| v.to_str().ok());
    let host = header("x-opencanvas-host")
        .and_then(|id| state.hosts.get(id))
        .ok_or_else(unauthorized)?;
    let expected = host.api_key.as_deref().filter(|k| !k.is_empty());
    match (expected, header("x-opencanvas-key")) {
        (Some(want), Some(got)) if crate::util::same_secret(want, got) => Ok(host),
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
    // Cached MCP `/access` answers for this user are dropped too (docs/24 §7.1 rule 5).
    state
        .host
        .forget_access(&host.id, &file_id, Some(&body.user_id));
    let sessions = state
        .store
        .set_session_role(&room, &body.user_id, role)
        .await
        .map_err(ApiError::internal)?;
    // docs/21 revision 2: revocation is authoritative for the member list at once, on every
    // node (cluster: published before the room is told, so refetches see it).
    let (room_s, user) = (room.clone(), body.user_id.clone());
    state
        .members_event(if role.is_none() {
            MembersEvent::Revoke { room: room_s, user }
        } else {
            MembersEvent::Restore { room: room_s, user }
        })
        .await;
    let connections = state.rooms.set_role(&room, &body.user_id, role).await;
    tracing::info!(host = %host.id, room = %room, role = %body.role, connections, sessions, "role API");
    Ok(Json(
        json!({"connections": connections, "sessions": sessions}),
    ))
}

/// `POST /v1/files/:fileId/members/invalidate`: the host's member list changed. Drops the
/// cached members callback answers for the file; every open editor refetches `/v1/members`.
pub async fn invalidate_members(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let host = authenticate(&state, &headers)?;
    let room = room_id(&host.id, &file_id);
    state.host.forget_access(&host.id, &file_id, None);
    state
        .members_event(MembersEvent::Invalidate { room: room.clone() })
        .await;
    // No user has the empty id: this only tells the room the list changed.
    let _ = state.rooms.set_role(&room, "", None).await;
    tracing::info!(host = %host.id, room = %room, "members invalidated by host");
    Ok(Json(json!({"invalidated": true})))
}

/// `DELETE /v1/files/:fileId/session`: final save, disconnect everyone, drop all tickets.
pub async fn close_session(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let host = authenticate(&state, &headers)?;
    let room = room_id(&host.id, &file_id);
    state
        .members_event(MembersEvent::Invalidate { room: room.clone() })
        .await;
    let sessions = state
        .store
        .delete_room_sessions(&room)
        .await
        .map_err(ApiError::internal)?;
    let closed = state.rooms.close(&room).await;
    if host.ephemeral() {
        // ADR-043: the live room destroyed itself; this also clears a room that was not live.
        state
            .store
            .destroy_room(&room, None)
            .await
            .map_err(ApiError::internal)?;
    }
    tracing::info!(host = %host.id, room = %room, closed, sessions, "session closed by host");
    Ok(Json(json!({"closed": closed, "sessions": sessions})))
}

// ---------- patch / commit / convert ----------

/// Optional bearer for callbacks made on behalf of a host API call (loading or saving a file
/// with no live room, fetching images). Without it the bearer is empty and the host relies on
/// the HMAC signature.
pub(super) fn callback_token(headers: &HeaderMap) -> String {
    headers
        .get("x-opencanvas-callback-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

#[derive(Deserialize)]
pub struct Author {
    pub(super) id: String,
    #[serde(default)]
    pub(super) name: Option<String>,
}

#[derive(Deserialize)]
pub struct PatchBody {
    ops: Vec<PatchOp>,
    author: Author,
}

/// The grant a host API call acts under: an `edit` "user" named after the author.
pub(super) fn api_grant(host: &HostConfig, file_id: &str, author: &Author, token: String) -> Grant {
    Grant {
        host_id: host.id.clone(),
        room: room_id(&host.id, file_id),
        role: Role::Edit,
        user: User {
            id: author.id.clone(),
            name: author.name.clone().unwrap_or_else(|| author.id.clone()),
            color: derive_color(&author.id),
            ..Default::default()
        },
        file: FileRef {
            id: file_id.to_string(),
            name: file_id.to_string(),
            version: None,
        },
        perms: Perms::default(),
        callback_token: token,
        members: vec![],
    }
}

fn patch_invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "PATCH_INVALID", message)
}

pub(super) fn conflict() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "CONFLICT",
        "the file changed elsewhere; the host's conflict policy is running",
    )
}

/// Maps a commit result to the API answer: 200 `{live, saved, version}`, 202 queued, 409.
fn commit_response(live: bool, result: CommitResult) -> Result<Response, ApiError> {
    Ok(match result {
        CommitResult::Saved { version } => {
            Json(json!({"live": live, "saved": true, "version": version})).into_response()
        }
        CommitResult::Clean { version } => {
            Json(json!({"live": live, "saved": false, "version": version})).into_response()
        }
        CommitResult::Queued { message } => (
            StatusCode::ACCEPTED,
            Json(json!({"live": live, "queued": true, "message": message})),
        )
            .into_response(),
        CommitResult::Conflict => return Err(conflict()),
    })
}

pub(super) fn patch_error(e: PatchFailure) -> ApiError {
    match e {
        PatchFailure::Invalid(p @ PatchError::NotFound(..)) => {
            ApiError::new(StatusCode::NOT_FOUND, "BLOCK_NOT_FOUND", p.to_string())
        }
        PatchFailure::Invalid(p) => patch_invalid(p.to_string()),
        PatchFailure::TooLarge => ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "DOC_TOO_LARGE",
            "the patched document would exceed the size limit",
        ),
        PatchFailure::Conflict => conflict(),
        PatchFailure::Unavailable => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "ROOM_UNAVAILABLE",
            "the change could not be stored; retry",
        ),
    }
}

/// `POST /v1/files/:fileId/patch {"ops":[…],"author":{"id","name"}}`.
pub async fn patch(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let host = authenticate(&state, &headers)?;
    let body: PatchBody =
        serde_json::from_slice(&body).map_err(|e| patch_invalid(e.to_string()))?;
    if body.author.id.trim().is_empty() {
        return Err(patch_invalid("author.id is required"));
    }
    let grant = api_grant(&host, &file_id, &body.author, callback_token(&headers));
    let live = state.rooms.is_live(&grant.room);
    let n = body.ops.len();
    let patched = state
        .rooms
        .patch(&host, &grant, body.ops, &body.author.id)
        .await
        .map_err(ApiError::host)?
        .map_err(patch_error)?;
    tracing::info!(host = %host.id, room = %grant.room, ops = n, live, "patch API");
    let out = json!({"applied": n, "blockIds": patched.block_ids, "live": live});
    save_if_idle(&state, &host, &grant, out, live).await
}

/// After a host API change: answer at once when an editor has the file open, else save now
/// so the host has the change (200 saved, 202 queued in the outbox, 409 conflict).
pub(super) async fn save_if_idle(
    state: &SharedState,
    host: &Arc<HostConfig>,
    grant: &Grant,
    mut out: Value,
    live: bool,
) -> Result<Response, ApiError> {
    if live {
        return Ok(Json(out).into_response());
    }
    // No editor had the file open: save now so the host has the change.
    let result = state
        .rooms
        .commit(host, grant)
        .await
        .map_err(ApiError::host)?;
    let (status, version) = match result {
        CommitResult::Saved { version } | CommitResult::Clean { version } => {
            (StatusCode::OK, version)
        }
        CommitResult::Queued { .. } => {
            out["queued"] = json!(true);
            (StatusCode::ACCEPTED, None)
        }
        CommitResult::Conflict => return Err(conflict()),
    };
    out["version"] = json!(version);
    Ok((status, Json(out)).into_response())
}

/// `POST /v1/files/:fileId/commit`: save now. 200 once the host acknowledged, 202 when the
/// save failed and waits in the outbox, 409 on a conflict.
pub async fn commit(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let host = authenticate(&state, &headers)?;
    let room = room_id(&host.id, &file_id);
    if let Some(result) = state.rooms.commit_live(&room).await {
        return commit_response(true, result);
    }
    // Not live: resume a commit still waiting in the outbox, else there is nothing to save.
    let pending = state
        .store
        .outbox_pending(&room)
        .await
        .map_err(ApiError::internal)?;
    if pending.is_some() {
        state.resume_outbox().await.map_err(ApiError::internal)?;
        if let Some(result) = state.rooms.commit_live(&room).await {
            return commit_response(true, result);
        }
    }
    commit_response(false, CommitResult::Clean { version: None })
}

#[derive(Deserialize)]
pub struct ConvertParams {
    #[serde(default)]
    from: String,
    #[serde(default)]
    to: String,
}

/// `POST /v1/convert?from=md|html|ocanvas&to=ocanvas|md|html|json|docx|pdf`, stateless.
pub async fn convert(
    State(state): State<SharedState>,
    Query(p): Query<ConvertParams>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let host = authenticate(&state, &headers)?;
    let unsupported = |m: &str| ApiError::new(StatusCode::BAD_REQUEST, "FORMAT_UNSUPPORTED", m);
    if !matches!(
        p.to.as_str(),
        "ocanvas" | "md" | "html" | "json" | "docx" | "pdf"
    ) {
        return Err(unsupported("to: ocanvas, md, html, json, docx or pdf"));
    }
    let doc = match p.from.as_str() {
        "md" => {
            let d = oc_model::new_doc();
            oc_model::import::apply_markdown(&d, &String::from_utf8_lossy(&body));
            d
        }
        "html" => {
            let d = oc_model::new_doc();
            let json = oc_model::html::html_to_json(&String::from_utf8_lossy(&body));
            oc_model::import::apply_document_json(&d, &json);
            d
        }
        "ocanvas" => {
            oc_model::read_ocanvas(&body)
                .map_err(|e| {
                    ApiError::new(StatusCode::BAD_REQUEST, "INPUT_INVALID", e.to_string())
                })?
                .doc
        }
        _ => return Err(unsupported("from: md, html or ocanvas")),
    };
    let token = callback_token(&headers);
    let req = super::export::RenderReq {
        token: &token,
        author: "opencanvas",
        wopi_room: None,
        people: None,
    };
    let (bytes, ctype, _) = super::export::render(&state, &host, &doc, &p.to, req).await?;
    Ok((
        [
            (header::CONTENT_TYPE, ctype),
            (header::CONTENT_SECURITY_POLICY, super::export::EXPORT_CSP),
        ],
        bytes,
    )
        .into_response())
}
