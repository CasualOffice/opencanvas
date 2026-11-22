// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! docs/21 revision 2 (ADR-026): the mention list is the canvas's members. The members
//! callback beats the token's `members` beats the saved `people` map; the callback is signed
//! and cached 60 s per room; presence shows real names to everyone; no e-mail anywhere.

mod common;

use std::sync::Arc;

use common::*;
use oc_server::grant::{Role, User};
use oc_server::room::protocol;
use serde_json::{Value, json};
use yrs::ClientID;
use yrs::sync::AwarenessUpdate;
use yrs::sync::awareness::AwarenessUpdateEntry;
use yrs::{Transact, Xml, XmlElementPrelim, XmlFragment, XmlTextPrelim};

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

async fn ticket_for(state: &oc_server::SharedState, g: &oc_server::grant::Grant) -> String {
    let t = ulid::Ulid::new().to_string();
    state
        .store
        .insert_session(&t, g, now_secs() + 600, 0)
        .await
        .unwrap();
    t
}

fn person(id: &str, name: &str) -> User {
    User {
        id: id.into(),
        name: name.into(),
        color: "#123456".into(),
        ..Default::default()
    }
}

/// Sends one awareness state for client `client` from `p`.
fn announce(p: &Peer, client: u64) {
    let st = json!({"user": {"name": "whatever", "email": "x@acme.example"}, "cursor": null})
        .to_string();
    p.send(protocol::awareness(AwarenessUpdate {
        clients: [(
            ClientID::new(client),
            AwarenessUpdateEntry {
                clock: 1,
                json: Arc::from(st.as_str()),
            },
        )]
        .into(),
    }));
}

/// The newest awareness `user` `p` received for `client`.
fn last_user(p: &Peer, client: u64) -> Option<Value> {
    p.awareness.iter().rev().find_map(|u| {
        u.clients
            .get(&ClientID::new(client))
            .and_then(|e| serde_json::from_str::<Value>(&e.json).ok())
            .map(|v| v["user"].clone())
    })
}

async fn members_of(addr: &str, t: &str, q: &str) -> Vec<Value> {
    let v: Value = http()
        .get(format!("http://{addr}/v1/members?ticket={t}&q={q}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    v["members"].as_array().cloned().unwrap_or_default()
}

fn ids(list: &[Value]) -> Vec<String> {
    list.iter()
        .map(|m| m["id"].as_str().unwrap().to_string())
        .collect()
}

/// Callback beats token beats the saved map; the callback is signed, cached per room (one
/// call for two viewers), and e-mails in host answers are dropped.
#[tokio::test]
async fn members_merge_callback_over_token_and_cache_per_room() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().members = Some(json!([
        {"id": "u_a", "name": "Asha (callback)", "email": "asha@acme.example"},
        {"id": "u_c", "name": "Chen", "detail": "Ops"}
    ]));
    let state = app(&base, room_cfg()).await;
    let mut g = grant("u_v", Role::Edit);
    g.members = vec![person("u_a", "Asha (token)"), person("u_b", "Ben")];
    let t = ticket_for(&state, &g).await;
    let t2 = ticket_for(&state, &grant("u_w", Role::View)).await;
    let addr = serve_state(state.clone()).await;

    let list = members_of(&addr, &t, "").await;
    assert_eq!(ids(&list), ["u_a", "u_c", "u_b", "u_v"]);
    assert_eq!(list[0]["name"], "Asha (callback)");
    assert_eq!(list[1]["detail"], "Ops");
    assert!(!Value::Array(list).to_string().contains('@'));

    // The other viewer gets the same host list, from the cache.
    let other = members_of(&addr, &t2, "").await;
    assert_eq!(ids(&other), ["u_a", "u_c", "u_w"]);
    let calls = host.lock().unwrap().members_calls.clone();
    assert_eq!(calls.len(), 1, "cached per room: {calls:?}");
    assert_eq!(calls[0].0, FILE);
    assert!(calls[0].2, "members callback is signed");

    // q goes to the host and filters the token list.
    let q = members_of(&addr, &t, "ben").await;
    assert_eq!(ids(&q), ["u_b"]);
    assert_eq!(host.lock().unwrap().members_calls.last().unwrap().1, "ben");
}

/// No callback (404) and no token `members`: the list is everyone who opened the canvas.
/// With a token list, someone who opened it but is no longer listed is not a member.
#[tokio::test]
async fn without_a_host_source_members_are_who_opened_it() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let mut a = Peer::join(&state, {
        let mut g = grant("u_a", Role::Edit);
        g.user.detail = Some("Design".into());
        g
    })
    .await;
    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;
    let people = json_of(&b.doc)["people"].clone();
    assert_eq!(people["u_a"]["detail"], "Design");
    assert!(people["u_a"].get("email").is_none());

    let t = ticket_for(&state, &grant("u_b", Role::Edit)).await;
    let addr = serve_state(state.clone()).await;
    let list = members_of(&addr, &t, "").await;
    let mut got = ids(&list);
    got.sort();
    assert_eq!(got, ["u_a", "u_b"]);

    let mut g = grant("u_b", Role::Edit);
    g.members = vec![person("u_c", "Chen")];
    let t = ticket_for(&state, &g).await;
    assert_eq!(ids(&members_of(&addr, &t, "").await), ["u_c", "u_b"]);
}

