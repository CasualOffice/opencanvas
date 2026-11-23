// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Version history for the editor (VH-01b, docs/30 §8, ADR-051, ADR-055). The editor never
//! calls the host; OpenCanvas stores no version (everything here is cached in memory only).
//!
//! - `GET /v1/history?ticket=[&cursor=]` → `{source, versions, next?, recent?, hostName}`.
//!   `source` is the list shown first (`host` or `file`); with both, `recent` holds the in-file
//!   versions. In-file version ids are `file:<commit id>`.
//! - `GET /v1/history/{v}?ticket=` → that version's Yjs state (v1 update), for a read-only
//!   preview.
//! - `GET /v1/history/diff?ticket=&from=&to=current|<v>` → the ADR-052 diff (`422
//!   DIFF_TOO_LARGE` past its limits).
//! - `POST /v1/history/name?ticket=` `{name}` → a named version now (edit + `commitMessage`).
//! - `POST /v1/history/{v}/restore?ticket=` `{label?}` → save, apply the version as one edit,
//!   save it as "Restored from …" (edit + `restore`) → `{restoreId, version, changed}`.
//! - `POST /v1/history/restore/undo?ticket=&restoreId=` → undo it (same person, 30 s).

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{ApiError, session};
use crate::SharedState;
use crate::grant::Grant;
use crate::history::{FileSnapshot, Sources, VersionDoc};
use crate::host_client::{Fetched, HostError, SaveTarget};
use crate::hosts::HostConfig;
use crate::room::HistoryOp;

const FILE_PREFIX: &str = "file:";

#[derive(Deserialize)]
pub struct Params {
    #[serde(default)]
    ticket: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    from: String,
    #[serde(default)]
    to: Option<String>,
    #[serde(default, rename = "restoreId")]
    restore_id: String,
}

#[derive(Deserialize, Default)]
pub struct NameBody {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize, Default)]
pub struct RestoreBody {
    /// How the editor shows the version ("'Board review ready'", "Nov 21, 10:14"); the server
    /// does not know the viewer's time zone.
    #[serde(default)]
    label: Option<String>,
}

fn err(status: StatusCode, code: &'static str, msg: &str) -> ApiError {
    ApiError::new(status, code, msg)
}

/// The session, checked for history access, and where its versions come from.
async fn open(
    state: &SharedState,
    ticket: &str,
) -> Result<(Arc<HostConfig>, Grant, Sources), ApiError> {
    let (host, grant) = session(state, ticket).await?;
    if !grant.can_see_history() {
        return Err(err(
            StatusCode::FORBIDDEN,
            "HISTORY_FORBIDDEN",
            "you can't see this canvas's history",
        ));
    }
    let mut s = Sources::of(&host, &grant);
    if state
        .history
        .unsupported
        .lock()
        .expect("lock")
        .contains(&grant.room)
    {
        s.host = false;
    }
    if !s.host && !s.file {
        return Err(err(
            StatusCode::NOT_FOUND,
            "HISTORY_OFF",
            "this canvas keeps no history here",
        ));
    }
    Ok((host, grant, s))
}

fn host_err(e: HostError) -> ApiError {
    match e {
        HostError::Status(s) if s == StatusCode::NOT_FOUND || s == StatusCode::GONE => err(
            StatusCode::NOT_FOUND,
            "VERSION_GONE",
            "this version is no longer kept",
        ),
        HostError::TooLarge => err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "VERSION_TOO_LARGE",
            "this version is too large to open",
        ),
        e => ApiError::host(e),
    }
}

/// The host's file, for its in-file history (ADR-055); cached 30 s.
async fn file_snapshot(
    state: &SharedState,
    host: &HostConfig,
    grant: &Grant,
) -> Result<Arc<FileSnapshot>, ApiError> {
    let key = format!("{}:file", grant.room);
    if let Some(s) = state.history.files.get(&key) {
        return Ok(s);
    }
    let fetched = state
        .host
        .get_file(host, &grant.callback_token, &grant.file.id)
        .await
        .map_err(host_err)?;
    let (snap, weight) = match fetched {
        Fetched::Found { bytes, .. } if oc_model::ocanvas::is_zip(&bytes) => {
            let loaded = oc_model::read_ocanvas(&bytes).map_err(|e| {
                err(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "VERSION_INVALID",
                    &e.to_string(),
                )
            })?;
            (
                FileSnapshot {
                    current: oc_model::doc_to_json(&loaded.doc),
                    meta: oc_model::history::VersionMeta::from_manifest(&loaded.manifest),
                    history: loaded.history,
                },
                bytes.len() * 4,
            )
        }
        _ => (
            FileSnapshot {
                current: json!({}),
                meta: Default::default(),
                history: Default::default(),
            },
            64,
        ),
    };
    Ok(state.history.files.insert(key, snap, weight))
}

