// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Backlinks and the link index (LINK-02/03, ADR-081, docs/38 §2.3-2.5):
//!
//! - `GET /api/v1/files/{fileId}/backlinks?block=&kind=&cursor=&limit=`: "Linked from" for a
//!   **user** token, filtered through the host's ACL ([`crate::links`]); MCP `canvas_backlinks`
//!   answers the same.
//! - `DELETE /api/v1/links/files/{fileId}` (host key): drop a deleted source's rows at once.
//! - `POST /api/v1/links/index {fileIds}` (host key, at most 100): backfill from the host's
//!   files; each document is read, its links written, and the document dropped.
//! - Editor: `GET /v1/backlinks?ticket=&block=&kind=&cursor=` and
//!   `GET /v1/backlinks/mentions?ticket=&names=` (unlinked mentions).

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use super::problem::Problem;
use super::{Answer, caller, check_file};
use crate::SharedState;
use crate::authz::{Principal, Via};
use crate::host_client::Fetched;
use crate::links::{LinkError, Query as LinkQuery, Reader};

/// Files per backfill call.
pub const MAX_BACKFILL: usize = 100;

impl From<LinkError> for Problem {
    fn from(e: LinkError) -> Self {
        match e {
            LinkError::Off => Problem::not_found(
                "LINKS_OFF",
                "links are not enabled for this host ([host.flags] links) or the storage has no link index",
            ),
            LinkError::Forbidden => Problem::new(
                StatusCode::FORBIDDEN,
                "ROLE_FORBIDDEN",
                "no access to this file",
            ),
            LinkError::Gone => Problem::new(StatusCode::GONE, "FILE_GONE", "the file was deleted"),
            LinkError::BadInput(m) => Problem::bad_request("BAD_INPUT", m),
            LinkError::RateLimited(after) => Problem::new(
                StatusCode::TOO_MANY_REQUESTS,
                "RATE_LIMITED",
                "too many backlink reads; retry shortly",
            )
            .header(header::RETRY_AFTER, &after.to_string()),
            LinkError::Host(m) => Problem::new(StatusCode::BAD_GATEWAY, "HOST_ERROR", m),
            LinkError::Internal(m) => {
                Problem::new(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", m)
            }
        }
    }
}

#[derive(Deserialize, Default)]
pub struct BacklinksQ {
    pub block: Option<String>,
    pub kind: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

fn link_query(q: BacklinksQ) -> Result<LinkQuery, LinkError> {
    let kind = match q.kind.as_deref() {
        None | Some("") | Some("all") => None,
        Some(k) => Some(
            oc_model::links::Kind::parse(k)
                .ok_or(LinkError::BadInput("kind is link, embed, relation or all"))?,
        ),
    };
    if q.block
        .as_ref()
        .is_some_and(|b| b.len() > oc_model::links::MAX_BLOCK_ID)
    {
        return Err(LinkError::BadInput("block is at most 128 bytes"));
    }
    Ok(LinkQuery {
        block: q.block.filter(|b| !b.is_empty()),
        kind,
        cursor: q.cursor,
        limit: q.limit,
        excerpts: true,
    })
}

/// The backlinks shared by the API and MCP: a user token, view on the target, then
/// [`crate::links::backlinks`].
pub async fn api_backlinks(
    state: &SharedState,
    p: &Principal,
    file_id: &str,
    q: BacklinksQ,
) -> Result<Value, Problem> {
    if p.via == Via::HostKey {
        return Err(Problem::bad_request(
            "USER_TOKEN_REQUIRED",
            "backlinks need a user token: what a person may see depends on who they are",
        ));
    }
    check_file(file_id)?;
    crate::links::admit(state, &p.host, &p.sub).await?;
    let reader = Reader {
        user_id: &p.sub,
        token: &p.callback_token,
        files: p.files.as_deref(),
    };
    let target = crate::links::target_access(state, &p.host, reader, file_id).await?;
    let title = target.name.unwrap_or_else(|| file_id.to_string());
    let q = link_query(q)?;
    Ok(crate::links::backlinks(state, &p.host, reader, file_id, &title, q).await?)
}

/// `GET /api/v1/files/{fileId}/backlinks`.
pub async fn backlinks(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    Query(q): Query<BacklinksQ>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    let v = api_backlinks(&state, &p, &file_id, q).await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(v)).into_response())
}

