// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Headless API v1 user-scoped tokens (docs/27 §4.2, HAPI-02): host-minted, audience-bound,
//! scoped, at most 15 minutes; effective permission = min(scope, host role); one check with MCP.
mod common;

use common::*;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use oc_server::grant::Role;
use serde_json::{Value, json};

const PUBLIC: &str = "https://oc.example";

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn api_on(h: &mut oc_server::hosts::HostConfig) {
    h.api_key = Some("k".into());
    h.flags.insert("api_v1".into(), toml::Value::Boolean(true));
    h.api
        .insert("audience".into(), toml::Value::String(PUBLIC.into()));
}

fn sign(claims: &Value, secret: &str) -> String {
    encode(
        &Header::new(Algorithm::HS256),
        claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap()
}

/// A token as the host mints it; `f` adjusts the claims.
fn token(scope: &str, f: impl FnOnce(&mut Value)) -> String {
    let mut c = json!({"iss": "sample", "aud": format!("{PUBLIC}/api/v1"), "sub": "u_api",
        "name": "Asha", "exp": now() + 600, "scope": scope, "role": "edit", "files": [FILE]});
    f(&mut c);
    sign(&c, SECRET)
}

async fn serve_with(
    tweak: fn(&mut oc_server::hosts::HostConfig),
) -> (String, oc_server::SharedState, Shared) {
    let (base, host) = mock_host().await;
    let state = app_custom(&base, room_cfg(), &temp_db(), tweak).await;
    (serve_state(state.clone()).await, state, host)
}

async fn call(
    addr: &str,
    method: reqwest::Method,
    path: &str,
    tok: &str,
    body: Option<Value>,
) -> (u16, reqwest::header::HeaderMap, Value) {
    let mut r = reqwest::Client::new()
        .request(method, format!("http://{addr}{path}"))
        .bearer_auth(tok);
    if let Some(b) = body {
        r = r.json(&b);
    }
    let res = r.send().await.unwrap();
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let v = res.json().await.unwrap_or(Value::Null);
    (status, headers, v)
}

async fn read(addr: &str, tok: &str) -> (u16, Value) {
    let (s, _, v) = call(
        addr,
        reqwest::Method::GET,
        &format!("/api/v1/files/{FILE}"),
        tok,
        None,
    )
    .await;
    (s, v)
}

async fn write(addr: &str, tok: &str, text: &str) -> (u16, Value) {
    let (s, _, v) = call(
        addr,
        reqwest::Method::POST,
        &format!("/api/v1/files/{FILE}/blocks:batch"),
        tok,
        Some(json!({"ops": [{"op": "append", "markdown": text}]})),
    )
    .await;
    (s, v)
}

#[tokio::test]
async fn scope_is_a_ceiling_and_the_host_role_decides() {
    let (addr, state, _) = serve_with(api_on).await;
    let mut peer = Peer::join(&state, grant("u_b", Role::Edit)).await;
    peer.settle().await;

    // canvas:read reads, cannot write.
    let t = token("canvas:read", |_| {});
    let (s, v) = read(&addr, &t).await;
    assert_eq!(s, 200, "{v}");
    let (s, v) = write(&addr, &t, "no").await;
    assert_eq!(
        (s, v["code"].as_str()),
        (403, Some("SCOPE_REQUIRED")),
        "{v}"
    );

    // canvas:write with an edit role writes, attributed to the token's user.
    let t = token("canvas:read canvas:write", |_| {});
    let (s, v) = write(&addr, &t, "From a token").await;
    assert_eq!(s, 200, "{v}");
    peer.settle().await;
    assert!(json_of(&peer.doc).to_string().contains("From a token"));

    // canvas:write, but the host says view: no write.
    let t = token("canvas:write", |c| c["role"] = json!("view"));
    let (s, v) = write(&addr, &t, "no").await;
    assert_eq!(
        (s, v["code"].as_str()),
        (403, Some("ROLE_FORBIDDEN")),
        "{v}"
    );
    // canvas:comment may comment but not write.
    let t = token("canvas:comment", |_| {});
    let (s, v) = write(&addr, &t, "no").await;
    assert_eq!(
        (s, v["code"].as_str()),
        (403, Some("SCOPE_REQUIRED")),
        "{v}"
    );
    let (s, v) = read(&addr, &t).await;
    assert_eq!(s, 200, "{v}");

    // A file outside the token's `files` is refused.
    let t = token("canvas:read", |c| c["files"] = json!(["other"]));
    let (s, v) = read(&addr, &t).await;
    assert_eq!(
        (s, v["code"].as_str()),
        (403, Some("ROLE_FORBIDDEN")),
        "{v}"
    );
    // No `files` and no /access callback: refused (SEC-34 for the API).
    let t = token("canvas:read", |c| {
        c.as_object_mut().unwrap().remove("files");
    });
    let (s, v) = read(&addr, &t).await;
    assert_eq!(
        (s, v["code"].as_str()),
        (403, Some("FILES_REQUIRED")),
        "{v}"
    );
    // No canvas scope at all.
    let t = token("openid profile", |_| {});
    let (s, v) = read(&addr, &t).await;
    assert_eq!(
        (s, v["code"].as_str()),
        (403, Some("SCOPE_REQUIRED")),
        "{v}"
    );
}

#[tokio::test]
async fn the_access_callback_overrides_the_claim_and_revocation_is_immediate() {
    let (addr, state, host) = serve_with(api_on).await;
    let mut peer = Peer::join(&state, grant("u_b", Role::Edit)).await;
    peer.settle().await;
    host.lock().unwrap().access = Some(
        [("u_api".to_string(), "view".to_string())]
            .into_iter()
            .collect(),
    );
    // The claim says edit, the host says view.
    let t = token("canvas:write", |c| {
        c.as_object_mut().unwrap().remove("files");
    });
    let (s, v) = write(&addr, &t, "no").await;
    assert_eq!(
        (s, v["code"].as_str()),
        (403, Some("ROLE_FORBIDDEN")),
        "{v}"
    );
    assert!(
        host.lock().unwrap().access_calls[0].2,
        "signed /access call"
    );

    // The host grants edit and tells us through the role API (drops the cached answer).
    host.lock().unwrap().access = Some(
        [("u_api".to_string(), "edit".to_string())]
            .into_iter()
            .collect(),
    );
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/api/v1/files/{FILE}/role"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", "k")
        .json(&json!({"userId": "u_api", "role": "edit"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let (s, v) = write(&addr, &t, "now allowed").await;
    assert_eq!(s, 200, "{v}");

    // Revoked: the next call is refused at once, the same token notwithstanding.
    host.lock().unwrap().access = Some(Default::default());
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/api/v1/files/{FILE}/role"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", "k")
        .json(&json!({"userId": "u_api", "role": "none"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let (s, v) = write(&addr, &t, "no").await;
    assert_eq!(s, 403, "{v}");
    let (s, v) = read(&addr, &t).await;
    assert_eq!(s, 403, "{v}");
}

#[tokio::test]
async fn expired_long_lived_foreign_and_forged_tokens_are_refused() {
    let (addr, state, _) = serve_with(api_on).await;
    let mut peer = Peer::join(&state, grant("u_b", Role::Edit)).await;
    peer.settle().await;
    let check = |s: u16, v: &Value, code: &str| {
        assert_eq!((s, v["code"].as_str()), (401, Some(code)), "{v}");
    };

    let (s, v) = read(
        &addr,
        &token("canvas:read", |c| c["exp"] = json!(now() - 120)),
    )
    .await;
    check(s, &v, "TOKEN_EXPIRED");
    let (s, v) = read(
        &addr,
        &token("canvas:read", |c| c["exp"] = json!(now() + 3600)),
    )
    .await;
    check(s, &v, "TOKEN_INVALID");
    let (s, v) = read(
        &addr,
        &token("canvas:read", |c| c["nbf"] = json!(now() + 300)),
    )
    .await;
    check(s, &v, "TOKEN_INVALID");
    // Replaying an MCP token (another audience) or a launch token here.
    let (s, v) = read(
        &addr,
        &token("canvas:read", |c| {
            c["aud"] = json!(format!("{PUBLIC}/mcp/sample"))
        }),
    )
    .await;
    check(s, &v, "TOKEN_INVALID");
    let (s, v) = read(
        &addr,
        &token("canvas:read", |c| c["aud"] = json!("opencanvas")),
    )
    .await;
    check(s, &v, "TOKEN_INVALID");
    // The audience never follows the Host header.
    let (s, v) = read(
        &addr,
        &token("canvas:read", |c| {
            c["aud"] = json!(format!("http://{addr}/api/v1"))
        }),
    )
    .await;
    check(s, &v, "TOKEN_INVALID");
    // Forged (another key), unknown issuer, missing sub, garbage.
    let mut c = json!({"iss": "sample", "aud": format!("{PUBLIC}/api/v1"), "sub": "u_api",
        "exp": now() + 600, "scope": "canvas:read", "files": [FILE]});
    let (s, v) = read(&addr, &sign(&c, "not-the-secret")).await;
    check(s, &v, "TOKEN_INVALID");
    c["iss"] = json!("intruder");
    let (s, v) = read(&addr, &sign(&c, SECRET)).await;
    check(s, &v, "TOKEN_INVALID");
    c["iss"] = json!("sample");
    c.as_object_mut().unwrap().remove("sub");
    let (s, v) = read(&addr, &sign(&c, SECRET)).await;
    check(s, &v, "TOKEN_INVALID");
    let (s, v) = read(&addr, "not.a.token").await;
    check(s, &v, "TOKEN_INVALID");
    // The same, valid token keeps working until it expires (bearer semantics).
    let t = token("canvas:read", |_| {});
    assert_eq!(read(&addr, &t).await.0, 200);
    assert_eq!(read(&addr, &t).await.0, 200);
}

#[tokio::test]
async fn without_a_public_url_tokens_are_off() {
    let (addr, _, _) = serve_with(|h| {
        h.api_key = Some("k".into());
        h.flags.insert("api_v1".into(), toml::Value::Boolean(true));
    })
    .await;
    let t = token("canvas:read", |_| {});
    let (s, v) = read(&addr, &t).await;
    assert_eq!((s, v["code"].as_str()), (401, Some("TOKEN_INVALID")), "{v}");
    assert!(
        v["detail"].as_str().unwrap().contains("OC_PUBLIC_URL"),
        "{v}"
    );
}

#[tokio::test]
async fn admin_operations_are_the_host_keys_unless_the_host_allows_tokens() {
    let (addr, state, _) = serve_with(api_on).await;
    let mut peer = Peer::join(&state, grant("u_b", Role::Edit)).await;
    peer.settle().await;
    let t = token("canvas:write canvas:admin", |_| {});
    let path = format!("/api/v1/files/{FILE}/commit");
    let (s, _, v) = call(&addr, reqwest::Method::POST, &path, &t, None).await;
    assert_eq!(
        (s, v["code"].as_str()),
        (403, Some("SCOPE_REQUIRED")),
        "{v}"
    );

    let (addr, state, _) = serve_with(|h| {
        api_on(h);
        h.api
            .insert("token_admin".into(), toml::Value::Boolean(true));
    })
    .await;
    let mut peer = Peer::join(&state, grant("u_b", Role::Edit)).await;
    peer.settle().await;
    let (s, _, v) = call(&addr, reqwest::Method::POST, &path, &t, None).await;
    assert_eq!(s, 200, "{v}");
    // Without canvas:admin, still no.
    let t = token("canvas:write", |_| {});
    let (s, _, v) = call(&addr, reqwest::Method::POST, &path, &t, None).await;
    assert_eq!(
        (s, v["code"].as_str()),
        (403, Some("SCOPE_REQUIRED")),
        "{v}"
    );
}

#[tokio::test]
async fn an_api_token_is_not_an_mcp_token() {
    let (base, _h) = mock_host().await;
    let state = app_ai(&base, room_cfg(), &temp_db(), |h| {
        api_on(h);
        h.ai.insert("mcp".into(), toml::Value::Boolean(true));
        h.ai.insert("mcp_audience".into(), toml::Value::String(PUBLIC.into()));
    })
    .await;
    let addr = serve_state(state).await;
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/mcp/sample"))
        .bearer_auth(token("canvas:read", |_| {}))
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}
