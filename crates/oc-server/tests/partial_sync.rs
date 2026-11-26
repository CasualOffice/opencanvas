// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! PSYNC-02 (ADR-076, docs/15 §3.2): a room with `[host.flags] partial_sync` keeps databases
//! and boards as subdocuments: loaded when a connection asks (type 101), the role checked per
//! request, evicted when unheld, flattened back to format v1 with the item ids kept on save,
//! and editors without `caps=subdoc` closed with 4426.

mod common;

use std::time::Duration;

use common::*;
use oc_server::grant::Role;
use oc_server::room::protocol;
use serde_json::{Value, json};
use yrs::sync::{Message, SyncMessage};
use yrs::updates::decoder::Decode;
use yrs::{Doc, Map, MapRef, Out, ReadTxn, StateVector, Transact, Update};

/// Text, two databases and a board.
fn canvas() -> Vec<u8> {
    let doc = oc_model::new_doc();
    oc_model::import::apply_document_json(
        &doc,
        &json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Intro"}]}],
            "databases": {
                "d1": {"name": "Tasks", "rows": {"r1": {"title": "One"}}, "order": ["r1"]},
                "d2": {"name": "Bugs", "rows": {}, "order": []}
            },
            "boards": {"b1": {"items": {"i1": {"text": "card"}}, "order": ["i1"]}}
        }),
    );
    oc_model::write_ocanvas(&doc, &Default::default()).unwrap()
}

async fn server(partial: bool) -> (oc_server::SharedState, Shared) {
    let (base, mock) = mock_host().await;
    mock.lock()
        .unwrap()
        .files
        .insert(FILE.into(), (canvas(), 1));
    let mut cfg = room_cfg();
    cfg.part_evict = Duration::from_millis(200);
    cfg.whole_release = Duration::from_millis(200);
    let state = app_custom(&base, cfg, &temp_db(), |h| {
        if partial {
            h.flags.insert("partial_sync".into(), true.into());
        }
    })
    .await;
    (state, mock)
}

fn subdoc_grant(user: &str, role: Role) -> oc_server::grant::Grant {
    let mut g = grant(user, role);
    g.subdoc = true;
    g
}

fn guid(block: &str) -> String {
    format!("{FILE}/block/{block}")
}

/// Asks for a part (sync step 1 from an empty doc) and applies what comes back to `doc`.
async fn load(p: &mut Peer, block: &str, doc: &Doc) {
    let sv = doc.transact().state_vector();
    p.send(protocol::subdoc(&guid(block), &protocol::step1(sv)));
    p.settle().await;
    take_into(p, block, doc);
}

fn take_into(p: &mut Peer, block: &str, doc: &Doc) {
    for (g, m) in std::mem::take(&mut p.subs) {
        if g != guid(block) {
            continue;
        }
        if let Message::Sync(SyncMessage::SyncStep2(u) | SyncMessage::Update(u)) = m {
            doc.transact_mut()
                .apply_update(Update::decode_v1(&u).unwrap())
                .unwrap();
        }
    }
}

fn db(doc: &Doc, id: &str) -> Value {
    oc_model::doc_to_json(doc)["databases"][id].clone()
}

fn row_title(doc: &Doc, db_id: &str, row: &str) -> Option<String> {
    let dbs = doc.get_or_insert_map("databases");
    let txn = doc.transact();
    let Some(Out::YMap(d)) = dbs.get(&txn, db_id) else {
        return None;
    };
    let Some(Out::YMap(rows)) = d.get(&txn, "rows") else {
        return None;
    };
    let Some(Out::YMap(r)) = rows.get(&txn, row) else {
        return None;
    };
    r.get(&txn, "title").map(|v| v.to_string(&txn))
}

