// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Portable live blocks, server side (docs/27 §2, ADR-039, ADR-063..066).
//!
//! - **Host contract (LIVE-01).** `[host.flags] live_blocks` turns the feature on; `[host.live]`
//!   sets the snapshot policy ([`LiveCfg`]). The host creates a live block's backing file
//!   (`POST {callback_base}/files`) and decides access to it (`POST /access`, required; without
//!   it only files in the launch token's `live` claim open, read-only). A session that meets a
//!   live block asks for a **derived grant** (`POST /v1/live/session`): role = the host's
//!   answer, perms ∩ the parent session's, expiry = the parent's, never another derived grant.
//! - **Rooms (LIVE-02).** A derived grant is an ordinary session of the live file's own room,
//!   so cluster ownership, WAL, autosave, the role filter and revocation apply unchanged. At
//!   most [`LiveCfg::max_open`] (8) are connected per parent session ([`OpenSlots`]).
//! - **Projections (LIVE-04).** `GET /v1/live/projection`: the read-only view of a live file or
//!   of one block (`blockRef`), with an ETag for cheap refreshes; `POST /v1/live/refresh`
//!   writes the title and, when the policy allows, a snapshot into the embedding canvas.
//! - **Exports (LIVE-05).** [`resolve_for_export`] inlines what the exporting person can read.
//!
//! Nothing of a live file is stored by OpenCanvas: the host keeps it like any other file.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::bail;
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use oc_model::live::{Ref, Snapshot};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::SharedState;
use crate::grant::{FileRef, Grant, LiveParent, Role, room_id};
use crate::hosts::HostConfig;
use crate::routes::ApiError;
use crate::util::now_ms;

mod view;
pub use view::{LiveExport, projection, references, refresh};

/// Most live block rooms one session may have connected at once (docs/27 §2.2).
pub const MAX_OPEN: usize = 8;

/// `[host.live]` (docs/05 §2c).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveCfg {
    /// `snapshot = "none" | "title" | "content"` (default `"title"`, docs/27 §9 decision 1).
    pub snapshot: Snapshot,
    /// `link = "https://…/{fileId}"`: where exports link a live block's source. http(s) only.
    pub link: Option<String>,
    /// `max_open` (1-8, default 8): live block rooms one session may have connected.
    pub max_open: usize,
}

impl Default for LiveCfg {
    fn default() -> Self {
        Self {
            snapshot: Snapshot::Title,
            link: None,
            max_open: MAX_OPEN,
        }
    }
}

impl LiveCfg {
    /// Parses `[host.live]`; unknown keys and bad values are errors (refused at start-up).
    pub fn parse(t: &toml::Table) -> anyhow::Result<Self> {
        let mut c = Self::default();
        for (k, v) in t {
            match k.as_str() {
                "snapshot" => {
                    c.snapshot = v.as_str().and_then(Snapshot::parse).ok_or_else(|| {
                        anyhow::anyhow!(
                            "[host.live] snapshot takes \"none\", \"title\" or \"content\""
                        )
                    })?;
                }
                "link" => {
                    let s = v.as_str().unwrap_or_default();
                    if !(s.starts_with("https://") || s.starts_with("http://"))
                        || !s.contains("{fileId}")
                    {
                        bail!("[host.live] link must be an http(s) URL with {{fileId}}");
                    }
                    c.link = Some(s.to_string());
                }
                "max_open" => {
                    c.max_open = v
                        .as_integer()
                        .filter(|n| (1..=MAX_OPEN as i64).contains(n))
                        .ok_or_else(|| anyhow::anyhow!("[host.live] max_open takes 1-{MAX_OPEN}"))?
                        as usize;
                }
                other => bail!("[host.live] has no key {other:?} (snapshot, link, max_open)"),
            }
        }
        Ok(c)
    }

    /// The host's settings (checked at start-up, so defaults only for hosts built in code).
    pub fn of(host: &HostConfig) -> Self {
        Self::parse(&host.live).unwrap_or_default()
    }

