// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Owner side: the internal endpoints other nodes call. Never exposed through the load
//! balancer; every request carries an `OC_CLUSTER_SECRET` HMAC over room + payload + time.
//!
//! - `GET  /v1/internal/relay/:room` (WebSocket): a relayed client connection. The grant
//!   travels signed in `x-oc-cluster-grant`; roles are enforced here, by the room actor.
//! - `POST /v1/internal/rooms/:room`: a host-API room call ([`RemoteOp`]).

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use futures::StreamExt;
use tokio::sync::mpsc;

use super::H_GRANT;
use crate::SharedState;
use crate::grant::Grant;
use crate::room::{Membership, NotOwner, Outbound, RemoteOp};

pub fn routes(state: SharedState) -> Router {
    Router::new()
        .route("/v1/internal/relay/{room}", get(relay))
        .route("/v1/internal/rooms/{room}", post(call))
        .route("/v1/internal/tools/{room}", post(tool))
        .with_state(state)
}

/// `POST /v1/internal/tools/:room`: a canvas tool call forwarded by another node.
async fn tool(
    State(state): State<SharedState>,
    Path(room): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    crate::ai::tools::serve_forward(state, room, headers, body).await
}

fn status(code: StatusCode, msg: &str) -> Response {
    (code, msg.to_string()).into_response()
}

async fn relay(
    State(state): State<SharedState>,
    Path(room): Path<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(cluster) = state.rooms.cluster() else {
        return status(StatusCode::NOT_FOUND, "not in cluster mode");
    };
    let Some(grant_b64) = headers.get(H_GRANT).and_then(|v| v.to_str().ok()) else {
        return status(StatusCode::BAD_REQUEST, "grant missing");
    };
    if !cluster.verify(&headers, &room, grant_b64.as_bytes()) {
        tracing::warn!(room = %room, "relay with a bad cluster signature refused");
        return status(StatusCode::UNAUTHORIZED, "bad signature");
    }
    let grant: Grant = match base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(grant_b64)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
    {
        Some(g) => g,
        None => return status(StatusCode::BAD_REQUEST, "bad grant"),
    };
    if grant.room != room {
        return status(StatusCode::BAD_REQUEST, "grant is for another room");
    }
    let Some(host) = state.hosts.get(&grant.host_id) else {
        return status(StatusCode::NOT_FOUND, "unknown host");
    };
    let (tx, rx) = mpsc::unbounded_channel();
    let membership = match state.rooms.join_owned(&host, Arc::new(grant), tx).await {
        Ok(m) => m,
        Err(e) if e.is::<NotOwner>() || state.rooms.draining() => {
            return status(StatusCode::CONFLICT, "not the owner");
        }
        Err(e) => {
            tracing::warn!(room = %room, error = %e, "relayed join failed");
            return status(StatusCode::SERVICE_UNAVAILABLE, "room unavailable");
        }
    };
    let limit = state.cfg.rooms.max_frame_bytes * 2;
    crate::routes::collab::ws_config(ws, limit)
        .on_upgrade(move |socket| pump(socket, membership, rx))
}

/// Edge → actor and actor → edge, in order, until either side closes.
async fn pump(socket: WebSocket, membership: Membership, rx: mpsc::UnboundedReceiver<Outbound>) {
    let (sink, mut stream) = socket.split();
    let mut writer = tokio::spawn(crate::routes::write_frames(sink, rx));
    loop {
        tokio::select! {
            msg = stream.next() => match msg {
                Some(Ok(Message::Binary(b))) => membership.send(b.to_vec()).await,
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            _ = &mut writer => {
                // The room closed the connection (its close frame, if any, is already flushed)
                // or the actor is gone: drop the socket so the edge reacts at once.
                return;
            }
        }
    }
    drop(membership);
    let _ = tokio::time::timeout(Duration::from_secs(5), &mut writer).await;
    writer.abort();
}

async fn call(
    State(state): State<SharedState>,
    Path(room): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(cluster) = state.rooms.cluster() else {
        return status(StatusCode::NOT_FOUND, "not in cluster mode");
    };
    if !cluster.verify(&headers, &room, &body) {
        tracing::warn!(room = %room, "room call with a bad cluster signature refused");
        return status(StatusCode::UNAUTHORIZED, "bad signature");
    }
    let op: RemoteOp = match serde_json::from_slice(&body) {
        Ok(op) => op,
        Err(e) => return status(StatusCode::BAD_REQUEST, &e.to_string()),
    };
    if let Some(g) = op.grant()
        && g.room != room
    {
        return status(StatusCode::BAD_REQUEST, "grant is for another room");
    }
    let host = match op.grant() {
        Some(g) => match state.hosts.get(&g.host_id) {
            Some(h) => Some(h),
            None => return status(StatusCode::NOT_FOUND, "unknown host"),
        },
        None => None,
    };
    if let (RemoteOp::Automation { grant, call }, Some(h)) = (&op, &host) {
        return match crate::routes::v1::automation::serve_owned(&state, h, grant, call.clone())
            .await
        {
            Some(v) => axum::Json(v).into_response(),
            None => status(StatusCode::CONFLICT, "not the owner"),
        };
    }
    match state.rooms.serve_remote(&room, host, op).await {
        Ok(v) => axum::Json(v).into_response(),
        Err(e) if e.is::<NotOwner>() || state.rooms.draining() => {
            status(StatusCode::CONFLICT, "not the owner")
        }
        Err(e) => {
            tracing::warn!(room = %room, error = %e, "forwarded room call failed");
            status(StatusCode::BAD_GATEWAY, &e.to_string())
        }
    }
}
