// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Save conflicts over a real WebSocket: an in-process mock host answers 409 to PUT, and the
//! host's `on_conflict` policy plays out on the wire (docs/15 §3, §7).
mod common;

use std::time::Duration;

use common::*;
use futures::{SinkExt, StreamExt};
use oc_server::SharedState;
use oc_server::config::RoomConfig;
use oc_server::grant::Role;
use oc_server::room::protocol;
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use yrs::encoding::read::Cursor;
use yrs::sync::protocol::MessageReader;
use yrs::sync::{Message, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::{Doc, ReadTxn, Text, Transact, Update, XmlFragment, XmlTextPrelim, XmlTextRef};

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// A y-websocket client over a real socket.
struct Client {
    ws: Ws,
    doc: Doc,
    controls: Vec<Value>,
    denied: usize,
    closed: Option<u16>,
}

impl Client {
    async fn connect(addr: &str, state: &SharedState, user: &str) -> Client {
        let g = grant(user, Role::Edit);
        let ticket = format!("01TICKET{}{}", user.to_uppercase(), ulid::Ulid::new());
        state
            .store
            .insert_session(&ticket, &g, i64::MAX / 2, 0)
            .await
            .unwrap();
        Self::reconnect(addr, &g.room, &ticket).await
    }

    async fn reconnect(addr: &str, room: &str, ticket: &str) -> Client {
        let (ws, _) = tokio_tungstenite::connect_async(format!(
            "ws://{addr}/v1/collab/{room}?ticket={ticket}"
        ))
        .await
        .unwrap();
        let mut c = Client {
            ws,
            doc: Doc::new(),
            controls: vec![],
            denied: 0,
            closed: None,
        };
        let sv = c.doc.transact().state_vector();
        c.ws.send(WsMessage::Binary(protocol::step1(sv).into()))
            .await
            .unwrap();
        c.pump().await;
        c
    }

    /// Reads frames until the line is quiet for 300 ms or the server closes.
    async fn pump(&mut self) {
        while self.closed.is_none() {
            let Ok(Some(Ok(msg))) =
                tokio::time::timeout(Duration::from_millis(300), self.ws.next()).await
            else {
                return;
            };
            match msg {
                WsMessage::Binary(data) => {
                    let mut d = DecoderV1::new(Cursor::new(&data));
                    let msgs: Vec<Message> = MessageReader::new(&mut d)
                        .collect::<Result<_, _>>()
                        .unwrap();
                    for m in msgs {
                        match m {
                            Message::Sync(SyncMessage::SyncStep1(sv)) => {
                                let diff = self.doc.transact().encode_state_as_update_v1(&sv);
                                let _ = self
                                    .ws
                                    .send(WsMessage::Binary(protocol::step2(diff).into()))
                                    .await;
                            }
                            Message::Sync(SyncMessage::SyncStep2(u) | SyncMessage::Update(u)) => {
                                self.doc
                                    .transact_mut()
                                    .apply_update(Update::decode_v1(&u).unwrap())
                                    .unwrap();
                            }
                            Message::Custom(100, b) => {
                                self.controls.push(serde_json::from_slice(&b).unwrap())
                            }
                            Message::Auth(Some(_)) => self.denied += 1,
                            _ => {}
                        }
                    }
                }
                WsMessage::Close(f) => self.closed = Some(f.map_or(1005, |f| u16::from(f.code))),
                _ => {}
            }
        }
    }

    async fn type_text(&mut self, s: &str) {
        let sv = self.doc.transact().state_vector();
        {
            let content = self.doc.get_or_insert_xml_fragment("content");
            let mut txn = self.doc.transact_mut();
            let first: Option<XmlTextRef> = content.get(&txn, 0).and_then(|n| n.into_xml_text());
            match first {
                Some(t) => t.push(&mut txn, s),
                None => {
                    content.push_back(&mut txn, XmlTextPrelim::new(s));
                }
            }
        }
        let update = self.doc.transact().encode_state_as_update_v1(&sv);
        self.ws
            .send(WsMessage::Binary(protocol::update(update).into()))
            .await
            .unwrap();
    }

    fn text(&self) -> String {
        json_of(&self.doc)["content"]
            .as_array()
            .map(|a| a.iter().filter_map(|n| n["text"].as_str()).collect())
            .unwrap_or_default()
    }
}

fn fast() -> RoomConfig {
    RoomConfig {
        autosave_debounce: Duration::from_millis(50),
        ..room_cfg()
    }
}

fn ocanvas_with(text: &str) -> Vec<u8> {
    let d = oc_model::new_doc();
    {
        let content = d.get_or_insert_xml_fragment("content");
        let mut txn = d.transact_mut();
        content.push_back(&mut txn, XmlTextPrelim::new(text));
    }
    oc_model::write_ocanvas(&d, &oc_model::CommitInfo::default()).unwrap()
}

#[tokio::test]
async fn copy_policy_posts_a_copy_announces_it_and_refuses_further_writes() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().conflict = true;
    let state = app(&base, fast()).await;
    let addr = serve_state(state.clone()).await;
    let mut a = Client::connect(&addr, &state, "u_a").await;
    let mut b = Client::connect(&addr, &state, "u_b").await;

    a.type_text("mine").await;
    wait_until(|| !host.lock().unwrap().copies.is_empty()).await;
    a.pump().await;
    b.pump().await;

    let (puts, copy) = {
        let h = host.lock().unwrap();
        (h.puts.len(), h.copies[0].clone())
    };
    assert_eq!(puts, 1, "the PUT that got the 409");
    assert!(copy.signature_ok);
    assert!(
        copy.headers["authorization"]
            .to_str()
            .unwrap()
            .starts_with("Bearer cb-u_")
    );
    assert!(copy.headers.contains_key("idempotency-key"));
    assert_eq!(ocanvas_text(&copy.body), "mine");

    for c in [&a, &b] {
        let conflict = c
            .controls
            .iter()
            .find(|m| m["t"] == "conflict")
            .unwrap_or_else(|| panic!("no conflict control: {:?}", c.controls));
        assert_eq!(conflict["policy"], "copy");
        assert_eq!(conflict["fileId"], "doc_1_copy1");
        assert_eq!(conflict["url"], "http://host/files/doc_1_copy1");
        assert!(
            c.closed.is_none(),
            "copy policy keeps sockets open (read-only)"
        );
    }

    // Further writes are refused with an auth frame and never reach the other client.
    b.type_text(" theirs").await;
    b.pump().await;
    a.pump().await;
    assert_eq!(b.denied, 1);
    assert_eq!(a.text(), "mine");
    assert_eq!(content_text_of(&server_json(&state).await), "mine");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let h = host.lock().unwrap();
    assert_eq!(h.puts.len(), 1, "no saves after the conflict");
    assert_eq!(h.copies.len(), 1, "one copy");
}

