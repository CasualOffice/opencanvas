// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! SDK blocks in the model (BSDK-01; docs/15 §4.2): validation against installed manifests.
//!
//! The installed registry is process-wide, so every test installs its own type names.

use oc_model::ext::{self, Manifest, Registry};
use serde_json::{Value, json};

fn manifest(ty: &str, major: u64) -> Manifest {
    let mut v = json!({
        "type": ty, "version": format!("{major}.1.0"), "title": "OKR", "icon": "target",
        "content": "blocks",
        "attrs": {"$schema": "https://json-schema.org/draft/2020-12/schema",
                  "type": "object", "additionalProperties": false,
                  "properties": {"objective": {"type": "string", "maxLength": 40},
                                 "progress": {"type": "number", "minimum": 0, "maximum": 1}},
                  "required": ["objective"]},
        "data": {"kind": "map", "schema": {"type": "object", "additionalProperties": false,
                  "properties": {"score": {"type": "integer", "minimum": 0}}}},
        "export": {"markdown": "**{{objective}}** ({{progress|percent}})", "text": "{{objective}}"},
        "entry": "block.js",
        "integrity": format!("sha384-{}", "A".repeat(64))
    });
    if major >= 2 {
        v["migrations"] =
            json!({"1": [{"op": "move", "from": "/attrs/name", "path": "/attrs/objective"}]});
    }
    Manifest::from_json(&v, false).unwrap()
}

fn install(ty: &str, major: u64) -> Registry {
    let mut r = Registry::new();
    r.insert(manifest(ty, major)).unwrap();
    ext::install(&r);
    r
}

fn block(ty: &str, v: u64, attrs: Value) -> Value {
    json!({"type": "extBlock",
        "attrs": {"blockId": "b_ext", "type": ty, "v": v, "attrs": attrs, "dataId": "d_1",
                  "fallback": {"markdown": "**Fallback** objective", "text": "Fallback objective"}},
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "child text"}]}]})
}

fn doc_with(node: Value, data: Value) -> Value {
    json!({"type": "doc", "content": [
        {"type": "paragraph", "attrs": {"blockId": "b_p"}, "content": [{"type": "text", "text": "before"}]},
        node
    ], "ext": {"d_1": data}})
}

fn messages(r: &[oc_model::Issue]) -> Vec<String> {
    r.iter().map(ToString::to_string).collect()
}

#[test]
fn validation_checks_installed_blocks_and_keeps_unknown_ones() {
    let reg = install("t.valid", 1);
    // Valid: no findings at all.
    let ok = oc_model::validate_json_with(
        &doc_with(
            block("t.valid", 1, json!({"objective": "Ship"})),
            json!({"score": 3}),
        ),
        &reg,
    );
    assert!(ok.errors.is_empty() && ok.warnings.is_empty(), "{ok:?}");
    // Schema-invalid attrs and data are errors that name the place.
    let bad = oc_model::validate_json_with(
        &doc_with(
            block("t.valid", 1, json!({"progress": 2})),
            json!({"score": -1}),
        ),
        &reg,
    );
    assert_eq!(
        messages(&bad.errors),
        [
            "/content/1/attrs/attrs/objective: t.valid: is required",
            "/content/1/attrs/attrs/progress: t.valid: must be at most 1",
            "/ext/d_1/score: t.valid: must be at least 0",
        ]
    );
    // A type nobody installed is kept: a warning, never an error (rule 7).
    let unknown = oc_model::validate_json_with(
        &doc_with(
            block("t.unknown", 7, json!({"anything": [1, {"x": 2}]})),
            json!({"z": 1}),
        ),
        &reg,
    );
    assert!(unknown.errors.is_empty(), "{unknown:?}");
    assert_eq!(unknown.warnings.len(), 1);
    assert!(unknown.warnings[0].message.contains("not installed"));
    // Data written by a newer package: kept and read-only, a warning.
    let newer = oc_model::validate_json_with(
        &doc_with(block("t.valid", 3, json!({"objective": 5})), json!({})),
        &reg,
    );
    assert!(newer.errors.is_empty(), "{newer:?}");
    assert!(
        newer.warnings[0].message.contains("newer version"),
        "{newer:?}"
    );
    // Malformed extBlock attributes are errors whatever is installed.
    for (attrs, needle) in [
        (json!({"type": "Not A Type", "v": 1}), "lowercase"),
        (
            json!({"type": "t.valid", "v": 0, "attrs": {"objective": "x"}}),
            "≥ 1",
        ),
        (
            json!({"type": "t.valid", "v": 1, "attrs": "x"}),
            "JSON object",
        ),
        (
            json!({"type": "t.valid", "v": 1, "attrs": {"objective": "x"}, "fallback": {"markdown": 3}}),
            "string",
        ),
        (json!({"v": 1}), "string type"),
    ] {
        let r = oc_model::validate_json_with(
            &json!({"content": [{"type": "extBlock", "attrs": attrs}]}),
            &reg,
        );
        assert!(
            r.errors.iter().any(|e| e.message.contains(needle)),
            "{needle}: {r:?}"
        );
    }
}

#[test]
fn a_schema_invalid_block_refuses_the_file() {
    install("t.refuse", 1);
    let doc = oc_model::new_doc();
    oc_model::import::apply_document_json(
        &doc,
        &doc_with(block("t.refuse", 1, json!({"progress": "x"})), json!({})),
    );
    let bytes = oc_model::write_ocanvas(&doc, &Default::default()).unwrap();
    match oc_model::read_ocanvas(&bytes) {
        Err(oc_model::Error::Invalid(e)) => assert!(e.contains("t.refuse"), "{e}"),
        other => panic!("expected Invalid, got {:?}", other.map(|_| ())),
    }
}
