//! WOPI-compatible mode end to end (docs/05 §6): an in-process mock WOPI host, a real
//! WebSocket client, CheckFileInfo → GetFile → edit → autosave PutFile, conflicts (1010 →
//! PUT_RELATIVE), assets inlined into the file, and the WOPISrc allowlist.
mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use common::*;
use futures::{SinkExt, StreamExt};
use oc_server::SharedState;
use oc_server::config::RoomConfig;
use oc_server::room::protocol;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use yrs::encoding::read::Cursor;
use yrs::sync::protocol::MessageReader;
use yrs::sync::{Message, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::{Doc, ReadTxn, Transact, Update, Xml, XmlElementPrelim, XmlFragment, XmlTextPrelim};

// ---------------------------------------------------------------- mock WOPI host

#[derive(Clone, Debug)]
struct Req {
    headers: HeaderMap,
    query: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Default)]
struct Wopi {
    /// file id → (bytes, LastModifiedTime counter)
    files: HashMap<String, (Vec<u8>, u64)>,
    /// access token → CheckFileInfo user fields
    tokens: HashMap<String, Value>,
    /// CheckFileInfo calls (by token)
    infos: Vec<String>,
    puts: Vec<Req>,
    relatives: Vec<Req>,
    /// Every PutFile answers 409 / 1010 while set.
    conflict: bool,
}

type W = Arc<Mutex<Wopi>>;

fn stamp(n: u64) -> String {
    format!("2026-11-21T10:00:{n:02}.0000000Z")
}

fn authorized(w: &Wopi, q: &HashMap<String, String>) -> Option<Value> {
    w.tokens.get(q.get("access_token")?).cloned()
}

async fn check_file_info(
    State(w): State<W>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let mut w = w.lock().unwrap();
    w.infos
        .push(q.get("access_token").cloned().unwrap_or_default());
    let Some(user) = authorized(&w, &q) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let (bytes, n) = w.files.get(&id).cloned().unwrap_or_default();
    let mut v = json!({
        "BaseFileName": if id.ends_with("_md") { format!("{id}.md") } else { format!("{id}.ocanvas") },
        "Size": bytes.len(),
        "Version": n.to_string(),
        "LastModifiedTime": stamp(n),
        "OwnerId": "owner",
    });
    v.as_object_mut()
        .unwrap()
        .extend(user.as_object().unwrap().clone());
    axum::Json(v).into_response()
}

async fn get_contents(
    State(w): State<W>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let w = w.lock().unwrap();
    if authorized(&w, &q).is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    w.files
        .get(&id)
        .map(|f| f.0.clone())
        .unwrap_or_default()
        .into_response()
}

async fn put_contents(
    State(w): State<W>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut w = w.lock().unwrap();
    if authorized(&w, &q).is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    w.puts.push(Req {
        headers: headers.clone(),
        query: q,
        body: body.to_vec(),
    });
    let n = w.files.get(&id).map_or(0, |f| f.1);
    let sent = headers
        .get("x-cool-wopi-timestamp")
        .and_then(|v| v.to_str().ok());
    if w.conflict || sent.is_some_and(|t| t != stamp(n)) {
        return (
            StatusCode::CONFLICT,
            axum::Json(json!({"COOLStatusCode": 1010})),
        )
            .into_response();
    }
    w.files.insert(id, (body.to_vec(), n + 1));
    axum::Json(json!({"LastModifiedTime": stamp(n + 1)})).into_response()
}

async fn put_relative(
    State(w): State<W>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut w = w.lock().unwrap();
    if authorized(&w, &q).is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    w.relatives.push(Req {
        headers,
        query: q,
        body: body.to_vec(),
    });
    let new_id = format!("{id}_copy");
    w.files.insert(new_id.clone(), (body.to_vec(), 0));
    axum::Json(json!({
        "Name": "copy.ocanvas",
        "Url": format!("http://wopi.invalid/wopi/files/{new_id}?access_token=secret-new"),
        "HostEditUrl": format!("http://wopi.invalid/edit/{new_id}"),
    }))
    .into_response()
}

