// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! VH-02a: structural diff of two versions (ADR-052, docs/30 §6.1).
//!
//! The fixtures in `tests/fixtures/diff/*.json` (`{old, new, expected}`) are shared with the web
//! renderer, which places its decorations from `expected` (web/packages/editor history tests).
//! `OC_UPDATE_FIXTURES=1 cargo test -p oc-model --test diff` rewrites `expected` after a reviewed
//! change.

use std::time::Duration;

use oc_model::diff::{DiffCache, DiffError, Limits, diff_json};
use serde_json::{Value, json};

fn doc(content: Value) -> Value {
    json!({"type":"doc","content":content,"meta":{},"databases":{},"boards":{},"comments":{}})
}
fn p(id: &str, text: &str) -> Value {
    json!({"type":"paragraph","attrs":{"blockId":id},"content":[{"type":"text","text":text}]})
}
fn p_noid(text: &str) -> Value {
    json!({"type":"paragraph","content":[{"type":"text","text":text}]})
}
fn d(old: &Value, new: &Value) -> Value {
    diff_json(old, new, &Limits::default()).unwrap()
}
fn ops(v: &Value) -> Vec<(String, String)> {
    v["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| {
            (
                b["op"].as_str().unwrap().to_string(),
                b["blockId"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect()
}

#[test]
fn identical_versions_have_no_changes() {
    let a = doc(json!([p("b1", "one"), p("b2", "two")]));
    let r = d(&a, &a);
    assert_eq!(
        r["summary"],
        json!({"added":0,"removed":0,"changed":0,"moved":0})
    );
    assert_eq!(r["blocks"], json!([]));
    assert_eq!(r["truncated"], false);
}

#[test]
fn blocks_added_removed_and_changed_by_id_with_inline_words() {
    let a = doc(json!([
        p("b1", "Admins can sign in with SAML today"),
        p("b2", "gone"),
        p("b3", "same")
    ]));
    let b = doc(json!([
        p("b1", "Admins can sign in with SSO today"),
        p("b3", "same"),
        p("b4", "new")
    ]));
    let r = d(&a, &b);
    assert_eq!(
        ops(&r),
        vec![
            ("changed".into(), "b1".into()),
            ("removed".into(), "b2".into()),
            ("added".into(), "b4".into())
        ]
    );
    assert_eq!(
        r["blocks"][0]["text"],
        json!([
            ["eq", "Admins can sign in with "],
            ["del", "SAML"],
            ["ins", "SSO"],
            ["eq", " today"]
        ])
    );
    assert_eq!(r["blocks"][0]["path"], "/content/0");
    // A removed block says where it was: after b1 in the new version.
    assert_eq!(r["blocks"][1]["path"], "/content/1");
    assert_eq!(
        r["blocks"][1]["after"],
        json!({"blockId":"b1","path":"/content/0"})
    );
    assert_eq!(r["blocks"][1]["node"]["content"][0]["text"], "gone");
    assert_eq!(r["blocks"][2]["path"], "/content/2");
    assert_eq!(
        r["summary"],
        json!({"added":1,"removed":1,"changed":1,"moved":0})
    );
}

#[test]
fn semantic_cleanup_merges_word_runs() {
    let a = doc(json!([p("b1", "the quick brown fox")]));
    let b = doc(json!([p("b1", "the slow red fox")]));
    let r = d(&a, &b);
    // "quick brown" → "slow red" is one change, not two split by the shared space.
    assert_eq!(
        r["blocks"][0]["text"],
        json!([
            ["eq", "the "],
            ["del", "quick brown"],
            ["ins", "slow red"],
            ["eq", " fox"]
        ])
    );
}

#[test]
fn mark_only_change_is_formatting() {
    let a = doc(json!([p("b1", "bold me")]));
    let b = doc(
        json!([{"type":"paragraph","attrs":{"blockId":"b1"},"content":[
        {"type":"text","text":"bold","marks":[{"type":"bold"}]},{"type":"text","text":" me"}]}]),
    );
    let r = d(&a, &b);
    assert_eq!(r["blocks"][0]["op"], "changed");
    assert_eq!(r["blocks"][0]["changes"], json!(["formatting"]));
    assert!(r["blocks"][0].get("text").is_none());
}

#[test]
fn attribute_change_is_reported() {
    let a = doc(
        json!([{"type":"heading","attrs":{"blockId":"h","level":1},"content":[{"type":"text","text":"T"}]}]),
    );
    let b = doc(
        json!([{"type":"heading","attrs":{"blockId":"h","level":2},"content":[{"type":"text","text":"T"}]}]),
    );
    let r = d(&a, &b);
    assert_eq!(r["blocks"][0]["changes"], json!(["attrs"]));
    assert_eq!(r["blocks"][0]["attrs"], json!({"level":{"old":1,"new":2}}));
}

#[test]
fn a_ticked_task_is_a_change_of_its_paragraph() {
    let task = |checked: bool| json!([{"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":checked},"content":[p_noid("Fix the bug")]}]}]);
    let r = d(&doc(task(false)), &doc(task(true)));
    assert_eq!(r["blocks"][0]["changes"], json!(["attrs"]));
    assert_eq!(
        r["blocks"][0]["attrs"],
        json!({"taskItem.checked":{"old":false,"new":true}})
    );
}

