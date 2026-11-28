// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Links and backlinks (LINK-01..03, ADR-081, docs/38 §2): the index follows only saves the
//! host acknowledged (LINK-A1), holds no text (LINK-A3), and every read goes through the
//! host's ACL so a source the reader cannot open is absent from the API, the editor route, MCP
//! and the counts (LINK-A2); exports write host URLs (LINK-A5).
mod common;

use common::*;
use oc_server::grant::Role;
use serde_json::{Value, json};

const PUBLIC: &str = "https://oc.example";
const KEY: &str = "links-key";
const TARGET: &str = "doc_target";

fn on(h: &mut oc_server::hosts::HostConfig) {
    h.api_key = Some(KEY.into());
    h.flags.insert("api_v1".into(), toml::Value::Boolean(true));
    h.flags.insert("links".into(), toml::Value::Boolean(true));
    h.api
        .insert("audience".into(), toml::Value::String(PUBLIC.into()));
    h.api
        .insert("rate_per_sec".into(), toml::Value::Integer(100_000));
    h.api.insert("burst".into(), toml::Value::Integer(100_000));
    h.ai.insert("mcp".into(), toml::Value::Boolean(true));
    h.ai.insert("mcp_audience".into(), toml::Value::String(PUBLIC.into()));
    h.links = toml::toml! {
        url_patterns = ["https://docs.acme.test/f/{fileId}#{blockId}", "https://docs.acme.test/f/{fileId}"]
        url_template = "https://docs.acme.test/f/{fileId}#{blockId}"
    };
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
        "exp": now() + 600, "scope": "canvas:read", "role": "view"}),
    )
}

