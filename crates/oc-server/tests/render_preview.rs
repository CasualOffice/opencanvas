// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! RND-01: `GET /v1/preview?ticket=` renders the room's current state as static HTML in the
//! editor's markup, for every role, never for a bad ticket, never with comment threads, and
//! cached per room version.
mod common;

use std::time::Duration;

use common::*;
use jsonwebtoken::{EncodingKey, Header, encode};
use oc_server::SharedState;
use oc_server::grant::Role;
use serde_json::json;

const API_KEY: &str = "preview-test-api-key";

fn token(role: &str, user: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let claims = json!({
        "iss": "sample", "aud": "opencanvas", "exp": now + 600, "jti": ulid::Ulid::new().to_string(),
        "file": {"id": FILE, "name": "Doc one", "version": "0"},
        "user": {"id": user, "name": "Asha Rao", "email": "asha@example.com"},
        "role": role, "perms": {"export": false, "download": false, "comment": true},
        "callbackToken": format!("cb-{user}")
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

async fn launch(addr: &str, role: &str, user: &str) -> String {
    let res = http()
        .post(format!("http://{addr}/v1/launch"))
        .form(&[("token", token(role, user))])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 303, "{:?}", res.text().await);
    res.headers()["location"]
        .to_str()
        .unwrap()
        .trim_start_matches("/app/#t=")
        .to_string()
}

async fn get(addr: &str, ticket: &str, etag: Option<&str>) -> reqwest::Response {
    let mut req = http()
        .get(format!("http://{addr}/v1/preview"))
        .query(&[("ticket", ticket)]);
    if let Some(e) = etag {
        req = req.header("if-none-match", e);
    }
    req.send().await.unwrap()
}

/// A canvas with a heading, a commented paragraph, a task, a database and a board.
fn content() -> serde_json::Value {
    json!({
        "meta": {"title": "Launch plan", "tone": "green"},
        "comments": {"th_secret": {"anchor": "x", "resolved": false,
            "messages": [{"id": "m1", "author": "u_2", "body": "private reviewer remark", "at": 1}]}},
        "databases": {"d1": {"name": "Tasks", "fields": [{"id": "f1", "name": "Name"}, {"id": "f2", "name": "Status"}],
            "order": ["r1"], "rows": {"r1": {"f1": "Ship preview", "f2": "Doing"}}}},
        "boards": {"b1": {"order": ["s1"], "shapes": {"s1": {"type": "sticky", "x": 0, "y": 0, "w": 150, "h": 110, "text": "Sticky idea"}}}},
        "content": [
            {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Goals"}]},
            {"type": "paragraph", "content": [
                {"type": "text", "text": "Ship the preview", "marks": [{"type": "commentMark", "attrs": {"threadId": "th_secret"}}]},
                {"type": "text", "text": " to "},
                {"type": "mention", "attrs": {"id": "u_1", "label": "Asha Rao", "email": "asha@example.com"}}
            ]},
            {"type": "taskList", "content": [{"type": "taskItem", "attrs": {"checked": false},
                "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Measure CLS"}]}]}]},
            {"type": "database", "attrs": {"dbId": "d1"}},
            {"type": "board", "attrs": {"boardId": "b1"}}
        ]
    })
}

async fn seeded(state: &SharedState) -> Peer {
    let mut a = Peer::join(state, grant("u_seed", Role::Edit)).await;
    a.settle().await;
    let v = content();
    a.edit(|d| oc_model::import::apply_document_json(d, &v));
    a.settle().await;
    a
}

#[tokio::test]
async fn every_role_sees_the_canvas_in_the_editor_markup() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let _seed = seeded(&state).await;
    let addr = serve_state(state).await;
    for role in ["view", "comment", "edit"] {
        let t = launch(&addr, role, "u_1").await;
        let res = get(&addr, &t, None).await;
        assert_eq!(res.status(), 200, "{role}");
        let h = res.headers().clone();
        assert_eq!(h["content-type"], "text/html; charset=utf-8");
        assert_eq!(h["cache-control"], "private, no-cache");
        assert!(
            h["content-security-policy"]
                .to_str()
                .unwrap()
                .starts_with("sandbox")
        );
        assert!(h.contains_key("etag"));
        let body = res.text().await.unwrap();
        assert!(body.contains(&format!("data-role=\"{role}\"")), "{body}");
        assert!(
            body.contains("<h1 class=\"dtitle\">Launch plan</h1>"),
            "{body}"
        );
        assert!(
            body.contains("<span class=\"cname\">Launch plan</span>"),
            "{body}"
        );
        assert!(body.contains("<h2>Goals</h2>"), "{body}");
        assert!(body.contains("Ship the preview"), "{body}");
        assert!(body.contains("<ul data-type=\"taskList\">"), "{body}");
        assert!(
            body.contains("<td>Ship preview</td>"),
            "database as a table: {body}"
        );
        assert!(body.contains(">Sticky idea</text>"), "board as SVG: {body}");
        // The banner the editor shows for the role, so the takeover does not shift content.
        match role {
            "view" => {
                assert!(body.contains("class=\"app oc-root ro\""), "{body}");
                assert!(body.contains("You can view this canvas. Ask in Sample for edit access."));
            }
            "comment" => {
                assert!(body.contains("class=\"app oc-root ro\""), "{body}");
                assert!(body.contains("You can comment. Select text to start a thread."));
            }
            _ => {
                assert!(body.contains("class=\"app oc-root\""), "{body}");
                assert!(!body.contains("class=\"banner"), "{body}");
            }
        }
        // Threads, anchors and e-mail addresses never reach any role.
        for leak in [
            "th_secret",
            "private reviewer remark",
            "commentMark",
            "asha@example.com",
        ] {
            assert!(!body.contains(leak), "{leak} leaked to {role}: {body}");
        }
    }
}

