// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Portable live blocks on the server (LIVE-01, LIVE-02; docs/27 §2, ADR-039): the host
//! contract (`[host.flags] live_blocks`, `[host.live]`, `POST /files`, `/access`, the token's
//! `perms.live` and `live` claim), derived grants, "Make live", the room rules (old editors,
//! the depth rule, the reference limit, the snapshot policy) and the open live block limit.
mod common;

use common::*;
use jsonwebtoken::{EncodingKey, Header, encode};
use oc_server::grant::{Grant, Role, room_id};
use serde_json::{Value, json};
use yrs::{Transact, Xml, XmlElementPrelim, XmlFragment, XmlTextPrelim};

const API_KEY: &str = "test-api-key";

fn live_on(h: &mut oc_server::hosts::HostConfig) {
    h.api_key = Some(API_KEY.into());
    h.flags
        .insert("live_blocks".into(), toml::Value::Boolean(true));
}

async fn serve_with(
    tweak: impl FnOnce(&mut oc_server::hosts::HostConfig),
) -> (String, oc_server::SharedState, Shared) {
    let (base, host) = mock_host().await;
    let state = app_custom(&base, room_cfg(), &temp_db(), tweak).await;
    (serve_state(state.clone()).await, state, host)
}

async fn serve() -> (String, oc_server::SharedState, Shared) {
    serve_with(live_on).await
}

fn token(user: &str, extra: Value) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let mut claims = json!({
        "iss": "sample", "aud": "opencanvas", "exp": now + 600, "jti": ulid::Ulid::new().to_string(),
        "file": {"id": FILE, "name": "Doc one", "version": "0"},
        "user": {"id": user, "name": format!("Name of {user}")}, "role": "edit",
        "perms": {"live": true}, "callbackToken": format!("cb-{user}")
    });
    if let (Some(c), Some(e)) = (claims.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            c.insert(k.clone(), v.clone());
        }
    }
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

/// Launches `user` on `doc_1`; returns the session ticket.
async fn launch(addr: &str, user: &str, extra: Value) -> String {
    let res = http()
        .post(format!("http://{addr}/v1/launch"))
        .form(&[("token", token(user, extra))])
        .send()
        .await
        .unwrap();
    let loc = res.headers()["location"].to_str().unwrap().to_string();
    loc.strip_prefix("/app/#t=").unwrap().to_string()
}

