// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Host REST API: patch, commit, convert, and the DOCX export (docs/04 §6, docs/05 §7).
mod common;

use std::io::{Cursor, Read};
use std::time::Duration;

use common::*;
use oc_server::config::RoomConfig;
use oc_server::grant::Role;
use serde_json::{Value, json};

const API_KEY: &str = "test-api-key";

fn with_key(h: &mut oc_server::hosts::HostConfig) {
    h.api_key = Some(API_KEY.into());
}

fn fast() -> RoomConfig {
    RoomConfig {
        autosave_debounce: Duration::from_millis(50),
        ..room_cfg()
    }
}

fn post(addr: &str, path: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .post(format!("http://{addr}{path}"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", API_KEY)
}

async fn patch(addr: &str, body: Value) -> (u16, Value) {
    let res = post(addr, &format!("/v1/files/{FILE}/patch"))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

async fn commit(addr: &str) -> (u16, Value) {
    let res = post(addr, &format!("/v1/files/{FILE}/commit"))
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

fn texts(v: &Value) -> Vec<String> {
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

fn ocanvas_of(json: Value) -> Vec<u8> {
    let d = oc_model::new_doc();
    oc_model::import::apply_document_json(&d, &json);
    oc_model::write_ocanvas(&d, &oc_model::CommitInfo::default()).unwrap()
}

fn bot() -> Value {
    json!({"id": "bot-1", "name": "Standup bot"})
}

// ---------- patch ----------

#[tokio::test]
async fn patch_applies_to_the_live_room_and_reaches_clients() {
    let (base, host) = mock_host().await;
    let state = app_custom(&base, fast(), &temp_db(), with_key).await;
    let addr = serve_state(state.clone()).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;

    let res = reqwest::Client::new()
        .post(format!("http://{addr}/v1/files/{FILE}/patch"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", "wrong")
        .json(&json!({"ops": [{"op": "append", "markdown": "x"}], "author": bot()}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);

    let (status, body) = patch(
        &addr,
        json!({"ops": [
            {"op": "append", "markdown": "## Standup\n\n- [ ] Follow up with design"},
            {"op": "append", "blocks": [{"type": "callout", "attrs": {"tone": "blue", "blockId": "b_call"},
                "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Heads up"}]}]}]}
        ], "author": bot()}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["live"], true);
    let ids: Vec<String> = serde_json::from_value(body["blockIds"].clone()).unwrap();
    assert_eq!(ids.len(), 3);
    assert_eq!(ids[2], "b_call");
    a.settle().await;
    assert_eq!(
        texts(&json_of(&a.doc)),
        ["Standup", "Follow up with design", "Heads up"]
    );

    let (status, _) = patch(
        &addr,
        json!({"ops": [
            {"op": "insertAfter", "blockId": ids[0], "markdown": "Inserted"},
            {"op": "replace", "blockId": "b_call", "markdown": "Replaced **bold**"},
            {"op": "delete", "blockId": ids[1]}
        ], "author": bot()}),
    )
    .await;
    assert_eq!(status, 200);
    a.settle().await;
    assert_eq!(
        texts(&json_of(&a.doc)),
        ["Standup", "Inserted", "Replaced bold"]
    );
    assert_eq!(texts(&server_json(&state).await), texts(&json_of(&a.doc)));

    // A bad op changes nothing.
    let (status, body) = patch(
        &addr,
        json!({"ops": [{"op": "append", "markdown": "nope"}, {"op": "delete", "blockId": "b_missing"}],
               "author": bot()}),
    )
    .await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["error"]["code"], "BLOCK_NOT_FOUND");
    let (status, body) = patch(&addr, json!({"ops": [{"op": "explode"}], "author": bot()})).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"]["code"], "PATCH_INVALID");
    // MOD-01: a block that breaks the schema is refused with the path of the bad node.
    let (status, body) = patch(
        &addr,
        json!({"ops": [{"op": "append", "blocks": [{"type": "bulletList", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "not an item"}]}]}]}],
               "author": bot()}),
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"]["code"], "PATCH_INVALID");
    let msg = body["error"]["message"].as_str().unwrap_or_default();
    assert!(
        msg.contains("blocks/0/content/0") && msg.contains("not allowed inside bulletList"),
        "{msg}"
    );
    let (status, _) = patch(&addr, json!({"ops": [{"op": "append", "markdown": "x"}]})).await;
    assert_eq!(status, 400, "author is required");
    a.settle().await;
    assert_eq!(texts(&json_of(&a.doc)).len(), 3);

    // The bot is credited in the autosave.
    wait_until(|| !host.lock().unwrap().puts.is_empty()).await;
    let put = host.lock().unwrap().puts[0].clone();
    let authors = put.headers["x-opencanvas-authors"].to_str().unwrap();
    assert!(authors.contains("bot-1"), "{authors}");
    assert_eq!(
        texts(&json_of(&oc_model::read_ocanvas(&put.body).unwrap().doc)).len(),
        3
    );
}

#[tokio::test]
async fn patch_without_a_live_room_loads_applies_and_saves() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().files.insert(
        FILE.into(),
        (
            ocanvas_of(json!({"content": [
                {"type": "paragraph", "attrs": {"blockId": "b_x"}, "content": [{"type": "text", "text": "theirs"}]}
            ]})),
            3,
        ),
    );
    let state = app_custom(&base, room_cfg(), &temp_db(), with_key).await;
    let addr = serve_state(state.clone()).await;
    let res = post(&addr, &format!("/v1/files/{FILE}/patch"))
        .header("X-OpenCanvas-Callback-Token", "cb-bot")
        .json(
            &json!({"ops": [{"op": "insertAfter", "blockId": "b_x", "markdown": "from the bot"}],
                       "author": bot()}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["live"], false);
    assert_eq!(body["version"], "4", "{body}");
    let st = host.lock().unwrap();
    let (bytes, version) = st.files[FILE].clone();
    assert_eq!(version, 4);
    assert_eq!(
        texts(&json_of(&oc_model::read_ocanvas(&bytes).unwrap().doc)),
        ["theirs", "from the bot"]
    );
    let put = st.puts.last().unwrap();
    assert!(put.signature_ok);
    assert_eq!(put.headers["authorization"], "Bearer cb-bot");
    assert_eq!(put.headers["if-match"], "\"3\"");
}

#[tokio::test]
async fn patch_respects_the_document_cap() {
    let (base, _host) = mock_host().await;
    let state = app_custom(
        &base,
        RoomConfig {
            max_doc_bytes: 4096,
            ..room_cfg()
        },
        &temp_db(),
        with_key,
    )
    .await;
    let addr = serve_state(state.clone()).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    let (status, body) = patch(
        &addr,
        json!({"ops": [{"op": "append", "markdown": "x".repeat(5000)}], "author": bot()}),
    )
    .await;
    assert_eq!(status, 413, "{body}");
    assert_eq!(body["error"]["code"], "DOC_TOO_LARGE");
    a.settle().await;
    assert!(texts(&json_of(&a.doc)).is_empty());
}

// ---------- commit ----------

#[tokio::test]
async fn commit_saves_now_and_reports_the_version() {
    let (base, host) = mock_host().await;
    // Autosave would wait an hour: only the commit API can trigger the save.
    let state = app_custom(&base, room_cfg(), &temp_db(), with_key).await;
    let addr = serve_state(state.clone()).await;

    let (status, body) = commit(&addr).await;
    assert_eq!(status, 200);
    assert_eq!(
        body,
        json!({"live": false, "saved": false, "version": null})
    );

    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    a.edit(|d| {
        d.get_or_insert_map("meta")
            .insert(&mut yrs::Transact::transact_mut(d), "title", "T");
    });
    a.settle().await;
    let (status, body) = commit(&addr).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body, json!({"live": true, "saved": true, "version": "1"}));
    assert_eq!(host.lock().unwrap().puts.len(), 1);
    let (status, body) = commit(&addr).await;
    assert_eq!(status, 200);
    assert_eq!(body, json!({"live": true, "saved": false, "version": "1"}));
    assert_eq!(host.lock().unwrap().puts.len(), 1, "clean room: no PUT");

    // Host down: the commit is queued in the outbox.
    host.lock().unwrap().fail = true;
    a.edit(|d| {
        d.get_or_insert_map("meta")
            .insert(&mut yrs::Transact::transact_mut(d), "title", "U");
    });
    a.settle().await;
    let (status, body) = commit(&addr).await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["queued"], true);

    // Conflict: 409.
    {
        let mut h = host.lock().unwrap();
        h.fail = false;
        h.conflict = true;
    }
    let (status, body) = commit(&addr).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"]["code"], "CONFLICT");
}