fn content_text_of(v: &Value) -> String {
    v["content"]
        .as_array()
        .map(|a| a.iter().filter_map(|n| n["text"].as_str()).collect())
        .unwrap_or_default()
}

#[tokio::test]
async fn reload_policy_closes_with_1012_and_reconnects_onto_the_host_version() {
    let (base, host) = mock_host().await;
    host.lock()
        .unwrap()
        .files
        .insert(FILE.into(), (ocanvas_with("original"), 0));
    let state = app_custom(&base, fast(), &temp_db(), |h| {
        h.flags.insert("on_conflict".into(), "reload".into());
    })
    .await;
    let addr = serve_state(state.clone()).await;
    let g = grant("u_a", Role::Edit);
    let ticket = "01TICKETRELOAD000000000000";
    state
        .store
        .insert_session(ticket, &g, i64::MAX / 2, 0)
        .await
        .unwrap();
    let mut a = Client::reconnect(&addr, &g.room, ticket).await;
    assert_eq!(a.text(), "original");

    // The file changes outside the session; our next save gets 409.
    host.lock()
        .unwrap()
        .files
        .insert(FILE.into(), (ocanvas_with("theirs"), 7));
    a.type_text(" + stale edit").await;
    wait_until(|| !host.lock().unwrap().puts.is_empty()).await;
    for _ in 0..10 {
        a.pump().await;
        if a.closed.is_some() {
            break;
        }
    }
    let ts: Vec<&str> = a.controls.iter().filter_map(|c| c["t"].as_str()).collect();
    let conflict = ts.iter().position(|t| *t == "conflict").expect("conflict");
    let closed = ts.iter().position(|t| *t == "closed").expect("closed");
    assert!(conflict < closed, "{ts:?}");
    assert!(
        a.controls
            .iter()
            .any(|c| c["t"] == "conflict" && c["policy"] == "reload")
    );
    assert_eq!(a.closed, Some(1012));
    assert!(host.lock().unwrap().copies.is_empty());

    // Reconnecting with a fresh Y.Doc gets the host's version, not the stale room state.
    let mut again = Client::reconnect(&addr, &g.room, ticket).await;
    assert_eq!(again.text(), "theirs");
    assert!(!again.text().contains("stale"));
    assert!(again.closed.is_none());
    // And saving works again against the new base version.
    again.type_text("!").await;
    wait_until(|| host.lock().unwrap().files[FILE].1 == 8).await;
    let last = host.lock().unwrap().puts.last().unwrap().clone();
    assert_eq!(last.headers["if-match"], "\"7\"");
    assert_eq!(ocanvas_text(&last.body), "theirs!");
    again.pump().await;
}