fn api(addr: &str, method: reqwest::Method, file: &str, path: &str) -> reqwest::RequestBuilder {
    http()
        .request(method, format!("http://{addr}/api/v1/files/{file}{path}"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", API_KEY)
        .header("X-OpenCanvas-Callback-Token", "cb-u_1")
}

async fn batch(addr: &str, file: &str, ops: Value) -> (u16, Value) {
    let res = api(addr, reqwest::Method::POST, file, "/blocks:batch")
        .json(&json!({"ops": ops}))
        .send()
        .await
        .unwrap();
    (
        res.status().as_u16(),
        res.json().await.unwrap_or(Value::Null),
    )
}

fn live_node(block: &str, file: &str) -> Value {
    json!({"type": "liveBlock", "attrs": {"blockId": block, "fileId": file, "kind": "blocks", "title": format!("Title {file}")}})
}

/// `doc_1` embeds live files `files` (through the API: the server's own write).
async fn embed(addr: &str, files: &[&str]) {
    let blocks: Vec<Value> = files
        .iter()
        .enumerate()
        .map(|(i, f)| live_node(&format!("b_live{i}"), f))
        .collect();
    let (s, out) = batch(addr, FILE, json!([{"op": "append", "blocks": blocks}])).await;
    assert_eq!(s, 200, "{out}");
}

async fn post(addr: &str, path: &str, body: Value) -> (u16, Value) {
    let res = http()
        .post(format!("http://{addr}{path}"))
        .json(&body)
        .send()
        .await
        .unwrap();
    (
        res.status().as_u16(),
        res.json().await.unwrap_or(Value::Null),
    )
}

async fn live_session(addr: &str, ticket: &str, file: &str) -> (u16, Value) {
    post(
        addr,
        "/v1/live/session",
        json!({"ticket": ticket, "fileId": file}),
    )
    .await
}

fn grant_access(host: &Shared, file: &str, user: &str, role: &str) {
    host.lock()
        .unwrap()
        .access_files
        .insert((file.into(), user.into()), role.into());
}

async fn stored_grant(state: &oc_server::SharedState, ticket: &str) -> (Grant, i64) {
    state.store.session(ticket).await.unwrap().unwrap()
}

#[test]
fn live_settings_are_checked_at_start_up() {
    let src = |extra: &str| {
        format!(
            "[[host]]\nid = \"h\"\nname = \"N\"\njwt_secret = \"0123456789abcdef0123456789abcdef\"\ncallback_base = \"http://h/api\"\n{extra}"
        )
    };
    let parse = |extra: &str| oc_server::hosts::Hosts::parse(&src(extra), None);
    assert!(
        parse(
            "[host.flags]\nlive_blocks = true\n[host.live]\nsnapshot = \"content\"\nmax_open = 4\n"
        )
        .is_ok()
    );
    let h = parse("").unwrap();
    assert!(!h.get("h").unwrap().live_blocks(), "off by default");
    for bad in [
        "[host.flags]\nlive_blocks = \"yes\"\n",
        "[host.live]\nsnapshot = \"everything\"\n",
        "[host.live]\nmax_open = 20\n",
        "[host.live]\nlink = \"ftp://x/{fileId}\"\n",
        "[host.live]\nwhat = 1\n",
    ] {
        assert!(parse(bad).is_err(), "{bad}");
    }
    // The feature needs JWT callbacks and host storage.
    let wopi = "[[host]]\nid = \"w\"\nname = \"W\"\nmode = \"wopi\"\nwopi_allowlist = [\"http://w\"]\n[host.flags]\nlive_blocks = true\n";
    let e = oc_server::hosts::Hosts::parse(wopi, None).unwrap_err();
    assert!(format!("{e:#}").contains("live_blocks"), "{e:#}");
    let eph = "[[host]]\nid = \"e\"\nname = \"E\"\njwt_secret = \"0123456789abcdef0123456789abcdef\"\nstorage = \"ephemeral\"\n[host.flags]\nlive_blocks = true\n";
    assert!(oc_server::hosts::Hosts::parse(eph, None).is_err());
}

#[tokio::test]
async fn derived_sessions_follow_the_hosts_access_answer() {
    let (addr, state, host) = serve().await;
    embed(&addr, &["L_edit", "L_view", "L_none"]).await;
    grant_access(&host, "L_edit", "u_1", "edit");
    grant_access(&host, "L_view", "u_1", "view");
    grant_access(&host, "L_none", "u_other", "edit");
    let ticket = launch(&addr, "u_1", json!({})).await;
    let (_, parent_exp) = stored_grant(&state, &ticket).await;

    let (s, out) = live_session(&addr, &ticket, "L_edit").await;
    assert_eq!(s, 201, "{out}");
    assert_eq!(out["role"], "edit");
    assert_eq!(out["room"], room_id("sample", "L_edit"));
    assert_eq!(out["name"], "Name of L_edit");
    assert_eq!(out["maxOpen"], 8);
    let (g, exp) = stored_grant(&state, out["ticket"].as_str().unwrap()).await;
    assert_eq!(g.file.id, "L_edit");
    assert_eq!(g.user.id, "u_1");
    assert_eq!(exp, parent_exp, "a derived grant expires with its parent");
    assert!(!g.perms.live, "a live file embeds nothing");
    assert_eq!(g.live.parent.as_ref().unwrap().file_id, FILE);
    // The access call was signed (v2).
    assert!(
        host.lock()
            .unwrap()
            .access_calls
            .iter()
            .any(|(f, u, ok)| f == "L_edit" && u == "u_1" && *ok)
    );

    let (s, out) = live_session(&addr, &ticket, "L_view").await;
    assert_eq!((s, out["role"].as_str()), (201, Some("view")));

    // No access: refused, with nothing about the file.
    let (s, out) = live_session(&addr, &ticket, "L_none").await;
    assert_eq!(s, 403, "{out}");
    assert_eq!(out["error"]["code"], "LIVE_NO_ACCESS");
    assert!(!out.to_string().contains("Name of L_none"), "{out}");

    // Only files the canvas embeds: a ticket is no key to every file the person can open.
    grant_access(&host, "L_elsewhere", "u_1", "edit");
    let (s, out) = live_session(&addr, &ticket, "L_elsewhere").await;
    assert_eq!(
        (s, out["error"]["code"].as_str()),
        (404, Some("LIVE_NOT_EMBEDDED"))
    );

    // A derived session cannot derive again (depth 1).
    let (_, edit) = live_session(&addr, &ticket, "L_edit").await;
    let (s, out) = live_session(&addr, edit["ticket"].as_str().unwrap(), "L_view").await;
    assert_eq!(
        (s, out["error"]["code"].as_str()),
        (403, Some("LIVE_DEPTH"))
    );

    // A derived ticket opens its own room only.
    let (s, _) = post(
        &addr,
        "/v1/live/session",
        json!({"ticket": "nope", "fileId": "L_edit"}),
    )
    .await;
    assert_eq!(s, 401);
}

#[tokio::test]
async fn the_session_answer_carries_the_hosts_folder_path_as_text() {
    let (addr, _state, host) = serve().await;
    embed(
        &addr,
        &["L_path", "L_long", "L_edge", "L_plain", "L_hidden"],
    )
    .await;
    for f in ["L_path", "L_long", "L_edge", "L_plain"] {
        grant_access(&host, f, "u_1", "edit");
    }
    grant_access(&host, "L_hidden", "u_other", "edit");
    {
        let mut h = host.lock().unwrap();
        h.access_paths
            .insert("L_path".into(), "  Leadership weekly › Q1  ".into());
        h.access_paths.insert("L_long".into(), "é".repeat(201));
        h.access_paths.insert("L_edge".into(), "é".repeat(200));
        h.access_paths
            .insert("L_hidden".into(), "Board › Secret plans".into());
    }
    let ticket = launch(&addr, "u_1", json!({})).await;
    // Shown as text in the header ("from Leadership weekly › Q1"), trimmed.
    let (s, out) = live_session(&addr, &ticket, "L_path").await;
    assert_eq!(s, 201, "{out}");
    assert_eq!(out["path"], "Leadership weekly › Q1");
    // At most 200 characters (not bytes): longer is dropped, and the editor shows the host name.
    let (_, out) = live_session(&addr, &ticket, "L_long").await;
    assert!(out.get("path").is_none_or(Value::is_null), "{out}");
    let (_, out) = live_session(&addr, &ticket, "L_edge").await;
    assert_eq!(out["path"], "é".repeat(200));
    let (_, out) = live_session(&addr, &ticket, "L_plain").await;
    assert!(out.get("path").is_none_or(Value::is_null), "{out}");
    // A person without access learns nothing of where the file lives.
    let (s, out) = live_session(&addr, &ticket, "L_hidden").await;
    assert_eq!(s, 403, "{out}");
    assert!(!out.to_string().contains("Secret"), "{out}");
}

#[tokio::test]
async fn without_an_access_callback_only_token_listed_files_open_read_only() {
    let (addr, _state, host) = serve().await;
    host.lock().unwrap().access = None; // `/access` answers 404
    embed(&addr, &["L_listed", "L_unlisted"]).await;
    let ticket = launch(
        &addr,
        "u_1",
        json!({"live": [{"fileId": "L_listed", "role": "edit"}, {"bad": 1}]}),
    )
    .await;
    let (s, out) = live_session(&addr, &ticket, "L_listed").await;
    assert_eq!(s, 201, "{out}");
    assert_eq!(out["role"], "view", "read-only without /access");
    let (s, out) = live_session(&addr, &ticket, "L_unlisted").await;
    assert_eq!(
        (s, out["error"]["code"].as_str()),
        (403, Some("LIVE_NO_ACCESS"))
    );
}

#[tokio::test]
async fn the_flag_off_hides_every_live_route() {
    let (addr, _state, _host) = serve_with(|h| h.api_key = Some(API_KEY.into())).await;
    let ticket = launch(&addr, "u_1", json!({})).await;
    let (s, out) = live_session(&addr, &ticket, "L").await;
    assert_eq!((s, out["error"]["code"].as_str()), (404, Some("LIVE_OFF")));
    let (s, out) = post(
        &addr,
        "/v1/live/make",
        json!({"ticket": ticket, "blockIds": ["x"], "name": "N"}),
    )
    .await;
    assert_eq!((s, out["error"]["code"].as_str()), (404, Some("LIVE_OFF")));
}

#[tokio::test]
async fn a_viewer_of_the_live_file_cannot_change_it_and_revocation_reaches_every_embed() {
    let (addr, state, host) = serve().await;
    embed(&addr, &["L"]).await;
    grant_access(&host, "L", "u_1", "view");
    grant_access(&host, "L", "u_2", "edit");
    let t1 = launch(&addr, "u_1", json!({})).await;
    let t2 = launch(&addr, "u_2", json!({})).await;
    let (_, s1) = live_session(&addr, &t1, "L").await;
    let (_, s2) = live_session(&addr, &t2, "L").await;
    let (g1, _) = stored_grant(&state, s1["ticket"].as_str().unwrap()).await;
    let (g2, _) = stored_grant(&state, s2["ticket"].as_str().unwrap()).await;
    // u_1 edits the embedding canvas but only views L: the server's role filter refuses.
    let mut viewer = Peer::join(&state, g1).await;
    let mut editor = Peer::join(&state, g2).await;
    viewer.settle().await;
    editor.settle().await;
    viewer.edit(|d| {
        let c = d.get_or_insert_xml_fragment("content");
        let mut t = d.transact_mut();
        let p = c.push_back(&mut t, XmlElementPrelim::empty("paragraph"));
        p.push_back(&mut t, XmlTextPrelim::new("viewer write"));
    });
    viewer.settle().await;
    editor.settle().await;
    assert!(viewer.denied > 0);
    assert!(!json_of(&editor.doc).to_string().contains("viewer write"));

    // The host revokes u_2 on L through the role API: the live room ends their session, and
    // no new derived grant is minted (the /access cache is dropped too).
    let res = http()
        .post(format!("http://{addr}/api/v1/files/L/role"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", API_KEY)
        .json(&json!({"userId": "u_2", "role": "none"}))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "{}", res.status());
    editor.settle().await;
    assert_eq!(editor.closed, Some(1008));
    let (s, out) = live_session(&addr, &t2, "L").await;
    assert_eq!(
        (s, out["error"]["code"].as_str()),
        (403, Some("LIVE_NO_ACCESS"))
    );
}

#[tokio::test]
async fn make_live_moves_blocks_into_a_file_the_host_creates() {
    let (addr, state, host) = serve().await;
    let (s, out) = batch(
        &addr,
        FILE,
        json!([{"op": "append", "markdown": "Keep here\n\nMove one\n\nMove two"}]),
    )
    .await;
    assert_eq!(s, 200, "{out}");
    let ids: Vec<String> = out["blockIds"]
        .as_array()
        .or(out["inserted"].as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let doc = server_json(&state).await;
    let blocks = doc["content"].as_array().unwrap();
    let id_of = |text: &str| {
        blocks
            .iter()
            .find(|b| b.to_string().contains(text))
            .map(|b| b["attrs"]["blockId"].as_str().unwrap().to_string())
            .unwrap()
    };
    let _ = ids;
    let (one, two) = (id_of("Move one"), id_of("Move two"));

    // Without perms.live: refused.
    let plain = launch(&addr, "u_1", json!({"perms": {}})).await;
    let (s, out) = post(
        &addr,
        "/v1/live/make",
        json!({"ticket": plain, "blockIds": [one], "name": "Q1"}),
    )
    .await;
    assert_eq!(
        (s, out["error"]["code"].as_str()),
        (403, Some("ROLE_FORBIDDEN"))
    );

    let ticket = launch(&addr, "u_1", json!({})).await;
    let res = http()
        .post(format!("http://{addr}/v1/live/make"))
        .header("Idempotency-Key", "mk-1")
        .json(&json!({"ticket": ticket, "blockIds": [one, two], "name": "Q1 OKRs"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 201);
    let out: Value = res.json().await.unwrap();
    let live_file = out["liveFileId"].as_str().unwrap().to_string();
    assert_eq!(out["kind"], "blocks");
    {
        let st = host.lock().unwrap();
        let c = st.creates.last().unwrap();
        assert!(c.signature_ok, "POST /files is signed (v2)");
        assert_eq!(c.headers["authorization"], "Bearer cb-u_1");
        assert_eq!(c.headers["idempotency-key"], "mk-1");
        let body: Value = serde_json::from_slice(&c.body).unwrap();
        assert_eq!(
            body,
            json!({"name": "Q1 OKRs", "parentFileId": FILE, "kind": "ocanvas"})
        );
        // Saved through the normal commit path, as a live file.
        let (bytes, _) = st.files.get(&live_file).expect("the live file was saved");
        let saved = oc_model::doc_to_json(&oc_model::read_ocanvas(bytes).unwrap().doc);
        assert_eq!(saved["meta"]["kind"], "live");
        assert!(saved.to_string().contains("Move one") && saved.to_string().contains("Move two"));
        assert!(!saved.to_string().contains("Keep here"));
    }
    // The canvas now has one liveBlock where the blocks were.
    let doc = server_json(&state).await;
    let s = doc.to_string();
    assert!(
        s.contains("Keep here") && !s.contains("Move one") && !s.contains("Move two"),
        "{s}"
    );
    let refs = oc_model::live::references(&doc);
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].file_id, live_file);
    assert_eq!(refs[0].title, "Q1 OKRs");
    assert_eq!(refs[0].block_id, out["blockId"].as_str().unwrap());

    // A host without POST /files: 501 and nothing changes.
    host.lock().unwrap().create_off = true;
    let keep = id_of("Keep here");
    let (s, out) = post(
        &addr,
        "/v1/live/make",
        json!({"ticket": ticket, "blockIds": [keep], "name": "N"}),
    )
    .await;
    assert_eq!(
        (s, out["error"]["code"].as_str()),
        (501, Some("LIVE_CREATE_UNSUPPORTED"))
    );
    assert!(server_json(&state).await.to_string().contains("Keep here"));
}

/// What y-prosemirror does in an editor whose schema lacks the node: delete it.
fn remove_first(tag: &'static str) -> impl FnOnce(&yrs::Doc) {
    move |d: &yrs::Doc| {
        let c = d.get_or_insert_xml_fragment("content");
        let mut t = d.transact_mut();
        let at = (0..c.len(&t))
            .find(|i| matches!(c.get(&t, *i), Some(yrs::XmlOut::Element(e)) if e.tag().as_ref() == tag))
            .unwrap();
        c.remove_range(&mut t, at, 1);
    }
}

fn add_live(file: &'static str) -> impl FnOnce(&yrs::Doc) {
    move |d: &yrs::Doc| {
        let c = d.get_or_insert_xml_fragment("content");
        let mut t = d.transact_mut();
        let el = c.push_back(&mut t, XmlElementPrelim::empty("liveBlock"));
        el.insert_attribute(&mut t, "blockId", "b_client");
        el.insert_attribute(&mut t, "fileId", file);
        el.insert_attribute(&mut t, "kind", "blocks");
    }
}

fn with(role: Role, f: impl FnOnce(&mut Grant)) -> Grant {
    let mut g = grant("u_1", role);
    f(&mut g);
    g
}

#[tokio::test]
async fn a_0_2_editor_in_a_canvas_with_live_blocks_loses_nothing() {
    let (addr, state, _host) = serve().await;
    // A 0.2 editor keeps SDK blocks (`caps=ext`) but has no liveBlock in its schema.
    let mut old = Peer::join(&state, with(Role::Edit, |g| g.ext_blocks = true)).await;
    let mut new = Peer::join(
        &state,
        with(Role::Edit, |g| {
            g.ext_blocks = true;
            g.live.caps = true;
            g.user.id = "u_new".into();
        }),
    )
    .await;
    old.settle().await;
    new.settle().await;
    embed(&addr, &["L1", "L2"]).await;
    old.settle().await;
    new.settle().await;
    let before = server_json(&state).await;
    assert_eq!(oc_model::live::references(&before).len(), 2);

    old.edit(remove_first("liveBlock"));
    old.settle().await;
    assert_eq!(old.closed, Some(4426), "the 0.2 editor's session ends");
    new.settle().await;
    let after = server_json(&state).await;
    assert_eq!(after["content"], before["content"], "the room lost nothing");
    assert_eq!(oc_model::live::references(&json_of(&new.doc)).len(), 2);

    // An editor that keeps live blocks may delete one (moving or deleting the reference
    // needs edit on the canvas only; the live file stays).
    new.edit(remove_first("liveBlock"));
    new.settle().await;
    assert_eq!(new.closed, None);
    assert_eq!(
        oc_model::live::references(&server_json(&state).await).len(),
        1
    );
}

#[tokio::test]
async fn adding_a_live_block_needs_the_flag_and_perms_live() {
    let (addr, state, _host) = serve().await;
    let caps = |live: bool| {
        with(Role::Edit, move |g| {
            g.live.caps = true;
            g.perms.live = live;
        })
    };
    let mut no_perm = Peer::join(&state, caps(false)).await;
    no_perm.settle().await;
    no_perm.edit(add_live("L"));
    no_perm.settle().await;
    assert!(no_perm.denied > 0);
    assert!(oc_model::live::references(&server_json(&state).await).is_empty());
    let mut ok = Peer::join(&state, caps(true)).await;
    ok.settle().await;
    ok.edit(add_live("L"));
    ok.settle().await;
    assert_eq!(ok.denied, 0);
    assert_eq!(
        oc_model::live::references(&server_json(&state).await).len(),
        1
    );
    let _ = addr;

    // Flag off: neither a client nor the API may add one.
    let (addr, state, _host) = serve_with(|h| h.api_key = Some(API_KEY.into())).await;
    let mut p = Peer::join(&state, caps(true)).await;
    p.settle().await;
    p.edit(add_live("L"));
    p.settle().await;
    assert!(p.denied > 0);
    let (s, out) = batch(
        &addr,
        FILE,
        json!([{"op": "append", "blocks": [live_node("b1", "L")]}]),
    )
    .await;
    assert_eq!(s, 400, "{out}");
    assert!(out.to_string().contains("live_blocks"), "{out}");
}

#[tokio::test]
async fn a_live_file_cannot_contain_live_blocks() {
    let (addr, state, host) = serve().await;
    // Make L a live file through "Make live".
    let (s, _) = batch(&addr, FILE, json!([{"op": "append", "markdown": "Inside"}])).await;
    assert_eq!(s, 200);
    let doc = server_json(&state).await;
    let id = doc["content"][0]["attrs"]["blockId"]
        .as_str()
        .unwrap()
        .to_string();
    let ticket = launch(&addr, "u_1", json!({})).await;
    let (s, out) = post(
        &addr,
        "/v1/live/make",
        json!({"ticket": ticket, "blockIds": [id], "name": "L"}),
    )
    .await;
    assert_eq!(s, 201, "{out}");
    let live_file = out["liveFileId"].as_str().unwrap().to_string();
    let _ = host;
    // The API refuses a reference inside it.
    let (s, out) = batch(
        &addr,
        &live_file,
        json!([{"op": "append", "blocks": [live_node("b_in", "Other")]}]),
    )
    .await;
    assert_eq!(s, 400, "{out}");
    assert!(out.to_string().contains("live file"), "{out}");
    // So does the room, for a client.
    let mut g = with(Role::Edit, |g| {
        g.live.caps = true;
        g.perms.live = true;
    });
    g.room = room_id("sample", &live_file);
    g.file.id = live_file.clone();
    let mut p = Peer::join(&state, g).await;
    p.settle().await;
    p.edit(add_live("Other"));
    p.settle().await;
    assert!(p.denied > 0);
}

#[tokio::test]
async fn at_most_fifty_references_per_canvas() {
    let (addr, _state, _host) = serve().await;
    let files: Vec<String> = (0..50).map(|i| format!("L{i}")).collect();
    let refs: Vec<&str> = files.iter().map(String::as_str).collect();
    embed(&addr, &refs).await;
    let (s, out) = batch(
        &addr,
        FILE,
        json!([{"op": "append", "blocks": [live_node("b_51", "L51")]}]),
    )
    .await;
    assert_eq!(s, 400, "{out}");
    assert!(out.to_string().contains("at most 50"), "{out}");
}

#[tokio::test]
async fn snapshot_policy_title_keeps_no_content_in_the_canvas() {
    let (addr, state, _host) = serve().await;
    embed(&addr, &["L"]).await;
    let mut p = Peer::join(
        &state,
        with(Role::Edit, |g| {
            g.live.caps = true;
            g.perms.live = true;
        }),
    )
    .await;
    p.settle().await;
    // A client writes a content snapshot into the node: refused under "title".
    p.edit(|d| {
        let c = d.get_or_insert_xml_fragment("content");
        let mut t = d.transact_mut();
        let Some(yrs::XmlOut::Element(el)) = c.get(&t, 0) else {
            panic!("no node")
        };
        el.insert_attribute(&mut t, "snapshot", "SECRET-LIVE-CONTENT");
    });
    p.settle().await;
    assert!(p.denied > 0);
    let ticket = launch(&addr, "u_1", json!({})).await;
    let bytes = http()
        .get(format!("http://{addr}/v1/export/ocanvas?ticket={ticket}"))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert!(!bytes.is_empty());
    // Byte search over every entry of the zip.
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).unwrap();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).unwrap();
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut f, &mut buf).unwrap();
        assert!(
            !buf.windows(19).any(|w| w == b"SECRET-LIVE-CONTENT"),
            "entry {i} leaks the snapshot",
        );
    }
}