/// Starts the mock WOPI host; returns its origin (`http://127.0.0.1:<port>`).
async fn wopi_host() -> (String, W) {
    let w: W = Arc::default();
    {
        let mut s = w.lock().unwrap();
        s.tokens.insert(
            "tok-asha".into(),
            json!({"UserId": "u_asha", "UserFriendlyName": "Asha Rao", "UserCanWrite": true,
                   "UserExtraInfo": {"avatar": "https://cloud.example.com/asha.png"}}),
        );
        s.tokens.insert(
            "tok-ravi".into(),
            json!({"UserId": "u_ravi", "UserFriendlyName": "Ravi Menon", "UserCanWrite": false,
                   "OpenCanvas_UserCanComment": true, "DisableExport": true}),
        );
        s.tokens.insert(
            "tok-sam".into(),
            json!({"UserId": "u_sam", "UserFriendlyName": "Sam Ortiz", "UserCanWrite": true, "ReadOnly": true,
                   "DisablePrint": true}),
        );
    }
    let app = Router::new()
        .route("/wopi/files/{id}", get(check_file_info).post(put_relative))
        .route(
            "/wopi/files/{id}/contents",
            get(get_contents).post(put_contents),
        )
        .with_state(w.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), w)
}

fn fast_rooms() -> RoomConfig {
    RoomConfig {
        autosave_debounce: Duration::from_millis(150),
        autosave_max: Duration::from_millis(1000),
        tick: Duration::from_millis(20),
        ..RoomConfig::default()
    }
}

