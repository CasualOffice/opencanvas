// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Cluster forwarding of canvas tool calls (docs/24 §5.6): a call that lands on a node that
//! does not own the room is sent to the owner over the signed internal API
//! (`POST /v1/internal/tools/:room`, `OC_CLUSTER_SECRET` HMAC over room + body + time).
//!
//! Only the verified identity travels: the grant (user, role already capped by the token's
//! scope, file) with its callback token blanked, the origin and the write mode. Never the
//! client's bearer token. The owner rebuilds the [`ToolCtx`] and runs the call through the
//! same checks (role, scope, revocation) as a local call. A request id makes the call
//! idempotent: a retry of the same id gets the first answer and does not run twice.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::OnceCell;

use super::{LiveTools, ToolCtx, ToolError, WriteMode};
use crate::SharedState;
use crate::cluster::{H_NODE, ToolSent};
use crate::grant::Grant;
use crate::hosts::HostConfig;

/// A tool call on its way to the room's owner.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolForward {
    pub request_id: String,
    pub host_id: String,
    pub file_id: String,
    /// The verified identity: user, role (`min(scope, host role)`), file. No callback token.
    pub grant: Grant,
    pub origin: String,
    pub mode: String,
    pub name: String,
    pub args: Value,
}

/// How long a non-owner keeps looking for the owner while the room moves.
const MOVE_DEADLINE: Duration = Duration::from_secs(10);
const MOVE_RETRY: Duration = Duration::from_millis(200);
/// How long an owner remembers the answer to a request id.
const DEDUPE_TTL: Duration = Duration::from_secs(600);

fn ok_envelope(r: &Result<Value, ToolError>) -> Value {
    match r {
        Ok(v) => json!({"ok": v}),
        Err(e) => json!({"err": e.to_json()}),
    }
}

fn open_envelope(v: Value) -> Result<Value, ToolError> {
    if let Some(ok) = v.get("ok") {
        return Ok(ok.clone());
    }
    Err(ToolError::from_json(&v["err"]))
}

/// Non-owner side: sends the call to `owner`, following the room if it moves, until it ran.
/// `None`: the room is now placed on this node; the caller runs it here.
pub(super) async fn forward(
    state: &SharedState,
    host: &Arc<HostConfig>,
    ctx: &ToolCtx,
    mut owner: crate::cluster::lease::Owner,
    name: &str,
    args: &Value,
) -> Option<Result<Value, ToolError>> {
    let cluster = state.rooms.cluster()?;
    let mut grant = ctx.user.clone();
    grant.callback_token = String::new();
    let fwd = ToolForward {
        request_id: ulid::Ulid::new().to_string().to_lowercase(),
        host_id: ctx.host_id.clone(),
        file_id: ctx.file_id.clone(),
        grant,
        origin: ctx.origin.clone(),
        mode: ctx.mode_default.as_str().to_string(),
        name: name.to_string(),
        args: args.clone(),
    };
    let body = match serde_json::to_vec(&fwd) {
        Ok(b) => b,
        Err(e) => return Some(Err(ToolError::Internal(e.to_string()))),
    };
    let room = &ctx.user.room;
    let deadline = Instant::now() + MOVE_DEADLINE;
    let mut lost_once = false;
    loop {
        match cluster.call_tool(&owner, room, &body).await {
            ToolSent::Done(v) => return Some(open_envelope(v)),
            ToolSent::Unreachable(e) => {
                tracing::warn!(room = %room, owner = %owner.node, error = %e, "tool forward: owner unreachable");
                return Some(Err(ToolError::Unavailable(
                    "the node that holds this canvas is unreachable; retry shortly".into(),
                )));
            }
            ToolSent::Lost(e) if !lost_once => {
                // It may have run: the same request id gets the first answer.
                tracing::warn!(room = %room, owner = %owner.node, error = %e, "tool forward: no answer; retrying");
                lost_once = true;
            }
            ToolSent::Lost(e) => {
                tracing::warn!(room = %room, owner = %owner.node, error = %e, "tool forward: no answer");
                return Some(Err(ToolError::Unavailable(
                    "the node that holds this canvas did not answer; retry shortly".into(),
                )));
            }
            ToolSent::Moved => {
                if Instant::now() >= deadline {
                    return Some(Err(ToolError::Unavailable(
                        "the canvas is moving between nodes; retry shortly".into(),
                    )));
                }
                tokio::time::sleep(MOVE_RETRY).await;
                match state.rooms.tool_owner(host, &ctx.user).await {
                    Ok(Some(o)) => owner = o,
                    Ok(None) => return None,
                    Err(e) => return Some(Err(ToolError::Unavailable(e.to_string()))),
                }
            }
        }
    }
}

