// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Version history host contract (VH-01a, docs/30 §3, ADR-051): save headers, the version
//! callbacks, permissions and the session's history fields.

mod common;

use std::sync::Arc;

use common::*;
use jsonwebtoken::{EncodingKey, Header, encode};
use oc_model::ocanvas::CommitKind;
use oc_server::grant::Role;
use oc_server::host_client::{HostError, PutRequest, SaveMeta};
use serde_json::{Value, json};

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn token(role: &str, perms: Value) -> String {
    let claims = json!({
        "iss": "sample", "aud": "opencanvas", "exp": now() + 600, "jti": ulid::Ulid::new().to_string(),
        "file": {"id": FILE, "name": "Doc one", "version": "0"},
        "user": {"id": "u_1", "name": "Asha Rao"},
        "role": role, "perms": perms, "callbackToken": "cb-u_1"
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

/// Launches with `tok` and returns the session answer.
async fn session(addr: &str, tok: &str) -> Value {
    let res = http()
        .post(format!("http://{addr}/v1/launch"))
        .form(&[("token", tok)])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 303);
    let loc = res.headers()["location"].to_str().unwrap().to_string();
    let ticket = loc
        .split("#t=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap()
        .to_string();
    http()
        .get(format!("http://{addr}/v1/sessions/{ticket}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

fn header<'a>(p: &'a RecordedPut, k: &str) -> Option<&'a str> {
    p.headers.get(k).and_then(|v| v.to_str().ok())
}

#[tokio::test]
async fn named_and_restore_saves_carry_their_headers() {
    let (base, mock) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let host = state.hosts.get("sample").unwrap();
    let body = oc_model::write_ocanvas(&oc_model::new_doc(), &Default::default()).unwrap();
    let named = SaveMeta {
        kind: CommitKind::Named,
        message: Some("Board review — ready ✓".into()),
        restored_from: None,
        checkpoint: true,
    };
    let req = PutRequest {
        file_id: FILE,
        body: body.clone(),
        if_match: None,
        idempotency_key: "k1",
        authors: &["u_1".to_string()],
        meta: &named,
    };
    state.host.put_file(&host, "cb-u_1", req).await.unwrap();
    let restore = SaveMeta {
        kind: CommitKind::Restore,
        message: Some("Restored from Nov 21, 10:14".into()),
        restored_from: Some("18".into()),
        checkpoint: true,
    };
    let req = PutRequest {
        file_id: FILE,
        body,
        if_match: None,
        idempotency_key: "k2",
        authors: &[],
        meta: &restore,
    };
    state.host.put_file(&host, "cb-u_1", req).await.unwrap();
    let puts = mock.lock().unwrap().puts.clone();
    assert_eq!(header(&puts[0], "x-opencanvas-autosave"), Some("0"));
    assert_eq!(
        header(&puts[0], "x-opencanvas-commit-message"),
        Some("Board%20review%20%E2%80%94%20ready%20%E2%9C%93")
    );
    assert_eq!(header(&puts[0], "x-opencanvas-checkpoint"), Some("1"));
    assert_eq!(header(&puts[0], "x-opencanvas-restored-from"), None);
    assert_eq!(header(&puts[1], "x-opencanvas-autosave"), Some("0"));
    assert_eq!(header(&puts[1], "x-opencanvas-restored-from"), Some("18"));
}

#[tokio::test]
async fn autosaves_are_checkpoints_only_when_the_room_empties_or_after_a_while() {
    let (base, mock) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let host = state.hosts.get("sample").unwrap();
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    a.edit(|d| {
        use yrs::{Map, Transact};
        d.get_or_insert_map("meta")
            .insert(&mut d.transact_mut(), "title", "one");
    });
    a.settle().await;
    // A save while someone is still editing: an autosave, not a checkpoint.
    state
        .rooms
        .commit(&host, &grant("u_a", Role::Edit))
        .await
        .unwrap();
    {
        let st = mock.lock().unwrap();
        let p = st.puts.last().expect("a save");
        assert_eq!(header(p, "x-opencanvas-autosave"), Some("1"));
        assert_eq!(header(p, "x-opencanvas-checkpoint"), None);
        assert_eq!(header(p, "x-opencanvas-commit-message"), None);
        let m = oc_model::ocanvas::read_manifest(&p.body).unwrap();
        assert_eq!(m["commit"]["kind"], "auto");
    }
    // The last person leaves with unsaved work: that save is a checkpoint.
    a.edit(|d| {
        use yrs::{Map, Transact};
        d.get_or_insert_map("meta")
            .insert(&mut d.transact_mut(), "title", "two");
    });
    a.settle().await;
    let before = mock.lock().unwrap().puts.len();
    a.leave();
    wait_until(|| mock.lock().unwrap().puts.len() > before).await;
    let st = mock.lock().unwrap();
    assert_eq!(
        header(st.puts.last().unwrap(), "x-opencanvas-checkpoint"),
        Some("1")
    );
}

#[tokio::test]
async fn first_save_after_the_checkpoint_interval_is_a_checkpoint() {
    let (base, mock) = mock_host().await;
    let mut cfg = room_cfg();
    cfg.checkpoint_every = std::time::Duration::ZERO;
    let state = app(&base, cfg).await;
    let host = state.hosts.get("sample").unwrap();
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    a.edit(|d| {
        use yrs::{Map, Transact};
        d.get_or_insert_map("meta")
            .insert(&mut d.transact_mut(), "title", "one");
    });
    a.settle().await;
    state
        .rooms
        .commit(&host, &grant("u_a", Role::Edit))
        .await
        .unwrap();
    let st = mock.lock().unwrap();
    assert_eq!(
        header(st.puts.last().unwrap(), "x-opencanvas-checkpoint"),
        Some("1")
    );
}

#[tokio::test]
async fn version_callbacks_are_signed_and_normalized() {
    let (base, mock) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let host = state.hosts.get("sample").unwrap();
    // Not implemented: 404 comes back as a status.
    let e = state
        .host
        .list_versions(&host, "cb-u_1", FILE, None, 50)
        .await
        .unwrap_err();
    assert!(matches!(e, HostError::Status(s) if s == 404));
    mock.lock().unwrap().versions = Some(json!({
        "versions": [
            {"version": 18, "at": "2026-11-24T10:14:03Z", "authors": ["u_1"], "name": "  Before the board review  ", "kind": "named", "size": 182344},
            {"version": "17", "at": "2026-11-24T10:02:00Z", "authors": ["u_1", 7], "kind": "weird"},
            {"at": "no version id: dropped"}
        ],
        "next": "c2"
    }));
    let list = state
        .host
        .list_versions(&host, "cb-u_1", FILE, Some("c1"), 500)
        .await
        .unwrap();
    assert_eq!(
        list,
        json!({"versions": [
            {"version": "18", "at": "2026-11-24T10:14:03Z", "authors": ["u_1"], "kind": "named", "name": "Before the board review", "size": 182344},
            {"version": "17", "at": "2026-11-24T10:02:00Z", "authors": ["u_1"], "kind": "auto"}
        ], "next": "c2"})
    );
    let body = oc_model::write_ocanvas(&oc_model::new_doc(), &Default::default()).unwrap();
    mock.lock()
        .unwrap()
        .version_bodies
        .insert("18".into(), body.clone());
    let got = state
        .host
        .get_version(&host, "cb-u_1", FILE, "18")
        .await
        .unwrap();
    assert_eq!(got.as_ref(), body.as_slice());
    let gone = state
        .host
        .get_version(&host, "cb-u_1", FILE, "3")
        .await
        .unwrap_err();
    assert!(matches!(gone, HostError::Status(s) if s == 410));
    let calls = mock.lock().unwrap().version_calls.clone();
    assert_eq!(calls[1].0, "/api/files/doc_1/versions?cursor=c1&limit=100");
    assert!(
        calls.iter().all(|c| c.1),
        "every call is v2-signed: {calls:?}"
    );
    assert!(calls.iter().all(|c| c.2 == "cb-u_1"));
}

#[tokio::test]
async fn session_says_where_history_comes_from_and_who_may_use_it() {
    let (base, _mock) = mock_host().await;
    // Host versions and in-file history (both default on for this JWT host).
    let st = app_custom(&base, room_cfg(), &temp_db(), |h| {
        h.flags.insert("history".into(), true.into());
    })
    .await;
    let addr = serve_state(st).await;
    let all = json!({"export": true, "download": true, "comment": true});
    let s = session(&addr, &token("edit", all.clone())).await;
    assert_eq!(s["history"], "full");
    assert_eq!(s["historySource"], "host");
    assert_eq!(s["historyHostName"], "Sample");
    assert_eq!(s["perms"]["history"], true);
    assert_eq!(s["perms"]["restore"], true);
    assert_eq!(s["perms"]["commitMessage"], true);
    // Viewers: no history unless the host grants it; never restore or name.
    let v = session(&addr, &token("view", all.clone())).await;
    assert_eq!(v["perms"]["history"], false);
    assert_eq!(v["perms"]["restore"], false);
    assert_eq!(v["perms"]["commitMessage"], false);
    let vh = session(
        &addr,
        &token(
            "view",
            json!({"export": true, "download": true, "history": true}),
        ),
    )
    .await;
    assert_eq!(vh["perms"]["history"], true);
    assert_eq!(vh["perms"]["restore"], false);
    let nr = session(&addr, &token("edit", json!({"restore": false}))).await;
    assert_eq!(nr["perms"]["restore"], false);

    // In-file history off, no callbacks, a link to the host's page.
    let st = app_custom(&base, room_cfg(), &temp_db(), |h| {
        h.versions.insert("file".into(), false.into());
        h.flags.insert(
            "history_url".into(),
            "https://host.example/files/{fileId}/versions".into(),
        );
    })
    .await;
    let addr = serve_state(st).await;
    let s = session(&addr, &token("edit", all.clone())).await;
    assert_eq!(s["history"], "link");
    assert_eq!(s["historyUrl"], "https://host.example/files/doc_1/versions");

    // Nothing: plain message.
    let st = app_custom(&base, room_cfg(), &temp_db(), |h| {
        h.versions.insert("file".into(), false.into());
    })
    .await;
    let addr = serve_state(st).await;
    let s = session(&addr, &token("edit", all.clone())).await;
    assert_eq!(s["history"], "none");
    assert!(s.get("historySource").is_none());

    // In-file only (JWT default) with prefer_host irrelevant.
    let st = app(&base, room_cfg()).await;
    let addr = serve_state(st).await;
    let s = session(&addr, &token("edit", all)).await;
    assert_eq!(s["history"], "full");
    assert_eq!(s["historySource"], "file");
}

#[test]
fn temporary_canvases_have_no_history_and_wopi_hosts_no_in_file_history() {
    let mut h = host_config("http://x");
    h.storage = "ephemeral".into();
    h.flags.insert("history".into(), true.into());
    let s = oc_server::history::Sources::of(&h, &grant("u", Role::Edit));
    assert_eq!(s.mode(), "none");
    let mut w = host_config("http://x");
    w.mode = "wopi".into();
    assert!(w.file_history().is_none());
    let j = host_config("http://x");
    let lim = j.file_history().unwrap();
    assert_eq!((lim.max_bytes, lim.max_versions), (1024 * 1024, 50));
    let _ = Arc::new(());
}

fn set_title(p: &Peer, t: &str) {
    use yrs::{Map, Transact};
    let t = t.to_string();
    p.edit(move |d| {
        d.get_or_insert_map("meta")
            .insert(&mut d.transact_mut(), "title", t);
    });
}

fn last_put_history(mock: &Shared) -> (oc_model::history::FileHistory, Value) {
    let st = mock.lock().unwrap();
    let loaded = oc_model::read_ocanvas(&st.puts.last().expect("a save").body).unwrap();
    let cur = oc_model::doc_to_json(&loaded.doc);
    (loaded.history, cur)
}

/// ADR-055: checkpoint saves become in-file versions once a newer save replaces them.
#[tokio::test]
async fn saves_carry_in_file_history() {
    let (base, mock) = mock_host().await;
    let mut cfg = room_cfg();
    cfg.checkpoint_every = std::time::Duration::ZERO;
    let state = app(&base, cfg).await;
    let host = state.hosts.get("sample").unwrap();
    let g = grant("u_a", Role::Edit);
    let mut a = Peer::join(&state, g.clone()).await;
    a.settle().await;
    for t in ["one", "two", "three"] {
        set_title(&a, t);
        a.settle().await;
        state.rooms.commit(&host, &g).await.unwrap();
    }
    let (h, cur) = last_put_history(&mock);
    assert_eq!(cur["meta"]["title"], "three");
    // A new file: the empty start is not a version; "one" and "two" are.
    assert_eq!(h.entries.len(), 2);
    let ids: Vec<String> = h.entries.iter().map(|e| e.id.clone()).collect();
    assert_eq!(h.state_of(&cur, &ids[0]).unwrap()["meta"]["title"], "one");
    assert_eq!(h.state_of(&cur, &ids[1]).unwrap()["meta"]["title"], "two");
}

#[tokio::test]
async fn a_loaded_file_keeps_its_history_and_becomes_a_version() {
    let (base, mock) = mock_host().await;
    // The host's file already has one in-file version.
    let older = json!({"type":"doc","content":[],"meta":{"title":"v0"},"databases":{},"boards":{},"comments":{}});
    let current = json!({"type":"doc","content":[],"meta":{"title":"v1"},"databases":{},"boards":{},"comments":{}});
    let mut h = oc_model::history::FileHistory::default();
    let m0 = oc_model::history::VersionMeta {
        id: "c0".into(),
        kind: CommitKind::Named,
        name: Some("First".into()),
        ..Default::default()
    };
    h.advance(&older, &m0, true, &current, Default::default());
    let doc = oc_model::new_doc();
    oc_model::import::apply_document_json(&doc, &current);
    let commit = oc_model::CommitInfo {
        id: "c1".into(),
        ..Default::default()
    };
    let file = oc_model::ocanvas::write_ocanvas_with(&doc, &commit, Some(&h)).unwrap();
    mock.lock().unwrap().files.insert(FILE.into(), (file, 0));
    let state = app(&base, room_cfg()).await;
    let host = state.hosts.get("sample").unwrap();
    let g = grant("u_a", Role::Edit);
    let mut a = Peer::join(&state, g.clone()).await;
    a.settle().await;
    set_title(&a, "v2");
    a.settle().await;
    state.rooms.commit(&host, &g).await.unwrap();
    let (h, cur) = last_put_history(&mock);
    let ids: Vec<&str> = h.entries.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, ["c0", "c1"]);
    assert_eq!(h.entries[0].name.as_deref(), Some("First"));
    assert_eq!(h.state_of(&cur, "c0").unwrap()["meta"]["title"], "v0");
    assert_eq!(h.state_of(&cur, "c1").unwrap()["meta"]["title"], "v1");
}

#[tokio::test]
async fn hosts_can_turn_in_file_history_off() {
    let (base, mock) = mock_host().await;
    let mut cfg = room_cfg();
    cfg.checkpoint_every = std::time::Duration::ZERO;
    let state = app_custom(&base, cfg, &temp_db(), |h| {
        h.versions.insert("file".into(), false.into());
    })
    .await;
    let host = state.hosts.get("sample").unwrap();
    let g = grant("u_a", Role::Edit);
    let mut a = Peer::join(&state, g.clone()).await;
    a.settle().await;
    for t in ["one", "two"] {
        set_title(&a, t);
        a.settle().await;
        state.rooms.commit(&host, &g).await.unwrap();
    }
    let st = mock.lock().unwrap();
    let body = &st.puts.last().unwrap().body;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(body.as_slice())).unwrap();
    assert!((0..z.len()).all(|i| {
        !z.by_index(i)
            .unwrap()
            .name()
            .unwrap()
            .starts_with("history/")
    }));
}