/// The in-file versions, newest first: the file's own (last saved) state, then its history.
fn file_list(snap: &FileSnapshot) -> Vec<Value> {
    let mut out = Vec::new();
    if !snap.meta.id.is_empty() {
        let m = &snap.meta;
        let mut v = json!({"version": format!("{FILE_PREFIX}{}", m.id), "kind": m.kind.as_str(),
            "authors": m.authors, "at": m.at, "source": "file", "latest": true});
        if let Some(n) = &m.name {
            v["name"] = json!(n);
        }
        out.push(v);
    }
    for mut v in snap.history.list() {
        v["version"] = json!(format!(
            "{FILE_PREFIX}{}",
            v["version"].as_str().unwrap_or("")
        ));
        v["source"] = json!("file");
        out.push(v);
    }
    out
}

/// `GET /v1/history?ticket=[&cursor=]`.
pub async fn list(
    State(state): State<SharedState>,
    Query(p): Query<Params>,
) -> Result<Response, ApiError> {
    let (host, grant, mut s) = open(&state, &p.ticket).await?;
    let mut host_list: Option<Value> = None;
    if s.host {
        let key = format!("{}:list:{}", grant.room, p.cursor.as_deref().unwrap_or(""));
        if let Some(l) = state.history.lists.get(&key) {
            host_list = Some((*l).clone());
        } else {
            match state
                .host
                .list_versions(
                    &host,
                    &grant.callback_token,
                    &grant.file.id,
                    p.cursor.as_deref(),
                    50,
                )
                .await
            {
                Ok(mut l) => {
                    for v in l["versions"].as_array_mut().into_iter().flatten() {
                        v["source"] = json!("host");
                    }
                    let w = l.to_string().len();
                    host_list = Some((*state.history.lists.insert(key, l, w)).clone());
                }
                // Not implemented: this session falls back to what else it has (docs/30 §3).
                Err(HostError::Status(st)) if [404, 405, 501].contains(&st.as_u16()) => {
                    state
                        .history
                        .unsupported
                        .lock()
                        .expect("lock")
                        .insert(grant.room.clone());
                    s.host = false;
                }
                Err(e) => return Err(ApiError::host(e)),
            }
        }
    }
    let file = if s.file && p.cursor.is_none() {
        Some(file_list(&*file_snapshot(&state, &host, &grant).await?))
    } else {
        None
    };
    let mut out = json!({"hostName": host.name});
    match (host_list, file, s.primary()) {
        (Some(h), f, Some("host")) | (Some(h), f @ None, _) => {
            out["source"] = json!("host");
            out["versions"] = h["versions"].clone();
            if let Some(n) = h.get("next") {
                out["next"] = n.clone();
            }
            if let Some(f) = f {
                out["recent"] = json!(f);
            }
        }
        (_, Some(f), _) => {
            out["source"] = json!("file");
            out["versions"] = json!(f);
        }
        _ => {
            out["source"] = Value::Null;
            out["versions"] = json!([]);
        }
    }
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(out)).into_response())
}

