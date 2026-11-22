// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Durable saves, conflict policies, size limits and the host role API.
mod common;

use std::time::Duration;

use common::*;
use oc_server::config::RoomConfig;
use oc_server::grant::Role;
use serde_json::{Value, json};
use yrs::{Doc, Map, Text, Transact, XmlFragment, XmlTextPrelim, XmlTextRef};

fn type_text(doc: &Doc, s: &str) {
    let content = doc.get_or_insert_xml_fragment("content");
    let mut txn = doc.transact_mut();
    let first: Option<XmlTextRef> = content.get(&txn, 0).and_then(|n| n.into_xml_text());
    match first {
        Some(t) => t.push(&mut txn, s),
        None => {
            content.push_back(&mut txn, XmlTextPrelim::new(s));
        }
    }
}

fn content_text(v: &Value) -> String {
    v["content"]
        .as_array()
        .map(|a| a.iter().filter_map(|n| n["text"].as_str()).collect())
        .unwrap_or_default()
}

fn fast() -> RoomConfig {
    RoomConfig {
        autosave_debounce: Duration::from_millis(50),
        ..room_cfg()
    }
}

fn header(p: &RecordedPut, k: &str) -> String {
    p.headers
        .get(k)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

fn room() -> String {
    grant("u_a", Role::Edit).room
}

// ---------- 1. durable saves ----------

#[tokio::test]
async fn save_is_written_to_the_outbox_before_the_host_call() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().fail = true;
    let state = app(&base, fast()).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    a.edit(|d| type_text(d, "durable"));
    wait_until(|| !host.lock().unwrap().puts.is_empty()).await;

    let rows = state.store.outbox_rows(&room()).await.unwrap();
    assert_eq!(rows.len(), 1, "one pending commit");
    let row = &rows[0];
    assert_eq!(row.status, "pending");
    assert_eq!(ocanvas_text(&row.payload), "durable");
    let put = host.lock().unwrap().puts[0].clone();
    assert_eq!(header(&put, "idempotency-key"), row.id);
    a.settle().await;
    assert!(a.controls.iter().any(|c| c["t"] == "save_error"));
}

#[tokio::test]
async fn pending_save_is_resumed_after_a_restart() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().fail = true;
    let db = temp_db();
    let state = app_custom(&base, fast(), &db, |_| {}).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    a.edit(|d| type_text(d, "survives"));
    wait_until(|| !host.lock().unwrap().puts.is_empty()).await;
    let key = state.store.outbox_rows(&room()).await.unwrap()[0]
        .id
        .clone();

    // The process dies: the room actor goes away without saving, the host recovers.
    state.rooms.crash(&room());
    a.leave();
    drop(state);
    host.lock().unwrap().fail = false;

    let restarted = app_custom(&base, fast(), &db, |_| {}).await;
    assert_eq!(restarted.resume_outbox().await.unwrap(), 1);
    wait_until(|| host.lock().unwrap().files.contains_key(FILE)).await;
    {
        let h = host.lock().unwrap();
        let ok = h.puts.last().unwrap();
        assert_eq!(header(ok, "idempotency-key"), key, "same idempotency key");
        assert_eq!(header(ok, "authorization"), "Bearer cb-u_a");
        assert_eq!(ocanvas_text(&h.files[FILE].0), "survives");
    }
    let mut done = false;
    for _ in 0..100 {
        let rows = restarted.store.outbox_rows(&room()).await.unwrap();
        if rows.iter().all(|r| r.status == "done") {
            done = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(done, "outbox row marked done after the 200");
}

#[tokio::test]
async fn successful_save_marks_the_outbox_row_done() {
    let (base, host) = mock_host().await;
    let state = app(&base, fast()).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    a.edit(|d| type_text(d, "ok"));
    wait_until(|| host.lock().unwrap().files.contains_key(FILE)).await;
    a.settle().await;
    let rows = state.store.outbox_rows(&room()).await.unwrap();
    assert!(!rows.is_empty() && rows.iter().all(|r| r.status == "done"));
    assert!(a.controls.iter().any(|c| c["t"] == "saved"));
}

// ---------- 2. conflict policy ----------

#[tokio::test]
async fn conflict_with_copy_policy_saves_a_copy_and_goes_read_only() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().conflict = true;
    let state = app(&base, fast()).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    a.edit(|d| type_text(d, "mine"));
    wait_until(|| !host.lock().unwrap().copies.is_empty()).await;
    a.settle().await;

    let copy = host.lock().unwrap().copies[0].clone();
    assert!(copy.signature_ok);
    assert_eq!(ocanvas_text(&copy.body), "mine");
    let c = a
        .controls
        .iter()
        .find(|c| c["t"] == "conflict")
        .expect("conflict control")
        .clone();
    assert_eq!(c["policy"], "copy");
    assert_eq!(c["fileId"], "doc_1_copy1");
    assert_eq!(c["url"], "http://host/files/doc_1_copy1");

    a.edit(|d| type_text(d, " more"));
    a.settle().await;
    assert!(a.denied >= 1, "room is read-only after the conflict");
    assert_eq!(content_text(&server_json(&state).await), "mine");
    assert_eq!(host.lock().unwrap().puts.len(), 1, "no further saves");

    // A client reconnecting meanwhile is told about the conflict too.
    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    b.settle().await;
    assert!(
        b.controls
            .iter()
            .any(|c| c["t"] == "conflict" && c["policy"] == "copy")
    );
}

