// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Server-side import (docs/23 FC-10): `POST /v1/import?format=md|html|csv&ticket=` and
//! `POST /v1/files/:id/import`, gated by `[host.flags] import_formats` and `OC_IMPORT=off`.
mod common;

use common::*;
use oc_server::SharedState;
use oc_server::grant::Role;
use serde_json::{Value, json};

fn all_formats(h: &mut oc_server::hosts::HostConfig) {
    h.api_key = Some("test-api-key".into());
    h.flags.insert(
        "import_formats".into(),
        toml::Value::Array(vec![
            "md".into(),
            "html".into(),
            "csv".into(),
            "drawio".into(),
            "excalidraw".into(),
        ]),
    );
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../oc-model/tests/fixtures/import/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

async fn serve_import(
    tweak: impl FnOnce(&mut oc_server::hosts::HostConfig),
    import_off: bool,
) -> (String, SharedState) {
    let (base, _h) = mock_host().await;
    let state = app_full(&base, room_cfg(), &temp_db(), tweak, |c| {
        c.import_off = import_off
    })
    .await;
    (serve_state(state.clone()).await, state)
}

async fn ticket(state: &SharedState, role: Role) -> String {
    let g = grant("u_a", role);
    let t = ulid::Ulid::new().to_string();
    let exp = oc_server::util::now_secs() + 600;
    state.store.insert_session(&t, &g, exp, 0).await.unwrap();
    t
}

async fn import(addr: &str, t: &str, query: &str, body: impl Into<reqwest::Body>) -> (u16, Value) {
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/v1/import?ticket={t}&{query}"))
        .body(body)
        .send()
        .await
        .unwrap();
    let s = res.status().as_u16();
    (s, res.json().await.unwrap_or(Value::Null))
}

async fn doc(state: &SharedState) -> Value {
    server_json(state).await
}

#[tokio::test]
async fn markdown_imports_at_the_end_and_after_a_block() {
    let (addr, state) = serve_import(all_formats, false).await;
    let mut peer = Peer::join(&state, grant("u_b", Role::Edit)).await;
    peer.settle().await;
    let t = ticket(&state, Role::Edit).await;
    let (s, v) = import(&addr, &t, "format=md", "# Plan\n\nHello **bold**").await;
    assert_eq!(s, 200, "{v}");
    let first = v["blockIds"][0].as_str().unwrap().to_string();
    let (s, _) = import(&addr, &t, "format=md", "last").await;
    assert_eq!(s, 200);
    let (s, v) = import(&addr, &t, &format!("format=md&blockId={first}"), "middle").await;
    assert_eq!(s, 200, "{v}");
    peer.settle().await;
    let j = json_of(&peer.doc);
    let md = oc_model::export::to_markdown(&j);
    assert!(md.starts_with("# Plan\n"), "{md}");
    assert!(md.contains("**bold**"), "{md}");
    let (m, l) = (md.find("middle").unwrap(), md.find("last").unwrap());
    assert!(m < l, "{md}");
}

#[tokio::test]
async fn html_is_sanitised() {
    let (addr, state) = serve_import(all_formats, false).await;
    let t = ticket(&state, Role::Edit).await;
    let (s, v) = import(
        &addr,
        &t,
        "format=html",
        r#"<h2 onclick="alert(1)">Notes</h2><p style="color:red">see <a href="javascript:alert(1)">this</a>
        and <a href="https://ok.dev">that</a></p><img src="x" onerror="alert(2)"><script>alert(3)</script>"#,
    )
    .await;
    assert_eq!(s, 200, "{v}");
    let j = doc(&state).await.to_string();
    assert!(j.contains("Notes") && j.contains("https://ok.dev"), "{j}");
    for bad in ["javascript:", "onerror", "onclick", "alert", "color:red"] {
        assert!(!j.contains(bad), "{bad} in {j}");
    }
}

#[tokio::test]
async fn csv_becomes_a_database_with_detected_types() {
    let (addr, state) = serve_import(all_formats, false).await;
    let t = ticket(&state, Role::Edit).await;
    let csv = "Task,Points,Due,Done,Status,Notes\n\
        Write,3,2026-01-05,true,Open,\"a, b\"\n\
        Test,5.5,2026-02-01,false,Closed,\"say \"\"hi\"\"\"\n\
        Ship,8,2026-03-01,yes,Open,free text\n\
        Docs,1,2026-03-02,no,Open,more text\n";
    let (s, v) = import(&addr, &t, "format=csv", csv).await;
    assert_eq!(s, 200, "{v}");
    let j = doc(&state).await;
    let (_, db) = j["databases"].as_object().unwrap().iter().next().unwrap();
    let types: Vec<&str> = db["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["type"].as_str().unwrap())
        .collect();
    assert_eq!(
        types,
        ["title", "number", "date", "checkbox", "select", "text"]
    );
    assert_eq!(db["order"].as_array().unwrap().len(), 4);
    let s = db.to_string();
    assert!(s.contains("say \\\"hi\\\"") && s.contains("a, b"), "{s}");
    assert!(
        j["content"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["type"] == "database"),
        "{j}"
    );
}

#[tokio::test]
async fn limits_are_enforced() {
    let (addr, state) = serve_import(all_formats, false).await;
    let t = ticket(&state, Role::Edit).await;
    let mut rows = String::from("a,b\n");
    for i in 0..10_001 {
        rows.push_str(&format!("{i},x\n"));
    }
    assert_eq!(import(&addr, &t, "format=csv", rows).await.0, 413);
    let wide = (0..201)
        .map(|i| format!("c{i}"))
        .collect::<Vec<_>>()
        .join(",")
        + "\n";
    assert_eq!(import(&addr, &t, "format=csv", wide).await.0, 413);
    let big = "x".repeat(6 * 1024 * 1024);
    assert_eq!(import(&addr, &t, "format=md", big).await.0, 413);
    assert_eq!(import(&addr, &t, "format=pdf", "x").await.0, 400);
    assert!(
        doc(&state).await["databases"]
            .as_object()
            .is_none_or(|d| d.is_empty())
    );
}

#[tokio::test]
async fn only_editors_may_import() {
    let (addr, state) = serve_import(all_formats, false).await;
    for role in [Role::View, Role::Comment] {
        let t = ticket(&state, role).await;
        assert_eq!(import(&addr, &t, "format=md", "nope").await.0, 403);
    }
    assert!(!doc(&state).await.to_string().contains("nope"));
}

#[tokio::test]
async fn import_is_off_by_default_and_per_format() {
    let (addr, state) = serve_import(|_| {}, false).await;
    let t = ticket(&state, Role::Edit).await;
    assert_eq!(import(&addr, &t, "format=md", "x").await.0, 403);
    let (addr, state) = serve_import(
        |h| {
            h.flags.insert(
                "import_formats".into(),
                toml::Value::Array(vec!["md".into()]),
            );
        },
        false,
    )
    .await;
    let t = ticket(&state, Role::Edit).await;
    assert_eq!(import(&addr, &t, "format=md", "x").await.0, 200);
    assert_eq!(import(&addr, &t, "format=html", "<p>x</p>").await.0, 403);
    assert_eq!(import(&addr, &t, "format=csv", "a\n1\n").await.0, 403);
}

#[tokio::test]
async fn the_kill_switch_wins() {
    let (addr, state) = serve_import(all_formats, true).await;
    let t = ticket(&state, Role::Edit).await;
    assert_eq!(import(&addr, &t, "format=md", "x").await.0, 403);
}

#[test]
fn unknown_import_formats_are_refused_at_load() {
    let src = r#"
[[host]]
id = "h"
name = "H"
jwt_secret = "0123456789abcdef0123456789abcdef"
callback_base = "http://h"
allowed_origins = ["http://h"]
[host.flags]
import_formats = ["md", "pdf"]
"#;
    let Err(e) = oc_server::hosts::Hosts::parse(src, None) else {
        panic!("an unknown import format must be refused")
    };
    let e = e.to_string();
    assert!(e.contains("import_formats"), "{e}");
}

#[tokio::test]
async fn host_rest_import() {
    let (addr, state) = serve_import(all_formats, false).await;
    let res = reqwest::Client::new()
        .post(format!(
            "http://{addr}/v1/files/{FILE}/import?format=md&author=u_api"
        ))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", "test-api-key")
        .header("X-OpenCanvas-Callback-Token", "cb-bot")
        .body("From the host")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 200);
    let v: Value = res.json().await.unwrap();
    assert_eq!(v["live"], false, "{v}");
    assert!(v["version"].is_string(), "saved to the host: {v}");
    let _ = (state, json!(null));
}

// ---------- DGM-15: draw.io and Excalidraw ----------

fn board_shapes(j: &Value, board: &str) -> serde_json::Map<String, Value> {
    j["boards"][board]["shapes"]
        .as_object()
        .cloned()
        .unwrap_or_default()
}

fn from_src<'a>(shapes: &'a serde_json::Map<String, Value>, id: &str) -> (&'a String, &'a Value) {
    shapes
        .iter()
        .find(|(_, s)| s["props"]["sourceId"] == id)
        .unwrap_or_else(|| panic!("no shape from {id}"))
}