    /// The source link for exports, `{fileId}` replaced (percent-encoded).
    pub fn link(&self, file_id: &str) -> Option<String> {
        self.link
            .as_ref()
            .map(|t| t.replace("{fileId}", &crate::host_client::percent_encode(file_id)))
    }
}

/// Start-up check of a host's live block settings (LIVE-01): `[host.live]` parses, the flag is
/// a boolean, and a host that turns the feature on can answer the callbacks it needs (JWT
/// callbacks: `POST /files` and `POST /access`; not WOPI-only, not temporary canvases).
pub fn check_host(h: &HostConfig) -> anyhow::Result<()> {
    if h.flags
        .get("live_blocks")
        .is_some_and(|v| v.as_bool().is_none())
    {
        bail!("[host.flags] live_blocks takes true or false");
    }
    LiveCfg::parse(&h.live)?;
    if h.live_blocks() {
        if h.wopi_only() {
            bail!(
                "[host.flags] live_blocks needs JWT callbacks (POST /access, POST /files); mode = \"wopi\" has none"
            );
        }
        if h.ephemeral() {
            bail!("[host.flags] live_blocks needs host storage (live blocks are host files)");
        }
        if h.callback_base.is_empty() {
            bail!("[host.flags] live_blocks needs callback_base (POST /access, POST /files)");
        }
    }
    Ok(())
}

/// A ticket's key for counting (a hash: tickets are bearer secrets and never stored twice).
pub fn session_key(ticket: &str) -> String {
    let d = Sha256::digest(ticket.as_bytes());
    d.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// Connected live block rooms per parent session (LIVE-02). Per node: a tab's sockets for one
/// canvas normally reach one node; the editor opens rooms lazily and closes them out of view.
#[derive(Default)]
pub struct OpenSlots(Mutex<HashMap<String, usize>>);

/// One connected live block room; frees its slot when dropped.
pub struct Slot {
    slots: Arc<OpenSlots>,
    key: String,
}

impl OpenSlots {
    /// Takes a slot for `key` when fewer than `max` are taken.
    pub fn take(self: &Arc<Self>, key: &str, max: usize) -> Option<Slot> {
        let mut m = self.0.lock().expect("live slots");
        let n = m.entry(key.to_string()).or_insert(0);
        if *n >= max {
            return None;
        }
        *n += 1;
        Some(Slot {
            slots: self.clone(),
            key: key.to_string(),
        })
    }

    /// Slots taken for `key`.
    pub fn taken(&self, key: &str) -> usize {
        self.0
            .lock()
            .expect("live slots")
            .get(key)
            .copied()
            .unwrap_or(0)
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut m = self.slots.0.lock().expect("live slots");
        if let Some(n) = m.get_mut(&self.key) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                m.remove(&self.key);
            }
        }
    }
}

/// What the host says one person may do with a live file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Access {
    Granted {
        role: Role,
        name: Option<String>,
        callback_token: Option<String>,
    },
    Denied,
}

impl Access {
    pub fn word(&self) -> &'static str {
        match self {
            Access::Granted { role, .. } => role.as_str(),
            Access::Denied => "none",
        }
    }
}

fn err(status: StatusCode, code: &'static str, msg: &str) -> ApiError {
    ApiError::new(status, code, msg)
}

fn no_access() -> ApiError {
    // No title, no content: nothing about a file the person cannot open (docs/27 §2.2).
    err(
        StatusCode::FORBIDDEN,
        "LIVE_NO_ACCESS",
        "no access to this live block",
    )
}

/// The feature flag (404 when off: the routes do not exist for this host).
pub fn require_on(host: &HostConfig) -> Result<(), ApiError> {
    if host.live_blocks() {
        Ok(())
    } else {
        Err(err(
            StatusCode::NOT_FOUND,
            "LIVE_OFF",
            "live blocks are off for this host ([host.flags] live_blocks)",
        ))
    }
}

fn check_file_id(file_id: &str) -> Result<(), ApiError> {
    if file_id.is_empty() || file_id.len() > 1024 {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "BAD_INPUT",
            "fileId must be 1-1024 bytes",
        ));
    }
    Ok(())
}