/// An edit on a part doc: a new title for row r1, sent as a type 101 update.
fn edit_part(p: &Peer, doc: &Doc, block: &str, title: &str) {
    let sv = doc.transact().state_vector();
    {
        let dbs: MapRef = doc.get_or_insert_map("databases");
        let mut txn = doc.transact_mut();
        let Some(Out::YMap(d)) = dbs.get(&txn, block) else {
            panic!("part not loaded");
        };
        let Some(Out::YMap(rows)) = d.get(&txn, "rows") else {
            panic!("no rows");
        };
        let Some(Out::YMap(r)) = rows.get(&txn, "r1") else {
            panic!("no r1");
        };
        r.insert(&mut txn, "title", title);
    }
    let u = doc.transact().encode_state_as_update_v1(&sv);
    p.send(protocol::subdoc(&guid(block), &protocol::update(u)));
}

#[tokio::test]
async fn old_editors_are_closed_with_4426_on_a_split_room_and_welcome_without_the_flag() {
    // Mixed versions: a 0.3 editor (no caps=subdoc) next to a 0.4 one.
    let (state, _) = server(true).await;
    let mut new = Peer::join(&state, subdoc_grant("u_new", Role::Edit)).await;
    new.settle().await;
    let mut old = Peer::join(&state, grant("u_old", Role::Edit)).await;
    old.settle().await;
    assert_eq!(old.closed, Some(4426));
    assert_eq!(new.closed, None);
    let parts = new
        .controls
        .iter()
        .find(|c| c["t"] == "parts")
        .expect("parts list");
    let ids: Vec<&str> = parts["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [guid("b1"), guid("d1"), guid("d2")]);
    assert_eq!(parts["parts"][1]["name"], "Tasks");
    assert_eq!(parts["parts"][1]["kind"], "database");
    // The main document carries the text and no heavy block.
    let main = json_of(&new.doc);
    assert_eq!(main["databases"], json!({}));
    assert_eq!(main["boards"], json!({}));
    assert!(main["content"].to_string().contains("Intro"));

    // Without the flag nothing changes: the same old editor gets everything.
    let (state, _) = server(false).await;
    let mut old = Peer::join(&state, grant("u_old", Role::Edit)).await;
    old.settle().await;
    assert_eq!(old.closed, None);
    assert_eq!(json_of(&old.doc)["databases"]["d1"]["name"], "Tasks");
    assert!(!old.controls.iter().any(|c| c["t"] == "parts"));
}

#[tokio::test]
async fn parts_load_on_demand_edits_reach_holders_and_the_save_is_v1_with_the_same_ids() {
    let (state, mock) = server(true).await;
    let host = state.hosts.get("sample").unwrap();
    let mut a = Peer::join(&state, subdoc_grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&state, subdoc_grant("u_b", Role::Edit)).await;
    let mut c = Peer::join(&state, subdoc_grant("u_c", Role::Edit)).await;
    for p in [&mut a, &mut b, &mut c] {
        p.settle().await;
    }
    let (da, db_) = (oc_model::new_doc(), oc_model::new_doc());
    load(&mut a, "d1", &da).await;
    load(&mut b, "d1", &db_).await;
    assert_eq!(db(&da, "d1")["name"], "Tasks");
    assert_eq!(row_title(&da, "d1", "r1").as_deref(), Some("One"));
    // A part holds its block only.
    assert_eq!(
        oc_model::doc_to_json(&da)["databases"]
            .as_object()
            .unwrap()
            .len(),
        1
    );

    edit_part(&a, &da, "d1", "Uno");
    b.settle().await;
    c.settle().await;
    take_into(&mut b, "d1", &db_);
    assert_eq!(row_title(&db_, "d1", "r1").as_deref(), Some("Uno"));
    // c never loaded d1: nothing of it arrives.
    assert!(c.subs.is_empty());

    // An API read merges the parts; an API write runs on a whole view and reaches holders.
    let whole = server_json(&state).await;
    assert_eq!(whole["databases"]["d1"]["rows"]["r1"]["title"], "Uno");
    assert_eq!(whole["boards"]["b1"]["order"], json!(["i1"]));
    let ops =
        vec![serde_json::from_value(json!({"op": "append", "markdown": "From the API"})).unwrap()];
    state
        .rooms
        .patch(&host, &grant("u_api", Role::Edit), ops, "u_api")
        .await
        .unwrap()
        .unwrap();
    a.settle().await;
    assert!(
        json_of(&a.doc)["content"]
            .to_string()
            .contains("From the API")
    );

    // The save flattens to format v1: the host's file is one document with every block, and
    // the items keep their ids (a part's state vector is contained in the saved file's).
    state
        .rooms
        .commit(&host, &grant("u_a", Role::Edit))
        .await
        .unwrap();
    let saved = mock.lock().unwrap().files[FILE].0.clone();
    let file = oc_model::read_ocanvas(&saved).unwrap().doc;
    let j = oc_model::doc_to_json(&file);
    assert_eq!(j["databases"]["d1"]["rows"]["r1"]["title"], "Uno");
    assert_eq!(j["databases"]["d2"]["name"], "Bugs");
    assert!(j["content"].to_string().contains("From the API"));
    let file_sv = file.transact().state_vector();
    for (client, clock) in da.transact().state_vector().iter() {
        assert!(file_sv.get(client) >= *clock, "item ids kept");
    }
    // An offline copy's part merges into the saved file without duplicates: same ids.
    let before = oc_model::doc_to_json(&file);
    let all = da
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let owners = oc_model::parts::split(&oc_model::ocanvas::encode_state(&file))
        .unwrap()
        .owners;
    let own = oc_model::parts::own_share(&all, "databases/d1", &owners).unwrap();
    file.transact_mut()
        .apply_update(Update::decode_v1(&own).unwrap())
        .unwrap();
    assert_eq!(oc_model::doc_to_json(&file), before);
}

#[tokio::test]
async fn the_role_is_checked_per_request_and_other_files_blocks_are_refused() {
    let (state, _) = server(true).await;
    let mut v = Peer::join(&state, subdoc_grant("u_v", Role::View)).await;
    v.settle().await;
    let dv = oc_model::new_doc();
    // A viewer may read a block...
    load(&mut v, "d1", &dv).await;
    assert_eq!(db(&dv, "d1")["name"], "Tasks");
    // ...but not write it.
    edit_part(&v, &dv, "d1", "Hacked");
    v.settle().await;
    assert!(v.denied >= 1);
    // Another file's block, or a block this canvas lacks, is refused.
    for g in ["doc_2/block/d1".to_string(), guid("nope")] {
        v.send(protocol::subdoc(
            &g,
            &protocol::step1(StateVector::default()),
        ));
        v.settle().await;
        assert!(
            v.controls
                .iter()
                .any(|c| c["t"] == "sub-denied" && c["id"] == g.as_str()),
            "{g} refused"
        );
    }
    // An update for a block not loaded first is refused.
    let mut e = Peer::join(&state, subdoc_grant("u_e", Role::Edit)).await;
    e.settle().await;
    edit_part(&e, &dv, "d1", "Blind");
    e.settle().await;
    assert!(e.controls.iter().any(|c| c["t"] == "sub-denied"));
    let whole = server_json(&state).await;
    assert_eq!(whole["databases"]["d1"]["rows"]["r1"]["title"], "One");
}

#[tokio::test]
async fn an_unheld_part_is_evicted_and_comes_back_from_the_wal() {
    let (state, _) = server(true).await;
    let mut a = Peer::join(&state, subdoc_grant("u_a", Role::Edit)).await;
    a.settle().await;
    let d = oc_model::new_doc();
    load(&mut a, "d1", &d).await;
    edit_part(&a, &d, "d1", "Kept");
    a.settle().await;
    a.send(protocol::control(
        &json!({"t": "sub-unload", "id": guid("d1")}),
    ));
    // Evicted after `part_evict` (200 ms here), snapshotted because it was written.
    tokio::time::sleep(Duration::from_millis(600)).await;
    let d2 = oc_model::new_doc();
    load(&mut a, "d1", &d2).await;
    assert_eq!(row_title(&d2, "d1", "r1").as_deref(), Some("Kept"));
}

/// A part edit that lands while the room holds a whole view (here, right after an API write)
/// changes that block only: a part's delete set names its fillers, which must not delete the
/// rest of the canvas.
#[tokio::test]
async fn a_part_edit_during_a_whole_view_touches_its_block_only() {
    let (state, _) = server(true).await;
    let host = state.hosts.get("sample").unwrap();
    let mut a = Peer::join(&state, subdoc_grant("u_a", Role::Edit)).await;
    a.settle().await;
    let d = oc_model::new_doc();
    load(&mut a, "d1", &d).await;
    let ops = vec![serde_json::from_value(json!({"op": "append", "markdown": "API"})).unwrap()];
    state
        .rooms
        .patch(&host, &grant("u_api", Role::Edit), ops, "u_api")
        .await
        .unwrap()
        .unwrap();
    edit_part(&a, &d, "d1", "While whole");
    a.settle().await;
    let whole = server_json(&state).await;
    assert_eq!(
        whole["databases"]["d1"]["rows"]["r1"]["title"],
        "While whole"
    );
    assert_eq!(whole["databases"]["d2"]["name"], "Bugs");
    assert_eq!(whole["boards"]["b1"]["order"], json!(["i1"]));
    assert!(whole["content"].to_string().contains("Intro"));
}

fn zip_entry(file: &[u8], name: &str) -> String {
    use std::io::Read;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(file)).unwrap();
    let mut s = String::new();
    z.by_name(name).unwrap().read_to_string(&mut s).unwrap();
    s
}

