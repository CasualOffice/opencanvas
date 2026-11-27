// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! HAPI-05 (docs/27 §4.2): `GET /api/v1/files/{id}/events` over SSE and WebSocket (edited,
//! commented, mentioned, member joined/left, saved, restored, session closed; resume with
//! `Last-Event-ID`; scopes), and `POST …/sync-token` for headless CRDT sync. Every wait is for
//! an event to arrive (with a generous bound), never a fixed sleep.
mod common;

use std::time::Duration;

use common::*;
use futures::StreamExt;
use oc_server::grant::Role;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use yrs::{
    Any, Array, ArrayPrelim, Doc, Map, MapPrelim, Transact, Xml, XmlElementPrelim, XmlFragment,
    XmlTextPrelim,
};

const API_KEY: &str = "test-api-key";
const PUBLIC: &str = "https://oc.example";

fn api_on(h: &mut oc_server::hosts::HostConfig) {
    h.api_key = Some(API_KEY.into());
    h.flags.insert("api_v1".into(), toml::Value::Boolean(true));
    h.api
        .insert("audience".into(), toml::Value::String(PUBLIC.into()));
}

async fn serve() -> (String, oc_server::SharedState, Shared) {
    let (base, host) = mock_host().await;
    let state = app_custom(&base, room_cfg(), &temp_db(), api_on).await;
    (serve_state(state.clone()).await, state, host)
}

