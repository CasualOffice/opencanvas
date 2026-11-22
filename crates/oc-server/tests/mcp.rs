// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! MCP endpoint (docs/24 §5, §7): handshake, tools over HTTP, bearer auth, scopes.
mod common;

use common::*;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use oc_server::grant::Role;
use serde_json::{Value, json};

fn mcp_on(h: &mut oc_server::hosts::HostConfig) {
    h.ai.insert("mcp".into(), toml::Value::Boolean(true));
    h.ai.insert("default_mode".into(), toml::Value::String("direct".into()));
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn token(addr: &str, scope: &str, role: &str, f: impl FnOnce(&mut Value)) -> String {
    let mut c = json!({"iss": "sample", "aud": format!("http://{addr}/mcp/sample"), "sub": "u_mcp",
        "name": "Asha", "exp": now() + 600, "scope": scope, "role": role, "client_id": "claude"});
    f(&mut c);
    encode(
        &Header::new(Algorithm::HS256),
        &c,
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}

async fn rpc(addr: &str, tok: Option<&str>, method: &str, params: Value) -> reqwest::Response {
    let mut r = reqwest::Client::new()
        .post(format!("http://{addr}/mcp/sample"))
        .header("MCP-Protocol-Version", "2025-11-25")
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}));
    if let Some(t) = tok {
        r = r.bearer_auth(t);
    }
    r.send().await.unwrap()
}

async fn ok(addr: &str, tok: &str, method: &str, params: Value) -> Value {
    let res = rpc(addr, Some(tok), method, params).await;
    assert_eq!(res.status(), 200);
    let v: Value = res.json().await.unwrap();
    assert!(v.get("error").is_none(), "{v}");
    v["result"].clone()
}

async fn serve(tweak: fn(&mut oc_server::hosts::HostConfig)) -> (String, oc_server::SharedState) {
    let (base, _h) = mock_host().await;
    let state = app_ai(&base, room_cfg(), &temp_db(), tweak).await;
    (serve_state(state.clone()).await, state)
}

#[tokio::test]
async fn off_by_default() {
    let (addr, _) = serve(|_| {}).await;
    let t = token(&addr, "canvas:read", "edit", |_| {});
    assert_eq!(
        rpc(&addr, Some(&t), "initialize", json!({})).await.status(),
        404
    );
}

