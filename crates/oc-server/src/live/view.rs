// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Live block projections, snapshots and exports (LIVE-04, LIVE-05; docs/27 §2.2, §2.5).

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use oc_model::live::{Resolved, Snapshot};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    Access, LiveCfg, access, admit_open, derive, doc_json, embedded, err, no_access,
    parent_session, require_on,
};
use crate::SharedState;
use crate::grant::{Grant, Role};
use crate::hosts::HostConfig;
use crate::routes::ApiError;
use crate::util::{now_ms, rfc3339};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionQuery {
    #[serde(default)]
    ticket: String,
    #[serde(default)]
    file_id: String,
    /// A `blockRef`'s block in `fileId`; absent: the whole live file.
    #[serde(default)]
    block_id: Option<String>,
}

/// The read-only projection of a live file, or of one of its blocks, as `(document.json,
/// Markdown, rev)`. `None` when the block is gone.
fn project(source: &Value, block_id: Option<&str>) -> Option<(Value, String, String)> {
    let doc = match block_id {
        Some(b) => oc_model::live::block_document(source, b)?,
        None => {
            let mut d = json!({"type": "doc", "content": source["content"].clone()});
            for root in ["databases", "boards", "ext"] {
                if let Some(v) = source.get(root) {
                    d[root] = v.clone();
                }
            }
            d
        }
    };
    let md = oc_model::export::to_markdown(&doc);
    let rev = {
        let h = Sha256::digest(doc.to_string().as_bytes());
        h.iter().take(12).map(|b| format!("{b:02x}")).collect()
    };
    Some((doc, md, rev))
}

/// `GET /v1/live/projection?ticket&fileId[&blockId]` (LIVE-04): what a `liveBlock` that is not
/// connected, or a `blockRef`, shows: `{access, name, fileId, blockId, rev, doc, markdown}`.
/// `ETag` is the projection's rev; `If-None-Match` with it answers 304, so polling is cheap.
/// No access: 403 `LIVE_NO_ACCESS` and nothing else.
pub async fn projection(
    State(state): State<SharedState>,
    Query(q): Query<ProjectionQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (host, parent, _) = parent_session(&state, &q.ticket).await?;
    embedded(&state, &host, &parent, &q.file_id, q.block_id.as_deref()).await?;
    admit_open(&state, &host, &parent.user.id).await?;
    let Access::Granted {
        role,
        name,
        callback_token,
        ..
    } = access(&state, &host, &parent, &q.file_id).await?
    else {
        return Err(no_access());
    };
    let g = derive(&parent, None, &q.file_id, role, name, callback_token);
    let source = doc_json(&state, &host, &g).await?;
    let (doc, md, rev) = project(&source, q.block_id.as_deref()).ok_or_else(|| {
        err(
            StatusCode::NOT_FOUND,
            "BLOCK_NOT_FOUND",
            "the referenced block is gone",
        )
    })?;
    let etag = format!("\"{rev}\"");
    let fresh = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',')
                .any(|t| t.trim().trim_start_matches("W/") == etag)
        });
    let mut res = if fresh {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        Json(json!({
            "access": role, "name": g.file.name, "fileId": q.file_id, "blockId": q.block_id,
            "rev": rev, "doc": doc, "markdown": md,
            "live": oc_model::live::is_live_file(&source),
        }))
        .into_response()
    };
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(v) = HeaderValue::from_str(&etag) {
        h.insert(header::ETAG, v);
    }
    Ok(res)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshBody {
    #[serde(default)]
    ticket: String,
    #[serde(default)]
    block_id: String,
}

/// `POST /v1/live/refresh {ticket, blockId}` (LIVE-04/05): reads the source of the canvas's
/// `liveBlock` or `blockRef` `blockId` for this person and writes what the host's snapshot
/// policy keeps into the node: the title (not under `"none"`), and under `"content"` a
/// Markdown snapshot with its time. Needs the edit role on the canvas. Without access to the
/// source nothing is written: `{access: "none"}`.
pub async fn refresh(
    State(state): State<SharedState>,
    Json(b): Json<RefreshBody>,
) -> Result<Response, ApiError> {
    let (host, parent, _) = parent_session(&state, &b.ticket).await?;
    require_on(&host)?;
    if parent.role != Role::Edit {
        return Err(err(
            StatusCode::FORBIDDEN,
            "ROLE_FORBIDDEN",
            "refreshing a live block needs the edit role",
        ));
    }
    let doc = doc_json(&state, &host, &parent).await?;
    let node = find_node(&doc, &b.block_id).ok_or_else(|| {
        err(
            StatusCode::NOT_FOUND,
            "BLOCK_NOT_FOUND",
            "no live block or block reference with that blockId",
        )
    })?;
    let r = oc_model::live::references(&json!({"content": [node.clone()]}))
        .pop()
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "BAD_INPUT", "not a live block"))?;
    admit_open(&state, &host, &parent.user.id).await?;
    let a = access(&state, &host, &parent, &r.file_id).await?;
    let Access::Granted {
        role,
        name,
        callback_token,
        ..
    } = a
    else {
        return Ok(Json(json!({"access": "none"})).into_response());
    };
    let g = derive(
        &parent,
        None,
        &r.file_id,
        role,
        name.clone(),
        callback_token,
    );
    let source = doc_json(&state, &host, &g).await?;
    let projected = project(&source, r.ref_block_id.as_deref());
    let cfg = LiveCfg::of(&host);
    let mut node = node;
    let attrs = node["attrs"].as_object_mut().ok_or_else(|| {
        err(
            StatusCode::BAD_REQUEST,
            "BAD_INPUT",
            "the node has no attributes",
        )
    })?;
    let title = match cfg.snapshot {
        Snapshot::None => String::new(),
        _ => source["meta"]["title"]
            .as_str()
            .filter(|t| !t.trim().is_empty())
            .map(String::from)
            .or(name)
            .unwrap_or_else(|| r.title.clone()),
    };
    attrs.insert("title".into(), json!(title));
    if cfg.snapshot == Snapshot::Content
        && let Some((_, md, _)) = &projected
        && let Some(snap) = oc_model::live::snapshot_value(md)
    {
        attrs.insert("snapshot".into(), snap);
        attrs.insert("snapshotAt".into(), json!(rfc3339(now_ms())));
    } else {
        attrs.remove("snapshot");
        attrs.remove("snapshotAt");
    }
    let ops = vec![oc_model::patch::PatchOp::Replace {
        block_id: b.block_id.clone(),
        markdown: None,
        blocks: Some(vec![node]),
    }];
    match state
        .rooms
        .patch(&host, &parent, ops, &parent.user.id)
        .await
        .map_err(ApiError::host)?
    {
        Ok(_) => {}
        Err(e) => {
            return Err(err(
                StatusCode::UNPROCESSABLE_ENTITY,
                "PATCH_INVALID",
                &format!("{e:?}"),
            ));
        }
    }
    Ok(
        Json(json!({"access": role, "title": title, "rev": projected.map(|p| p.2)}))
            .into_response(),
    )
}

