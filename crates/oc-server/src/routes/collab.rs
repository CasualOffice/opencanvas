//! `GET /v1/collab/:room?ticket=` WebSocket (docs/15 §3).

use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::response::Response;
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

#[derive(Deserialize)]
pub struct WsParams {
    #[serde(default)]
    ticket: String,
}

pub async fn upgrade(
    State(state): State<SharedState>,
    Path(room): Path<String>,
    Query(p): Query<WsParams>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &p.ticket).await?;
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
    Ok(ws
        .max_message_size(limit * 2)
        .max_frame_size(limit * 2)
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
    let (tx, mut rx) = mpsc::unbounded_channel::<Outbound>();
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
    let writer = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            let msg = match out {
                Outbound::Frame(b) => Message::Binary(b.into()),
                Outbound::Close(code, reason) => {
                    let _ = sink
                        .send(Message::Close(Some(CloseFrame {
                            code,
                            reason: reason.into(),
                        })))
                        .await;
                    break;
                }
            };
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    let limit = state.cfg.rooms.max_frame_bytes;
    let mut bucket = Bucket::new(RATE_PER_SEC, RATE_BURST);
    let mut awareness = Bucket::new(AWARENESS_PER_SEC, AWARENESS_BURST);
    let expiry = tokio::time::sleep(expires_in);
    tokio::pin!(expiry);
    loop {
        tokio::select! {
            msg = stream.next() => match msg {
                Some(Ok(Message::Binary(data))) => {
                    if data.len() > limit {
                        let _ = tx.send(Outbound::Close(1009, "frame too large".into()));
                        break;
                    }
                    // y-protocols message type 1 = awareness (a single-byte varuint).
                    if data.first() == Some(&protocol::MSG_AWARENESS) {
                        if awareness.take() {
                            membership.send(data.to_vec());
                        }
                        continue;
                    }
                    if !bucket.take() {
                        let _ = tx.send(Outbound::Close(CLOSE_RATE_LIMIT, "rate limit".into()));
                        break;
                    }
                    membership.send(data.to_vec());
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            _ = &mut expiry => {
                let _ = tx.send(Outbound::Frame(protocol::control(&json!({"t": "closed", "reason": "session expired"}))));
                let _ = tx.send(Outbound::Close(1008, "session expired".into()));
                break;
            }
        }
    }
    drop(membership);
    drop(tx);
    let _ = tokio::time::timeout(Duration::from_secs(5), writer).await;
    Metrics::dec(&state.metrics.connections_active);
}
