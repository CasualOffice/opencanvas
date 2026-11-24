// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Editor profiles (EDP-01, ADR-061, docs/05 §2b): `[host.editor]` is checked at start-up, the
//! session carries `editor`, and features with a server surface are enforced there. Profiles
//! never touch documents (the editor's profile tests prove content round-trips).

mod common;

use common::*;
use oc_server::ai::tools::{CanvasTools, LiveTools, ToolCtx, ToolError, WriteMode};
use oc_server::grant::Role;
use oc_server::hosts::{HostConfig, Hosts};
use serde_json::{Value, json};

const HOST: &str = "[[host]]\nid = \"h\"\nname = \"H\"\njwt_secret = \"0123456789abcdef0123456789abcdef\"\ncallback_base = \"http://h/api\"\n";

fn parse(extra: &str) -> anyhow::Result<Hosts> {
    Hosts::parse(&format!("{HOST}{extra}"), None)
}

#[test]
fn start_up_refuses_an_unknown_profile_block_or_feature() {
    let ok = parse(
        "[host.editor]\nprofile = \"meeting\"\n[host.editor.blocks]\nquick_insert = [\"core.checklist\"]\n[host.editor.features]\nai = false\n",
    )
    .unwrap();
    let e = ok.get("h").unwrap().editor();
    assert_eq!(e.profile, "meeting");
    assert_eq!(e.features.ai, Some(false));
    for (extra, says) in [
        ("[host.editor]\nprofile = \"meetings\"\n", "unknown profile"),
        (
            "[host.editor.blocks]\nenabled = [\"core.text\", \"core.kanbn\"]\n",
            "unknown block id \"core.kanbn\"",
        ),
        // An SDK type must be enabled for this host in [host.blocks].
        (
            "[host.editor.blocks]\nenabled = [\"acme.okr\"]\n",
            "unknown block id \"acme.okr\"",
        ),
        ("[host.editor.features]\nchat = true\n", "unknown feature"),
    ] {
        let Err(e) = parse(extra) else {
            panic!("{extra} was accepted")
        };
        let err = format!("{e:#}");
        assert!(
            err.contains("host h") && err.contains(says),
            "{extra}: {err}"
        );
    }
    parse("[host.blocks]\nenabled = [\"acme.okr@^1\"]\n[host.editor.blocks]\nenabled = [\"acme.okr\"]\n")
        .unwrap();
}

async fn state(tweak: impl FnOnce(&mut HostConfig)) -> (oc_server::SharedState, String) {
    let (base, _host) = mock_host().await;
    let st = app_full(&base, room_cfg(), &temp_db(), tweak, ai_server_on).await;
    let addr = serve_state(st.clone()).await;
    (st, addr)
}

async fn ticket(st: &oc_server::SharedState, role: Role) -> String {
    let t = ulid::Ulid::new().to_string();
    let exp = oc_server::util::now_secs() + 600;
    st.store
        .insert_session(&t, &grant("u_1", role), exp, 0)
        .await
        .unwrap();
    t
}

async fn get(addr: &str, path: &str) -> (u16, Value) {
    let r = reqwest::get(format!("http://{addr}{path}")).await.unwrap();
    let s = r.status().as_u16();
    (s, r.json().await.unwrap_or(Value::Null))
}

fn editor(t: &str) -> toml::Table {
    toml::from_str(t).unwrap()
}

#[tokio::test]
async fn session_carries_the_full_profile_by_default() {
    let (st, addr) = state(|_| {}).await;
    let t = ticket(&st, Role::Edit).await;
    let (s, j) = get(&addr, &format!("/v1/sessions/{t}")).await;
    assert_eq!(s, 200);
    let e = &j["editor"];
    assert_eq!(e["profile"], "full", "{j}");
    assert_eq!(
        e["blocks"].as_array().unwrap().len(),
        oc_server::editor::CORE_BLOCKS.len()
    );
    assert_eq!(e["quickInsert"], json!([]));
    assert_eq!(e["features"]["comments"], true);
    assert_eq!(e["features"]["versionHistory"], true);
    assert_eq!(e["features"]["diagramming"], true);
    assert_eq!(e["features"]["templates"], true);
    // No [host.ai] and no import_formats: the aliases leave both off, as today.
    assert_eq!(e["features"]["ai"], false);
    assert_eq!(e["features"]["import"], false);
}