fn req(addr: &str, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .request(method, format!("http://{addr}{path}"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", API_KEY)
}

fn f(path: &str) -> String {
    format!("/api/v1/files/{FILE}{path}")
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn token(scope: &str, files: &[&str]) -> String {
    let c = json!({"iss": "sample", "aud": format!("{PUBLIC}/api/v1"), "sub": "u_api",
        "exp": now() + 600, "scope": scope, "role": "edit", "files": files});
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        &c,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()).unwrap(),
    )
    .unwrap()
}

/// One parsed SSE message.
#[derive(Debug, Clone)]
struct Sse {
    id: Option<String>,
    event: String,
    data: Value,
}

/// A Server-Sent Events reader over a streaming response.
struct SseReader {
    body: futures::stream::BoxStream<'static, reqwest::Result<bytes::Bytes>>,
    buf: String,
}

impl SseReader {
    async fn open(rb: reqwest::RequestBuilder) -> (u16, reqwest::header::HeaderMap, Self) {
        let res = rb.send().await.unwrap();
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        (
            status,
            headers,
            Self {
                body: res.bytes_stream().boxed(),
                buf: String::new(),
            },
        )
    }

    /// The next message (keep-alive comments skipped); panics after 10 s without one.
    async fn next(&mut self) -> Sse {
        loop {
            if let Some(i) = self.buf.find("\n\n") {
                let frame: String = self.buf.drain(..i + 2).collect();
                let mut ev = Sse {
                    id: None,
                    event: "message".into(),
                    data: Value::Null,
                };
                let mut data = String::new();
                for line in frame.lines() {
                    if let Some(v) = line.strip_prefix("id:") {
                        ev.id = Some(v.trim().to_string());
                    } else if let Some(v) = line.strip_prefix("event:") {
                        ev.event = v.trim().to_string();
                    } else if let Some(v) = line.strip_prefix("data:") {
                        data.push_str(v.trim());
                    }
                }
                if data.is_empty() {
                    continue;
                }
                ev.data = serde_json::from_str(&data).unwrap();
                return ev;
            }
            let chunk = tokio::time::timeout(Duration::from_secs(10), self.body.next())
                .await
                .expect("an event within 10 s")
                .expect("stream open")
                .unwrap();
            self.buf.push_str(&String::from_utf8_lossy(&chunk));
        }
    }

    /// The next message of type `kind`, skipping others.
    async fn next_of(&mut self, kind: &str) -> Sse {
        loop {
            let e = self.next().await;
            if e.event == kind {
                return e;
            }
        }
    }
}

fn mention_para(doc: &Doc, block: &str, who: &str) {
    let content = doc.get_or_insert_xml_fragment("content");
    let mut txn = doc.transact_mut();
    let p = content.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    p.insert_attribute(&mut txn, "blockId", block);
    p.push_back(&mut txn, XmlTextPrelim::new("ping "));
    let m = p.push_back(&mut txn, XmlElementPrelim::empty("mention"));
    m.insert_attribute(&mut txn, "id", who);
    m.insert_attribute(&mut txn, "label", "Sam");
}

fn comment(doc: &Doc, thread: &str, block: &str) {
    let comments = doc.get_or_insert_map("comments");
    let mut txn = doc.transact_mut();
    let t = comments.insert(&mut txn, thread, MapPrelim::default());
    t.insert(&mut txn, "blockId", block);
    let msgs = t.insert(&mut txn, "messages", ArrayPrelim::default());
    let m = msgs.push_back(&mut txn, MapPrelim::default());
    m.insert(&mut txn, "user", "u_a");
    m.insert(&mut txn, "text", "secret words");
    m.insert(&mut txn, "mentions", Any::from(vec![Any::from("u_sam")]));
}

#[tokio::test]
async fn sse_reports_every_kind_of_change_without_content() {
    let (addr, state, _host) = serve().await;
    let (status, headers, mut sse) =
        SseReader::open(req(&addr, reqwest::Method::GET, &f("/events"))).await;
    assert_eq!(status, 200);
    assert!(
        headers["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/event-stream")
    );

    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let e = sse.next_of("member.joined").await;
    assert_eq!(e.data["data"], json!({"userId": "u_a", "role": "edit"}));
    assert_eq!(e.data["fileId"], FILE);
    assert_eq!(e.data["type"], "member.joined");
    assert_eq!(e.id.as_deref(), e.data["id"].as_str());
    a.settle().await;

    // A program's write: one debounced `edited` with the new block ids.
    let (s, out) = {
        let res = req(&addr, reqwest::Method::POST, &f("/blocks:batch"))
            .header("X-OpenCanvas-Author", "bot-1")
            .json(
                &json!({"ops": [{"op": "append", "blocks": [{"type": "paragraph",
                "attrs": {"blockId": "b_one"}, "content": [{"type": "text", "text": "Hello"}]}]}]}),
            )
            .send()
            .await
            .unwrap();
        (res.status().as_u16(), res.json::<Value>().await.unwrap())
    };
    assert_eq!(s, 200, "{out}");
    let e = sse.next_of("edited").await;
    assert_eq!(e.data["data"]["blockIds"], json!(["b_one"]));
    assert_eq!(e.data["data"]["by"], json!(["bot-1"]));
    assert!(
        !e.data.to_string().contains("Hello"),
        "no content: {}",
        e.data
    );
    a.settle().await;

    // A person's typing and a comment with a mention.
    a.edit(|d| mention_para(d, "b_two", "u_sam"));
    let e = sse.next_of("edited").await;
    assert_eq!(e.data["data"]["blockIds"], json!(["b_two"]));
    assert_eq!(e.data["data"]["by"], json!(["u_a"]));
    let e = sse.next_of("mentioned").await;
    assert_eq!(
        e.data["data"],
        json!({"mentioned": ["u_sam"], "by": "u_a", "blockId": "b_two"})
    );
    a.edit(|d| comment(d, "t_1", "b_two"));
    let e = sse.next_of("commented").await;
    assert_eq!(
        e.data["data"],
        json!({"threadId": "t_1", "blockId": "b_two", "added": 1, "by": ["u_a"]})
    );
    assert!(!e.data.to_string().contains("secret words"));
    let e = sse.next_of("mentioned").await;
    assert_eq!(e.data["data"]["threadId"], "t_1");

    // Removing a block names it.
    a.edit(|d| {
        let content = d.get_or_insert_xml_fragment("content");
        let mut txn = d.transact_mut();
        content.remove_range(&mut txn, 0, 1);
    });
    let e = sse.next_of("edited").await;
    assert_eq!(
        e.data["data"]["removedBlockIds"],
        json!(["b_one"]),
        "{}",
        e.data
    );

    // Saved, then the person leaves and the host closes the session.
    let res = req(&addr, reqwest::Method::POST, &f("/commit"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let e = sse.next_of("saved").await;
    assert!(e.data["data"]["version"].is_string(), "{}", e.data);
    a.leave();
    let e = sse.next_of("member.left").await;
    assert_eq!(e.data["data"], json!({"userId": "u_a"}));
    let res = req(&addr, reqwest::Method::DELETE, &f("/session"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let e = sse.next_of("session.closed").await;
    assert_eq!(e.data["data"], json!({"reason": "host"}));
}

#[tokio::test]
async fn last_event_id_resumes_from_the_ring_or_asks_for_a_resync() {
    let (addr, state, _host) = serve().await;
    let (_, _, mut sse) = SseReader::open(req(&addr, reqwest::Method::GET, &f("/events"))).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let first = sse.next_of("member.joined").await;
    a.settle().await;
    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    let second = sse.next_of("member.joined").await;
    b.settle().await;
    a.leave();
    let third = sse.next_of("member.left").await;
    drop(sse);

    let (_, _, mut again) = SseReader::open(
        req(&addr, reqwest::Method::GET, &f("/events"))
            .header("Last-Event-ID", first.id.clone().unwrap()),
    )
    .await;
    let r1 = again.next().await;
    let r2 = again.next().await;
    assert_eq!((r1.id, r2.id), (second.id.clone(), third.id.clone()));

    // `since` does the same; the header wins over it.
    let (_, _, mut q) = SseReader::open(req(
        &addr,
        reqwest::Method::GET,
        &f(&format!("/events?since={}", second.id.clone().unwrap())),
    ))
    .await;
    assert_eq!(q.next().await.id, third.id);

    let (_, _, mut lost) = SseReader::open(
        req(&addr, reqwest::Method::GET, &f("/events")).header("Last-Event-ID", "ev_gone"),
    )
    .await;
    let r = lost.next().await;
    assert_eq!(r.event, "resync");
    assert_eq!(r.id, third.id, "resync points at the newest event");

    // A type filter.
    let (_, _, mut only) = SseReader::open(req(
        &addr,
        reqwest::Method::GET,
        &f("/events?types=member.left"),
    ))
    .await;
    b.leave();
    let e = only.next().await;
    assert_eq!(
        (e.event.as_str(), &e.data["data"]["userId"]),
        ("member.left", &json!("u_b"))
    );
}

#[tokio::test]
async fn websocket_events_and_scope_checks() {
    let (addr, state, _host) = serve().await;
    let mut r = format!("ws://{addr}{}", f("/events"))
        .into_client_request()
        .unwrap();
    r.headers_mut().insert(
        "authorization",
        format!("Bearer {}", token("canvas:read", &[FILE]))
            .parse()
            .unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(r).await.unwrap();
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let v: Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "member.joined");
    assert!(v["id"].as_str().unwrap().starts_with("ev_"));
    a.settle().await;

    // A token for another file, no canvas scope, or a bad filter: refused before streaming.
    let other = token("canvas:read", &["doc_other"]);
    let res = reqwest::Client::new()
        .get(format!("http://{addr}{}", f("/events")))
        .bearer_auth(other)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    let res = req(&addr, reqwest::Method::GET, &f("/events?types=nope"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    let res = reqwest::Client::new()
        .get(format!("http://{addr}{}", f("/events")))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn a_revoked_user_stream_is_closed() {
    let (addr, state, _host) = serve().await;
    let tok = token("canvas:read", &[FILE]);
    let (_, _, mut sse) = SseReader::open(
        reqwest::Client::new()
            .get(format!("http://{addr}{}", f("/events")))
            .bearer_auth(&tok),
    )
    .await;
    let res = req(&addr, reqwest::Method::POST, &f("/role"))
        .json(&json!({"userId": "u_api", "role": "none"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    // The next event finds the revoke: nothing more is sent.
    let _a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let e = sse.next().await;
    assert_eq!(e.event, "close", "{e:?}");
    assert_eq!(e.data["code"], 4003);
}

#[tokio::test]
async fn sync_token_opens_the_room_websocket_with_the_effective_role() {
    let (addr, _state, _host) = serve().await;
    let tok = token("canvas:read", &[FILE]);
    let res = reqwest::Client::new()
        .post(format!("http://{addr}{}", f("/sync-token")))
        .bearer_auth(&tok)
        .header("Idempotency-Key", "k1")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["cache-control"], "no-store");
    assert!(res.headers().get("idempotency-replayed").is_none());
    let v: Value = res.json().await.unwrap();
    assert_eq!(v["role"], "view", "canvas:read caps the role: {v}");
    assert!(v["expiresAt"].as_i64().unwrap() <= now() + 600);
    // The same key again gets a fresh ticket: credentials are never replayed.
    let again: Value = reqwest::Client::new()
        .post(format!("http://{addr}{}", f("/sync-token")))
        .bearer_auth(&tok)
        .header("Idempotency-Key", "k1")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_ne!(again["ticket"], v["ticket"]);

    let url = format!("ws://{addr}{}", v["url"].as_str().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    // The room greets a client with sync step 1 (binary y-protocols frame).
    let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(msg.is_binary(), "{msg:?}");
    assert_eq!(msg.into_data()[0], 0, "sync message");

    // Host key: full role.
    let v: Value = req(&addr, reqwest::Method::POST, &f("/sync-token"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(v["role"], "edit");
}