#[test]
fn moved_blocks_are_outside_the_longest_increasing_run() {
    let a = doc(json!([
        p("b1", "1"),
        p("b2", "2"),
        p("b3", "3"),
        p("b4", "4")
    ]));
    let b = doc(json!([
        p("b2", "2"),
        p("b3", "3"),
        p("b4", "4"),
        p("b1", "1")
    ]));
    let r = d(&a, &b);
    assert_eq!(ops(&r), vec![("moved".into(), "b1".into())]);
    assert_eq!(r["blocks"][0]["from"], "/content/0");
    assert_eq!(r["blocks"][0]["path"], "/content/3");
    assert_eq!(r["summary"]["moved"], 1);
}

#[test]
fn blocks_without_ids_match_by_signature_then_similarity() {
    let a = doc(json!([
        p_noid("Intro"),
        p_noid("We will ship the editor on Friday"),
        p_noid("Old line"),
        p_noid("Outro")
    ]));
    let b = doc(json!([
        p_noid("Intro"),
        p_noid("We will ship the new editor on Monday"),
        p_noid("Outro")
    ]));
    let r = d(&a, &b);
    let o: Vec<String> = r["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["op"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(o, vec!["changed", "removed"]);
    assert_eq!(r["blocks"][0]["path"], "/content/1");
    assert_eq!(r["blocks"][1]["node"]["content"][0]["text"], "Old line");
}

#[test]
fn nested_blocks_have_paths_into_lists() {
    let li = |id: &str, t: &str| json!({"type":"listItem","content":[p(id, t)]});
    let a = doc(json!([{"type":"bulletList","content":[li("x","a"), li("y","b")]}]));
    let b = doc(json!([{"type":"bulletList","content":[li("x","a"), li("y","b!"), li("z","c")]}]));
    let r = d(&a, &b);
    assert_eq!(r["blocks"][0]["path"], "/content/0/content/1/content/0");
    assert_eq!(r["blocks"][0]["op"], "changed");
    assert_eq!(r["blocks"][1]["path"], "/content/0/content/2/content/0");
    assert_eq!(r["blocks"][1]["op"], "added");
}

#[test]
fn meta_title_and_icon() {
    let mut a = doc(json!([]));
    let mut b = doc(json!([]));
    a["meta"] = json!({"title":"Plan","icon":"rocket"});
    b["meta"] = json!({"title":"Plan v2","icon":"rocket"});
    let r = d(&a, &b);
    assert_eq!(
        r["meta"],
        json!([{"field":"title","old":"Plan","new":"Plan v2"}])
    );
    assert_eq!(r["summary"]["changed"], 1);
}

#[test]
fn databases_fields_rows_cells_notes_order_views() {
    let mut a = doc(json!([]));
    let mut b = doc(json!([]));
    a["databases"] = json!({"db_1":{
        "name":"Tasks",
        "fields":[{"id":"title","name":"Name","type":"title"},{"id":"status","name":"Status","type":"status","options":[{"v":"Todo"}]},{"id":"old","name":"Old","type":"text"}],
        "order":["r_1","r_2","r_3"],
        "rows":{"r_1":{"title":"Write","status":"Todo"},"r_2":{"title":"Review","status":"In progress"},"r_3":{"title":"Drop"}},
        "notes":{"r_1":"first note"},
        "view":"table"
    }});
    b["databases"] = json!({"db_1":{
        "name":"Tasks",
        "fields":[{"id":"title","name":"Title","type":"title"},{"id":"status","name":"Status","type":"status","options":[{"v":"Todo"},{"v":"Done"}]},{"id":"due","name":"Due","type":"date"}],
        "order":["r_2","r_1","r_9"],
        "rows":{"r_1":{"title":"Write","status":"Todo"},"r_2":{"title":"Review","status":"In review"},"r_9":{"title":"New task"}},
        "notes":{"r_1":"first note, edited"},
        "view":"board"
    }});
    let r = d(&a, &b);
    let db = &r["databases"][0];
    assert_eq!(db["dbId"], "db_1");
    assert_eq!(db["op"], "changed");
    assert_eq!(
        db["fields"],
        json!([
            {"op":"changed","fieldId":"title","name":"Title","changes":["renamed"],"old":"Name","new":"Title"},
            {"op":"changed","fieldId":"status","name":"Status","changes":["options"]},
            {"op":"removed","fieldId":"old","name":"Old"},
            {"op":"added","fieldId":"due","name":"Due"}
        ])
    );
    assert_eq!(
        db["rows"],
        json!([{"op":"removed","rowId":"r_3","title":"Drop"},{"op":"added","rowId":"r_9","title":"New task"}])
    );
    assert_eq!(
        db["cells"],
        json!([{"rowId":"r_2","fieldId":"status","field":"Status","old":"In progress","new":"In review"}])
    );
    assert_eq!(db["notes"][0]["rowId"], "r_1");
    assert_eq!(
        db["notes"][0]["text"],
        json!([["eq", "first note"], ["ins", ", edited"]])
    );
    assert_eq!(db["order"], true);
    assert_eq!(db["views"], true);
}

#[test]
fn database_added_and_removed() {
    let mut a = doc(json!([]));
    let mut b = doc(json!([]));
    a["databases"] = json!({"db_old":{"name":"Old","fields":[],"rows":{}}});
    b["databases"] = json!({"db_new":{"name":"New","fields":[],"rows":{}}});
    let r = d(&a, &b);
    assert_eq!(
        r["databases"],
        json!([{"dbId":"db_new","op":"added","name":"New"},{"dbId":"db_old","op":"removed","name":"Old"}])
    );
}

#[test]
fn boards_shapes_added_removed_moved_resized_text_style_rebound() {
    let mut a = doc(json!([]));
    let mut b = doc(json!([]));
    a["boards"] = json!({"bd_1":{
    "order":["s1","s2","s3","s4","s5","a1"],
    "shapes":{
        "s1":{"type":"sticky","x":0,"y":0,"w":160,"h":120,"text":"keep"},
        "s2":{"type":"rect","x":120,"y":80,"w":100,"h":60},
        "s3":{"type":"rect","x":0,"y":0,"w":100,"h":60,"text":"Login"},
        "s4":{"type":"ellipse","x":0,"y":0,"w":50,"h":50},
        "s5":{"type":"rect","x":10,"y":10,"w":10,"h":10,"fill":"blue"},
        "a1":{"type":"arrow","start":{"shapeId":"s1","anchor":"right"},"end":{"shapeId":"s2","anchor":"left"},"pts":[[0,0],[10,10]]}
    }}});
    b["boards"] = json!({"bd_1":{
    "order":["s2","s1","s3","s5","a1","s6"],
    "shapes":{
        "s1":{"type":"sticky","x":1,"y":1,"w":160,"h":120,"text":"keep"},
        "s2":{"type":"rect","x":340,"y":80,"w":100,"h":60},
        "s3":{"type":"rect","x":0,"y":0,"w":200,"h":60,"text":"Sign in"},
        "s5":{"type":"rect","x":10,"y":10,"w":10,"h":10,"fill":"red"},
        "a1":{"type":"arrow","start":{"shapeId":"s1","anchor":"right"},"end":{"shapeId":"s3","anchor":"left"},"pts":[[0,0],[99,99]]},
        "s6":{"type":"sticky","x":500,"y":500,"w":160,"h":120}
    }}});
    let r = d(&a, &b);
    let shapes = &r["boards"][0]["shapes"];
    assert_eq!(r["boards"][0]["boardId"], "bd_1");
    // s1 moved by 1 px: not a move.
    assert_eq!(
        shapes[0],
        json!({"op":"moved","shapeId":"s2","type":"rect","changes":["moved"],"from":[120.0,80.0],"to":[340.0,80.0]})
    );
    assert_eq!(shapes[1]["shapeId"], "s3");
    assert_eq!(shapes[1]["changes"], json!(["resized", "text"]));
    assert_eq!(
        shapes[1]["text"],
        json!([["del", "Login"], ["ins", "Sign in"]])
    );
    assert_eq!(shapes[2]["shapeId"], "s5");
    assert_eq!(shapes[2]["changes"], json!(["style"]));
    assert_eq!(shapes[2]["style"], json!(["fill"]));
    assert_eq!(shapes[3]["shapeId"], "a1");
    assert_eq!(shapes[3]["changes"], json!(["rebound"]));
    assert_eq!(shapes[4]["op"], "removed");
    assert_eq!(shapes[4]["shapeId"], "s4");
    assert_eq!(shapes[4]["shape"]["type"], "ellipse");
    assert_eq!(shapes[5]["op"], "added");
    assert_eq!(shapes[5]["shapeId"], "s6");
    assert_eq!(r["boards"][0]["order"], true);
}

#[test]
fn entry_limit_truncates() {
    let a = doc(json!([]));
    let blocks: Vec<Value> = (0..50).map(|i| p(&format!("b{i}"), "x")).collect();
    let b = doc(Value::Array(blocks));
    let r = diff_json(
        &a,
        &b,
        &Limits {
            max_entries: 10,
            ..Limits::default()
        },
    )
    .unwrap();
    assert_eq!(r["blocks"].as_array().unwrap().len(), 10);
    assert_eq!(r["truncated"], true);
}

#[test]
fn time_limit_refuses() {
    let a = doc(json!([p("b1", "a")]));
    let b = doc(json!([p("b1", "b")]));
    let e = diff_json(
        &a,
        &b,
        &Limits {
            max_time: Duration::ZERO,
            ..Limits::default()
        },
    );
    assert!(matches!(e, Err(DiffError::TimedOut)));
}

#[test]
fn large_documents_stay_fast() {
    // 2,000 paragraphs without ids, one in ten edited: well under the 5 s limit.
    let a: Vec<Value> = (0..2000)
        .map(|i| p_noid(&format!("line {i} of the plan with some words")))
        .collect();
    let b: Vec<Value> = (0..2000)
        .map(|i| {
            if i % 10 == 0 {
                p_noid(&format!("line {i} of the new plan with other words"))
            } else {
                p_noid(&format!("line {i} of the plan with some words"))
            }
        })
        .collect();
    let r = diff_json(
        &doc(Value::Array(a)),
        &doc(Value::Array(b)),
        &Limits::default(),
    )
    .unwrap();
    assert_eq!(r["summary"]["changed"], 200);
}

#[test]
fn cache_is_bounded_by_bytes_and_expires() {
    let c: DiffCache<String> = DiffCache::new(100, Duration::from_secs(300));
    let t0 = std::time::Instant::now();
    c.insert_at("a".into(), "A".into(), 60, t0);
    c.insert_at("b".into(), "B".into(), 60, t0);
    // Over 100 bytes: the least recently used entry ("a") went.
    assert!(c.get_at("a", t0).is_none());
    assert_eq!(c.get_at("b", t0).as_deref(), Some(&"B".to_string()));
    // Expired after the TTL.
    assert!(c.get_at("b", t0 + Duration::from_secs(301)).is_none());
    // An entry bigger than the whole cache is not kept.
    c.insert_at("huge".into(), "H".into(), 1000, t0);
    assert!(c.get_at("huge", t0).is_none());
}

/// Shared fixtures: `expected` is what the web renderer decorates from.
#[test]
fn shared_fixtures() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/diff");
    let mut names: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    names.sort();
    assert!(names.len() >= 4, "fixtures missing in {dir}");
    for path in names {
        let mut f: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let got = d(&f["old"], &f["new"]);
        if std::env::var("OC_UPDATE_FIXTURES").is_ok() {
            f["expected"] = got;
            std::fs::write(&path, serde_json::to_string_pretty(&f).unwrap() + "\n").unwrap();
            continue;
        }
        assert_eq!(got, f["expected"], "{}", path.display());
    }
}
