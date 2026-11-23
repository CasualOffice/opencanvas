// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Per-host embed origins (`frame_ancestors`, docs/05 §4, MX-01): a host's extra frame
//! ancestors apply to that host's editor pages only, never to the server-wide policy, and
//! hosts without the setting keep today's behaviour.

mod common;

use common::*;
use jsonwebtoken::{EncodingKey, Header, encode};
use serde_json::json;

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn token() -> String {
    let claims = json!({
        "iss": "sample", "aud": "opencanvas", "exp": now() + 600, "jti": ulid::Ulid::new().to_string(),
        "file": {"id": FILE, "name": "Doc one", "version": "0"},
        "user": {"id": "u_1", "name": "Asha Rao"},
        "role": "edit", "callbackToken": "cb-u_1"
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

async fn csp_of(addr: &str, path: &str) -> String {
    let res = http()
        .get(format!("http://{addr}{path}"))
        .send()
        .await
        .unwrap();
    res.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .to_string()
}

async fn launch_location(addr: &str) -> String {
    let res = http()
        .post(format!("http://{addr}/v1/launch"))
        .form(&[("token", token().as_str())])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 303);
    res.headers()["location"].to_str().unwrap().to_string()
}

const ELEMENT: &str = "https://element.acme.example";

#[tokio::test]
async fn host_frame_ancestors_apply_to_that_hosts_editor_only() {
    let (base, _host) = mock_host().await;
    let state = app_custom(&base, room_cfg(), &temp_db(), |h| {
        h.frame_ancestors = vec![ELEMENT.into()];
    })
    .await;
    let addr = serve_state(state).await;

    // The launch names the host in the editor URL so its page gets the host's ancestors.
    let loc = launch_location(&addr).await;
    assert!(loc.starts_with("/app/?h=sample#t="), "{loc}");

    let csp = csp_of(&addr, "/app/?h=sample").await;
    assert!(
        csp.ends_with(&format!(
            "frame-ancestors 'self' http://localhost:4000 {ELEMENT}"
        )),
        "{csp}"
    );
    // Not server-wide: other pages, other hosts' editors and unknown hosts do not get it.
    for path in ["/app/", "/app/?h=other", "/healthz", "/app/?h=sample%20x"] {
        let csp = csp_of(&addr, path).await;
        assert!(!csp.contains(ELEMENT), "{path}: {csp}");
        assert!(
            csp.ends_with("frame-ancestors 'self' http://localhost:4000"),
            "{path}: {csp}"
        );
    }
}

#[tokio::test]
async fn hosts_without_frame_ancestors_keep_todays_redirect_and_policy() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let addr = serve_state(state).await;
    let loc = launch_location(&addr).await;
    assert!(loc.starts_with("/app/#t="), "{loc}");
    let csp = csp_of(&addr, "/app/?h=sample").await;
    assert!(
        csp.ends_with("frame-ancestors 'self' http://localhost:4000"),
        "{csp}"
    );
}