/// The saved file's content without what differs between any two sessions (who opened it
/// when, and the block ids the API mints).
fn comparable(file: &[u8]) -> (Value, Value) {
    let mut doc: Value = serde_json::from_str(&zip_entry(file, "document.json")).unwrap();
    doc.as_object_mut().unwrap().remove("people");
    let mut search: Value = serde_json::from_str(&zip_entry(file, "search.json")).unwrap();
    let strip = |v: &mut Value| {
        let s = v.to_string();
        let re = regex_lite_strip(&s);
        *v = serde_json::from_str(&re).unwrap();
    };
    strip(&mut doc);
    strip(&mut search);
    (doc, search)
}

/// Replaces `b_<26 chars>` block ids with a placeholder.
fn regex_lite_strip(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'b'
            && b.get(i + 1) == Some(&b'_')
            && i + 28 <= b.len()
            && b[i + 2..i + 28].iter().all(|c| c.is_ascii_alphanumeric())
        {
            out.push_str("b_ID");
            i += 28;
        } else {
            out.push(b[i] as char);
            i += 1;
        }
    }
    out
}

/// PSYNC-04 (PSYNC-A5): the same session on a split room and on a whole one saves the same
/// file: format v1, the same `document.json` and `search.json`, readable by the 0.3 reader; and
/// the API's reads (exports, MCP and search read the same state) see the same canvas.
#[tokio::test]
async fn a_split_room_saves_what_a_whole_room_saves() {
    let mut saved = Vec::new();
    for partial in [false, true] {
        let (state, mock) = server(partial).await;
        let host = state.hosts.get("sample").unwrap();
        let mut g = grant("u_a", Role::Edit);
        g.subdoc = true;
        let mut a = Peer::join(&state, g.clone()).await;
        a.settle().await;
        let ops = vec![
            serde_json::from_value(
                json!({"op": "append", "markdown": "## Notes\n\nShipped **v1**."}),
            )
            .unwrap(),
        ];
        state
            .rooms
            .patch(&host, &grant("u_api", Role::Edit), ops, "u_api")
            .await
            .unwrap()
            .unwrap();
        // A cell edit: through the part on the split room, through the main document otherwise.
        if partial {
            let d = oc_model::new_doc();
            load(&mut a, "d1", &d).await;
            edit_part(&a, &d, "d1", "Uno");
        } else {
            a.settle().await;
            let sv = a.doc.transact().state_vector();
            {
                let dbs = a.doc.get_or_insert_map("databases");
                let mut txn = a.doc.transact_mut();
                let Some(Out::YMap(d)) = dbs.get(&txn, "d1") else {
                    panic!("d1")
                };
                let Some(Out::YMap(rows)) = d.get(&txn, "rows") else {
                    panic!("rows")
                };
                let Some(Out::YMap(r)) = rows.get(&txn, "r1") else {
                    panic!("r1")
                };
                r.insert(&mut txn, "title", "Uno");
            }
            let u = a.doc.transact().encode_state_as_update_v1(&sv);
            a.send(protocol::update(u));
        }
        a.settle().await;
        let api_view = server_json(&state).await;
        state.rooms.commit(&host, &g).await.unwrap();
        let file = mock.lock().unwrap().files[FILE].0.clone();
        // The 0.3 reader opens it: format v1, one document.
        let loaded = oc_model::read_ocanvas(&file).unwrap();
        let read = oc_model::doc_to_json(&loaded.doc);
        assert_eq!(read["databases"]["d1"]["rows"]["r1"]["title"], "Uno");
        let mut api = api_view.clone();
        api.as_object_mut().unwrap().remove("people");
        saved.push((comparable(&file), api));
    }
    assert_eq!(saved[0].0.0, saved[1].0.0, "document.json");
    assert_eq!(saved[0].0.1, saved[1].0.1, "search.json");
    let ids = |v: &Value| serde_json::from_str::<Value>(&regex_lite_strip(&v.to_string())).unwrap();
    assert_eq!(ids(&saved[0].1), ids(&saved[1].1), "API state");
}

