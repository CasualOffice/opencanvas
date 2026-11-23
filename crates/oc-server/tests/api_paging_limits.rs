// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! HAPI-04: signed cursors over Yjs relative positions, and one rate limiter for the API and
//! MCP with `RateLimit` headers. Time moves through the server clock, never by sleeping.
mod common;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use common::*;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use oc_server::grant::Role;
use serde_json::{Value, json};

const PUBLIC: &str = "https://oc.example";

fn api_on(h: &mut oc_server::hosts::HostConfig) {
    h.api_key = Some("k".into());
    h.flags.insert("api_v1".into(), toml::Value::Boolean(true));
    h.api
        .insert("audience".into(), toml::Value::String(PUBLIC.into()));
}

fn roomy(h: &mut oc_server::hosts::HostConfig) {
    api_on(h);
    h.api
        .insert("rate_per_sec".into(), toml::Value::Integer(10_000));
    h.api
        .insert("file_writes_per_sec".into(), toml::Value::Integer(10_000));
}

fn tight(h: &mut oc_server::hosts::HostConfig) {
    api_on(h);
    h.api.insert("rate_per_sec".into(), toml::Value::Integer(1));
    h.api.insert("burst".into(), toml::Value::Integer(3));
    h.api
        .insert("file_writes_per_sec".into(), toml::Value::Integer(1));
    h.api.insert("file_burst".into(), toml::Value::Integer(2));
    h.ai.insert("mcp".into(), toml::Value::Boolean(true));
    h.ai.insert("mcp_audience".into(), toml::Value::String(PUBLIC.into()));
}

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn send(rb: reqwest::RequestBuilder) -> (u16, reqwest::header::HeaderMap, Value) {
    let res = rb.send().await.unwrap();
    let s = res.status().as_u16();
    let h = res.headers().clone();
    (s, h, res.json().await.unwrap_or(Value::Null))
}

