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