/// Room memory on the 50 MB fixture (docs/36 §2.3, PSYNC-A6), one fresh process per figure:
///
/// - `OC_PSYNC_PHASE=whole`: flag off, the room opens the file (0.3 today).
/// - `OC_PSYNC_PHASE=prepare`: flag on, the room opens and splits the file, an editor types a
///   word (the room is dirty), and the room stops without saving; the WAL in `OC_PSYNC_DB`
///   holds the main document and the parts.
/// - `OC_PSYNC_PHASE=split`: flag on, the room opens from that WAL. Only this phase measures
///   the split room: the split itself (on first open) builds the whole canvas once and the
///   process's resident set keeps that high-water mark.
///
/// Each measuring phase joins 20 viewers with `caps=subdoc` on the first page (they sync the
/// main document and load no part) and prints the resident set before and after:
/// `OC_PSYNC_FIXTURE=<canvas-50mb.ocanvas> OC_PSYNC_DB=<file> OC_PSYNC_PHASE=… cargo test
/// --release -p oc-server --test partial_sync room_memory -- --ignored --nocapture`.
#[tokio::test]
#[ignore]
async fn room_memory_on_the_fixture() {
    let phase = std::env::var("OC_PSYNC_PHASE").expect("OC_PSYNC_PHASE");
    let db = std::path::PathBuf::from(std::env::var("OC_PSYNC_DB").expect("OC_PSYNC_DB"));
    let rss = || {
        let out = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse::<u64>()
            .unwrap()
            / 1024
    };
    let (base, mock) = mock_host().await;
    if phase != "split" {
        let path = std::env::var("OC_PSYNC_FIXTURE").expect("OC_PSYNC_FIXTURE");
        let bytes = std::fs::read(path).unwrap();
        mock.lock().unwrap().files.insert(FILE.into(), (bytes, 1));
    }
    let mut cfg = room_cfg();
    cfg.max_doc_bytes = 1 << 30;
    let on = phase != "whole";
    let state = app_custom(&base, cfg, &db, |h| {
        if on {
            h.flags.insert("partial_sync".into(), true.into());
        }
    })
    .await;
    if phase == "prepare" {
        let mut e = Peer::join(&state, subdoc_grant("u_e", Role::Edit)).await;
        e.settle().await;
        e.edit(|d| {
            let c = d.get_or_insert_xml_fragment("content");
            let mut txn = d.transact_mut();
            yrs::XmlFragment::push_back(&c, &mut txn, yrs::XmlTextPrelim::new("typed"));
        });
        e.settle().await;
        state
            .rooms
            .crash(&oc_server::grant::room_id("sample", FILE));
        println!("prepared {}", db.display());
        return;
    }
    let before = rss();
    let started = std::time::Instant::now();
    let mut peers = Vec::new();
    for i in 0..20 {
        let mut p = Peer::join(&state, subdoc_grant(&format!("u_{i}"), Role::View)).await;
        p.settle().await;
        assert_eq!(p.closed, None);
        // Only the room is measured: the test's own copy of the document goes.
        p.doc = Doc::new();
        peers.push(p);
    }
    let opened = started.elapsed();
    tokio::time::sleep(Duration::from_secs(2)).await;
    let after = rss();
    println!(
        "phase {phase}: RSS {before} MB before, {after} MB with the room open and 20 viewers ({} MB for the room; 20 joined in {} ms)",
        after.saturating_sub(before),
        opened.as_millis()
    );
}

