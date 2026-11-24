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
        "publisher": "Acme Corp", "keywords": ["goals"],
        "permissions": {"network": ["https://okr.example", "https://cdn.example"], "members": "read"},
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
    h.blocks = toml::from_str(
        "enabled = [\"srv.okr@^1\", \"srv.bad\"]\n[permissions.\"srv.okr\"]\nnetwork = [\"https://okr.example\"]\n",
    )
    .unwrap();
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
    assert_eq!(
        b["entry"],
        "https://blocks.example/blocks/srv.okr/1.2.0/block.js"
    );
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
    // srv.okr plus the built-in oc.progress.
    assert_eq!(health["blocks"]["installed"], 2);
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

fn on(addr: &str, host: &str, path: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .get(format!("http://{addr}{path}"))
        .header(reqwest::header::HOST, host)
}

/// BSDK-03: the frame and the package files are served on the block origin only, with the
/// CSP built from the effective permissions (manifest narrowed by the host).
#[tokio::test]
async fn block_frames_are_served_on_the_block_origin_only() {
    let (addr, _state) = serve("frame").await;
    let s = session_json(&addr).await;
    let b = &s["blocks"][0];
    assert_eq!(
        b["frame"],
        "https://blocks.example/blocks/frame/sample/srv.okr"
    );
    assert_eq!(b["publisher"], "Acme Corp");
    assert_eq!(
        b["permissions"],
        json!({"network": ["https://okr.example"], "members": "read"})
    );

    let res = on(&addr, "blocks.example", "/blocks/frame/sample/srv.okr")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let csp = res.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .to_string();
    let html = res.text().await.unwrap();
    assert!(
        csp.starts_with("default-src 'none'; script-src 'sha384-"),
        "{csp}"
    );
    assert!(
        csp.contains("https://blocks.example/blocks/srv.okr/1.2.0/;"),
        "{csp}"
    );
    assert!(
        csp.contains("connect-src https://okr.example;"),
        "host narrowing: {csp}"
    );
    assert!(!csp.contains("cdn.example"), "{csp}");
    assert!(
        html.contains("integrity=\"sha384-") && html.contains("crossorigin=\"anonymous\""),
        "{html}"
    );
    // The runtime inlined in the page is the one the CSP hash allows.
    let runtime_hash = oc_server::blocks::sri_sha384(oc_server::blocks::FRAME_RUNTIME.as_bytes());
    assert!(csp.contains(&format!("'{runtime_hash}'")), "{csp}");
    assert!(html.contains(oc_server::blocks::FRAME_RUNTIME));

    let file = on(&addr, "blocks.example", "/blocks/srv.okr/1.2.0/block.js")
        .send()
        .await
        .unwrap();
    assert_eq!(file.status(), 200);
    assert_eq!(file.headers()["access-control-allow-origin"], "*");
    assert_eq!(file.text().await.unwrap(), "export default {}");

    // Not on the editor's host name, not for a type the host does not enable, no other files.
    for (host, path) in [
        ("127.0.0.1", "/blocks/frame/sample/srv.okr"),
        ("127.0.0.1", "/blocks/srv.okr/1.2.0/block.js"),
        ("blocks.example", "/blocks/frame/sample/srv.bad"),
        ("blocks.example", "/blocks/frame/nobody/srv.okr"),
        ("blocks.example", "/blocks/srv.okr/1.2.0/block.json"),
        ("blocks.example", "/blocks/srv.okr/9.9.9/block.js"),
    ] {
        let r = on(&addr, host, path).send().await.unwrap();
        assert_eq!(r.status(), 404, "{host}{path}");
    }
    // The editor page may frame the block origin (frame-src).
    let app = reqwest::get(format!("http://{addr}/healthz"))
        .await
        .unwrap();
    let editor_csp = app.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .to_string();
    assert!(editor_csp.contains("frame-src https:"), "{editor_csp}");
}