#[tokio::test]
async fn conflict_with_reload_policy_closes_the_room_onto_the_host_version() {
    let (base, host) = mock_host().await;
    let theirs = {
        let d = oc_model::new_doc();
        type_text(&d, "theirs");
        let commit = oc_model::CommitInfo {
            id: "c".into(),
            authors: vec![],
            at: "2026-11-21T00:00:00Z".into(),
        };
        oc_model::write_ocanvas(&d, &commit).unwrap()
    };
    let state = app_custom(&base, fast(), &temp_db(), |h| {
        h.flags.insert("on_conflict".into(), "reload".into());
    })
    .await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    // Someone changes the file outside the session.
    host.lock().unwrap().files.insert(FILE.into(), (theirs, 5));
    a.edit(|d| type_text(d, "mine"));
    wait_until(|| !host.lock().unwrap().puts.is_empty()).await;
    a.settle().await;
    assert!(
        a.controls
            .iter()
            .any(|c| c["t"] == "conflict" && c["policy"] == "reload"),
        "{:?}",
        a.controls
    );
    assert!(a.closed.is_some(), "clients are disconnected to reload");
    assert!(host.lock().unwrap().copies.is_empty());

    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    b.settle().await;
    assert_eq!(content_text(&json_of(&b.doc)), "theirs");
    b.edit(|d| type_text(d, "!"));
    wait_until(|| host.lock().unwrap().files[FILE].1 == 6).await;
    assert_eq!(
        header(host.lock().unwrap().puts.last().unwrap(), "if-match"),
        "\"5\""
    );
}

// ---------- 3. limits ----------

#[tokio::test]
async fn updates_over_the_document_cap_are_refused() {
    let (base, _host) = mock_host().await;
    let state = app(
        &base,
        RoomConfig {
            max_doc_bytes: 4096,
            ..room_cfg()
        },
    )
    .await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;
    a.edit(|d| type_text(d, "small"));
    a.settle().await;
    a.edit(|d| type_text(d, &"x".repeat(5000)));
    a.settle().await;
    b.settle().await;
    assert_eq!(a.denied, 1);
    assert_eq!(content_text(&server_json(&state).await), "small");
    assert_eq!(content_text(&json_of(&b.doc)), "small");
}

// ---------- 5. secrets at rest ----------

#[tokio::test]
async fn callback_tokens_are_encrypted_at_rest() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().fail = true;
    let state = app(&base, fast()).await;
    let ticket = "01TESTTICKETSEALED00000000";
    state
        .store
        .insert_session(ticket, &grant("u_a", Role::Edit), i64::MAX / 2, 0)
        .await
        .unwrap();
    let raw = state.store.raw_grant_json(ticket).await.unwrap().unwrap();
    assert!(!raw.contains("cb-u_a"), "{raw}");
    assert!(raw.contains("enc:v1:"));
    let (g, _) = state.store.session(ticket).await.unwrap().unwrap();
    assert_eq!(g.callback_token, "cb-u_a");

    // The outbox keeps the token sealed too.
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    a.edit(|d| type_text(d, "x"));
    wait_until(|| !host.lock().unwrap().puts.is_empty()).await;
    let raw = state.store.raw_outbox_token(&room()).await.unwrap();
    assert!(
        raw.starts_with("enc:v1:") && !raw.contains("cb-u_a"),
        "{raw}"
    );
}

// ---------- 7. role API ----------

const API_KEY: &str = "test-api-key";

fn with_key(h: &mut oc_server::hosts::HostConfig) {
    h.api_key = Some(API_KEY.into());
}

