// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Ephemeral storage (ADR-043, docs/05 §8): no host load or save, the canvas is destroyed
//! when its room closes, uploads live with the room, exports still work.
mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use jsonwebtoken::{EncodingKey, Header, encode};
use oc_server::SharedState;
use oc_server::config::{Config, RoomConfig};
use oc_server::grant::Role;
use oc_server::grant::room_id;
use oc_server::hosts::{HostConfig, Hosts};
use oc_server::room::EPHEMERAL_CLOSED;
use serde_json::{Value, json};
use yrs::{GetString, Text, Transact};

const API_KEY: &str = "ephemeral-test-api-key";

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn token() -> String {
    let claims = json!({
        "iss": "sample", "aud": "opencanvas", "exp": now() + 600, "jti": ulid::Ulid::new().to_string(),
        "file": {"id": FILE, "name": "Meeting notes"},
        "user": {"id": "u_1", "name": "Asha Rao"},
        "role": "edit", "perms": {"export": true, "download": true, "comment": true},
        "callbackToken": "cb-u_1"
    });
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(SECRET.as_bytes()).unwrap(),
    )
    .unwrap()
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

fn rooms(idle: Duration) -> RoomConfig {
    RoomConfig {
        room_ttl: idle,
        ..room_cfg()
    }
}

/// An ephemeral `sample` host. `base` is its `callback_base` (empty: none); with a mock host
/// behind it, any call the server makes is recorded.
async fn eph_app(
    base: &str,
    idle: Duration,
    tweak_cfg: impl FnOnce(&mut Config),
    tweak: impl FnOnce(&mut HostConfig),
) -> SharedState {
    app_full(
        base,
        rooms(idle),
        &temp_db(),
        |h| {
            h.storage = "ephemeral".into();
            h.api_key = Some(API_KEY.into());
            tweak(h);
        },
        tweak_cfg,
    )
    .await
}

/// `POST /v1/launch` → ticket.
async fn launch(addr: &str) -> String {
    let res = http()
        .post(format!("http://{addr}/v1/launch"))
        .form(&[("token", token())])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 303);
    res.headers()["location"]
        .to_str()
        .unwrap()
        .strip_prefix("/app/#t=")
        .unwrap()
        .to_string()
}

