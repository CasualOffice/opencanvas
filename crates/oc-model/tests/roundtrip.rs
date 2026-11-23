// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

use oc_model::import::{apply_document_json, apply_markdown};
use oc_model::{CommitInfo, doc_to_json, new_doc, read_ocanvas, write_ocanvas};
use serde_json::json;
use yrs::{Map, ReadTxn, StateVector, Transact};

fn block_ids(v: &serde_json::Value) -> Vec<String> {
    fn walk(n: &serde_json::Value, out: &mut Vec<String>) {
        if let Some(id) = n["attrs"]["blockId"].as_str() {
            out.push(id.to_string());
        }
        for c in n["content"].as_array().into_iter().flatten() {
            walk(c, out);
        }
    }
    let mut out = Vec::new();
    walk(v, &mut out);
    out
}

/// VH-01a: a save describes itself in its manifest (docs/30 §2 c2), additively.
#[test]
fn manifest_carries_commit_kind_name_and_restored_from() {
    use oc_model::ocanvas::{CommitKind, read_manifest};
    let doc = new_doc();
    apply_document_json(&doc, &sample());
    let named = write_ocanvas(
        &doc,
        &CommitInfo {
            id: "c2".into(),
            authors: vec!["u_1".into()],
            at: "2026-11-24T10:00:00Z".into(),
            kind: CommitKind::Named,
            message: Some("Board review ready".into()),
            restored_from: None,
        },
    )
    .unwrap();
    let m = read_manifest(&named).unwrap();
    assert_eq!(m["commit"]["kind"], "named");
    assert_eq!(m["commit"]["message"], "Board review ready");
    assert!(m["commit"].get("restoredFrom").is_none());
    let restore = write_ocanvas(
        &doc,
        &CommitInfo {
            kind: CommitKind::Restore,
            message: Some("Restored from Nov 21, 10:14".into()),
            restored_from: Some("18".into()),
            ..CommitInfo::default()
        },
    )
    .unwrap();
    let m = read_manifest(&restore).unwrap();
    assert_eq!(m["commit"]["kind"], "restore");
    assert_eq!(m["commit"]["restoredFrom"], "18");
    // Automatic saves say so; readers that do not know the fields still load the file.
    let auto = write_ocanvas(&doc, &CommitInfo::default()).unwrap();
    assert_eq!(read_manifest(&auto).unwrap()["commit"]["kind"], "auto");
    assert_eq!(
        doc_to_json(&read_ocanvas(&auto).unwrap().doc),
        doc_to_json(&doc)
    );
}

/// VH-00: block ids as the web editor writes them (shared fixture, made by
/// `web/packages/editor/scripts/blockids-fixture.mjs` and read by `blockId.test.ts`) survive
/// Yjs → `document.json` → `.ocanvas` → Yjs, and `document.json` alone.
#[test]
fn web_block_ids_round_trip_through_document_json_and_ocanvas() {
    let update = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/blockids.ydoc.bin"
    ))
    .unwrap();
    let doc = new_doc();
    oc_model::ocanvas::apply_update_bytes(&doc, &update).unwrap();
    let json = doc_to_json(&doc);
    let want = [
        "b_0000000000000000000000000a",
        "b_0000000000000000000000000b",
        "b_0000000000000000000000000c",
        "b_0000000000000000000000000d",
        "b_0000000000000000000000000e",
    ];
    assert_eq!(block_ids(&json), want);

    let bytes = write_ocanvas(
        &doc,
        &CommitInfo {
            id: "c1".into(),
            authors: vec![],
            at: "2026-11-24T00:00:00Z".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let loaded = read_ocanvas(&bytes).unwrap();
    assert_eq!(block_ids(&doc_to_json(&loaded.doc)), want);

    let from_json = new_doc();
    apply_document_json(&from_json, &json);
    assert_eq!(block_ids(&doc_to_json(&from_json)), want);
}

fn sample() -> serde_json::Value {
    json!({
        "type": "doc",
        "content": [
            {"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Sprint 42"}]},
            {"type":"paragraph","content":[
                {"type":"text","text":"Hello "},
                {"type":"text","text":"world","marks":[{"type":"bold"},{"type":"link","attrs":{"href":"https://x.dev"}}]}
            ]},
            {"type":"callout","attrs":{"icon":"info","tone":"blue"},"content":[{"type":"paragraph","content":[{"type":"text","text":"note"}]}]},
            {"type":"futureBlock","attrs":{"weird":[1,2,{"a":true}]}}
        ],
        "meta": {"title": "Sprint 42", "icon": "rocket"},
        "databases": {}, "boards": {}, "comments": {}
    })
}

#[test]
fn ocanvas_round_trip_preserves_doc_and_crdt_state() {
    let doc = new_doc();
    apply_document_json(&doc, &sample());
    let json = doc_to_json(&doc);
    assert_eq!(
        json["content"],
        sample()["content"],
        "json walk mirrors the input"
    );

    let bytes = write_ocanvas(
        &doc,
        &CommitInfo {
            id: "c1".into(),
            authors: vec!["u_1".into()],
            at: "2026-11-21T00:00:00Z".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let loaded = read_ocanvas(&bytes).unwrap();
    assert_eq!(loaded.manifest["format"], "ocanvas");
    assert_eq!(loaded.manifest["title"], "Sprint 42");
    assert_eq!(doc_to_json(&loaded.doc), json);

    // ydoc.bin keeps CRDT identity: the original doc has nothing new for the loaded copy.
    let sv = loaded.doc.transact().state_vector();
    assert_eq!(sv, doc.transact().state_vector());
    assert_ne!(sv, StateVector::default());
}

#[test]
fn document_json_only_archive_loads() {
    use std::io::Write;
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file("document.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(sample().to_string().as_bytes()).unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    let loaded = read_ocanvas(&bytes).unwrap();
    assert_eq!(doc_to_json(&loaded.doc)["content"], sample()["content"]);
    let txn = loaded.doc.transact();
    assert_eq!(
        txn.get_map("meta")
            .unwrap()
            .get(&txn, "icon")
            .unwrap()
            .to_string(&txn),
        "rocket"
    );
}

#[test]
fn zip_path_traversal_rejected() {
    use std::io::Write;
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file("../evil", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"x").unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    assert!(read_ocanvas(&bytes).is_err());
}

#[test]
fn markdown_import_builds_blocks() {
    let doc = new_doc();
    apply_markdown(
        &doc,
        "# Title\n\nSome text\nmore\n\n- [x] done\n- [ ] todo\n\n```rust\nfn x() {}\n```\n",
    );
    let json = doc_to_json(&doc);
    let types: Vec<_> = json["content"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["type"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(types, ["heading", "paragraph", "taskList", "codeBlock"]);
    assert_eq!(json["content"][1]["content"][0]["text"], "Some text more");
    let md = oc_model::export::to_markdown(&json);
    assert!(md.contains("- [x] done\n- [ ] todo"));
    assert!(md.contains("```rust\nfn x() {}\n```"));
}