/// The host's answer for `who.user` on `file_id` (LIVE-01): `POST /access` (cached 30 s);
/// without that callback, the launch token's `live` claim, read-only. A person the role API
/// revoked on that file's room has no access whatever the cache says.
pub async fn access(
    state: &SharedState,
    host: &HostConfig,
    who: &Grant,
    file_id: &str,
) -> Result<Access, ApiError> {
    let room = room_id(&host.id, file_id);
    if state
        .members
        .without_revoked(&room, vec![who.user.clone()])
        .is_empty()
    {
        return Ok(Access::Denied);
    }
    match state.host.access_detail(host, file_id, &who.user.id).await {
        Ok(Some(d)) => Ok(match d.role {
            Some(role) => Access::Granted {
                role,
                name: d.name,
                callback_token: d.callback_token,
            },
            None => Access::Denied,
        }),
        // `/access` is required for live blocks; without it, only files the token lists open,
        // and only read-only (docs/27 §2.2).
        Ok(None) => Ok(if who.live.claims.iter().any(|c| c.file_id == file_id) {
            Access::Granted {
                role: Role::View,
                name: None,
                callback_token: None,
            }
        } else {
            Access::Denied
        }),
        Err(e) => Err(ApiError::host(e)),
    }
}

/// A derived grant for a live file (LIVE-01, docs/27 §2.5): the host's role; perms ∩ the
/// parent's (never `live`: a live file holds no live blocks); the parent's user; the host's
/// callback token for that file when it gave one, else the parent's.
pub fn derive(
    parent: &Grant,
    parent_ticket: Option<&str>,
    file_id: &str,
    role: Role,
    name: Option<String>,
    callback_token: Option<String>,
) -> Grant {
    let mut perms = parent.perms.clone();
    perms.live = false;
    perms.comment = perms.comment && role != Role::View;
    Grant {
        host_id: parent.host_id.clone(),
        room: room_id(&parent.host_id, file_id),
        role,
        user: parent.user.clone(),
        file: FileRef {
            id: file_id.to_string(),
            name: name.unwrap_or_else(|| file_id.to_string()),
            version: None,
        },
        perms,
        callback_token: callback_token.unwrap_or_else(|| parent.callback_token.clone()),
        members: vec![],
        wopi_history: None,
        ext_blocks: false,
        live: crate::grant::LiveGrant {
            claims: vec![],
            parent: Some(LiveParent {
                file_id: parent.file.id.clone(),
                session: parent_ticket.map(session_key).unwrap_or_default(),
                title: parent.file.name.clone(),
            }),
            caps: false,
        },
    }
}

/// The document a grant opens, as `document.json` (the room's state; the room opens when needed).
pub async fn doc_json(
    state: &SharedState,
    host: &Arc<HostConfig>,
    grant: &Grant,
) -> Result<Value, ApiError> {
    let bytes = state
        .rooms
        .state(host, grant)
        .await
        .map_err(ApiError::host)?;
    let doc = oc_model::new_doc();
    oc_model::ocanvas::apply_update_bytes(&doc, &bytes).map_err(ApiError::internal)?;
    Ok(oc_model::doc_to_json(&doc))
}

/// A session ticket's grant and expiry.
async fn parent_session(
    state: &SharedState,
    ticket: &str,
) -> Result<(Arc<HostConfig>, Grant, i64), ApiError> {
    let (host, grant) = crate::routes::session(state, ticket).await?;
    let exp = state
        .store
        .session(ticket)
        .await
        .map_err(ApiError::internal)?
        .map_or(0, |(_, e)| e);
    Ok((host, grant, exp))
}

/// Rate limit on opening live files per person (docs/27 §2.5 "per-user room-open rate limits").
async fn admit_open(state: &SharedState, host: &HostConfig, user: &str) -> Result<(), ApiError> {
    let policy = crate::ratelimit::Policy {
        name: "live-open",
        rate: 2.0,
        burst: 60.0,
    };
    let d = state
        .limiter
        .check(&format!("live:{}:{user}", host.id), policy)
        .await;
    if d.ok {
        Ok(())
    } else {
        Err(err(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "too many live blocks opened; retry shortly",
        ))
    }
}

