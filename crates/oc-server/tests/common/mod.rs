#![allow(dead_code)]
//! Test harness: an in-process mock host, a temp SQLite store and simulated y-websocket peers.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use oc_server::config::{Config, RoomConfig};
use oc_server::grant::{FileRef, Grant, Perms, Role, User, room_id};
use oc_server::host_client::signature;
use oc_server::hosts::{HostConfig, Hosts};
use oc_server::room::{Membership, Outbound, protocol};
use oc_server::{AppState, SharedState};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use yrs::encoding::read::Cursor;
use yrs::sync::protocol::MessageReader;
use yrs::sync::{Message, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

pub const SECRET: &str = "dev-secret-change-me";
pub const FILE: &str = "doc_1";

#[derive(Clone, Debug)]
pub struct RecordedPut {
    pub headers: HeaderMap,
    pub body: Vec<u8>,
    pub signature_ok: bool,
}

#[derive(Default)]
pub struct HostState {
    pub files: HashMap<String, (Vec<u8>, u64)>,
    pub puts: Vec<RecordedPut>,
    pub gets: usize,
    pub conflict: bool,
}

pub type Shared = Arc<Mutex<HostState>>;

fn verify(headers: &HeaderMap, body: &[u8]) -> bool {
    let Some(sig) = headers
        .get("x-opencanvas-signature")
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let Some(t) = sig
        .strip_prefix("t=")
        .and_then(|s| s.split(',').next())
        .and_then(|t| t.parse::<i64>().ok())
    else {
        return false;
    };
    signature(SECRET.as_bytes(), t, body) == sig
}

async fn get_file(
    State(s): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let mut st = s.lock().unwrap();
    st.gets += 1;
    if !verify(&headers, b"") {
        return (StatusCode::UNAUTHORIZED, HeaderMap::new(), Vec::new());
    }
    match st.files.get(&id) {
        Some((bytes, v)) => {
            let mut h = HeaderMap::new();
            h.insert("etag", format!("\"{v}\"").parse().unwrap());
            h.insert(
                "content-type",
                "application/vnd.opencanvas+zip".parse().unwrap(),
            );
            (StatusCode::OK, h, bytes.clone())
        }
        None => (StatusCode::NOT_FOUND, HeaderMap::new(), Vec::new()),
    }
}

async fn put_file(
    State(s): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let mut st = s.lock().unwrap();
    let signature_ok = verify(&headers, &body);
    st.puts.push(RecordedPut {
        headers: headers.clone(),
        body: body.to_vec(),
        signature_ok,
    });
    let current = st.files.get(&id).map_or(0, |f| f.1);
    let if_match = headers
        .get("if-match")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim_matches('"').to_string());
    if st.conflict || if_match.is_some_and(|m| m != current.to_string()) {
        return (
            StatusCode::CONFLICT,
            axum::Json(json!({"version": current.to_string()})),
        );
    }
    st.files.insert(id, (body.to_vec(), current + 1));
    (
        StatusCode::OK,
        axum::Json(json!({"version": (current + 1).to_string()})),
    )
}

async fn users(headers: HeaderMap) -> impl IntoResponse {
    if !verify(&headers, b"") {
        return (StatusCode::UNAUTHORIZED, axum::Json(json!([])));
    }
    (
        StatusCode::OK,
        axum::Json(json!([{"id": "u_1", "name": "Asha Rao", "avatar": null}])),
    )
}

/// Starts the mock host; returns its callback base URL and shared state.
pub async fn mock_host() -> (String, Shared) {
    let state: Shared = Arc::default();
    let app = Router::new()
        .route("/api/files/{id}", get(get_file).put(put_file))
        .route("/api/users", get(users))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}/api"), state)
}

pub fn host_config(base: &str) -> HostConfig {
    HostConfig {
        id: "sample".into(),
        name: "Sample".into(),
        mode: "jwt".into(),
        jwt_alg: "HS256".into(),
        jwt_secret: Some(SECRET.into()),
        jwt_public_key: None,
        callback_secret: None,
        api_key: None,
        callback_base: base.into(),
        allowed_origins: vec!["http://localhost:4000".into()],
        flags: Default::default(),
    }
}

pub fn room_cfg() -> RoomConfig {
    RoomConfig {
        autosave_debounce: Duration::from_secs(3600),
        autosave_max: Duration::from_secs(3600),
        tick: Duration::from_millis(20),
        ..RoomConfig::default()
    }
}