fn get(addr: &str, path: &str) -> reqwest::RequestBuilder {
    client()
        .get(format!("http://{addr}{path}"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", "k")
}

fn post(addr: &str, path: &str) -> reqwest::RequestBuilder {
    client()
        .post(format!("http://{addr}{path}"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", "k")
}

async fn batch(addr: &str, ops: Value) -> Value {
    let (s, _, v) = send(
        post(addr, &format!("/api/v1/files/{FILE}/blocks:batch"))
            .json(&json!({"ops": ops, "confirm": true})),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    v
}

async fn setup(
    tweak: fn(&mut oc_server::hosts::HostConfig),
) -> (String, oc_server::SharedState, Peer) {
    let (base, _h) = mock_host().await;
    let state = app_ai(&base, room_cfg(), &temp_db(), tweak).await;
    state.clock.set_ms(1_800_000_000_000);
    let addr = serve_state(state.clone()).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    (addr, state, a)
}

fn ids(page: &Value) -> Vec<String> {
    page["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["blockId"].as_str().unwrap().to_string())
        .collect()
}

/// docs/27 §4.3: page through 1,000 blocks while another client inserts and deletes; every
/// surviving block is returned once.
#[tokio::test]
async fn cursors_survive_concurrent_inserts_and_deletes() {
    let (addr, _state, _a) = setup(roomy).await;
    let md: Vec<String> = (0..1000).map(|i| format!("Block {i}")).collect();
    batch(
        &addr,
        json!([{"op": "append", "markdown": md.join("\n\n")}]),
    )
    .await;
    let (_, _, first) = send(get(&addr, &format!("/api/v1/files/{FILE}/blocks"))).await;
    let all: Vec<String> = {
        // Every id at the start, by paging without edits.
        let mut out = ids(&first);
        let mut cur = first["next_cursor"].as_str().map(str::to_string);
        while let Some(c) = cur {
            assert!(out.len() <= 1000, "paging does not end");
            let (_, _, p) = send(get(
                &addr,
                &format!("/api/v1/files/{FILE}/blocks?cursor={c}"),
            ))
            .await;
            out.extend(ids(&p));
            cur = p["next_cursor"].as_str().map(str::to_string);
        }
        out
    };
    assert_eq!(all.len(), 1000);

    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut deleted: HashSet<String> = HashSet::new();
    let (s, h, mut page) = send(get(
        &addr,
        &format!("/api/v1/files/{FILE}/blocks?limit=100"),
    ))
    .await;
    assert_eq!(s, 200);
    assert!(h["link"].to_str().unwrap().contains("rel=\"next\""));
    let mut round = 0;
    loop {
        let got = ids(&page);
        for id in &got {
            *seen.entry(id.clone()).or_default() += 1;
        }
        let Some(c) = page["next_cursor"].as_str().map(str::to_string) else {
            break;
        };
        assert!(round < 30, "paging does not end");
        // Between pages: delete the last block read (the cursor's anchor), the next unread one
        // and one already read; insert before and after the anchor.
        let last = got.last().unwrap().clone();
        let pos = all.iter().position(|x| *x == last).unwrap();
        let unread = all[pos + 1..]
            .iter()
            .find(|x| !deleted.contains(*x))
            .cloned();
        let read_one = all[..pos]
            .iter()
            .rev()
            .find(|x| !deleted.contains(*x))
            .cloned();
        let mut ops = vec![
            json!({"op": "insertAfter", "blockId": last, "markdown": format!("New after {round}")}),
            json!({"op": "insertAfter", "blockId": read_one.clone().unwrap_or(last.clone()), "markdown": format!("New early {round}")}),
            json!({"op": "delete", "blockId": last}),
        ];
        deleted.insert(last.clone());
        if let Some(u) = &unread {
            ops.push(json!({"op": "delete", "blockId": u}));
            deleted.insert(u.clone());
        }
        if let Some(r) = &read_one {
            ops.push(json!({"op": "delete", "blockId": r}));
            deleted.insert(r.clone());
        }
        batch(&addr, json!(ops)).await;
        let (s, _, p) = send(get(
            &addr,
            &format!("/api/v1/files/{FILE}/blocks?limit=100&cursor={c}"),
        ))
        .await;
        assert_eq!(s, 200, "{p}");
        page = p;
        round += 1;
    }
    assert!(round >= 9, "{round}");
    for id in &all {
        let n = seen.get(id).copied().unwrap_or(0);
        if deleted.contains(id) {
            assert!(n <= 1, "{id} seen {n} times");
        } else {
            assert_eq!(n, 1, "surviving block {id} seen {n} times");
        }
    }
    assert!(seen.values().all(|n| *n == 1), "no block twice");
}

#[tokio::test]
async fn cursors_are_signed_bound_and_expire() {
    let (addr, state, _a) = setup(roomy).await;
    let md: Vec<String> = (0..5).map(|i| format!("B{i}")).collect();
    batch(
        &addr,
        json!([{"op": "append", "markdown": md.join("\n\n")}]),
    )
    .await;
    let (_, _, p) = send(get(&addr, &format!("/api/v1/files/{FILE}/blocks?limit=2"))).await;
    let c = p["next_cursor"].as_str().unwrap().to_string();
    let (s, _, v) = send(get(
        &addr,
        &format!("/api/v1/files/other/blocks?cursor={c}"),
    ))
    .await;
    assert_eq!(
        (s, v["code"].as_str()),
        (400, Some("CURSOR_INVALID")),
        "{v}"
    );
    let tampered = format!("x{c}");
    let (s, _, v) = send(get(
        &addr,
        &format!("/api/v1/files/{FILE}/blocks?cursor={tampered}"),
    ))
    .await;
    assert_eq!(
        (s, v["code"].as_str()),
        (400, Some("CURSOR_INVALID")),
        "{v}"
    );
    state.clock.advance_ms(3601 * 1000);
    let (s, _, v) = send(get(
        &addr,
        &format!("/api/v1/files/{FILE}/blocks?cursor={c}"),
    ))
    .await;
    assert_eq!(
        (s, v["code"].as_str()),
        (410, Some("CURSOR_EXPIRED")),
        "{v}"
    );

    // Database rows: a row inserted before the anchor between pages does not shift the page.
    let (s, _, out) = send(
        post(&addr, &format!("/api/v1/files/{FILE}/databases")).json(&json!({
        "name": "T", "fields": [{"name": "Name", "type": "title"}],
        "rows": (0..7).map(|i| json!({"values": {"Name": format!("r{i}")}})).collect::<Vec<_>>()})),
    )
    .await;
    assert_eq!(s, 200, "{out}");
    let db = out["dbId"].as_str().unwrap().to_string();
    let rows_path = format!("/api/v1/files/{FILE}/databases/{db}/rows");
    let names = |p: &Value| -> Vec<String> {
        p["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                r["values"]
                    .as_object()
                    .unwrap()
                    .values()
                    .next()
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    };
    let (_, h, p1) = send(get(&addr, &format!("{rows_path}?limit=3"))).await;
    assert!(h["link"].to_str().unwrap().contains("rel=\"next\""));
    let mut got = names(&p1);
    let c1 = p1["next_cursor"].as_str().unwrap().to_string();
    let (s, _, v) = send(get(
        &addr,
        &format!("{rows_path}?limit=3&sort=%5B%5D&cursor={c1}"),
    ))
    .await;
    assert_eq!(
        (s, v["code"].as_str()),
        (400, Some("CURSOR_INVALID")),
        "another query: {v}"
    );
    let mut cur = Some(c1);
    while let Some(c) = cur {
        assert!(got.len() <= 7, "paging does not end");
        let (s, _, p) = send(get(&addr, &format!("{rows_path}?limit=3&cursor={c}"))).await;
        assert_eq!(s, 200, "{p}");
        got.extend(names(&p));
        cur = p["next_cursor"].as_str().map(str::to_string);
    }
    let want: Vec<String> = (0..7).map(|i| format!("r{i}")).collect();
    assert_eq!(got, want);
}

fn token(sub: &str, aud: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    encode(
        &Header::new(Algorithm::HS256),
        &json!({"iss": "sample", "aud": aud, "sub": sub, "exp": now + 600,
            "scope": "canvas:read canvas:write", "role": "edit", "files": [FILE]}),
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}

#[tokio::test]
async fn rate_limits_answer_headers_429_and_refill_by_the_clock() {
    let (addr, state, _a) = setup(tight).await;
    let read = || get(&addr, &format!("/api/v1/files/{FILE}"));
    for left in [2, 1, 0] {
        let (s, h, _) = send(read()).await;
        assert_eq!(s, 200);
        assert_eq!(h["ratelimit-policy"], "\"subject\";q=3;w=3");
        assert_eq!(
            h["ratelimit"].to_str().unwrap(),
            format!("\"subject\";r={left};t={}", 3 - left)
        );
    }
    let (s, h, v) = send(read()).await;
    assert_eq!((s, v["code"].as_str()), (429, Some("RATE_LIMITED")), "{v}");
    assert_eq!(h["retry-after"], "1");
    assert_eq!(h["content-type"], "application/problem+json");
    state.clock.advance_ms(1000);
    assert_eq!(send(read()).await.0, 200, "one token back after a second");
    assert_eq!(send(read()).await.0, 429);

    // Writes per file: two, then the file's bucket is empty (subject bucket refilled first).
    state.clock.advance_ms(10_000);
    let w =
        |f: &str| post(&addr, &format!("/api/v1/files/{f}/comments")).json(&json!({"text": "x"}));
    let (_, h, _) = send(w(FILE)).await;
    assert!(
        h["ratelimit-policy"]
            .to_str()
            .unwrap()
            .contains("\"file-writes\";q=2;w=2")
    );
    send(w(FILE)).await;
    let (s, _, v) = send(w(FILE)).await;
    assert_eq!(s, 429, "{v}");
    assert!(v["detail"].as_str().unwrap().contains("file-writes"), "{v}");
    // A second later the subject has one token again; doc_2's own bucket is full.
    state.clock.advance_ms(1000);
    let (s, _, _) = send(w("doc_2")).await;
    assert_ne!(s, 429, "another file has its own bucket");
}

#[tokio::test]
async fn mcp_and_the_api_share_the_subjects_bucket() {
    let (addr, _state, _a) = setup(tight).await;
    let api = token("u_shared", &format!("{PUBLIC}/api/v1"));
    for _ in 0..3 {
        let (s, _, v) = send(
            client()
                .get(format!("http://{addr}/api/v1/files/{FILE}"))
                .bearer_auth(&api),
        )
        .await;
        assert_eq!(s, 200, "{v}");
    }
    let mcp = token("u_shared", &format!("{PUBLIC}/mcp/sample"));
    let res = client()
        .post(format!("http://{addr}/mcp/sample"))
        .bearer_auth(&mcp)
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 429, "the API spent the bucket MCP draws from");
    // Another user is unaffected.
    let other = token("u_other", &format!("{PUBLIC}/mcp/sample"));
    let res = client()
        .post(format!("http://{addr}/mcp/sample"))
        .bearer_auth(&other)
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
}

/// In a cluster the buckets live in Redis: two nodes' limiters share one bucket. Runs when
/// `OC_TEST_REDIS_URL` is set.
#[tokio::test]
async fn redis_buckets_are_shared_between_nodes() {
    let Ok(url) = std::env::var("OC_TEST_REDIS_URL") else {
        eprintln!("OC_TEST_REDIS_URL not set: skipping the shared Redis limiter test");
        return;
    };
    let conn = || async {
        redis::Client::open(url.as_str())
            .unwrap()
            .get_connection_manager()
            .await
            .unwrap()
    };
    let clock = Arc::new(oc_server::clock::Clock::default());
    clock.set_ms(1_800_000_000_000);
    let n1 = oc_server::ratelimit::Limiter::new(clock.clone(), Some(conn().await));
    let n2 = oc_server::ratelimit::Limiter::new(clock.clone(), Some(conn().await));
    let p = oc_server::ratelimit::Policy {
        name: "subject",
        rate: 1.0,
        burst: 2.0,
    };
    let key = format!("test:{}", ulid::Ulid::new());
    assert!(n1.check(&key, p).await.ok);
    assert!(n2.check(&key, p).await.ok);
    assert!(!n1.check(&key, p).await.ok, "node 1 sees node 2's spend");
    assert!(!n2.check(&key, p).await.ok);
    clock.advance_ms(1000);
    assert!(n2.check(&key, p).await.ok);
}
