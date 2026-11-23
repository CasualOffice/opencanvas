// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Version history REST for the editor (VH-01b, docs/30 §4-6, §8): list, preview, diff, name,
//! restore (save first, minimal edit, restore save, `restored` control) and undo.

mod common;

use std::time::Duration;

use common::*;
use jsonwebtoken::{EncodingKey, Header, encode};
use oc_server::grant::Role;
use serde_json::{Value, json};

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn token(user: &str, role: &str, perms: Value) -> String {
    let claims = json!({
        "iss": "sample", "aud": "opencanvas", "exp": now() + 600, "jti": ulid::Ulid::new().to_string(),
        "file": {"id": FILE, "name": "Doc one", "version": "0"},
        "user": {"id": user, "name": format!("Name of {user}")},
        "role": role, "perms": perms, "callbackToken": format!("cb-{user}")
    });
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

async fn ticket(addr: &str, tok: &str) -> String {
    let res = http()
        .post(format!("http://{addr}/v1/launch"))
        .form(&[("token", tok)])
        .send()
        .await
        .unwrap();
    let loc = res.headers()["location"].to_str().unwrap().to_string();
    loc.split("#t=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap()
        .to_string()
}

async fn get(addr: &str, path: &str) -> (u16, Value) {
    let r = http()
        .get(format!("http://{addr}{path}"))
        .send()
        .await
        .unwrap();
    (r.status().as_u16(), r.json().await.unwrap_or(Value::Null))
}

async fn post(addr: &str, path: &str, body: Value) -> (u16, Value) {
    let r = http()
        .post(format!("http://{addr}{path}"))
        .json(&body)
        .send()
        .await
        .unwrap();
    (r.status().as_u16(), r.json().await.unwrap_or(Value::Null))
}

fn set_title(p: &Peer, t: &str) {
    use yrs::{Map, Transact};
    let t = t.to_string();
    p.edit(move |d| {
        d.get_or_insert_map("meta")
            .insert(&mut d.transact_mut(), "title", t);
    });
}

fn hdr<'a>(p: &'a RecordedPut, k: &str) -> Option<&'a str> {
    p.headers.get(k).and_then(|v| v.to_str().ok())
}

/// An `.ocanvas` with this title and one paragraph.
fn version_file(title: &str, text: &str) -> Vec<u8> {
    let doc = oc_model::new_doc();
    oc_model::import::apply_document_json(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"b_1"},"content":[{"type":"text","text":text}]}],
            "meta":{"title":title},"databases":{},"boards":{},"comments":{}}),
    );
    oc_model::write_ocanvas(&doc, &Default::default()).unwrap()
}

struct Setup {
    addr: String,
    state: oc_server::SharedState,
    mock: Shared,
}

async fn setup(
    tweak: impl FnOnce(&mut oc_server::config::RoomConfig),
    host_versions: bool,
) -> Setup {
    let (base, mock) = mock_host().await;
    let mut cfg = room_cfg();
    tweak(&mut cfg);
    let state = app_custom(&base, cfg, &temp_db(), |h| {
        if host_versions {
            h.flags.insert("history".into(), true.into());
        }
    })
    .await;
    let addr = serve_state(state.clone()).await;
    Setup { addr, state, mock }
}

const ALL: fn() -> Value = || json!({"export": true, "download": true, "comment": true});

#[tokio::test]
async fn naming_saves_now_with_the_name_even_without_changes() {
    let s = setup(|_| {}, true).await;
    let t = ticket(&s.addr, &token("u_1", "edit", ALL())).await;
    let mut a = Peer::join(&s.state, grant("u_1", Role::Edit)).await;
    a.settle().await;
    set_title(&a, "draft");
    a.settle().await;
    let (st, r) = post(
        &s.addr,
        &format!("/v1/history/name?ticket={t}"),
        json!({"name": " Board review ready "}),
    )
    .await;
    assert_eq!(st, 200, "{r}");
    assert_eq!(r["name"], "Board review ready");
    assert_eq!(r["version"], "1");
    // Nothing changed since: still a save, so the host gets a labelled version.
    let (st, r) = post(
        &s.addr,
        &format!("/v1/history/name?ticket={t}"),
        json!({"name": "Again"}),
    )
    .await;
    assert_eq!(st, 200, "{r}");
    assert_eq!(r["version"], "2");
    let puts = s.mock.lock().unwrap().puts.clone();
    assert_eq!(puts.len(), 2);
    assert_eq!(hdr(&puts[0], "x-opencanvas-autosave"), Some("0"));
    assert_eq!(
        hdr(&puts[0], "x-opencanvas-commit-message"),
        Some("Board%20review%20ready")
    );
    assert_eq!(hdr(&puts[1], "x-opencanvas-commit-message"), Some("Again"));
    let m = oc_model::ocanvas::read_manifest(&puts[1].body).unwrap();
    assert_eq!(m["commit"]["kind"], "named");
    // Names are 1-120 characters.
    let (st, _) = post(
        &s.addr,
        &format!("/v1/history/name?ticket={t}"),
        json!({"name": "  "}),
    )
    .await;
    assert_eq!(st, 400);
    let long = "x".repeat(121);
    let (st, _) = post(
        &s.addr,
        &format!("/v1/history/name?ticket={t}"),
        json!({"name": long}),
    )
    .await;
    assert_eq!(st, 400);
}