async fn ws(addr: &str, room: &str, ticket: &str) -> Result<(), u16> {
    let url = format!("ws://{addr}/v1/collab/{room}?ticket={ticket}&caps=ext,live");
    match tokio_tungstenite::connect_async(url).await {
        Ok((mut s, _)) => {
            // Keep it open by leaking it into a task that reads until the test ends.
            tokio::spawn(async move {
                use futures::StreamExt;
                while s.next().await.is_some() {}
            });
            Ok(())
        }
        Err(tokio_tungstenite::tungstenite::Error::Http(r)) => Err(r.status().as_u16()),
        Err(e) => panic!("{e}"),
    }
}

#[tokio::test]
async fn live_block_rooms_per_session_are_capped() {
    let (addr, _state, host) = serve_with(|h| {
        live_on(h);
        h.live.insert("max_open".into(), toml::Value::Integer(2));
    })
    .await;
    embed(&addr, &["L1", "L2", "L3"]).await;
    for f in ["L1", "L2", "L3"] {
        grant_access(&host, f, "u_1", "edit");
    }
    let ticket = launch(&addr, "u_1", json!({})).await;
    let mut sessions = vec![];
    for f in ["L1", "L2", "L3"] {
        let (s, out) = live_session(&addr, &ticket, f).await;
        assert_eq!(s, 201, "{out}");
        assert_eq!(out["maxOpen"], 2);
        sessions.push(out);
    }
    for s in &sessions[..2] {
        ws(
            &addr,
            s["room"].as_str().unwrap(),
            s["ticket"].as_str().unwrap(),
        )
        .await
        .unwrap();
    }
    let third = &sessions[2];
    assert_eq!(
        ws(
            &addr,
            third["room"].as_str().unwrap(),
            third["ticket"].as_str().unwrap()
        )
        .await,
        Err(429)
    );
    // Another person's session has its own count.
    grant_access(&host, "L1", "u_2", "edit");
    let other = launch(&addr, "u_2", json!({})).await;
    let (_, o) = live_session(&addr, &other, "L1").await;
    ws(
        &addr,
        o["room"].as_str().unwrap(),
        o["ticket"].as_str().unwrap(),
    )
    .await
    .unwrap();
}

