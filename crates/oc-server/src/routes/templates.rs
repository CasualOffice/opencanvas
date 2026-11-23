// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Team templates for the editor (TPL-01, docs/15 §2): the editor never calls the host.
//!
//! - `GET /v1/templates?ticket=` → `{"enabled", "templates": [{id, name, description,
//!   category, icon, tone, updatedAt}]}` from the host's `GET /templates`, cached per host.
//! - `POST /v1/templates/{id}/apply?ticket=` (edit role) → the host's `GET /templates/{id}`
//!   file, checked (size, MOD-01 schema), replaces the canvas content as one transaction.
//!   Answers `{"applyId", "blockIds", "name"}`.
//! - `POST /v1/templates/undo?ticket=&applyId=` (edit role, the same user) → reverts it.
//!
//! Gate: `[host.flags] team_templates = true`.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::api::patch_error;
use super::{ApiError, session};
use crate::SharedState;
use crate::grant::{Grant, Role};
use crate::host_client::HostError;
use crate::hosts::HostConfig;
use crate::team_templates::{self as tt, TeamTemplate, TemplateError};

#[derive(Deserialize)]
pub struct Params {
    #[serde(default)]
    ticket: String,
    #[serde(default, rename = "applyId")]
    apply_id: String,
}

fn off() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "TEMPLATES_OFF",
        "team templates are off for this host",
    )
}

fn host_error(e: HostError) -> ApiError {
    match e {
        HostError::TooLarge => ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "TEMPLATE_TOO_LARGE",
            format!("templates are at most {} bytes", tt::MAX_TEMPLATE_BYTES),
        ),
        e => ApiError::host(e),
    }
}

/// The host's list, from the cache when fresh. `None` = no templates callback.
async fn list(
    state: &SharedState,
    host: &HostConfig,
    grant: &Grant,
) -> Result<Option<Vec<TeamTemplate>>, ApiError> {
    if let Some(l) = state.team_templates.get(&host.id) {
        return Ok(l);
    }
    let l = state
        .host
        .templates(host, &grant.callback_token)
        .await
        .map_err(host_error)?
        .map(|v| tt::parse_list(&v));
    state.team_templates.put(&host.id, l.clone());
    Ok(l)
}

/// `GET /v1/templates?ticket=`.
pub async fn index(
    State(state): State<SharedState>,
    Query(p): Query<Params>,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &p.ticket).await?;
    if !host.team_templates() {
        return Ok(Json(json!({"enabled": false, "templates": []})).into_response());
    }
    let l = list(&state, &host, &grant).await?;
    Ok(Json(json!({"enabled": l.is_some(), "templates": l.unwrap_or_default()})).into_response())
}

fn check_edit(state: &SharedState, host: &HostConfig, grant: &Grant) -> Result<(), ApiError> {
    if !host.team_templates() {
        return Err(off());
    }
    if grant.role != Role::Edit {
        return Err(ApiError::forbidden(
            "applying a template needs the edit role",
        ));
    }
    if state
        .members
        .without_revoked(&grant.room, vec![grant.user.clone()])
        .is_empty()
    {
        return Err(ApiError::forbidden("access was revoked"));
    }
    Ok(())
}

/// `POST /v1/templates/{id}/apply?ticket=`.
pub async fn apply(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    Query(p): Query<Params>,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &p.ticket).await?;
    check_edit(&state, &host, &grant)?;
    if !tt::valid_id(&id) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "TEMPLATE_NOT_FOUND",
            "no such template",
        ));
    }
    let entry = list(&state, &host, &grant)
        .await
        .ok()
        .flatten()
        .and_then(|l| l.into_iter().find(|t| t.id == id));
    let bytes = state
        .host
        .template_file(&host, &grant.callback_token, &id)
        .await
        .map_err(host_error)?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "TEMPLATE_NOT_FOUND",
                "the host has no such template",
            )
        })?;
    let refused = |e: TemplateError| match e {
        TemplateError::TooLarge => host_error(HostError::TooLarge),
        TemplateError::Invalid(m) => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "TEMPLATE_INVALID",
            format!("the template can't be used: {m}"),
        ),
    };
    let doc = tt::read_file(&bytes).map_err(refused)?;
    // Meta: the list entry first, then the file's own meta.
    let file_meta = doc["meta"].clone();
    let pick = |from_list: Option<&str>, key: &str| -> Option<Value> {
        from_list
            .map(|s| json!(s))
            .or_else(|| file_meta.get(key).filter(|v| v.is_string()).cloned())
    };
    let mut meta = Map::new();
    let name = pick(entry.as_ref().map(|e| e.name.as_str()), "title");
    if let Some(n) = &name {
        meta.insert("title".into(), n.clone());
    }
    if let Some(i) = pick(entry.as_ref().map(|e| e.icon.as_str()), "icon") {
        meta.insert("icon".into(), i);
    }
    if let Some(t) = pick(entry.as_ref().map(|e| e.tone.as_str()), "tone") {
        meta.insert("tone".into(), t);
    }
    meta.insert("template".into(), json!(format!("team:{id}")));
    let prepared = tt::prepare(&doc, meta).map_err(refused)?;
    let apply_id = ulid::Ulid::new().to_string().to_lowercase();
    let origin = format!("template:{}:{apply_id}", grant.user.id);
    let out = state
        .rooms
        .apply_template(&host, &grant, prepared, &origin)
        .await
        .map_err(ApiError::host)?
        .map_err(patch_error)?;
    tracing::info!(host = %host.id, room = %grant.room, "team template applied");
    Ok(Json(json!({
        "applyId": apply_id,
        "blockIds": out.block_ids,
        "name": name,
    }))
    .into_response())
}

/// `POST /v1/templates/undo?ticket=&applyId=`.
pub async fn undo(
    State(state): State<SharedState>,
    Query(p): Query<Params>,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &p.ticket).await?;
    check_edit(&state, &host, &grant)?;
    if p.apply_id.is_empty() || p.apply_id.len() > 64 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
            "applyId is required",
        ));
    }
    // The origin names the user: nobody can undo someone else's template.
    let origin = format!("template:{}:{}", grant.user.id, p.apply_id);
    state
        .rooms
        .undo_template(&host, &grant, &origin)
        .await
        .map_err(ApiError::host)?
        .map_err(|e| match e {
            crate::room::PatchFailure::Invalid(_) => ApiError::new(
                StatusCode::CONFLICT,
                "NOTHING_TO_UNDO",
                "this template can no longer be undone",
            ),
            e => patch_error(e),
        })?;
    Ok(Json(json!({"undone": true})).into_response())
}