#[tokio::test]
async fn viewers_need_the_history_perm_and_never_name_or_restore() {
    let s = setup(|_| {}, true).await;
    let v = ticket(&s.addr, &token("u_v", "view", ALL())).await;
    let (st, _) = get(&s.addr, &format!("/v1/history?ticket={v}")).await;
    assert_eq!(st, 403);
    s.mock.lock().unwrap().versions = Some(json!({"versions": []}));
    let vh = ticket(
        &s.addr,
        &token("u_v", "view", json!({"export": true, "history": true})),
    )
    .await;
    let (st, _) = get(&s.addr, &format!("/v1/history?ticket={vh}")).await;
    assert_eq!(st, 200);
    let (st, _) = post(
        &s.addr,
        &format!("/v1/history/name?ticket={vh}"),
        json!({"name": "x"}),
    )
    .await;
    assert_eq!(st, 403);
    let (st, _) = post(
        &s.addr,
        &format!("/v1/history/5/restore?ticket={vh}"),
        json!({}),
    )
    .await;
    assert_eq!(st, 403);
    let nr = ticket(&s.addr, &token("u_e", "edit", json!({"restore": false}))).await;
    let (st, _) = post(
        &s.addr,
        &format!("/v1/history/5/restore?ticket={nr}"),
        json!({}),
    )
    .await;
    assert_eq!(st, 403);
}

#[tokio::test]
async fn list_merges_host_versions_and_recent_in_file_ones() {
    let s = setup(|c| c.checkpoint_every = Duration::ZERO, true).await;
    let t = ticket(&s.addr, &token("u_1", "edit", ALL())).await;
    let host = s.state.hosts.get("sample").unwrap();
    let g = grant("u_1", Role::Edit);
    let mut a = Peer::join(&s.state, g.clone()).await;
    a.settle().await;
    for title in ["one", "two"] {
        set_title(&a, title);
        a.settle().await;
        s.state.rooms.commit(&host, &g).await.unwrap();
    }
    s.mock.lock().unwrap().versions = Some(json!({"versions": [
        {"version": "2", "at": "2026-11-24T10:00:00Z", "authors": ["u_1"], "kind": "auto"},
        {"version": "1", "at": "2026-11-24T09:00:00Z", "authors": ["u_1"], "kind": "named", "name": "First"}
    ]}));
    let (st, r) = get(&s.addr, &format!("/v1/history?ticket={t}")).await;
    assert_eq!(st, 200, "{r}");
    assert_eq!(r["source"], "host");
    assert_eq!(r["hostName"], "Sample");
    assert_eq!(r["versions"][1]["name"], "First");
    assert_eq!(r["versions"][0]["source"], "host");
    // In-file: the file's own state ("two"), then "one".
    let recent = r["recent"].as_array().unwrap();
    assert_eq!(recent.len(), 2);
    assert!(recent[0]["version"].as_str().unwrap().starts_with("file:"));
    assert_eq!(recent[0]["latest"], true);
    // Each in-file version previews as its own state.
    let v = recent[1]["version"].as_str().unwrap();
    let bytes = http()
        .get(format!("http://{}/v1/history/{v}?ticket={t}", s.addr))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let d = oc_model::new_doc();
    oc_model::ocanvas::apply_update_bytes(&d, &bytes).unwrap();
    assert_eq!(oc_model::doc_to_json(&d)["meta"]["title"], "one");
}

#[tokio::test]
async fn a_host_without_the_list_call_falls_back_to_in_file_history() {
    let s = setup(|c| c.checkpoint_every = Duration::ZERO, true).await;
    let t = ticket(&s.addr, &token("u_1", "edit", ALL())).await;
    let host = s.state.hosts.get("sample").unwrap();
    let g = grant("u_1", Role::Edit);
    let mut a = Peer::join(&s.state, g.clone()).await;
    a.settle().await;
    set_title(&a, "one");
    a.settle().await;
    s.state.rooms.commit(&host, &g).await.unwrap();
    // mock.versions = None: the host answers 404.
    let (st, r) = get(&s.addr, &format!("/v1/history?ticket={t}")).await;
    assert_eq!(st, 200, "{r}");
    assert_eq!(r["source"], "file");
    assert_eq!(r["versions"].as_array().unwrap().len(), 1);
}

async fn restore_setup(window: Duration) -> (Setup, String, Peer, Peer) {
    let s = setup(move |c| c.restore_undo_window = window, true).await;
    s.mock.lock().unwrap().version_bodies.insert(
        "5".into(),
        version_file("Old title", "Admins sign in with SAML"),
    );
    let t = ticket(&s.addr, &token("u_1", "edit", ALL())).await;
    let mut a = Peer::join(&s.state, grant("u_1", Role::Edit)).await;
    let mut b = Peer::join(&s.state, grant("u_2", Role::Edit)).await;
    a.settle().await;
    b.settle().await;
    set_title(&a, "New title");
    a.settle().await;
    b.settle().await;
    (s, t, a, b)
}