async fn session(addr: &str, ticket: &str) -> (u16, Value) {
    let res = http()
        .get(format!("http://{addr}/v1/sessions/{ticket}"))
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

async fn upload(addr: &str, ticket: &str) -> Value {
    let b = "ocboundary42";
    let mut body = format!(
        "--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(b"\x89PNG\r\n\x1a\nnot-really-a-png");
    body.extend_from_slice(format!("\r\n--{b}--\r\n").as_bytes());
    let res = http()
        .post(format!("http://{addr}/v1/assets?ticket={ticket}"))
        .header("content-type", format!("multipart/form-data; boundary={b}"))
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 201);
    res.json().await.unwrap()
}

fn type_text(peer: &Peer, s: &str) {
    peer.edit(|d| {
        let t = d.get_or_insert_text("scratch");
        let mut tx = d.transact_mut();
        t.insert(&mut tx, 0, s);
    });
}

/// Rows and keys the room still has, by table (and Redis).
async fn leftovers(state: &SharedState) -> Vec<(&'static str, i64)> {
    state
        .store
        .room_footprint(&room_id("sample", FILE))
        .await
        .unwrap()
        .into_iter()
        .filter(|(_, n)| *n > 0)
        .collect()
}

async fn wait_closed(state: &SharedState) {
    let room = room_id("sample", FILE);
    for _ in 0..200 {
        if !state.rooms.is_live(&room) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("room still live");
}

#[test]
fn ephemeral_hosts_need_no_callback_base() {
    let src = |extra: &str| {
        format!(
            "[[host]]\nid = \"jitsi\"\nname = \"Meet\"\njwt_secret = \"0123456789abcdef0123456789abcdef\"\n{extra}\n"
        )
    };
    let hosts = Hosts::parse(&src("storage = \"ephemeral\""), None).unwrap();
    let h = hosts.get("jitsi").unwrap();
    assert!(h.ephemeral());
    assert_eq!(h.callback_base, "");
    // The default is unchanged: host storage needs a callback_base.
    assert!(Hosts::parse(&src(""), None).is_err());
    assert!(
        !Hosts::parse(&src("callback_base = \"http://h/api\""), None)
            .unwrap()
            .get("jitsi")
            .unwrap()
            .ephemeral()
    );
    assert!(Hosts::parse(&src("storage = \"tmp\""), None).is_err());
    let wopi = "storage = \"ephemeral\"\nmode = \"wopi\"\nwopi_allowlist = [\"http://w\"]";
    assert!(Hosts::parse(&src(wopi), None).is_err());
    // A template is read at startup.
    let path = std::env::temp_dir().join(format!("oc-tpl-{}.md", ulid::Ulid::new()));
    std::fs::write(&path, "# Agenda\n").unwrap();
    let with_tpl = format!(
        "storage = \"ephemeral\"\ntemplate = {:?}",
        path.display().to_string()
    );
    let hosts = Hosts::parse(&src(&with_tpl), None).unwrap();
    assert_eq!(
        hosts
            .get("jitsi")
            .unwrap()
            .template_bytes
            .as_deref()
            .map(Vec::as_slice),
        Some(&b"# Agenda\n"[..])
    );
    let missing = "storage = \"ephemeral\"\ntemplate = \"/nonexistent/oc-template.md\"";
    assert!(Hosts::parse(&src(missing), None).is_err());
}

/// Launch, upload, edit, export, leave: the host is never called, and after the idle grace
/// nothing of the room is left anywhere.
async fn idle_close_leaves_nothing(tweak_cfg: impl FnOnce(&mut Config)) {
    let (base, host) = mock_host().await;
    let state = eph_app(&base, Duration::from_millis(300), tweak_cfg, |_| {}).await;
    let addr = serve_state(state.clone()).await;
    let ticket = launch(&addr).await;
    let (code, s) = session(&addr, &ticket).await;
    assert_eq!(code, 200);
    assert_eq!(s["storage"], "ephemeral");
    assert_eq!(s["isNew"], true);
    let up = upload(&addr, &ticket).await;
    let asset = http()
        .get(format!(
            "http://{addr}{}?ticket={ticket}",
            up["url"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(asset.status(), 200);

    let mut peer = Peer::join(&state, grant("u_1", Role::Edit)).await;
    peer.settle().await;
    assert!(
        peer.controls.iter().any(|c| c["t"] == "temporary"),
        "{:?}",
        peer.controls
    );
    type_text(&peer, "kept only by exporting");
    peer.settle().await;
    // Export stays available.
    let md = http()
        .get(format!("http://{addr}/v1/export/json?ticket={ticket}"))
        .send()
        .await
        .unwrap();
    assert_eq!(md.status(), 200);
    let ocanvas = http()
        .get(format!("http://{addr}/v1/export/ocanvas?ticket={ticket}"))
        .send()
        .await
        .unwrap();
    assert_eq!(ocanvas.status(), 200);
    assert!(oc_model::read_ocanvas(&ocanvas.bytes().await.unwrap()).is_ok());
    assert!(!leftovers(&state).await.is_empty());

    peer.leave();
    wait_closed(&state).await;
    assert_eq!(leftovers(&state).await, vec![], "room destroyed");
    {
        let h = host.lock().unwrap();
        assert_eq!(h.gets, 0, "no load callback");
        assert!(h.puts.is_empty(), "no save callback");
        assert!(h.copies.is_empty() && h.mentions.is_empty());
    }
    // The ticket died with the canvas.
    assert_eq!(session(&addr, &ticket).await.0, 401);
}

#[tokio::test]
async fn idle_close_destroys_everything_without_calling_the_host() {
    idle_close_leaves_nothing(|_| {}).await;
}

#[tokio::test]
async fn idle_close_destroys_everything_in_redis_too() {
    let Ok(url) = std::env::var("OC_TEST_REDIS_URL") else {
        eprintln!("OC_TEST_REDIS_URL not set: skipping the Redis ephemeral tests");
        return;
    };
    let u = url.clone();
    idle_close_leaves_nothing(move |c| c.wal_redis_url = Some(u)).await;
    idle_close_leaves_nothing(move |c| c.storage_redis_url = Some(url)).await;
}

/// A host without `callback_base` launches, edits and closes.
#[tokio::test]
async fn ephemeral_host_runs_without_callback_base() {
    let state = eph_app("", Duration::from_millis(200), |_| {}, |_| {}).await;
    let addr = serve_state(state.clone()).await;
    let ticket = launch(&addr).await;
    assert_eq!(session(&addr, &ticket).await.1["storage"], "ephemeral");
    let mut peer = Peer::join(&state, grant("u_1", Role::Edit)).await;
    type_text(&peer, "hello");
    peer.settle().await;
    assert!(server_json(&state).await.is_object());
    peer.leave();
    wait_closed(&state).await;
    assert_eq!(leftovers(&state).await, vec![]);
}

/// `DELETE /v1/files/{id}/session` ends the canvas at once with a clear reason.
#[tokio::test]
async fn close_session_destroys_at_once_with_a_reason() {
    let (base, host) = mock_host().await;
    let state = eph_app(&base, Duration::from_secs(3600), |_| {}, |_| {}).await;
    let addr = serve_state(state.clone()).await;
    let ticket = launch(&addr).await;
    upload(&addr, &ticket).await;
    let mut peer = Peer::join(&state, grant("u_1", Role::Edit)).await;
    type_text(&peer, "draft");
    peer.settle().await;
    peer.controls.clear();

    let res = http()
        .delete(format!("http://{addr}/v1/files/{FILE}/session"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", API_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.json::<Value>().await.unwrap()["closed"], true);
    peer.settle().await;
    assert_eq!(peer.closed, Some(1000));
    assert!(
        peer.controls
            .iter()
            .any(|c| c["t"] == "closed" && c["reason"] == EPHEMERAL_CLOSED),
        "{:?}",
        peer.controls
    );
    assert_eq!(leftovers(&state).await, vec![], "destroyed immediately");
    assert_eq!(session(&addr, &ticket).await.0, 401);
    let h = host.lock().unwrap();
    assert_eq!(h.gets, 0);
    assert!(h.puts.is_empty());
}

/// A reconnect inside the idle grace finds the canvas as it was; a new launch after it ended
/// starts from the host's template.
#[tokio::test]
async fn reconnect_within_grace_keeps_the_canvas_and_new_rooms_use_the_template() {
    let state = eph_app(
        "",
        Duration::from_millis(1500),
        |_| {},
        |h| {
            h.template_bytes = Some(Arc::new(b"# Agenda\n".to_vec()));
        },
    )
    .await;
    let mut a = Peer::join(&state, grant("u_1", Role::Edit)).await;
    a.settle().await;
    assert!(server_json(&state).await.to_string().contains("Agenda"));
    type_text(&a, "decision: ship");
    a.settle().await;
    a.leave();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut b = Peer::join(&state, grant("u_1", Role::Edit)).await;
    b.settle().await;
    let text = b.doc.get_or_insert_text("scratch");
    assert_eq!(text.get_string(&b.doc.transact()), "decision: ship");
    b.leave();
    wait_closed(&state).await;
    assert_eq!(leftovers(&state).await, vec![]);
    let mut c = Peer::join(&state, grant("u_1", Role::Edit)).await;
    c.settle().await;
    let text = c.doc.get_or_insert_text("scratch");
    assert_eq!(text.get_string(&c.doc.transact()), "", "a new canvas");
    assert!(server_json(&state).await.to_string().contains("Agenda"));
}

/// `template = "meeting"` names a built-in template: every new canvas starts from it, applied
/// once by the server (two people joining at once never get it twice). Unknown names fail at
/// startup and list the valid ones.
#[tokio::test]
async fn a_builtin_template_by_name_seeds_each_new_canvas() {
    let src = |t: &str| {
        format!(
            "[[host]]\nid = \"jitsi\"\nname = \"Meet\"\njwt_secret = \"0123456789abcdef0123456789abcdef\"\nstorage = \"ephemeral\"\ntemplate = {t:?}\n"
        )
    };
    let err = Hosts::parse(&src("nosuch"), None).unwrap_err().to_string();
    assert!(
        err.contains("unknown template") && err.contains("meeting"),
        "{err}"
    );
    let hosts = Hosts::parse(&src("meeting"), None).unwrap();
    let bytes = hosts.get("jitsi").unwrap().template_bytes.clone();
    let state = eph_app(
        "",
        Duration::from_millis(1500),
        |_| {},
        move |h| {
            h.template_bytes = bytes.clone();
        },
    )
    .await;
    let mut a = Peer::join(&state, grant("u_1", Role::Edit)).await;
    let mut b = Peer::join(&state, grant("u_2", Role::Edit)).await;
    a.settle().await;
    b.settle().await;
    let tpl = oc_model::templates::builtin("meeting").unwrap();
    let blocks = server_json(&state).await["content"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(
        blocks,
        tpl["content"].as_array().unwrap().len(),
        "applied exactly once"
    );
}

/// A restart or deploy (drain) is not the end of the meeting: the canvas survives it and
/// reopens as it was; only the idle close or the host's close destroys it.
#[tokio::test]
async fn a_drain_keeps_the_canvas_for_the_reconnect() {
    let db = temp_db();
    let node = || {
        app_full(
            "",
            rooms(Duration::from_millis(1500)),
            &db,
            |h| {
                h.storage = "ephemeral".into();
                h.api_key = Some(API_KEY.into());
            },
            |_| {},
        )
    };
    let first = node().await;
    let mut a = Peer::join(&first, grant("u_1", Role::Edit)).await;
    a.settle().await;
    type_text(&a, "kept across a restart");
    a.settle().await;
    first.rooms.shutdown_all().await;
    assert_ne!(
        leftovers(&first).await,
        vec![],
        "the canvas is kept for the reconnect"
    );
    // The restarted server opens the same canvas.
    let second = node().await;
    let mut b = Peer::join(&second, grant("u_1", Role::Edit)).await;
    b.settle().await;
    let text = b.doc.get_or_insert_text("scratch");
    assert_eq!(text.get_string(&b.doc.transact()), "kept across a restart");
    b.leave();
    wait_closed(&second).await;
    assert_eq!(leftovers(&second).await, vec![]);
}

/// The default storage is unchanged: the room loads from the host and says so.
#[tokio::test]
async fn host_storage_is_unchanged() {
    let (base, host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let addr = serve_state(state.clone()).await;
    let ticket = launch(&addr).await;
    let (_, s) = session(&addr, &ticket).await;
    assert_eq!(s["storage"], "host");
    let mut peer = Peer::join(&state, grant("u_1", Role::Edit)).await;
    peer.settle().await;
    assert!(peer.controls.iter().any(|c| c["t"] == "saved"));
    assert_eq!(host.lock().unwrap().gets, 1);
}
