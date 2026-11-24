// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! HAPI-08 (docs/27 §4.2 "Relation to MCP"): every MCP canvas tool is an adapter over a
//! documented API operation. The contract: each tool maps to operations in the OpenAPI
//! document with the same scope and a route in the router; and for the same input, a tool
//! call answers what the operation answers (reads: the same JSON on the same file; writes:
//! the same answer, ids aside, on two files that started equal, which then read the same).
//! Also: MCP writes share the API's per-file write bucket and its idempotency store.
mod common;

use std::collections::{BTreeSet, HashMap};

use common::*;
use oc_server::routes::v1::ops;
use serde_json::{Value, json};

const PUBLIC: &str = "https://oc.example";
const KEY: &str = "parity-key";
const A: &str = "doc_a";
const B: &str = "doc_b";

fn on(h: &mut oc_server::hosts::HostConfig) {
    h.api_key = Some(KEY.into());
    h.flags.insert("api_v1".into(), toml::Value::Boolean(true));
    h.api
        .insert("audience".into(), toml::Value::String(PUBLIC.into()));
    h.api
        .insert("rate_per_sec".into(), toml::Value::Integer(100_000));
    h.api.insert("burst".into(), toml::Value::Integer(100_000));
    h.api
        .insert("file_writes_per_sec".into(), toml::Value::Integer(100_000));
    h.api
        .insert("file_burst".into(), toml::Value::Integer(100_000));
    h.ai.insert("mcp".into(), toml::Value::Boolean(true));
    h.ai.insert("mcp_audience".into(), toml::Value::String(PUBLIC.into()));
    h.ai.insert("default_mode".into(), toml::Value::String("direct".into()));
}

