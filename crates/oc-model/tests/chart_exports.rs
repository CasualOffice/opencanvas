// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! SHEET-06 (frame 4h): a linked chart block exports as a table of the values it draws
//! (Markdown, HTML, Word), from a sheet range or a database grouped by a field.

use std::io::Read;

use serde_json::{Value, json};

fn sheet_block() -> Value {
    json!({
        "order": ["s1"],
        "sheets": {"s1": {"name": "Budget", "rows": ["a", "b", "c", "d"], "cols": ["x", "y", "z"],
            "cells": {
                "a:x": {"in": "Category"}, "a:y": {"in": "Total"},
                "b:x": {"in": "Venue"}, "b:y": {"in": "4200"},
                "c:x": {"in": "Food"}, "c:y": {"in": "800.5"},
                "d:x": {"in": "Print"}, "d:y": {"in": "=4*10"}
            }}},
        "styles": {}
    })
}

fn sheet_doc() -> Value {
    json!({
        "type": "doc",
        "content": [{"type": "chart", "attrs": {"kind": "bar", "title": "Total by Category", "src": "sheet",
            "sheetId": "k1", "sheet": "s1", "r0": "a", "r1": "d", "c0": "x", "c1": "y"}}],
        "meta": {}, "databases": {}, "boards": {}, "comments": {},
        "sheets": {"k1": sheet_block()}
    })
}

fn db_doc() -> Value {
    json!({
        "type": "doc",
        "content": [{"type": "chart", "attrs": {"kind": "pie", "title": "", "src": "db", "dbId": "d1",
            "groupBy": "f2", "agg": "sum", "field": "f3"}}],
        "meta": {}, "boards": {}, "comments": {}, "sheets": {},
        "databases": {"d1": {"name": "Launch budget",
            "fields": [{"id": "f1", "name": "Item", "type": "title"}, {"id": "f2", "name": "Category", "type": "select"},
                       {"id": "f3", "name": "Total", "type": "number"}],
            "order": ["r1", "r2", "r3"],
            "rows": {"r1": {"f1": "Venue hire", "f2": "Venue", "f3": 4200},
                     "r2": {"f1": "Lunch", "f2": "Food", "f3": 38},
                     "r3": {"f1": "Insurance", "f2": "Venue", "f3": 890}}}}
    })
}

#[test]
fn markdown_shows_the_charted_values() {
    let md = oc_model::export::to_markdown(&sheet_doc());
    assert!(md.contains("### Total by Category"), "{md}");
    assert!(md.contains("*Column chart*"), "{md}");
    assert!(md.contains("| Category | Total |"), "{md}");
    assert!(md.contains("| Food | 800.5 |"), "{md}");
    // Computed by the sheet engine, as the editor shows it.
    assert!(md.contains("| Print | 40 |"), "{md}");
}

#[test]
fn html_groups_a_database() {
    let html = oc_model::export::to_html(&db_doc());
    assert!(
        html.contains("<figcaption>Sum of Total by Category</figcaption>"),
        "{html}"
    );
    assert!(html.contains("<th>Category</th>"), "{html}");
    assert!(html.contains("<th>Sum of Total</th>"), "{html}");
    assert!(html.contains("<td>Venue</td><td>5090</td>"), "{html}");
    assert!(html.contains("<td>Food</td><td>38</td>"), "{html}");
}

#[test]
fn word_has_the_table() {
    let (bytes, _) = oc_model::docx::to_docx(&sheet_doc(), &Default::default()).expect("docx");
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut xml = String::new();
    z.by_name("word/document.xml")
        .unwrap()
        .read_to_string(&mut xml)
        .unwrap();
    assert!(xml.contains("Total by Category"), "{xml}");
    assert!(xml.contains(">800.5<"), "{xml}");
}

#[test]
fn rules_match_the_editor() {
    use oc_model::chart::{from_grid, parse_num};
    assert_eq!(parse_num("€4,200.50"), Some(4200.5));
    assert_eq!(parse_num("(1,000)"), Some(-1000.0));
    assert_eq!(parse_num("TRUE"), None);
    let g = |r: &[&[&str]]| {
        r.iter()
            .map(|x| x.iter().map(|s| s.to_string()).collect())
            .collect::<Vec<Vec<String>>>()
    };
    let d = from_grid(&g(&[&["1", "10"], &["2", "20"]]));
    assert_eq!(d.categories, vec!["1", "2"]);
    assert_eq!(d.series[1].0, "Series 2");
    let d = from_grid(&g(&[&["Cost"], &["4"], &[""], &["6"]]));
    assert_eq!(
        d.series,
        vec![("Cost".to_string(), vec![Some(4.0), Some(6.0)])]
    );
}