/// The parent session's checks shared by every live route: feature on, not itself a live
/// file's session (the depth rule), and the canvas really embeds `file_id` (the node that
/// names it), so a ticket cannot be used to open arbitrary files.
async fn embedded(
    state: &SharedState,
    host: &Arc<HostConfig>,
    parent: &Grant,
    file_id: &str,
    ref_block: Option<&str>,
) -> Result<Ref, ApiError> {
    require_on(host)?;
    check_file_id(file_id)?;
    if parent.live.parent.is_some() {
        return Err(err(
            StatusCode::FORBIDDEN,
            "LIVE_DEPTH",
            "a live file holds no live blocks",
        ));
    }
    let doc = doc_json(state, host, parent).await?;
    oc_model::live::references(&doc)
        .into_iter()
        .find(|r| {
            r.file_id == file_id
                && match ref_block {
                    None => r.node == oc_model::live::LIVE_BLOCK,
                    Some(b) => {
                        r.node == oc_model::live::BLOCK_REF && r.ref_block_id.as_deref() == Some(b)
                    }
                }
        })
        .ok_or_else(|| {
            err(
                StatusCode::NOT_FOUND,
                "LIVE_NOT_EMBEDDED",
                "this canvas does not embed that live block",
            )
        })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBody {
    #[serde(default)]
    ticket: String,
    #[serde(default)]
    file_id: String,
}

/// `POST /v1/live/session {ticket, fileId}` (LIVE-01/02): a derived session for a live block
/// the canvas embeds: `{ticket, room, fileId, role, name, exp, wsUrl}`. The editor connects
/// to `wsUrl/<room>?ticket=…&caps=ext,live` like any canvas, lazily, at most 8 at once.
pub async fn open_session(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(b): Json<SessionBody>,
) -> Result<Response, ApiError> {
    let (host, parent, exp) = parent_session(&state, &b.ticket).await?;
    embedded(&state, &host, &parent, &b.file_id, None).await?;
    if b.file_id == parent.file.id {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "BAD_INPUT",
            "a canvas cannot embed itself",
        ));
    }
    admit_open(&state, &host, &parent.user.id).await?;
    let Access::Granted {
        role,
        name,
        callback_token,
    } = access(&state, &host, &parent, &b.file_id).await?
    else {
        return Err(no_access());
    };
    let grant = derive(
        &parent,
        Some(&b.ticket),
        &b.file_id,
        role,
        name,
        callback_token,
    );
    let ticket = ulid::Ulid::new().to_string();
    state
        .store
        .insert_session(&ticket, &grant, exp, now_ms())
        .await
        .map_err(ApiError::internal)?;
    state
        .tickets
        .lock()
        .expect("tickets lock")
        .entry(ticket.clone())
        .or_insert(crate::TicketUse {
            first_seen: std::time::Instant::now(),
            connected: false,
        });
    tracing::info!(host = %host.id, room = %grant.room, role = role.as_str(), "live block session");
    let body = json!({
        "ticket": ticket,
        "room": grant.room,
        "fileId": b.file_id,
        "role": role,
        "name": grant.file.name,
        "exp": exp,
        "wsUrl": crate::routes::ws_url_of(&state, &headers),
        "maxOpen": LiveCfg::of(&host).max_open,
    });
    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(body),
    )
        .into_response())
}

/// The blocks "Make live" moves, checked: top-level blocks of the canvas, none a reference or
/// an SDK block (their data would need moving too), in document order.
fn picked_blocks(doc: &Value, ids: &[String]) -> Result<Vec<Value>, ApiError> {
    let bad = |m: &str| err(StatusCode::BAD_REQUEST, "BAD_INPUT", m);
    if ids.is_empty() || ids.len() > 500 {
        return Err(bad("blockIds must list 1-500 blocks"));
    }
    let top = doc["content"].as_array().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for n in top {
        let Some(id) = n["attrs"]["blockId"].as_str() else {
            continue;
        };
        if !ids.iter().any(|x| x == id) {
            continue;
        }
        let s = n.to_string();
        if s.contains("\"type\":\"liveBlock\"") || s.contains("\"type\":\"blockRef\"") {
            return Err(bad("a live file holds no live blocks or references"));
        }
        if s.contains("\"type\":\"extBlock\"") {
            return Err(bad("SDK blocks cannot be made live yet"));
        }
        out.push(n);
    }
    if out.len() != ids.len() {
        return Err(err(
            StatusCode::NOT_FOUND,
            "BLOCK_NOT_FOUND",
            "every blockId must be a top-level block of this canvas",
        ));
    }
    Ok(out)
}