async fn set_role(addr: &str, key: &str, user: &str, role: &str) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("http://{addr}/v1/files/{FILE}/role"))
        .header("X-OpenCanvas-Key", key)
        .header("X-OpenCanvas-Host", "sample")
        .json(&json!({"userId": user, "role": role}))
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn role_api_downgrades_a_live_session() {
    let (base, _host) = mock_host().await;
    let state = app_custom(&base, room_cfg(), &temp_db(), with_key).await;
    let addr = serve_state(state.clone()).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let mut v = Peer::join(&state, grant("u_v", Role::Edit)).await;
    a.settle().await;
    v.settle().await;
    let ticket = "01TESTTICKETROLE0000000000";
    state
        .store
        .insert_session(ticket, &grant("u_v", Role::Edit), i64::MAX / 2, 0)
        .await
        .unwrap();

    assert_eq!(set_role(&addr, "wrong", "u_v", "view").await.status(), 401);
    let res = set_role(&addr, API_KEY, "u_v", "view").await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["connections"], 1);
    v.settle().await;
    assert_eq!(
        v.controls.last().unwrap(),
        &json!({"t": "role", "role": "view"})
    );
    v.edit(|d| type_text(d, "nope"));
    v.settle().await;
    assert_eq!(v.denied, 1);
    assert_eq!(content_text(&server_json(&state).await), "");
    // Reconnects with the old ticket get the new role.
    let (g, _) = state.store.session(ticket).await.unwrap().unwrap();
    assert_eq!(g.role, Role::View);
    assert_eq!(g.callback_token, "cb-u_v");

    // Upgrade again, then revoke.
    assert_eq!(
        set_role(&addr, API_KEY, "u_v", "comment").await.status(),
        200
    );
    v.settle().await;
    v.edit(|d| {
        d.get_or_insert_map("comments")
            .insert(&mut d.transact_mut(), "t1", "hi");
    });
    v.settle().await;
    assert_eq!(server_json(&state).await["comments"]["t1"], "hi");
    assert_eq!(set_role(&addr, API_KEY, "u_v", "none").await.status(), 200);
    v.settle().await;
    assert_eq!(v.closed, Some(1008));
    assert!(state.store.session(ticket).await.unwrap().is_none());
    assert!(a.closed.is_none(), "other users are untouched");
}

#[tokio::test]
async fn saves_use_a_connected_editor_after_the_last_editor_is_revoked() {
    // PERM-05: u_b joins last, so the room's save token is u_b's. A commit is pending (the
    // host is down) when u_b is revoked; u_a is still editing.
    let (base, host) = mock_host().await;
    let state = app_custom(&base, fast(), &temp_db(), with_key).await;
    let addr = serve_state(state.clone()).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;
    host.lock().unwrap().fail = true;
    b.edit(|d| type_text(d, "pending"));
    wait_until(|| !host.lock().unwrap().puts.is_empty()).await;
    assert_eq!(
        state.store.outbox_rows(&room()).await.unwrap()[0].token,
        "cb-u_b"
    );

    assert_eq!(set_role(&addr, API_KEY, "u_b", "none").await.status(), 200);
    b.settle().await;
    {
        let mut h = host.lock().unwrap();
        h.denied_tokens.insert("cb-u_b".into());
        h.fail = false;
        h.puts.clear();
    }
    a.edit(|d| type_text(d, " more"));
    wait_until(|| host.lock().unwrap().files.contains_key(FILE)).await;
    let h = host.lock().unwrap();
    assert!(
        h.puts
            .iter()
            .all(|p| header(p, "authorization") == "Bearer cb-u_a"),
        "a revoked grant is never used for a save"
    );
    assert!(ocanvas_text(&h.files[FILE].0).contains("pending"));
}

#[tokio::test]
async fn a_save_refused_with_403_falls_back_to_another_editor() {
    let (base, host) = mock_host().await;
    let state = app(&base, fast()).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;
    // The host revoked u_b on its side without telling OpenCanvas.
    host.lock().unwrap().denied_tokens.insert("cb-u_b".into());
    a.edit(|d| type_text(d, "kept"));
    wait_until(|| host.lock().unwrap().files.contains_key(FILE)).await;
    let h = host.lock().unwrap();
    assert_eq!(
        header(h.puts.last().unwrap(), "authorization"),
        "Bearer cb-u_a"
    );
    assert_eq!(ocanvas_text(&h.files[FILE].0), "kept");
}

#[tokio::test]
async fn delete_session_saves_then_closes_everyone() {
    let (base, host) = mock_host().await;
    let state = app_custom(&base, room_cfg(), &temp_db(), with_key).await;
    let addr = serve_state(state.clone()).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    let ticket = "01TESTTICKETDELETE00000000";
    state
        .store
        .insert_session(ticket, &grant("u_a", Role::Edit), i64::MAX / 2, 0)
        .await
        .unwrap();
    a.edit(|d| type_text(d, "last words"));
    a.settle().await;

    let client = reqwest::Client::new();
    let url = format!("http://{addr}/v1/files/{FILE}/session");
    let res = client
        .delete(&url)
        .header("X-OpenCanvas-Host", "sample")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401, "API key required");
    let res = client
        .delete(&url)
        .header("X-OpenCanvas-Key", API_KEY)
        .header("X-OpenCanvas-Host", "sample")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    a.settle().await;
    assert_eq!(
        ocanvas_text(&host.lock().unwrap().files[FILE].0),
        "last words"
    );
    assert!(a.closed.is_some());
    assert!(a.controls.iter().any(|c| c["t"] == "closed"));
    assert!(state.store.session(ticket).await.unwrap().is_none());
    wait_until(|| state.rooms.live_rooms() == 0).await;
}