fn host_key_only(p: &Principal) -> Result<(), Problem> {
    if p.via != Via::HostKey {
        return Err(Problem::new(
            StatusCode::FORBIDDEN,
            "HOST_KEY_REQUIRED",
            "this operation needs the host key",
        ));
    }
    Ok(())
}

fn links_on(state: &SharedState, p: &Principal) -> Result<(), Problem> {
    if !crate::links::LinksCfg::of(&p.host).on || !state.store.links_supported() {
        return Err(LinkError::Off.into());
    }
    Ok(())
}

/// `DELETE /api/v1/links/files/{fileId}` (host key): the file was deleted at the host; its
/// outgoing links go now. Links *to* it stay until their sources are saved again (they show
/// as "Deleted canvas").
pub async fn delete_file(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    host_key_only(&p)?;
    links_on(&state, &p)?;
    check_file(&file_id)?;
    let n = state
        .store
        .links_delete_src(&p.host.id, &file_id)
        .await
        .map_err(|e| Problem::new(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", e.to_string()))?;
    Ok(Json(json!({"fileId": file_id, "removed": n})).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexBody {
    file_ids: Vec<String>,
}

/// `POST /api/v1/links/index {fileIds}` (host key): loads each file through the host (with
/// the host key's callback bearer), writes its links and drops the document.
pub async fn index_files(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Answer {
    let p = caller(&state, &headers).await?;
    host_key_only(&p)?;
    links_on(&state, &p)?;
    let b: IndexBody = serde_json::from_slice(&body)
        .map_err(|e| Problem::bad_request("BAD_INPUT", format!("body: {e}")))?;
    if b.file_ids.is_empty() || b.file_ids.len() > MAX_BACKFILL {
        return Err(Problem::bad_request(
            "BAD_INPUT",
            "fileIds takes 1-100 file ids",
        ));
    }
    let patterns = crate::links::LinksCfg::of(&p.host).patterns;
    let mut indexed = vec![];
    let mut failed = vec![];
    for f in &b.file_ids {
        check_file(f)?;
        let got = state.host.get_file(&p.host, &p.callback_token, f).await;
        let bytes = match got {
            Ok(Fetched::Found { bytes, .. }) => bytes,
            Ok(Fetched::Missing) => {
                failed.push(json!({"fileId": f, "code": "not_found"}));
                continue;
            }
            Err(_) => {
                failed.push(json!({"fileId": f, "code": "host_error"}));
                continue;
            }
        };
        let pats = patterns.clone();
        let extracted = tokio::task::spawn_blocking(move || {
            if !oc_model::ocanvas::is_zip(&bytes) {
                return None;
            }
            let l = oc_model::ocanvas::read_ocanvas(&bytes).ok()?;
            Some(oc_model::links::extract(
                &oc_model::doc_to_json(&l.doc),
                &pats,
            ))
        })
        .await
        .ok()
        .flatten();
        let Some(e) = extracted else {
            failed.push(json!({"fileId": f, "code": "not_ocanvas"}));
            continue;
        };
        crate::links::index_saved(
            &state.store,
            &state.metrics,
            &p.host.id,
            f,
            &e,
            crate::util::now_ms(),
        )
        .await;
        indexed.push(json!({"fileId": f, "links": e.edges.len(), "dropped": e.dropped}));
    }
    Ok(Json(json!({"indexed": indexed, "failed": failed})).into_response())
}

fn editor_answer(r: Result<Value, LinkError>) -> Response {
    match r {
        Ok(v) => ([(header::CACHE_CONTROL, "no-store")], Json(v)).into_response(),
        Err(e) => Problem::from(e).into_response(),
    }
}

#[derive(Deserialize)]
pub struct EditorQ {
    pub ticket: String,
    pub block: Option<String>,
    pub kind: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

/// `GET /v1/backlinks?ticket=…`: "Linked from" for the session's canvas, as its person. The
/// session proves view on the target; the sources are checked with the host.
pub async fn editor_backlinks(
    State(state): State<SharedState>,
    Query(q): Query<EditorQ>,
) -> Result<Response, crate::routes::ApiError> {
    let (host, grant) = crate::routes::session(&state, &q.ticket).await?;
    let r = async {
        crate::links::admit(&state, &host, &grant.user.id).await?;
        let reader = Reader {
            user_id: &grant.user.id,
            token: &grant.callback_token,
            files: None,
        };
        let lq = link_query(BacklinksQ {
            block: q.block,
            kind: q.kind,
            cursor: q.cursor,
            limit: q.limit,
        })?;
        crate::links::backlinks(&state, &host, reader, &grant.file.id, &grant.file.name, lq).await
    }
    .await;
    Ok(editor_answer(r))
}

#[derive(Deserialize)]
pub struct MentionsQ {
    pub ticket: String,
    /// The canvas's title and aliases, `|`-separated (the editor knows its own title).
    pub names: Option<String>,
}

/// `GET /v1/backlinks/mentions?ticket=…&names=…`: unlinked mentions (docs/38 §2.5).
pub async fn editor_mentions(
    State(state): State<SharedState>,
    Query(q): Query<MentionsQ>,
) -> Result<Response, crate::routes::ApiError> {
    let (host, grant) = crate::routes::session(&state, &q.ticket).await?;
    let r = async {
        crate::links::admit(&state, &host, &grant.user.id).await?;
        let mut names: Vec<String> = q
            .names
            .unwrap_or_default()
            .split('|')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s.len() <= 200)
            .take(4)
            .collect();
        if names.is_empty() {
            names.push(grant.file.name.clone());
        }
        let reader = Reader {
            user_id: &grant.user.id,
            token: &grant.callback_token,
            files: None,
        };
        crate::links::mentions(&state, &host, reader, &grant.file.id, &names).await
    }
    .await;
    Ok(editor_answer(r))
}

#[derive(Deserialize, Default)]
pub struct GraphQ {
    pub root: Option<String>,
    pub depth: Option<u8>,
    pub kinds: Option<String>,
    pub blocks: Option<bool>,
    pub limit: Option<usize>,
}

fn graph_params(q: GraphQ) -> Result<crate::graph::Params, LinkError> {
    crate::graph::Params::parse(q.root, q.depth, q.kinds.as_deref(), q.blocks, q.limit)
}

/// The graph shared by the API and MCP (GRAPH-01): a user token; every node checked first.
pub async fn api_graph(state: &SharedState, p: &Principal, q: GraphQ) -> Result<Value, Problem> {
    if p.via == Via::HostKey {
        return Err(Problem::bad_request(
            "USER_TOKEN_REQUIRED",
            "the graph needs a user token: what a person may see depends on who they are",
        ));
    }
    let params = graph_params(q)?;
    let reader = Reader {
        user_id: &p.sub,
        token: &p.callback_token,
        files: p.files.as_deref(),
    };
    Ok(crate::graph::graph(state, &p.host, reader, params).await?)
}

/// `GET /api/v1/graph?root=&depth=&kinds=&blocks=&limit=` (ADR-082).
pub async fn graph(
    State(state): State<SharedState>,
    Query(q): Query<GraphQ>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    let v = api_graph(&state, &p, q).await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(v)).into_response())
}

#[derive(Deserialize)]
pub struct EditorGraphQ {
    pub ticket: String,
    /// `"none"` for the full graph; absent: the session's canvas.
    pub root: Option<String>,
    pub depth: Option<u8>,
    pub kinds: Option<String>,
    pub blocks: Option<bool>,
    pub limit: Option<usize>,
}

/// `GET /v1/graph?ticket=…`: the local graph of the session's canvas (or `root=none` for the
/// full graph), as the session's person.
pub async fn editor_graph(
    State(state): State<SharedState>,
    Query(q): Query<EditorGraphQ>,
) -> Result<Response, crate::routes::ApiError> {
    let (host, grant) = crate::routes::session(&state, &q.ticket).await?;
    let r = async {
        let root = match q.root.as_deref() {
            Some("none") => None,
            Some(r) if !r.is_empty() => Some(r.to_string()),
            _ => Some(grant.file.id.clone()),
        };
        let params = graph_params(GraphQ {
            root,
            depth: q.depth,
            kinds: q.kinds,
            blocks: q.blocks,
            limit: q.limit,
        })?;
        let reader = Reader {
            user_id: &grant.user.id,
            token: &grant.callback_token,
            files: None,
        };
        crate::graph::graph(&state, &host, reader, params).await
    }
    .await;
    Ok(editor_answer(r))
}

// ---------- editor-only routes (LINK-04/05): titles and states, `#` targets, previews ----------

/// Most link targets one resolve call answers.
pub const MAX_RESOLVE: usize = 100;
/// Most canvases one resolve call opens to name or check blocks.
pub const MAX_RESOLVE_DOCS: usize = 20;

async fn editor_session(
    state: &SharedState,
    ticket: &str,
) -> Result<
    (
        std::sync::Arc<crate::hosts::HostConfig>,
        crate::grant::Grant,
    ),
    crate::routes::ApiError,
> {
    crate::routes::session(state, ticket).await
}

fn reader_of(grant: &crate::grant::Grant) -> Reader<'_> {
    Reader {
        user_id: &grant.user.id,
        token: &grant.callback_token,
        files: None,
    }
}

/// The target document of a link as the reader may read it, for its access answer.
async fn target_doc(
    state: &SharedState,
    host: &std::sync::Arc<crate::hosts::HostConfig>,
    reader: Reader<'_>,
    file_id: &str,
    access: &crate::host_client::AccessDetail,
) -> Option<Value> {
    crate::links::source_doc(state, host, reader, file_id, access).await
}

fn target_json(t: &oc_model::links::Target) -> Value {
    let mut v = json!({"id": t.id, "kind": t.kind, "text": t.text});
    if t.level > 0 {
        v["level"] = json!(t.level);
    }
    if let Some(db) = &t.db {
        v["db"] = json!(db);
    }
    v
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveTarget {
    file_id: String,
    #[serde(default)]
    block_id: Option<String>,
}

#[derive(Deserialize)]
pub struct ResolveBody {
    ticket: String,
    targets: Vec<ResolveTarget>,
}

/// `POST /v1/links/resolve {ticket, targets: [{fileId, blockId?}]}`: what each link in the
/// canvas shows now: `state` `ok` (with the host's title and path, and the block's text when it
/// points at one), `none` (no title), `gone` (deleted) or `missing` (the block is not there).
pub async fn editor_resolve(
    State(state): State<SharedState>,
    Json(b): Json<ResolveBody>,
) -> Result<Response, crate::routes::ApiError> {
    let (host, grant) = editor_session(&state, &b.ticket).await?;
    let r = async {
        crate::links::admit(&state, &host, &grant.user.id).await?;
        if b.targets.len() > MAX_RESOLVE {
            return Err(LinkError::BadInput("at most 100 targets"));
        }
        let reader = reader_of(&grant);
        let mut files: Vec<String> = b.targets.iter().map(|t| t.file_id.clone()).collect();
        files.sort();
        files.dedup();
        if files.iter().any(|f| f.is_empty() || f.len() > 1024) {
            return Err(LinkError::BadInput("fileId must be 1-1024 bytes"));
        }
        let (ok, gone) = crate::links::readable(&state, &host, reader, &files).await;
        // Canvases whose blocks are asked for: their targets, read now (the first 20).
        let mut with_blocks: Vec<&String> = b
            .targets
            .iter()
            .filter(|t| t.block_id.as_deref().is_some_and(|x| !x.is_empty()))
            .map(|t| &t.file_id)
            .filter(|f| ok.contains_key(*f))
            .collect();
        with_blocks.sort();
        with_blocks.dedup();
        let mut targets: std::collections::HashMap<String, Vec<oc_model::links::Target>> =
            Default::default();
        for f in with_blocks.into_iter().take(MAX_RESOLVE_DOCS) {
            if let Some(doc) = target_doc(&state, &host, reader, f, &ok[f]).await {
                targets.insert(f.clone(), oc_model::links::targets(&doc, 500));
            }
        }
        let items: Vec<Value> = b
            .targets
            .iter()
            .map(|t| {
                let block = t.block_id.clone().filter(|x| !x.is_empty());
                if gone.contains(&t.file_id) {
                    return json!({"fileId": t.file_id, "blockId": block, "state": "gone"});
                }
                let Some(a) = ok.get(&t.file_id) else {
                    return json!({"fileId": t.file_id, "blockId": block, "state": "none"});
                };
                let mut v = json!({
                    "fileId": t.file_id, "blockId": block, "state": "ok",
                    "title": a.name.clone().unwrap_or_else(|| t.file_id.clone()), "path": a.path,
                });
                if let (Some(bid), Some(list)) = (&block, targets.get(&t.file_id)) {
                    match oc_model::links::find_target(list, bid) {
                        Some(x) => v["block"] = json!(x.text),
                        None => v["state"] = json!("missing"),
                    }
                }
                v
            })
            .collect();
        Ok(json!({"items": items}))
    }
    .await;
    Ok(editor_answer(r))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetQ {
    ticket: String,
    file_id: String,
    block: Option<String>,
}

/// The access answer for one target, or the error to show.
async fn one_target(
    state: &SharedState,
    host: &crate::hosts::HostConfig,
    reader: Reader<'_>,
    file_id: &str,
) -> Result<crate::host_client::AccessDetail, LinkError> {
    crate::links::target_access(state, host, reader, file_id).await
}

/// `GET /v1/links/targets?ticket=&fileId=`: the headings, blocks, databases and rows of a
/// canvas the reader can open, for `[[Canvas#`.
pub async fn editor_targets(
    State(state): State<SharedState>,
    Query(q): Query<TargetQ>,
) -> Result<Response, crate::routes::ApiError> {
    let (host, grant) = editor_session(&state, &q.ticket).await?;
    let r = async {
        crate::links::admit(&state, &host, &grant.user.id).await?;
        let reader = reader_of(&grant);
        let a = one_target(&state, &host, reader, &q.file_id).await?;
        let doc = target_doc(&state, &host, reader, &q.file_id, &a)
            .await
            .ok_or_else(|| LinkError::Host("the canvas could not be read".into()))?;
        let items: Vec<Value> = oc_model::links::targets(&doc, 20)
            .iter()
            .take(300)
            .map(target_json)
            .collect();
        Ok(json!({
            "fileId": q.file_id,
            "title": a.name.unwrap_or_else(|| q.file_id.clone()),
            "path": a.path,
            "items": items,
        }))
    }
    .await;
    Ok(editor_answer(r))
}

/// `GET /v1/links/preview?ticket=&fileId=&block=`: the hover preview of a link: the host's
/// title, path and last edit, and the first lines of the canvas or the linked block, as plain
/// text read with the reader's role. `state` as for resolve.
pub async fn editor_preview(
    State(state): State<SharedState>,
    Query(q): Query<TargetQ>,
) -> Result<Response, crate::routes::ApiError> {
    let (host, grant) = editor_session(&state, &q.ticket).await?;
    let r = async {
        crate::links::admit(&state, &host, &grant.user.id).await?;
        let reader = reader_of(&grant);
        let a = match one_target(&state, &host, reader, &q.file_id).await {
            Ok(a) => a,
            Err(LinkError::Forbidden) => return Ok(json!({"fileId": q.file_id, "state": "none"})),
            Err(LinkError::Gone) => return Ok(json!({"fileId": q.file_id, "state": "gone"})),
            Err(e) => return Err(e),
        };
        let doc = target_doc(&state, &host, reader, &q.file_id, &a).await;
        let block = q.block.filter(|b| !b.is_empty());
        let mut state_word = "ok";
        let mut block_text = Value::Null;
        let lines: Vec<String> = match (&doc, &block) {
            (Some(d), Some(b)) => {
                let all = oc_model::links::targets(d, 500);
                match oc_model::links::find_target(&all, b) {
                    Some(t) => {
                        block_text = json!(t.text);
                        let mut l = vec![];
                        if let Some(n) = oc_model::links::block_by_id(d, b) {
                            let text = oc_model::links::plain_text(n);
                            if !text.trim().is_empty() && text.trim() != t.text {
                                l.push(text.trim().chars().take(300).collect());
                            }
                        }
                        l
                    }
                    None => {
                        state_word = "missing";
                        oc_model::links::first_lines(d, 3)
                    }
                }
            }
            (Some(d), None) => oc_model::links::first_lines(d, 4),
            (None, _) => vec![],
        };
        Ok(json!({
            "fileId": q.file_id,
            "state": state_word,
            "title": a.name.clone().unwrap_or_else(|| q.file_id.clone()),
            "path": a.path,
            "updatedAt": a.updated_at,
            "updatedBy": a.updated_by,
            "role": a.role.map(|r| r.as_str()),
            "block": block_text,
            "lines": lines,
        }))
    }
    .await;
    Ok(editor_answer(r))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionLinkBody {
    ticket: String,
    /// The canvas that mentions this one.
    file_id: String,
    /// The block the search hit named (else the first block that mentions it).
    #[serde(default)]
    block_id: Option<String>,
    /// The words to link (this canvas's title or an alias).
    name: String,
}

type UndoKey = (String, String, String, String);

/// LINK-05: the blocks "Link" changed, per (host, person, source, block), for its Undo.
#[derive(Default)]
pub struct MentionUndo(
    std::sync::Mutex<std::collections::HashMap<UndoKey, (std::time::Instant, Value, Value)>>,
);

const UNDO_TTL: std::time::Duration = std::time::Duration::from_secs(600);

/// A grant on the source canvas with the role the host gave, for a room edit as that person.
fn source_grant(
    host: &crate::hosts::HostConfig,
    parent: &crate::grant::Grant,
    file_id: &str,
    a: &crate::host_client::AccessDetail,
) -> crate::grant::Grant {
    let mut g = crate::live::derive(
        parent,
        None,
        file_id,
        a.role.unwrap_or(crate::grant::Role::View),
        a.name.clone(),
        a.callback_token.clone(),
    );
    g.live = Default::default();
    g.host_id = host.id.clone();
    g
}

async fn source_json(
    state: &SharedState,
    host: &std::sync::Arc<crate::hosts::HostConfig>,
    g: &crate::grant::Grant,
) -> Result<Value, LinkError> {
    let bytes = state
        .rooms
        .state(host, g)
        .await
        .map_err(|e| LinkError::Host(e.to_string()))?;
    let doc = oc_model::new_doc();
    oc_model::ocanvas::apply_update_bytes(&doc, &bytes)
        .map_err(|e| LinkError::Internal(e.to_string()))?;
    Ok(oc_model::doc_to_json(&doc))
}

async fn replace_block(
    state: &SharedState,
    host: &std::sync::Arc<crate::hosts::HostConfig>,
    g: &crate::grant::Grant,
    block_id: &str,
    block: Value,
) -> Result<(), LinkError> {
    let ops = vec![oc_model::patch::PatchOp::Replace {
        block_id: block_id.to_string(),
        markdown: None,
        blocks: Some(vec![block]),
    }];
    match state.rooms.patch(host, g, ops, &g.user.id).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(LinkError::Internal(format!("{e:?}"))),
        Err(e) => Err(LinkError::Internal(e.to_string())),
    }
}

/// Who may edit the source: the host's answer for this person, edit only.
async fn edit_access(
    state: &SharedState,
    host: &crate::hosts::HostConfig,
    grant: &crate::grant::Grant,
    file_id: &str,
) -> Result<crate::host_client::AccessDetail, LinkError> {
    let a = one_target(state, host, reader_of(grant), file_id).await?;
    if a.role != Some(crate::grant::Role::Edit) {
        return Err(LinkError::Forbidden);
    }
    Ok(a)
}

/// `POST /v1/backlinks/link {ticket, fileId, blockId?, name}` (LINK-05, docs/38 §2.5): turns the
/// mention of this canvas in `fileId` into a link, in that canvas's room, as this person, who
/// needs edit there (checked with the host). One block replaced: one step to undo.
pub async fn editor_link_mention(
    State(state): State<SharedState>,
    Json(b): Json<MentionLinkBody>,
) -> Result<Response, crate::routes::ApiError> {
    let (host, grant) = editor_session(&state, &b.ticket).await?;
    let r = async {
        crate::links::admit(&state, &host, &grant.user.id).await?;
        if b.name.trim().chars().count() < 2 || b.name.len() > 200 || b.file_id == grant.file.id {
            return Err(LinkError::BadInput(
                "name is 2-200 bytes, in another canvas",
            ));
        }
        let a = edit_access(&state, &host, &grant, &b.file_id).await?;
        let g = source_grant(&host, &grant, &b.file_id, &a);
        let doc = source_json(&state, &host, &g).await?;
        let found = match b.block_id.as_deref().filter(|x| !x.is_empty()) {
            Some(id) => oc_model::links::block_by_id(&doc, id).and_then(|blk| {
                oc_model::links::link_mention(blk, &b.name, &grant.file.id)
                    .map(|n| (id.to_string(), blk.clone(), n))
            }),
            None => first_mention(&doc, &b.name, &grant.file.id),
        };
        let Some((block_id, before, after)) = found else {
            return Err(LinkError::BadInput("the mention is not there any more"));
        };
        replace_block(&state, &host, &g, &block_id, after.clone()).await?;
        if let Ok(mut m) = state.mention_undo.0.lock() {
            m.retain(|_, (at, _, _)| at.elapsed() < UNDO_TTL);
            m.insert(
                (
                    host.id.clone(),
                    grant.user.id.clone(),
                    b.file_id.clone(),
                    block_id.clone(),
                ),
                (std::time::Instant::now(), before, after),
            );
        }
        Ok(json!({"fileId": b.file_id, "blockId": block_id}))
    }
    .await;
    Ok(editor_answer(r))
}

/// The first block with an id that mentions `name` (search hits without a block id).
fn first_mention(doc: &Value, name: &str, target: &str) -> Option<(String, Value, Value)> {
    fn go(
        nodes: &[Value],
        name: &str,
        target: &str,
        depth: usize,
    ) -> Option<(String, Value, Value)> {
        for n in nodes {
            if depth > 64 {
                return None;
            }
            let id = n["attrs"]["blockId"].as_str().unwrap_or_default();
            if !id.is_empty()
                && matches!(n["type"].as_str(), Some("paragraph" | "heading"))
                && let Some(after) = oc_model::links::link_mention(n, name, target)
            {
                return Some((id.to_string(), n.clone(), after));
            }
            if let Some(c) = n["content"].as_array()
                && let Some(hit) = go(c, name, target, depth + 1)
            {
                return Some(hit);
            }
        }
        None
    }
    go(doc["content"].as_array()?, name, target, 0)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionUndoBody {
    ticket: String,
    file_id: String,
    block_id: String,
}

/// `POST /v1/backlinks/unlink {ticket, fileId, blockId}`: Undo of [`editor_link_mention`]: the
/// block goes back to what it was, if nobody changed it since (else 409 `CONFLICT`).
pub async fn editor_unlink_mention(
    State(state): State<SharedState>,
    Json(b): Json<MentionUndoBody>,
) -> Result<Response, crate::routes::ApiError> {
    let (host, grant) = editor_session(&state, &b.ticket).await?;
    let key = (
        host.id.clone(),
        grant.user.id.clone(),
        b.file_id.clone(),
        b.block_id.clone(),
    );
    let saved = state.mention_undo.0.lock().ok().and_then(|m| {
        m.get(&key)
            .filter(|(at, _, _)| at.elapsed() < UNDO_TTL)
            .cloned()
    });
    let r: Result<Value, Problem> = async {
        let Some((_, before, after)) = saved else {
            return Err(Problem::not_found("NOT_FOUND", "nothing to undo"));
        };
        let a = edit_access(&state, &host, &grant, &b.file_id).await?;
        let g = source_grant(&host, &grant, &b.file_id, &a);
        let doc = source_json(&state, &host, &g).await?;
        let now = oc_model::links::block_by_id(&doc, &b.block_id);
        let same = now.is_some_and(|n| {
            oc_model::links::plain_text(n) == oc_model::links::plain_text(&after)
                && oc_model::links::extract(&json!({"content": [n]}), &Default::default())
                    .edges
                    .len()
                    == oc_model::links::extract(&json!({"content": [&after]}), &Default::default())
                        .edges
                        .len()
        });
        if !same {
            return Err(Problem::new(
                StatusCode::CONFLICT,
                "CONFLICT",
                "the block changed since; undo it there",
            ));
        }
        replace_block(&state, &host, &g, &b.block_id, before).await?;
        if let Ok(mut m) = state.mention_undo.0.lock() {
            m.remove(&key);
        }
        Ok(json!({"fileId": b.file_id, "blockId": b.block_id}))
    }
    .await;
    Ok(match r {
        Ok(v) => Json(v).into_response(),
        Err(p) => p.into_response(),
    })
}