/// The live file's first document: the picked blocks, the databases and boards they show, and
/// `meta {kind: "live", title}`.
fn live_document(source: &Value, blocks: &[Value], name: &str) -> Value {
    let mut dbs = serde_json::Map::new();
    let mut boards = serde_json::Map::new();
    let s = Value::Array(blocks.to_vec()).to_string();
    if let Some(all) = source["databases"].as_object() {
        for (k, v) in all {
            if s.contains(&format!("\"dbId\":{}", json!(k))) {
                dbs.insert(k.clone(), v.clone());
            }
        }
    }
    if let Some(all) = source["boards"].as_object() {
        for (k, v) in all {
            if s.contains(&format!("\"boardId\":{}", json!(k))) {
                boards.insert(k.clone(), v.clone());
            }
        }
    }
    json!({
        "type": "doc",
        "content": blocks,
        "meta": {"kind": "live", "title": name},
        "databases": dbs,
        "boards": boards,
    })
}

/// "Make live" checks before the host is asked to create anything: the edit role on the
/// canvas, the canvas not itself a live file (the depth rule), and blocks that may move.
pub async fn precheck(
    state: &SharedState,
    host: &Arc<HostConfig>,
    grant_a: &Grant,
    block_ids: &[String],
) -> Result<(), ApiError> {
    if grant_a.role != Role::Edit {
        return Err(err(
            StatusCode::FORBIDDEN,
            "ROLE_FORBIDDEN",
            "making a live block needs the edit role on the canvas",
        ));
    }
    let source = doc_json(state, host, grant_a).await?;
    if oc_model::live::is_live_file(&source) {
        return Err(err(
            StatusCode::FORBIDDEN,
            "LIVE_DEPTH",
            "a live file holds no live blocks",
        ));
    }
    picked_blocks(&source, block_ids).map(|_| ())
}

/// "Make live" (LIVE-01, docs/27 §2.2), after the host created `live_file`: writes the picked
/// blocks into the live file (one edit), saves it through the commit path, then replaces them
/// in the canvas with one `liveBlock` (one edit). `grant_a` must be an editor of the canvas,
/// `grant_l` of the live file. Returns `{liveFileId, blockId}`.
pub async fn make_live(
    state: &SharedState,
    host: &Arc<HostConfig>,
    grant_a: &Grant,
    grant_l: &Grant,
    block_ids: &[String],
    name: &str,
    origin: &str,
) -> Result<Value, ApiError> {
    use crate::ai::tools::{CanvasTools, LiveTools, ToolCtx, WriteMode};
    if grant_a.role != Role::Edit || grant_l.role != Role::Edit {
        return Err(err(
            StatusCode::FORBIDDEN,
            "ROLE_FORBIDDEN",
            "making a live block needs the edit role on the canvas and on the new file",
        ));
    }
    let source = doc_json(state, host, grant_a).await?;
    if oc_model::live::is_live_file(&source) {
        return Err(err(
            StatusCode::FORBIDDEN,
            "LIVE_DEPTH",
            "a live file holds no live blocks",
        ));
    }
    let blocks = picked_blocks(&source, block_ids)?;
    let kind = match blocks.as_slice() {
        [b] if b["type"] == "database" => "database",
        [b] if b["type"] == "board" => "board",
        _ => "blocks",
    };
    let tools = LiveTools::new(state.clone());
    let ctx = |g: &Grant| ToolCtx {
        host_id: host.id.clone(),
        file_id: g.file.id.clone(),
        user: g.clone(),
        origin: origin.to_string(),
        mode_default: WriteMode::Direct,
    };
    let live_doc = live_document(&source, &blocks, name);
    tools
        .live_init(&ctx(grant_l), json!({"doc": live_doc}))
        .await
        .map_err(tool_err)?;
    match state.rooms.commit(host, grant_l).await {
        Ok(crate::room::CommitResult::Saved { .. } | crate::room::CommitResult::Clean { .. }) => {}
        Ok(other) => {
            tracing::warn!(host = %host.id, result = ?other, "live file not saved yet; it stays queued");
        }
        Err(e) => return Err(ApiError::host(e)),
    }
    let cfg = LiveCfg::of(host);
    let block_id = format!("b_{}", ulid::Ulid::new().to_string().to_lowercase());
    let title = if cfg.snapshot == Snapshot::None {
        ""
    } else {
        name
    };
    let node = json!({"type": "liveBlock", "attrs": {
        "blockId": block_id, "fileId": grant_l.file.id, "hostId": host.id, "kind": kind, "title": title,
    }});
    let mut ops = vec![json!({"op": "replace", "blockId": block_ids[0], "blocks": [node]})];
    for id in &block_ids[1..] {
        ops.push(json!({"op": "delete", "blockId": id}));
    }
    tools
        .call(
            &ctx(grant_a),
            "canvas_patch",
            json!({"ops": ops, "mode": "direct", "confirm": true}),
        )
        .await
        .map_err(tool_err)?;
    tracing::info!(host = %host.id, room = %grant_a.room, live = %grant_l.room, blocks = block_ids.len(), "made live");
    Ok(json!({"liveFileId": grant_l.file.id, "blockId": block_id, "kind": kind}))
}