/// Presence: everyone sees the sender's real name and detail, stamped from the grant (never
/// what the client claimed, never an e-mail).
#[tokio::test]
async fn presence_shows_real_names_to_everyone() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let mut a = Peer::join(&state, {
        let mut g = grant("u_a", Role::Edit);
        g.user.detail = Some("Design".into());
        g
    })
    .await;
    let mut b = Peer::join(&state, grant("u_b", Role::View)).await;
    a.settle().await;
    b.settle().await;
    announce(&a, 21);
    b.settle().await;
    b.settle().await;
    let u = last_user(&b, 21).expect("presence relayed");
    assert_eq!(u["name"], "Name of u_a");
    assert_eq!(u["detail"], "Design");
    assert!(!u.to_string().contains('@'), "{u}");
}

fn mention(doc: &yrs::Doc, id: &str, label: &str) {
    let frag = doc.get_or_insert_xml_fragment("content");
    let mut txn = doc.transact_mut();
    let p = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    p.push_back(&mut txn, XmlTextPrelim::new("Ask "));
    let m = p.push_back(&mut txn, XmlElementPrelim::empty("mention"));
    m.insert_attribute(&mut txn, "id", id);
    m.insert_attribute(&mut txn, "label", label);
}

/// Exports show members' current names; a non-member keeps the snapshot label.
#[tokio::test]
async fn exports_use_members_current_names() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().members = Some(json!([{"id": "u_a", "name": "Callback A"}]));
    let state = app(&base, room_cfg()).await;
    let mut g = grant("u_v", Role::Edit);
    g.members = vec![person("u_a", "Token A"), person("u_b", "Token B")];
    let mut p = Peer::join(&state, g.clone()).await;
    p.settle().await;
    p.edit(|d| {
        mention(d, "u_a", "Snapshot A");
        mention(d, "u_b", "Snapshot B");
        mention(d, "u_gone", "Snapshot Gone");
    });
    p.settle().await;
    let t = ticket_for(&state, &g).await;
    let addr = serve_state(state.clone()).await;
    let out = http()
        .get(format!("http://{addr}/v1/export/md?ticket={t}"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(out.contains("@Callback A"), "callback wins: {out}");
    assert!(out.contains("@Token B"), "then the token: {out}");
    assert!(
        out.contains("@Snapshot Gone"),
        "non-member: snapshot: {out}"
    );
}

/// The session never carries e-mail, participants or directory settings.
#[tokio::test]
async fn session_has_no_email_or_directory() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let t = ticket_for(&state, &grant("u_a", Role::Edit)).await;
    let addr = serve_state(state.clone()).await;
    let s: Value = http()
        .get(format!("http://{addr}/v1/sessions/{t}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(s.get("participants").is_none());
    assert!(s.get("directory").is_none());
    assert!(s["perms"].get("showEmail").is_none());
    assert!(s["user"].get("email").is_none());
    let old = http()
        .get(format!("http://{addr}/v1/users?ticket={t}&q=a"))
        .send()
        .await
        .unwrap();
    assert_ne!(old.status(), 200, "GET /v1/users is gone");
}

fn host_post(addr: &str, path: &str) -> reqwest::RequestBuilder {
    http()
        .post(format!("http://{addr}{path}"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", "test-api-key")
}

/// Revocation is authoritative (docs/21 revision 2): after the role API revokes Sam, the
/// cached callback answer, Priya's older token and the saved map no longer list him, the
/// others in the room are told to refetch, and the invalidate call drops the cache.
#[tokio::test]
async fn revoke_removes_a_member_at_once() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().members = Some(json!([
        {"id": "u_priya", "name": "Priya"}, {"id": "u_sam", "name": "Sam"}
    ]));
    let state = app_custom(&base, room_cfg(), &temp_db(), |h| {
        h.api_key = Some("test-api-key".into());
    })
    .await;
    let mut g = grant("u_priya", Role::Edit);
    g.members = vec![person("u_sam", "Sam")];
    let mut priya = Peer::join(&state, g.clone()).await;
    let mut sam = Peer::join(&state, grant("u_sam", Role::Edit)).await;
    priya.settle().await;
    sam.settle().await;
    let t = ticket_for(&state, &g).await;
    let addr = serve_state(state.clone()).await;
    assert!(ids(&members_of(&addr, &t, "").await).contains(&"u_sam".to_string()));

    // The host revokes Sam, and its callback stops listing him.
    host.lock().unwrap().members = Some(json!([{"id": "u_priya", "name": "Priya"}]));
    let r = host_post(&addr, &format!("/v1/files/{FILE}/role"))
        .json(&json!({"userId": "u_sam", "role": "none"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    priya.settle().await;
    assert!(
        priya.controls.iter().any(|c| c["t"] == "members"),
        "the room is told the list changed: {:?}",
        priya.controls
    );
    let list = ids(&members_of(&addr, &t, "").await);
    assert!(!list.contains(&"u_sam".to_string()), "{list:?}");
    assert_eq!(
        host.lock().unwrap().members_calls.len(),
        2,
        "the revoke invalidated the cache"
    );

    // The invalidate call drops the cache too.
    members_of(&addr, &t, "").await;
    assert_eq!(host.lock().unwrap().members_calls.len(), 2, "cached");
    let r = host_post(&addr, &format!("/v1/files/{FILE}/members/invalidate"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    members_of(&addr, &t, "").await;
    assert_eq!(host.lock().unwrap().members_calls.len(), 3, "refetched");
    let r = http()
        .post(format!("http://{addr}/v1/files/{FILE}/members/invalidate"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401, "host-authenticated");
}
