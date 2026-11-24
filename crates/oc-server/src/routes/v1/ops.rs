// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The operation layer shared by the headless API and MCP (HAPI-08, docs/27 §4.2 "Relation
//! to MCP"). Every API operation that changes or reads canvas content runs through
//! [`invoke`], named by its OpenAPI `operationId`; each MCP canvas tool is a thin adapter that
//! names the operation it stands for ([`MCP_TOOLS`]) and calls the same function, so the two
//! share one permission check (`authz::Principal`), the same per-file write bucket
//! ([`admit_write`]) and the same idempotency store and key space ([`mcp_idempotent`]).

use serde_json::{Value, json};

use super::idempotency::{LEASE_SECS, TTL_SECS, sha};
use crate::SharedState;
use crate::ai::tools::{CanvasTools, LiveTools, Scope, ToolError};
use crate::authz::Principal;
use crate::ratelimit::{Decision, file_policy};
use crate::store::IdemBegin;

/// Canvas operations: `operationId` → the tool-layer step that runs it.
pub const OPERATIONS: &[(&str, &str)] = &[
    ("readFile", "canvas_read"),
    ("getBlock", "canvas_read"),
    ("findBlocks", "canvas_find"),
    ("batchBlocks", "canvas_patch"),
    ("listDatabases", "db_describe"),
    ("getDatabase", "db_describe"),
    ("createDatabase", "db_create"),
    ("queryRows", "db_query"),
    ("upsertRows", "db_upsert_rows"),
    ("addField", "db_add_field"),
    ("readBoard", "board_read"),
    ("addShapes", "board_add_shapes"),
    ("createBoard", "board_add_shapes"),
    ("listComments", "comment_list"),
    ("addComment", "comment_add"),
    ("listMembers", "members_list"),
];

/// Every MCP canvas tool and the API operations it is an adapter for (the first is the
/// usual one; `board_add_shapes` without a `boardId` is `createBoard`). The parity contract
/// test (`tests/mcp_api_parity.rs`) holds this to the tool list, the OpenAPI document and the
/// answers of both interfaces.
pub const MCP_TOOLS: &[(&str, &[&str])] = &[
    ("canvas_read", &["readFile"]),
    ("canvas_find", &["findBlocks"]),
    ("db_describe", &["listDatabases"]),
    ("db_query", &["queryRows"]),
    ("board_read", &["readBoard"]),
    ("comment_list", &["listComments"]),
    ("members_list", &["listMembers"]),
    ("canvas_patch", &["batchBlocks"]),
    ("db_upsert_rows", &["upsertRows"]),
    ("db_create", &["createDatabase"]),
    ("db_add_field", &["addField"]),
    ("board_add_shapes", &["addShapes", "createBoard"]),
    ("comment_add", &["addComment"]),
];

/// The API operation one MCP tool call stands for.
pub fn operation_for_call(tool: &str, args: &Value) -> Option<&'static str> {
    let ops = MCP_TOOLS.iter().find(|(t, _)| *t == tool)?.1;
    if tool == "board_add_shapes" && args["boardId"].as_str().is_none() {
        return Some("createBoard");
    }
    ops.first().copied()
}

fn step_of(op: &str) -> Option<&'static str> {
    OPERATIONS.iter().find(|(o, _)| *o == op).map(|(_, s)| *s)
}

/// Runs one canvas operation as `p` on `file_id`: the scope ceiling, the host role (min of
/// both), then the tool-layer step in the room. The answer keeps the untrusted-data wrapper
/// (`{notice, data}`) of reads; the API unwraps it, MCP passes it to the model.
pub async fn invoke(
    state: &SharedState,
    p: &Principal,
    op: &str,
    file_id: &str,
    mut input: Value,
) -> Result<Value, ToolError> {
    let step = step_of(op).ok_or_else(|| ToolError::NotFound(format!("unknown operation {op}")))?;
    let spec = crate::ai::tools::phase1_specs()
        .into_iter()
        .find(|s| s.name == step)
        .ok_or_else(|| ToolError::NotFound(format!("unknown operation {op}")))?;
    if input.is_null() {
        input = json!({});
    } else if !input.is_object() {
        return Err(ToolError::BadInput("arguments must be an object".into()));
    }
    input["fileId"] = json!(file_id);
    p.scope_ok(spec.scope, step)?;
    let ctx = p.tool_ctx(state, file_id).await?;
    LiveTools::new(state.clone()).call(&ctx, step, input).await
}