#[tokio::test]
async fn session_carries_a_meeting_profile_and_its_blocks() {
    let (st, addr) = state(|h| {
        h.editor = editor(
            "profile = \"meeting\"\n[blocks]\nquick_insert = [\"core.checklist\", \"core.text\"]\n",
        )
    })
    .await;
    let t = ticket(&st, Role::Edit).await;
    let (_, j) = get(&addr, &format!("/v1/sessions/{t}")).await;
    let e = &j["editor"];
    assert_eq!(e["profile"], "meeting");
    let blocks: Vec<&str> = e["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(blocks.contains(&"core.checklist") && blocks.contains(&"core.table"));
    assert!(!blocks.contains(&"core.whiteboard") && !blocks.contains(&"core.database"));
    assert_eq!(e["quickInsert"], json!(["core.checklist", "core.text"]));
}

/// `version_history = false`: no history menu (session) and no history routes, even with the
/// host's `[host.flags] history = true` (explicit features win over the flag aliases).
#[tokio::test]
async fn version_history_off_removes_the_session_entry_and_the_routes() {
    let (st, addr) = state(|h| {
        h.flags.insert("history".into(), true.into());
        h.editor = editor("[features]\nversion_history = false\n");
    })
    .await;
    let t = ticket(&st, Role::Edit).await;
    let (_, j) = get(&addr, &format!("/v1/sessions/{t}")).await;
    assert_eq!(j["history"], "none", "{j}");
    assert_eq!(j["perms"]["history"], false);
    assert_eq!(j["perms"]["restore"], false);
    assert_eq!(j["editor"]["features"]["versionHistory"], false);
    let (s, r) = get(&addr, &format!("/v1/history?ticket={t}")).await;
    assert_eq!(s, 404, "{r}");
    assert_eq!(r["error"]["code"], "HISTORY_OFF");
}

/// `ai = false` beats `[host.ai] enabled = true` and `mcp = true`: no assistant, no MCP.
#[tokio::test]
async fn ai_off_beats_the_host_ai_table() {
    let ai: toml::Table =
        toml::from_str("enabled = true\nprovider = \"anthropic\"\nmcp = true\n").unwrap();
    let (st, addr) = state(|h| {
        h.ai = ai.clone();
        h.editor = editor("[features]\nai = false\n");
    })
    .await;
    let t = ticket(&st, Role::Edit).await;
    let (_, j) = get(&addr, &format!("/v1/sessions/{t}")).await;
    assert_eq!(j["ai"]["enabled"], false, "{j}");
    assert_eq!(j["editor"]["features"]["ai"], false);
    let host = st.hosts.get("sample").unwrap();
    assert!(oc_server::ai::HostAi(&host).agent().is_none());
    assert!(!oc_server::ai::HostAi(&host).mcp());

    // Without the feature switch the same table turns the assistant on.
    let (st, addr) = state(|h| h.ai = ai).await;
    let t = ticket(&st, Role::Edit).await;
    let (_, j) = get(&addr, &format!("/v1/sessions/{t}")).await;
    assert_eq!(j["ai"]["enabled"], true, "{j}");
    assert_eq!(j["editor"]["features"]["ai"], true);
}

/// `import = false` beats `import_formats`; `import = true` without a list allows every format.
#[tokio::test]
async fn import_feature_wins_over_import_formats() {
    let (st, addr) = state(|h| {
        h.flags.insert(
            "import_formats".into(),
            toml::Value::Array(vec!["md".into()]),
        );
        h.editor = editor("[features]\nimport = false\n");
    })
    .await;
    let t = ticket(&st, Role::Edit).await;
    let (_, j) = get(&addr, &format!("/v1/sessions/{t}")).await;
    assert_eq!(j["import"]["formats"], json!([]), "{j}");
    assert_eq!(j["editor"]["features"]["import"], false);
    let r = reqwest::Client::new()
        .post(format!("http://{addr}/v1/import?ticket={t}&format=md"))
        .body("# Hi")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);

    let (st, addr) = state(|h| h.editor = editor("[features]\nimport = true\n")).await;
    let t = ticket(&st, Role::Edit).await;
    let (_, j) = get(&addr, &format!("/v1/sessions/{t}")).await;
    assert_eq!(
        j["import"]["formats"],
        json!(oc_server::hosts::IMPORT_FORMATS),
        "{j}"
    );
}

/// `templates = false` beats `team_templates = true`; `comments = false` clears the comment
/// perm and refuses comment writes through the tool layer (REST API and MCP).
#[tokio::test]
async fn templates_and_comments_off() {
    let (st, addr) = state(|h| {
        h.flags.insert("team_templates".into(), true.into());
        h.editor = editor("[features]\ntemplates = false\ncomments = false\n");
    })
    .await;
    let t = ticket(&st, Role::Edit).await;
    let (_, j) = get(&addr, &format!("/v1/sessions/{t}")).await;
    assert_eq!(j["templates"]["team"], false, "{j}");
    assert_eq!(j["editor"]["features"]["templates"], false);
    assert_eq!(j["perms"]["comment"], false);
    assert_eq!(j["editor"]["features"]["comments"], false);
    let (s, r) = get(&addr, &format!("/v1/templates?ticket={t}")).await;
    assert_eq!(s, 200);
    assert_eq!(r["enabled"], false);

    let mut peer = Peer::join(&st, grant("u_b", Role::Edit)).await;
    peer.settle().await;
    let tools = LiveTools::new(st.clone());
    let ctx = ToolCtx {
        host_id: "sample".into(),
        file_id: FILE.into(),
        user: grant("u_ai", Role::Edit),
        origin: "api:test".into(),
        mode_default: WriteMode::Direct,
    };
    let e = tools
        .call(&ctx, "comment_add", json!({"text": "Why?"}))
        .await
        .unwrap_err();
    assert!(
        matches!(&e, ToolError::Forbidden(m) if m.contains("comments are off")),
        "{e}"
    );
}