mod cluster {
    //! LIVE-02 in a cluster (ADR-006): a live file's room is an ordinary room, so a derived
    //! session minted on one node opens it through the remote room relay when another node
    //! owns it, and the owner enforces the derived role.
    use super::*;
    use oc_server::cluster::bus::{Bus, FakeBus};
    use oc_server::cluster::lease::{FakeLeases, key};
    use oc_server::cluster::{Cluster, ClusterConfig};
    use std::sync::Arc;

    const CLUSTER_SECRET: &str = "test-cluster-secret-0123456789abcdef";

    async fn node(
        base: &str,
        db: &std::path::Path,
        fake: &Arc<FakeLeases>,
        id: &str,
        bus: Arc<dyn Bus>,
    ) -> (oc_server::SharedState, String) {
        let state = app_custom(base, room_cfg(), db, live_on).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let cfg = ClusterConfig::build(
            Some("redis://unused".into()),
            "mysql://unused",
            Some(id.into()),
            Some(format!("http://{addr}")),
            Some(CLUSTER_SECRET.into()),
            "unused",
        )
        .unwrap()
        .unwrap();
        state.join_cluster(Cluster::with_backends(cfg, fake.clone(), bus));
        let app = oc_server::app(state.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (state, addr.to_string())
    }

    fn para(text: &'static str) -> impl FnOnce(&yrs::Doc) {
        move |d: &yrs::Doc| {
            let c = d.get_or_insert_xml_fragment("content");
            let mut t = d.transact_mut();
            let p = c.push_back(&mut t, XmlElementPrelim::empty("paragraph"));
            p.push_back(&mut t, XmlTextPrelim::new(text));
        }
    }

    #[tokio::test]
    async fn live_rooms_relay_across_nodes_and_the_owner_enforces_the_derived_role() {
        let (base, host) = mock_host().await;
        let db = temp_db();
        let fake = Arc::new(FakeLeases::default());
        let bus: Arc<dyn Bus> = Arc::new(FakeBus::default());
        let (n1, a1) = node(&base, &db, &fake, "n1", bus.clone()).await;
        let (n2, a2) = node(&base, &db, &fake, "n2", bus).await;
        grant_access(&host, "L", "u_1", "edit");
        grant_access(&host, "L", "u_2", "view");
        // The canvas lives on n1; its live file L is opened first on n2.
        embed(&a1, &["L"]).await;
        let t1 = launch(&a1, "u_1", json!({})).await;
        let t2 = launch(&a1, "u_2", json!({})).await;
        // Sessions minted on either node are in the shared store.
        let (s, s1) = live_session(&a2, &t1, "L").await;
        assert_eq!(s, 201, "{s1}");
        let (s, s2) = live_session(&a1, &t2, "L").await;
        assert_eq!(s, 201, "{s2}");
        let (g1, _) = stored_grant(&n2, s1["ticket"].as_str().unwrap()).await;
        let (g2, _) = stored_grant(&n1, s2["ticket"].as_str().unwrap()).await;
        let room = g1.room.clone();
        let mut owner_side = Peer::join(&n2, g1).await;
        assert!(fake.value(&key(&room)).unwrap().starts_with("n2@"));
        let mut relayed = Peer::join(&n1, g2).await;
        assert!(!n1.rooms.is_live(&room), "n1 relays, it does not open L");
        owner_side.settle().await;
        relayed.settle().await;
        owner_side.edit(para("typed on n2"));
        relayed.edit(para("viewer on n1"));
        owner_side.settle().await;
        relayed.settle().await;
        assert!(json_of(&relayed.doc).to_string().contains("typed on n2"));
        assert!(
            relayed.denied > 0,
            "the owner applies the derived view role"
        );
        assert!(
            !json_of(&owner_side.doc)
                .to_string()
                .contains("viewer on n1")
        );
    }
}

// ---------- LIVE-04, LIVE-05, LIVE-06: projections, snapshots, exports, render ----------

/// Puts a live file `id` with one paragraph `text` (blockId `p_<id>`) on the mock host.
fn host_live_file(host: &Shared, id: &str, text: &str) {
    let doc = oc_model::new_doc();
    oc_model::import::apply_document_json(
        &doc,
        &json!({"type": "doc", "meta": {"kind": "live", "title": format!("Live {id}")}, "content": [
            {"type": "paragraph", "attrs": {"blockId": format!("p_{id}")}, "content": [{"type": "text", "text": text}]}
        ]}),
    );
    let bytes = oc_model::write_ocanvas(&doc, &oc_model::CommitInfo::default()).unwrap();
    host.lock().unwrap().files.insert(id.into(), (bytes, 1));
}

async fn get(addr: &str, path: &str) -> reqwest::Response {
    http()
        .get(format!("http://{addr}{path}"))
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn projections_answer_for_the_reader_and_refresh_with_etags() {
    let (addr, _state, host) = serve().await;
    host_live_file(&host, "L", "Shared status");
    grant_access(&host, "L", "u_1", "view");
    let (s, out) = batch(
        &addr,
        FILE,
        json!([{"op": "append", "blocks": [live_node("b_live", "L"),
            {"type": "blockRef", "attrs": {"blockId": "b_ref", "fileId": "L", "refBlockId": "p_L", "title": ""}}]}]),
    )
    .await;
    assert_eq!(s, 200, "{out}");
    let ticket = launch(&addr, "u_1", json!({})).await;
    let res = get(
        &addr,
        &format!("/v1/live/projection?ticket={ticket}&fileId=L"),
    )
    .await;
    assert_eq!(res.status().as_u16(), 200);
    let etag = res.headers()["etag"].to_str().unwrap().to_string();
    let v: Value = res.json().await.unwrap();
    assert_eq!(v["access"], "view");
    assert!(v["markdown"].as_str().unwrap().contains("Shared status"));
    assert_eq!(v["live"], true);
    // Unchanged: 304.
    let res = http()
        .get(format!(
            "http://{addr}/v1/live/projection?ticket={ticket}&fileId=L"
        ))
        .header("If-None-Match", &etag)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 304);
    // A blockRef: one block.
    let v: Value = get(
        &addr,
        &format!("/v1/live/projection?ticket={ticket}&fileId=L&blockId=p_L"),
    )
    .await
    .json()
    .await
    .unwrap();
    assert_eq!(v["doc"]["content"].as_array().unwrap().len(), 1);
    assert_eq!(v["doc"]["content"][0]["attrs"]["blockId"], "p_L");
    // A block the canvas does not reference: refused.
    let res = get(
        &addr,
        &format!("/v1/live/projection?ticket={ticket}&fileId=L&blockId=other"),
    )
    .await;
    assert_eq!(res.status().as_u16(), 404);
    // Someone without access sees nothing.
    let t2 = launch(&addr, "u_2", json!({})).await;
    let res = get(&addr, &format!("/v1/live/projection?ticket={t2}&fileId=L")).await;
    assert_eq!(res.status().as_u16(), 403);
    let body = res.text().await.unwrap();
    assert!(
        !body.contains("Shared status") && !body.contains("Live L"),
        "{body}"
    );
}

#[tokio::test]
async fn refresh_keeps_what_the_snapshot_policy_allows() {
    for (policy, title, content) in [
        ("none", false, false),
        ("title", true, false),
        ("content", true, true),
    ] {
        let (addr, state, host) = serve_with(|h| {
            live_on(h);
            h.live
                .insert("snapshot".into(), toml::Value::String(policy.into()));
        })
        .await;
        host_live_file(&host, "L", "Q1 numbers");
        grant_access(&host, "L", "u_1", "edit");
        let node = json!({"type": "liveBlock", "attrs": {"blockId": "b_live", "fileId": "L", "kind": "blocks", "title": ""}});
        let (s, out) = batch(&addr, FILE, json!([{"op": "append", "blocks": [node]}])).await;
        assert_eq!(s, 200, "{policy}: {out}");
        let ticket = launch(&addr, "u_1", json!({})).await;
        let (s, out) = post(
            &addr,
            "/v1/live/refresh",
            json!({"ticket": ticket, "blockId": "b_live"}),
        )
        .await;
        assert_eq!(s, 200, "{policy}: {out}");
        let doc = server_json(&state).await;
        let attrs = &oc_model::live::references(&doc);
        assert_eq!(attrs.len(), 1);
        assert_eq!(!attrs[0].title.is_empty(), title, "{policy}: {doc}");
        assert_eq!(attrs[0].has_snapshot, content, "{policy}: {doc}");
        assert_eq!(doc.to_string().contains("Q1 numbers"), content, "{policy}");
        // A reader without access to L refreshes nothing.
        let t2 = launch(&addr, "u_2", json!({})).await;
        let (s, out) = post(
            &addr,
            "/v1/live/refresh",
            json!({"ticket": t2, "blockId": "b_live"}),
        )
        .await;
        assert_eq!((s, out["access"].as_str()), (200, Some("none")), "{policy}");
    }
}

#[tokio::test]
async fn exports_inline_only_what_the_exporting_person_can_read() {
    let (addr, _state, host) = serve_with(|h| {
        live_on(h);
        h.live.insert(
            "link".into(),
            toml::Value::String("https://host.example/files/{fileId}".into()),
        );
    })
    .await;
    host_live_file(&host, "L", "Only for readers");
    grant_access(&host, "L", "u_1", "view");
    embed(&addr, &["L"]).await;
    let reader = launch(&addr, "u_1", json!({})).await;
    let md = get(&addr, &format!("/v1/export/md?ticket={reader}"))
        .await
        .text()
        .await
        .unwrap();
    assert!(md.contains("Only for readers"), "{md}");
    assert!(md.contains("Live block: Title L"), "{md}");
    assert!(md.contains("https://host.example/files/L"), "{md}");
    let html = get(&addr, &format!("/v1/export/html?ticket={reader}"))
        .await
        .text()
        .await
        .unwrap();
    assert!(html.contains("Only for readers"));

    let other = launch(&addr, "u_2", json!({})).await;
    for fmt in ["md", "html", "docx", "ocanvas", "json"] {
        let bytes = get(&addr, &format!("/v1/export/{fmt}?ticket={other}"))
            .await
            .bytes()
            .await
            .unwrap();
        assert!(!bytes.is_empty(), "{fmt}");
        let found = if fmt == "docx" || fmt == "ocanvas" {
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).unwrap();
            (0..zip.len()).any(|i| {
                let mut buf = Vec::new();
                std::io::Read::read_to_end(&mut zip.by_index(i).unwrap(), &mut buf).unwrap();
                buf.windows(16).any(|w| w == b"Only for readers")
            })
        } else {
            bytes.windows(16).any(|w| w == b"Only for readers")
        };
        assert!(
            !found,
            "{fmt} leaks the live file to someone without access"
        );
    }
    let md = get(&addr, &format!("/v1/export/md?ticket={other}"))
        .await
        .text()
        .await
        .unwrap();
    assert!(md.contains("Live block: Title L (no access)"), "{md}");
}

