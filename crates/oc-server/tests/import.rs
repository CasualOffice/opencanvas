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
        toml::Value::Array(vec!["md".into(), "html".into(), "csv".into()]),
    );
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
