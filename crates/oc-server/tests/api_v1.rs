// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Headless API v1 (docs/27 §4, ADR-041, HAPI-01): the `/api/v1` router, the OpenAPI 3.1
//! document and its contract with the router, RFC 9457 errors, and the 0.1 aliases.
mod common;

use std::collections::{BTreeSet, HashSet};

use common::*;
use oc_server::grant::Role;
use serde_json::{Value, json};

pub const API_KEY: &str = "test-api-key";

fn api_on(h: &mut oc_server::hosts::HostConfig) {
    h.api_key = Some(API_KEY.into());
    h.flags.insert("api_v1".into(), toml::Value::Boolean(true));
    h.flags.insert(
        "import_formats".into(),
        toml::Value::Array(vec![toml::Value::String("md".into())]),
    );
}

async fn serve(
    tweak: fn(&mut oc_server::hosts::HostConfig),
) -> (String, oc_server::SharedState, Shared) {
    let (base, host) = mock_host().await;
    let state = app_custom(&base, room_cfg(), &temp_db(), tweak).await;
    (serve_state(state.clone()).await, state, host)
}

fn req(addr: &str, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .request(method, format!("http://{addr}{path}"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", API_KEY)
}

async fn call(rb: reqwest::RequestBuilder) -> (u16, reqwest::header::HeaderMap, Value) {
    let res = rb.send().await.unwrap();
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let text = res.text().await.unwrap();
    (
        status,
        headers,
        serde_json::from_str(&text).unwrap_or(Value::String(text)),
    )
}

fn get(addr: &str, path: &str) -> reqwest::RequestBuilder {
    req(addr, reqwest::Method::GET, path)
}

fn post(addr: &str, path: &str) -> reqwest::RequestBuilder {
    req(addr, reqwest::Method::POST, path)
}

fn f(path: &str) -> String {
    format!("/api/v1/files/{FILE}{path}")
}

/// Asserts an RFC 9457 answer with this status and code.
fn assert_problem(
    status: u16,
    headers: &reqwest::header::HeaderMap,
    body: &Value,
    want: u16,
    code: &str,
) {
    assert_eq!(status, want, "{body}");
    assert_eq!(
        headers["content-type"].to_str().unwrap(),
        "application/problem+json",
        "{body}"
    );
    assert_eq!(body["status"], want, "{body}");
    assert_eq!(body["code"], code, "{body}");
    assert!(
        body["type"]
            .as_str()
            .unwrap()
            .starts_with("urn:opencanvas:problem:")
    );
    assert!(
        body["title"].is_string() && body["detail"].is_string(),
        "{body}"
    );
}

// ---------- the OpenAPI document ----------

fn openapi() -> Value {
    serde_json::from_str(oc_server::routes::v1::OPENAPI).expect("openapi.json is JSON")
}

/// Every `$ref` in `v` resolves inside `doc`.
fn check_refs(doc: &Value, v: &Value, at: &str) {
    match v {
        Value::Object(m) => {
            if let Some(r) = m.get("$ref").and_then(Value::as_str) {
                let ptr = r
                    .strip_prefix('#')
                    .unwrap_or_else(|| panic!("external ref {r} at {at}"));
                assert!(doc.pointer(ptr).is_some(), "unresolved {r} at {at}");
            }
            for (k, x) in m {
                check_refs(doc, x, &format!("{at}/{k}"));
            }
        }
        Value::Array(a) => a.iter().for_each(|x| check_refs(doc, x, at)),
        _ => {}
    }
}

#[test]
fn openapi_document_is_valid_3_1() {
    let doc = openapi();
    assert_eq!(doc["openapi"], "3.1.0");
    assert!(doc["info"]["title"].is_string() && doc["info"]["version"].is_string());
    check_refs(&doc, &doc, "");
    let mut ids = HashSet::new();
    let methods = [
        "get", "put", "post", "delete", "patch", "head", "options", "trace",
    ];
    for (path, item) in doc["paths"].as_object().unwrap() {
        assert!(path.starts_with('/'), "{path}");
        let want: BTreeSet<String> = path
            .split('/')
            .filter_map(|s| s.strip_prefix('{').and_then(|s| s.strip_suffix('}')))
            .map(String::from)
            .collect();
        for (m, op) in item.as_object().unwrap() {
            assert!(methods.contains(&m.as_str()), "{m} {path}");
            let id = op["operationId"]
                .as_str()
                .unwrap_or_else(|| panic!("{m} {path}: operationId"));
            assert!(ids.insert(id.to_string()), "duplicate operationId {id}");
            assert!(
                op["responses"].as_object().is_some_and(|r| !r.is_empty()),
                "{id}"
            );
            let declared: BTreeSet<String> = op["parameters"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|p| match p.get("$ref").and_then(Value::as_str) {
                    Some(r) => doc.pointer(&r[1..]).unwrap().clone(),
                    None => p.clone(),
                })
                .filter(|p| p["in"] == "path")
                .map(|p| {
                    assert_eq!(p["required"], true, "{id}: path params are required");
                    p["name"].as_str().unwrap().to_string()
                })
                .collect();
            assert_eq!(declared, want, "{id}: path parameters");
            for s in op["security"].as_array().cloned().unwrap_or_default() {
                for name in s.as_object().unwrap().keys() {
                    assert!(
                        doc["components"]["securitySchemes"][name].is_object(),
                        "{id}: unknown security scheme {name}"
                    );
                }
            }
        }
    }
}

/// Contract (docs/27 §4.3): every route the router registers is documented, and every
/// documented operation is routed.
#[test]
fn openapi_matches_the_router() {
    let doc = openapi();
    let documented: BTreeSet<(String, String)> = doc["paths"]
        .as_object()
        .unwrap()
        .iter()
        .flat_map(|(p, item)| {
            item.as_object()
                .unwrap()
                .keys()
                .map(move |m| (m.clone(), p.clone()))
        })
        .collect();
    let routed: BTreeSet<(String, String)> =
        oc_server::routes::v1::operations().into_iter().collect();
    let undocumented: Vec<_> = routed.difference(&documented).collect();
    let unrouted: Vec<_> = documented.difference(&routed).collect();
    assert!(
        undocumented.is_empty(),
        "routes missing from openapi.json: {undocumented:?}"
    );
    assert!(
        unrouted.is_empty(),
        "documented but not routed: {unrouted:?}"
    );
}

#[tokio::test]
async fn serves_the_checked_in_document() {
    let (addr, _, _) = serve(api_on).await;
    let res = reqwest::get(format!("http://{addr}/api/v1/openapi.json"))
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert!(
        res.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("application/json")
    );
    let v: Value = res.json().await.unwrap();
    assert_eq!(v, openapi());
}

// ---------- auth, flag and problem details ----------

#[tokio::test]
async fn off_unless_the_host_turns_it_on() {
    let (addr, _, _) = serve(|h| h.api_key = Some(API_KEY.into())).await;
    let (s, h, b) = call(get(&addr, &f(""))).await;
    assert_problem(s, &h, &b, 404, "API_OFF");
}

#[tokio::test]
async fn errors_are_problem_details() {
    let (addr, state, _) = serve(api_on).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;

    // No or a wrong key: 401.
    let (s, h, b) = call(reqwest::Client::new().get(format!("http://{addr}{}", f("")))).await;
    assert_problem(s, &h, &b, 401, "UNAUTHENTICATED");
    assert!(h.contains_key("www-authenticate"));
    let (s, h, b) = call(
        reqwest::Client::new()
            .get(format!("http://{addr}{}", f("")))
            .header("X-OpenCanvas-Host", "sample")
            .header("X-OpenCanvas-Key", "wrong"),
    )
    .await;
    assert_problem(s, &h, &b, 401, "UNAUTHENTICATED");

    // Unknown block, unknown operation, wrong method, bad JSON, bad format.
    let (s, h, b) = call(get(&addr, &f("/blocks/b_nope"))).await;
    assert_problem(s, &h, &b, 404, "BLOCK_NOT_FOUND");
    let (s, h, b) = call(get(&addr, &f("/nothing-here"))).await;
    assert_problem(s, &h, &b, 404, "NOT_FOUND");
    let (s, h, b) = call(req(&addr, reqwest::Method::PUT, &f("/blocks:batch"))).await;
    assert_problem(s, &h, &b, 405, "METHOD_NOT_ALLOWED");
    let (s, h, b) = call(post(&addr, &f("/blocks:batch")).body("{nope")).await;
    assert_problem(s, &h, &b, 400, "BAD_INPUT");
    let (s, h, b) = call(get(&addr, &f("?format=pdf"))).await;
    assert_problem(s, &h, &b, 400, "BAD_INPUT");
    let (s, h, b) = call(
        post(&addr, &f("/blocks:batch"))
            .json(&json!({"ops": [{"op": "delete", "blockId": "b_missing"}]})),
    )
    .await;
    assert_problem(s, &h, &b, 404, "BLOCK_NOT_FOUND");
    let (s, h, b) = call(get(&addr, &f("/databases/db_nope"))).await;
    assert_eq!(s, 404, "{b}");
    assert_eq!(h["content-type"], "application/problem+json");
}

// ---------- blocks ----------

#[tokio::test]
async fn read_batch_and_preconditions() {
    let (addr, state, _) = serve(api_on).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;

    let (s, h, out) = call(
        post(&addr, &f("/blocks:batch"))
            .header("X-OpenCanvas-Author", "bot-1")
            .json(&json!({"ops": [
                {"op": "append", "markdown": "## Plan\n\nFirst step"},
                {"op": "append", "blocks": [{"type": "paragraph", "attrs": {"blockId": "b_two"},
                    "content": [{"type": "text", "text": "Second step"}]}]}
            ]})),
    )
    .await;
    assert_eq!(s, 200, "{out}");
    assert_eq!(out["applied"], 2);
    assert_eq!(out["mode"], "direct");
    let ids: Vec<String> = serde_json::from_value(out["blockIds"].clone()).unwrap();
    assert_eq!(ids.len(), 3);
    let rev = out["rev"].as_str().unwrap().to_string();
    assert_eq!(h["etag"].to_str().unwrap(), format!("\"{rev}\""));
    a.settle().await;
    let text = json_of(&a.doc).to_string();
    assert!(
        text.contains("Second step") && text.contains("Plan"),
        "{text}"
    );

    // Read: JSON blocks with rev, and the same document rev as the batch answered.
    let (s, h, doc) = call(get(&addr, &f(""))).await;
    assert_eq!(s, 200, "{doc}");
    assert_eq!(doc["rev"], rev.as_str());
    assert_eq!(h["etag"].to_str().unwrap(), format!("\"{rev}\""));
    assert_eq!(doc["blocks"].as_array().unwrap().len(), 3);
    assert!(
        doc.get("notice").is_none(),
        "content is not wrapped for programs"
    );
    let (_, _, md) = call(get(&addr, &f("?format=markdown"))).await;
    assert!(md["markdown"].as_str().unwrap().contains("## Plan"), "{md}");

    // One block, a page of blocks, find.
    let (s, h, b) = call(get(&addr, &f("/blocks/b_two"))).await;
    assert_eq!(s, 200, "{b}");
    assert_eq!(b["blockId"], "b_two");
    let block_rev = b["rev"].as_str().unwrap().to_string();
    assert_eq!(h["etag"].to_str().unwrap(), format!("\"{block_rev}\""));
    let (_, _, page) = call(get(&addr, &f("/blocks?limit=2"))).await;
    assert_eq!(page["blocks"].as_array().unwrap().len(), 2);
    assert_eq!(page["has_more"], true);
    let (_, _, found) = call(get(&addr, &f("/blocks:find?q=second"))).await;
    assert!(found.to_string().contains("b_two"), "{found}");

    // A stale document precondition: 412, nothing applied.
    let (s, h, b) = call(
        post(&addr, &f("/blocks:batch"))
            .header("If-Match", "\"000000000000\"")
            .json(&json!({"ops": [{"op": "append", "markdown": "never"}]})),
    )
    .await;
    assert_problem(s, &h, &b, 412, "STALE_BLOCK");
    assert_eq!(b["fresh"]["rev"], rev.as_str());
    // The current one applies.
    let (s, _, out) = call(
        post(&addr, &f("/blocks:batch"))
            .header("If-Match", format!("\"{rev}\""))
            .json(
                &json!({"ops": [{"op": "editText", "blockId": "b_two", "ifMatch": block_rev,
                "textEdits": [{"find": "Second", "replace": "2nd"}]}]}),
            ),
    )
    .await;
    assert_eq!(s, 200, "{out}");
    // The block changed: the old block rev is stale now (412 with the fresh block).
    let (s, h, b) = call(post(&addr, &f("/blocks:batch")).json(&json!({"ops": [
            {"op": "replace", "blockId": "b_two", "ifMatch": block_rev, "markdown": "x"}]})))
    .await;
    assert_problem(s, &h, &b, 412, "STALE_BLOCK");
    assert_eq!(b["fresh"]["stale"][0]["blockId"], "b_two");
    a.settle().await;
    let text = json_of(&a.doc).to_string();
    assert!(
        text.contains("2nd step") && !text.contains("never"),
        "{text}"
    );
}

// ---------- databases, boards, comments, members ----------

#[tokio::test]
async fn databases_boards_comments_and_members() {
    let (addr, state, _) = serve(api_on).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;

    let (s, _, out) = call(post(&addr, &f("/databases")).json(&json!({
        "name": "Tasks",
        "fields": [{"name": "Task", "type": "title"}, {"name": "Points", "type": "number"}],
    })))
    .await;
    assert_eq!(s, 200, "{out}");
    let (_, _, dbs) = call(get(&addr, &f("/databases"))).await;
    let db_id = dbs["databases"][0]["dbId"].as_str().unwrap().to_string();
    let (s, _, out) = call(
        post(&addr, &f(&format!("/databases/{db_id}/rows:upsert")))
            .json(&json!({"rows": [{"values": {"Task": "Ship", "Points": 3}},
                {"values": {"Task": "Test", "Points": 5}}]})),
    )
    .await;
    assert_eq!(s, 200, "{out}");
    let (s, _, out) = call(
        post(&addr, &f(&format!("/databases/{db_id}/fields")))
            .json(&json!({"name": "Notes", "type": "text"})),
    )
    .await;
    assert_eq!(s, 200, "{out}");
    let (s, _, db) = call(get(&addr, &f(&format!("/databases/{db_id}")))).await;
    assert_eq!(s, 200, "{db}");
    assert_eq!(db["rowCount"], 2);
    let filter = urlencode(r#"[{"f":"Points","op":"gt","v":4}]"#);
    let (s, _, rows) = call(get(
        &addr,
        &f(&format!("/databases/{db_id}/rows?filter={filter}")),
    ))
    .await;
    assert_eq!(s, 200, "{rows}");
    assert!(
        rows.to_string().contains("Test") && !rows.to_string().contains("Ship"),
        "{rows}"
    );

    let (s, _, out) = call(post(&addr, &f("/boards/new/shapes")).json(&json!({
        "shapes": [{"kind": "sticky", "text": "Idea"}]})))
    .await;
    // `new` is not a board: the tool layer refuses (a board is created without boardId).
    assert!(s == 404 || s == 400, "{out}");

    let (_, _, out) = call(
        post(&addr, &f("/blocks:batch")).json(&json!({"ops": [{"op": "append",
        "blocks": [{"type": "paragraph", "attrs": {"blockId": "b_c"},
        "content": [{"type": "text", "text": "Review me"}]}]}]})),
    )
    .await;
    assert_eq!(out["applied"], 1, "{out}");
    let (s, _, out) =
        call(post(&addr, &f("/comments")).json(&json!({"text": "Looks good", "blockId": "b_c"})))
            .await;
    assert_eq!(s, 200, "{out}");
    let (_, _, list) = call(get(&addr, &f("/comments"))).await;
    assert!(list.to_string().contains("Looks good"), "{list}");

    let (s, _, m) = call(get(&addr, &f("/members"))).await;
    assert_eq!(s, 200, "{m}");
    assert!(m["members"].is_array(), "{m}");
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

// ---------- files and admin ----------

#[tokio::test]
async fn export_import_convert_and_admin() {
    let (addr, state, host) = serve(api_on).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;

    let (s, _, out) = call(
        post(&addr, &f("/import?format=md"))
            .header("X-OpenCanvas-Author", "bot-1")
            .body("# Imported\n\nHello from markdown"),
    )
    .await;
    assert_eq!(s, 200, "{out}");
    let res = get(&addr, &f("/export/md")).send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert!(res.text().await.unwrap().contains("Hello from markdown"));
    let (s, h, b) = call(get(&addr, &f("/export/exe"))).await;
    assert_problem(s, &h, &b, 404, "FORMAT_UNSUPPORTED");
    let (s, h, b) = call(post(&addr, &f("/import?format=csv")).body("a,b")).await;
    assert_eq!(s, 403, "{b}");
    assert_eq!(h["content-type"], "application/problem+json");

    let res = post(&addr, "/api/v1/convert?from=md&to=html")
        .body("# Title")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert!(res.text().await.unwrap().contains("<h1"));

    // Admin: commit saves to the host now.
    let (s, _, out) = call(post(&addr, &f("/commit"))).await;
    assert_eq!(s, 200, "{out}");
    assert_eq!(out["saved"], true, "{out}");
    assert_eq!(host.lock().unwrap().puts.len(), 1);
    let (s, _, out) =
        call(post(&addr, &f("/role")).json(&json!({"userId": "u_a", "role": "view"}))).await;
    assert_eq!(s, 200, "{out}");
    assert_eq!(out["connections"], 1);
    let (s, h, b) =
        call(post(&addr, &f("/role")).json(&json!({"userId": "u_a", "role": "owner"}))).await;
    assert_problem(s, &h, &b, 400, "ROLE_INVALID");
    let (s, _, out) = call(post(&addr, &f("/members:invalidate"))).await;
    assert_eq!((s, out["invalidated"].clone()), (200, json!(true)));
    let (s, _, out) = call(req(&addr, reqwest::Method::DELETE, &f("/session"))).await;
    assert_eq!(s, 200, "{out}");
    assert_eq!(out["closed"], true);
}

// ---------- 0.1 aliases ----------

#[tokio::test]
async fn old_routes_still_answer_with_their_shape_and_a_deprecation() {
    let (addr, state, _) = serve(api_on).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    let path = format!("/v1/files/{FILE}/patch");
    let (s, h, out) = call(post(&addr, &path).json(&json!({
        "ops": [{"op": "append", "markdown": "old route"}], "author": {"id": "bot"}})))
    .await;
    assert_eq!(s, 200, "{out}");
    assert_eq!(out["applied"], 1);
    assert_eq!(out["live"], true);
    assert_eq!(h["deprecation"], oc_server::routes::v1::DEPRECATED_AT);
    assert_eq!(
        h["link"].to_str().unwrap(),
        format!("</api/v1/files/{FILE}/blocks:batch>; rel=\"successor-version\"")
    );
    // Old errors keep `{error:{code,message}}`.
    let (s, h, out) = call(post(&addr, &path).json(&json!({
        "ops": [{"op": "delete", "blockId": "b_missing"}], "author": {"id": "bot"}})))
    .await;
    assert_eq!(s, 404);
    assert_eq!(out["error"]["code"], "BLOCK_NOT_FOUND", "{out}");
    assert!(
        h["content-type"]
            .to_str()
            .unwrap()
            .starts_with("application/json")
    );
    // They work whether or not the host turned the v1 API on.
    let (addr, state, _) = serve(|h| h.api_key = Some(API_KEY.into())).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    let (s, h, _) = call(post(&addr, &format!("/v1/files/{FILE}/commit"))).await;
    assert_eq!(s, 200);
    assert_eq!(
        h["link"].to_str().unwrap(),
        format!("</api/v1/files/{FILE}/commit>; rel=\"successor-version\"")
    );
    let (s, _, _) = call(post(&addr, "/v1/convert?from=md&to=md").body("# x")).await;
    assert_eq!(s, 200);
}

/// HAPI-03 in the contract: every write under `/api/v1/files` documents `Idempotency-Key` and
/// its 409/422 answers; `convert` (returns a document) takes no key.
#[test]
fn openapi_documents_idempotency_on_every_file_write() {
    let doc = openapi();
    let mut n = 0;
    for (path, item) in doc["paths"].as_object().unwrap() {
        let Some(op) = item.get("post") else { continue };
        let has_key = op["parameters"].as_array().is_some_and(|p| {
            p.iter()
                .any(|p| p["$ref"] == "#/components/parameters/IdempotencyKey")
        });
        if path.ends_with("/sync-token") {
            // HAPI-05: the answer is a credential, never stored for a replay.
            assert!(!has_key, "{path} takes no key");
        } else if path.starts_with("/api/v1/files/") {
            n += 1;
            assert!(has_key, "{path}: Idempotency-Key");
            assert!(
                op["responses"]["409"].is_object() && op["responses"]["422"].is_object(),
                "{path}"
            );
        } else {
            assert!(!has_key, "{path} takes no key");
        }
    }
    assert!(n >= 10, "{n}");
    assert_eq!(
        doc["components"]["parameters"]["IdempotencyKey"]["in"],
        "header"
    );
}