#[tokio::test]
async fn diagram_dry_run_reports_and_adds_nothing() {
    let (addr, state) = serve_import(all_formats, false).await;
    let t = ticket(&state, Role::Edit).await;
    let (s, v) = import(
        &addr,
        &t,
        "format=drawio&dryRun=1",
        fixture("architecture.drawio"),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["dryRun"], true);
    assert_eq!(v["report"]["counts"]["connectors"], 3, "{v}");
    assert_eq!(v["report"]["items"][0]["code"], "stencil", "{v}");
    assert_eq!(v["report"]["pages"], json!(["Service map"]));
    assert!(v["blockIds"].is_null());
    let j = doc(&state).await;
    assert!(j["boards"].as_object().is_none_or(|b| b.is_empty()), "{j}");
}

#[tokio::test]
async fn drawio_import_creates_a_board_block_with_bound_connectors() {
    let (addr, state) = serve_import(all_formats, false).await;
    let mut peer = Peer::join(&state, grant("u_b", Role::Edit)).await;
    peer.settle().await;
    let t = ticket(&state, Role::Edit).await;
    let (s, v) = import(&addr, &t, "format=drawio", fixture("flowchart.drawio")).await;
    assert_eq!(s, 200, "{v}");
    let board = v["boardId"].as_str().unwrap().to_string();
    assert_eq!(v["blockIds"].as_array().unwrap().len(), 1, "{v}");
    assert_eq!(v["shapes"], 6);
    assert_eq!(v["connectors"], 6);
    peer.settle().await;
    let j = json_of(&peer.doc);
    assert!(
        j["content"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["type"] == "board" && b["attrs"]["boardId"] == board),
        "{j}"
    );
    let shapes = board_shapes(&j, &board);
    assert_eq!(shapes.len(), 12);
    assert_eq!(j["boards"][&board]["order"].as_array().unwrap().len(), 12);
    let (start, _) = from_src(&shapes, "start");
    let (cart, cart_s) = from_src(&shapes, "cart");
    let (_, e1) = from_src(&shapes, "e1");
    assert_eq!(e1["start"]["shapeId"], json!(start));
    assert_eq!(e1["end"]["shapeId"], json!(cart));
    assert_eq!(e1["route"], "elbow");
    assert_eq!(cart_s["text"], "Load cart\nfrom & session");
    // Placed at the board's top left, keeping relative positions (waypoints too).
    let min = |k: &str| {
        shapes
            .values()
            .filter(|s| s["type"] != "arrow")
            .filter_map(|s| s[k].as_f64())
            .fold(f64::MAX, f64::min)
    };
    assert_eq!((min("x"), min("y")), (40.0, 40.0));
    let (_, e4) = from_src(&shapes, "e4");
    let (_, stock) = from_src(&shapes, "stock");
    assert_eq!(
        e4["via"][0][0].as_f64().unwrap() - stock["x"].as_f64().unwrap(),
        290.0 - 130.0
    );
}