/// BSDK-03: a room update that breaks an SDK block's schema is refused, whatever client sent
/// it; a valid one goes through.
#[tokio::test]
async fn room_updates_that_break_a_block_schema_are_refused() {
    let (addr, state) = serve("ws").await;
    let mut a = Peer::join(&state, {
        let mut g = grant("u_a", Role::Edit);
        g.ext_blocks = true;
        g
    })
    .await;
    a.settle().await;
    let (s, out) = batch(&addr, json!([{"op": "append", "blocks": [
        {"type": "extBlock", "attrs": {"blockId": "b_okr", "type": "srv.okr", "attrs": {"objective": "Ship"}}}
    ]}]))
    .await;
    assert_eq!(s, 200, "{out}");
    a.settle().await;
    let set_attrs = |doc: &yrs::Doc, attrs: Value| {
        let c = doc.get_or_insert_xml_fragment("content");
        let mut t = doc.transact_mut();
        let Some(yrs::XmlOut::Element(el)) = c.get(&t, 0) else {
            panic!("no block")
        };
        yrs::Xml::insert_attribute(&el, &mut t, "attrs", oc_model::import::json_to_any(&attrs));
    };
    a.edit(|d| set_attrs(d, json!({"objective": 42})));
    a.settle().await;
    assert!(a.denied > 0, "the invalid write is refused");
    assert!(server_json(&state).await.to_string().contains("Ship"));
    // A refused update leaves that client diverged (its later edits build on it), so the valid
    // write comes from a fresh connection, as a reloaded editor would send it.
    let mut b = Peer::join(&state, {
        let mut g = grant("u_b", Role::Edit);
        g.ext_blocks = true;
        g
    })
    .await;
    b.settle().await;
    b.edit(|d| set_attrs(d, json!({"objective": "Ship v2", "progress": 0.5})));
    b.settle().await;
    assert_eq!(b.denied, 0);
    assert!(server_json(&state).await.to_string().contains("Ship v2"));
}

/// BSDK-04: `oc.progress` is compiled in (first party, the `oc.` prefix allowed) and enabled
/// like any package; the `acme.okr` sample package installs from a blocks directory.
#[tokio::test]
async fn the_samples_install() {
    let (base, _host) = mock_host().await;
    let state = app_full(
        &base,
        room_cfg(),
        &temp_db(),
        |h| h.blocks = toml::from_str("enabled = [\"oc.progress\", \"acme.okr@^1\"]").unwrap(),
        |c| {
            c.blocks = oc_server::blocks::BlocksConfig {
                dir: Some(
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/blocks"),
                ),
                origin: Some("https://blocks.example".into()),
            };
        },
    )
    .await;
    assert!(
        state.blocks.refused.is_empty(),
        "{:?}",
        state.blocks.refused
    );
    let addr = serve_state(state.clone()).await;
    let s = session_json(&addr).await;
    let types: Vec<&str> = s["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["type"].as_str().unwrap())
        .collect();
    assert_eq!(types, ["oc.progress", "acme.okr"]);
    let okr = &s["blocks"][1];
    assert_eq!(
        okr["preview"],
        "https://blocks.example/blocks/acme.okr/1.2.0/preview.png"
    );
    assert_eq!(okr["discovery"]["category"], "data-planning");
    assert_eq!(okr["permissions"]["members"], "read");
    let png = on(
        &addr,
        "blocks.example",
        "/blocks/acme.okr/1.2.0/preview.png",
    )
    .send()
    .await
    .unwrap();
    assert_eq!(png.headers()["content-type"], "image/png");
    // Exports draw the samples' templates.
    let reg = oc_model::ext::installed();
    let doc = json!({"content": [
        {"type": "extBlock", "attrs": {"type": "oc.progress", "v": 1, "attrs": {"label": "Launch", "value": 0.5}}},
        {"type": "extBlock", "attrs": {"type": "acme.okr", "v": 1, "attrs": {"objective": "Ship", "progress": 0.5,
            "krs": [{"title": "API", "progress": 1}, {"title": "SDK", "progress": 0}]}}}
    ]});
    assert!(reg.get("oc.progress").is_some());
    let md = oc_model::export::to_markdown(&doc);
    assert!(md.contains("**Launch**: 50%"), "{md}");
    assert!(
        md.contains("**Ship** (50%)\n- API: 100%\n- SDK: 0%"),
        "{md}"
    );
}
