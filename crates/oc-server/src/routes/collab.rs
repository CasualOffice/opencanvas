// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `GET /v1/collab/:room?ticket=` WebSocket (docs/15 §3).

use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;

use super::{ApiError, session};
use crate::grant::Grant;
use crate::hosts::HostConfig;
use crate::metrics::Metrics;
use crate::room::{Outbound, protocol};
use crate::util::now_secs;
use crate::{SharedState, TicketUse};

const CONNECT_WINDOW: Duration = Duration::from_secs(60);
const RATE_PER_SEC: f64 = 60.0;
const RATE_BURST: f64 = 120.0;
/// Awareness (cursor) frames have their own bucket; excess frames are dropped, not fatal.
const AWARENESS_PER_SEC: f64 = 120.0;
const AWARENESS_BURST: f64 = 240.0;
/// Close code for the frame-rate limit (distinct from 1008, which means access revoked).
pub const CLOSE_RATE_LIMIT: u16 = 4429;
/// A client that does not read is dropped (SEC-17): one frame may wait this long for the
/// socket, and at most [`MAX_BACKLOG`] frames may queue for it.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_BACKLOG: usize = 4096;
/// Initial WebSocket read buffer per connection. tungstenite's default (128 KiB) is
/// zero-filled on the first read, so every idle connection kept 128 KiB resident (docs/22
/// §7). Client frames are small (keystroke updates, awareness); a larger frame grows the
/// buffer as needed, up to the frame limit.
pub const WS_READ_BUFFER: usize = 8 * 1024;
/// Bytes tungstenite gathers before it writes to the socket (its default is 128 KiB, which
/// every busy connection then keeps). Batches are flushed at [`WRITE_BATCH_BYTES`] anyway.
pub const WS_WRITE_BUFFER: usize = 16 * 1024;

/// The WebSocket settings shared by client sockets and the cluster relay.
pub fn ws_config(ws: WebSocketUpgrade, max_message: usize) -> WebSocketUpgrade {
    ws.read_buffer_size(WS_READ_BUFFER)
        .write_buffer_size(WS_WRITE_BUFFER)
        .max_message_size(max_message)
        .max_frame_size(max_message)
}

/// Frames written to the socket before one flush: a busy room's backlog goes out in one
/// write instead of one syscall per frame (docs/22 §9.1).
const WRITE_BATCH: usize = 64;
/// Bytes written before one flush. The socket's write buffer keeps the capacity of the
/// largest batch it ever held, for the life of the connection: without a byte cap a 550-peer
/// room's presence frames grew every connection's buffer to 200-400 KB (docs/22 §9.4).
pub const WRITE_BATCH_BYTES: usize = 64 * 1024;

/// Sends the actor's frames to `sink` until a close, a send error, a send that takes longer
/// than [`SEND_TIMEOUT`] or a backlog over [`MAX_BACKLOG`] (a peer that stopped reading).
/// Frames already queued are written together and flushed once.
pub async fn write_frames<S>(mut sink: S, mut rx: mpsc::UnboundedReceiver<Outbound>)
where
    S: futures::Sink<Message> + Unpin,
{
    let mut next = rx.recv().await;
    while let Some(out) = next.take() {
        if rx.len() > MAX_BACKLOG {
            tracing::info!(backlog = rx.len(), "slow client dropped");
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                sink.send(Message::Close(Some(CloseFrame {
                    code: 1013,
                    reason: "too slow".into(),
                }))),
            )
            .await;
            break;
        }
        let mut close = None;
        let mut batch = Vec::new();
        let mut bytes = 0;
        let mut item = Some(out);
        while let Some(o) = item.take() {
            match o {
                Outbound::Frame(b) => {
                    bytes += b.len();
                    batch.push(Message::Binary(b));
                }
                Outbound::Close(code, reason) => {
                    close = Some((code, reason));
                    break;
                }
            }
            if batch.len() < WRITE_BATCH && bytes < WRITE_BATCH_BYTES {
                item = rx.try_recv().ok();
            }
        }
        let write = async {
            for m in batch {
                sink.feed(m).await?;
            }
            sink.flush().await
        };
        match tokio::time::timeout(SEND_TIMEOUT, write).await {
            Ok(Ok(())) => {}
            _ => break,
        }
        if let Some((code, reason)) = close {
            let _ = tokio::time::timeout(
                SEND_TIMEOUT,
                sink.send(Message::Close(Some(CloseFrame {
                    code,
                    reason: reason.into(),
                }))),
            )
            .await;
            break;
        }
        next = rx.recv().await;
    }
}

#[derive(Deserialize)]
pub struct WsParams {
    #[serde(default)]
    ticket: String,
    /// Comma-separated client capabilities; `ext`: keeps SDK blocks (BSDK-02).
    #[serde(default)]
    caps: String,
}

pub async fn upgrade(
    State(state): State<SharedState>,
    Path(room): Path<String>,
    Query(p): Query<WsParams>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    // Draining (SIGTERM): refuse before the upgrade, so the client tries another node instead
    // of looping on an accepted socket that closes at once (docs/22 §8 weakness 7).
    if state.rooms.draining() {
        return Ok((
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::RETRY_AFTER, "5")],
            axum::Json(json!({"error": {"code": "DRAINING", "message": "server is draining"}})),
        )
            .into_response());
    }
    let (host, mut grant) = session(&state, &p.ticket).await?;
    grant.ext_blocks = p.caps.split(',').any(|c| c.trim() == "ext");
    if grant.room != room {
        return Err(ApiError::forbidden("ticket is for another room"));
    }
    {
        let mut tickets = state.tickets.lock().expect("tickets lock");
        let entry = tickets.entry(p.ticket.clone()).or_insert(TicketUse {
            first_seen: Instant::now(),
            connected: false,
        });
        if !entry.connected && entry.first_seen.elapsed() > CONNECT_WINDOW {
            return Err(ApiError::ticket());
        }
        entry.connected = true;
    }
    let limit = state.cfg.rooms.max_frame_bytes;
    Ok(ws_config(ws, limit * 2)
        .on_upgrade(move |socket| serve(state, host, grant, socket, p.ticket)))
}

