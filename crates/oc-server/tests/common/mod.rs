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
    /// PUTs answer 500 while set (host outage).
    pub fail: bool,
    /// Bodies POSTed to `/files/{id}/copies` (conflict policy `copy`).
    pub copies: Vec<RecordedPut>,
    /// Requests to `/assets/{id}` (with whether the signature verified).
    pub asset_gets: Vec<(String, bool)>,
    /// `/assets/redirect` answers 302 to this URL.
    pub redirect_to: Option<String>,
    /// `POST /mentions` calls (body, headers, v2 signature ok).
    pub mentions: Vec<RecordedPut>,
    /// The next this-many `POST /mentions` calls answer 503.
    pub mentions_fail: u32,
    /// `GET /files/{id}/members` answer (docs/21 revision 2); `None` = 404.
    pub members: Option<Value>,
    /// (file id, query, signature ok) of every members call.
    pub members_calls: Vec<(String, String, bool)>,
}

pub const PNG_1X1: [u8; 70] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xcf, 0xc0, 0xf0,
    0x1f, 0x00, 0x05, 0x05, 0x02, 0x00, 0x5f, 0xc8, 0xf1, 0xd2, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

async fn asset(
    State(s): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> axum::response::Response {
    let mut st = s.lock().unwrap();
    st.asset_gets.push((id.clone(), verify(&headers, b"")));
    if id == "redirect"
        && let Some(to) = st.redirect_to.clone()
    {
        return (StatusCode::FOUND, [("location", to)]).into_response();
    }
    match id.as_str() {
        // Over the 10 MB cap (a valid PNG header, then padding).
        "big" => {
            let mut b = PNG_1X1.to_vec();
            b.resize(10 * 1024 * 1024 + 1, 0);
            return ([("content-type", "image/png")], b).into_response();
        }
        // A document for the preview route (not an image).
        "doc.pdf" => {
            return (
                [("content-type", "application/pdf")],
                b"%PDF-1.4\n%%EOF\n".to_vec(),
            )
                .into_response();
        }
        // Over the 50 MB preview cap.
        "huge.pdf" => {
            return (
                [("content-type", "application/pdf")],
                vec![0u8; 50 * 1024 * 1024 + 1],
            )
                .into_response();
        }
        // Image bytes, but not served as an image.
        "text" => return ([("content-type", "text/html")], PNG_1X1.to_vec()).into_response(),
        _ => {}
    }
    ([("content-type", "image/png")], PNG_1X1.to_vec()).into_response()
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
    // v1 first (what older hosts check), then v2 (method + path bound, SEC-18).
    sig.starts_with(&format!("{},v2=", signature(SECRET.as_bytes(), t, body)))
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
    if st.fail {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({"error": "down"})),
        );
    }
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

async fn post_copy(
    State(s): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let mut st = s.lock().unwrap();
    let signature_ok = verify(&headers, &body);
    st.copies.push(RecordedPut {
        headers,
        body: body.to_vec(),
        signature_ok,
    });
    let new_id = format!("{id}_copy{}", st.copies.len());
    st.files.insert(new_id.clone(), (body.to_vec(), 1));
    (
        StatusCode::CREATED,
        axum::Json(json!({"fileId": new_id, "url": format!("http://host/files/{new_id}")})),
    )
}

/// v2 signature check (method + path bound) for `POST /api/mentions`.
fn verify_v2(headers: &HeaderMap, path: &str, body: &[u8]) -> bool {
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
    sig == oc_server::host_client::signature_header(SECRET.as_bytes(), t, "POST", path, body)
}

async fn mentions(State(s): State<Shared>, headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    let mut st = s.lock().unwrap();
    let signature_ok = verify_v2(&headers, "/api/mentions", &body);
    st.mentions.push(RecordedPut {
        headers,
        body: body.to_vec(),
        signature_ok,
    });
    if st.mentions_fail > 0 {
        st.mentions_fail -= 1;
        return StatusCode::SERVICE_UNAVAILABLE;
    }
    StatusCode::NO_CONTENT
}

fn bearer(headers: &HeaderMap) -> String {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_string()
}

#[derive(serde::Deserialize)]
struct MembersQuery {
    #[serde(default)]
    q: String,
}

