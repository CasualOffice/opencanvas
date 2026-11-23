// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! In-file bounded history (ADR-055): reverse diffs rebuild every kept version, the bounds drop
//! automatic versions first, and the layout round-trips through `.ocanvas`.

use oc_model::history::{FileHistory, Limits, VersionMeta, apply_reverse, reverse_diff};
use oc_model::import::apply_document_json;
use oc_model::ocanvas::{CommitKind, read_ocanvas, write_ocanvas, write_ocanvas_with};
use oc_model::{CommitInfo, doc_to_json, new_doc};
use serde_json::{Value, json};

fn p(id: &str, t: &str) -> Value {
    json!({"type":"paragraph","attrs":{"blockId":id},"content":[{"type":"text","text":t}]})
}

/// A canvas after `n` edits: each edit appends a paragraph and changes the title, a row and a
/// shape.
fn state(n: usize) -> Value {
    let content: Vec<Value> = (0..=n)
        .map(|i| p(&format!("b{i}"), &format!("line {i}")))
        .collect();
    json!({
        "type": "doc",
        "content": content,
        "meta": {"title": format!("Plan v{n}")},
        "databases": {"db": {"name": "Tasks", "rows": {"r1": {"title": format!("task {n}")}}, "order": ["r1"]}},
        "boards": {"bd": {"shapes": {"s1": {"type": "rect", "x": n * 10, "y": 0}}}},
        "comments": {"t1": {"quote": "kept as they are now"}}
    })
}

fn meta(id: &str, kind: CommitKind) -> VersionMeta {
    VersionMeta {
        id: id.into(),
        kind,
        name: (kind != CommitKind::Auto).then(|| format!("name {id}")),
        at: "2026-11-24T10:00:00Z".into(),
        ..Default::default()
    }
}

fn big() -> Limits {
    Limits {
        max_bytes: 1 << 30,
        max_versions: 1000,
    }
}

#[test]
fn reverse_diff_rebuilds_the_older_version_exactly() {
    let (newer, older) = (state(5), state(2));
    let d = reverse_diff(&newer, &older);
    let mut want = older.clone();
    want["comments"] = newer["comments"].clone(); // comments are never history (docs/30 §5)
    assert_eq!(apply_reverse(&newer, &d), want);
    // Diffs only: the kept blocks are not in it.
    let s = d.to_string();
    assert!(!s.contains("line 0") && !s.contains("line 1"), "{s}");
    // A block added in the middle since then is dropped again; the ones after it stay.
    let mut grown = state(3);
    grown["content"]
        .as_array_mut()
        .unwrap()
        .insert(1, p("b_new", "inserted later"));
    let d = reverse_diff(&grown, &state(3));
    let mut want = state(3);
    want["comments"] = grown["comments"].clone();
    assert_eq!(apply_reverse(&grown, &d), want);
    // Deleted and changed content from either side survives.
    let mut odd = state(3);
    odd["content"].as_array_mut().unwrap().remove(1);
    odd["meta"] = json!({"icon": "rocket"});
    odd["boards"] = json!({});
    let d = reverse_diff(&odd, &state(3));
    let mut want = state(3);
    want["comments"] = odd["comments"].clone();
    assert_eq!(apply_reverse(&odd, &d), want);
}

#[test]
fn the_chain_rebuilds_every_kept_version() {
    let mut h = FileHistory::default();
    for n in 1..=6 {
        h.advance(
            &state(n - 1),
            &meta(&format!("c{}", n - 1), CommitKind::Auto),
            true,
            &state(n),
            big(),
        );
    }
    let states = h.states(&state(6)).unwrap();
    assert_eq!(states.len(), 6);
    for (i, s) in states.iter().enumerate() {
        assert_eq!(s["meta"]["title"], format!("Plan v{i}"));
        assert_eq!(s["content"].as_array().unwrap().len(), i + 1);
    }
    assert_eq!(
        h.state_of(&state(6), "c2").unwrap()["meta"]["title"],
        "Plan v2"
    );
    assert_eq!(h.list()[0]["version"], "c5");
}

