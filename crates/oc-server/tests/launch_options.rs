// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Host launch options from the Mattermost and Matrix prototypes (MM S2f, MX S5-S7b):
//! the `start` launch claim (ADR-048) and the `temporary_wording` host flag (ADR-049).

mod common;

use common::*;
use jsonwebtoken::{EncodingKey, Header, encode};
use oc_server::hosts::Hosts;
use serde_json::{Value, json};

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn token(extra: Value) -> String {
    let mut claims = json!({
        "iss": "sample", "aud": "opencanvas", "exp": now() + 600, "jti": ulid::Ulid::new().to_string(),
        "file": {"id": FILE, "name": "Doc one", "version": "0"},
        "user": {"id": "u_1", "name": "Asha Rao"},
        "role": "edit", "perms": {"export": true, "download": true, "comment": true},
        "callbackToken": "cb-u_1"
    });
    for (k, v) in extra.as_object().unwrap() {
        claims[k] = v.clone();
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

async fn location(addr: &str, tok: String) -> String {
    let res = http()
        .post(format!("http://{addr}/v1/launch"))
        .form(&[("token", tok)])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 303);
    res.headers()["location"].to_str().unwrap().to_string()
}

async fn session(addr: &str, ticket: &str) -> (u16, Value) {
    let res = http()
        .get(format!("http://{addr}/v1/sessions/{ticket}"))
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

/// ADR-048 (MM S2f): `"start": "page"` in the launch token opens a new canvas straight into
/// the page. It travels in the app fragment next to the ticket; other values are ignored.
#[tokio::test]
async fn start_page_claim_travels_in_the_fragment() {
    let (base, _host) = mock_host().await;
    let addr = serve_state(app(&base, room_cfg()).await).await;

    let loc = location(&addr, token(json!({"start": "page"}))).await;
    assert!(
        loc.starts_with("/app/#t=") && loc.ends_with("&start=page"),
        "{loc}"
    );
    let ticket = loc
        .strip_prefix("/app/#t=")
        .unwrap()
        .strip_suffix("&start=page")
        .unwrap();
    assert_eq!(session(&addr, ticket).await.0, 200);

    // Absent or any other value: unchanged, no suffix.
    for extra in [
        json!({}),
        json!({"start": "templates"}),
        json!({"start": "x&t=evil"}),
    ] {
        let loc = location(&addr, token(extra)).await;
        assert!(!loc.contains("start="), "{loc}");
        assert!(!loc.contains("evil"), "{loc}");
    }

    // The JSON answer used for token renewal (ADR-036) carries the bare ticket.
    let res = http()
        .post(format!("http://{addr}/v1/launch"))
        .header("accept", "application/json")
        .form(&[("token", token(json!({"start": "page"})))])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let ticket = res.json::<Value>().await.unwrap()["ticket"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(!ticket.contains('&'), "{ticket}");
    assert_eq!(session(&addr, &ticket).await.0, 200);

    // It composes with `block`.
    let res = http()
        .post(format!("http://{addr}/v1/launch"))
        .form(&[
            ("token", token(json!({"start": "page"})).as_str()),
            ("block", "b_1"),
        ])
        .send()
        .await
        .unwrap();
    let loc = res.headers()["location"].to_str().unwrap();
    assert!(
        loc.contains("&start=page") && loc.ends_with("&block=b_1"),
        "{loc}"
    );
}

/// ADR-049 (MX S5-S7b): `[host.flags] temporary_wording` picks the editor's wording for a
/// temporary canvas. Meeting wording stays the default (Jitsi); Matrix sets "room".
#[tokio::test]
async fn temporary_wording_defaults_to_meeting_and_a_host_can_choose_room() {
    for (flag, want) in [
        (None, "meeting"),
        (Some("room"), "room"),
        (Some("meeting"), "meeting"),
    ] {
        let (base, _host) = mock_host().await;
        let state = app_custom(&base, room_cfg(), &temp_db(), |h| {
            h.storage = "ephemeral".into();
            if let Some(f) = flag {
                h.flags
                    .insert("temporary_wording".into(), toml::Value::String(f.into()));
            }
        })
        .await;
        let addr = serve_state(state).await;
        let loc = location(&addr, token(json!({}))).await;
        let ticket = loc.strip_prefix("/app/#t=").unwrap();
        let (status, s) = session(&addr, ticket).await;
        assert_eq!(status, 200);
        assert_eq!(s["storage"], "ephemeral");
        assert_eq!(s["wording"], want, "flag {flag:?}");
    }
}

#[test]
fn temporary_wording_takes_meeting_or_room() {
    let src = |extra: &str| {
        format!(
            "[[host]]\nid = \"m\"\nname = \"Matrix\"\njwt_secret = \"0123456789abcdef0123456789abcdef\"\nstorage = \"ephemeral\"\n[host.flags]\n{extra}\n"
        )
    };
    assert!(Hosts::parse(&src("temporary_wording = \"room\""), None).is_ok());
    assert!(Hosts::parse(&src("temporary_wording = \"meeting\""), None).is_ok());
    assert!(Hosts::parse(&src(""), None).is_ok());
    assert!(Hosts::parse(&src("temporary_wording = \"chat\""), None).is_err());
    assert!(Hosts::parse(&src("temporary_wording = true"), None).is_err());
}
