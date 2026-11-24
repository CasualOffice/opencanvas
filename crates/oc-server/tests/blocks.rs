// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! SDK block packages on the server (BSDK-01, BSDK-02; docs/27 §3, docs/05 §2): installing
//! from `OC_BLOCKS_DIR` with the integrity check, `[host.blocks]`, the session list,
//! `/healthz`, schema-checked writes through the API (the same tool layer as MCP), and the
//! guard against editors older than 0.2 deleting `extBlock`s.
mod common;

use std::path::{Path, PathBuf};

use common::*;
use jsonwebtoken::{EncodingKey, Header, encode};
use oc_server::grant::Role;
use serde_json::{Value, json};
use yrs::{Transact, XmlFragment};

const API_KEY: &str = "test-api-key";

fn package(root: &Path, dir: &str, ty: &str, bundle: &[u8], integrity: Option<String>) {
    let d = root.join(dir);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("block.js"), bundle).unwrap();
    let m = json!({
        "type": ty, "version": "1.2.0", "title": "OKR", "icon": "target",
        "attrs": {"type": "object", "additionalProperties": false,
                  "properties": {"objective": {"type": "string", "maxLength": 40},
                                 "progress": {"type": "number", "minimum": 0, "maximum": 1}},
                  "required": ["objective"]},
        "data": {"kind": "map", "schema": {"type": "object", "additionalProperties": false,
                  "properties": {"score": {"type": "integer"}}}},
        "export": {"markdown": "**{{objective}}** ({{progress|percent}})", "text": "{{objective}}"},
        "entry": "block.js",
        "integrity": integrity.unwrap_or_else(|| oc_server::blocks::sri_sha384(bundle)),
    });
    std::fs::write(d.join("block.json"), serde_json::to_vec(&m).unwrap()).unwrap();
}

fn blocks_dir(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("oc-blocks-it-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    package(&root, "okr", "srv.okr", b"export default {}", None);
    package(
        &root,
        "tampered",
        "srv.bad",
        b"changed after signing",
        Some(oc_server::blocks::sri_sha384(b"signed")),
    );
    root
}

fn enable(h: &mut oc_server::hosts::HostConfig) {
    h.api_key = Some(API_KEY.into());
    h.flags.insert("api_v1".into(), toml::Value::Boolean(true));
    h.blocks = toml::from_str("enabled = [\"srv.okr@^1\", \"srv.bad\"]").unwrap();
}

async fn serve(name: &str) -> (String, oc_server::SharedState) {
    let (base, _host) = mock_host().await;
    let dir = blocks_dir(name);
    let state = app_full(&base, room_cfg(), &temp_db(), enable, |c| {
        c.blocks = oc_server::blocks::BlocksConfig {
            dir: Some(dir),
            origin: Some("https://blocks.example".into()),
        };
    })
    .await;
    (serve_state(state.clone()).await, state)
}

fn token() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let claims = json!({
        "iss": "sample", "aud": "opencanvas", "exp": now + 600, "jti": ulid::Ulid::new().to_string(),
        "file": {"id": FILE, "name": "Doc one", "version": "0"},
        "user": {"id": "u_1", "name": "Asha Rao"}, "role": "edit",
        "perms": {"export": true, "download": true, "comment": true}, "callbackToken": "cb-u_1"
    });
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}

