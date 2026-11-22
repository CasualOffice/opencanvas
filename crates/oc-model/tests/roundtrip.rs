// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

use oc_model::import::{apply_document_json, apply_markdown};
use oc_model::{CommitInfo, doc_to_json, new_doc, read_ocanvas, write_ocanvas};
use serde_json::json;
use yrs::{Map, ReadTxn, StateVector, Transact};

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