#[tokio::test]
async fn no_preview_without_a_valid_ticket() {
    let (base, _host) = mock_host().await;
    let state = app_custom(&base, room_cfg(), &temp_db(), |h| {
        h.api_key = Some(API_KEY.into())
    })
    .await;
    let _seed = seeded(&state).await;
    let addr = serve_state(state).await;
    for bad in ["", "nope", &"x".repeat(80)] {
        let res = get(&addr, bad, None).await;
        assert_eq!(res.status(), 401, "{bad:?}");
        assert!(!res.text().await.unwrap().contains("Goals"));
    }
    // A revoked user's ticket stops working at once.
    let t = launch(&addr, "view", "u_gone").await;
    assert_eq!(get(&addr, &t, None).await.status(), 200);
    let res = http()
        .post(format!("http://{addr}/v1/files/{FILE}/role"))
        .header("x-opencanvas-host", "sample")
        .header("x-opencanvas-key", API_KEY)
        .json(&json!({"userId": "u_gone", "role": "none"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let res = get(&addr, &t, None).await;
    assert_eq!(res.status(), 401);
    assert!(!res.text().await.unwrap().contains("Goals"));
}

#[tokio::test]
async fn cached_per_room_version_and_refreshed_by_an_edit() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let mut seed = seeded(&state).await;
    let addr = serve_state(state.clone()).await;
    let view = launch(&addr, "view", "u_1").await;
    let edit = launch(&addr, "edit", "u_2").await;

    let first = get(&addr, &view, None).await;
    let etag = first.headers()["etag"].to_str().unwrap().to_string();
    assert!(first.text().await.unwrap().contains("Goals"));
    assert_eq!(state.previews.renders(), 1);
    // Same version: served from the cache, for any role; a matching ETag gets 304.
    assert!(
        get(&addr, &edit, None)
            .await
            .text()
            .await
            .unwrap()
            .contains("Goals")
    );
    assert_eq!(state.previews.renders(), 1);
    let again = get(&addr, &view, Some(&etag)).await;
    assert_eq!(again.status(), 304);
    assert_eq!(again.text().await.unwrap(), "");
    // Another role's shell differs, so its ETag does too.
    let edit_tag = get(&addr, &edit, None).await.headers()["etag"].clone();
    assert_ne!(edit_tag.to_str().unwrap(), etag);

    // An edit changes the version: the next preview shows it.
    seed.edit(|d| {
        let mut v = content();
        v["content"][0]["content"][0]["text"] = json!("Revised goals");
        oc_model::import::apply_document_json(d, &v)
    });
    seed.settle().await;
    let res = get(&addr, &view, Some(&etag)).await;
    assert_eq!(res.status(), 200);
    assert_ne!(res.headers()["etag"].to_str().unwrap(), etag);
    let body = res.text().await.unwrap();
    assert!(body.contains("<h2>Revised goals</h2>"), "{body}");
    assert_eq!(state.previews.renders(), 2);
}

#[tokio::test]
async fn ephemeral_rooms_preview_their_live_state() {
    let state = app_full(
        "",
        room_cfg(),
        &temp_db(),
        |h| h.storage = "ephemeral".into(),
        |_| {},
    )
    .await;
    let addr = serve_state(state.clone()).await;
    let t = launch(&addr, "view", "u_1").await;
    let res = get(&addr, &t, None).await;
    assert_eq!(res.status(), 200);
    assert!(
        res.text()
            .await
            .unwrap()
            .contains("class=\"ProseMirror oc-pv-content\"")
    );
    let _seed = seeded(&state).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let body = get(&addr, &t, None).await.text().await.unwrap();
    assert!(body.contains("<h2>Goals</h2>"), "{body}");
}
