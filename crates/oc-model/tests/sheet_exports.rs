// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! SHEET-03: a Spreadsheet block exports as tables of computed values (Markdown, HTML, Word,
//! `search.json`), from the `sheets` root of the document (ADR-080 §4).

use std::collections::HashMap;
use std::io::Read;

use serde_json::{Value, json};

/// `=SUM(B2:B3)` with references stored as ids (the converter's form).
fn sum_b2_b3() -> String {
    let sheets = oc_sheet::block::book_sheets(&block(None));
    let grid = oc_sheet::engine::grid_of(&sheets);
    oc_sheet::refs::to_ids("=SUM(B2:B3)", "s1", &grid)
}

fn block(total: Option<String>) -> Value {
    let mut b = json!({
        "order": ["s1"],
        "sheets": {"s1": {"name": "Budget", "rows": ["a", "b", "c", "d"], "cols": ["x", "y"],
            "cells": {
                "a:x": {"in": "Item"}, "a:y": {"in": "Cost"},
                "b:x": {"in": "Venue"}, "b:y": {"in": "4200"},
                "c:x": {"in": "Food"}, "c:y": {"in": "800"},
                "d:x": {"in": "Total"}
            }}},
        "styles": {}
    });
    if let Some(t) = total {
        b["sheets"]["s1"]["cells"]["d:y"] = json!({ "in": t });
    }
    b
}

fn doc() -> Value {
    json!({
        "type": "doc",
        "content": [{"type": "spreadsheet", "attrs": {"blockId": "b1", "sheetId": "k1"}}],
        "meta": {}, "databases": {}, "boards": {}, "comments": {},
        "sheets": {"k1": block(Some(sum_b2_b3()))}
    })
}

#[test]
fn markdown_shows_computed_values() {
    let md = oc_model::export::to_markdown(&doc());
    assert!(md.contains("### Budget"), "{md}");
    assert!(md.contains("| Item | Cost |"), "{md}");
    assert!(md.contains("| Total | 5000 |"), "{md}");
}

#[test]
fn html_shows_computed_values() {
    let html = oc_model::export::to_html(&doc());
    assert!(html.contains("<td>5000</td>"), "{html}");
}

#[test]
fn word_shows_computed_values() {
    let (bytes, _) = oc_model::docx::to_docx(&doc(), &HashMap::new()).unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .unwrap()
        .read_to_string(&mut xml)
        .unwrap();
    assert!(xml.contains(">5000<"), "{xml}");
    assert!(xml.contains(">Budget<"), "{xml}");
}

#[test]
fn search_json_indexes_displayed_values() {
    let s = oc_model::search::search_json(&doc(), Default::default());
    let b = s["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["type"] == "sheet")
        .unwrap_or_else(|| panic!("{s}"));
    assert_eq!(b["id"], "b1");
    let text = b["text"].as_str().unwrap();
    assert!(text.contains("Total") && text.contains("5000"), "{text}");
}

#[test]
fn the_document_json_carries_the_sheets_root() {
    let d = oc_model::new_doc();
    oc_model::import::apply_document_json(&d, &doc());
    let back = oc_model::doc_to_json(&d);
    assert_eq!(back["sheets"]["k1"]["sheets"]["s1"]["name"], "Budget");
    assert!(oc_model::export::to_markdown(&back).contains("| Total | 5000 |"));
}
