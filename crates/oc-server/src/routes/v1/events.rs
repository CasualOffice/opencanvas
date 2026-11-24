// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! HAPI-05 (docs/27 §4.2): `GET /api/v1/files/{fileId}/events` as Server-Sent Events or, when
//! upgraded, a WebSocket of JSON text messages; and `POST /api/v1/files/{fileId}/sync-token`,
//! a session ticket for the room WebSocket so a Yjs-native client syncs the CRDT itself.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::IntoResponse;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use futures::{SinkExt, Stream, StreamExt};
use serde::Deserialize;
use serde_json::json;

use super::problem::Problem;
use super::{Answer, caller, check_file};
use crate::SharedState;
use crate::authz::Via;
use crate::events::{self, FileEvent, Subscription};

/// A WebSocket send that takes longer than this ends the stream as too slow.
const WS_SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// Longest life of a sync ticket (the room WebSocket closes then; connect within 60 s).
pub const SYNC_TICKET_SECS: i64 = 15 * 60;

#[derive(Deserialize, Default)]
pub struct EventsQ {
    /// Resume after this event id (same as the `Last-Event-ID` header, which wins).
    since: Option<String>,
    /// Comma-separated event types to receive (default: all).
    types: Option<String>,
}

/// What the stream sends next.
#[derive(Debug)]
pub enum Out {
    Event(Arc<FileEvent>),
    Close(u16, &'static str),
}

/// `exp` of a bearer token in `headers` (already verified by the caller check).
fn bearer_exp(headers: &HeaderMap) -> Option<i64> {
    use base64::Engine;
    let auth = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = auth.strip_prefix("Bearer ")?.trim();
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()?
        .get("exp")?
        .as_i64()
}

fn parse_types(q: Option<&str>) -> Result<Option<Vec<String>>, Problem> {
    let Some(q) = q.filter(|s| !s.trim().is_empty()) else {
        return Ok(None);
    };
    let mut out = Vec::new();
    for t in q.split(',').map(str::trim).filter(|t| !t.is_empty()) {
        if !events::TYPES.contains(&t) {
            return Err(Problem::bad_request(
                "BAD_INPUT",
                format!(
                    "unknown event type {t:?}; one of {}",
                    events::TYPES.join(", ")
                ),
            ));
        }
        out.push(t.to_string());
    }
    Ok(Some(out))
}

/// Whether the caller lost access since the stream opened.
pub type Revoked = Arc<dyn Fn() -> bool + Send + Sync>;

/// The events of one subscription as a stream: backlog, then live events, ending with a close
/// when the subscriber fell behind, the token expired or access was revoked (checked before
/// every event, so nothing is sent after a revoke).
pub fn stream(
    mut sub: Subscription,
    types: Option<Vec<String>>,
    deadline: Option<tokio::time::Instant>,
    revoked: Revoked,
) -> impl Stream<Item = Out> + Send {
    let backlog: VecDeque<Arc<FileEvent>> = std::mem::take(&mut sub.backlog).into();
    let types = Arc::new(types);
    futures::stream::unfold(
        (sub, backlog, false),
        move |(mut sub, mut backlog, done)| {
            let types = types.clone();
            let revoked = revoked.clone();
            async move {
                if done {
                    return None;
                }
                let wanted = |e: &FileEvent| {
                    e.kind == events::RESYNC
                        || types.as_ref().as_ref().is_none_or(|t| t.contains(&e.kind))
                };
                let close_revoked = Out::Close(events::CLOSE_REVOKED, "access revoked");
                if revoked() {
                    return Some((close_revoked, (sub, backlog, true)));
                }
                while let Some(e) = backlog.pop_front() {
                    if revoked() {
                        return Some((close_revoked, (sub, backlog, true)));
                    }
                    if wanted(&e) {
                        return Some((Out::Event(e), (sub, backlog, false)));
                    }
                }
                loop {
                    if sub.lagged() {
                        let out = Out::Close(
                            events::CLOSE_SLOW,
                            "too slow: reconnect with Last-Event-ID",
                        );
                        return Some((out, (sub, backlog, true)));
                    }
                    let expiry = async {
                        match deadline {
                            Some(d) => tokio::time::sleep_until(d).await,
                            None => std::future::pending().await,
                        }
                    };
                    tokio::select! {
                        ev = sub.rx.recv() => match ev {
                            Some(_) if revoked() => {
                                return Some((close_revoked, (sub, backlog, true)));
                            }
                            Some(e) if wanted(&e) => {
                                return Some((Out::Event(e), (sub, backlog, false)));
                            }
                            Some(_) => continue,
                            None if sub.lagged() => continue,
                            None => return None,
                        },
                        _ = expiry => {
                            let out = Out::Close(
                                events::CLOSE_EXPIRED,
                                "token expired: reconnect with a fresh token",
                            );
                            return Some((out, (sub, backlog, true)));
                        }
                    }
                }
            }
        },
    )
}

/// `GET /api/v1/files/{fileId}/events`.
pub async fn events(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    Query(q): Query<EventsQ>,
    headers: HeaderMap,
    ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
) -> Answer {
    // Not a WebSocket upgrade: Server-Sent Events.
    let ws = ws.ok();
    let p = caller(&state, &headers).await?;
    check_file(&file_id)?;
    p.scope_ok(crate::ai::tools::Scope::Read, "events")?;
    let types = parse_types(q.types.as_deref())?;
    let grant = p.grant(&state, &file_id).await?;
    let last = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or(q.since);
    if last.as_ref().is_some_and(|l| l.len() > 64) {
        return Err(Problem::bad_request(
            "BAD_INPUT",
            "Last-Event-ID is at most 64 characters",
        ));
    }
    let sub = state
        .events()
        .subscribe(&grant.room, &file_id, &p.host.id, last.as_deref())
        .map_err(|_| {
            Problem::new(
                StatusCode::TOO_MANY_REQUESTS,
                "TOO_MANY_STREAMS",
                format!(
                    "at most {} event streams per file on one server",
                    events::MAX_SUBS_PER_ROOM
                ),
            )
            .header(header::RETRY_AFTER, "5")
        })?;
    let deadline = match p.via {
        Via::HostKey => None,
        _ => bearer_exp(&headers).map(|exp| {
            let left = (exp - crate::util::now_secs()).max(0) as u64;
            tokio::time::Instant::now() + Duration::from_secs(left)
        }),
    };
    let revoked: Revoked = {
        let state = state.clone();
        let room = grant.room.clone();
        let user = p.sub.clone();
        let check = p.via != Via::HostKey;
        Arc::new(move || check && state.members.is_revoked(&room, &user))
    };
    tracing::info!(host = %p.host.id, room = %grant.room, ws = ws.is_some(), resume = last.is_some(), "event stream opened");
    let events = stream(sub, types, deadline, revoked);
    if let Some(ws) = ws {
        return Ok(ws.on_upgrade(move |socket| serve_ws(socket, events)));
    }
    let sse = events.map(|o| {
        Ok::<_, std::convert::Infallible>(match o {
            Out::Event(e) => SseEvent::default()
                .id(e.id.clone())
                .event(e.kind.clone())
                .data(e.public().to_string()),
            Out::Close(code, reason) => SseEvent::default()
                .event("close")
                .data(json!({"code": code, "reason": reason}).to_string()),
        })
    });
    let mut res = Sse::new(sse)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    // Proxies (nginx) must not buffer the stream.
    res.headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(res)
}

async fn serve_ws(socket: WebSocket, events: impl Stream<Item = Out> + Send) {
    let (mut sink, mut incoming) = socket.split();
    let mut events = std::pin::pin!(events);
    let mut ping = tokio::time::interval(Duration::from_secs(30));
    ping.tick().await;
    loop {
        tokio::select! {
            o = events.next() => {
                let msg = match o {
                    None => Message::Close(Some(CloseFrame { code: 1000, reason: "".into() })),
                    Some(Out::Event(e)) => Message::Text(e.public().to_string().into()),
                    Some(Out::Close(code, reason)) => {
                        Message::Close(Some(CloseFrame { code, reason: reason.into() }))
                    }
                };
                let close = matches!(msg, Message::Close(_));
                match tokio::time::timeout(WS_SEND_TIMEOUT, sink.send(msg)).await {
                    Ok(Ok(())) if !close => {}
                    Ok(Ok(())) => break,
                    _ => {
                        let _ = tokio::time::timeout(
                            Duration::from_secs(1),
                            sink.send(Message::Close(Some(CloseFrame {
                                code: events::CLOSE_SLOW,
                                reason: "too slow".into(),
                            }))),
                        )
                        .await;
                        break;
                    }
                }
            }
            m = incoming.next() => match m {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => {
                if tokio::time::timeout(WS_SEND_TIMEOUT, sink.send(Message::Ping(Default::default())))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    }
}

/// `POST /api/v1/files/{fileId}/sync-token`: a session ticket for `/v1/collab/{room}?ticket=`
/// with the caller's effective role (docs/27 §4.2 option 2). Connect within 60 s; the room
/// WebSocket closes when the ticket ends (15 minutes at most, never after a user token's
/// `exp`). Never stored for `Idempotency-Key` replays: it is a credential.
pub async fn sync_token(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    check_file(&file_id)?;
    p.scope_ok(crate::ai::tools::Scope::Read, "sync-token")?;
    let grant = p.grant(&state, &file_id).await?;
    let now = crate::util::now_secs();
    let mut exp = now + SYNC_TICKET_SECS;
    if p.via != Via::HostKey
        && let Some(t) = bearer_exp(&headers)
    {
        exp = exp.min(t);
    }
    let ticket = ulid::Ulid::new().to_string();
    state
        .store
        .insert_session(&ticket, &grant, exp, crate::util::now_ms())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "storing a sync ticket failed");
            Problem::new(StatusCode::SERVICE_UNAVAILABLE, "UNAVAILABLE", "try again")
                .header(header::RETRY_AFTER, "1")
        })?;
    tracing::info!(host = %p.host.id, room = %grant.room, role = grant.role.as_str(), "headless sync ticket issued");
    let mut res = Json(json!({
        "ticket": ticket,
        "room": grant.room,
        "role": grant.role.as_str(),
        "url": format!("/v1/collab/{}?ticket={ticket}", grant.room),
        "expiresAt": exp,
        "connectWithinSecs": 60,
    }))
    .into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types_are_checked() {
        assert_eq!(parse_types(None).unwrap(), None);
        assert_eq!(
            parse_types(Some("saved, edited")).unwrap(),
            Some(vec!["saved".to_string(), "edited".to_string()])
        );
        assert!(parse_types(Some("saved,nope")).is_err());
    }

    #[tokio::test]
    async fn the_stream_filters_and_closes_a_slow_subscriber() {
        let hub = events::Hub::with_buffer(2);
        let sub = hub.subscribe("r", "f", "h", None).unwrap();
        let s = stream(sub, Some(vec!["saved".into()]), None, Arc::new(|| false));
        let mut s = std::pin::pin!(s);
        hub.publish(FileEvent::new("h", "r", "f", "edited", json!({})));
        hub.publish(FileEvent::new("h", "r", "f", "saved", json!({})));
        match s.next().await {
            Some(Out::Event(e)) => assert_eq!(e.kind, "saved"),
            o => panic!("{o:?}"),
        }
        for _ in 0..3 {
            hub.publish(FileEvent::new("h", "r", "f", "saved", json!({})));
        }
        match s.next().await {
            Some(Out::Close(code, _)) => assert_eq!(code, events::CLOSE_SLOW),
            o => panic!("{o:?}"),
        }
        assert!(s.next().await.is_none());
    }

    #[tokio::test]
    async fn revoked_and_expired_streams_close() {
        let hub = events::Hub::new();
        let sub = hub.subscribe("r", "f", "h", None).unwrap();
        let mut s = std::pin::pin!(stream(sub, None, None, Arc::new(|| true)));
        assert!(matches!(
            s.next().await,
            Some(Out::Close(events::CLOSE_REVOKED, _))
        ));
        let sub = hub.subscribe("r", "f", "h", None).unwrap();
        let past = tokio::time::Instant::now();
        let mut s = std::pin::pin!(stream(sub, None, Some(past), Arc::new(|| false)));
        assert!(matches!(
            s.next().await,
            Some(Out::Close(events::CLOSE_EXPIRED, _))
        ));
    }
}