fn tool_err(e: crate::ai::tools::ToolError) -> ApiError {
    use crate::ai::tools::ToolError as T;
    match e {
        T::Forbidden(m) => ApiError::new(StatusCode::FORBIDDEN, "ROLE_FORBIDDEN", m),
        T::BadInput(m) => ApiError::new(StatusCode::BAD_REQUEST, "BAD_INPUT", m),
        T::NotFound(m) => ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", m),
        T::Unavailable(m) => ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "UNAVAILABLE", m),
        other => ApiError::internal(format!("{other:?}")),
    }
}

/// Asks the host to create the live file (`POST {callback_base}/files`). 501 when the host
/// does not implement it ("Make live" is then hidden, docs/27 §9 decision 2).
pub async fn create_file(
    state: &SharedState,
    host: &HostConfig,
    token: &str,
    name: &str,
    parent_file_id: &str,
    idempotency_key: &str,
) -> Result<String, ApiError> {
    match state
        .host
        .create_file(host, token, name, parent_file_id, idempotency_key)
        .await
    {
        Ok(Some(id)) => Ok(id),
        Ok(None) => Err(err(
            StatusCode::NOT_IMPLEMENTED,
            "LIVE_CREATE_UNSUPPORTED",
            "the host does not create files (POST /files)",
        )),
        Err(e) => Err(ApiError::host(e)),
    }
}

