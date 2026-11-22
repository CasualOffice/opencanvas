// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Regression tests for the 2026-11-21 security audit (docs/18). Each test names its finding.

mod common;

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::http::HeaderMap;
use axum::routing::get;
use common::*;
use oc_server::grant::Role;
use oc_server::room::protocol;
use yrs::ClientID;
use yrs::sync::AwarenessUpdate;
use yrs::sync::awareness::AwarenessUpdateEntry;

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
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

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn header(res: &reqwest::Response, k: &str) -> String {
    res.headers()
        .get(k)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

/// SEC-01: the global `frame-ancestors` header used to *replace* every handler's own CSP
/// (the `sandbox` on room assets and exports was lost). Exports must keep a sandboxing CSP,
/// every response must carry `nosniff`, and the SPA gets a script-restricting policy.
#[tokio::test]
async fn sec01_responses_keep_their_own_csp_and_get_baseline_headers() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let t = ticket_for(&state, &grant("u_1", Role::Edit)).await;
    let addr = serve_state(state).await;
    let c = http();

    let res = c
        .get(format!("http://{addr}/v1/export/html?ticket={t}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let csp = header(&res, "content-security-policy");
    assert!(csp.contains("sandbox"), "export CSP lost: {csp}");
    assert!(csp.contains("default-src 'none'"), "{csp}");
    assert!(csp.contains("frame-ancestors"), "{csp}");
    assert_eq!(header(&res, "x-content-type-options"), "nosniff");

    let res = c
        .get(format!("http://{addr}/healthz"))
        .send()
        .await
        .unwrap();
    assert_eq!(header(&res, "x-content-type-options"), "nosniff");
    assert_eq!(header(&res, "referrer-policy"), "no-referrer");

    let res = c.get(format!("http://{addr}/app/")).send().await.unwrap();
    let csp = header(&res, "content-security-policy");
    assert!(csp.contains("script-src 'self'"), "SPA CSP: {csp}");
    assert!(csp.contains("object-src 'none'"), "{csp}");
    assert!(
        csp.contains("frame-ancestors 'self' http://localhost:4000"),
        "{csp}"
    );
}

/// SEC-02: `/metrics` was open to anyone. With `OC_METRICS_TOKEN` set it needs the bearer.
#[tokio::test]
async fn sec02_metrics_need_the_token_when_one_is_configured() {
    let (base, _host) = mock_host().await;
    let state = app_full(
        &base,
        room_cfg(),
        &temp_db(),
        |_| {},
        |cfg| cfg.metrics_token = Some("m-secret-0123456789".into()),
    )
    .await;
    let addr = serve_state(state).await;
    let c = http();
    let url = format!("http://{addr}/metrics");
    assert_eq!(c.get(&url).send().await.unwrap().status(), 401);
    assert_eq!(
        c.get(&url)
            .bearer_auth("wrong")
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let ok = c
        .get(&url)
        .bearer_auth("m-secret-0123456789")
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);
    assert!(ok.text().await.unwrap().contains("oc_rooms_active"));
}

/// SEC-03: rooms had no peer cap (docs/07 says 550); every socket was admitted.
#[tokio::test]
async fn sec03_a_full_room_refuses_more_peers() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let mut peers = Vec::new();
    for i in 0..550 {
        peers.push(Peer::join(&state, grant(&format!("u_{i}"), Role::View)).await);
    }
    let mut extra = Peer::join(&state, grant("u_extra", Role::View)).await;
    extra.settle().await;
    assert_eq!(extra.closed, Some(1013), "peer 551 must be refused");
    peers[0].settle().await;
    assert_eq!(peers[0].closed, None);
}

/// SEC-04: one connection could register any number of awareness client ids (memory DoS and
/// fan-out amplification). At most 8 are kept per connection.
#[tokio::test]
async fn sec04_awareness_client_ids_per_connection_are_capped() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    b.settle().await;
    let update = AwarenessUpdate {
        clients: (1..=50u64)
            .map(|i| {
                (
                    ClientID::new(1000 + i),
                    AwarenessUpdateEntry {
                        clock: 1,
                        json: Arc::from("{\"cursor\":null}"),
                    },
                )
            })
            .collect(),
    };
    a.send(protocol::awareness(update));
    b.settle().await;
    let seen: std::collections::HashSet<ClientID> = b
        .awareness
        .iter()
        .flat_map(|u| u.clients.keys().copied())
        .collect();
    assert!(
        !seen.is_empty() && seen.len() <= 8,
        "relayed {} ids",
        seen.len()
    );
}