async fn session_json(addr: &str) -> Value {
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let res = http
        .post(format!("http://{addr}/v1/launch"))
        .form(&[("token", token())])
        .send()
        .await
        .unwrap();
    let loc = res.headers()["location"].to_str().unwrap().to_string();
    let ticket = loc.strip_prefix("/app/#t=").unwrap().to_string();
    http.get(format!("http://{addr}/v1/sessions/{ticket}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

fn api(addr: &str, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .request(method, format!("http://{addr}/api/v1/files/{FILE}{path}"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", API_KEY)
}

async fn batch(addr: &str, ops: Value) -> (u16, Value) {
    let res = api(addr, reqwest::Method::POST, "/blocks:batch")
        .json(&json!({"ops": ops}))
        .send()
        .await
        .unwrap();
    (
        res.status().as_u16(),
        res.json().await.unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn installed_packages_reach_the_session_and_refused_ones_healthz() {
    let (addr, state) = serve("session").await;
    assert!(state.blocks.registry.get("srv.okr").is_some());
    assert!(
        state.blocks.registry.get("srv.bad").is_none(),
        "integrity mismatch"
    );

    let s = session_json(&addr).await;
    let blocks = s["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 1, "{s}");
    let b = &blocks[0];
    assert_eq!(b["type"], "srv.okr");
    assert_eq!(b["version"], "1.2.0");
    assert_eq!(b["v"], 1);
    assert_eq!(b["entry"], "https://blocks.example/srv.okr/1.2.0/block.js");
    assert_eq!(
        b["integrity"],
        oc_server::blocks::sri_sha384(b"export default {}")
    );
    assert_eq!(b["attrs"]["required"], json!(["objective"]));

    let health: Value = reqwest::get(format!("http://{addr}/healthz"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["ok"], true);
    assert_eq!(health["blocks"]["installed"], 1);
    let refused = &health["blocks"]["refused"][0];
    assert_eq!(refused["package"], "tampered");
    assert!(
        refused["reason"]
            .as_str()
            .unwrap()
            .contains("integrity mismatch"),
        "{health}"
    );
}

#[tokio::test]
async fn api_writes_are_checked_against_the_block_schema() {
    let (addr, state) = serve("api").await;
    let mut a = Peer::join(&state, {
        let mut g = grant("u_a", Role::Edit);
        g.ext_blocks = true;
        g
    })
    .await;
    a.settle().await;

    let (s, out) = batch(&addr, json!([{"op": "append", "blocks": [
        {"type": "extBlock", "attrs": {"blockId": "b_okr", "type": "srv.okr", "attrs": {"objective": "Ship v0.2", "progress": 0.4}},
         "data": {"score": 3}}
    ]}]))
    .await;
    assert_eq!(s, 200, "{out}");
    a.settle().await;
    let doc = json_of(&a.doc);
    let attrs = &doc["content"][0]["attrs"];
    assert_eq!(attrs["v"], 1, "the installed version is stamped");
    assert_eq!(attrs["fallback"]["markdown"], "**Ship v0.2** (40%)");
    assert_eq!(
        doc["ext"][attrs["dataId"].as_str().unwrap()],
        json!({"score": 3})
    );

    // Schema-invalid attrs or data: refused before anything reaches the room.
    for bad in [
        json!({"type": "extBlock", "attrs": {"type": "srv.okr", "attrs": {"objective": "x", "progress": 7}}}),
        json!({"type": "extBlock", "attrs": {"type": "srv.okr", "attrs": {"objective": "x"}}, "data": {"score": "lots"}}),
        json!({"type": "extBlock", "attrs": {"type": "srv.okr", "attrs": {}}}),
    ] {
        let (s, out) = batch(&addr, json!([{"op": "append", "blocks": [bad.clone()]}])).await;
        assert_eq!(s, 400, "{bad}: {out}");
        assert!(
            out["detail"]
                .as_str()
                .unwrap_or_default()
                .contains("srv.okr"),
            "{out}"
        );
    }
    // A type this server did not install is kept as written (round trip), not refused.
    let (s, out) = batch(&addr, json!([{"op": "append", "blocks": [
        {"type": "extBlock", "attrs": {"type": "other.thing", "v": 3, "attrs": {"anything": [1]},
         "fallback": {"text": "Other thing"}}}
    ]}]))
    .await;
    assert_eq!(s, 200, "{out}");

    // Reads: JSON carries the node and its data; Markdown the template rendering.
    let res = api(&addr, reqwest::Method::GET, "?format=json")
        .send()
        .await
        .unwrap();
    let read: Value = res.json().await.unwrap();
    let first = &read["blocks"][0];
    assert_eq!(first["node"]["attrs"]["type"], "srv.okr", "{read}");
    assert_eq!(first["data"], json!({"score": 3}), "{read}");
    let res = api(&addr, reqwest::Method::GET, "?format=markdown")
        .send()
        .await
        .unwrap();
    let md: Value = res.json().await.unwrap();
    let md = md["markdown"].as_str().unwrap();
    assert!(
        md.contains("**Ship v0.2** (40%)") && md.contains("Other thing"),
        "{md}"
    );
}

#[tokio::test]
async fn an_editor_older_than_0_2_cannot_delete_sdk_blocks() {
    let (addr, state) = serve("legacy").await;
    let mut new = Peer::join(&state, {
        let mut g = grant("u_new", Role::Edit);
        g.ext_blocks = true;
        g
    })
    .await;
    // `grant()` is a connection without `caps=ext`: an editor older than 0.2.
    let mut old = Peer::join(&state, grant("u_old", Role::Edit)).await;
    new.settle().await;
    old.settle().await;
    // Before any SDK block exists, the old editor edits as always.
    old.edit(|d| {
        let c = d.get_or_insert_xml_fragment("content");
        let mut t = d.transact_mut();
        c.push_back(&mut t, yrs::XmlElementPrelim::empty("paragraph"));
    });
    old.settle().await;
    assert_eq!(old.closed, None);

    let (s, out) = batch(&addr, json!([{"op": "append", "blocks": [
        {"type": "extBlock", "attrs": {"blockId": "b_okr", "type": "srv.okr", "attrs": {"objective": "Keep me"}}}
    ]}]))
    .await;
    assert_eq!(s, 200, "{out}");
    old.settle().await;
    new.settle().await;

    // What y-prosemirror does in a 0.1.x editor: delete the node its schema lacks.
    let remove_ext = |d: &yrs::Doc| {
        let c = d.get_or_insert_xml_fragment("content");
        let mut t = d.transact_mut();
        let at = (0..c.len(&t))
            .find(|i| matches!(c.get(&t, *i), Some(yrs::XmlOut::Element(e)) if e.tag().as_ref() == "extBlock"))
            .unwrap();
        c.remove_range(&mut t, at, 1);
    };
    old.edit(remove_ext);
    old.settle().await;
    assert_eq!(old.closed, Some(4426), "the old editor's session ends");
    assert!(old.denied > 0);
    let server = server_json(&state).await;
    assert!(
        server.to_string().contains("Keep me"),
        "the block is kept: {server}"
    );

    // A current editor may delete it.
    new.edit(remove_ext);
    new.settle().await;
    assert_eq!(new.closed, None);
    assert!(!server_json(&state).await.to_string().contains("Keep me"));
}
