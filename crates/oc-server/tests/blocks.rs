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
use serde_json::{Value, json};

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
