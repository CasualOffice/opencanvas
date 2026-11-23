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
    // Ports and port bindings are not part of the kind: they stay (DGM-12 draws them).
    let mut plain = board();
    for s in plain["shapes"].as_object_mut().unwrap().values_mut() {
        let o = s.as_object_mut().unwrap();
        for k in ["kind", "kindVersion", "props", "edgeStyle"] {
            o.remove(k);
        }
    }
    assert_eq!(
        oc_model::board::to_svg(&doc_with(board()), "b1"),
        oc_model::board::to_svg(&doc_with(plain), "b1")
    );
}

fn ports_board() -> Value {
    serde_json::from_str(include_str!("fixtures/board-ports.json")).expect("fixture json")
}

#[test]
fn port_bindings_resolve_as_the_web_resolver_does() {
    // DGM-12: `board-ports.resolved.json` is the web `withResolvedArrows` output for
    // `board-ports.json` (web/packages/board/src/export.test.ts regenerates it): a binding to a
    // port the shape stores attaches there and leaves from the port's side; anything else
    // (missing port, a legacy id in `port`, an empty one) draws at `anchor`.
    let expected: std::collections::BTreeMap<String, Vec<[f64; 2]>> =
        serde_json::from_str(include_str!("fixtures/board-ports.resolved.json")).unwrap();
    let got: std::collections::BTreeMap<String, Vec<[f64; 2]>> =
        oc_model::board::resolved_points(&doc_with(ports_board()), "b1")
            .into_iter()
            .collect();
    assert_eq!(got, expected);
}

#[test]
fn port_bindings_export_the_same_svg_as_the_web() {
    let expected = include_str!("fixtures/board-ports.web.svg");
    let svg = oc_model::board::to_svg(&doc_with(ports_board()), "b1");
    assert_eq!(svg.replace("ocbd-b1-", "ocbd-x-"), expected);
}

#[test]
fn without_the_port_field_an_end_draws_at_its_anchor() {
    // What a 0.1.x client sees (and what its paste writes): `{shapeId, anchor}`.
    let mut plain = ports_board();
    for s in plain["shapes"].as_object_mut().unwrap().values_mut() {
        for end in ["start", "end"] {
            if let Some(b) = s.get_mut(end).and_then(Value::as_object_mut) {
                b.remove("port");
            }
        }
    }
    let pts = oc_model::board::resolved_points(&doc_with(plain), "b1");
    let e1 = &pts.iter().find(|(id, _)| id == "e1").unwrap().1;
    assert_eq!(e1, &vec![[200.0, 50.0], [480.0, 200.0]]);
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
        ..Default::default()
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

/// The shape `n1`'s `props` value as stored in the Y doc.
fn props_out(doc: &yrs::Doc) -> Option<yrs::Out> {
    use yrs::{Map, Transact};
    let boards = doc.get_or_insert_map("boards");
    let txn = doc.transact();
    let yrs::Out::YMap(b) = boards.get(&txn, "b1")? else {
        return None;
    };
    let yrs::Out::YMap(shapes) = b.get(&txn, "shapes")? else {
        return None;
    };
    let yrs::Out::YMap(n1) = shapes.get(&txn, "n1")? else {
        return None;
    };
    n1.get(&txn, "props")
}

#[test]
fn props_are_a_per_field_map_and_concurrent_field_edits_merge() {
    use yrs::{Map, Transact};
    // ADR-045: `props` is a nested map, one key per property. A document.json import gives the
    // same form the web writes, so two writers editing different properties both survive.
    let a = ydoc_from(&doc_with(board()));
    assert!(
        matches!(props_out(&a), Some(yrs::Out::YMap(_))),
        "props imported as a map"
    );
    let b = oc_model::doc::new_doc();
    oc_model::ocanvas::apply_update_bytes(&b, &oc_model::ocanvas::encode_state(&a)).unwrap();
    for (doc, key, val) in [(&a, "stereotype", "value"), (&b, "owner", "team-b")] {
        let Some(yrs::Out::YMap(p)) = props_out(doc) else {
            panic!("props map");
        };
        p.insert(&mut doc.transact_mut(), key, val);
    }
    let (ua, ub) = (
        oc_model::ocanvas::encode_state(&a),
        oc_model::ocanvas::encode_state(&b),
    );
    oc_model::ocanvas::apply_update_bytes(&a, &ub).unwrap();
    oc_model::ocanvas::apply_update_bytes(&b, &ua).unwrap();
    for doc in [&a, &b] {
        let props = &oc_model::doc::doc_to_json(doc)["boards"]["b1"]["shapes"]["n1"]["props"];
        assert_eq!(props["stereotype"], "value");
        assert_eq!(props["owner"], "team-b");
        assert_eq!(props["attrs"], json!([{"name": "id", "pk": true}]));
    }
}

#[test]
fn both_props_forms_read_and_render_the_same() {
    // Per-field map (web, import) and one plain value (a 0.1.x copy) give the same logical JSON
    // and the same pictures.
    use yrs::{Any, Map, Transact};
    let mapped = ydoc_from(&doc_with(board()));
    let plain = ydoc_from(&doc_with(board()));
    {
        let boards = plain.get_or_insert_map("boards");
        let mut txn = plain.transact_mut();
        let Some(yrs::Out::YMap(b)) = boards.get(&txn, "b1") else {
            panic!()
        };
        let Some(yrs::Out::YMap(shapes)) = b.get(&txn, "shapes") else {
            panic!()
        };
        let Some(yrs::Out::YMap(n1)) = shapes.get(&txn, "n1") else {
            panic!()
        };
        let value: Any = oc_model::import::json_to_any(&board()["shapes"]["n1"]["props"]);
        n1.insert(&mut txn, "props", value);
    }
    assert!(matches!(props_out(&plain), Some(yrs::Out::Any(_))));
    let (jm, jp) = (
        oc_model::doc::doc_to_json(&mapped),
        oc_model::doc::doc_to_json(&plain),
    );
    assert_eq!(jm["boards"], jp["boards"]);
    assert_eq!(
        oc_model::board::to_svg(&jm, "b1"),
        oc_model::board::to_svg(&jp, "b1")
    );
    assert_eq!(
        oc_model::preview::render(&jm).html,
        oc_model::preview::render(&jp).html
    );
}

#[test]
fn a_board_name_survives_import_validation_and_ocanvas_round_trips() {
    // DGM-14 (1d): boards get an optional `name` string beside `shapes` and `order`.
    let mut b = board();
    b["name"] = json!("Service map");
    let doc = doc_with(b);
    let y = ydoc_from(&doc);
    assert_eq!(
        oc_model::doc::doc_to_json(&y)["boards"]["b1"]["name"],
        "Service map"
    );
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
    // Rendering ignores it: the same SVG with and without a name.
    assert_eq!(
        oc_model::board::to_svg(&doc_with(board()), "b1"),
        oc_model::board::to_svg(&doc, "b1")
    );
}