/// SEC-05: tickets and other path values reach SQL only as bound parameters.
#[tokio::test]
async fn sec05_sql_metacharacters_in_a_ticket_are_just_an_unknown_ticket() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let _ = ticket_for(&state, &grant("u_1", Role::Edit)).await;
    for evil in [
        "' OR '1'='1",
        "x' UNION SELECT grant_json, 9999999999 FROM sessions --",
    ] {
        assert!(state.store.session(evil).await.unwrap().is_none(), "{evil}");
    }
    let addr = serve_state(state).await;
    let res = http()
        .get(format!(
            "http://{addr}/v1/sessions/%27%20OR%20%271%27%3D%271"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

/// SEC-05 (guard): no SQL text in the server is built with `format!` / concatenation.
#[test]
fn sec05_every_sql_statement_is_a_literal() {
    let src = concat!(
        include_str!("../src/store.rs"),
        include_str!("../src/cluster/lease.rs")
    );
    for (i, line) in src.lines().enumerate() {
        let l = line.trim();
        assert!(
            !(l.contains("sqlx::query(&") || l.contains("sqlx::query(format!")),
            "line {}: dynamic SQL: {l}",
            i + 1
        );
        if l.contains("format!(") {
            let upper = l.to_ascii_uppercase();
            for kw in [
                "SELECT ", "INSERT ", "UPDATE ", "DELETE ", " WHERE ", " LIKE ",
            ] {
                assert!(!upper.contains(kw), "line {}: SQL in format!: {l}", i + 1);
            }
        }
    }
}

/// SEC-06: without `OC_PUBLIC_URL` the discovery XML echoes the request's `Host`; it was
/// served `public, max-age=3600`, so one forged Host could poison shared caches.
#[tokio::test]
async fn sec06_host_derived_discovery_is_not_publicly_cacheable() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let addr = serve_state(state).await;
    let res = http()
        .get(format!("http://{addr}/hosting/discovery"))
        .header("host", "evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let cc = header(&res, "cache-control");
    assert!(!cc.contains("public"), "cache-control: {cc}");
}

/// SEC-07: signed callbacks followed redirects, so a redirecting callback URL forwarded the
/// `X-OpenCanvas-Signature` header (and the request) to wherever it pointed.
#[tokio::test]
async fn sec07_signed_callbacks_do_not_follow_redirects() {
    let seen: Arc<Mutex<Vec<HeaderMap>>> = Arc::default();
    let s2 = seen.clone();
    let evil = Router::new().route(
        "/steal",
        get(move |h: HeaderMap| {
            let s = s2.clone();
            async move {
                s.lock().unwrap().push(h);
                "stolen"
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let evil_addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, evil).await.unwrap() });
    let target = format!("http://{evil_addr}/steal");
    let redirector = Router::new().route(
        "/api/files/{id}",
        get(move || {
            let t = target.clone();
            async move { axum::response::Redirect::temporary(&t) }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/api", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, redirector).await.unwrap() });

    let state = app(&base, room_cfg()).await;
    let host = state.hosts.get("sample").unwrap();
    let res = state.host.get_file(&host, "cb-token", "f1").await;
    assert!(res.is_err(), "a redirect is not a file");
    assert!(
        seen.lock().unwrap().is_empty(),
        "the signed request was forwarded to another origin"
    );
}

/// SEC-08: host errors returned to the browser carried the internal callback URL.
#[tokio::test]
async fn sec08_host_errors_do_not_reveal_callback_urls() {
    let state = app("http://127.0.0.1:9/internal-secret-path", room_cfg()).await;
    let t = ticket_for(&state, &grant("u_1", Role::Edit)).await;
    let addr = serve_state(state).await;
    let body = "--XyZ\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--XyZ--\r\n";
    let res = http()
        .post(format!("http://{addr}/v1/assets?ticket={t}"))
        .header("content-type", "multipart/form-data; boundary=XyZ")
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 502);
    let body = res.text().await.unwrap();
    assert!(!body.contains("internal-secret-path"), "{body}");
    assert!(!body.contains("127.0.0.1:9"), "{body}");
}

/// EX-09: the host's `export_formats` flag limits the formats, whatever the session's perms.
#[tokio::test]
async fn sec_host_export_formats_limits_what_can_be_exported() {
    // docs/05 §2: `[host.flags] export_formats` lists the formats the host allows. A format
    // outside it is refused even when the session has `perms.export` (docs/23 EX-09).
    let (base, _host) = mock_host().await;
    let state = app_custom(&base, room_cfg(), &temp_db(), |h| {
        h.flags.insert(
            "export_formats".into(),
            toml::Value::Array(vec!["md".into(), "svg".into()]),
        );
    })
    .await;
    let g = grant("u_e", Role::Edit);
    let t = ticket_for(&state, &g).await;
    let addr = serve_state(state).await;
    for (path, want) in [
        ("export/md", 200),
        ("export/html", 403),
        ("export/docx", 403),
        ("export/ocanvas", 403),
        ("export/board/b1.png", 403),
    ] {
        let res = http()
            .get(format!("http://{addr}/v1/{path}?ticket={t}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), want, "{path}");
    }
}

/// SEC-02/04 (guard): a viewer whose perms forbid export cannot export any format or board.
#[tokio::test]
async fn sec_guard_export_needs_the_permission_for_every_format() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let mut g = grant("u_v", Role::View);
    g.perms.export = false;
    g.perms.download = false;
    let t = ticket_for(&state, &g).await;
    let addr = serve_state(state).await;
    for path in [
        "export/md",
        "export/html",
        "export/json",
        "export/docx",
        "export/pdf",
        "export/ocanvas",
        "export/board/b1.svg",
        "export/board/b1.png",
    ] {
        let res = http()
            .get(format!("http://{addr}/v1/{path}?ticket={t}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 403, "{path}");
    }
    // A ticket never opens another room's socket.
    let other = oc_server::grant::room_id("sample", "another-file");
    let res = http()
        .get(format!("http://{addr}/v1/collab/{other}?ticket={t}"))
        .header("connection", "upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
}
