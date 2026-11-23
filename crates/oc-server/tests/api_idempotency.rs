// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `Idempotency-Key` on `POST /api/v1/files/…` (docs/27 §4.2, HAPI-03). Time moves through the
//! server clock, never by sleeping.
mod common;

use common::*;
use oc_server::grant::Role;
use serde_json::{Value, json};

fn api_on(h: &mut oc_server::hosts::HostConfig) {
    h.api_key = Some("k".into());
    h.flags.insert("api_v1".into(), toml::Value::Boolean(true));
}

async fn batch(
    addr: &str,
    key: &str,
    author: &str,
    text: &str,
) -> (u16, reqwest::header::HeaderMap, Value) {
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/api/v1/files/{FILE}/blocks:batch"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", "k")
        .header("X-OpenCanvas-Author", author)
        .header("Idempotency-Key", key)
        .json(&json!({"ops": [{"op": "append", "markdown": text}]}))
        .send()
        .await
        .unwrap();
    let s = res.status().as_u16();
    let h = res.headers().clone();
    (s, h, res.json().await.unwrap_or(Value::Null))
}

fn count(doc: &Value, text: &str) -> usize {
    doc.to_string().matches(text).count()
}

#[tokio::test]
async fn a_key_applies_once_replays_and_refuses_another_body() {
    let (base, _h) = mock_host().await;
    let state = app_custom(&base, room_cfg(), &temp_db(), api_on).await;
    state.clock.set_ms(1_800_000_000_000);
    let addr = serve_state(state.clone()).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;

    let (s, h, first) = batch(&addr, "k-1", "bot", "Once only").await;
    assert_eq!(s, 200, "{first}");
    assert!(h.get("idempotency-replayed").is_none());
    let (s, h, again) = batch(&addr, "k-1", "bot", "Once only").await;
    assert_eq!(s, 200, "{again}");
    assert_eq!(h["idempotency-replayed"], "true");
    assert_eq!(again, first);
    a.settle().await;
    assert_eq!(count(&json_of(&a.doc), "Once only"), 1);

    let (s, _, v) = batch(&addr, "k-1", "bot", "Other body").await;
    assert_eq!(
        (s, v["code"].as_str()),
        (422, Some("IDEMPOTENCY_KEY_REUSED")),
        "{v}"
    );
    // Keys are per subject: another author's k-1 is another key.
    let (s, h, _) = batch(&addr, "k-1", "bot-2", "Other body").await;
    assert_eq!(s, 200);
    assert!(h.get("idempotency-replayed").is_none());
    // After 24 h the key is free again.
    state.clock.advance_ms(24 * 3600 * 1000 + 1000);
    let (s, h, _) = batch(&addr, "k-1", "bot", "Next day").await;
    assert_eq!(s, 200);
    assert!(h.get("idempotency-replayed").is_none());
    // A bad key is refused.
    let (s, _, v) = batch(&addr, "", "bot", "x").await;
    assert_eq!(
        (s, v["code"].as_str()),
        (400, Some("IDEMPOTENCY_KEY_INVALID")),
        "{v}"
    );
}

#[tokio::test]
async fn concurrent_duplicates_apply_once_and_failures_free_the_key() {
    let (base, _h) = mock_host().await;
    let state = app_custom(&base, room_cfg(), &temp_db(), api_on).await;
    let addr = serve_state(state.clone()).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;

    let all =
        futures::future::join_all((0..8).map(|_| batch(&addr, "k-c", "bot", "Concurrent"))).await;
    let fresh = all
        .iter()
        .filter(|(s, h, _)| *s == 200 && h.get("idempotency-replayed").is_none())
        .count();
    assert_eq!(
        fresh,
        1,
        "{:?}",
        all.iter().map(|x| x.0).collect::<Vec<_>>()
    );
    for (s, h, v) in &all {
        assert!(
            *s == 200
                || (*s == 409 && v["code"] == "IDEMPOTENCY_IN_PROGRESS" && h["retry-after"] == "1"),
            "{s} {v}"
        );
    }
    a.settle().await;
    assert_eq!(count(&json_of(&a.doc), "Concurrent"), 1);

    // A failed request is not stored: the retry runs again.
    let fail = || async {
        reqwest::Client::new()
            .post(format!("http://{addr}/api/v1/files/{FILE}/blocks:batch"))
            .header("X-OpenCanvas-Host", "sample")
            .header("X-OpenCanvas-Key", "k")
            .header("Idempotency-Key", "k-f")
            .json(&json!({"ops": [{"op": "delete", "blockId": "b_missing"}]}))
            .send()
            .await
            .unwrap()
    };
    for _ in 0..2 {
        let r = fail().await;
        assert_eq!(r.status(), 404);
        assert!(r.headers().get("idempotency-replayed").is_none());
    }
}