async fn wopi_app(origin: &str, db: &std::path::Path) -> SharedState {
    let origin = origin.to_string();
    app_custom("", fast_rooms(), db, move |h| {
        h.mode = "wopi".into();
        h.jwt_secret = None;
        h.callback_base = String::new();
        h.wopi_allowlist = vec![origin];
    })
    .await
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

/// `POST /v1/launch?WOPISrc=` with the form fields; returns (status, ticket or error body).
async fn launch(addr: &str, src: &str, token: &str, ttl: Option<i64>) -> (u16, String) {
    let mut url = reqwest::Url::parse(&format!("http://{addr}/v1/launch")).unwrap();
    url.query_pairs_mut().append_pair("WOPISrc", src);
    let mut form = vec![("access_token", token.to_string())];
    if let Some(t) = ttl {
        form.push(("access_token_ttl", t.to_string()));
    }
    let res = http().post(url).form(&form).send().await.unwrap();
    let status = res.status().as_u16();
    if status == 303 {
        let loc = res.headers()["location"].to_str().unwrap().to_string();
        (status, loc.split("#t=").nth(1).unwrap().to_string())
    } else {
        (status, res.text().await.unwrap())
    }
}

async fn session_json(addr: &str, ticket: &str) -> Value {
    http()
        .get(format!("http://{addr}/v1/sessions/{ticket}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

fn ttl_in_an_hour() -> i64 {
    (oc_server::util::now_secs() + 3600) * 1000
}

// ---------------------------------------------------------------- a y-websocket client

struct Client {
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    doc: Doc,
    controls: Vec<Value>,
}

impl Client {
    async fn connect(addr: &str, room: &str, ticket: &str) -> Client {
        let (ws, _) = tokio_tungstenite::connect_async(format!(
            "ws://{addr}/v1/collab/{room}?ticket={ticket}"
        ))
        .await
        .unwrap();
        let mut c = Client {
            ws,
            doc: Doc::new(),
            controls: vec![],
        };
        let sv = c.doc.transact().state_vector();
        c.ws.send(WsMessage::Binary(protocol::step1(sv).into()))
            .await
            .unwrap();
        c.pump(300).await;
        c
    }

    async fn pump(&mut self, quiet_ms: u64) {
        while let Ok(Some(Ok(msg))) =
            tokio::time::timeout(Duration::from_millis(quiet_ms), self.ws.next()).await
        {
            let WsMessage::Binary(data) = msg else {
                continue;
            };
            let mut d = DecoderV1::new(Cursor::new(&data));
            let msgs: Vec<Message> = MessageReader::new(&mut d)
                .collect::<Result<_, _>>()
                .unwrap();
            for m in msgs {
                match m {
                    Message::Sync(SyncMessage::SyncStep1(sv)) => {
                        let diff = self.doc.transact().encode_state_as_update_v1(&sv);
                        self.ws
                            .send(WsMessage::Binary(protocol::step2(diff).into()))
                            .await
                            .unwrap();
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
                    _ => {}
                }
            }
        }
    }

    async fn edit(&mut self, f: impl FnOnce(&Doc)) {
        let sv = self.doc.transact().state_vector();
        f(&self.doc);
        let update = self.doc.transact().encode_state_as_update_v1(&sv);
        self.ws
            .send(WsMessage::Binary(protocol::update(update).into()))
            .await
            .unwrap();
    }

    async fn type_paragraph(&mut self, text: &str) {
        self.edit(|doc| {
            let content = doc.get_or_insert_xml_fragment("content");
            let mut txn = doc.transact_mut();
            let p = content.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            p.push_back(&mut txn, XmlTextPrelim::new(text));
        })
        .await;
    }
}

async fn wait_for(w: &W, f: impl Fn(&Wopi) -> bool) {
    for _ in 0..200 {
        if f(&w.lock().unwrap()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("mock WOPI host never saw the expected request");
}

/// Markdown of a saved `.ocanvas`.
fn md_of(bytes: &[u8]) -> String {
    let doc = oc_model::read_ocanvas(bytes).unwrap().doc;
    oc_model::export::to_markdown(&oc_model::doc_to_json(&doc))
}

fn header<'a>(r: &'a Req, k: &str) -> Option<&'a str> {
    r.headers.get(k).and_then(|v| v.to_str().ok())
}

// ---------------------------------------------------------------- tests

#[tokio::test]
async fn discovery_route_serves_xml() {
    let (origin, _w) = wopi_host().await;
    let state = wopi_app(&origin, &temp_db()).await;
    let addr = serve_state(state).await;
    let res = http()
        .get(format!("http://{addr}/hosting/discovery"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert!(
        res.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/xml")
    );
    let xml = res.text().await.unwrap();
    let launch = format!(r#"urlsrc="http://{addr}/v1/launch?""#);
    assert!(
        xml.contains(&format!(
            r#"<action name="edit" ext="ocanvas" default="true" {launch}"#
        )),
        "{xml}"
    );
    assert!(xml.contains(&format!(
        r#"<action name="convert" ext="md" targetext="ocanvas" {launch}"#
    )));
    let caps: Value = http()
        .get(format!("http://{addr}/hosting/capabilities"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(caps["productName"], "OpenCanvas");
}

#[tokio::test]
async fn launch_refuses_wopisrc_outside_the_allowlist() {
    let (origin, w) = wopi_host().await;
    let state = wopi_app(&origin, &temp_db()).await;
    let addr = serve_state(state).await;
    let port = origin.rsplit(':').next().unwrap();
    for bad in [
        format!("http://localhost:{port}/wopi/files/doc_1"),
        format!("http://127.0.0.1:{port}@evil.example/wopi/files/doc_1"),
        format!("http://127.0.0.1:{port}.evil.example/wopi/files/doc_1"),
        format!("http://127.0.0.2:{port}/wopi/files/doc_1"),
        format!("https://127.0.0.1:{port}/wopi/files/doc_1"),
        format!("http://evil.example/?x={origin}/wopi/files/doc_1"),
        format!("{origin}/wopi/files/doc_1?access_token=tok-asha"),
        "file:///etc/passwd".into(),
    ] {
        let (status, body) = launch(&addr, &bad, "tok-asha", None).await;
        assert_eq!(status, 403, "{bad}: {body}");
        assert!(body.contains("WOPISRC_NOT_ALLOWED"));
    }
    assert!(
        w.lock().unwrap().infos.is_empty(),
        "nothing was called for refused origins"
    );
    // A good origin with a bad token: the host says 401, so do we.
    let src = format!("{origin}/wopi/files/doc_1");
    let (status, body) = launch(&addr, &src, "nope", None).await;
    assert_eq!(status, 401, "{body}");
    assert!(!body.contains("nope"), "the token is not echoed");
    // An access_token_ttl in the past.
    let (status, _) = launch(&addr, &src, "tok-asha", Some(1000)).await;
    assert_eq!(status, 401);
}

#[tokio::test]
async fn check_file_info_sets_role_user_perms_and_expiry() {
    let (origin, w) = wopi_host().await;
    let state = wopi_app(&origin, &temp_db()).await;
    let addr = serve_state(state.clone()).await;
    let src = format!("{origin}/wopi/files/doc_1");
    let ttl = ttl_in_an_hour();

    let (status, ticket) = launch(&addr, &src, "tok-asha", Some(ttl)).await;
    assert_eq!(status, 303, "{ticket}");
    let s = session_json(&addr, &ticket).await;
    assert_eq!(s["role"], "edit");
    assert_eq!(s["user"]["id"], "u_asha");
    assert_eq!(s["user"]["name"], "Asha Rao");
    assert_eq!(s["user"]["avatar"], "https://cloud.example.com/asha.png");
    assert_eq!(s["file"]["name"], "doc_1.ocanvas");
    assert_eq!(s["file"]["id"], src);
    assert_eq!(
        s["perms"],
        json!({"export": true, "download": true, "comment": true, "print": true})
    );
    assert_eq!(s["isNew"], true, "an empty WOPI file is a new canvas");
    let (_, exp) = state.store.session(&ticket).await.unwrap().unwrap();
    assert_eq!(exp, ttl / 1000, "access_token_ttl is the session expiry");
    let raw = state.store.raw_grant_json(&ticket).await.unwrap().unwrap();
    assert!(
        !raw.contains("tok-asha"),
        "access token sealed at rest: {raw}"
    );

    let (_, ticket) = launch(&addr, &src, "tok-ravi", None).await;
    let s = session_json(&addr, &ticket).await;
    assert_eq!(s["role"], "comment");
    assert_eq!(
        s["perms"],
        json!({"export": false, "download": false, "comment": true, "print": false})
    );
    let (_, exp) = state.store.session(&ticket).await.unwrap().unwrap();
    assert!(
        exp > oc_server::util::now_secs() + 9 * 3600,
        "no ttl → 10 h"
    );

    let (_, ticket) = launch(&addr, &src, "tok-sam", None).await;
    let s = session_json(&addr, &ticket).await;
    assert_eq!(s["role"], "view", "ReadOnly wins over UserCanWrite");
    assert_eq!(s["perms"]["print"], false);
    let pdf = http()
        .get(format!("http://{addr}/v1/export/pdf?ticket={ticket}"))
        .send()
        .await
        .unwrap();
    assert_eq!(pdf.status(), 403, "DisablePrint forbids PDF");

    // Mentions: the users who opened the file.
    let users: Value = http()
        .get(format!("http://{addr}/v1/users?ticket={ticket}&q=ra"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let names: Vec<_> = users
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Asha Rao", "Ravi Menon"]);
    // A JWT launch for a WOPI-only host is refused.
    let res = http()
        .post(format!("http://{addr}/v1/launch"))
        .form(&[("token", "x.y.z")])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    let _ = w;
}

/// launch → edit over the WebSocket → autosave arrives at the WOPI host as a PutFile.
#[tokio::test]
async fn edit_autosaves_through_putfile() {
    let (origin, w) = wopi_host().await;
    let state = wopi_app(&origin, &temp_db()).await;
    let addr = serve_state(state.clone()).await;
    let src = format!("{origin}/wopi/files/doc_1");
    let start = oc_model::write_ocanvas(&oc_model::new_doc(), &Default::default()).unwrap();
    w.lock().unwrap().files.insert("doc_1".into(), (start, 3));

    let (_, ticket) = launch(&addr, &src, "tok-asha", Some(ttl_in_an_hour())).await;
    let s = session_json(&addr, &ticket).await;
    let mut c = Client::connect(&addr, s["room"].as_str().unwrap(), &ticket).await;
    c.type_paragraph("Hello over WOPI").await;
    wait_for(&w, |w| !w.puts.is_empty()).await;
    c.pump(300).await;

    let w = w.lock().unwrap();
    let put = &w.puts[0];
    assert_eq!(
        put.query.get("access_token").map(String::as_str),
        Some("tok-asha")
    );
    assert_eq!(header(put, "x-wopi-override"), Some("PUT"));
    assert_eq!(
        header(put, "x-cool-wopi-timestamp"),
        Some(stamp(3).as_str())
    );
    assert_eq!(header(put, "x-cool-wopi-isautosave"), Some("true"));
    assert_eq!(header(put, "x-cool-wopi-ismodifiedbyuser"), Some("true"));
    assert!(md_of(&put.body).contains("Hello over WOPI"));
    assert_eq!(w.files["doc_1"].1, 4, "the host accepted the save");
    let saved = c.controls.iter().rev().find(|m| m["t"] == "saved").unwrap();
    assert_eq!(
        saved["version"],
        stamp(4),
        "the new LastModifiedTime is tracked"
    );
}

/// A Markdown file is saved back as Markdown.
#[tokio::test]
async fn markdown_files_stay_markdown() {
    let (origin, w) = wopi_host().await;
    let state = wopi_app(&origin, &temp_db()).await;
    let addr = serve_state(state).await;
    w.lock()
        .unwrap()
        .files
        .insert("notes_md".into(), (b"# Notes\n\nFirst line\n".to_vec(), 1));
    let src = format!("{origin}/wopi/files/notes_md");
    let (_, ticket) = launch(&addr, &src, "tok-asha", None).await;
    let s = session_json(&addr, &ticket).await;
    let mut c = Client::connect(&addr, s["room"].as_str().unwrap(), &ticket).await;
    c.type_paragraph("Second line").await;
    wait_for(&w, |w| !w.puts.is_empty()).await;
    let body = String::from_utf8(w.lock().unwrap().puts[0].body.clone()).unwrap();
    assert!(
        body.contains("# Notes") && body.contains("Second line"),
        "{body}"
    );
    c.pump(100).await;
}

/// 409 + COOLStatusCode 1010 → conflict policy `copy` → PUT_RELATIVE, room read-only.
#[tokio::test]
async fn conflict_1010_saves_a_copy_with_put_relative() {
    let (origin, w) = wopi_host().await;
    let state = wopi_app(&origin, &temp_db()).await;
    let addr = serve_state(state).await;
    let src = format!("{origin}/wopi/files/doc_1");
    let (_, ticket) = launch(&addr, &src, "tok-asha", None).await;
    let s = session_json(&addr, &ticket).await;
    let mut c = Client::connect(&addr, s["room"].as_str().unwrap(), &ticket).await;
    w.lock().unwrap().conflict = true;
    c.type_paragraph("Mine").await;
    wait_for(&w, |w| !w.relatives.is_empty()).await;
    c.pump(400).await;

    let w = w.lock().unwrap();
    assert_eq!(w.puts.len(), 1, "autosave stops after the conflict");
    let rel = &w.relatives[0];
    assert_eq!(header(rel, "x-wopi-override"), Some("PUT_RELATIVE"));
    assert_eq!(
        header(rel, "x-wopi-suggestedtarget"),
        Some("doc_1 (conflict copy).ocanvas")
    );
    assert_eq!(
        header(rel, "x-wopi-size"),
        Some(rel.body.len().to_string().as_str())
    );
    assert!(md_of(&rel.body).contains("Mine"));
    let conflict = c
        .controls
        .iter()
        .find(|m| m["t"] == "conflict")
        .expect("conflict control");
    assert_eq!(conflict["policy"], "copy");
    assert_eq!(conflict["url"], "http://wopi.invalid/edit/doc_1_copy");
    assert_eq!(
        conflict["fileId"], "http://wopi.invalid/wopi/files/doc_1_copy",
        "the copy's token is not passed on"
    );
}

fn multipart(name: &str, mime: &str, data: &[u8]) -> (String, Vec<u8>) {
    let b = "ocboundary42";
    let mut body = format!(
        "--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{b}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={b}"), body)
}

/// Upload → image in the doc → PutFile carries `assets/<id>` → a fresh server (new DB) loads
/// the file and serves the asset again from the zip.
#[tokio::test]
async fn assets_are_inlined_and_round_trip() {
    let (origin, w) = wopi_host().await;
    let state = wopi_app(&origin, &temp_db()).await;
    let addr = serve_state(state).await;
    let src = format!("{origin}/wopi/files/doc_1");
    let (_, ticket) = launch(&addr, &src, "tok-asha", None).await;
    let s = session_json(&addr, &ticket).await;

    let (ctype, body) = multipart("dot.png", "image/png", &PNG_1X1);
    let up: Value = http()
        .post(format!("http://{addr}/v1/assets?ticket={ticket}"))
        .header("content-type", ctype.clone())
        .body(body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = up["assetId"].as_str().unwrap().to_string();
    let url = up["url"].as_str().unwrap().to_string();
    assert_eq!(url, format!("/v1/assets/{id}"));
    assert_eq!(up["mime"], "image/png");

    let get = |addr: String, ticket: String, url: String| async move {
        http()
            .get(format!("http://{addr}{url}?ticket={ticket}"))
            .send()
            .await
            .unwrap()
    };
    let res = get(addr.clone(), ticket.clone(), url.clone()).await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["x-content-type-options"], "nosniff");
    assert_eq!(res.bytes().await.unwrap().as_ref(), PNG_1X1);
    assert_eq!(
        get(addr.clone(), "bad".into(), url.clone()).await.status(),
        401
    );

    // Too large.
    let (ctype_big, big) = multipart(
        "big.bin",
        "application/octet-stream",
        &vec![0; 10 * 1024 * 1024 + 1],
    );
    let res = http()
        .post(format!("http://{addr}/v1/assets?ticket={ticket}"))
        .header("content-type", ctype_big)
        .body(big)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 413);

    let mut c = Client::connect(&addr, s["room"].as_str().unwrap(), &ticket).await;
    let src_attr = url.clone();
    c.edit(|doc| {
        let content = doc.get_or_insert_xml_fragment("content");
        let mut txn = doc.transact_mut();
        let img = content.push_back(&mut txn, XmlElementPrelim::empty("image"));
        img.insert_attribute(&mut txn, "src", src_attr.as_str());
    })
    .await;
    wait_for(&w, |w| !w.puts.is_empty()).await;
    let saved = w.lock().unwrap().puts[0].body.clone();
    let assets = oc_model::ocanvas::read_assets(&saved).unwrap();
    assert_eq!(assets.len(), 1, "only the referenced asset is inlined");
    assert_eq!(assets[0].id, id);
    assert_eq!(assets[0].mime, "image/png");
    assert_eq!(assets[0].data, PNG_1X1);
    c.pump(100).await;
    drop(c);

    // A fresh server with an empty DB reads the asset back out of the host's file.
    let state2 = wopi_app(&origin, &temp_db()).await;
    let addr2 = serve_state(state2).await;
    let (_, ticket2) = launch(&addr2, &src, "tok-ravi", None).await;
    session_json(&addr2, &ticket2).await; // opens the room → GetFile
    let res = get(addr2, ticket2, url).await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.bytes().await.unwrap().as_ref(), PNG_1X1);
}
