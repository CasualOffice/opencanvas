// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Search across canvases (SRCH-02/03, ADR-065, docs/34 §4.3-4.5): `search.json` in every
//! save, stateless `POST /api/v1/extract`, the host's `GET /search` behind `GET /api/v1/search`,
//! MCP `canvas_search` and the editor route; OpenCanvas stores no text (byte search).
mod common;

use common::*;
use oc_server::grant::Role;
use serde_json::{Value, json};

const PUBLIC: &str = "https://oc.example";
const KEY: &str = "search-key";

fn on(h: &mut oc_server::hosts::HostConfig) {
    h.api_key = Some(KEY.into());
    h.flags.insert("api_v1".into(), toml::Value::Boolean(true));
    h.api
        .insert("audience".into(), toml::Value::String(PUBLIC.into()));
    h.api
        .insert("rate_per_sec".into(), toml::Value::Integer(100_000));
    h.api.insert("burst".into(), toml::Value::Integer(100_000));
    h.ai.insert("mcp".into(), toml::Value::Boolean(true));
    h.ai.insert("mcp_audience".into(), toml::Value::String(PUBLIC.into()));
    h.search
        .insert("callback".into(), toml::Value::Boolean(true));
    h.search
        .insert("timeout_ms".into(), toml::Value::Integer(1000));
}

fn now() -> i64 {
    oc_server::util::now_secs()
}

fn sign(c: &Value) -> String {
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        c,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()).unwrap(),
    )
    .unwrap()
}

fn api_token(sub: &str) -> String {
    sign(
        &json!({"iss": "sample", "aud": format!("{PUBLIC}/api/v1"), "sub": sub, "name": "Asha",
        "exp": now() + 600, "scope": "canvas:read", "role": "view", "files": [FILE]}),
    )
}

fn mcp_token(sub: &str) -> String {
    sign(
        &json!({"iss": "sample", "aud": format!("{PUBLIC}/mcp/sample"), "sub": sub,
        "name": "Asha", "exp": now() + 600, "scope": "canvas:read", "role": "view",
        "files": [FILE], "client_id": "t"}),
    )
}

async fn serve(
    tweak: impl FnOnce(&mut oc_server::hosts::HostConfig),
) -> (String, oc_server::SharedState, Shared, std::path::PathBuf) {
    let (base, host) = mock_host().await;
    let db = temp_db();
    let state = app_ai(&base, room_cfg(), &db, tweak).await;
    (serve_state(state.clone()).await, state, host, db)
}

fn http() -> reqwest::Client {
    reqwest::Client::new()
}

async fn host_key(
    addr: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let mut r = http()
        .request(method, format!("http://{addr}{path}"))
        .header("x-opencanvas-host", "sample")
        .header("x-opencanvas-key", KEY);
    if let Some(b) = body {
        r = r.json(&b);
    }
    let res = r.send().await.unwrap();
    let s = res.status().as_u16();
    (s, res.json().await.unwrap_or(Value::Null))
}

fn hits() -> Value {
    json!({"results": [
        {"fileId": FILE, "title": "Sprint 42 planning", "path": "Engineering", "blockId": "b_1",
         "snippet": "Admins can sign in with <SSO>", "updatedAt": "2026-11-26T09:41:00Z", "rank": 3},
        {"fileId": "doc_hidden", "title": "Secret", "snippet": "SSO in a file Asha cannot open"}
    ], "scopes": [{"id": "all", "label": "All canvases"}], "partial": true, "next": "p2"})
}