/// A live file's name: trimmed, 1-200 characters.
pub fn clean_name(name: &str) -> Result<String, ApiError> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 200 {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "BAD_INPUT",
            "name must be 1-200 characters",
        ));
    }
    Ok(n.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MakeBody {
    #[serde(default)]
    ticket: String,
    #[serde(default)]
    block_ids: Vec<String>,
    #[serde(default)]
    name: String,
}

/// `POST /v1/live/make {ticket, blockIds, name}` (LIVE-01): "Make live" for the editor. Needs
/// the edit role and `perms.live`; the host creates the file and must give this person edit
/// on it. `201 {liveFileId, blockId, kind}`.
pub async fn make(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(b): Json<MakeBody>,
) -> Result<Response, ApiError> {
    let (host, parent, _) = parent_session(&state, &b.ticket).await?;
    require_on(&host)?;
    if parent.live.parent.is_some() {
        return Err(err(
            StatusCode::FORBIDDEN,
            "LIVE_DEPTH",
            "a live file holds no live blocks",
        ));
    }
    if !parent.perms.live || parent.role != Role::Edit {
        return Err(err(
            StatusCode::FORBIDDEN,
            "ROLE_FORBIDDEN",
            "making a live block needs the edit role and perms.live",
        ));
    }
    let name = clean_name(&b.name)?;
    admit_open(&state, &host, &parent.user.id).await?;
    precheck(&state, &host, &parent, &b.block_ids).await?;
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .filter(|k| !k.is_empty() && k.len() <= 255)
        .map(String::from)
        .unwrap_or_else(|| ulid::Ulid::new().to_string());
    let file = create_file(
        &state,
        &host,
        &parent.callback_token,
        &name,
        &parent.file.id,
        &key,
    )
    .await?;
    let Access::Granted {
        role,
        name: _,
        callback_token,
    } = access(&state, &host, &parent, &file).await?
    else {
        return Err(no_access());
    };
    let gl = derive(
        &parent,
        Some(&b.ticket),
        &file,
        role,
        Some(name.clone()),
        callback_token,
    );
    let out = make_live(
        &state,
        &host,
        &parent,
        &gl,
        &b.block_ids,
        &name,
        &format!("user:{}", parent.user.id),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(out)).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_parses_and_refuses_bad_values() {
        let t = |s: &str| -> toml::Table { toml::from_str(s).unwrap() };
        assert_eq!(LiveCfg::parse(&t("")).unwrap(), LiveCfg::default());
        let c = LiveCfg::parse(&t(
            "snapshot = \"content\"\nlink = \"https://h/f/{fileId}\"\nmax_open = 3",
        ))
        .unwrap();
        assert_eq!(c.snapshot, Snapshot::Content);
        assert_eq!(c.max_open, 3);
        assert_eq!(c.link("a b").as_deref(), Some("https://h/f/a%20b"));
        for bad in [
            "snapshot = \"all\"",
            "link = \"javascript:{fileId}\"",
            "link = \"https://h/f\"",
            "max_open = 9",
            "max_open = 0",
            "nope = 1",
        ] {
            assert!(LiveCfg::parse(&t(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn slots_cap_open_rooms_per_session_and_free_on_drop() {
        let s = Arc::new(OpenSlots::default());
        let held: Vec<Slot> = (0..3).filter_map(|_| s.take("k", 3)).collect();
        assert_eq!(held.len(), 3);
        assert!(s.take("k", 3).is_none());
        assert!(s.take("other", 3).is_some());
        drop(held);
        assert_eq!(s.taken("k"), 0);
        assert!(s.take("k", 3).is_some());
    }

    #[test]
    fn derived_grants_are_never_wider_than_the_parent() {
        let parent = Grant {
            host_id: "h".into(),
            room: room_id("h", "a"),
            role: Role::View,
            user: crate::grant::User {
                id: "u".into(),
                name: "U".into(),
                color: "#123456".into(),
                ..Default::default()
            },
            file: FileRef {
                id: "a".into(),
                name: "A".into(),
                version: None,
            },
            perms: crate::grant::Perms {
                export: false,
                download: false,
                comment: false,
                print: false,
                history: Some(false),
                restore: false,
                commit_message: false,
                live: true,
            },
            callback_token: "cb".into(),
            members: vec![],
            wopi_history: None,
            ext_blocks: true,
            live: Default::default(),
        };
        let g = derive(&parent, Some("t"), "L", Role::Edit, None, None);
        assert_eq!(g.role, Role::Edit, "the host's answer for the live file");
        assert_eq!(g.room, room_id("h", "L"));
        assert!(!g.perms.export && !g.perms.download && !g.perms.print && !g.perms.live);
        assert!(!g.can_see_history());
        assert_eq!(g.callback_token, "cb");
        assert_eq!(g.live.parent.as_ref().unwrap().file_id, "a");
        assert!(!g.ext_blocks, "caps come from the connection");
        let g = derive(
            &parent,
            None,
            "L",
            Role::View,
            Some("Name".into()),
            Some("t2".into()),
        );
        assert_eq!(g.callback_token, "t2");
        assert_eq!(g.file.name, "Name");
    }
}