#[tokio::test]
async fn handshake_tools_list_and_call_over_http() {
    let (addr, state) = serve(mcp_on).await;
    let mut peer = Peer::join(&state, grant("u_b", Role::Edit)).await;
    peer.settle().await;
    let t = token(&addr, "canvas:read canvas:write", "edit", |_| {});

    let init = ok(
        &addr,
        &t,
        "initialize",
        json!({"protocolVersion": "2025-11-25",
        "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}),
    )
    .await;
    assert_eq!(init["protocolVersion"], "2025-11-25");
    assert_eq!(init["serverInfo"]["name"], "opencanvas");
    let init = ok(
        &addr,
        &t,
        "initialize",
        json!({"protocolVersion": "2026-07-28"}),
    )
    .await;
    assert_eq!(init["protocolVersion"], "2026-07-28");
    let init = ok(
        &addr,
        &t,
        "initialize",
        json!({"protocolVersion": "2024-01-01"}),
    )
    .await;
    assert_eq!(init["protocolVersion"], "2026-07-28", "unknown → newest");

    // A notification gets 202.
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/mcp/sample"))
        .bearer_auth(&t)
        .json(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 202);

    let list = ok(&addr, &t, "tools/list", json!({})).await;
    let names: Vec<&str> = list["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"canvas_read") && names.contains(&"canvas_patch"));
    assert_eq!(list["tools"][0]["annotations"]["readOnlyHint"], true);

    let r = ok(
        &addr,
        &t,
        "tools/call",
        json!({"name": "canvas_patch", "arguments": {"fileId": FILE,
        "ops": [{"op": "append", "markdown": "From MCP"}]}}),
    )
    .await;
    assert_eq!(r["isError"], false, "{r}");
    peer.settle().await;
    let pj = json_of(&peer.doc);
    assert_eq!(pj["content"][0]["content"][0]["text"], "From MCP");

    let r = ok(
        &addr,
        &t,
        "tools/call",
        json!({"name": "canvas_read", "arguments": {"fileId": FILE}}),
    )
    .await;
    assert!(
        r["structuredContent"]["data"]["markdown"]
            .as_str()
            .unwrap()
            .contains("From MCP")
    );

    let tpl = ok(&addr, &t, "resources/templates/list", json!({})).await;
    assert_eq!(
        tpl["resourceTemplates"][0]["uriTemplate"],
        "canvas://sample/{fileId}"
    );
    let res = ok(
        &addr,
        &t,
        "resources/read",
        json!({"uri": format!("canvas://sample/{FILE}")}),
    )
    .await;
    assert!(
        res["contents"][0]["text"]
            .as_str()
            .unwrap()
            .contains("From MCP")
    );
}

#[tokio::test]
async fn unauthorized_carries_resource_metadata_and_bad_tokens_are_refused() {
    let (addr, _) = serve(mcp_on).await;
    let res = rpc(&addr, None, "tools/list", json!({})).await;
    assert_eq!(res.status(), 401);
    let www = res.headers()["www-authenticate"]
        .to_str()
        .unwrap()
        .to_string();
    let meta = format!("http://{addr}/.well-known/oauth-protected-resource/mcp/sample");
    assert!(
        www.contains(&format!("resource_metadata=\"{meta}\"")),
        "{www}"
    );
    let prm: Value = reqwest::get(&meta).await.unwrap().json().await.unwrap();
    assert_eq!(prm["resource"], format!("http://{addr}/mcp/sample"));
    assert_eq!(prm["authorization_servers"][0], "sample");

    let wrong_aud = token(&addr, "canvas:read", "edit", |c| {
        c["aud"] = json!("http://x/mcp/other")
    });
    assert_eq!(
        rpc(&addr, Some(&wrong_aud), "tools/list", json!({}))
            .await
            .status(),
        401
    );
    let launch_aud = token(&addr, "canvas:read", "edit", |c| {
        c["aud"] = json!("opencanvas")
    });
    assert_eq!(
        rpc(&addr, Some(&launch_aud), "tools/list", json!({}))
            .await
            .status(),
        401
    );
    let expired = token(&addr, "canvas:read", "edit", |c| {
        c["exp"] = json!(now() - 300)
    });
    let res = rpc(&addr, Some(&expired), "tools/list", json!({})).await;
    assert_eq!(res.status(), 401);
    assert!(
        res.headers()["www-authenticate"]
            .to_str()
            .unwrap()
            .contains("invalid_token")
    );
    let long = token(&addr, "canvas:read", "edit", |c| {
        c["exp"] = json!(now() + 3600)
    });
    assert_eq!(
        rpc(&addr, Some(&long), "tools/list", json!({}))
            .await
            .status(),
        401
    );
    let no_scope = token(&addr, "profile", "edit", |_| {});
    assert_eq!(
        rpc(&addr, Some(&no_scope), "tools/list", json!({}))
            .await
            .status(),
        403
    );
}

#[tokio::test]
async fn a_scope_narrower_than_the_role_wins() {
    let (addr, state) = serve(mcp_on).await;
    let mut peer = Peer::join(&state, grant("u_b", Role::Edit)).await;
    peer.settle().await;
    // Role edit, scope read: no write tools listed, and calling one is refused.
    let t = token(&addr, "canvas:read", "edit", |_| {});
    let list = ok(&addr, &t, "tools/list", json!({})).await;
    assert!(
        list["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["annotations"]["readOnlyHint"] == true)
    );
    let r = ok(
        &addr,
        &t,
        "tools/call",
        json!({"name": "canvas_patch", "arguments": {"fileId": FILE,
        "ops": [{"op": "append", "markdown": "nope"}]}}),
    )
    .await;
    assert_eq!(r["isError"], true);
    assert_eq!(r["structuredContent"]["code"], "ROLE_FORBIDDEN");
    // And the role still caps a wide scope: view role with canvas:write cannot write.
    let t = token(&addr, "canvas:write", "view", |_| {});
    let r = ok(
        &addr,
        &t,
        "tools/call",
        json!({"name": "canvas_patch", "arguments": {"fileId": FILE,
        "ops": [{"op": "append", "markdown": "nope"}]}}),
    )
    .await;
    assert_eq!(r["isError"], true);
    peer.settle().await;
    assert!(json_of(&peer.doc)["content"].as_array().unwrap().is_empty());
}

async fn serve_with_host(
    tweak: fn(&mut oc_server::hosts::HostConfig),
) -> (String, oc_server::SharedState, Shared) {
    let (base, h) = mock_host().await;
    let state = app_ai(&base, room_cfg(), &temp_db(), tweak).await;
    (serve_state(state.clone()).await, state, h)
}

fn patch(addr: &str) -> Value {
    let _ = addr;
    json!({"name": "canvas_patch", "arguments": {"fileId": FILE,
        "ops": [{"op": "append", "markdown": "from mcp"}]}})
}

#[tokio::test]
async fn the_host_access_callback_decides_the_role_over_the_token_claim() {
    let (addr, state, host) = serve_with_host(mcp_on).await;
    let mut peer = Peer::join(&state, grant("u_b", Role::Edit)).await;
    peer.settle().await;
    // The host says `view` although the token claims `edit`: writing is refused.
    host.lock().unwrap().access = Some(
        [("u_mcp".to_string(), "view".to_string())]
            .into_iter()
            .collect(),
    );
    let t = token(&addr, "canvas:write", "edit", |_| {});
    let r = ok(&addr, &t, "tools/call", patch(&addr)).await;
    assert_eq!(r["isError"], true, "{r}");
    assert_eq!(r["structuredContent"]["code"], "ROLE_FORBIDDEN");
    {
        let st = host.lock().unwrap();
        assert_eq!(st.access_calls.len(), 1);
        let (f, u, signed) = &st.access_calls[0];
        assert_eq!((f.as_str(), u.as_str(), *signed), (FILE, "u_mcp", true));
    }
    // Reading is fine for a viewer, and the answer is cached (no second callback).
    let r = ok(
        &addr,
        &t,
        "tools/call",
        json!({"name": "canvas_read", "arguments": {"fileId": FILE}}),
    )
    .await;
    assert_eq!(r["isError"], false, "{r}");
    assert_eq!(host.lock().unwrap().access_calls.len(), 1, "cached");
    // `none` refuses even reads; the token's role claim never widens it.
    host.lock().unwrap().access = Some(Default::default());
    let t2 = token(&addr, "canvas:write", "edit", |c| {
        c["sub"] = json!("u_other")
    });
    let r = ok(
        &addr,
        &t2,
        "tools/call",
        json!({"name": "canvas_read", "arguments": {"fileId": FILE}}),
    )
    .await;
    assert_eq!(r["structuredContent"]["code"], "ROLE_FORBIDDEN", "{r}");
    // The host says `edit` but the scope is `canvas:comment`: min(scope, role) = comment.
    host.lock().unwrap().access = Some(
        [("u_c".to_string(), "edit".to_string())]
            .into_iter()
            .collect(),
    );
    let t3 = token(&addr, "canvas:comment", "view", |c| c["sub"] = json!("u_c"));
    let r = ok(&addr, &t3, "tools/call", patch(&addr)).await;
    assert_eq!(r["structuredContent"]["code"], "ROLE_FORBIDDEN", "{r}");
    peer.settle().await;
    assert!(json_of(&peer.doc)["content"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn without_the_access_callback_the_token_role_claim_is_used() {
    let (addr, state, host) = serve_with_host(mcp_on).await;
    let mut peer = Peer::join(&state, grant("u_b", Role::Edit)).await;
    peer.settle().await;
    // The mock host answers 404 on /access: fall back to the claim (`edit`).
    let t = token(&addr, "canvas:write", "edit", |_| {});
    let r = ok(&addr, &t, "tools/call", patch(&addr)).await;
    assert_eq!(r["isError"], false, "{r}");
    assert_eq!(host.lock().unwrap().access_calls.len(), 1, "asked once");
    peer.settle().await;
    assert!(!json_of(&peer.doc)["content"].as_array().unwrap().is_empty());
}
