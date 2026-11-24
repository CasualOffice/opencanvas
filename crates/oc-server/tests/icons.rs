// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! DGM-17 Add your own icon (ADR-057): `POST /v1/icons` cleans the file and the server writes
//! it into the document's `icons` root; clients can't touch that root, like `comments`.
mod common;

use common::*;
use oc_server::SharedState;
use oc_server::grant::Role;
use serde_json::{Value, json};
use yrs::{Map, Transact, WriteTxn};

async fn serve() -> (String, SharedState) {
    let (base, _h) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    (serve_state(state.clone()).await, state)
}

async fn ticket(state: &SharedState, user: &str, role: Role) -> String {
    let g = grant(user, role);
    let t = ulid::Ulid::new().to_string();
    let exp = oc_server::util::now_secs() + 600;
    state.store.insert_session(&t, &g, exp, 0).await.unwrap();
    t
}

async fn upload(addr: &str, t: &str, query: &str, body: &[u8]) -> (u16, Value) {
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/v1/icons?ticket={t}&{query}"))
        .body(body.to_vec())
        .send()
        .await
        .unwrap();
    let s = res.status().as_u16();
    (s, res.json().await.unwrap_or(Value::Null))
}

async fn change(addr: &str, t: &str, id: &str, body: Value) -> (u16, Value) {
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/v1/icons/{id}?ticket={t}"))
        .json(&body)
        .send()
        .await
        .unwrap();
    let s = res.status().as_u16();
    (s, res.json().await.unwrap_or(Value::Null))
}

const LOGO: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>alert(1)</script><circle cx="12" cy="12" r="10" fill="#2a5ad7" onclick="x()"/></svg>"##;

#[tokio::test]
async fn an_editor_adds_a_cleaned_icon_that_everyone_gets() {
    let (addr, state) = serve().await;
    let mut peer = Peer::join(&state, grant("u_b", Role::Edit)).await;
    peer.settle().await;
    let t = ticket(&state, "u_a", Role::Edit).await;

    // Dry run: the cleaning report and a preview, nothing stored.
    let (s, v) = upload(&addr, &t, "dryRun=1", LOGO).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["format"], "svg");
    assert!(
        v["removed"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["what"] == "Scripts")
    );
    assert!(
        v["removed"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["what"] == "Event handlers")
    );
    assert!(
        v["dataUrl"]
            .as_str()
            .unwrap()
            .starts_with("data:image/svg+xml;base64,")
    );
    assert!(v["id"].is_null());
    assert!(server_json(&state).await.get("icons").is_none());

    let (s, v) = upload(&addr, &t, "name=Jitsi%20Meet&keywords=video,meetings", LOGO).await;
    assert_eq!(s, 200, "{v}");
    let id = v["id"].as_str().unwrap().to_string();
    let doc = server_json(&state).await;
    let icon = &doc["icons"][&id];
    assert_eq!(icon["name"], "Jitsi Meet");
    assert_eq!(icon["keywords"], json!(["video", "meetings"]));
    assert_eq!(icon["by"], "u_a");
    assert!(oc_model::doc_icons::data_url(icon).is_some());
    peer.settle().await;
    assert_eq!(json_of(&peer.doc)["icons"][&id]["name"], "Jitsi Meet");

    // Rename, then remove.
    let (s, _) = change(
        &addr,
        &t,
        &id,
        json!({"name": "Jitsi", "keywords": ["video"]}),
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(server_json(&state).await["icons"][&id]["name"], "Jitsi");
    let (s, _) = change(&addr, &t, &id, json!({"remove": true})).await;
    assert_eq!(s, 200);
    assert!(server_json(&state).await.get("icons").is_none());
}

#[tokio::test]
async fn refusals_view_role_and_the_rate_limit() {
    let (addr, state) = serve().await;
    let viewer = ticket(&state, "u_v", Role::View).await;
    let (s, _) = upload(&addr, &viewer, "name=x", LOGO).await;
    assert_eq!(s, 403);

    let t = ticket(&state, "u_a", Role::Edit).await;
    let mut fake = b"\x89PNG\r\n\x1a\n".to_vec();
    fake.extend_from_slice(b"<svg onload=alert(1)>");
    let (s, v) = upload(&addr, &t, "name=x", &fake).await;
    assert_eq!(s, 422, "{v}");
    assert_eq!(v["code"], "invalid_png");
    assert!(v["message"].as_str().unwrap().contains("PNG"));
    let (s, v) = upload(&addr, &t, "name=x", &vec![b' '; 300 * 1024]).await;
    assert_eq!(s, 413, "{v}");

    // 20 uploads a minute per person.
    let t2 = ticket(&state, "u_r", Role::Edit).await;
    for _ in 0..20 {
        let (s, _) = upload(&addr, &t2, "dryRun=1", LOGO).await;
        assert_eq!(s, 200);
    }
    let (s, _) = upload(&addr, &t2, "dryRun=1", LOGO).await;
    assert_eq!(s, 429);
}

#[tokio::test]
async fn clients_cannot_write_the_icons_root() {
    let (addr, state) = serve().await;
    let t = ticket(&state, "u_a", Role::Edit).await;
    let (s, v) = upload(&addr, &t, "name=Logo", LOGO).await;
    assert_eq!(s, 200, "{v}");
    let id = v["id"].as_str().unwrap().to_string();

    let mut peer = Peer::join(&state, grant("u_b", Role::Edit)).await;
    peer.settle().await;
    assert!(json_of(&peer.doc)["icons"][&id].is_object());
    let before = server_json(&state).await["icons"].clone();

    // A new entry, a change inside an existing one, and a removal: all refused.
    peer.edit(|d| {
        let m = d.transact_mut().get_or_insert_map("icons");
        m.insert(&mut d.transact_mut(), "evil", "<svg onload=alert(1)>");
    });
    peer.settle().await;
    assert!(peer.denied >= 1);
    assert_eq!(server_json(&state).await["icons"], before);

    let mut p2 = Peer::join(&state, grant("u_c", Role::Edit)).await;
    p2.settle().await;
    p2.edit(|d| {
        let mut txn = d.transact_mut();
        let root = txn.get_or_insert_map("icons");
        if let Some(yrs::Out::YMap(e)) = root.get(&txn, &id) {
            e.insert(&mut txn, "data", "PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+");
        }
    });
    p2.settle().await;
    assert!(p2.denied >= 1);
    assert_eq!(server_json(&state).await["icons"], before);

    let mut p3 = Peer::join(&state, grant("u_d", Role::Edit)).await;
    p3.settle().await;
    p3.edit(|d| {
        let mut txn = d.transact_mut();
        let root = txn.get_or_insert_map("icons");
        root.remove(&mut txn, &id);
    });
    p3.settle().await;
    assert!(p3.denied >= 1);
    assert_eq!(server_json(&state).await["icons"], before);

    // Ordinary edits still go through in a document that has icons.
    let mut p4 = Peer::join(&state, grant("u_e", Role::Edit)).await;
    p4.settle().await;
    p4.edit(|d| {
        let m = d.transact_mut().get_or_insert_map("meta");
        m.insert(&mut d.transact_mut(), "title", "Still editable");
    });
    p4.settle().await;
    assert_eq!(p4.denied, 0);
    assert_eq!(server_json(&state).await["meta"]["title"], "Still editable");
}