/// SRCH-A3: every save carries `search.json`, with the canvas text and block ids, no comment
/// text unless the host asks, and no in-file history.
#[tokio::test]
async fn every_save_carries_search_json_without_comments() {
    let (addr, st, host, _db) = serve(on).await;
    let mut a = Peer::join(&st, grant("u_a", Role::Edit)).await;
    let (s, v) = host_key(
        &addr,
        reqwest::Method::POST,
        &format!("/api/v1/files/{FILE}/blocks:batch"),
        Some(json!({"mode": "direct", "ops": [{"op": "append", "markdown": "# Release 4.2\n\nAdmins can sign in with SSO\n\n- [ ] SSO set-up docs updated"}]})),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    let (s, v) = host_key(
        &addr,
        reqwest::Method::POST,
        &format!("/api/v1/files/{FILE}/comments"),
        Some(json!({"text": "private remark about SSO", "quote": "Admins"})),
    )
    .await;
    assert!(s == 200 || s == 201, "{s} {v}");
    let (s, v) = host_key(
        &addr,
        reqwest::Method::POST,
        &format!("/api/v1/files/{FILE}/commit"),
        None,
    )
    .await;
    assert_eq!(s, 200, "{v}");
    a.settle().await;
    wait_until(|| !host.lock().unwrap().puts.is_empty()).await;
    let body = host.lock().unwrap().puts.last().unwrap().body.clone();
    let sj = oc_model::search::read_entry(&body).expect("search.json in the save");
    assert_eq!(sj["v"], 1);
    let blocks = sj["blocks"].as_array().unwrap();
    let para = blocks
        .iter()
        .find(|b| b["text"] == "Admins can sign in with SSO")
        .expect("paragraph");
    assert_eq!(para["path"], json!(["Release 4.2"]));
    assert!(
        para["id"].as_str().is_some_and(|i| i.starts_with("b_")),
        "{para}"
    );
    let todo = blocks.iter().find(|b| b["type"] == "todo").unwrap();
    assert_eq!(todo["done"], false);
    let text = serde_json::to_string(&sj).unwrap();
    assert!(
        !text.contains("private remark"),
        "comments are left out by default"
    );
    assert!(sj.get("comments").is_none());
    assert!(!text.contains("history"));
    // A 0.2 reader (read_ocanvas) still opens the file.
    oc_model::read_ocanvas(&body).unwrap();
}

#[tokio::test]
async fn comments_are_in_search_json_when_the_host_asks() {
    let (addr, st, host, _db) = serve(|h| {
        on(h);
        h.search
            .insert("comments".into(), toml::Value::Boolean(true));
    })
    .await;
    let _a = Peer::join(&st, grant("u_a", Role::Edit)).await;
    host_key(
        &addr,
        reqwest::Method::POST,
        &format!("/api/v1/files/{FILE}/blocks:batch"),
        Some(json!({"mode": "direct", "ops": [{"op": "append", "markdown": "Admins"}]})),
    )
    .await;
    let (s, v) = host_key(
        &addr,
        reqwest::Method::POST,
        &format!("/api/v1/files/{FILE}/comments"),
        Some(json!({"text": "remark about SSO", "quote": "Admins"})),
    )
    .await;
    assert!(s == 200 || s == 201, "{s} {v}");
    host_key(
        &addr,
        reqwest::Method::POST,
        &format!("/api/v1/files/{FILE}/commit"),
        None,
    )
    .await;
    wait_until(|| !host.lock().unwrap().puts.is_empty()).await;
    let body = host.lock().unwrap().puts.last().unwrap().body.clone();
    let sj = oc_model::search::read_entry(&body).unwrap();
    assert!(
        serde_json::to_string(&sj["comments"])
            .unwrap()
            .contains("remark about SSO"),
        "{sj}"
    );
}

/// `POST /api/v1/extract`: the same JSON as in the save, statelessly; 415, 422 and 401.
#[tokio::test]
async fn extract_answers_search_json_and_stores_nothing() {
    let (addr, _st, _host, db) = serve(on).await;
    let doc = oc_model::new_doc();
    oc_model::import::apply_markdown(&doc, "# Zebra heading\n\nquokka-unique-marker text");
    let bytes = oc_model::write_ocanvas(&doc, &Default::default()).unwrap();
    let want = oc_model::search::read_entry(&bytes).unwrap();
    let post = |ct: &'static str, body: Vec<u8>, key: bool| {
        let mut r = http()
            .post(format!("http://{addr}/api/v1/extract"))
            .header("content-type", ct)
            .body(body);
        if key {
            r = r
                .header("x-opencanvas-host", "sample")
                .header("x-opencanvas-key", KEY);
        }
        r.send()
    };
    let res = post("application/vnd.opencanvas+zip", bytes.clone(), true)
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.json::<Value>().await.unwrap(), want);
    // A user token with canvas:read may extract too.
    let res = http()
        .post(format!("http://{addr}/api/v1/extract"))
        .bearer_auth(api_token("u_1"))
        .header("content-type", "text/markdown")
        .body("# Hello\n\nworld")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let v: Value = res.json().await.unwrap();
    assert_eq!(v["blocks"][1]["text"], "world");
    let res = post(
        "application/vnd.opencanvas+zip",
        b"not a zip".to_vec(),
        true,
    )
    .await
    .unwrap();
    assert_eq!(res.status(), 422);
    let p: Value = res.json().await.unwrap();
    assert_eq!(p["code"], "NOT_OCANVAS", "{p}");
    let res = post("image/png", vec![1, 2, 3], true).await.unwrap();
    assert_eq!(res.status(), 415);
    let res = post("application/vnd.opencanvas+zip", bytes, false)
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    // SRCH-A6: the database holds no text after extraction (byte search).
    assert_no_text(&db, &["quokka-unique-marker", "Zebra heading"]);
}

