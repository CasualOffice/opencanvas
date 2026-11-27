// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Automation (AUTO-01..05, AUTO-07, ADR-067/068, docs/34 §5.10 AUTO-A1..A8): rules in the
//! canvas run by the server as "Automation" on behalf of their owner. A status change moves the
//! row and notifies once; an owner without edit pauses the rule; chains stop at depth 3 and a
//! rule never triggers itself; URL calls are signed, on allowed origins only, never redirected;
//! 10 failures pause; a date rule runs once with the room closed; the run log holds no text.
mod common;

use std::time::Duration;

use common::*;
use oc_server::grant::Role;
use serde_json::{Value, json};

const KEY: &str = "auto-key";

fn on(h: &mut oc_server::hosts::HostConfig) {
    h.api_key = Some(KEY.into());
    h.flags.insert("api_v1".into(), toml::Value::Boolean(true));
    h.api
        .insert("rate_per_sec".into(), toml::Value::Integer(100_000));
    h.api.insert("burst".into(), toml::Value::Integer(100_000));
    h.api
        .insert("file_writes_per_sec".into(), toml::Value::Integer(100_000));
    h.api
        .insert("file_burst".into(), toml::Value::Integer(100_000));
    h.automation = toml::from_str("enabled = true\ntime_zone = \"UTC+01:00\"").unwrap();
}

async fn serve(
    tweak: impl FnOnce(&mut oc_server::hosts::HostConfig),
) -> (String, oc_server::SharedState, Shared, std::path::PathBuf) {
    let (base, host) = mock_host().await;
    host.lock().unwrap().access = Some([("u_lea".to_string(), "edit".to_string())].into());
    let db = temp_db();
    let state = app_custom(&base, room_cfg(), &db, tweak).await;
    (serve_state(state.clone()).await, state, host, db)
}

async fn api(
    addr: &str,
    method: reqwest::Method,
    path: &str,
    author: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let mut r = reqwest::Client::new()
        .request(method, format!("http://{addr}/api/v1/files/{FILE}{path}"))
        .header("x-opencanvas-host", "sample")
        .header("x-opencanvas-key", KEY)
        .header("x-opencanvas-author", author);
    if let Some(b) = body {
        r = r.json(&b);
    }
    let res = r.send().await.unwrap();
    let s = res.status().as_u16();
    (s, res.json().await.unwrap_or(Value::Null))
}

/// Backlog (Task, Status, Owner) with one row owned by Noor, and an empty Archive.
async fn backlog(addr: &str) -> (String, String, String) {
    let (s, v) = api(addr, reqwest::Method::POST, "/databases", "u_lea", Some(json!({"name": "Backlog",
        "fields": [{"name": "Task", "type": "title"}, {"name": "Status", "type": "select", "options": ["In review", "Done"]},
                   {"name": "Owner", "type": "person"}],
        "rows": [{"values": {"Task": "Rate limit the public API", "Status": "In review", "Owner": "u_noor"}}]}))).await;
    assert_eq!(s, 200, "{v}");
    let (db, row) = (
        v["dbId"].as_str().unwrap().to_string(),
        v["rowIds"][0].as_str().unwrap().to_string(),
    );
    let (s, a) = api(addr, reqwest::Method::POST, "/databases", "u_lea", Some(json!({"name": "Archive",
        "fields": [{"name": "Task", "type": "title"}, {"name": "Status", "type": "select", "options": ["Done"]}, {"name": "Owner", "type": "person"}]}))).await;
    assert_eq!(s, 200, "{a}");
    (db, row, a["dbId"].as_str().unwrap().to_string())
}

fn move_rule(db: &str, archive: &str) -> Value {
    json!({"name": "Move done items",
        "trigger": {"kind": "field.changed", "database": db, "field": "Status", "to": "Done"},
        "conditions": [{"field": "Owner", "op": "isNotEmpty"}],
        "actions": [{"kind": "row.move", "to": {"database": archive}},
                    {"kind": "notify", "people": ["field:Owner"], "text": "{row.title} is done and archived"}]})
}

async fn set_status(addr: &str, db: &str, row: &str, v: &str) {
    let (s, b) = api(
        addr,
        reqwest::Method::POST,
        &format!("/databases/{db}/rows:upsert"),
        "u_noor",
        Some(json!({"rows": [{"rowId": row, "values": {"Status": v}}]})),
    )
    .await;
    assert_eq!(s, 200, "{b}");
}

