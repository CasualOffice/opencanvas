// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Canvas tool layer (docs/24 §5, AI-01): every tool against a live room, with a second
//! client seeing the edit; roles, stale `ifMatch`, suggest mode, confirmation.
mod common;

use common::*;
use oc_server::ai::tools::{CanvasTools, LiveTools, ToolCtx, ToolError, WriteMode};
use oc_server::grant::Role;
use serde_json::{Value, json};

fn ctx(role: Role, mode: WriteMode) -> ToolCtx {
    ToolCtx {
        host_id: "sample".into(),
        file_id: FILE.into(),
        user: grant("u_ai", role),
        origin: "ai:run1".into(),
        mode_default: mode,
    }
}

async fn setup() -> (oc_server::SharedState, Peer, std::sync::Arc<LiveTools>) {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let mut peer = Peer::join(&state, grant("u_b", Role::Edit)).await;
    peer.settle().await;
    let tools = LiveTools::new(state.clone());
    (state, peer, tools)
}

async fn call(t: &LiveTools, c: &ToolCtx, name: &str, input: Value) -> Value {
    t.call(c, name, input)
        .await
        .unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn content_texts(v: &Value) -> Vec<String> {
    fn text(v: &Value) -> String {
        match v["text"].as_str() {
            Some(t) => t.to_string(),
            None => v["content"]
                .as_array()
                .map(|a| a.iter().map(text).collect())
                .unwrap_or_default(),
        }
    }
    v["content"]
        .as_array()
        .map(|a| a.iter().map(text).collect())
        .unwrap_or_default()
}

#[tokio::test]
async fn every_tool_edits_the_live_room_and_the_other_client_sees_it() {
    let (_state, mut peer, t) = setup().await;
    let c = ctx(Role::Edit, WriteMode::Direct);

    // canvas_patch: append (new content is direct).
    let out = call(
        &t,
        &c,
        "canvas_patch",
        json!({"fileId": FILE, "ops": [
        {"op": "append", "markdown": "# Plan\n\nShip the tool layer today."}]}),
    )
    .await;
    assert_eq!(out["mode"], "direct");
    let ids: Vec<String> = serde_json::from_value(out["blockIds"].clone()).unwrap();
    assert_eq!(ids.len(), 2);
    peer.settle().await;
    assert_eq!(
        content_texts(&json_of(&peer.doc)),
        ["Plan", "Ship the tool layer today."]
    );

    // canvas_read (markdown, json, outline) is wrapped as data and carries revs.
    let r = call(&t, &c, "canvas_read", json!({"fileId": FILE})).await;
    assert!(r["notice"].as_str().unwrap().contains("Untrusted"));
    assert!(r["data"]["markdown"].as_str().unwrap().contains("# Plan"));
    let rev = r["data"]["blocks"][1]["rev"].as_str().unwrap().to_string();
    let o = call(&t, &c, "canvas_read", json!({"format": "outline"})).await;
    assert_eq!(o["data"]["outline"][0]["text"], "Plan");
    let j = call(&t, &c, "canvas_read", json!({"format": "json"})).await;
    assert_eq!(j["data"]["blocks"][0]["node"]["type"], "heading");

    // canvas_find
    let f = call(&t, &c, "canvas_find", json!({"query": "tool LAYER"})).await;
    assert_eq!(f["data"]["matches"][0]["blockId"], ids[1].as_str());

    // editText with a matching ifMatch, direct mode: a minimal text edit.
    call(
        &t,
        &c,
        "canvas_patch",
        json!({"ops": [{"op": "editText", "blockId": ids[1],
        "ifMatch": rev, "textEdits": [{"find": "today", "replace": "tomorrow"}]}]}),
    )
    .await;
    peer.settle().await;
    assert_eq!(
        content_texts(&json_of(&peer.doc))[1],
        "Ship the tool layer tomorrow."
    );

    // db_create, db_add_field, db_upsert_rows, db_describe, db_query
    let db = call(&t, &c, "db_create", json!({"name": "Tasks", "afterBlockId": ids[0],
        "fields": [{"name": "Task", "type": "title"}, {"name": "Status", "type": "status", "options": ["Todo", "Done"]}],
        "rows": [{"values": {"Task": "Write tests", "Status": "Todo"}}]})).await;
    let db_id = db["dbId"].as_str().unwrap().to_string();
    let f = call(
        &t,
        &c,
        "db_add_field",
        json!({"dbId": db_id, "name": "Points", "type": "number"}),
    )
    .await;
    assert!(f["fieldId"].as_str().unwrap().starts_with("f_"));
    let up = call(
        &t,
        &c,
        "db_upsert_rows",
        json!({"dbId": db_id, "rows": [
        {"values": {"Task": "Ship", "Status": "Done", "Points": 3}},
        {"rowId": db["rowIds"][0], "values": {"Points": 5}}]}),
    )
    .await;
    assert_eq!(
        (up["created"].as_u64(), up["updated"].as_u64()),
        (Some(1), Some(1))
    );
    let desc = call(&t, &c, "db_describe", json!({})).await;
    assert_eq!(desc["data"]["databases"][0]["rowCount"], 2);
    assert_eq!(
        desc["data"]["databases"][0]["fields"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let q = call(
        &t,
        &c,
        "db_query",
        json!({"dbId": db_id,
        "filters": [{"f": "Status", "op": "eq", "v": "Todo"}]}),
    )
    .await;
    let rows = q["data"]["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["rowId"], db["rowIds"][0]);
    let q = call(
        &t,
        &c,
        "db_query",
        json!({"dbId": db_id, "sorts": [{"f": "Points", "dir": -1}]}),
    )
    .await;
    assert_eq!(q["data"]["rows"][0]["rowId"], db["rowIds"][0]);
    peer.settle().await;
    let pj = json_of(&peer.doc);
    assert_eq!(pj["databases"][&db_id]["name"], "Tasks");
    assert_eq!(
        pj["databases"][&db_id]["rows"].as_object().unwrap().len(),
        2
    );
    assert_eq!(
        pj["content"][1]["type"], "database",
        "inserted after the heading"
    );

    // board_add_shapes (server layout) and board_read
    let b = call(&t, &c, "board_add_shapes", json!({"layout": "flow", "shapes": [
        {"ref": "a", "kind": "sticky", "text": "Idea"}, {"ref": "b", "kind": "rect", "text": "Build"},
        {"kind": "arrow", "from": "a", "to": "b"}]})).await;
    let board_id = b["boardId"].as_str().unwrap().to_string();
    let br = call(&t, &c, "board_read", json!({"boardId": board_id})).await;
    let shapes = br["data"]["shapes"].as_array().unwrap();
    assert_eq!(shapes.len(), 3);
    assert!(shapes[1]["x"].as_f64().unwrap() > shapes[0]["x"].as_f64().unwrap());
    assert_eq!(shapes[2]["from"], b["shapeIds"]["a"]);
    peer.settle().await;
    assert_eq!(
        json_of(&peer.doc)["boards"][&board_id]["shapes"]
            .as_object()
            .unwrap()
            .len(),
        3
    );

    // comment_add, comment_list
    let th = call(
        &t,
        &c,
        "comment_add",
        json!({"blockId": ids[0], "text": "Looks good"}),
    )
    .await;
    call(
        &t,
        &c,
        "comment_add",
        json!({"threadId": th["threadId"], "text": "Agreed"}),
    )
    .await;
    let cl = call(&t, &c, "comment_list", json!({})).await;
    assert_eq!(cl["data"]["threads"][0]["quote"], "Plan");
    assert_eq!(
        cl["data"]["threads"][0]["messages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    peer.settle().await;
    assert_eq!(json_of(&peer.doc)["comments"].as_object().unwrap().len(), 1);

    // members_list never returns e-mail addresses.
    let mut c2 = c.clone();
    c2.user.members = vec![oc_server::grant::User {
        id: "u_z".into(),
        name: "Zed".into(),
        detail: Some("Design".into()),
        ..Default::default()
    }];
    let m = call(&t, &c2, "members_list", json!({})).await;
    assert_eq!(m["data"]["members"][0]["name"], "Zed");
    assert!(!m.to_string().contains('@'));

    // Delete within the threshold, direct.
    call(
        &t,
        &c,
        "canvas_patch",
        json!({"mode": "direct", "ops": [{"op": "delete", "blockId": ids[0]}]}),
    )
    .await;
    peer.settle().await;
    assert_ne!(json_of(&peer.doc)["content"][0]["type"], "heading");
}

#[tokio::test]
async fn view_and_comment_roles_cannot_write() {
    let (_state, _peer, t) = setup().await;
    let edit = ctx(Role::Edit, WriteMode::Direct);
    let out = call(
        &t,
        &edit,
        "canvas_patch",
        json!({"ops": [{"op": "append", "markdown": "x"}]}),
    )
    .await;
    let id = out["blockIds"][0].clone();
    for role in [Role::View, Role::Comment] {
        let c = ctx(role, WriteMode::Direct);
        call(&t, &c, "canvas_read", json!({})).await;
        for (tool, input) in [
            (
                "canvas_patch",
                json!({"ops": [{"op": "append", "markdown": "y"}]}),
            ),
            ("db_create", json!({"name": "D", "fields": []})),
            ("board_add_shapes", json!({"shapes": [{"kind": "sticky"}]})),
        ] {
            let e = t.call(&c, tool, input).await.unwrap_err();
            assert!(matches!(e, ToolError::Forbidden(_)), "{role:?} {tool}: {e}");
        }
    }
    let e = t
        .call(
            &ctx(Role::View, WriteMode::Direct),
            "comment_add",
            json!({"blockId": id, "text": "hi"}),
        )
        .await
        .unwrap_err();
    assert!(matches!(e, ToolError::Forbidden(_)));
    call(
        &t,
        &ctx(Role::Comment, WriteMode::Direct),
        "comment_add",
        json!({"blockId": id, "text": "hi"}),
    )
    .await;
}

#[tokio::test]
async fn stale_if_match_is_refused_with_the_fresh_block() {
    let (_state, mut peer, t) = setup().await;
    let c = ctx(Role::Edit, WriteMode::Direct);
    let out = call(
        &t,
        &c,
        "canvas_patch",
        json!({"ops": [{"op": "append", "markdown": "First"}]}),
    )
    .await;
    let id = out["blockIds"][0].as_str().unwrap().to_string();
    let r = call(&t, &c, "canvas_read", json!({})).await;
    let old = r["data"]["blocks"][0]["rev"].as_str().unwrap().to_string();
    call(&t, &c, "canvas_patch", json!({"ops": [{"op": "editText", "blockId": id, "textEdits": [{"find": "First", "replace": "Changed"}]}]})).await;
    let e = t
        .call(
            &c,
            "canvas_patch",
            json!({"ops": [{"op": "replace", "blockId": id, "ifMatch": old, "markdown": "Mine"}]}),
        )
        .await
        .unwrap_err();
    let ToolError::Stale(v) = e else {
        panic!("{e}")
    };
    assert_eq!(v["data"]["stale"][0]["blockId"], id.as_str());
    assert!(
        v["data"]["stale"][0]["markdown"]
            .as_str()
            .unwrap()
            .contains("Changed")
    );
    peer.settle().await;
    assert_eq!(content_texts(&json_of(&peer.doc)), ["Changed"]);
}

#[tokio::test]
async fn suggest_mode_writes_only_to_suggestions() {
    let (state, mut peer, t) = setup().await;
    let direct = ctx(Role::Edit, WriteMode::Direct);
    let out = call(
        &t,
        &direct,
        "canvas_patch",
        json!({"ops": [{"op": "append", "markdown": "Keep me"}]}),
    )
    .await;
    let id = out["blockIds"][0].as_str().unwrap().to_string();
    peer.settle().await;
    let before = json_of(&peer.doc);

    // Host default `suggest` for changes to existing content; asking for direct can't upgrade it.
    let c = ctx(Role::Edit, WriteMode::Suggest);
    let s = call(&t, &c, "canvas_patch", json!({"mode": "direct", "ops": [{"op": "replace", "blockId": id, "markdown": "Rewritten"}]})).await;
    assert_eq!(s["mode"], "suggest");
    let sid = s["suggestionId"].as_str().unwrap().to_string();
    peer.settle().await;
    let after = json_of(&peer.doc);
    assert_eq!(after["content"], before["content"], "content untouched");
    let sugg = oc_server::ai::tools::suggestions(&peer.doc);
    assert_eq!(sugg[&sid]["status"], "pending");
    assert_eq!(sugg[&sid]["by"], "u_ai");
    assert_eq!(sugg[&sid]["ops"][0]["markdown"], "Rewritten");
    assert!(sugg[&sid]["ops"][0]["rev"].is_string());
    // New content is still direct under a suggest default.
    let n = call(
        &t,
        &c,
        "canvas_patch",
        json!({"ops": [{"op": "append", "markdown": "New"}]}),
    )
    .await;
    assert_eq!(n["mode"], "direct");
    let _ = state;
}

#[tokio::test]
async fn bulk_delete_needs_confirmation() {
    let (_state, mut peer, t) = setup().await;
    let c = ctx(Role::Edit, WriteMode::Direct);
    let out = call(
        &t,
        &c,
        "canvas_patch",
        json!({"ops": [{"op": "append", "markdown": "a\n\nb\n\nc\n\nd\n\ne\n\nf"}]}),
    )
    .await;
    let ops: Vec<Value> = out["blockIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| json!({"op": "delete", "blockId": id}))
        .collect();
    assert_eq!(ops.len(), 6);
    let e = t
        .call(&c, "canvas_patch", json!({"ops": ops.clone()}))
        .await
        .unwrap_err();
    assert!(matches!(e, ToolError::ConfirmationRequired(_)), "{e}");
    peer.settle().await;
    assert_eq!(content_texts(&json_of(&peer.doc)).len(), 6);
    call(&t, &c, "canvas_patch", json!({"ops": ops, "confirm": true})).await;
    peer.settle().await;
    assert!(content_texts(&json_of(&peer.doc)).is_empty());
}