type Slot = Arc<OnceCell<Value>>;

/// Answers by `(node, request id)`; concurrent duplicates wait for the first run.
static SEEN: LazyLock<Mutex<HashMap<String, (Instant, Slot)>>> = LazyLock::new(Mutex::default);

fn slot(key: &str) -> Slot {
    let mut seen = SEEN.lock().expect("tool forward dedupe");
    if seen.len() > 10_000 {
        seen.retain(|_, (at, _)| at.elapsed() < DEDUPE_TTL);
    }
    let entry = seen
        .entry(key.to_string())
        .or_insert_with(|| (Instant::now(), Arc::new(OnceCell::new())));
    if entry.0.elapsed() >= DEDUPE_TTL {
        *entry = (Instant::now(), Arc::new(OnceCell::new()));
    }
    entry.1.clone()
}

fn status(code: StatusCode, msg: &str) -> Response {
    (code, msg.to_string()).into_response()
}

/// Owner side: `POST /v1/internal/tools/:room`.
pub async fn serve_forward(
    state: SharedState,
    room: String,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(cluster) = state.rooms.cluster() else {
        return status(StatusCode::NOT_FOUND, "not in cluster mode");
    };
    if !cluster.verify(&headers, &room, &body) {
        tracing::warn!(room = %room, "tool forward with a bad cluster signature refused");
        return status(StatusCode::UNAUTHORIZED, "bad signature");
    }
    let fwd: ToolForward = match serde_json::from_slice(&body) {
        Ok(f) => f,
        Err(e) => return status(StatusCode::BAD_REQUEST, &e.to_string()),
    };
    if fwd.grant.room != room
        || fwd.grant.host_id != fwd.host_id
        || fwd.grant.file.id != fwd.file_id
        || fwd.request_id.is_empty()
    {
        return status(StatusCode::BAD_REQUEST, "forward does not match its room");
    }
    let Some(host) = state.hosts.get(&fwd.host_id) else {
        return status(StatusCode::NOT_FOUND, "unknown host");
    };
    match state.rooms.tool_owner(&host, &fwd.grant).await {
        Ok(None) => {}
        Ok(Some(_)) => return status(StatusCode::CONFLICT, "not the owner"),
        Err(_) if state.rooms.draining() => return status(StatusCode::CONFLICT, "draining"),
        Err(e) => return status(StatusCode::SERVICE_UNAVAILABLE, &e.to_string()),
    }
    let node = headers
        .get(H_NODE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let cell = slot(&format!("{node}\n{}", fwd.request_id));
    let answer = cell
        .get_or_init(|| async {
            let ctx = ToolCtx {
                host_id: fwd.host_id.clone(),
                file_id: fwd.file_id.clone(),
                user: fwd.grant.clone(),
                origin: fwd.origin.clone(),
                mode_default: WriteMode::parse(&fwd.mode),
            };
            let out = LiveTools::new(state.clone())
                .call_owned(&ctx, &fwd.name, fwd.args.clone())
                .await;
            ok_envelope(&out)
        })
        .await;
    axum::Json(answer.clone()).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelopes_round_trip_errors() {
        let e = open_envelope(ok_envelope(&Err(ToolError::Stale(json!({"b": 1}))))).unwrap_err();
        assert!(matches!(e, ToolError::Stale(v) if v["b"] == 1));
        let e = open_envelope(ok_envelope(&Err(ToolError::Forbidden("no".into())))).unwrap_err();
        assert!(matches!(e, ToolError::Forbidden(m) if m == "no"));
        assert_eq!(open_envelope(ok_envelope(&Ok(json!(3)))).unwrap(), json!(3));
    }

    #[test]
    fn the_same_request_id_shares_one_slot() {
        let a = slot("n2\nreq-1");
        let b = slot("n2\nreq-1");
        let c = slot("n3\nreq-1");
        assert!(Arc::ptr_eq(&a, &b));
        assert!(!Arc::ptr_eq(&a, &c));
    }
}