#[tokio::test]
async fn diagram_import_adds_to_an_open_board_to_the_right() {
    let (addr, state) = serve_import(all_formats, false).await;
    let t = ticket(&state, Role::Edit).await;
    let (s, v) = import(
        &addr,
        &t,
        "format=drawio&page=1",
        fixture("multipage.drawio"),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    let board = v["boardId"].as_str().unwrap().to_string();
    let j = doc(&state).await;
    let before = board_shapes(&j, &board);
    assert!(
        before.values().any(|s| s["text"] == "Sequence box"),
        "page 2 was chosen"
    );
    let right = before
        .values()
        .map(|s| s["x"].as_f64().unwrap_or(0.0) + s["w"].as_f64().unwrap_or(0.0))
        .fold(f64::MIN, f64::max);
    let (s, v) = import(
        &addr,
        &t,
        &format!("format=excalidraw&boardId={board}"),
        fixture("board.excalidraw"),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert!(
        v["blockIds"].as_array().is_none_or(|b| b.is_empty()),
        "no new block: {v}"
    );
    let ids: Vec<String> = v["shapeIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i.as_str().unwrap().to_string())
        .collect();
    let j = doc(&state).await;
    let after = board_shapes(&j, &board);
    assert_eq!(after.len(), before.len() + ids.len());
    for id in &ids {
        assert!(!before.contains_key(id));
        let x = after[id]["x"].as_f64().unwrap();
        assert!(x > right, "{id} at {x}, the board ends at {right}");
    }
    // Groups, containers and bindings point at the new ids.
    let (_, r1) = from_src(&after, "r1");
    let (frame, _) = from_src(&after, "frame1");
    assert_eq!(r1["props"]["parent"], json!(frame));
    let (_, a1) = from_src(&after, "a1");
    assert!(ids.contains(&a1["start"]["shapeId"].as_str().unwrap().to_string()));
    assert!(
        r1["group"].as_str().is_some_and(|g| g != "g1"),
        "group ids are new: {r1}"
    );
    let (s, _) = import(
        &addr,
        &t,
        "format=excalidraw&boardId=nope",
        fixture("board.excalidraw"),
    )
    .await;
    assert_eq!(s, 404);
}

#[tokio::test]
async fn hostile_diagram_files_are_refused_with_a_reason() {
    let (addr, state) = serve_import(all_formats, false).await;
    let t = ticket(&state, Role::Edit).await;
    let laughs = r#"<!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><mxfile><diagram name="x">&b;</diagram></mxfile>"#;
    let (s, v) = import(&addr, &t, "format=drawio", laughs).await;
    assert_eq!(s, 400, "{v}");
    assert_eq!(v["error"]["code"], "IMPORT_INVALID");
    assert!(
        v["error"]["message"].as_str().unwrap().contains("entities"),
        "{v}"
    );
    let (s, _) = import(
        &addr,
        &t,
        "format=drawio&page=5",
        fixture("multipage.drawio"),
    )
    .await;
    assert_eq!(s, 400);
    let big = format!(
        "{{\"type\":\"excalidraw\",\"pad\":\"{}\"}}",
        "x".repeat(6 << 20)
    );
    assert_eq!(
        import(&addr, &t, "format=excalidraw&dryRun=1", big)
            .await
            .0,
        413
    );
    let (s, v) = import(
        &addr,
        &t,
        "format=excalidraw",
        r#"{"type":"excalidraw","elements":[]}"#,
    )
    .await;
    assert_eq!(s, 400, "nothing to import: {v}");
    assert!(
        doc(&state).await["boards"]
            .as_object()
            .is_none_or(|b| b.is_empty())
    );
}