#[tokio::test]
async fn restore_saves_first_applies_the_version_saves_it_and_tells_everyone() {
    let (s, t, mut a, mut b) = restore_setup(Duration::from_secs(30)).await;
    let (st, r) = post(
        &s.addr,
        &format!("/v1/history/5/restore?ticket={t}"),
        json!({"label": "Nov 21, 10:14"}),
    )
    .await;
    assert_eq!(st, 200, "{r}");
    assert_eq!(r["name"], "Restored from Nov 21, 10:14");
    assert_eq!(r["changed"], true);
    let puts = s.mock.lock().unwrap().puts.clone();
    assert_eq!(puts.len(), 2, "a save before and the restore save");
    let before = oc_model::read_ocanvas(&puts[0].body).unwrap();
    assert_eq!(
        oc_model::doc_to_json(&before.doc)["meta"]["title"],
        "New title"
    );
    assert_eq!(hdr(&puts[0], "x-opencanvas-checkpoint"), Some("1"));
    assert_eq!(hdr(&puts[1], "x-opencanvas-autosave"), Some("0"));
    assert_eq!(hdr(&puts[1], "x-opencanvas-restored-from"), Some("5"));
    assert_eq!(
        hdr(&puts[1], "x-opencanvas-commit-message"),
        Some("Restored%20from%20Nov%2021%2C%2010%3A14")
    );
    let saved = oc_model::doc_to_json(&oc_model::read_ocanvas(&puts[1].body).unwrap().doc);
    assert_eq!(saved["meta"]["title"], "Old title");
    // Everyone's doc follows, and everyone is told.
    a.settle().await;
    b.settle().await;
    assert_eq!(json_of(&b.doc)["meta"]["title"], "Old title");
    let ctl = b
        .controls
        .iter()
        .find(|c| c["t"] == "restored")
        .expect("restored control");
    assert_eq!(ctl["by"], "u_1");
    assert_eq!(ctl["byName"], "Name of u_1");
    assert_eq!(ctl["from"], "5");
    // The person who restored may undo it.
    let rid = r["restoreId"].as_str().unwrap();
    let (st, u) = post(
        &s.addr,
        &format!("/v1/history/restore/undo?ticket={t}&restoreId={rid}"),
        json!({}),
    )
    .await;
    assert_eq!(st, 200, "{u}");
    b.settle().await;
    assert_eq!(json_of(&b.doc)["meta"]["title"], "New title");
    // Once.
    let (st, _) = post(
        &s.addr,
        &format!("/v1/history/restore/undo?ticket={t}&restoreId={rid}"),
        json!({}),
    )
    .await;
    assert_eq!(st, 409);
}

#[tokio::test]
async fn only_the_restorer_may_undo_and_only_within_the_window() {
    let (s, t, _a, _b) = restore_setup(Duration::ZERO).await;
    let (_, r) = post(
        &s.addr,
        &format!("/v1/history/5/restore?ticket={t}"),
        json!({}),
    )
    .await;
    let rid = r["restoreId"].as_str().unwrap().to_string();
    assert_eq!(r["name"], "Restored from 5");
    let other = ticket(&s.addr, &token("u_2", "edit", ALL())).await;
    let (st, e) = post(
        &s.addr,
        &format!("/v1/history/restore/undo?ticket={other}&restoreId={rid}"),
        json!({}),
    )
    .await;
    assert_eq!(
        (st, e["error"]["code"].as_str()),
        (409, Some("NOTHING_TO_UNDO"))
    );
    let (st, e) = post(
        &s.addr,
        &format!("/v1/history/restore/undo?ticket={t}&restoreId={rid}"),
        json!({}),
    )
    .await;
    assert_eq!(
        (st, e["error"]["code"].as_str()),
        (409, Some("UNDO_EXPIRED"))
    );
}

#[tokio::test]
async fn diff_from_a_version_to_the_live_canvas() {
    let (s, t, _a, _b) = restore_setup(Duration::from_secs(30)).await;
    let (st, d) = get(
        &s.addr,
        &format!("/v1/history/diff?ticket={t}&from=5&to=current"),
    )
    .await;
    assert_eq!(st, 200, "{d}");
    // The live canvas has the new title and no paragraph.
    assert_eq!(
        d["meta"][0],
        json!({"field": "title", "old": "Old title", "new": "New title"})
    );
    assert_eq!(d["blocks"][0]["op"], "removed");
    let (st, e) = get(
        &s.addr,
        &format!("/v1/history/diff?ticket={t}&from=404&to=current"),
    )
    .await;
    assert_eq!(
        (st, e["error"]["code"].as_str()),
        (404, Some("VERSION_GONE"))
    );
}