use yrs::Map;

// ---------- convert ----------

async fn convert(addr: &str, from: &str, to: &str, body: Vec<u8>) -> reqwest::Response {
    post(addr, &format!("/v1/convert?from={from}&to={to}"))
        .body(body)
        .send()
        .await
        .unwrap()
}

fn unzip(bytes: &[u8]) -> std::collections::HashMap<String, Vec<u8>> {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    (0..z.len())
        .map(|i| {
            let mut f = z.by_index(i).unwrap();
            let mut b = Vec::new();
            f.read_to_end(&mut b).unwrap();
            (f.name().unwrap().to_string(), b)
        })
        .collect()
}

#[tokio::test]
async fn convert_between_formats() {
    let (base, host) = mock_host().await;
    let (elsewhere, other) = mock_host().await;
    let state = app_custom(&base, room_cfg(), &temp_db(), with_key).await;
    let addr = serve_state(state.clone()).await;
    let origin = base.trim_end_matches("/api");
    let other_origin = elsewhere.trim_end_matches("/api");
    host.lock().unwrap().redirect_to = Some(format!("{other_origin}/assets/leak"));

    let md = "# Title\n\nSome **bold** text\n\n- [x] done\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    let res = convert(&addr, "md", "html", md.into()).await;
    assert_eq!(res.status(), 200);
    assert!(
        res.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );
    let html = res.text().await.unwrap();
    assert!(html.contains("<strong>bold</strong>"), "{html}");

    let res = convert(&addr, "html", "md", html.into()).await;
    let back = res.text().await.unwrap();
    assert!(back.contains("Some **bold** text"), "{back}");
    assert!(back.contains("- [x] done"), "{back}");
    assert!(back.contains("| 1 | 2 |"), "{back}");

    let oc = convert(&addr, "md", "ocanvas", md.into())
        .await
        .bytes()
        .await
        .unwrap();
    let doc = oc_model::read_ocanvas(&oc).unwrap().doc;
    assert_eq!(json_of(&doc)["content"][0]["type"], "heading");
    let json: Value = convert(&addr, "ocanvas", "json", oc.to_vec())
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(json["content"][1]["content"][1]["text"], "bold");

    // DOCX: images on the host's callback origin are embedded; others are links and are
    // never fetched, and redirects are not followed.
    let page = format!(
        "<h1>Doc</h1><p><img src=\"{origin}/assets/a1\" alt=\"ours\"></p><img src=\"/assets/a2\">\
         <img src=\"{other_origin}/assets/x\" alt=\"theirs\"><img src=\"{origin}/assets/redirect\">"
    );
    let res = convert(&addr, "html", "docx", page.into()).await;
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers()["content-type"],
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    let parts = unzip(&res.bytes().await.unwrap());
    assert!(parts.contains_key("[Content_Types].xml"));
    assert_eq!(parts["word/media/image1.png"], PNG_1X1);
    assert_eq!(parts["word/media/image2.png"], PNG_1X1);
    assert!(!parts.contains_key("word/media/image3.png"));
    let gets = host.lock().unwrap().asset_gets.clone();
    assert_eq!(gets.len(), 3, "{gets:?}");
    assert!(gets.iter().all(|(_, signed)| *signed));
    assert!(
        other.lock().unwrap().asset_gets.is_empty(),
        "foreign origin never fetched"
    );
    let document = String::from_utf8(parts["word/document.xml"].clone()).unwrap();
    assert!(document.contains("Image: theirs"));

    // Errors.
    assert_eq!(convert(&addr, "md", "pdf", vec![]).await.status(), 501);
    assert_eq!(convert(&addr, "md", "rtf", vec![]).await.status(), 400);
    assert_eq!(convert(&addr, "rtf", "md", vec![]).await.status(), 400);
    assert_eq!(
        convert(&addr, "ocanvas", "md", b"not a zip".to_vec())
            .await
            .status(),
        400
    );
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/v1/convert?from=md&to=html"))
        .body("x")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn export_docx_with_a_ticket() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let addr = serve_state(state.clone()).await;
    let ticket = "01TESTTICKETDOCX0000000000";
    state
        .store
        .insert_session(ticket, &grant("u_a", Role::Edit), i64::MAX / 2, 0)
        .await
        .unwrap();
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    a.edit(|d| {
        d.get_or_insert_map("meta").insert(
            &mut yrs::Transact::transact_mut(d),
            "title",
            "Docx title",
        );
    });
    a.settle().await;
    let res = reqwest::get(format!("http://{addr}/v1/export/docx?ticket={ticket}"))
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert!(
        res.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .contains("Doc one.docx")
    );
    let parts = unzip(&res.bytes().await.unwrap());
    let document = String::from_utf8(parts["word/document.xml"].clone()).unwrap();
    assert!(document.contains("Docx title"));
}