/// A block made in the main document moves into a part when the room next splits. An editor
/// that has not seen the new parts list yet still edits it in its main document: that edit
/// must land in the part, not vanish against the main document's fillers.
#[tokio::test]
async fn an_edit_to_a_block_that_just_became_a_part_is_kept() {
    let (state, _) = server(true).await;
    let host = state.hosts.get("sample").unwrap();
    let mut a = Peer::join(&state, subdoc_grant("u_a", Role::Edit)).await;
    a.settle().await;
    // A new database, made in the main document (the editor does this for a new block).
    a.edit(|d| {
        let dbs = d.get_or_insert_map("databases");
        let mut txn = d.transact_mut();
        let db = dbs.insert(&mut txn, "d9", yrs::MapPrelim::default());
        db.insert(&mut txn, "name", "New");
    });
    a.settle().await;
    // Server work makes a whole view; idle, it splits again and d9 becomes a part.
    let ops = vec![serde_json::from_value(json!({"op": "append", "markdown": "x"})).unwrap()];
    state
        .rooms
        .patch(&host, &grant("u_api", Role::Edit), ops, "u_api")
        .await
        .unwrap()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    a.settle().await;
    // The editor still edits d9 where it has it: its main document.
    a.edit(|d| {
        let dbs = d.get_or_insert_map("databases");
        let mut txn = d.transact_mut();
        let Some(Out::YMap(db)) = dbs.get(&txn, "d9") else {
            panic!("d9")
        };
        db.insert(&mut txn, "name", "Renamed");
    });
    a.settle().await;
    let whole = server_json(&state).await;
    assert_eq!(whole["databases"]["d9"]["name"], "Renamed");
}