/// One version, decoded; cached 5 minutes.
async fn version_doc(
    state: &SharedState,
    host: &HostConfig,
    grant: &Grant,
    v: &str,
) -> Result<Arc<VersionDoc>, ApiError> {
    if v.is_empty() || v.len() > 200 {
        return Err(err(StatusCode::BAD_REQUEST, "BAD_REQUEST", "version id"));
    }
    let key = format!("{}:v:{v}", grant.room);
    if let Some(d) = state.history.versions.get(&key) {
        return Ok(d);
    }
    let cap = state.cfg.rooms.max_doc_bytes;
    let doc = if let Some(id) = v.strip_prefix(FILE_PREFIX) {
        let snap = file_snapshot(state, host, grant).await?;
        let json = if id == snap.meta.id {
            Some(snap.current.clone())
        } else {
            snap.history.state_of(&snap.current, id)
        }
        .ok_or_else(|| {
            err(
                StatusCode::NOT_FOUND,
                "VERSION_GONE",
                "this version is no longer kept",
            )
        })?;
        let doc = oc_model::new_doc();
        oc_model::import::apply_document_json(&doc, &json);
        doc
    } else {
        let bytes = state
            .host
            .get_version(host, &grant.callback_token, &grant.file.id, v)
            .await
            .map_err(host_err)?;
        // WOPI versions carry their images inline: make them servable for this room.
        if matches!(
            SaveTarget::of(host, &grant.file.id),
            Ok(SaveTarget::Wopi(_))
        ) {
            for a in oc_model::ocanvas::read_assets(&bytes).unwrap_or_default() {
                let _ = state
                    .store
                    .asset_put(&grant.room, &a, crate::util::now_ms())
                    .await;
            }
        }
        oc_model::read_ocanvas(&bytes)
            .map_err(|e| {
                err(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "VERSION_INVALID",
                    &e.to_string(),
                )
            })?
            .doc
    };
    let state_bytes = oc_model::ocanvas::encode_state(&doc);
    if state_bytes.len() > cap {
        return Err(err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "VERSION_TOO_LARGE",
            "this version is over the document size limit",
        ));
    }
    let json = oc_model::doc_to_json(&doc);
    let weight = state_bytes.len() + json.to_string().len();
    Ok(state.history.versions.insert(
        key,
        VersionDoc {
            json,
            state: state_bytes,
        },
        weight,
    ))
}

/// `GET /v1/history/{v}?ticket=`: the version's Yjs state.
pub async fn version(
    State(state): State<SharedState>,
    Path(v): Path<String>,
    Query(p): Query<Params>,
) -> Result<Response, ApiError> {
    let (host, grant, _) = open(&state, &p.ticket).await?;
    let d = version_doc(&state, &host, &grant, &v).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        d.state.clone(),
    )
        .into_response())
}

/// `GET /v1/history/diff?ticket=&from=&to=`.
pub async fn diff(
    State(state): State<SharedState>,
    Query(p): Query<Params>,
) -> Result<Response, ApiError> {
    let (host, grant, _) = open(&state, &p.ticket).await?;
    let to = p.to.clone().unwrap_or_else(|| "current".into());
    let key = format!("{}:diff:{}:{to}", grant.room, p.from);
    if to != "current"
        && let Some(d) = state.history.diffs.get(&key)
    {
        return Ok(Json((*d).clone()).into_response());
    }
    let from = version_doc(&state, &host, &grant, &p.from)
        .await?
        .json
        .clone();
    let to_json = if to == "current" {
        let bytes = state
            .rooms
            .state(&host, &grant)
            .await
            .map_err(ApiError::host)?;
        let d = oc_model::new_doc();
        oc_model::ocanvas::apply_update_bytes(&d, &bytes).map_err(ApiError::internal)?;
        oc_model::doc_to_json(&d)
    } else {
        version_doc(&state, &host, &grant, &to).await?.json.clone()
    };
    let out = tokio::task::spawn_blocking(move || {
        oc_model::diff::diff_json(&from, &to_json, &oc_model::diff::Limits::default())
    })
    .await
    .map_err(ApiError::internal)?
    .map_err(|_| {
        err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "DIFF_TOO_LARGE",
            "these versions differ too much to compare",
        )
    })?;
    if to != "current" {
        let w = out.to_string().len();
        state.history.diffs.insert(key, out.clone(), w);
    }
    Ok(Json(out).into_response())
}

/// Maps a room's `{"error": CODE}` answer.
fn room_answer(v: Value) -> Result<Value, ApiError> {
    let Some(code) = v["error"].as_str() else {
        return Ok(v);
    };
    Err(match code {
        "CONFLICT" => err(
            StatusCode::CONFLICT,
            "CONFLICT",
            "the canvas is handling a save conflict",
        ),
        "NOTHING_TO_UNDO" => err(
            StatusCode::CONFLICT,
            "NOTHING_TO_UNDO",
            "this restore can no longer be undone",
        ),
        "UNDO_EXPIRED" => err(
            StatusCode::CONFLICT,
            "UNDO_EXPIRED",
            "the time to undo this restore has passed",
        ),
        "DOC_TOO_LARGE" => err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "DOC_TOO_LARGE",
            "the version is over the document size limit",
        ),
        "VERSION_INVALID" => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "VERSION_INVALID",
            "this version can't be restored",
        ),
        "HISTORY_OFF" => err(
            StatusCode::NOT_FOUND,
            "HISTORY_OFF",
            "this canvas keeps no history",
        ),
        _ => err(
            StatusCode::SERVICE_UNAVAILABLE,
            "UNAVAILABLE",
            "the canvas could not be saved; try again",
        ),
    })
}

