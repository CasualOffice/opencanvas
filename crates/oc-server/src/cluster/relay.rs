// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Edge side of the relay: a client connected to a node that does not own its room gets one
//! internal WebSocket to the owner. One socket per client connection keeps per-connection
//! order (TCP), and the owner sees the relayed connection exactly like a local one.

use std::time::Duration;

use base64::Engine;
use futures::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, Message, client::IntoClientRequest};

use super::lease::Owner;
use super::{Cluster, H_GRANT, RemoteError};
use crate::grant::Grant;
use crate::room::{Cmd, Outbound, protocol};

/// Close code + control frame a client gets when it must reconnect (drain, owner moved).
pub const RECONNECT: u16 = 1012;

pub fn reconnect_frame() -> Vec<u8> {
    protocol::control(&json!({"t": "reconnect"}))
}

fn ws_url(http: &str) -> String {
    if let Some(rest) = http.strip_prefix("https://") {
        format!("wss://{rest}")
    } else {
        format!("ws://{}", http.trim_start_matches("http://"))
    }
}

/// Opens the relay to `owner`. Frames sent into the returned channel (`Cmd::Frame`) go to the
/// owner in order; owner frames go to `out`. `on_end` runs when the relay stops.
pub(crate) async fn connect(
    cluster: &Cluster,
    owner: &Owner,
    grant: &Grant,
    out: mpsc::UnboundedSender<Outbound>,
    on_end: Box<dyn FnOnce() + Send>,
) -> Result<mpsc::UnboundedSender<Cmd>, RemoteError> {
    let grant_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(grant).map_err(|e| RemoteError::Failed(e.to_string()))?);
    let url = format!("{}/v1/internal/relay/{}", ws_url(&owner.url), grant.room);
    let mut req = url
        .into_client_request()
        .map_err(|e| RemoteError::Failed(e.to_string()))?;
    let headers = req.headers_mut();
    for (k, v) in cluster.sign(&grant.room, grant_b64.as_bytes()) {
        headers.insert(k, v.parse().expect("header value"));
    }
    headers.insert(H_GRANT, grant_b64.parse().expect("header value"));
    let connected = tokio::time::timeout(
        Duration::from_secs(3),
        tokio_tungstenite::connect_async(req),
    )
    .await;
    let ws = match connected {
        Err(_) => return Err(RemoteError::Unreachable("relay connect timed out".into())),
        Ok(Err(tungstenite::Error::Http(resp))) => {
            return match resp.status().as_u16() {
                409 | 503 => Err(RemoteError::Moved),
                s => Err(RemoteError::Failed(format!("owner refused the relay: {s}"))),
            };
        }
        Ok(Err(e)) => return Err(RemoteError::Unreachable(e.to_string())),
        Ok(Ok((ws, _))) => ws,
    };
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Cmd>();
    let room = grant.room.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(Cmd::Frame { data, .. }) => {
                        if sink.send(Message::Binary(data.into())).await.is_err() {
                            let _ = out.send(Outbound::Frame(reconnect_frame().into()));
                            let _ = out.send(Outbound::Close(RECONNECT, "owner moved".into()));
                            break;
                        }
                    }
                    Some(Cmd::Leave { .. }) | None => {
                        let _ = sink.send(Message::Close(None)).await;
                        break;
                    }
                    Some(_) => {}
                },
                msg = stream.next() => match msg {
                    Some(Ok(Message::Binary(b))) => {
                        let _ = out.send(Outbound::Frame(b));
                    }
                    Some(Ok(Message::Close(Some(cf)))) => {
                        let _ = out.send(Outbound::Close(cf.code.into(), cf.reason.to_string()));
                        break;
                    }
                    Some(Ok(Message::Close(None))) | None | Some(Err(_)) => {
                        // The owner went away without a word (crash): the client reconnects and
                        // lands on whichever node now owns the room.
                        tracing::info!(room = %room, "relay to owner lost; client told to reconnect");
                        let _ = out.send(Outbound::Frame(reconnect_frame().into()));
                        let _ = out.send(Outbound::Close(RECONNECT, "owner moved".into()));
                        break;
                    }
                    Some(Ok(_)) => {}
                },
            }
        }
        on_end();
    });
    Ok(tx)
}