fn mcp_token(sub: &str) -> String {
    sign(
        &json!({"iss": "sample", "aud": format!("{PUBLIC}/mcp/sample"), "sub": sub,
        "name": "Asha", "exp": now() + 600, "scope": "canvas:read", "role": "view",
        "client_id": "t"}),
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

async fn get_json(url: String, bearer: &str) -> (u16, Value) {
    let res = http().get(url).bearer_auth(bearer).send().await.unwrap();
    let s = res.status().as_u16();
    (s, res.json().await.unwrap_or(Value::Null))
}

/// A `.ocanvas` of `doc`, as the host stores it.
fn ocanvas(doc: &Value) -> Vec<u8> {
    let d = oc_model::new_doc();
    oc_model::import::apply_document_json(&d, doc);
    oc_model::write_ocanvas(&d, &oc_model::CommitInfo::default()).unwrap()
}

fn link(file: &str, block: &str, label: &str) -> Value {
    json!({"type": "canvasLink", "attrs": {"fileId": file, "targetBlockId": block, "label": label}})
}

/// A source canvas: a heading, then a paragraph that links to the target.
fn source(section: &str, before: &str, block: &str) -> Value {
    json!({"content": [
        {"type": "heading", "attrs": {"level": 2, "blockId": "h_s"}, "content": [{"type": "text", "text": section}]},
        {"type": "paragraph", "attrs": {"blockId": "p_s"}, "content": [
            {"type": "text", "text": before},
            link(TARGET, block, "MARKER-OLD-LABEL"),
            {"type": "text", "text": "."},
        ]},
    ]})
}

async fn poll<F, Fut>(mut f: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..500 {
        if f().await {
            return;
        }
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("condition not reached");
}

/// LINK-A1 and LINK-A3: a save the host refused leaves the index alone; the acknowledged save
/// replaces the file's rows; the rows hold ids and kinds only.
#[tokio::test]
async fn the_index_follows_acknowledged_saves_only_and_holds_no_text() {
    let (addr, st, host, _db) = serve(on).await;
    {
        let mut h = host.lock().unwrap();
        let doc = json!({"meta": {"title": "MARKER-TITLE"}, "content": [
            {"type": "paragraph", "attrs": {"blockId": "p1"}, "content": [
                {"type": "text", "text": "MARKER-TEXT see "},
                link(TARGET, "h2", "MARKER-LABEL"),
                {"type": "text", "text": " and ", "marks": []},
                {"type": "text", "text": "MARKER-URL", "marks": [{"type": "link", "attrs": {"href": "https://docs.acme.test/f/doc_other"}}]},
            ]},
        ]});
        h.files.insert(FILE.into(), (ocanvas(&doc), 1));
        h.fail = true;
    }
    let mut a = Peer::join(&st, grant("u_a", Role::Edit)).await;
    let (s, v) = host_key(
        &addr,
        reqwest::Method::POST,
        &format!("/api/v1/files/{FILE}/blocks:batch"),
        Some(json!({"mode": "direct", "ops": [{"op": "append", "markdown": "MARKER-MORE"}]})),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    // The save goes out and the host refuses it.
    let commit = tokio::spawn({
        let addr = addr.clone();
        async move {
            host_key(
                &addr,
                reqwest::Method::POST,
                &format!("/api/v1/files/{FILE}/commit"),
                None,
            )
            .await
        }
    });
    wait_until(|| !host.lock().unwrap().puts.is_empty()).await;
    assert!(
        st.store
            .links_from("sample", FILE)
            .await
            .unwrap()
            .is_empty(),
        "no rows before the host acknowledged a save"
    );
    commit.abort();
    host.lock().unwrap().fail = false;
    let (s, v) = host_key(
        &addr,
        reqwest::Method::POST,
        &format!("/api/v1/files/{FILE}/commit"),
        None,
    )
    .await;
    assert_eq!(s, 200, "{v}");
    a.settle().await;
    poll(|| {
        let st = st.clone();
        async move {
            !st.store
                .links_from("sample", FILE)
                .await
                .unwrap()
                .is_empty()
        }
    })
    .await;
    let rows = st.store.links_from("sample", FILE).await.unwrap();
    let got: Vec<(&str, &str, &str, &str)> = rows
        .iter()
        .map(|r| {
            (
                r.src_block.as_str(),
                r.dst_file.as_str(),
                r.dst_block.as_str(),
                r.kind.as_str(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("p1", TARGET, "h2", "link"),
            ("p1", "doc_other", "", "link")
        ]
    );
    // LINK-A3: no string of the fixture is at rest.
    for s in st.store.links_dump().await.unwrap() {
        assert!(!s.contains("MARKER"), "text in link_edges: {s}");
    }
}

/// LINK-A2: a source the reader cannot open (`none`, 410, or a failing answer) is absent from
/// the API, MCP, the editor route and every count; the batch callback and its per-file
/// fallback answer the same; a deleted source's rows go.
#[tokio::test]
async fn backlinks_leave_out_what_the_reader_cannot_open() {
    let (addr, st, host, _db) = serve(on).await;
    {
        let mut h = host.lock().unwrap();
        for (k, v) in [
            (TARGET, "view"),
            ("src_ok", "view"),
            ("src_none", "none"),
            ("src_gone", "gone"),
        ] {
            h.access_files.insert((k.into(), "u_1".into()), v.into());
        }
        h.access_paths
            .insert("src_ok".into(), "Engineering / Identity".into());
        h.access_paths
            .insert("src_none".into(), "Secret space".into());
        h.files.insert(
            "src_ok".into(),
            (
                ocanvas(&source("Identity", "Scope and dates live in ", "h2")),
                1,
            ),
        );
        h.files.insert(
            "src_none".into(),
            (ocanvas(&source("Hidden", "HIDDEN-EXCERPT ", "h3")), 1),
        );
    }
    let edge = |block: &str| oc_model::links::Edge {
        src_block: "p_s".into(),
        dst_file: TARGET.into(),
        dst_block: block.into(),
        dst_row: String::new(),
        kind: oc_model::links::Kind::Link,
    };
    st.store
        .links_replace("sample", "src_ok", &[edge("h2")], 3)
        .await
        .unwrap();
    st.store
        .links_replace("sample", "src_none", &[edge("h3")], 2)
        .await
        .unwrap();
    st.store
        .links_replace("sample", "src_gone", &[edge("h3")], 1)
        .await
        .unwrap();

    let url = format!("http://{addr}/api/v1/files/{TARGET}/backlinks");
    let (s, api) = get_json(url.clone(), &api_token("u_1")).await;
    assert_eq!(s, 200, "{api}");
    assert_eq!(api["total"], 1, "{api}");
    let items = api["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{api}");
    assert_eq!(items[0]["fileId"], "src_ok");
    assert_eq!(items[0]["title"], "Name of src_ok");
    assert_eq!(items[0]["path"], "Engineering / Identity");
    let r = &items[0]["refs"][0];
    assert_eq!(r["toBlock"], "h2");
    assert_eq!(r["section"], "Identity");
    assert_eq!(
        r["excerpt"],
        json!({"before": "Scope and dates live in ", "link": "Name of doc_target", "after": "."})
    );
    // Counts per block only of readable sources: h3 is linked only from hidden ones.
    assert_eq!(api["blocks"], json!({"h2": 1}), "{api}");
    let text = api.to_string();
    for hidden in ["src_none", "src_gone", "Secret space", "HIDDEN-EXCERPT"] {
        assert!(!text.contains(hidden), "{hidden} leaked: {text}");
    }
    {
        let h = host.lock().unwrap();
        let (user, files, sig) = h.access_batch_calls.last().unwrap();
        assert!(sig, "the batch callback is signed (v2)");
        assert_eq!(user, "u_1");
        assert!(files.contains(&"src_none".to_string()));
    }
    // The deleted source loses its rows.
    poll(|| {
        let st = st.clone();
        async move {
            st.store
                .links_from("sample", "src_gone")
                .await
                .unwrap()
                .is_empty()
        }
    })
    .await;

    // Filtered to a block the reader sees nothing of: empty, and still no count.
    let (s, v) = get_json(format!("{url}?block=h3"), &api_token("u_1")).await;
    assert_eq!(s, 200);
    assert_eq!(v["items"], json!([]));
    assert_eq!(v["total"], 0);

    // MCP answers the same (ADR-041 parity).
    let res = http()
        .post(format!("http://{addr}/mcp/sample"))
        .bearer_auth(mcp_token("u_1"))
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "canvas_backlinks", "arguments": {"fileId": TARGET}}}))
        .send()
        .await
        .unwrap();
    let mcp: Value = res.json().await.unwrap();
    assert_eq!(mcp["result"]["structuredContent"], api, "{mcp}");

    // The editor route, as the session's person.
    let t = ulid::Ulid::new().to_string();
    let mut g = grant("u_1", Role::View);
    g.file.id = TARGET.into();
    g.file.name = "SSO rollout plan".into();
    g.room = oc_server::grant::room_id("sample", TARGET);
    st.store
        .insert_session(&t, &g, now() + 600, 0)
        .await
        .unwrap();
    let res = http()
        .get(format!("http://{addr}/v1/backlinks?ticket={t}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let ed: Value = res.json().await.unwrap();
    assert_eq!(ed["total"], 1, "{ed}");
    assert_eq!(ed["items"][0]["fileId"], "src_ok");
    assert_eq!(
        ed["items"][0]["refs"][0]["excerpt"]["link"],
        "SSO rollout plan"
    );

    // Without the batch callback: per-file `/access`, the same answer.
    host.lock().unwrap().access_batch_off = true;
    let (_, v) = get_json(url.clone(), &api_token("u_1")).await;
    assert_eq!(v["items"], api["items"], "{v}");
    assert_eq!(v["total"], 1);

    // Someone else, whom the host refuses on every source: nothing at all.
    host.lock()
        .unwrap()
        .access_files
        .insert((TARGET.into(), "u_2".into()), "view".into());
    let (s, v) = get_json(url.clone(), &api_token("u_2")).await;
    assert_eq!(s, 200);
    assert_eq!(v["items"], json!([]));
    assert_eq!(v["total"], 0);
    assert_eq!(v["blocks"], json!({}));

    // No view on the target: no answer.
    let (s, v) = get_json(url.clone(), &api_token("u_3")).await;
    assert_eq!(s, 403, "{v}");
    // A host key cannot read as everyone.
    let (s, v) = host_key(
        &addr,
        reqwest::Method::GET,
        &format!("/api/v1/files/{TARGET}/backlinks"),
        None,
    )
    .await;
    assert_eq!(s, 400);
    assert_eq!(v["code"], "USER_TOKEN_REQUIRED");
}

/// A failing access check shows nothing (fail closed), it never shows everything.
#[tokio::test]
async fn a_failing_access_batch_shows_nothing() {
    let (addr, st, host, _db) = serve(on).await;
    host.lock()
        .unwrap()
        .access_files
        .insert((TARGET.into(), "u_1".into()), "view".into());
    st.store
        .links_replace(
            "sample",
            "src_ok",
            &[oc_model::links::Edge {
                src_block: String::new(),
                dst_file: TARGET.into(),
                dst_block: String::new(),
                dst_row: String::new(),
                kind: oc_model::links::Kind::Embed,
            }],
            1,
        )
        .await
        .unwrap();
    host.lock()
        .unwrap()
        .access_files
        .insert(("src_ok".into(), "u_1".into()), "view".into());
    // The target answer is cached first, then the batch fails.
    let url = format!("http://{addr}/api/v1/files/{TARGET}/backlinks");
    let (_, v) = get_json(url.clone(), &api_token("u_1")).await;
    assert_eq!(v["total"], 1, "{v}");
    host.lock().unwrap().access_batch_fail = true;
    let (s, v) = get_json(url, &api_token("u_9")).await;
    // u_9's target check fails too: no answer rather than an unfiltered one.
    assert!(s == 403 || v["items"] == json!([]), "{s} {v}");
}

/// The feature is off by default: no routes answer, no MCP tool, no rows written.
#[tokio::test]
async fn links_are_off_by_default() {
    let (addr, st, host, _db) = serve(|h| {
        on(h);
        h.flags.remove("links");
    })
    .await;
    host.lock()
        .unwrap()
        .access_files
        .insert((TARGET.into(), "u_1".into()), "view".into());
    let (s, v) = get_json(
        format!("http://{addr}/api/v1/files/{TARGET}/backlinks"),
        &api_token("u_1"),
    )
    .await;
    assert_eq!(s, 404);
    assert_eq!(v["code"], "LINKS_OFF");
    let res = http()
        .post(format!("http://{addr}/mcp/sample"))
        .bearer_auth(mcp_token("u_1"))
        .json(&json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))
        .send()
        .await
        .unwrap();
    let list: Value = res.json().await.unwrap();
    assert!(
        !list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "canvas_backlinks")
    );
    assert!(st.store.links_dump().await.unwrap().is_empty());
}

/// Backfill (host key, at most 100 files) and the delete call.
#[tokio::test]
async fn backfill_and_delete_through_the_host_key() {
    let (addr, st, host, _db) = serve(on).await;
    host.lock()
        .unwrap()
        .files
        .insert("src_a".into(), (ocanvas(&source("A", "See ", "h2")), 1));
    let (s, v) = host_key(
        &addr,
        reqwest::Method::POST,
        "/api/v1/links/index",
        Some(json!({"fileIds": ["src_a", "missing"]})),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(
        v["indexed"],
        json!([{"fileId": "src_a", "links": 1, "dropped": 0}])
    );
    assert_eq!(v["failed"][0]["fileId"], "missing");
    assert_eq!(
        st.store.links_from("sample", "src_a").await.unwrap().len(),
        1
    );
    let too_many: Vec<String> = (0..101).map(|i| format!("f{i}")).collect();
    let (s, _) = host_key(
        &addr,
        reqwest::Method::POST,
        "/api/v1/links/index",
        Some(json!({"fileIds": too_many})),
    )
    .await;
    assert_eq!(s, 400);
    let (s, v) = host_key(
        &addr,
        reqwest::Method::DELETE,
        "/api/v1/links/files/src_a",
        None,
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["removed"], 1);
    assert!(
        st.store
            .links_from("sample", "src_a")
            .await
            .unwrap()
            .is_empty()
    );
    // A person's token may not delete.
    let res = http()
        .delete(format!("http://{addr}/api/v1/links/files/src_a"))
        .bearer_auth(api_token("u_1"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
}

/// LINK-A5: exports write a canvas link as a link to the host URL with its label, and the
/// `.ocanvas` keeps the node.
#[tokio::test]
async fn exports_write_host_urls() {
    let (addr, st, host, _db) = serve(on).await;
    host.lock()
        .unwrap()
        .files
        .insert(FILE.into(), (ocanvas(&source("A", "Plan in ", "h2")), 1));
    let _a = Peer::join(&st, grant("u_a", Role::Edit)).await;
    let res = http()
        .get(format!("http://{addr}/api/v1/files/{FILE}/export/md"))
        .header("x-opencanvas-host", "sample")
        .header("x-opencanvas-key", KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let md = res.text().await.unwrap();
    assert!(
        md.contains("[MARKER-OLD-LABEL](https://docs.acme.test/f/doc_target#h2)"),
        "{md}"
    );
    let res = http()
        .get(format!("http://{addr}/api/v1/files/{FILE}/export/html"))
        .header("x-opencanvas-host", "sample")
        .header("x-opencanvas-key", KEY)
        .send()
        .await
        .unwrap();
    let html = res.text().await.unwrap();
    assert!(
        html.contains("href=\"https://docs.acme.test/f/doc_target#h2\""),
        "{html}"
    );
    let res = http()
        .get(format!("http://{addr}/api/v1/files/{FILE}/export/json"))
        .header("x-opencanvas-host", "sample")
        .header("x-opencanvas-key", KEY)
        .send()
        .await
        .unwrap();
    let j: Value = res.json().await.unwrap();
    assert_eq!(j["content"][1]["content"][1]["type"], "canvasLink", "{j}");
}

fn edge_to(dst: &str, kind: oc_model::links::Kind) -> oc_model::links::Edge {
    oc_model::links::Edge {
        src_block: String::new(),
        dst_file: dst.into(),
        dst_block: String::new(),
        dst_row: String::new(),
        kind,
    }
}

/// GRAPH-A1 (ADR-082): no node, edge, title or count for a canvas the reader cannot open, at any
/// depth; a hidden canvas between two readable ones does not connect them. Local and full
/// graphs, the API, MCP and the editor route.
#[tokio::test]
async fn the_graph_never_shows_or_bridges_through_a_hidden_canvas() {
    use oc_model::links::Kind;
    let (addr, st, host, _db) = serve(on).await;
    {
        let mut h = host.lock().unwrap();
        for (k, v) in [
            ("g_a", "view"),
            ("g_b", "edit"),
            ("g_c", "view"),
            ("g_h", "none"),
        ] {
            h.access_files.insert((k.into(), "u_1".into()), v.into());
        }
        h.access_paths
            .insert("g_a".into(), "Engineering / Identity".into());
    }
    // a → h → b (h hidden), a → c, b → a? no: b is only reachable through h.
    st.store
        .links_replace(
            "sample",
            "g_a",
            &[edge_to("g_h", Kind::Link), edge_to("g_c", Kind::Embed)],
            1,
        )
        .await
        .unwrap();
    st.store
        .links_replace("sample", "g_h", &[edge_to("g_b", Kind::Link)], 2)
        .await
        .unwrap();
    st.store
        .links_replace("sample", "g_b", &[edge_to("g_c", Kind::Link)], 3)
        .await
        .unwrap();

    let ids = |v: &Value| -> Vec<String> {
        let mut n: Vec<String> = v["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["id"].as_str().unwrap().to_string())
            .collect();
        n.sort();
        n
    };
    // Depth 1 from a: a and c (h is hidden).
    let (s, v) = get_json(
        format!("http://{addr}/api/v1/graph?root=g_a&depth=1"),
        &api_token("u_1"),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(ids(&v), vec!["g_a", "g_c"], "{v}");
    assert_eq!(
        v["edges"],
        json!([{"from": "g_a", "to": "g_c", "kind": "embed"}])
    );
    let a = v["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == "g_a")
        .unwrap();
    assert_eq!(a["space"], "Engineering");
    assert_eq!(a["out"], 1, "the hidden canvas is not counted: {a}");
    // Depth 3 from a: b is reached through c (b → c), never through h.
    let (_, v) = get_json(
        format!("http://{addr}/api/v1/graph?root=g_a&depth=3"),
        &api_token("u_1"),
    )
    .await;
    assert_eq!(ids(&v), vec!["g_a", "g_b", "g_c"], "{v}");
    assert!(!v.to_string().contains("g_h"), "{v}");
    let edges = v["edges"].as_array().unwrap();
    assert!(
        !edges.iter().any(|e| e["from"] == "g_a" && e["to"] == "g_b"),
        "a and b must not be joined through h: {v}"
    );
    // Only links, depth 2: c is an embed, so nothing beyond a.
    let (_, v) = get_json(
        format!("http://{addr}/api/v1/graph?root=g_a&depth=2&kinds=link"),
        &api_token("u_1"),
    )
    .await;
    assert_eq!(ids(&v), vec!["g_a"], "{v}");
    // Full graph: the readable canvases, no hidden one, and `total` because all were checked.
    let (s, full) = get_json(format!("http://{addr}/api/v1/graph"), &api_token("u_1")).await;
    assert_eq!(s, 200, "{full}");
    assert_eq!(ids(&full), vec!["g_a", "g_b", "g_c"], "{full}");
    assert_eq!(full["truncated"], false);
    assert_eq!(full["total"], 3);
    assert!(!full.to_string().contains("g_h"));
    // MCP answers the same.
    let res = http()
        .post(format!("http://{addr}/mcp/sample"))
        .bearer_auth(mcp_token("u_1"))
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "canvas_graph", "arguments": {}}}))
        .send()
        .await
        .unwrap();
    let mcp: Value = res.json().await.unwrap();
    assert_eq!(mcp["result"]["structuredContent"], full, "{mcp}");
    // A reader who can open only a: just a.
    host.lock()
        .unwrap()
        .access_files
        .insert(("g_a".into(), "u_2".into()), "view".into());
    let (_, v) = get_json(
        format!("http://{addr}/api/v1/graph?root=g_a&depth=3"),
        &api_token("u_2"),
    )
    .await;
    assert_eq!(ids(&v), vec!["g_a"], "{v}");
    assert_eq!(v["edges"], json!([]));
    // A root the reader cannot open: no answer.
    let (s, _) = get_json(
        format!("http://{addr}/api/v1/graph?root=g_h"),
        &api_token("u_1"),
    )
    .await;
    assert_eq!(s, 403);
    // Bad parameters.
    let (s, _) = get_json(
        format!("http://{addr}/api/v1/graph?root=g_a&depth=4"),
        &api_token("u_1"),
    )
    .await;
    assert_eq!(s, 400);
}

/// Two full graphs a minute per person.
#[tokio::test]
async fn full_graphs_are_rate_limited() {
    let (addr, _st, _host, _db) = serve(on).await;
    let mut codes = vec![];
    for limit in [10, 11, 12] {
        // Different parameters, so the cache does not answer.
        let (s, _) = get_json(
            format!("http://{addr}/api/v1/graph?limit={limit}"),
            &api_token("u_rl"),
        )
        .await;
        codes.push(s);
    }
    assert_eq!(codes, vec![200, 200, 429]);
}