fn find_node(doc: &Value, block_id: &str) -> Option<Value> {
    fn walk(nodes: &[Value], id: &str, depth: usize) -> Option<Value> {
        if depth > 64 {
            return None;
        }
        for n in nodes {
            let ty = n["type"].as_str().unwrap_or_default();
            if oc_model::live::is_ref_node(ty) && n["attrs"]["blockId"].as_str() == Some(id) {
                return Some(n.clone());
            }
            if let Some(c) = n["content"].as_array()
                && let Some(hit) = walk(c, id, depth + 1)
            {
                return Some(hit);
            }
        }
        None
    }
    walk(doc["content"].as_array()?, block_id, 0)
}

/// Every reference in a canvas with this person's access to its source (LIVE-01 §2.4
/// `GET …/references`): `[{blockId, type, fileId, refBlockId?, kind?, access}]`. Sources that
/// cannot be checked count as `none`.
pub async fn references(
    state: &SharedState,
    host: &Arc<HostConfig>,
    who: &Grant,
    doc: &Value,
) -> Vec<Value> {
    let mut out = Vec::new();
    let mut seen: HashMap<String, &'static str> = HashMap::new();
    for r in oc_model::live::references(doc) {
        let a = match seen.get(&r.file_id) {
            Some(a) => *a,
            None => {
                let a = if host.live_blocks() {
                    access(state, host, who, &r.file_id)
                        .await
                        .map_or("none", |a| a.word())
                } else {
                    "none"
                };
                seen.insert(r.file_id.clone(), a);
                a
            }
        };
        let mut v =
            json!({"blockId": r.block_id, "type": r.node, "fileId": r.file_id, "access": a});
        if let Some(b) = r.ref_block_id {
            v["refBlockId"] = json!(b);
        }
        if let Some(k) = r.kind {
            v["kind"] = json!(k);
        }
        out.push(v);
    }
    out
}

/// LIVE-05 (docs/27 §2.2 "Export"): the live files an export may show, loaded for the
/// exporting person. [`LiveExport::apply`] then rewrites every reference into ordinary blocks:
/// readable content inlined after "Live block: <title>" (a link with `[host.live] link`), the
/// rest a placeholder (or the node's snapshot, which exists only under policy `"content"`).
/// With the feature off nothing is loaded and references show their caption.
pub struct LiveExport {
    docs: HashMap<String, Option<Value>>,
    on: bool,
    cfg: LiveCfg,
}

impl LiveExport {
    pub async fn load(
        state: &SharedState,
        host: &Arc<HostConfig>,
        who: &Grant,
        json: &Value,
    ) -> Self {
        let on = host.live_blocks();
        let mut docs: HashMap<String, Option<Value>> = HashMap::new();
        if on && who.live.parent.is_none() {
            for r in oc_model::live::references(json) {
                if docs.contains_key(&r.file_id) || r.file_id.is_empty() || r.file_id == who.file.id
                {
                    continue;
                }
                let d = match access(state, host, who, &r.file_id).await {
                    Ok(Access::Granted {
                        role,
                        name,
                        callback_token,
                        ..
                    }) => {
                        let g = derive(who, None, &r.file_id, role, name, callback_token);
                        doc_json(state, host, &g).await.ok()
                    }
                    _ => None,
                };
                docs.insert(r.file_id.clone(), d);
            }
        }
        Self {
            docs,
            on,
            cfg: LiveCfg::of(host),
        }
    }

    /// Rewrites the references of `json` (see [`LiveExport`]).
    pub fn apply(&self, json: &mut Value) {
        oc_model::live::rewrite_for_export(
            json,
            &|r| {
                if !self.on {
                    return None;
                }
                Some(match self.docs.get(&r.file_id).cloned().flatten() {
                    Some(d) => match &r.ref_block_id {
                        Some(b) => match oc_model::live::block_document(&d, b) {
                            Some(bd) => Resolved::Content(bd),
                            None => Resolved::NoAccess,
                        },
                        None => Resolved::Content(d),
                    },
                    None => Resolved::NoAccess,
                })
            },
            &|f| self.cfg.link(f),
        );
    }
}