#[test]
fn a_save_that_is_not_kept_rebases_the_newest_version() {
    let mut h = FileHistory::default();
    h.advance(
        &state(0),
        &meta("c0", CommitKind::Named),
        true,
        &state(1),
        big(),
    );
    // state(1) is an ordinary autosave: dropped when state(2) is saved.
    h.advance(
        &state(1),
        &meta("c1", CommitKind::Auto),
        false,
        &state(2),
        big(),
    );
    assert_eq!(h.entries.len(), 1);
    assert_eq!(
        h.state_of(&state(2), "c0").unwrap()["meta"]["title"],
        "Plan v0"
    );
}

#[test]
fn bounds_drop_automatic_versions_first_and_keep_the_chain_whole() {
    let mut h = FileHistory::default();
    let kinds = [
        CommitKind::Named,
        CommitKind::Auto,
        CommitKind::Auto,
        CommitKind::Named,
        CommitKind::Auto,
        CommitKind::Restore,
    ];
    let limits = Limits {
        max_bytes: 1 << 30,
        max_versions: 3,
    };
    for (n, k) in kinds.iter().enumerate() {
        h.advance(
            &state(n),
            &meta(&format!("c{n}"), *k),
            true,
            &state(n + 1),
            limits,
        );
    }
    let ids: Vec<&str> = h.entries.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, ["c0", "c3", "c5"], "automatic versions went first");
    // Every survivor still rebuilds exactly.
    for (id, n) in [("c0", 0), ("c3", 3), ("c5", 5)] {
        let s = h.state_of(&state(6), id).unwrap();
        assert_eq!(s["meta"]["title"], format!("Plan v{n}"), "{id}");
        assert_eq!(s["content"].as_array().unwrap().len(), n + 1);
    }
    // Only named ones left and still over: the oldest named goes.
    h.prune(
        &state(6),
        Limits {
            max_bytes: 1 << 30,
            max_versions: 2,
        },
    );
    let ids: Vec<&str> = h.entries.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, ["c3", "c5"]);
}

#[test]
fn the_byte_budget_holds() {
    let mut h = FileHistory::default();
    for n in 1..=40 {
        h.advance(
            &state(n - 1),
            &meta(&format!("c{}", n - 1), CommitKind::Auto),
            true,
            &state(n),
            Limits {
                max_bytes: 600,
                max_versions: 50,
            },
        );
        assert!(h.bytes() <= 600, "{} bytes", h.bytes());
    }
    assert!(!h.entries.is_empty());
    let newest = h.entries.last().unwrap().id.clone();
    assert_eq!(newest, "c39");
    assert_eq!(
        h.state_of(&state(40), "c39").unwrap()["meta"]["title"],
        "Plan v39"
    );
}

#[test]
fn history_round_trips_through_the_file_and_old_readers_ignore_it() {
    let mut h = FileHistory::default();
    h.advance(
        &state(0),
        &meta("c0", CommitKind::Named),
        true,
        &state(1),
        big(),
    );
    h.advance(
        &state(1),
        &meta("c1", CommitKind::Auto),
        true,
        &state(2),
        big(),
    );
    let doc = new_doc();
    apply_document_json(&doc, &state(2));
    let commit = CommitInfo {
        id: "c2".into(),
        ..Default::default()
    };
    let bytes = write_ocanvas_with(&doc, &commit, Some(&h)).unwrap();
    let loaded = read_ocanvas(&bytes).unwrap();
    assert_eq!(loaded.history, h);
    let cur = doc_to_json(&loaded.doc);
    assert_eq!(
        loaded.history.state_of(&cur, "c0").unwrap()["meta"]["title"],
        "Plan v0"
    );
    // A file without history loads with none; an old reader's view (document + ydoc) is unchanged.
    let plain = write_ocanvas(&doc, &commit).unwrap();
    assert!(read_ocanvas(&plain).unwrap().history.entries.is_empty());
    assert_eq!(cur, doc_to_json(&read_ocanvas(&plain).unwrap().doc));
    // Asset rewrites (WOPI saves) keep the history entries.
    let with_assets = oc_model::ocanvas::with_assets(&bytes, &[]).unwrap();
    assert_eq!(read_ocanvas(&with_assets).unwrap().history, h);
    // A missing entry file drops it and everything older (the chain would break there).
    let index = h.to_files().remove(0).1;
    let partial = FileHistory::from_files(&index, |n| {
        (n != "history/c0.deflate").then(|| h.entries[1].diff.clone())
    });
    assert_eq!(partial.entries.len(), 1);
    assert_eq!(partial.entries[0].id, "c1");
}
