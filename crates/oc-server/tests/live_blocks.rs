// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Portable live blocks on the server (LIVE-01, LIVE-02; docs/27 §2, ADR-039): the host
//! contract (`[host.flags] live_blocks`, `[host.live]`, `POST /files`, `/access`, the token's
//! `perms.live` and `live` claim), derived grants, "Make live", the room rules (old editors,
//! the depth rule, the reference limit, the snapshot policy) and the open live block limit.
mod common;

use common::*;
use jsonwebtoken::{EncodingKey, Header, encode};
use oc_server::grant::{Grant, room_id};
use serde_json::{Value, json};
use yrs::{Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};

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
