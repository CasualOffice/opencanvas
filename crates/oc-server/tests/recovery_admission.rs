// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! RLB-01b recovery admission. While rooms are recovering after a restart, launches and
//! WebSocket upgrades are answered 503 with a jittered `Retry-After`, never a 500, and the
//! browser's launch form gets a "Reconnecting…" page that posts the same form again. One test
//! per process: `OC_ROOM_LOAD_QUEUE=-1` forces the recovering state for this binary.

mod common;

use common::*;
use jsonwebtoken::{EncodingKey, Header, encode};
use serde_json::json;

fn token() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let claims = json!({
        "iss": "sample", "aud": "opencanvas", "exp": now + 600, "jti": ulid::Ulid::new().to_string(),
        "file": {"id": FILE, "name": "Doc one", "version": "0"},
        "user": {"id": "u_1", "name": "Asha Rao"}, "role": "edit", "callbackToken": "cb-u_1"
    });
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}

fn retry_after(res: &reqwest::Response) -> u64 {
    res.headers()
        .get("retry-after")
        .expect("Retry-After")
        .to_str()
        .unwrap()
        .parse()
        .unwrap()
}

#[tokio::test]
async fn while_rooms_recover_launches_and_upgrades_get_503_with_retry_after() {
    // SAFETY: set before the server reads it, in the only test of this binary.
    unsafe { std::env::set_var("OC_ROOM_LOAD_QUEUE", "-1") };
    let (base, _host) = mock_host().await;
    let addr = serve_state(app(&base, room_cfg()).await).await;
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let tok = token();
    // The browser's form post: a page that says Reconnecting… and posts the same form again.
    let res = http
        .post(format!("http://{addr}/v1/launch?block=b_1"))
        .form(&[("token", tok.as_str())])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 503);
    assert!((1..=5).contains(&retry_after(&res)));
    let html = res.text().await.unwrap();
    assert!(html.contains("Reconnecting"), "{html}");
    assert!(
        html.contains(&format!(r#"name="token" value="{tok}""#)),
        "{html}"
    );
    assert!(html.contains(r#"action="launch?block=b_1""#), "{html}");
    // The editor's JSON renewal: 503 BUSY, Retry-After.
    let res = http
        .post(format!("http://{addr}/v1/launch"))
        .header("accept", "application/json")
        .form(&[("token", tok.as_str())])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 503);
    assert!((1..=5).contains(&retry_after(&res)));
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["error"]["code"], "BUSY");
    // A WebSocket upgrade: refused before the upgrade with Retry-After.
    let res = http
        .get(format!("http://{addr}/v1/collab/r_x?ticket=t"))
        .header("connection", "upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 503);
    assert!((1..=5).contains(&retry_after(&res)));
}