fn tight(h: &mut oc_server::hosts::HostConfig) {
    on(h);
    h.api
        .insert("file_writes_per_sec".into(), toml::Value::Integer(1));
    h.api.insert("file_burst".into(), toml::Value::Integer(2));
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn mcp_token() -> String {
    let c = json!({"iss": "sample", "aud": format!("{PUBLIC}/mcp/sample"), "sub": "u_mcp",
        "name": "Asha", "exp": now() + 600, "scope": "canvas:read canvas:comment canvas:write",
        "role": "edit", "files": [A, B, FILE], "client_id": "parity"});
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        &c,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}

async fn serve(tweak: fn(&mut oc_server::hosts::HostConfig)) -> (String, oc_server::SharedState) {
    let (base, _h) = mock_host().await;
    let state = app_ai(&base, room_cfg(), &temp_db(), tweak).await;
    state.clock.set_ms(1_800_000_000_000);
    (serve_state(state.clone()).await, state)
}

/// A `tools/call`; answers the HTTP status and the JSON-RPC result.
async fn mcp_raw(addr: &str, tool: &str, args: Value, meta: Option<Value>) -> (u16, Value) {
    let mut params = json!({"name": tool, "arguments": args});
    if let Some(m) = meta {
        params["_meta"] = m;
    }
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/mcp/sample"))
        .bearer_auth(mcp_token())
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": params}))
        .send()
        .await
        .unwrap();
    let s = res.status().as_u16();
    let v: Value = res.json().await.unwrap();
    (s, v["result"].clone())
}

/// A successful tool call's structured result, with the untrusted-data wrapper of reads
/// removed (the API answers the data itself).
async fn mcp(addr: &str, tool: &str, args: Value) -> Value {
    let (s, r) = mcp_raw(addr, tool, args, None).await;
    assert_eq!(s, 200, "{r}");
    assert_eq!(r["isError"], false, "{tool}: {r}");
    let v = r["structuredContent"].clone();
    match (v.get("notice"), v.get("data")) {
        (Some(_), Some(d)) => d.clone(),
        _ => v,
    }
}

async fn api(addr: &str, method: &str, path: &str, body: Option<Value>) -> Value {
    let m = reqwest::Method::from_bytes(method.as_bytes()).unwrap();
    let mut rb = reqwest::Client::new()
        .request(m, format!("http://{addr}{path}"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", KEY);
    if let Some(b) = body {
        rb = rb.json(&b);
    }
    let res = rb.send().await.unwrap();
    let s = res.status().as_u16();
    let v: Value = res.json().await.unwrap();
    assert_eq!(s, 200, "{method} {path}: {v}");
    v
}

/// Ids (`b_…`, `db_…`, `r_…`, …: a prefix and a 26-character ULID) and revisions become
/// placeholders numbered by first appearance, so two files' answers can be compared.
fn normalize(v: &Value, seen: &mut HashMap<String, String>) -> Value {
    match v {
        Value::String(s) => {
            let id_like = s.split_once('_').is_some_and(|(p, u)| {
                !p.is_empty()
                    && p.len() <= 3
                    && u.len() == 26
                    && u.bytes().all(|b| b.is_ascii_alphanumeric())
            });
            if id_like {
                let n = seen.len();
                Value::String(seen.entry(s.clone()).or_insert(format!("<id{n}>")).clone())
            } else {
                v.clone()
            }
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| normalize(x, seen)).collect()),
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, x)| {
                    let x = if k == "rev" {
                        json!("<rev>")
                    } else {
                        normalize(x, seen)
                    };
                    (k.clone(), x)
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

fn same_modulo_ids(a: &Value, b: &Value, what: &str) {
    let na = normalize(a, &mut HashMap::new());
    let nb = normalize(b, &mut HashMap::new());
    assert_eq!(na, nb, "{what}: MCP {a} vs API {b}");
}

fn openapi() -> Value {
    serde_json::from_str(oc_server::routes::v1::OPENAPI).unwrap()
}

/// `operationId` → (method, path, scope) from the document.
fn documented() -> HashMap<String, (String, String, Option<String>)> {
    let mut out = HashMap::new();
    for (path, item) in openapi()["paths"].as_object().unwrap() {
        for (m, op) in item.as_object().unwrap() {
            out.insert(
                op["operationId"].as_str().unwrap().to_string(),
                (
                    m.clone(),
                    path.clone(),
                    op["x-opencanvas-scope"].as_str().map(String::from),
                ),
            );
        }
    }
    out
}

#[test]
fn every_mcp_tool_maps_to_a_documented_operation_with_its_scope() {
    let specs = oc_server::ai::tools::phase1_specs();
    let tools: BTreeSet<&str> = specs.iter().map(|s| s.name).collect();
    let mapped: BTreeSet<&str> = ops::MCP_TOOLS.iter().map(|(t, _)| *t).collect();
    assert_eq!(
        tools, mapped,
        "every MCP tool, and only those, has an operation"
    );
    let doc = documented();
    let routes: BTreeSet<(String, String)> =
        oc_server::routes::v1::operations().into_iter().collect();
    for spec in &specs {
        let (_, op_ids) = ops::MCP_TOOLS
            .iter()
            .find(|(t, _)| *t == spec.name)
            .unwrap();
        assert!(!op_ids.is_empty());
        for op in *op_ids {
            let (method, path, scope) = doc
                .get(*op)
                .unwrap_or_else(|| panic!("{}: {op} is not in openapi.json", spec.name));
            assert_eq!(
                scope.as_deref(),
                Some(oc_server::authz::scope_name(spec.scope)),
                "{}: {op} has another scope",
                spec.name
            );
            assert!(
                routes.contains(&(method.clone(), path.clone())),
                "{op}: {method} {path} is not routed"
            );
            // The operation runs the tool's own step, and is a write exactly when the tool is.
            assert_eq!(ops::is_write(op), !spec.read_only, "{op}");
            assert_eq!(ops::scope_of(op), Some(spec.scope), "{op}");
        }
    }
}

#[tokio::test]
async fn tools_answer_what_their_operations_answer() {
    let (addr, _state) = serve(on).await;
    let f = |file: &str, rest: &str| format!("/api/v1/files/{file}{rest}");
    // Both files start equal.
    for file in [A, B] {
        api(
            &addr,
            "POST",
            &f(file, "/blocks:batch"),
            Some(
                json!({"ops": [{"op": "append", "markdown": "# Plan\n\nAlpha item\n\nBeta item"}]}),
            ),
        )
        .await;
    }

    // ---- writes: MCP on A, the API on B, the same input ----
    let patch = json!({"ops": [{"op": "append", "markdown": "Gamma item"}], "mode": "direct"});
    let m = mcp(
        &addr,
        "canvas_patch",
        json!({"fileId": A, "ops": patch["ops"], "mode": "direct"}),
    )
    .await;
    let a = api(&addr, "POST", &f(B, "/blocks:batch"), Some(patch)).await;
    same_modulo_ids(&m, &a, "canvas_patch / batchBlocks");

    let db = json!({"name": "Tasks", "fields": [{"name": "Task", "type": "title"}, {"name": "Pts", "type": "number"}],
        "rows": [{"values": {"Task": "a", "Pts": 1}}]});
    let mut args = db.clone();
    args["fileId"] = json!(A);
    let m = mcp(&addr, "db_create", args).await;
    let a = api(&addr, "POST", &f(B, "/databases"), Some(db)).await;
    same_modulo_ids(&m, &a, "db_create / createDatabase");
    let (db_a, db_b) = (
        m["dbId"].as_str().unwrap().to_string(),
        a["dbId"].as_str().unwrap().to_string(),
    );

    let m = mcp(
        &addr,
        "db_add_field",
        json!({"fileId": A, "dbId": db_a, "name": "Owner", "type": "text"}),
    )
    .await;
    let a = api(
        &addr,
        "POST",
        &f(B, &format!("/databases/{db_b}/fields")),
        Some(json!({"name": "Owner", "type": "text"})),
    )
    .await;
    same_modulo_ids(&m, &a, "db_add_field / addField");

    let rows = json!([{"values": {"Task": "b", "Pts": 2}}]);
    let m = mcp(
        &addr,
        "db_upsert_rows",
        json!({"fileId": A, "dbId": db_a, "rows": rows}),
    )
    .await;
    let a = api(
        &addr,
        "POST",
        &f(B, &format!("/databases/{db_b}/rows:upsert")),
        Some(json!({"rows": rows})),
    )
    .await;
    same_modulo_ids(&m, &a, "db_upsert_rows / upsertRows");

    // board_add_shapes without a board is createBoard, with one addShapes.
    let shapes = json!([{"kind": "sticky", "text": "Idea"}, {"kind": "rect", "text": "Box"}]);
    let m = mcp(
        &addr,
        "board_add_shapes",
        json!({"fileId": A, "shapes": shapes, "layout": "grid"}),
    )
    .await;
    let a = api(
        &addr,
        "POST",
        &f(B, "/boards"),
        Some(json!({"shapes": shapes, "layout": "grid"})),
    )
    .await;
    same_modulo_ids(&m, &a, "board_add_shapes / createBoard");
    let (board_a, board_b) = (
        m["boardId"].as_str().unwrap().to_string(),
        a["boardId"].as_str().unwrap().to_string(),
    );
    let more = json!([{"kind": "ellipse", "text": "Later"}]);
    let m = mcp(
        &addr,
        "board_add_shapes",
        json!({"fileId": A, "boardId": board_a, "shapes": more}),
    )
    .await;
    let a = api(
        &addr,
        "POST",
        &f(B, &format!("/boards/{board_b}/shapes")),
        Some(json!({"shapes": more})),
    )
    .await;
    same_modulo_ids(&m, &a, "board_add_shapes / addShapes");

    let first = |file: &str| {
        let addr = addr.clone();
        let file = file.to_string();
        async move {
            let r = api(&addr, "GET", &format!("/api/v1/files/{file}"), None).await;
            r["blocks"][1]["blockId"].as_str().unwrap().to_string()
        }
    };
    let (blk_a, blk_b) = (first(A).await, first(B).await);
    let m = mcp(
        &addr,
        "comment_add",
        json!({"fileId": A, "blockId": blk_a, "text": "Why?"}),
    )
    .await;
    let a = api(
        &addr,
        "POST",
        &f(B, "/comments"),
        Some(json!({"blockId": blk_b, "text": "Why?"})),
    )
    .await;
    same_modulo_ids(&m, &a, "comment_add / addComment");

    // The two files now read the same (board pictures carry the board's own id inside their
    // data URI, so they are compared without it).
    let no_images = |mut v: Value| {
        if let Some(md) = v["markdown"].as_str() {
            let mut out = String::new();
            let mut rest = md;
            while let Some(i) = rest.find("(data:image/") {
                out.push_str(&rest[..i]);
                out.push_str("(<image>)");
                rest = &rest[i..];
                rest = &rest[rest.find(')').map_or(rest.len(), |j| j + 1)..];
            }
            out.push_str(rest);
            v["markdown"] = json!(out);
        }
        v
    };
    for fmt in ["markdown", "outline"] {
        let ra = no_images(api(&addr, "GET", &f(A, &format!("?format={fmt}")), None).await);
        let rb = no_images(api(&addr, "GET", &f(B, &format!("?format={fmt}")), None).await);
        same_modulo_ids(&ra, &rb, &format!("A and B as {fmt}"));
    }

    // ---- reads: the same file, the same input, the same JSON ----
    let reads: Vec<(&str, Value, String)> = vec![
        (
            "canvas_read",
            json!({"format": "json"}),
            f(A, "?format=json"),
        ),
        (
            "canvas_read",
            json!({"format": "markdown"}),
            f(A, "?format=markdown"),
        ),
        (
            "canvas_read",
            json!({"format": "outline"}),
            f(A, "?format=outline"),
        ),
        (
            "canvas_find",
            json!({"query": "item"}),
            f(A, "/blocks:find?q=item"),
        ),
        (
            "canvas_find",
            json!({"query": "item", "types": ["paragraph"], "limit": 2}),
            f(A, "/blocks:find?q=item&types=paragraph&limit=2"),
        ),
        ("db_describe", json!({}), f(A, "/databases")),
        (
            "board_read",
            json!({"boardId": board_a}),
            f(A, &format!("/boards/{board_a}/shapes")),
        ),
        ("comment_list", json!({}), f(A, "/comments")),
        (
            "comment_list",
            json!({"resolved": false}),
            f(A, "/comments?resolved=false"),
        ),
        ("members_list", json!({}), f(A, "/members")),
        (
            "members_list",
            json!({"q": "a", "limit": 5}),
            f(A, "/members?q=a&limit=5"),
        ),
    ];
    for (tool, mut args, path) in reads {
        args["fileId"] = json!(A);
        let m = mcp(&addr, tool, args.clone()).await;
        let a = api(&addr, "GET", &path, None).await;
        assert_eq!(m, a, "{tool} {args} vs GET {path}");
    }
    // db_query and queryRows: the same rows; paging tokens differ by design (the API signs a
    // cursor, MCP answers an offset).
    let m = mcp(
        &addr,
        "db_query",
        json!({"fileId": A, "dbId": db_a, "sorts": [{"f": "Pts", "dir": "desc"}], "limit": 1}),
    )
    .await;
    let sort = "%5B%7B%22f%22%3A%22Pts%22%2C%22dir%22%3A%22desc%22%7D%5D";
    let a = api(
        &addr,
        "GET",
        &f(A, &format!("/databases/{db_a}/rows?sort={sort}&limit=1")),
        None,
    )
    .await;
    assert_eq!(m["rows"], a["rows"], "db_query / queryRows");
    assert!(
        m["rows"][0]["values"]
            .as_object()
            .unwrap()
            .values()
            .any(|v| v == 2),
        "{m}"
    );
    assert_eq!(a["has_more"], true);
}

#[tokio::test]
async fn mcp_writes_share_the_api_file_write_bucket() {
    let (addr, _state) = serve(tight).await;
    let path = format!("/api/v1/files/{A}/blocks:batch");
    let body = json!({"ops": [{"op": "append", "markdown": "x"}]});
    // file_burst = 2: the API takes both tokens...
    api(&addr, "POST", &path, Some(body.clone())).await;
    api(&addr, "POST", &path, Some(body.clone())).await;
    // ...so an MCP write to the same file is refused, while a read still runs.
    let (s, _) = mcp_raw(
        &addr,
        "canvas_patch",
        json!({"fileId": A, "ops": body["ops"]}),
        None,
    )
    .await;
    assert_eq!(s, 429);
    let (s, r) = mcp_raw(&addr, "canvas_read", json!({"fileId": A}), None).await;
    assert_eq!((s, &r["isError"]), (200, &json!(false)), "{r}");
    // Another file has its own bucket.
    let (s, r) = mcp_raw(
        &addr,
        "canvas_patch",
        json!({"fileId": B, "ops": body["ops"]}),
        None,
    )
    .await;
    assert_eq!((s, &r["isError"]), (200, &json!(false)), "{r}");
}

#[tokio::test]
async fn mcp_writes_use_the_api_idempotency_store() {
    let (addr, _state) = serve(on).await;
    let args =
        json!({"fileId": A, "ops": [{"op": "append", "markdown": "Once"}], "mode": "direct"});
    let meta = json!({"idempotencyKey": "job-7"});
    let (_, first) = mcp_raw(&addr, "canvas_patch", args.clone(), Some(meta.clone())).await;
    assert_eq!(first["isError"], false, "{first}");
    assert!(first.get("_meta").is_none());
    let (_, again) = mcp_raw(&addr, "canvas_patch", args.clone(), Some(meta.clone())).await;
    assert_eq!(again["structuredContent"], first["structuredContent"]);
    assert_eq!(again["_meta"]["idempotencyReplayed"], true);
    // Applied once.
    let read = api(&addr, "GET", &format!("/api/v1/files/{A}"), None).await;
    assert_eq!(read["blocks"].as_array().unwrap().len(), 1, "{read}");
    // The same key with other input is refused, as on the API.
    let mut other = args.clone();
    other["ops"][0]["markdown"] = json!("Twice?");
    let (_, r) = mcp_raw(&addr, "canvas_patch", other, Some(meta)).await;
    assert_eq!(r["isError"], true);
    assert_eq!(r["structuredContent"]["code"], "BAD_INPUT", "{r}");
    assert!(
        r["structuredContent"]["message"]
            .as_str()
            .unwrap()
            .starts_with("IDEMPOTENCY_KEY_REUSED"),
        "{r}"
    );
    // Without a key nothing changes for existing clients: each call applies.
    mcp(&addr, "canvas_patch", args.clone()).await;
    mcp(&addr, "canvas_patch", args).await;
    let read = api(&addr, "GET", &format!("/api/v1/files/{A}"), None).await;
    assert_eq!(read["blocks"].as_array().unwrap().len(), 3);
}