/// Memory durability (ADR-029, the default without Redis) splits too: no WAL rows, so a part
/// changed during a whole view is written when the view splits again, and a written part when
/// it is evicted. An edit made while whole survives eviction and reload.
#[tokio::test]
async fn memory_durability_keeps_part_edits_made_during_a_whole_view() {
    let (base, mock) = mock_host().await;
    mock.lock()
        .unwrap()
        .files
        .insert(FILE.into(), (canvas(), 1));
    let mut cfg = room_cfg();
    cfg.durability = oc_server::config::Durability::Memory;
    cfg.part_evict = Duration::from_millis(200);
    cfg.whole_release = Duration::from_millis(200);
    let state = app_custom(&base, cfg, &temp_db(), |h| {
        h.flags.insert("partial_sync".into(), true.into());
    })
    .await;
    let host = state.hosts.get("sample").unwrap();
    let mut a = Peer::join(&state, subdoc_grant("u_a", Role::Edit)).await;
    a.settle().await;
    assert!(
        a.controls.iter().any(|c| c["t"] == "parts"),
        "split under memory durability"
    );
    let d = oc_model::new_doc();
    load(&mut a, "d1", &d).await;
    let ops = vec![serde_json::from_value(json!({"op": "append", "markdown": "x"})).unwrap()];
    state
        .rooms
        .patch(&host, &grant("u_api", Role::Edit), ops, "u_api")
        .await
        .unwrap()
        .unwrap();
    edit_part(&a, &d, "d1", "During whole");
    a.settle().await;
    a.send(protocol::control(
        &json!({"t": "sub-unload", "id": guid("d1")}),
    ));
    // The view splits again (200 ms), the part is evicted (200 ms more), then loaded again.
    tokio::time::sleep(Duration::from_millis(800)).await;
    let d2 = oc_model::new_doc();
    load(&mut a, "d1", &d2).await;
    assert_eq!(row_title(&d2, "d1", "r1").as_deref(), Some("During whole"));
}