fn assert_no_text(db: &std::path::Path, needles: &[&str]) {
    for path in [
        db.to_path_buf(),
        db.with_extension("db-wal"),
        std::path::PathBuf::from(format!("{}-wal", db.display())),
    ] {
        if let Ok(bytes) = std::fs::read(&path) {
            for n in needles {
                assert!(
                    !bytes.windows(n.len()).any(|w| w == n.as_bytes()),
                    "{n:?} found in {}",
                    path.display()
                );
            }
        }
    }
}

/// SRCH-A5: the API proxies the host's callback for a user token, signed, with the user id;
/// a host key is refused; hits the host's `/access` refuses are dropped; MCP answers the same.
#[tokio::test]
async fn api_search_proxies_the_host_and_matches_mcp() {
    let (addr, st, host, db) = serve(on).await;
    {
        let mut h = host.lock().unwrap();
        h.search = Some(hits());
        h.access = Some([("u_1".to_string(), "view".to_string())].into());
    }
    // The mock's /access answers by user only; the hidden file is refused for everyone else.
    let (s, v) = host_key(&addr, reqwest::Method::GET, "/api/v1/search?q=SSO", None).await;
    assert_eq!(s, 400);
    assert_eq!(v["code"], "USER_TOKEN_REQUIRED", "{v}");
    assert!(host.lock().unwrap().search_calls.is_empty());

    let res = http()
        .get(format!(
            "http://{addr}/api/v1/search?q=SSO%20rollout&limit=5"
        ))
        .bearer_auth(api_token("u_1"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let api: Value = res.json().await.unwrap();
    assert_eq!(api["items"].as_array().unwrap().len(), 2, "{api}");
    assert_eq!(api["items"][0]["blockId"], "b_1");
    assert_eq!(api["items"][0]["snippet"], "Admins can sign in with <SSO>");
    assert!(api["items"][0].get("rank").is_none());
    assert_eq!(api["partial"], true);
    assert_eq!(api["next"], "p2");
    {
        let h = host.lock().unwrap();
        let (pq, sig_ok, _bearer) = h.search_calls.last().unwrap();
        assert!(sig_ok, "the search callback is signed (v2)");
        assert!(pq.starts_with("/api/search?q=SSO+rollout"), "{pq}");
        assert!(pq.contains("limit=5") && pq.contains("userId=u_1"), "{pq}");
    }
    // MCP canvas_search: the same items (ADR-041 parity).
    let res = http()
        .post(format!("http://{addr}/mcp/sample"))
        .bearer_auth(mcp_token("u_1"))
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "canvas_search", "arguments": {"q": "SSO rollout", "limit": 5}}}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let mcp: Value = res.json().await.unwrap();
    assert_eq!(mcp["result"]["structuredContent"], api, "{mcp}");
    // tools/list offers it.
    let res = http()
        .post(format!("http://{addr}/mcp/sample"))
        .bearer_auth(mcp_token("u_1"))
        .json(&json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))
        .send()
        .await
        .unwrap();
    let list: Value = res.json().await.unwrap();
    assert!(
        list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "canvas_search")
    );
    // A person the host's /access refuses gets no hits at all.
    let res = http()
        .get(format!("http://{addr}/api/v1/search?q=SSO"))
        .bearer_auth(api_token("u_other"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let v: Value = res.json().await.unwrap();
    assert_eq!(v["items"], json!([]), "{v}");
    // Bad queries.
    let res = http()
        .get(format!("http://{addr}/api/v1/search?q=",))
        .bearer_auth(api_token("u_1"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    // SRCH-A6: nothing of the answers is in the database.
    drop(st);
    assert_no_text(
        &db,
        &["Admins can sign in", "Sprint 42 planning", "SSO rollout"],
    );
}

#[tokio::test]
async fn ten_searches_a_minute_per_user() {
    let (addr, _st, host, _db) = serve(on).await;
    host.lock().unwrap().search = Some(json!({"items": []}));
    let mut codes = vec![];
    for _ in 0..11 {
        let res = http()
            .get(format!("http://{addr}/api/v1/search?q=x"))
            .bearer_auth(api_token("u_rl"))
            .send()
            .await
            .unwrap();
        codes.push(res.status().as_u16());
        if res.status() == 429 {
            assert!(res.headers().get("retry-after").is_some());
        }
    }
    assert_eq!(&codes[..10], &[200; 10]);
    assert_eq!(codes[10], 429);
    // Another person has their own budget.
    let res = http()
        .get(format!("http://{addr}/api/v1/search?q=x"))
        .bearer_auth(api_token("u_rl2"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
}

async fn ticket(st: &oc_server::SharedState) -> String {
    let t = ulid::Ulid::new().to_string();
    let mut g = grant("u_1", Role::View);
    g.callback_token = "cb-token-u1".into();
    st.store
        .insert_session(&t, &g, now() + 600, 0)
        .await
        .unwrap();
    t
}

/// SRCH-04: the editor route searches as the session's person with their callback token; the
/// session says whether to show the entry; a host that answers 404 hides it.
#[tokio::test]
async fn editor_search_and_the_hidden_entry() {
    let (addr, st, host, _db) = serve(on).await;
    let t = ticket(&st).await;
    let info: Value = http()
        .get(format!("http://{addr}/v1/sessions/{t}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info["search"]["enabled"], true, "{info}");
    host.lock().unwrap().search = Some(hits());
    let res = http()
        .get(format!(
            "http://{addr}/v1/search?ticket={t}&q=SSO&scope=all&limit=5"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers().get("cache-control").unwrap(),
        "no-store",
        "results are never cached"
    );
    let v: Value = res.json().await.unwrap();
    // No /access on this mock: the host's filtering stands.
    assert_eq!(v["items"].as_array().unwrap().len(), 2);
    {
        let h = host.lock().unwrap();
        let (pq, ok, bearer) = h.search_calls.last().unwrap();
        assert!(ok);
        assert_eq!(bearer, "cb-token-u1");
        assert!(pq.contains("scope=all"), "{pq}");
    }
    let res = http()
        .get(format!("http://{addr}/v1/search?ticket=nope&q=SSO"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    // The host does not implement it: 404 and the entry is hidden from then on.
    host.lock().unwrap().search = None;
    let res = http()
        .get(format!("http://{addr}/v1/search?ticket={t}&q=SSO"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
    let info: Value = http()
        .get(format!("http://{addr}/v1/sessions/{t}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info["search"]["enabled"], false);
}

#[tokio::test]
async fn without_the_callback_nothing_is_called_and_slow_hosts_time_out() {
    let (addr, st, host, _db) = serve(|h| {
        on(h);
        h.search
            .insert("callback".into(), toml::Value::Boolean(false));
    })
    .await;
    host.lock().unwrap().search = Some(hits());
    let t = ticket(&st).await;
    let info: Value = http()
        .get(format!("http://{addr}/v1/sessions/{t}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info["search"]["enabled"], false);
    let res = http()
        .get(format!("http://{addr}/api/v1/search?q=SSO"))
        .bearer_auth(api_token("u_1"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
    assert!(host.lock().unwrap().search_calls.is_empty());

    let (addr, _st, host, _db) = serve(on).await;
    {
        let mut h = host.lock().unwrap();
        h.search = Some(hits());
        h.search_delay_ms = 3000;
    }
    let res = http()
        .get(format!("http://{addr}/api/v1/search?q=SSO"))
        .bearer_auth(api_token("u_1"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 504);
}

#[test]
fn start_up_checks_host_search() {
    let base = "[[host]]\nid = \"h\"\nname = \"H\"\njwt_secret = \"0123456789abcdef0123456789abcdef\"\ncallback_base = \"http://h/api\"\n";
    let ok = oc_server::hosts::Hosts::parse(
        &format!("{base}[host.search]\ncallback = true\ncomments = false\ntimeout_ms = 8000\n"),
        None,
    )
    .unwrap();
    assert!(ok.get("h").unwrap().search().callback);
    let err = oc_server::hosts::Hosts::parse(&format!("{base}[host.search]\nindex = true\n"), None)
        .err()
        .unwrap();
    assert!(format!("{err:#}").contains("[host.search] has no setting"));
}