struct Bucket {
    tokens: f64,
    at: Instant,
    rate: f64,
    burst: f64,
}

impl Bucket {
    fn new(rate: f64, burst: f64) -> Self {
        Self {
            tokens: burst,
            at: Instant::now(),
            rate,
            burst,
        }
    }

    fn take(&mut self) -> bool {
        let now = Instant::now();
        self.tokens =
            (self.tokens + now.duration_since(self.at).as_secs_f64() * self.rate).min(self.burst);
        self.at = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

async fn serve(
    state: SharedState,
    host: std::sync::Arc<HostConfig>,
    grant: Grant,
    socket: WebSocket,
    ticket: String,
) {
    let (mut sink, mut stream) = socket.split();
    let (tx, rx) = mpsc::unbounded_channel::<Outbound>();
    let expires_in = Duration::from_secs(
        (state
            .store
            .session(&ticket)
            .await
            .ok()
            .flatten()
            .map_or(0, |s| s.1)
            - now_secs())
        .max(0) as u64,
    );
    let membership = match state.rooms.join(&host, grant.into(), tx.clone()).await {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(error = %e, "join failed");
            let _ = sink
                .send(Message::Close(Some(CloseFrame {
                    code: 1011,
                    reason: "room unavailable".into(),
                })))
                .await;
            return;
        }
    };
    Metrics::inc(&state.metrics.connections_active);
    let mut writer = tokio::spawn(write_frames(sink, rx));
    let mut writer_done = false;

    let limit = state.cfg.rooms.max_frame_bytes;
    let mut bucket = Bucket::new(RATE_PER_SEC, RATE_BURST);
    let mut awareness = Bucket::new(AWARENESS_PER_SEC, AWARENESS_BURST);
    let expiry = tokio::time::sleep(expires_in);
    tokio::pin!(expiry);
    // Heartbeat (UX-02): browsers can't see WebSocket pings, so a quiet room and a dead
    // network look the same to the client. A control ping every `heartbeat` lets it treat
    // 15 s of silence as a lost connection instead of waiting for TCP to notice.
    let every = state.cfg.rooms.heartbeat;
    let mut heartbeat = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let ping = bytes::Bytes::from(protocol::control(&json!({"t": "ping"})));
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let _ = tx.send(Outbound::Frame(ping.clone()));
            }
            msg = stream.next() => match msg {
                Some(Ok(Message::Binary(data))) => {
                    if data.len() > limit {
                        let _ = tx.send(Outbound::Close(1009, "frame too large".into()));
                        break;
                    }
                    // y-protocols message type 1 = awareness (a single-byte varuint).
                    if data.first() == Some(&protocol::MSG_AWARENESS) {
                        if awareness.take() {
                            membership.send(data.to_vec()).await;
                        }
                        continue;
                    }
                    if !bucket.take() {
                        let _ = tx.send(Outbound::Close(CLOSE_RATE_LIMIT, "rate limit".into()));
                        break;
                    }
                    membership.send(data.to_vec()).await;
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            _ = &mut writer => {
                // The writer gave up (closed, or the client stopped reading): end the session.
                writer_done = true;
                break;
            }
            _ = &mut expiry => {
                let _ = tx.send(Outbound::Frame(protocol::control(&json!({"t": "closed", "reason": "session expired"})).into()));
                let _ = tx.send(Outbound::Close(1008, "session expired".into()));
                break;
            }
        }
    }
    drop(membership);
    drop(tx);
    if !writer_done {
        let _ = tokio::time::timeout(Duration::from_secs(5), &mut writer).await;
    }
    writer.abort();
    Metrics::dec(&state.metrics.connections_active);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// docs/22 §7: an idle connection must not keep tungstenite's 128 KiB default read buffer
    /// (zero-filled, so resident). Guard against the override being dropped or raised.
    #[test]
    fn websocket_read_buffer_stays_small() {
        let default = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
        assert!(
            default.read_buffer_size >= 64 * 1024,
            "default changed: re-measure"
        );
        assert!(
            WS_READ_BUFFER * 8 <= default.read_buffer_size,
            "WS_READ_BUFFER {WS_READ_BUFFER} is close to the default again"
        );
    }

    /// SEC-17: a client that stops reading is dropped once its backlog passes MAX_BACKLOG,
    /// instead of queueing every room update in memory forever.
    #[tokio::test]
    async fn a_client_that_does_not_read_is_dropped() {
        let (tx, rx) = mpsc::unbounded_channel();
        for _ in 0..MAX_BACKLOG + 10 {
            tx.send(Outbound::Frame(vec![0, 2, 1, 0].into())).unwrap();
        }
        let mut sent: Vec<Message> = Vec::new();
        write_frames(&mut sent, rx).await;
        assert_eq!(sent.len(), 1, "nothing but the close frame");
        assert!(
            matches!(&sent[0], Message::Close(Some(f)) if f.code == 1013),
            "{:?}",
            sent[0]
        );
        // A reading client gets everything.
        let (tx, rx) = mpsc::unbounded_channel();
        for _ in 0..10 {
            tx.send(Outbound::Frame(vec![1].into())).unwrap();
        }
        drop(tx);
        let mut sent: Vec<Message> = Vec::new();
        write_frames(&mut sent, rx).await;
        assert_eq!(sent.len(), 10);
    }
}
