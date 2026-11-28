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
            h.flags.remove("partial_sync");
        } else {
            h.flags.insert("partial_sync".into(), false.into());
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
async fn old_editors_are_closed_with_4426_by_default_and_welcome_when_disabled() {
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

    // Explicit opt-out lets the same old editor receive the complete canvas.
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
    v.send(protocol::subdoc(&guid("d1"), &protocol::step2(vec![0, 0])));
    v.settle().await;
    assert_eq!(v.denied, 0);
    let txn = dv.transact();
    let echo = txn.encode_state_as_update_v1(&txn.state_vector());
    drop(txn);
    assert!(!oc_model::parts::delete_set(&echo).unwrap().is_empty());
    v.send(protocol::subdoc(&guid("d1"), &protocol::step2(echo)));
    v.settle().await;
    assert_eq!(v.denied, 0);
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
async fn canvases_with_the_same_block_id_keep_separate_part_state() {
    let (state, mock) = server(true).await;
    let other_file = "doc_2";
    mock.lock()
        .unwrap()
        .files
        .insert(other_file.into(), (canvas(), 1));

    let mut first = Peer::join(&state, subdoc_grant("u_first", Role::Edit)).await;
    first.settle().await;
    let first_part = oc_model::new_doc();
    load(&mut first, "d1", &first_part).await;
    edit_part(&first, &first_part, "d1", "Only in the first canvas");
    first.settle().await;

    let mut other_grant = subdoc_grant("u_other", Role::View);
    other_grant.file.id = other_file.into();
    other_grant.room = oc_server::grant::room_id("sample", other_file);
    let mut other = Peer::join(&state, other_grant).await;
    let other_guid = format!("{other_file}/block/d1");
    other.send(protocol::subdoc(
        &other_guid,
        &protocol::step1(StateVector::default()),
    ));
    other.settle().await;
    let other_part = oc_model::new_doc();
    for (guid, msg) in other.subs {
        if guid == other_guid
            && let Message::Sync(SyncMessage::SyncStep2(update)) = msg
        {
            oc_model::ocanvas::apply_update_bytes(&other_part, &update).unwrap();
        }
    }
    assert_eq!(row_title(&other_part, "d1", "r1").as_deref(), Some("One"));
    assert_eq!(
        server_json(&state).await["databases"]["d1"]["rows"]["r1"]["title"],
        "Only in the first canvas"
    );
}

/// SEC-V4 (partial sync): one client id must not write to two documents of a split room, in
/// either order. A main-document edit and a part edit with the same client id collide when the
/// room flattens the parts (saves, whole views), so one editor could stop every save.
#[tokio::test]
async fn a_client_id_used_in_the_main_document_is_refused_in_a_part() {
    let (state, _) = server(true).await;
    let mut e = Peer::join(&state, subdoc_grant("u_e", Role::Edit)).await;
    e.settle().await;
    let dd = Doc::with_client_id(4242);
    oc_model::ensure_roots(&dd);
    load(&mut e, "d1", &dd).await;
    // A main-document edit with the part doc's client id: a new top-level map entry.
    let main = Doc::with_client_id(4242);
    {
        let m: MapRef = main.get_or_insert_map("meta");
        let mut txn = main.transact_mut();
        m.insert(&mut txn, "note", "from main");
    }
    let u = main
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    e.send(protocol::update(u));
    e.settle().await;
    // The same client id in the part.
    edit_part(&e, &dd, "d1", "Mine");
    e.settle().await;
    let refused = e.controls.iter().any(|c| {
        c["t"] == "sub-denied"
            && c["reason"]
                .as_str()
                .is_some_and(|r| r.contains("client id"))
    });
    assert!(
        refused,
        "cross-document client id was accepted: {:?}",
        e.controls
    );
    let whole = server_json(&state).await;
    assert_eq!(whole["databases"]["d1"]["rows"]["r1"]["title"], "One");
}

/// PSYNC-BUG-4: the client-id rule refuses a write only where another document was given the
/// clocks. An editor that made a database in its main document (its items moved to a part at
/// the next split) keeps typing in the main document; and an editor that loads that part
/// during a whole view answers the room's step 1 with the fillers it was sent. The old rule
/// (refuse past what every document knows, or without owning the stream's tail) refused both.
#[tokio::test]
async fn the_client_id_rule_refuses_only_clocks_another_document_was_given() {
    let (state, _) = server(true).await;
    let host = state.hosts.get("sample").unwrap();
    let mut a = Peer::join(&state, subdoc_grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&state, subdoc_grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;
    a.edit(|d| {
        let dbs = d.get_or_insert_map("databases");
        let mut txn = d.transact_mut();
        let db = dbs.insert(&mut txn, "d9", yrs::MapPrelim::default());
        db.insert(&mut txn, "name", "New");
    });
    a.settle().await;
    let append = |text: &str| -> Vec<oc_model::patch::PatchOp> {
        vec![serde_json::from_value(json!({"op": "append", "markdown": text})).unwrap()]
    };
    state
        .rooms
        .patch(&host, &grant("u_api", Role::Edit), append("x"), "u_api")
        .await
        .unwrap()
        .unwrap();
    // Idle: the view splits and d9 (a's items) becomes a part.
    tokio::time::sleep(Duration::from_millis(600)).await;
    a.settle().await;
    b.settle().await;
    a.edit(|d| {
        let meta = d.get_or_insert_map("meta");
        meta.insert(&mut d.transact_mut(), "note", "after the split");
    });
    a.settle().await;
    let refused = |p: &Peer| {
        p.denied > 0
            || p.controls.iter().any(|c| {
                c["reason"]
                    .as_str()
                    .is_some_and(|r| r.contains("client id"))
            })
    };
    assert!(!refused(&a), "a main edit was refused: {:?}", a.controls);
    assert_eq!(server_json(&state).await["meta"]["note"], "after the split");
    // A whole view; b loads d9 and answers the room's step 1 as a Yjs client does.
    state
        .rooms
        .patch(&host, &grant("u_api", Role::Edit), append("y"), "u_api")
        .await
        .unwrap()
        .unwrap();
    let d = Doc::with_client_id(777);
    oc_model::ensure_roots(&d);
    b.send(protocol::subdoc(
        &guid("d9"),
        &protocol::step1(d.transact().state_vector()),
    ));
    b.settle().await;
    let mut asked = None;
    for (g, m) in std::mem::take(&mut b.subs) {
        if g != guid("d9") {
            continue;
        }
        match m {
            Message::Sync(SyncMessage::SyncStep2(u) | SyncMessage::Update(u)) => {
                d.transact_mut()
                    .apply_update(Update::decode_v1(&u).unwrap())
                    .unwrap();
            }
            Message::Sync(SyncMessage::SyncStep1(sv)) => asked = Some(sv),
            _ => {}
        }
    }
    let asked = asked.expect("the room asks for the part's state");
    let reply = d.transact().encode_state_as_update_v1(&asked);
    b.send(protocol::subdoc(&guid("d9"), &protocol::step2(reply)));
    b.settle().await;
    assert!(!refused(&b), "the sync reply was refused: {:?}", b.controls);
    // b's own edit of the part lands.
    let sv = d.transact().state_vector();
    {
        let dbs: MapRef = d.get_or_insert_map("databases");
        let mut txn = d.transact_mut();
        let Some(Out::YMap(db)) = dbs.get(&txn, "d9") else {
            panic!("d9 not loaded");
        };
        db.insert(&mut txn, "name", "Renamed by b");
    }
    let u = d.transact().encode_state_as_update_v1(&sv);
    b.send(protocol::subdoc(&guid("d9"), &protocol::update(u)));
    b.settle().await;
    assert!(!refused(&b), "b's edit was refused: {:?}", b.controls);
    let whole = server_json(&state).await;
    assert_eq!(whole["databases"]["d9"]["name"], "Renamed by b");
    assert_eq!(whole["meta"]["note"], "after the split");
}

/// SEC-V4 (partial sync): edits to a part count against the document size limit, as main
/// document edits do (`max_doc_bytes`); they bypassed it, so one editor could grow a split
/// canvas without bound.
#[tokio::test]
async fn part_edits_count_against_the_document_size_limit() {
    let (base, mock) = mock_host().await;
    mock.lock()
        .unwrap()
        .files
        .insert(FILE.into(), (canvas(), 1));
    let mut cfg = room_cfg();
    cfg.max_doc_bytes = 100_000;
    let state = app_custom(&base, cfg, &temp_db(), |h| {
        h.flags.insert("partial_sync".into(), true.into());
    })
    .await;
    let mut e = Peer::join(&state, subdoc_grant("u_e", Role::Edit)).await;
    e.settle().await;
    let dd = oc_model::new_doc();
    load(&mut e, "d1", &dd).await;
    let big = "x".repeat(40_000);
    for i in 0..6 {
        edit_part(&e, &dd, "d1", &format!("{i}{big}"));
        e.settle().await;
    }
    assert!(
        e.controls.iter().any(|c| c["reason"]
            .as_str()
            .is_some_and(|r| r.contains("size limit"))),
        "240 KB of part edits passed a 100 KB limit: {:?}",
        e.controls
    );
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
    // Routing the first edit gives main a filler for its clocks. The part still owns the
    // client stream and must be able to extend it.
    edit_part(&a, &d, "d1", "Second edit while whole");
    a.settle().await;
    let whole = server_json(&state).await;
    assert_eq!(
        whole["databases"]["d1"]["rows"]["r1"]["title"],
        "Second edit while whole"
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
        h.flags.insert("partial_sync".into(), on.into());
    })
    .await;
    if phase == "prepare" {
        let t = std::time::Instant::now();
        let mut e = Peer::join(&state, subdoc_grant("u_e", Role::Edit)).await;
        e.settle().await;
        println!(
            "first open (load from the host, split, sync): {} ms",
            t.elapsed().as_millis()
        );
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

/// A delete-only main update refers to structs that are absent from that update.
#[tokio::test]
async fn a_main_deletion_during_a_whole_view_reaches_other_editors() {
    let (state, _) = server(true).await;
    let host = state.hosts.get("sample").unwrap();
    let mut a = Peer::join(&state, subdoc_grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&state, subdoc_grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;

    let ops = vec![serde_json::from_value(json!({"op": "append", "markdown": "keep"})).unwrap()];
    state
        .rooms
        .patch(&host, &grant("u_api", Role::Edit), ops, "u_api")
        .await
        .unwrap()
        .unwrap();

    a.edit(|d| {
        let content = d.get_or_insert_xml_fragment("content");
        yrs::XmlFragment::remove_range(&content, &mut d.transact_mut(), 0, 1);
    });
    b.settle().await;
    let json = oc_model::doc_to_json(&b.doc);
    assert_eq!(json["content"][0]["content"][0]["text"], "keep");
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

/// A split room on a given storage (`tweak` picks it), with fast timings.
async fn server_on(
    tweak_cfg: impl FnOnce(&mut oc_server::config::Config),
    durability: oc_server::config::Durability,
) -> (oc_server::SharedState, Shared, std::path::PathBuf) {
    let (base, mock) = mock_host().await;
    mock.lock()
        .unwrap()
        .files
        .insert(FILE.into(), (canvas(), 1));
    let mut cfg = room_cfg();
    cfg.durability = durability;
    cfg.part_evict = Duration::from_millis(200);
    cfg.whole_release = Duration::from_millis(200);
    let db = temp_db();
    let state = app_full(
        &base,
        cfg,
        &db,
        |h| {
            h.flags.insert("partial_sync".into(), true.into());
        },
        tweak_cfg,
    )
    .await;
    (state, mock, db)
}

/// Edits a part, crashes the room (no save, no dump), opens it again: the part edit is back.
async fn part_edit_survives_a_crash(state: &oc_server::SharedState) {
    let room = oc_server::grant::room_id("sample", FILE);
    let mut a = Peer::join(state, subdoc_grant("u_a", Role::Edit)).await;
    a.settle().await;
    assert!(a.controls.iter().any(|c| c["t"] == "parts"), "split");
    let d = oc_model::new_doc();
    load(&mut a, "d1", &d).await;
    assert!(
        row_title(&d, "d1", "r1").is_some(),
        "part loaded: {:?}",
        a.controls
    );
    edit_part(&a, &d, "d1", "Before the crash");
    a.settle().await;
    a.leave();
    state.rooms.crash(&room);
    let mut b = Peer::join(state, subdoc_grant("u_b", Role::Edit)).await;
    b.settle().await;
    let d2 = oc_model::new_doc();
    load(&mut b, "d1", &d2).await;
    assert_eq!(
        row_title(&d2, "d1", "r1").as_deref(),
        Some("Before the crash"),
        "controls after reopening: {:?}",
        b.controls
    );
}

/// PSYNC-02 crash safety: under memory durability a part's edits are in the WAL as they
/// happen (only the main document waits for the periodic dump).
#[tokio::test]
async fn memory_durability_writes_part_edits_to_the_wal() {
    let (state, _, _) = server_on(|_| {}, oc_server::config::Durability::Memory).await;
    part_edit_survives_a_crash(&state).await;
}

/// Redis: parts on the Redis WAL in front of the database, and on Redis-only storage
/// (`OC_TEST_REDIS_URL`, for example `redis://127.0.0.1:16399/`).
#[tokio::test]
async fn parts_on_redis_survive_a_crash() {
    let Ok(url) = std::env::var("OC_TEST_REDIS_URL") else {
        eprintln!("OC_TEST_REDIS_URL not set: Redis skipped");
        return;
    };
    // The room id is fixed (FILE): start from an empty Redis (a dedicated test instance), or a
    // dirty room left by an earlier run would be recovered instead of opened from the host.
    let client = redis::Client::open(url.as_str()).unwrap();
    let mut c = client.get_multiplexed_async_connection().await.unwrap();
    let _: () = redis::cmd("FLUSHDB").query_async(&mut c).await.unwrap();
    let u = url.clone();
    let (state, _, _) = server_on(
        move |c| c.wal_redis_url = Some(u),
        oc_server::config::Durability::Wal,
    )
    .await;
    part_edit_survives_a_crash(&state).await;
    let (state, _, _) = server_on(
        move |c| {
            c.storage_redis_url = Some(url);
            c.database_url = String::new();
        },
        oc_server::config::Durability::Wal,
    )
    .await;
    part_edit_survives_a_crash(&state).await;
}

/// PSYNC-A4: random concurrent work on a split room (text, cells in parts, API writes that
/// take whole views, view releases, unloads and reloads) converges: every editor's documents
/// and the room's merged state agree. `OC_PSYNC_FUZZ` sets the iterations (nightly: 10,000).
#[tokio::test]
async fn fuzz_split_rooms_converge() {
    let iters: u64 = std::env::var("OC_PSYNC_FUZZ")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(6);
    for seed in 1..=iters {
        let mut rng = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let mut next = move |n: u64| {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            rng % n
        };
        let (state, _) = server(true).await;
        let host = state.hosts.get("sample").unwrap();
        let mut peers = Vec::new();
        for i in 0..3 {
            let mut p = Peer::join(&state, subdoc_grant(&format!("u_{i}"), Role::Edit)).await;
            p.settle().await;
            let d = oc_model::new_doc();
            load(&mut p, "d1", &d).await;
            assert!(
                row_title(&d, "d1", "r1").is_some(),
                "seed {seed}: first load: {:?}",
                p.controls
            );
            peers.push((p, d));
        }
        for step in 0..12 {
            let i = next(3) as usize;
            match next(5) {
                0 => {
                    let (p, d) = &peers[i];
                    assert!(
                        row_title(d, "d1", "r1").is_some(),
                        "seed {seed} step {step} peer {i}: lost d1: {}",
                        oc_model::doc_to_json(d)["databases"]
                    );
                    edit_part(p, d, "d1", &format!("s{seed}-{step}-{i}"));
                }
                1 => {
                    let (p, _) = &peers[i];
                    let text = format!("t{seed}-{step}");
                    p.edit(|d| {
                        let c = d.get_or_insert_xml_fragment("content");
                        let mut txn = d.transact_mut();
                        yrs::XmlFragment::push_back(&c, &mut txn, yrs::XmlTextPrelim::new(text));
                    });
                }
                2 => {
                    let md = format!("api {seed}-{step}");
                    let ops = vec![
                        serde_json::from_value(json!({"op": "append", "markdown": md})).unwrap(),
                    ];
                    state
                        .rooms
                        .patch(&host, &grant("u_api", Role::Edit), ops, "u_api")
                        .await
                        .unwrap()
                        .unwrap();
                }
                3 => tokio::time::sleep(Duration::from_millis(250)).await,
                _ => {
                    // Unload and load again (maybe after an eviction).
                    let (p, _) = &mut peers[i];
                    p.send(protocol::control(
                        &json!({"t": "sub-unload", "id": guid("d1")}),
                    ));
                    if next(2) == 0 {
                        tokio::time::sleep(Duration::from_millis(450)).await;
                    }
                    let d = oc_model::new_doc();
                    load(p, "d1", &d).await;
                    assert!(
                        row_title(&d, "d1", "r1").is_some(),
                        "seed {seed} step {step}: reload: {:?}",
                        p.controls.iter().rev().take(4).collect::<Vec<_>>()
                    );
                    peers[i].1 = d;
                }
            }
            for (p, d) in peers.iter_mut() {
                p.settle().await;
                take_into(p, "d1", d);
            }
        }
        let want = server_json(&state).await;
        for (i, (p, d)) in peers.iter().enumerate() {
            let main = json_of(&p.doc);
            assert_eq!(
                main["content"], want["content"],
                "seed {seed}: peer {i} text"
            );
            assert_eq!(
                db(d, "d1"),
                want["databases"]["d1"],
                "seed {seed}: peer {i} database"
            );
        }
    }
}