pub async fn app(base: &str, rooms: RoomConfig) -> SharedState {
    let db = std::env::temp_dir().join(format!("oc-test-{}.db", ulid::Ulid::new()));
    let cfg = Config {
        bind: "127.0.0.1:0".into(),
        public_url: None,
        database_url: format!("sqlite://{}?mode=rwc", db.display()),
        hosts_file: "unused".into(),
        web_dir: "unused".into(),
        callback_base_override: None,
        rooms,
    };
    AppState::new(cfg, Hosts::from_list(vec![host_config(base)]))
        .await
        .unwrap()
}

pub fn grant(user: &str, role: Role) -> Grant {
    Grant {
        host_id: "sample".into(),
        room: room_id("sample", FILE),
        role,
        user: User {
            id: user.into(),
            name: format!("Name of {user}"),
            color: "#123456".into(),
            avatar: None,
        },
        file: FileRef {
            id: FILE.into(),
            name: "Doc one".into(),
            version: Some("0".into()),
        },
        perms: Perms {
            export: true,
            download: true,
            comment: true,
        },
        callback_token: format!("cb-{user}"),
    }
}

/// A y-websocket-like peer talking to a room through channels.
pub struct Peer {
    pub doc: Doc,
    pub membership: Option<Membership>,
    rx: mpsc::UnboundedReceiver<Outbound>,
    pub controls: Vec<Value>,
    pub denied: usize,
    pub awareness: Vec<yrs::sync::AwarenessUpdate>,
}

impl Peer {
    pub async fn join(state: &SharedState, g: Grant) -> Peer {
        let host = state.hosts.get("sample").unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        let membership = state.rooms.join(&host, Arc::new(g), tx).await.unwrap();
        let doc = Doc::new();
        let peer = Peer {
            doc,
            membership: Some(membership),
            rx,
            controls: vec![],
            denied: 0,
            awareness: vec![],
        };
        let sv = peer.doc.transact().state_vector();
        peer.send(protocol::step1(sv));
        peer
    }

    pub fn send(&self, frame: Vec<u8>) {
        self.membership.as_ref().unwrap().send(frame);
    }

    fn on_frame(&mut self, data: &[u8]) {
        let mut d = DecoderV1::new(Cursor::new(data));
        let msgs: Vec<Message> = MessageReader::new(&mut d)
            .collect::<Result<_, _>>()
            .unwrap();
        for m in msgs {
            match m {
                Message::Sync(SyncMessage::SyncStep1(sv)) => {
                    let diff = self.doc.transact().encode_state_as_update_v1(&sv);
                    self.send(protocol::step2(diff));
                }
                Message::Sync(SyncMessage::SyncStep2(u) | SyncMessage::Update(u)) => {
                    self.doc
                        .transact_mut()
                        .apply_update(Update::decode_v1(&u).unwrap())
                        .unwrap();
                }
                Message::Custom(100, body) => {
                    self.controls.push(serde_json::from_slice(&body).unwrap())
                }
                Message::Auth(Some(_)) => self.denied += 1,
                Message::Awareness(a) => self.awareness.push(a),
                _ => {}
            }
        }
    }

    /// Processes everything that arrives until the line is quiet for 150 ms.
    pub async fn settle(&mut self) {
        while let Ok(Some(out)) =
            tokio::time::timeout(Duration::from_millis(150), self.rx.recv()).await
        {
            if let Outbound::Frame(f) = out {
                self.on_frame(&f);
            }
        }
    }

    /// Runs `f` against the local doc and ships the resulting update.
    pub fn edit(&self, f: impl FnOnce(&Doc)) {
        let sv = self.doc.transact().state_vector();
        f(&self.doc);
        let update = self.doc.transact().encode_state_as_update_v1(&sv);
        self.send(protocol::update(update));
    }

    pub fn leave(&mut self) {
        self.membership.take();
    }
}

pub fn json_of(doc: &Doc) -> Value {
    let d = oc_model::new_doc();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    oc_model::ocanvas::apply_update_bytes(&d, &state).unwrap();
    oc_model::doc_to_json(&d)
}

pub async fn server_json(state: &SharedState) -> Value {
    let host = state.hosts.get("sample").unwrap();
    let bytes = state
        .rooms
        .state(&host, &grant("u_x", Role::View))
        .await
        .unwrap();
    let d = oc_model::new_doc();
    oc_model::ocanvas::apply_update_bytes(&d, &bytes).unwrap();
    oc_model::doc_to_json(&d)
}

pub async fn wait_until(mut f: impl FnMut() -> bool) {
    for _ in 0..200 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("condition not met in time");
}
