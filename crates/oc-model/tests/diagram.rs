// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Diagram fields (ADR-045, DGM-08): server-side rendering and file round trips for boards that
//! a newer client wrote. Kinds draw as their base `type`; an unknown `type` with a box draws as
//! a rect with its text (the web exporter does the same, `board-diagram.web.svg`); every field
//! survives `.ocanvas` save and load.

use serde_json::{Value, json};

fn board() -> Value {
    serde_json::from_str(include_str!("fixtures/board-diagram.json")).expect("fixture json")
}

fn doc_with(board: Value) -> Value {
    json!({
        "type": "doc",
        "content": [{"type": "board", "attrs": {"boardId": "b1", "blockId": "blk1"}}],
        "meta": {"title": "Diagram"},
        "databases": {},
        "boards": {"b1": board},
        "comments": {},
    })
}

fn texts(svg: &str) -> Vec<String> {
    svg.split("<text")
        .skip(1)
        .map(|t| t[t.find('>').unwrap() + 1..t.find("</text>").unwrap()].to_string())
        .collect()
}

#[test]
fn svg_matches_web_export_for_diagram_fields() {
    // `fixtures/board-diagram.web.svg` is the web `exportBoardSvg` output for
    // `fixtures/board-diagram.json` (web/packages/board/src/export.test.ts regenerates it).
    let expected = include_str!("fixtures/board-diagram.web.svg");
    let svg = oc_model::board::to_svg(&doc_with(board()), "b1");
    assert_eq!(svg.replace("ocbd-b1-", "ocbd-x-"), expected);
}

#[test]
fn a_kind_draws_exactly_as_its_base_type() {
    let mut plain = board();
    for s in plain["shapes"].as_object_mut().unwrap().values_mut() {
        let o = s.as_object_mut().unwrap();
        for k in ["kind", "kindVersion", "props", "ports", "edgeStyle"] {
            o.remove(k);
        }
        for end in ["start", "end"] {
            if let Some(b) = o.get_mut(end).and_then(Value::as_object_mut) {
                b.remove("port");
            }
        }
    }
    assert_eq!(
        oc_model::board::to_svg(&doc_with(board()), "b1"),
        oc_model::board::to_svg(&doc_with(plain), "b1")
    );
}

#[test]
fn an_unknown_type_with_a_box_falls_back_to_a_rect_with_its_text() {
    let svg = oc_model::board::to_svg(&doc_with(board()), "b1");
    let t = texts(&svg);
    assert!(t.iter().any(|x| x == "Review the claim"), "{t:?}");
    assert!(t.iter().any(|x| x == "TASK"), "{t:?}");
    // Drawn like a rect of the same box.
    let rect = oc_model::board::to_svg(
        &doc_with(
            json!({"order": ["u1"], "shapes": {"u1": {"type": "rect", "x": 0, "y": 200, "w": 160, "h": 80, "text": "Review the claim", "label": "task"}}}),
        ),
        "b1",
    );
    let unknown = oc_model::board::to_svg(
        &doc_with(json!({"order": ["u1"], "shapes": {"u1": board()["shapes"]["u1"].clone()}})),
        "b1",
    );
    assert_eq!(unknown, rect);
    // No box (only points): nothing is drawn, and nothing breaks.
    let pts_only = oc_model::board::to_svg(
        &doc_with(json!({"order": ["u2"], "shapes": {"u2": board()["shapes"]["u2"].clone()}})),
        "b1",
    );
    assert!(
        !pts_only.contains("<g>") && !pts_only.contains("<path d=\"M4"),
        "{pts_only}"
    );
}

#[test]
fn markdown_html_and_preview_render_diagram_boards() {
    let doc = doc_with(board());
    let md = oc_model::export::to_markdown(&doc);
    assert!(md.contains("data:image/svg+xml"), "{md}");
    let html = oc_model::export::to_html(&doc);
    assert!(
        html.contains("Review the claim") && html.contains("Order"),
        "board text in HTML"
    );
    let preview = oc_model::preview::render(&doc).html;
    assert!(
        preview.contains("oc-pv-board") && preview.contains("Review the claim"),
        "{preview}"
    );
}

fn ydoc_from(value: &Value) -> yrs::Doc {
    let doc = oc_model::doc::new_doc();
    oc_model::import::apply_document_json(&doc, value);
    doc
}

#[test]
fn diagram_fields_survive_ocanvas_save_and_load() {
    let doc = doc_with(board());
    let y = ydoc_from(&doc);
    let before = oc_model::doc::doc_to_json(&y);
    assert_eq!(before["boards"], doc["boards"], "import keeps every field");
    let report = oc_model::validate::validate(&y);
    assert!(report.first_error().is_none(), "{:?}", report.first_error());
    let commit = oc_model::ocanvas::CommitInfo {
        id: "c1".into(),
        authors: vec![],
        at: "2026-11-24T00:00:00Z".into(),
    };
    let bytes = oc_model::ocanvas::write_ocanvas(&y, &commit).expect("write");
    let loaded = oc_model::ocanvas::read_ocanvas(&bytes).expect("read");
    assert_eq!(
        oc_model::doc::doc_to_json(&loaded.doc)["boards"],
        doc["boards"]
    );
}

#[test]
fn diagram_fields_survive_a_document_json_only_file() {
    // A host or tool that writes only `document.json` (no `ydoc.bin`).
    let doc = doc_with(board());
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file("document.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    std::io::Write::write_all(&mut zip, doc.to_string().as_bytes()).unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    let loaded = oc_model::ocanvas::read_ocanvas(&bytes).expect("read");
    assert_eq!(
        oc_model::doc::doc_to_json(&loaded.doc)["boards"],
        doc["boards"]
    );
}