async fn runs(addr: &str) -> Vec<Value> {
    let (s, v) = api(
        addr,
        reqwest::Method::GET,
        "/automations/runs",
        "u_lea",
        None,
    )
    .await;
    assert_eq!(s, 200, "{v}");
    v["runs"].as_array().cloned().unwrap_or_default()
}

async fn eventually(mut f: impl AsyncFnMut() -> bool) {
    for _ in 0..200 {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("condition not met in 5 s");
}

/// The automation tables hold ids, times, counts and codes only: every column of every row
/// (the room's own WAL holds document updates by design, ADR-001, and is not searched here).
async fn assert_no_text(st: &oc_server::SharedState, needles: &[&str]) {
    let room = oc_server::grant::room_id("sample", FILE);
    let runs = st
        .store
        .automation_runs(&room, None, None, None, 1000)
        .await
        .unwrap();
    let sched = st.store.automation_schedule_of(&room).await.unwrap();
    let all = format!("{runs:?} {sched:?}");
    for n in needles {
        assert!(!all.contains(n), "{n:?} found in the automation tables");
    }
}

/// AUTO-A1: Done moves the row to Archive and notifies the owner once, as Automation.
#[tokio::test]
async fn a_status_change_moves_the_row_and_notifies_once() {
    let (addr, _st, host, _dbfile) = serve(on).await;
    let (db, row, archive) = backlog(&addr).await;
    let (s, v) = api(
        &addr,
        reqwest::Method::PUT,
        "/automations/au_move",
        "u_lea",
        Some(move_rule(&db, &archive)),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    let (s, list) = api(&addr, reqwest::Method::GET, "/automations", "u_lea", None).await;
    assert_eq!(s, 200);
    assert_eq!(list["rules"][0]["rule"]["ownerId"], "u_lea");
    assert_eq!(list["limits"]["maxRules"], 25);

    set_status(&addr, &db, &row, "Done").await;
    eventually(async || runs(&addr).await.iter().any(|r| r["result"] == "done")).await;
    let (_, a) = api(
        &addr,
        reqwest::Method::GET,
        &format!("/databases/{archive}/rows"),
        "u_lea",
        None,
    )
    .await;
    assert_eq!(a["rows"].as_array().unwrap().len(), 1, "{a}");
    let (_, b) = api(
        &addr,
        reqwest::Method::GET,
        &format!("/databases/{db}/rows"),
        "u_lea",
        None,
    )
    .await;
    assert_eq!(b["rows"].as_array().unwrap().len(), 0, "{b}");
    let m = host.lock().unwrap().mentions.clone();
    assert_eq!(m.len(), 1, "notified once");
    assert!(m[0].signature_ok);
    let body: Value = serde_json::from_slice(&m[0].body).unwrap();
    assert_eq!(body["mentioned"], json!(["u_noor"]));
    assert_eq!(body["by"], "automation:au_move");
    assert_eq!(body["onBehalfOf"], "u_lea");
    assert_eq!(
        body["excerpt"],
        "Rate limit the public API is done and archived"
    );
    let r = runs(&addr).await;
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["changes"], 1);
    assert_eq!(r[0]["notified"], 1);
    assert_eq!(r[0]["trigger"], "field.changed");
    // AUTO-A6: the run log and schedule hold ids, codes and counts, never canvas text.
    assert_no_text(
        &_st,
        &[
            "Rate limit the public API",
            "done and archived",
            "In review",
        ],
    )
    .await;
}

/// AUTO-A3: an owner who lost edit pauses the rule; nothing changes.
#[tokio::test]
async fn a_rule_whose_owner_lost_edit_pauses_and_changes_nothing() {
    let (addr, st, host, _db) = serve(on).await;
    let (db, row, archive) = backlog(&addr).await;
    api(
        &addr,
        reqwest::Method::PUT,
        "/automations/au_move",
        "u_lea",
        Some(move_rule(&db, &archive)),
    )
    .await;
    host.lock().unwrap().access = Some([("u_lea".to_string(), "view".to_string())].into());
    st.host.forget_access("sample", FILE, None);
    set_status(&addr, &db, &row, "Done").await;
    eventually(async || runs(&addr).await.iter().any(|r| r["result"] == "skipped")).await;
    let r = runs(&addr).await;
    assert_eq!(r[0]["errorCode"], "OWNER_NO_EDIT");
    let (_, b) = api(
        &addr,
        reqwest::Method::GET,
        &format!("/databases/{db}/rows"),
        "u_lea",
        None,
    )
    .await;
    assert_eq!(b["rows"].as_array().unwrap().len(), 1, "the row stays");
    assert!(host.lock().unwrap().mentions.is_empty());
    let (_, list) = api(&addr, reqwest::Method::GET, "/automations", "u_lea", None).await;
    assert_eq!(
        list["rules"][0]["rule"]["paused"]["code"], "OWNER_NO_EDIT",
        "{list}"
    );
    // "Run it as me": an editor who enables it takes it over.
    let (s, v) = api(
        &addr,
        reqwest::Method::POST,
        "/automations/au_move/enable",
        "u_ravi",
        Some(json!({"enabled": true})),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    let (_, list) = api(&addr, reqwest::Method::GET, "/automations", "u_lea", None).await;
    assert_eq!(list["rules"][0]["rule"]["ownerId"], "u_ravi");
    assert!(list["rules"][0]["rule"].get("paused").is_none());
}

/// AUTO-A4: a chain stops at depth 3 (logged `stopped`); a rule never triggers itself.
#[tokio::test]
async fn chains_stop_at_depth_three_and_rules_never_trigger_themselves() {
    let (addr, _st, _host, _db) = serve(on).await;
    let mut dbs = vec![];
    for name in ["One", "Two", "Three", "Four"] {
        let (s, v) = api(
            &addr,
            reqwest::Method::POST,
            "/databases",
            "u_lea",
            Some(json!({"name": name,
            "fields": [{"name": "Task", "type": "title"}]})),
        )
        .await;
        assert_eq!(s, 200, "{v}");
        dbs.push(v["dbId"].as_str().unwrap().to_string());
    }
    // One → Two → Three → Four → One: a loop of four.
    for i in 0..4 {
        let rule = json!({"name": format!("hop {i}"), "trigger": {"kind": "row.added", "database": dbs[i]},
            "actions": [{"kind": "row.move", "to": {"database": dbs[(i + 1) % 4]}}]});
        let (s, v) = api(
            &addr,
            reqwest::Method::PUT,
            &format!("/automations/au_{i}"),
            "u_lea",
            Some(rule),
        )
        .await;
        assert_eq!(s, 200, "{v}");
    }
    // A rule that would trigger itself: a row added to Two adds a field value in Two.
    let (s, _) = api(
        &addr,
        reqwest::Method::POST,
        &format!("/databases/{}/rows:upsert", dbs[0]),
        "u_noor",
        Some(json!({"rows": [{"values": {"Task": "x"}}]})),
    )
    .await;
    assert_eq!(s, 200);
    eventually(async || runs(&addr).await.iter().any(|r| r["result"] == "stopped")).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let r = runs(&addr).await;
    let stopped: Vec<&Value> = r.iter().filter(|x| x["result"] == "stopped").collect();
    assert_eq!(stopped.len(), 1, "{r:?}");
    assert_eq!(stopped[0]["ruleId"], "au_3");
    assert_eq!(stopped[0]["errorCode"], "MAX_DEPTH");
    assert_eq!(
        r.iter().filter(|x| x["result"] == "done").count(),
        3,
        "{r:?}"
    );
    assert!(r.iter().all(|x| x["depth"].as_i64().unwrap() <= 3));
}

/// AUTO-A5: URL calls: allowed origins only (refused at save), signed like webhooks with the
/// run id as idempotency key, only the named fields, never redirected.
#[tokio::test]
async fn url_calls_are_signed_allowed_and_never_redirected() {
    oc_server::automation::runner::set_url_retry_ms(10, 10);
    let (base, host) = mock_host().await;
    host.lock().unwrap().access = Some([("u_lea".to_string(), "edit".to_string())].into());
    let st = app_custom(&base, room_cfg(), &temp_db(), on).await;
    let addr = serve_state(st.clone()).await;
    let (db, row, _archive) = backlog(&addr).await;
    let bad = json!({"name": "Tell the bot", "trigger": {"kind": "field.changed", "database": db, "field": "Status"},
        "actions": [{"kind": "http.post", "url": "https://hooks.example/rel", "fields": ["Status"]}]});
    let (s, v) = api(
        &addr,
        reqwest::Method::PUT,
        "/automations/au_bad",
        "u_lea",
        Some(bad),
    )
    .await;
    assert_eq!(s, 400);
    assert_eq!(v["code"], "URL_NOT_ALLOWED", "{v}");
    assert!(v["detail"].as_str().unwrap().contains("may call"));
    let good = json!({"name": "Tell the bot", "trigger": {"kind": "field.changed", "database": db, "field": "Status"},
        "actions": [{"kind": "http.post", "url": format!("{base}/hooks"), "fields": ["Status"]}]});
    let (s, v) = api(
        &addr,
        reqwest::Method::PUT,
        "/automations/au_url",
        "u_lea",
        Some(good),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    set_status(&addr, &db, &row, "Done").await;
    eventually(async || !host.lock().unwrap().hooks.is_empty()).await;
    let h = host.lock().unwrap().hooks[0].clone();
    assert!(h.signature_ok, "signed v2 with the host secret");
    assert_eq!(h.headers["x-opencanvas-event"], "automation.url");
    let body: Value = serde_json::from_slice(&h.body).unwrap();
    assert_eq!(
        h.headers["idempotency-key"].to_str().unwrap(),
        body["runId"].as_str().unwrap()
    );
    assert_eq!(
        body["fields"],
        json!({"Status": "Done"}),
        "only the named fields"
    );
    assert_eq!(body["by"], "u_lea");
    // A redirect is not followed: the run fails with the 302.
    host.lock()
        .unwrap()
        .hook_answers
        .push_back((302, vec![("location", format!("{base}/elsewhere"))]));
    set_status(&addr, &db, &row, "In review").await;
    eventually(async || runs(&addr).await.iter().any(|r| r["result"] == "failed")).await;
    let r = runs(&addr).await;
    assert_eq!(r[0]["errorCode"], "URL_302");
    assert_eq!(host.lock().unwrap().elsewhere, 0);
}

/// AUTO-A6: ten failed runs in a row pause the rule and tell its owner once.
#[tokio::test]
async fn ten_failures_pause_the_rule_and_notify_its_owner_once() {
    oc_server::automation::runner::set_url_retry_ms(1, 1);
    let (base, host) = mock_host().await;
    host.lock().unwrap().access = Some([("u_lea".to_string(), "edit".to_string())].into());
    let st = app_custom(&base, room_cfg(), &temp_db(), on).await;
    let addr = serve_state(st.clone()).await;
    let (db, row, _a) = backlog(&addr).await;
    let rule = json!({"name": "Tell the bot", "trigger": {"kind": "field.changed", "database": db, "field": "Status"},
        "actions": [{"kind": "http.post", "url": format!("{base}/hooks"), "fields": []}]});
    let (s, v) = api(
        &addr,
        reqwest::Method::PUT,
        "/automations/au_url",
        "u_lea",
        Some(rule),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    for i in 0..10 {
        for _ in 0..3 {
            host.lock().unwrap().hook_answers.push_back((500, vec![]));
        }
        set_status(
            &addr,
            &db,
            &row,
            if i % 2 == 0 { "Done" } else { "In review" },
        )
        .await;
        eventually(async || {
            runs(&addr)
                .await
                .iter()
                .filter(|r| r["result"] == "failed")
                .count()
                > i
        })
        .await;
    }
    eventually(async || {
        let (_, list) = api(&addr, reqwest::Method::GET, "/automations", "u_lea", None).await;
        list["rules"][0]["rule"]["paused"]["code"] == "FAILURES"
    })
    .await;
    let m = host.lock().unwrap().mentions.clone();
    assert_eq!(m.len(), 1, "one notification, not one per failure");
    let body: Value = serde_json::from_slice(&m[0].body).unwrap();
    assert_eq!(body["mentioned"], json!(["u_lea"]));
    // Paused: the next change runs nothing.
    set_status(&addr, &db, &row, "Done").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        runs(&addr)
            .await
            .iter()
            .filter(|r| r["result"] == "failed")
            .count(),
        10
    );
}

/// AUTO-A2: a date rule runs once at 09:00 in the canvas time zone with the room closed, even
/// with two workers sweeping the same database.
#[tokio::test]
async fn a_date_rule_runs_once_at_nine_with_the_room_closed() {
    let (addr, st, host, _dbfile) = serve(on).await;
    // Wednesday 2026-11-25 23:00 UTC = Thursday 00:00 in UTC+01:00.
    let start = 1_795_647_600_000i64;
    st.clock.set_ms(start);
    let (s, v) = api(&addr, reqwest::Method::POST, "/databases", "u_lea", Some(json!({"name": "Backlog",
        "fields": [{"name": "Task", "type": "title"}, {"name": "Owner", "type": "person"}, {"name": "Due", "type": "date"}],
        "rows": [{"values": {"Task": "SSO settings page", "Owner": "u_noor", "Due": "2026-11-27"}},
                 {"values": {"Task": "Later", "Owner": "u_noor", "Due": "2026-12-20"}}]}))).await;
    assert_eq!(s, 200, "{v}");
    let db = v["dbId"].as_str().unwrap().to_string();
    let rule = json!({"name": "Due tomorrow reminder", "trigger": {"kind": "date.reached", "database": db, "field": "Due", "offsetDays": -1, "time": "09:00"},
        "actions": [{"kind": "notify", "people": ["field:Owner"], "text": "{row.title} is due tomorrow"}]});
    let (s, v) = api(
        &addr,
        reqwest::Method::PUT,
        "/automations/au_due",
        "u_lea",
        Some(rule),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    // The schedule row says 09:00 local = 08:00 UTC on Nov 26.
    let room = oc_server::grant::room_id("sample", FILE);
    let next = 1_795_680_000_000i64;
    eventually(async || {
        st.store.automation_schedule_of(&room).await.unwrap() == vec![("au_due".to_string(), next)]
    })
    .await;
    // Save (an editor is connected) and close the room; the host has the file.
    let mut lea = Peer::join(&st, grant("u_lea", Role::Edit)).await;
    let (s, v) = api(&addr, reqwest::Method::POST, "/commit", "u_lea", None).await;
    assert_eq!(s, 200, "{v}");
    eventually(async || !host.lock().unwrap().puts.is_empty()).await;
    lea.leave();
    st.rooms.close(&room).await;
    assert!(!st.rooms.is_live(&room));
    // Before nine: nothing.
    assert_eq!(
        oc_server::automation::worker::sweep(&st, "node-a")
            .await
            .unwrap(),
        0
    );
    st.clock.set_ms(next + 30_000);
    let (a, b) = tokio::join!(
        oc_server::automation::worker::sweep(&st, "node-a"),
        oc_server::automation::worker::sweep(&st, "node-b")
    );
    assert_eq!(a.unwrap() + b.unwrap(), 1, "one node takes the slot");
    let m = host.lock().unwrap().mentions.clone();
    assert_eq!(m.len(), 1);
    let body: Value = serde_json::from_slice(&m[0].body).unwrap();
    assert_eq!(body["excerpt"], "SSO settings page is due tomorrow");
    // The next slot is tomorrow at 09:00 local; sweeping again does nothing.
    assert_eq!(
        st.store.automation_schedule_of(&room).await.unwrap(),
        vec![("au_due".to_string(), next + 86_400_000)]
    );
    assert_eq!(
        oc_server::automation::worker::sweep(&st, "node-a")
            .await
            .unwrap(),
        0
    );
    let r = runs(&addr).await;
    assert_eq!(
        r.iter().filter(|x| x["trigger"] == "date.reached").count(),
        1,
        "{r:?}"
    );
    assert_no_text(&st, &["SSO settings page", "due tomorrow"]).await;
}

/// RLB-04: the room opening after 09:00 but before the sweep must not move the due slot to
/// tomorrow (an editor opening the canvas at 09:00:05 skipped the reminder; CI flaked on it in
/// `a_date_rule_runs_once_at_nine_with_the_room_closed` when the room's last schedule write
/// landed after the clock moved).
#[tokio::test]
async fn opening_the_room_after_nine_keeps_the_due_slot() {
    let (addr, st, _host, _dbfile) = serve(on).await;
    let start = 1_795_647_600_000i64;
    st.clock.set_ms(start);
    let (s, v) = api(&addr, reqwest::Method::POST, "/databases", "u_lea", Some(json!({"name": "Backlog",
        "fields": [{"name": "Task", "type": "title"}, {"name": "Owner", "type": "person"}, {"name": "Due", "type": "date"}],
        "rows": [{"values": {"Task": "SSO settings page", "Owner": "u_noor", "Due": "2026-11-27"}}]}))).await;
    assert_eq!(s, 200, "{v}");
    let db = v["dbId"].as_str().unwrap().to_string();
    let rule = json!({"name": "Due tomorrow reminder", "trigger": {"kind": "date.reached", "database": db, "field": "Due", "offsetDays": -1, "time": "09:00"},
        "actions": [{"kind": "notify", "people": ["field:Owner"], "text": "{row.title} is due tomorrow"}]});
    let (s, v) = api(
        &addr,
        reqwest::Method::PUT,
        "/automations/au_due",
        "u_lea",
        Some(rule),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    let room = oc_server::grant::room_id("sample", FILE);
    let next = 1_795_680_000_000i64;
    eventually(async || {
        st.store.automation_schedule_of(&room).await.unwrap() == vec![("au_due".to_string(), next)]
    })
    .await;
    st.rooms.close(&room).await;
    // 09:00:05: someone opens the canvas before the sweep.
    st.clock.set_ms(next + 5_000);
    let mut lea = Peer::join(&st, grant("u_lea", Role::Edit)).await;
    lea.settle().await;
    assert_eq!(
        st.store.automation_schedule_of(&room).await.unwrap(),
        vec![("au_due".to_string(), next)],
        "the due slot stays until a sweep runs it"
    );
    assert_eq!(
        oc_server::automation::worker::sweep(&st, "node-a")
            .await
            .unwrap(),
        1
    );
}

/// RLB-03: after a restore from backup (`OC_RESTORED=1`) a slot that was due before the restore
/// may already have run after the backup was taken: it is skipped and logged, not run again.
/// The next slot runs as usual.
#[tokio::test]
async fn a_slot_due_before_a_restore_is_skipped_not_run_twice() {
    let (addr, st, host, _dbfile) = serve(on).await;
    let start = 1_795_647_600_000i64;
    st.clock.set_ms(start);
    let (s, v) = api(&addr, reqwest::Method::POST, "/databases", "u_lea", Some(json!({"name": "Backlog",
        "fields": [{"name": "Task", "type": "title"}, {"name": "Owner", "type": "person"}, {"name": "Due", "type": "date"}],
        "rows": [{"values": {"Task": "SSO settings page", "Owner": "u_noor", "Due": "2026-11-27"}}]}))).await;
    assert_eq!(s, 200, "{v}");
    let db = v["dbId"].as_str().unwrap().to_string();
    let rule = json!({"name": "Due tomorrow reminder", "trigger": {"kind": "date.reached", "database": db, "field": "Due", "offsetDays": -1, "time": "09:00"},
        "actions": [{"kind": "notify", "people": ["field:Owner"], "text": "{row.title} is due tomorrow"}]});
    let (s, v) = api(
        &addr,
        reqwest::Method::PUT,
        "/automations/au_due",
        "u_lea",
        Some(rule),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    let room = oc_server::grant::room_id("sample", FILE);
    let next = 1_795_680_000_000i64;
    eventually(async || {
        st.store.automation_schedule_of(&room).await.unwrap() == vec![("au_due".to_string(), next)]
    })
    .await;
    // Restored at 09:05 from a backup taken before 09:00.
    st.clock.set_ms(next + 300_000);
    st.store.mark_restored(next + 300_000).await.unwrap();
    assert_eq!(
        oc_server::automation::worker::sweep(&st, "node-a")
            .await
            .unwrap(),
        1
    );
    assert!(
        host.lock().unwrap().mentions.is_empty(),
        "the 09:00 slot ran again after the restore"
    );
    let r = runs(&addr).await;
    assert!(
        r.iter().any(|x| x["result"] == "skipped"),
        "the skipped slot is in the run log: {r:?}"
    );
    assert_eq!(
        st.store.automation_schedule_of(&room).await.unwrap(),
        vec![("au_due".to_string(), next + 86_400_000)]
    );
}

/// AUTO-01: a client may change rules only with edit and perms.automate, owning what it enables.
#[tokio::test]
async fn clients_need_perms_automate_and_own_what_they_enable() {
    let (base, _host) = mock_host().await;
    let st = app_custom(&base, room_cfg(), &temp_db(), on).await;
    let rule = |owner: &str| {
        json!({"v": 1, "name": "r", "enabled": true, "ownerId": owner,
            "trigger": {"kind": "row.added", "database": "db_x"}, "actions": [{"kind": "comment.add", "text": "hi"}]})
    };
    let write = |p: &Peer, owner: &str| {
        let f = rule(owner).as_object().unwrap().clone();
        p.edit(|d| {
            let root = d.get_or_insert_map(oc_model::automation::ROOT);
            let mut txn = yrs::Transact::transact_mut(d);
            oc_model::automation::write_fields(&mut txn, &root, "au_1", &f);
        });
    };
    let rules = async |st: &oc_server::SharedState| {
        let j = server_json(st).await;
        j.get("automations").cloned().unwrap_or(Value::Null)
    };
    // An editor without perms.automate is refused.
    let mut a = Peer::join(&st, grant("u_a", Role::Edit)).await;
    write(&a, "u_a");
    a.settle().await;
    assert_eq!(rules(&st).await, Value::Null);
    a.leave();
    // With it, enabling a rule owned by someone else is refused; owning it is fine.
    let mut g = grant("u_b", Role::Edit);
    g.perms.automate = true;
    let mut b = Peer::join(&st, g).await;
    write(&b, "u_someone");
    b.settle().await;
    assert_eq!(rules(&st).await, Value::Null);
    b.leave();
    let mut g = grant("u_c", Role::Edit);
    g.perms.automate = true;
    let mut c = Peer::join(&st, g).await;
    write(&c, "u_c");
    c.settle().await;
    assert_eq!(rules(&st).await["au_1"]["ownerId"], "u_c");
}

#[tokio::test]
async fn test_run_changes_nothing_and_hosts_without_automation_get_404() {
    let (addr, _st, host, _db) = serve(on).await;
    let (db, _row, archive) = backlog(&addr).await;
    let (s, v) = api(
        &addr,
        reqwest::Method::POST,
        "/automations:test",
        "u_lea",
        Some(json!({"rule": move_rule(&db, &archive)})),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["subject"]["title"], "Rate limit the public API");
    assert_eq!(
        v["effects"][0],
        "Would move the row to Archive (3 fields match)"
    );
    assert_eq!(v["effects"][1], "Would notify u_noor through the host");
    assert_eq!(v["changed"], false);
    let (_, b) = api(
        &addr,
        reqwest::Method::GET,
        &format!("/databases/{db}/rows"),
        "u_lea",
        None,
    )
    .await;
    assert_eq!(b["rows"].as_array().unwrap().len(), 1);
    assert!(host.lock().unwrap().mentions.is_empty());
    let (s, _) = api(
        &addr,
        reqwest::Method::DELETE,
        "/automations/au_nope",
        "u_lea",
        None,
    )
    .await;
    assert_eq!(s, 404);

    let (addr, _st, _host, _db) = serve(|h| {
        on(h);
        h.automation = Default::default();
    })
    .await;
    let (s, v) = api(&addr, reqwest::Method::GET, "/automations", "u_lea", None).await;
    assert_eq!(s, 404);
    assert_eq!(v["code"], "AUTOMATION_OFF");
}

#[test]
fn start_up_checks_host_automation() {
    let base = "[[host]]\nid = \"h\"\nname = \"H\"\njwt_secret = \"0123456789abcdef0123456789abcdef\"\ncallback_base = \"http://h/api\"\n";
    oc_server::hosts::Hosts::parse(
        &format!(
            "{base}[host.automation]\nenabled = true\nallow_origins = [\"https://ci.example\"]\n"
        ),
        None,
    )
    .unwrap();
    for bad in [
        "max_rules = 500",
        "min_interval_min = 1",
        "actions = [\"canvas.delete\"]",
        "allow_origins = [\"https://ci.example/x\"]",
    ] {
        let Err(e) =
            oc_server::hosts::Hosts::parse(&format!("{base}[host.automation]\n{bad}\n"), None)
        else {
            panic!("{bad} was accepted")
        };
        assert!(
            format!("{e:#}").contains("[host.automation]"),
            "{bad}: {e:#}"
        );
    }
}

/// AUTO-07: the MCP tools answer what the API answers (ADR-041 parity).
#[tokio::test]
async fn mcp_tools_match_the_api() {
    const PUBLIC: &str = "https://oc.example";
    let (base, host) = mock_host().await;
    host.lock().unwrap().access = Some([("u_lea".to_string(), "edit".to_string())].into());
    let st = app_ai(&base, room_cfg(), &temp_db(), |h| {
        on(h);
        h.api
            .insert("audience".into(), toml::Value::String(PUBLIC.into()));
        h.ai.insert("mcp".into(), toml::Value::Boolean(true));
        h.ai.insert("mcp_audience".into(), toml::Value::String(PUBLIC.into()));
    })
    .await;
    let addr = serve_state(st.clone()).await;
    let (db, _row, archive) = backlog(&addr).await;
    api(
        &addr,
        reqwest::Method::PUT,
        "/automations/au_move",
        "u_lea",
        Some(move_rule(&db, &archive)),
    )
    .await;
    let tok = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        &json!({"iss": "sample", "aud": format!("{PUBLIC}/mcp/sample"), "sub": "u_lea", "name": "Lea",
            "exp": oc_server::util::now_secs() + 600, "scope": "canvas:read canvas:write", "role": "edit",
            "files": [FILE], "client_id": "t"}),
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()).unwrap(),
    )
    .unwrap();
    let call = async |name: &str, args: Value| -> Value {
        let r = reqwest::Client::new()
            .post(format!("http://{addr}/mcp/sample"))
            .bearer_auth(&tok)
            .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}))
            .send()
            .await
            .unwrap();
        r.json::<Value>().await.unwrap()["result"]["structuredContent"].clone()
    };
    let (_, list) = api(&addr, reqwest::Method::GET, "/automations", "u_lea", None).await;
    let m = call("canvas_automations", json!({"fileId": FILE})).await;
    assert_eq!(m["rules"], list["rules"]);
    let (_, t) = api(
        &addr,
        reqwest::Method::POST,
        "/automations:test",
        "u_lea",
        Some(json!({"rule": move_rule(&db, &archive)})),
    )
    .await;
    let mt = call(
        "canvas_automation_test",
        json!({"fileId": FILE, "rule": move_rule(&db, &archive)}),
    )
    .await;
    assert_eq!(mt["effects"], t["effects"]);
    let off = call(
        "canvas_automation_enable",
        json!({"fileId": FILE, "ruleId": "au_move", "enabled": false}),
    )
    .await;
    assert_eq!(off["enabled"], false);
}

/// The editor's session routes take numeric query parameters (a flattened query struct read
/// them as strings and answered 400).
#[tokio::test]
async fn editor_routes_take_numeric_query_parameters() {
    let (addr, st, _host, _db) = serve(on).await;
    let t = ulid::Ulid::new().to_string();
    st.store
        .insert_session(
            &t,
            &grant("u_lea", Role::Edit),
            oc_server::util::now_secs() + 600,
            0,
        )
        .await
        .unwrap();
    let r = reqwest::get(format!("http://{addr}/v1/automations/runs?ticket={t}&limit=5&before=1795680000000&rule=au_1&result=done"))
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
}

/// Frame 3a: the person whose change started a run is told (control `automation-ran`), and its
/// Undo reverts the whole run as one step, starting no rule.
#[tokio::test]
async fn the_person_who_triggered_a_run_is_told_and_can_undo_it() {
    let (addr, st, _host, _db) = serve(on).await;
    let (db, row, archive) = backlog(&addr).await;
    let (s, v) = api(
        &addr,
        reqwest::Method::PUT,
        "/automations/au_move",
        "u_lea",
        Some(move_rule(&db, &archive)),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    let mut noor = Peer::join(&st, grant("u_noor", Role::Edit)).await;
    noor.settle().await;
    let (_, d) = api(
        &addr,
        reqwest::Method::GET,
        &format!("/databases/{db}"),
        "u_lea",
        None,
    )
    .await;
    let status = d["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "Status")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    noor.edit(|doc| {
        use yrs::Map;
        let root = doc.get_or_insert_map("databases");
        let mut txn = yrs::Transact::transact_mut(doc);
        let Some(yrs::Out::YMap(m)) = root.get(&txn, &db) else {
            panic!("db")
        };
        let Some(yrs::Out::YMap(rows)) = m.get(&txn, "rows") else {
            panic!("rows")
        };
        let Some(yrs::Out::YMap(r)) = rows.get(&txn, &row) else {
            panic!("row")
        };
        r.insert(&mut txn, status.as_str(), "Done");
    });
    let mut notice = None;
    for _ in 0..100 {
        noor.settle().await;
        notice = noor
            .controls
            .iter()
            .find(|c| c["t"] == "automation-ran")
            .cloned();
        if notice.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let notice = notice.expect("automation-ran control");
    assert_eq!(
        notice["text"],
        "Move done items moved “Rate limit the public API” to Archive"
    );
    let (_, a) = api(
        &addr,
        reqwest::Method::GET,
        &format!("/databases/{archive}/rows"),
        "u_lea",
        None,
    )
    .await;
    assert_eq!(a["rows"].as_array().unwrap().len(), 1);
    // Undo: the row is back in the backlog, the archive is empty, and no rule ran again.
    noor.send(oc_server::room::protocol::control(
        &json!({"t": "automation-undo", "runId": notice["runId"], "ruleId": "au_move"}),
    ));
    eventually(async || {
        let (_, a) = api(
            &addr,
            reqwest::Method::GET,
            &format!("/databases/{archive}/rows"),
            "u_lea",
            None,
        )
        .await;
        a["rows"].as_array().is_some_and(|r| r.is_empty())
    })
    .await;
    let (_, b) = api(
        &addr,
        reqwest::Method::GET,
        &format!("/databases/{db}/rows"),
        "u_lea",
        None,
    )
    .await;
    assert_eq!(b["rows"].as_array().unwrap().len(), 1);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(runs(&addr).await.len(), 1, "the undo started no rule");
}
