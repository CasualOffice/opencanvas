// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! FILE-01: `GET /v1/assets/fetch?ticket=&url=` serves an attachment's bytes from this origin
//! (pdf.js and text previews can't read the host's origin), under the same origin rules as
//! export image fetching: exact allowed origins, no userinfo, no redirects; at most 50 MB.
mod common;

use common::*;
use jsonwebtoken::{EncodingKey, Header, encode};
use serde_json::{Value, json};

fn token(role: &str, download: bool) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let claims = json!({
        "iss": "sample", "aud": "opencanvas", "exp": now + 600, "jti": ulid::Ulid::new().to_string(),
        "file": {"id": FILE, "name": "Doc one", "version": "0"},
        "user": {"id": "u_1", "name": "Asha Rao"},
        "role": role, "perms": {"export": true, "download": download, "comment": true},
        "callbackToken": "cb-u_1"
    });
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

/// Serves OpenCanvas for the mock host; returns (address, a session ticket).
async fn session(base: &str, role: &str, download: bool) -> (String, String) {
    let state = app(base, room_cfg()).await;
    let addr = serve_state(state).await;
    let res = http()
        .post(format!("http://{addr}/v1/launch"))
        .form(&[("token", token(role, download))])
        .send()
        .await
        .unwrap();
    let ticket = res.headers()["location"]
        .to_str()
        .unwrap()
        .trim_start_matches("/app/#t=")
        .to_string();
    (addr, ticket)
}

async fn fetch(addr: &str, ticket: &str, url: &str) -> reqwest::Response {
    http()
        .get(format!("http://{addr}/v1/assets/fetch"))
        .query(&[("ticket", ticket), ("url", url)])
        .send()
        .await
        .unwrap()
}

fn origin(base: &str) -> String {
    base.trim_end_matches("/api").to_string()
}

#[tokio::test]
async fn an_allowed_asset_is_served_inline_and_sandboxed() {
    let (base, host) = mock_host().await;
    let (addr, ticket) = session(&base, "edit", true).await;
    let res = fetch(&addr, &ticket, &format!("{}/assets/doc.pdf", origin(&base))).await;
    assert_eq!(res.status(), 200);
    let h = res.headers().clone();
    assert_eq!(h["content-type"], "application/pdf");
    assert_eq!(h["content-disposition"], "inline");
    assert_eq!(h["x-content-type-options"], "nosniff");
    assert!(
        h["content-security-policy"]
            .to_str()
            .unwrap()
            .starts_with("sandbox; default-src 'none'"),
        "{:?}",
        h["content-security-policy"]
    );
    assert!(res.bytes().await.unwrap().starts_with(b"%PDF"));
    // The host's own origin is fetched signed, like every callback.
    let gets = host.lock().unwrap().asset_gets.clone();
    assert_eq!(gets, vec![("doc.pdf".to_string(), true)]);
}

#[tokio::test]
async fn other_origins_userinfo_and_odd_schemes_are_refused() {
    let (base, host) = mock_host().await;
    let (addr, ticket) = session(&base, "edit", true).await;
    let o = origin(&base);
    for bad in [
        "https://evil.example/x.pdf".to_string(),
        o.replace("http://", "http://user:pw@") + "/assets/doc.pdf",
        "file:///etc/passwd".into(),
        "javascript:alert(1)".into(),
        "//evil.example/x.pdf".into(),
    ] {
        let res = fetch(&addr, &ticket, &bad).await;
        assert_eq!(res.status(), 403, "{bad}");
        let v: Value = res.json().await.unwrap();
        assert_eq!(v["error"]["code"], "ASSET_ORIGIN_NOT_ALLOWED", "{bad}");
    }
    assert!(
        host.lock().unwrap().asset_gets.is_empty(),
        "nothing fetched"
    );
}

#[tokio::test]
async fn redirects_are_not_followed() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().redirect_to = Some("https://evil.example/x.pdf".into());
    let (addr, ticket) = session(&base, "edit", true).await;
    let res = fetch(
        &addr,
        &ticket,
        &format!("{}/assets/redirect", origin(&base)),
    )
    .await;
    assert_eq!(res.status(), 502);
    let v: Value = res.json().await.unwrap();
    assert_eq!(v["error"]["code"], "ASSET_UNAVAILABLE");
}

#[tokio::test]
async fn assets_over_50_mb_are_refused() {
    let (base, _host) = mock_host().await;
    let (addr, ticket) = session(&base, "edit", true).await;
    let res = fetch(
        &addr,
        &ticket,
        &format!("{}/assets/huge.pdf", origin(&base)),
    )
    .await;
    assert_eq!(res.status(), 413);
}

#[tokio::test]
async fn viewers_and_no_download_sessions_can_preview() {
    let (base, _host) = mock_host().await;
    for (role, download) in [("view", true), ("edit", false), ("view", false)] {
        let (addr, ticket) = session(&base, role, download).await;
        let res = fetch(&addr, &ticket, &format!("{}/assets/doc.pdf", origin(&base))).await;
        assert_eq!(res.status(), 200, "{role} download={download}");
        // Preview only: never offered as a download from here.
        assert_eq!(res.headers()["content-disposition"], "inline");
        // The download permission still reaches the editor, which hides its Download action.
        let s: Value = http()
            .get(format!("http://{addr}/v1/sessions/{ticket}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(s["perms"]["download"], download);
    }
}

#[tokio::test]
async fn a_bad_ticket_gets_nothing() {
    let (base, host) = mock_host().await;
    let (addr, _ticket) = session(&base, "edit", true).await;
    let res = fetch(&addr, "nope", &format!("{}/assets/doc.pdf", origin(&base))).await;
    assert_eq!(res.status(), 401);
    assert!(host.lock().unwrap().asset_gets.is_empty());
}
