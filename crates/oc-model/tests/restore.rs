// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Restore as a minimal edit (VH-01b, docs/30 §5).

use oc_model::import::apply_document_json;
use oc_model::restore::restore_update;
use oc_model::{doc_to_json, new_doc};
use serde_json::{Value, json};
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, StateVector, Transact, Update};

fn p(id: &str, t: &str) -> Value {
    json!({"type":"paragraph","attrs":{"blockId":id},"content":[{"type":"text","text":t}]})
}

fn doc_of(v: &Value) -> yrs::Doc {
    let d = new_doc();
    apply_document_json(&d, v);
    d
}

fn apply(doc: &yrs::Doc, u: &[u8]) {
    doc.transact_mut()
        .apply_update(Update::decode_v1(u).unwrap())
        .unwrap();
}

fn old() -> Value {
    json!({
        "type":"doc",
        "content":[p("b1","Intro"), p("b2","Admins sign in with SAML"), p("b3","Outro")],
        "meta":{"title":"Plan","icon":"rocket"},
        "databases":{"db":{"name":"Tasks","fields":[{"id":"title","name":"Task","type":"title"},{"id":"s","name":"Status","type":"status","options":[{"v":"Todo"}]}],
            "order":["r1","r2"],"rows":{"r1":{"title":"Write","s":"Todo"},"r2":{"title":"Review","s":"Todo"}}}},
        "boards":{"bd":{"order":["s1"],"shapes":{"s1":{"type":"rect","x":0,"y":0,"w":10,"h":10}}}},
        "comments":{"t1":{"quote":"old thread","resolved":false}}
    })
}

#[test]
fn restore_rebuilds_the_old_version_and_keeps_comments() {
    let live = doc_of(&old());
    // Later edits: a block changed and one added, a row edited and one added, a shape moved,
    // the title changed, a new comment thread.
    let mut now = old();
    now["content"][1] = p("b2", "Admins sign in with SSO");
    now["content"].as_array_mut().unwrap().push(p("b4", "New"));
    now["meta"]["title"] = json!("Plan v2");
    now["databases"]["db"]["rows"]["r1"]["s"] = json!("Done");
    now["databases"]["db"]["rows"]["r3"] = json!({"title": "Added"});
    now["boards"]["bd"]["shapes"]["s1"]["x"] = json!(300);
    now["comments"]["t2"] = json!({"quote": "new thread", "resolved": false});
    let target = old();
    let live2 = doc_of(&now);
    let _ = live;
    let u = restore_update(&live2, &target).unwrap();
    apply(&live2, &u);
    let got = doc_to_json(&live2);
    assert_eq!(got["content"], target["content"]);
    assert_eq!(got["meta"], target["meta"]);
    assert_eq!(got["databases"], target["databases"]);
    assert_eq!(got["boards"], target["boards"]);
    // Comments are conversation, not content: both threads stay.
    assert!(got["comments"]["t1"].is_object() && got["comments"]["t2"].is_object());
}

#[test]
fn restore_touches_only_what_differs_so_concurrent_edits_survive() {
    let base = old();
    let server = doc_of(&base);
    let alice = new_doc();
    apply(
        &alice,
        &server
            .transact()
            .encode_state_as_update_v1(&StateVector::default()),
    );
    // Someone changed block b2 since the version; restore computes the edit on the server…
    let mut target = base.clone();
    target["content"][1] = p("b2", "Restored text");
    let u = restore_update(&server, &target).unwrap();
    // …while Alice edits the unrelated row r2 at the same time.
    {
        use yrs::{Map, Out};
        let dbs = alice.get_or_insert_map("databases");
        let mut txn = alice.transact_mut();
        let Some(Out::YMap(db)) = dbs.get(&txn, "db") else {
            panic!()
        };
        let Some(Out::YMap(rows)) = db.get(&txn, "rows") else {
            panic!()
        };
        let Some(Out::YMap(r2)) = rows.get(&txn, "r2") else {
            panic!()
        };
        r2.insert(&mut txn, "s", "Done by Alice");
    }
    let alice_update = alice
        .transact()
        .encode_state_as_update_v1(&server.transact().state_vector());
    apply(&server, &u);
    apply(&server, &alice_update);
    let got = doc_to_json(&server);
    assert_eq!(got["content"][1], target["content"][1]);
    assert_eq!(got["databases"]["db"]["rows"]["r2"]["s"], "Done by Alice");
    // The untouched blocks were not rewritten: nothing to restore gives an empty change.
    let again = restore_update(&server, &got).unwrap();
    let before = server.transact().state_vector();
    apply(&server, &again);
    assert_eq!(server.transact().state_vector(), before);
}