#[tokio::test]
async fn api_make_live_references_and_render() {
    let (addr, state, host) = serve().await;
    let (s, _) = batch(
        &addr,
        FILE,
        json!([{"op": "append", "markdown": "Plan A\n\nStay"}]),
    )
    .await;
    assert_eq!(s, 200);
    let doc = server_json(&state).await;
    let id = doc["content"][0]["attrs"]["blockId"]
        .as_str()
        .unwrap()
        .to_string();
    let res = api(&addr, reqwest::Method::POST, FILE, "/live")
        .json(&json!({"blockIds": [id], "name": "Plan"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 201);
    let made: Value = res.json().await.unwrap();
    let live_file = made["liveFileId"].as_str().unwrap().to_string();
    assert_eq!(host.lock().unwrap().creates.len(), 1);
    // The references, with the caller's access (the mock host gave u_1 edit on the new file).
    let refs: Value = api(&addr, reqwest::Method::GET, FILE, "/references")
        .header("X-OpenCanvas-Author", "u_1")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let items = refs["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{refs}");
    assert_eq!(items[0]["fileId"], live_file);
    assert_eq!(items[0]["type"], "liveBlock");
    assert_eq!(items[0]["blockId"], made["blockId"]);
    // The compact view of the live file: sanitised HTML from the export renderer.
    let res = api(
        &addr,
        reqwest::Method::GET,
        &live_file,
        "/render?format=html",
    )
    .send()
    .await
    .unwrap();
    assert_eq!(res.status().as_u16(), 200);
    assert!(
        res.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("sandbox")
    );
    assert!(res.headers().contains_key("etag"));
    let html = res.text().await.unwrap();
    assert!(html.contains("Plan A"), "{html}");
    let res = api(
        &addr,
        reqwest::Method::GET,
        &live_file,
        "/render?format=pdf",
    )
    .send()
    .await
    .unwrap();
    assert_eq!(res.status().as_u16(), 404);
    // The canvas itself renders with the live block resolved for the caller.
    let html = api(&addr, reqwest::Method::GET, FILE, "/render")
        .header("X-OpenCanvas-Author", "u_1")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(
        html.contains("Live block: Plan") && html.contains("Plan A"),
        "{html}"
    );
}

// ---------- ADR-069: usage events and presence origin ----------

#[tokio::test]
async fn usage_events_report_each_insert_and_removal_once() {
    let (addr, state, _host) = serve().await;
    let room = room_id("sample", FILE);
    let mut sub = state
        .rooms
        .ctx()
        .events
        .subscribe(&room, FILE, "sample", None)
        .unwrap();
    embed(&addr, &["L1"]).await;
    // A client removes it (an editor that keeps live blocks).
    let mut p = Peer::join(&state, with(Role::Edit, |g| g.live.caps = true)).await;
    p.settle().await;
    p.edit(remove_first("liveBlock"));
    p.settle().await;
    let mut seen = vec![];
    while let Ok(Some(ev)) =
        tokio::time::timeout(std::time::Duration::from_millis(300), sub.rx.recv()).await
    {
        if ev.kind.starts_with("live.") {
            seen.push((ev.kind.clone(), ev.data.clone()));
        }
    }
    assert_eq!(seen.len(), 2, "{seen:?}");
    assert_eq!(seen[0].0, "live.embedded");
    assert_eq!(seen[0].1["liveFileId"], "L1");
    assert_eq!(seen[0].1["blockId"], "b_live0");
    assert_eq!(seen[0].1["type"], "liveBlock");
    assert_eq!(seen[1].0, "live.removed");
    assert_eq!(seen[1].1["by"], "u_1");
}

#[tokio::test]
async fn presence_says_where_a_person_is_only_to_people_from_the_same_canvas() {
    let (addr, state, host) = serve().await;
    embed(&addr, &["L"]).await;
    grant_access(&host, "L", "u_1", "edit");
    let t1 = launch(&addr, "u_1", json!({})).await;
    let (_, s1) = live_session(&addr, &t1, "L").await;
    let (from_a, _) = stored_grant(&state, s1["ticket"].as_str().unwrap()).await;
    // A teammate from the same canvas, and someone who opened L on its own.
    let mut same = from_a.clone();
    same.user.id = "u_same".into();
    let mut direct = from_a.clone();
    direct.user.id = "u_direct".into();
    direct.live = Default::default();
    let mut a = Peer::join(&state, from_a).await;
    let mut b = Peer::join(&state, same).await;
    let mut c = Peer::join(&state, direct).await;
    for p in [&mut a, &mut b, &mut c] {
        p.settle().await;
    }
    // u_1 sends a state that claims another origin: the server writes its own.
    let mut aw = yrs::sync::Awareness::new(yrs::Doc::new());
    aw.set_local_state(json!({"cursor": 1, "from": {"fileId": "spoof", "title": "Spoof"}}))
        .unwrap();
    a.send(oc_server::room::protocol::awareness(aw.update().unwrap()));
    for p in [&mut a, &mut b, &mut c] {
        p.settle().await;
    }
    let states = |p: &Peer| -> Vec<Value> {
        p.awareness
            .iter()
            .flat_map(|u| u.clients.values())
            .filter_map(|e| serde_json::from_str::<Value>(&e.json).ok())
            .filter(|v| v["cursor"] == 1)
            .collect()
    };
    let seen_b = states(&b);
    assert!(!seen_b.is_empty());
    assert!(
        seen_b
            .iter()
            .all(|v| v["from"] == json!({"fileId": FILE, "title": "Doc one"})),
        "{seen_b:?}"
    );
    let seen_c = states(&c);
    assert!(!seen_c.is_empty());
    assert!(seen_c.iter().all(|v| v.get("from").is_none()), "{seen_c:?}");
    assert!(!format!("{seen_b:?}{seen_c:?}").contains("Spoof"));
}

/// LIVE-03: the session answer says whether live blocks show and whether "Make live" and the
/// host picker may be offered.
#[tokio::test]
async fn the_session_answer_says_what_the_editor_may_offer() {
    let (addr, _state, _host) = serve().await;
    let info = async |addr: &str, t: String| -> Value {
        get(addr, &format!("/v1/sessions/{t}"))
            .await
            .json()
            .await
            .unwrap()
    };
    let s = info(&addr, launch(&addr, "u_1", json!({})).await).await;
    assert_eq!(s["live"]["enabled"], true, "{s}");
    assert_eq!(s["live"]["make"], true);
    assert_eq!(s["live"]["insert"], true);
    assert_eq!(s["live"]["snapshot"], "title");
    assert_eq!(s["live"]["maxOpen"], 8);
    let s = info(&addr, launch(&addr, "u_1", json!({"perms": {}})).await).await;
    assert_eq!(
        (s["live"]["enabled"].as_bool(), s["live"]["make"].as_bool()),
        (Some(true), Some(false))
    );
    let s = info(&addr, launch(&addr, "u_1", json!({"role": "view"})).await).await;
    assert_eq!(s["live"]["make"], false);
    let (addr2, _, _) = serve_with(|_| {}).await;
    let s = info(&addr2, launch(&addr2, "u_1", json!({})).await).await;
    assert_eq!(
        (s["live"]["enabled"].as_bool(), s["live"]["make"].as_bool()),
        (Some(false), Some(false))
    );
}

/// LIVE-06: `view=block` reaches the app fragment; anything else is dropped.
#[tokio::test]
async fn a_launch_carries_the_compact_view() {
    let (addr, _state, _host) = serve().await;
    let loc = async |view: &str| -> String {
        let res = http()
            .post(format!("http://{addr}/v1/launch"))
            .form(&[
                ("token", token("u_1", json!({}))),
                ("view", view.to_string()),
            ])
            .send()
            .await
            .unwrap();
        res.headers()["location"].to_str().unwrap().to_string()
    };
    assert!(loc("block").await.ends_with("&view=block"));
    assert!(!loc("page<script>").await.contains("view="));
    assert!(!loc("full").await.contains("view="));
}

/// LIVE-07, prototype 2d: "Who can see this" counts the canvas's other members the host would
/// not let open the live file, and returns no names.
#[tokio::test]
async fn who_can_see_this_counts_members_without_access() {
    let (addr, _state, host) = serve().await;
    embed(&addr, &["L_a"]).await;
    grant_access(&host, "L_a", "u_1", "edit");
    grant_access(&host, "L_a", "u_2", "view");
    let members = json!([
        {"id": "u_1", "name": "One"}, {"id": "u_2", "name": "Two"},
        {"id": "u_3", "name": "Three"}, {"id": "u_4", "name": "Four"}
    ]);
    let ticket = launch(&addr, "u_1", json!({"members": members})).await;
    let r = get(
        &addr,
        &format!("/v1/live/audience?ticket={ticket}&fileId=L_a"),
    )
    .await;
    assert_eq!(r.status(), 200);
    let out: Value = r.json().await.unwrap();
    assert_eq!(out["role"], "edit", "{out}");
    assert_eq!(out["cannotOpen"], 2, "u_3 and u_4 cannot open it: {out}");
    assert_eq!(out["members"], 3);
    assert!(!out.to_string().contains("Three"), "{out}");
    // A member who cannot open the live file learns nothing about who else can (SEC-63).
    let outsider = launch(&addr, "u_3", json!({"members": members})).await;
    let out: Value = get(
        &addr,
        &format!("/v1/live/audience?ticket={outsider}&fileId=L_a"),
    )
    .await
    .json()
    .await
    .unwrap();
    assert_eq!(out["role"], "none", "{out}");
    assert_eq!(out["cannotOpen"], Value::Null, "{out}");
    assert_eq!(out["members"], Value::Null, "{out}");
    // Not embedded: refused like every live route.
    let r = get(
        &addr,
        &format!("/v1/live/audience?ticket={ticket}&fileId=L_other"),
    )
    .await;
    assert_eq!(r.status(), 404);
    // Without a member list there is no count.
    let ticket = launch(&addr, "u_1", json!({})).await;
    let out: Value = get(
        &addr,
        &format!("/v1/live/audience?ticket={ticket}&fileId=L_a"),
    )
    .await
    .json()
    .await
    .unwrap();
    assert_eq!(out["cannotOpen"], Value::Null, "{out}");
}

/// LIVE-03, prototype 5e: a host that answers 410 for the live file (deleted or moved) gives
/// `404 LIVE_GONE`, distinct from no access, and nothing else about the file.
#[tokio::test]
async fn a_deleted_live_file_is_reported_as_gone() {
    let (addr, _state, host) = serve().await;
    embed(&addr, &["L_gone", "L_none"]).await;
    grant_access(&host, "L_gone", "u_1", "gone");
    grant_access(&host, "L_none", "u_2", "edit");
    let ticket = launch(&addr, "u_1", json!({})).await;
    let (s, out) = live_session(&addr, &ticket, "L_gone").await;
    assert_eq!(
        (s, out["error"]["code"].as_str()),
        (404, Some("LIVE_GONE")),
        "{out}"
    );
    let (s, out) = live_session(&addr, &ticket, "L_none").await;
    assert_eq!(
        (s, out["error"]["code"].as_str()),
        (403, Some("LIVE_NO_ACCESS")),
        "{out}"
    );
    let r = get(
        &addr,
        &format!("/v1/live/projection?ticket={ticket}&fileId=L_gone"),
    )
    .await;
    assert_eq!(r.status(), 404);
}