/// Whether an operation changes the file (and so takes from its write bucket).
pub fn is_write(op: &str) -> bool {
    step_of(op).is_some_and(|s| {
        crate::ai::tools::phase1_specs()
            .into_iter()
            .any(|x| x.name == s && !x.read_only)
    })
}

/// The least scope an operation needs.
pub fn scope_of(op: &str) -> Option<Scope> {
    let step = step_of(op)?;
    crate::ai::tools::phase1_specs()
        .into_iter()
        .find(|s| s.name == step)
        .map(|s| s.scope)
}

/// Takes one token from the file's write bucket (the API's `file-writes` policy).
pub async fn admit_write(state: &SharedState, p: &Principal, file_id: &str) -> Decision {
    let key = format!("file:{}:{file_id}", p.host.id);
    state.limiter.check(&key, file_policy(&p.host)).await
}

/// The idempotency store entry of a caller's key: the same id the API middleware uses, so a
/// key is one key per (host, subject) whichever interface sends it.
pub fn key_id(p: &Principal, key: &str) -> String {
    sha(&[p.host.id.as_bytes(), p.sub.as_bytes(), key.as_bytes()])
}

/// What an idempotent MCP call found.
pub enum Idem {
    /// Run it, then [`mcp_finish`] or [`mcp_release`].
    Run { id: String, hash: String },
    /// The stored result of the same call.
    Replay(Value),
}

/// Claims `key` for an MCP write: the same store, lease and 24 h replay window as the API.
/// The request fingerprint is the operation and its input, so the same key with other input
/// is refused (`IDEMPOTENCY_KEY_REUSED`), and a duplicate while the first runs is
/// `IDEMPOTENCY_IN_PROGRESS`.
pub async fn mcp_idempotent(
    state: &SharedState,
    p: &Principal,
    op: &str,
    file_id: &str,
    key: &str,
    input: &Value,
) -> Result<Idem, ToolError> {
    if !super::idempotency::valid_key(key) {
        return Err(ToolError::BadInput(
            "IDEMPOTENCY_KEY_INVALID: idempotencyKey must be 1-255 visible ASCII characters".into(),
        ));
    }
    let id = key_id(p, key);
    let hash = sha(&[
        b"mcp",
        op.as_bytes(),
        file_id.as_bytes(),
        input.to_string().as_bytes(),
    ]);
    let now = state.clock.now_secs();
    match state
        .store
        .idem_begin(&id, &p.host.id, &hash, now, LEASE_SECS)
        .await
    {
        Err(e) => {
            tracing::warn!(host = %p.host.id, error = %e, "idempotency store unavailable");
            Err(ToolError::Unavailable(
                "the idempotency store is unavailable; retry".into(),
            ))
        }
        Ok(IdemBegin::Started) => Ok(Idem::Run { id, hash }),
        Ok(IdemBegin::Replay { response, .. }) => Ok(Idem::Replay(
            serde_json::from_str::<Value>(&response)
                .ok()
                .and_then(|v| v.get("mcp").cloned())
                .unwrap_or(Value::Null),
        )),
        Ok(IdemBegin::InProgress) => Err(ToolError::BadInput(
            "IDEMPOTENCY_IN_PROGRESS: a call with this idempotencyKey is still running".into(),
        )),
        Ok(IdemBegin::Mismatch) => Err(ToolError::BadInput(
            "IDEMPOTENCY_KEY_REUSED: this idempotencyKey was used with a different call".into(),
        )),
    }
}

/// Stores a successful MCP write's result for replays.
pub async fn mcp_finish(state: &SharedState, p: &Principal, id: &str, hash: &str, out: &Value) {
    let stored = json!({"mcp": out}).to_string();
    if let Err(e) = state
        .store
        .idem_finish(
            id,
            &p.host.id,
            hash,
            200,
            &stored,
            TTL_SECS,
            state.clock.now_secs(),
        )
        .await
    {
        tracing::warn!(host = %p.host.id, error = %e, "storing an idempotent result failed");
    }
}

/// Frees the key after a failed call, so a retry runs again.
pub async fn mcp_release(state: &SharedState, p: &Principal, id: &str, hash: &str) {
    if let Err(e) = state.store.idem_release(id, &p.host.id, hash).await {
        tracing::warn!(host = %p.host.id, error = %e, "idempotency key release failed");
    }
}