/// `POST /v1/history/name?ticket=` `{name}`.
pub async fn name(
    State(state): State<SharedState>,
    Query(p): Query<Params>,
    body: Option<Json<NameBody>>,
) -> Result<Response, ApiError> {
    let (host, grant, _) = open(&state, &p.ticket).await?;
    if !grant.can_name_version() {
        return Err(ApiError::forbidden(
            "you can't name versions of this canvas",
        ));
    }
    let name = body.map(|b| b.0.name).unwrap_or_default();
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "NAME_INVALID",
            "a name is 1 to 120 characters",
        ));
    }
    let v = state
        .rooms
        .history(
            &host,
            &grant,
            HistoryOp::Save {
                name: Some(name.to_string()),
            },
        )
        .await
        .map_err(ApiError::host)?;
    let v = room_answer(v)?;
    state.history.saved(&grant.room);
    Ok(
        Json(json!({"name": name, "version": v["version"], "queued": v.get("queued")}))
            .into_response(),
    )
}

/// `POST /v1/history/{v}/restore?ticket=` `{label?}`.
pub async fn restore(
    State(state): State<SharedState>,
    Path(v): Path<String>,
    Query(p): Query<Params>,
    body: Option<Json<RestoreBody>>,
) -> Result<Response, ApiError> {
    let (host, grant, _) = open(&state, &p.ticket).await?;
    if !grant.can_restore() {
        return Err(ApiError::forbidden(
            "you can't restore versions of this canvas",
        ));
    }
    let target = version_doc(&state, &host, &grant, &v).await?.json.clone();
    let label = body
        .and_then(|b| b.0.label)
        .map(|l| l.trim().chars().take(100).collect::<String>())
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| v.trim_start_matches(FILE_PREFIX).to_string());
    let name: String = format!("Restored from {label}").chars().take(120).collect();
    // 1. Save first: the state before the restore is always a version (docs/30 §5).
    room_answer(
        state
            .rooms
            .history(&host, &grant, HistoryOp::Save { name: None })
            .await
            .map_err(ApiError::host)?,
    )?;
    // 2-5. Apply only the differences as one edit, save it as a restore version, tell everyone.
    let restore_id = ulid::Ulid::new().to_string().to_lowercase();
    let out = room_answer(
        state
            .rooms
            .history(
                &host,
                &grant,
                HistoryOp::Restore {
                    target,
                    from: v.clone(),
                    name: name.clone(),
                    restore_id: restore_id.clone(),
                    by_name: grant.user.name.clone(),
                },
            )
            .await
            .map_err(ApiError::host)?,
    )?;
    state.history.saved(&grant.room);
    tracing::info!(host = %host.id, room = %grant.room, "version restored");
    Ok(Json(json!({
        "restoreId": restore_id,
        "name": name,
        "version": out["version"],
        "changed": out["changed"],
    }))
    .into_response())
}

/// `POST /v1/history/restore/undo?ticket=&restoreId=`.
pub async fn undo(
    State(state): State<SharedState>,
    Query(p): Query<Params>,
) -> Result<Response, ApiError> {
    let (host, grant, _) = open(&state, &p.ticket).await?;
    if !grant.can_restore() {
        return Err(ApiError::forbidden(
            "you can't restore versions of this canvas",
        ));
    }
    if p.restore_id.is_empty() || p.restore_id.len() > 64 {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
            "restoreId is required",
        ));
    }
    room_answer(
        state
            .rooms
            .history(
                &host,
                &grant,
                HistoryOp::Undo {
                    restore_id: p.restore_id,
                },
            )
            .await
            .map_err(ApiError::host)?,
    )?;
    state.history.saved(&grant.room);
    Ok(Json(json!({"undone": true})).into_response())
}
