// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The server the client conformance suite runs against (HAPI-06/07,
//! `crates/oc-server/api/conformance.json`): a real OpenCanvas router on a random port, the
//! test harness's mock host behind it, and a few test-only control routes under
//! `/__conformance/`. Included by path from the Rust client's tests and from the
//! `conformance_server` example the TypeScript client's tests start; it expects the harness
//! (`tests/common`) as `crate::common`.
//!
//! Hosts: `conf` (API on, generous limits, webhooks for every event, events not debounced)
//! and `tight` (burst 2 at 1 request/s, for the rate-limit scenario). The server clock is
//! pinned; it only moves through `POST /__conformance/clock`, so no scenario sleeps.

#![allow(dead_code)]

use std::time::Duration;

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use oc_server::SharedState;
use serde_json::{Value, json};

use crate::common::{SECRET, Shared, host_config, mock_host, room_cfg, temp_db};

/// The public base URL API tokens are minted for (`[host.api] audience`).
pub const PUBLIC: &str = "https://oc.conformance";
/// Where the server clock starts.
pub const T0_MS: i64 = 1_800_000_000_000;

pub struct Conformance {
    /// `http://127.0.0.1:<port>`
    pub base_url: String,
    pub state: SharedState,
    pub host: Shared,
    /// What the suite needs to know: base URL, host ids and keys, the webhook secret.
    pub info: Value,
}

fn api(h: &mut oc_server::hosts::HostConfig, id: &str, key: &str) {
    h.id = id.into();
    h.name = id.into();
    h.api_key = Some(key.into());
    h.flags.insert("api_v1".into(), toml::Value::Boolean(true));
    h.api
        .insert("audience".into(), toml::Value::String(PUBLIC.into()));
}

/// Starts the server and its mock host.
pub async fn start() -> Conformance {
    let (base, host) = mock_host().await;
    let mut conf = host_config(&base);
    api(&mut conf, "conf", "conf-key");
    for (k, v) in [
        ("rate_per_sec", 100_000),
        ("burst", 100_000),
        ("file_writes_per_sec", 100_000),
        ("file_burst", 100_000),
        ("events_coalesce_ms", 0),
    ] {
        conf.api.insert(k.into(), toml::Value::Integer(v));
    }
    let mut hooks = toml::Table::new();
    hooks.insert("url".into(), toml::Value::String(format!("{base}/hooks")));
    hooks.insert(
        "events".into(),
        toml::Value::Array(vec![toml::Value::String("*".into())]),
    );
    conf.webhooks = hooks;
    let mut tight = host_config(&base);
    api(&mut tight, "tight", "tight-key");
    for (k, v) in [
        ("rate_per_sec", 1),
        ("burst", 2),
        ("file_writes_per_sec", 1),
        ("file_burst", 2),
    ] {
        tight.api.insert(k.into(), toml::Value::Integer(v));
    }
    let db = temp_db();
    let cfg = oc_server::config::Config {
        bind: "127.0.0.1:0".into(),
        public_url: None,
        database_url: format!("sqlite://{}?mode=rwc", db.display()),
        hosts_file: "unused".into(),
        web_dir: "unused".into(),
        callback_base_override: None,
        pdf_renderer: None,
        metrics_token: None,
        wal_redis_url: None,
        storage_redis_url: None,
        kek: Some(oc_server::crypto::Kek::from_b64(crate::common::TEST_KEK).unwrap()),
        rooms: room_cfg(),
        ai: None,
        import_off: false,
        unfurl: Default::default(),
        wopi_proof: Some(crate::common::test_proof_keys()),
    };
    let state =
        oc_server::AppState::new(cfg, oc_server::hosts::Hosts::from_list(vec![conf, tight]))
            .await
            .unwrap();
    state.clock.set_ms(T0_MS);
    let ctl = Router::new()
        .route("/__conformance/clock", post(clock))
        .route("/__conformance/token", post(token))
        .route("/__conformance/webhooks", post(webhooks))
        .with_state((state.clone(), host.clone()));
    let app = ctl.merge(oc_server::router(state.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let base_url = format!("http://{addr}");
    let info = json!({
        "baseUrl": base_url,
        "hosts": {
            "conf": {"id": "conf", "key": "conf-key"},
            "tight": {"id": "tight", "key": "tight-key"},
        },
        "webhookSecret": SECRET,
    });
    Conformance {
        base_url,
        state,
        host,
        info,
    }
}

type Ctl = State<(SharedState, Shared)>;

/// `{advanceMs}`: moves the server clock (rate-limit refills, cursor and key expiry).
async fn clock(State((state, _)): Ctl, Json(v): Json<Value>) -> Json<Value> {
    state.clock.advance_ms(v["advanceMs"].as_i64().unwrap_or(0));
    Json(json!({"nowMs": state.clock.now_ms()}))
}

/// `{host, sub, scope, role?, files?}`: a user token the way a host mints one (docs/05 §7b).
async fn token(Json(v): Json<Value>) -> Json<Value> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut c = json!({
        "iss": v["host"].as_str().unwrap_or("conf"),
        "aud": format!("{PUBLIC}/api/v1"),
        "sub": v["sub"].as_str().unwrap_or("u_conformance"),
        "exp": now + 600,
        "scope": v["scope"].as_str().unwrap_or("canvas:read"),
        "role": v["role"].as_str().unwrap_or("edit"),
    });
    if let Some(f) = v.get("files") {
        c["files"] = f.clone();
    }
    let t = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        &c,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    Json(json!({"token": t}))
}

/// `{type, fileId}`: runs the delivery worker until a webhook of that type for that file
/// reached the mock host (events reach the outbox in the background, so this waits for the
/// condition, up to 10 s), then answers those deliveries as `{pathQuery, signature, body,
/// nowSecs}`.
async fn webhooks(State((state, host)): Ctl, Json(v): Json<Value>) -> Json<Value> {
    let want_type = v["type"].as_str().unwrap_or_default().to_string();
    let want_file = v["fileId"].as_str().unwrap_or_default().to_string();
    let matching = |host: &Shared| -> Vec<Value> {
        host.lock()
            .unwrap()
            .hooks
            .iter()
            .filter_map(|h| {
                let body: Value = serde_json::from_slice(&h.body).ok()?;
                (body["type"] == want_type.as_str() && body["fileId"] == want_file.as_str()).then(
                    || {
                        json!({
                            "pathQuery": "/api/hooks",
                            "signature": h.headers.get("x-opencanvas-signature")
                                .and_then(|s| s.to_str().ok()).unwrap_or_default(),
                            "body": String::from_utf8_lossy(&h.body),
                        })
                    },
                )
            })
            .collect()
    };
    for _ in 0..400 {
        let _ = state.deliver_webhooks(state.clock.now_ms()).await;
        let found = matching(&host);
        if !found.is_empty() {
            return Json(json!({"deliveries": found, "nowSecs": state.clock.now_secs()}));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Json(json!({"deliveries": [], "nowSecs": state.clock.now_secs()}))
}