async fn members(
    State(s): State<Shared>,
    Path(id): Path<String>,
    axum::extract::Query(mq): axum::extract::Query<MembersQuery>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let ok = verify(&headers, b"") && !bearer(&headers).is_empty();
    let mut st = s.lock().unwrap();
    st.members_calls.push((id, mq.q, ok));
    if !ok {
        return (StatusCode::UNAUTHORIZED, axum::Json(json!([])));
    }
    match &st.members {
        None => (StatusCode::NOT_FOUND, axum::Json(json!({"error": "no"}))),
        Some(v) => (StatusCode::OK, axum::Json(v.clone())),
    }
}

/// Starts the mock host; returns its callback base URL and shared state.
pub async fn mock_host() -> (String, Shared) {
    let state: Shared = Arc::default();
    let app = Router::new()
        .route("/api/files/{id}", get(get_file).put(put_file))
        .route("/api/files/{id}/copies", axum::routing::post(post_copy))
        .route("/api/files/{id}/members", get(members))
        .route("/api/mentions", axum::routing::post(mentions))
        .route("/assets/{id}", get(asset))
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
        jwt_jwks_url: None,
        callback_secret: None,
        api_key: None,
        callback_base: base.into(),
        wopi_allowlist: vec![],
        allowed_origins: vec!["http://localhost:4000".into()],
        asset_origins: vec![],
        original_callback_base: None,
        flags: Default::default(),
    }
}

pub fn room_cfg() -> RoomConfig {
    RoomConfig {
        autosave_debounce: Duration::from_secs(3600),
        autosave_max: Duration::from_secs(3600),
        tick: Duration::from_millis(20),
        // Most tests check the strict WAL path; memory durability has its own (durability.rs).
        durability: oc_server::config::Durability::Wal,
        ..RoomConfig::default()
    }
}

pub fn temp_db() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("oc-test-{}.db", ulid::Ulid::new()))
}

/// A fixed test key-encryption key, so a second `AppState` on the same DB can read the first's rows.
pub const TEST_KEK: &str = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

pub async fn app(base: &str, rooms: RoomConfig) -> SharedState {
    app_custom(base, rooms, &temp_db(), |_| {}).await
}

/// Like `app` with an explicit DB file and a hook to adjust the host entry.
pub async fn app_custom(
    base: &str,
    rooms: RoomConfig,
    db: &std::path::Path,
    tweak: impl FnOnce(&mut HostConfig),
) -> SharedState {
    app_full(base, rooms, db, tweak, |_| {}).await
}

/// Like `app_custom`, with a hook for the server config too.
pub async fn app_full(
    base: &str,
    rooms: RoomConfig,
    db: &std::path::Path,
    tweak: impl FnOnce(&mut HostConfig),
    tweak_cfg: impl FnOnce(&mut Config),
) -> SharedState {
    let mut host = host_config(base);
    tweak(&mut host);
    let mut cfg = Config {
        bind: "127.0.0.1:0".into(),
        public_url: None,
        database_url: format!("sqlite://{}?mode=rwc", db.display()),
        hosts_file: "unused".into(),
        web_dir: "unused".into(),
        callback_base_override: None,
        pdf_renderer: None,
        metrics_token: None,
        wal_redis_url: None,
        storage_redis_url: None,
        kek: Some(oc_server::crypto::Kek::from_b64(TEST_KEK).unwrap()),
        rooms,
    };
    tweak_cfg(&mut cfg);
    AppState::new(cfg, Hosts::from_list(vec![host]))
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
            ..Default::default()
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
            print: true,
        },
        callback_token: format!("cb-{user}"),
        members: vec![],
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
    /// Close code the server sent, if any.
    pub closed: Option<u16>,
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
            closed: None,
        };
        let sv = peer.doc.transact().state_vector();
        peer.send(protocol::step1(sv));
        peer
    }

    pub fn send(&self, frame: Vec<u8>) {
        self.membership.as_ref().unwrap().try_send(frame);
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
            match out {
                Outbound::Frame(f) => self.on_frame(&f),
                Outbound::Close(code, _) => self.closed = Some(code),
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

/// Serves the router for `state` on a random port; returns `127.0.0.1:<port>`.
pub async fn serve_state(state: SharedState) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, oc_server::router(state))
            .await
            .unwrap()
    });
    format!("127.0.0.1:{}", addr.port())
}

pub fn ocanvas_text(bytes: &[u8]) -> String {
    let doc = oc_model::read_ocanvas(bytes).unwrap().doc;
    let v = oc_model::doc_to_json(&doc);
    v["content"]
        .as_array()
        .map(|a| a.iter().filter_map(|n| n["text"].as_str()).collect())
        .unwrap_or_default()
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
