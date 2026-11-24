// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! SDK blocks in the model (BSDK-01, BSDK-02, BSDK-05; docs/15 §4.2): validation against
//! installed manifests, the `ext` root, `.ocanvas` round trips, exports and server writes.
//!
//! The installed registry is process-wide, so every test installs its own type names.

use std::collections::HashMap;

use oc_model::ext::{self, Manifest, Registry};
use oc_model::patch::{PatchOp, apply_patch};
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
fn older_data_validates_after_migration() {
    let reg = install("t.migrated", 2);
    // v1 stored `name`; v2's schema wants `objective` and allows nothing else.
    let r = oc_model::validate_json_with(
        &doc_with(block("t.migrated", 1, json!({"name": "Old"})), json!({})),
        &reg,
    );
    assert!(r.errors.is_empty() && r.warnings.is_empty(), "{r:?}");
    let bad = oc_model::validate_json_with(
        &doc_with(block("t.migrated", 1, json!({"name": 7})), json!({})),
        &reg,
    );
    assert!(
        bad.errors.is_empty(),
        "older data is never refused: {bad:?}"
    );
    assert!(
        bad.warnings[0].message.contains("does not match"),
        "{bad:?}"
    );
}

#[test]
fn ocanvas_round_trips_blocks_data_and_unknown_types() {
    install("t.round", 1);
    let doc = oc_model::new_doc();
    oc_model::import::apply_document_json(
        &doc,
        &json!({"type": "doc", "content": [
            block("t.round", 1, json!({"objective": "Ship", "progress": 0.5})),
            block("t.notinstalled", 4, json!({"deep": {"a": [1, 2]}}))
        ], "ext": {"d_1": {"score": 9}}}),
    );
    let before = oc_model::doc_to_json(&doc);
    assert_eq!(before["ext"], json!({"d_1": {"score": 9}}));
    let bytes = oc_model::write_ocanvas(&doc, &Default::default()).unwrap();
    let manifest = oc_model::ocanvas::read_manifest(&bytes).unwrap();
    assert_eq!(
        manifest["requires"]["blocks"],
        json!([{"type": "t.notinstalled", "v": 4}, {"type": "t.round", "v": 1}])
    );
    assert_eq!(manifest["version"], 1, "format version 1 (ADR-042)");
    let loaded = oc_model::read_ocanvas(&bytes).unwrap();
    assert_eq!(oc_model::doc_to_json(&loaded.doc), before);
    // document.json alone (another tool's file) rebuilds the same document and `ext` root.
    let json_only = zip_with_only_document_json(&before);
    let loaded = oc_model::read_ocanvas(&json_only).unwrap();
    assert_eq!(oc_model::doc_to_json(&loaded.doc), before);
    // Per-field LWW: each field is its own key in a Y.Map under ext[dataId].
    let txn = yrs::Transact::transact(&loaded.doc);
    let root = yrs::ReadTxn::get_map(&txn, "ext").unwrap();
    assert!(matches!(
        yrs::Map::get(&root, &txn, "d_1"),
        Some(yrs::Out::YMap(_))
    ));
}

fn zip_with_only_document_json(doc: &Value) -> Vec<u8> {
    use std::io::Write;
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file("document.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(&serde_json::to_vec(doc).unwrap()).unwrap();
    zip.finish().unwrap().into_inner()
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

#[test]
fn exports_render_templates_or_fallbacks() {
    install("t.export", 1);
    let doc = doc_with(
        block(
            "t.export",
            1,
            json!({"objective": "Ship <v2>", "progress": 0.42}),
        ),
        json!({}),
    );
    let md = oc_model::export::to_markdown(&doc);
    assert!(md.contains("**Ship \\<v2\\>** (42%)\n\nchild text"), "{md}");
    let html = oc_model::export::to_html(&doc);
    assert!(
        html.contains("<strong>Ship &lt;v2&gt;</strong> (42%)"),
        "{html}"
    );
    assert!(html.contains("<p>child text</p>"), "{html}");
    let (docx, _) = oc_model::docx::to_docx(&doc, &HashMap::new()).unwrap();
    let body = unzip(&docx, "word/document.xml");
    assert!(
        body.contains("Ship &lt;v2&gt;") && body.contains("(42%)"),
        "{body}"
    );
    let preview = oc_model::preview::render(&doc);
    assert!(preview.html.contains("Ship &lt;v2&gt;"), "{}", preview.html);
    // A package nobody installed: the stored fallback, sanitised.
    let mut missing = doc_with(block("t.gone", 1, json!({"objective": "x"})), json!({}));
    missing["content"][1]["attrs"]["fallback"] = json!({"markdown": "[click](javascript:alert(1)) <img src=x onerror=alert(1)> **Fallback**"});
    let md = oc_model::export::to_markdown(&missing);
    assert!(
        md.contains("**Fallback**")
            && !md.contains("javascript:")
            && !md.replace("\\<", "").contains('<'),
        "{md}"
    );
    let html = oc_model::export::to_html(&missing);
    assert!(
        !html.contains("onerror=alert") || html.contains("&lt;img"),
        "{html}"
    );
    assert!(!html.contains("javascript:"), "{html}");
    // No fallback either: a placeholder naming the type, never nothing.
    missing["content"][1]["attrs"]["fallback"] = Value::Null;
    assert!(oc_model::export::to_markdown(&missing).contains("*Block: t.gone*"));
}

fn unzip(bytes: &[u8], name: &str) -> String {
    use std::io::Read;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut s = String::new();
    z.by_name(name).unwrap().read_to_string(&mut s).unwrap();
    s
}

fn patch(doc: &yrs::Doc, ops: Value) -> Result<(), oc_model::patch::PatchError> {
    let ops: Vec<PatchOp> = serde_json::from_value(ops).unwrap();
    let mut n = 0;
    let out = apply_patch(doc, &ops, &mut || {
        n += 1;
        format!("id{n}")
    })?;
    oc_model::ocanvas::apply_update_bytes(doc, &out.update).unwrap();
    Ok(())
}

#[test]
fn patches_write_data_migrate_and_derive_fallbacks() {
    install("t.write", 2);
    let doc = oc_model::new_doc();
    // A v1 block written today is migrated to v2 on the way in; data goes to the ext root.
    patch(&doc, json!([{"op": "append", "blocks": [
        {"type": "extBlock", "attrs": {"type": "t.write", "v": 1, "attrs": {"name": "Q1", "progress": 0.1}},
         "data": {"score": 4}}
    ]}]))
    .unwrap();
    let j = oc_model::doc_to_json(&doc);
    let a = &j["content"][0]["attrs"];
    assert_eq!(a["v"], 2);
    assert_eq!(a["attrs"], json!({"objective": "Q1", "progress": 0.1}));
    assert_eq!(
        a["fallback"],
        json!({"markdown": "**Q1** (10%)", "text": "Q1"})
    );
    let data_id = a["dataId"].as_str().unwrap();
    assert_eq!(j["ext"][data_id], json!({"score": 4}));
    // Schema-invalid attrs or data are refused and nothing changes.
    for bad in [
        json!({"type": "extBlock", "attrs": {"type": "t.write", "v": 2, "attrs": {"objective": 3}}}),
        json!({"type": "extBlock", "attrs": {"type": "t.write", "v": 2, "attrs": {"objective": "x"}}, "data": {"score": "high"}}),
        json!({"type": "extBlock", "attrs": {"type": "t.write", "v": 3, "attrs": {"objective": "x"}}}),
    ] {
        let err = patch(&doc, json!([{"op": "append", "blocks": [bad.clone()]}])).unwrap_err();
        assert!(err.to_string().contains("t.write"), "{bad}: {err}");
    }
    assert_eq!(oc_model::doc_to_json(&doc), j);
}

/// The shared template and migration cases (the editor runs the same file).
#[test]
fn ext_fixtures() {
    use oc_model::ext::migrate::Migrations;
    use oc_model::ext::template::{Target, Template};
    let f: Value = serde_json::from_str(include_str!("fixtures/ext.json")).unwrap();
    for c in f["templates"].as_array().unwrap() {
        let t = Template::parse(c["template"].as_str().unwrap()).unwrap();
        assert_eq!(
            t.render(&c["ctx"], Target::Markdown),
            c["markdown"].as_str().unwrap(),
            "{c}"
        );
        assert_eq!(
            t.render(&c["ctx"], Target::Text),
            c["text"].as_str().unwrap(),
            "{c}"
        );
    }
    for t in f["refused"].as_array().unwrap() {
        assert!(Template::parse(t.as_str().unwrap()).is_err(), "{t}");
    }
    for c in f["migrations"].as_array().unwrap() {
        let m = Migrations::parse(Some(&c["migrations"])).unwrap();
        let (a, d) = m
            .run(
                c["from"].as_u64().unwrap(),
                c["to"].as_u64().unwrap(),
                &c["attrs"],
                &c["data"],
            )
            .unwrap();
        assert_eq!(a, c["attrs_out"], "{c}");
        assert_eq!(d, c["data_out"], "{c}");
    }
}

#[test]
fn a_block_from_a_newer_version_is_not_overwritten() {
    install("t.newer", 1);
    let doc = oc_model::new_doc();
    oc_model::import::apply_document_json(
        &doc,
        &doc_with(block("t.newer", 2, json!({"future": true})), json!({})),
    );
    let err = patch(
        &doc,
        json!([{"op": "replace", "blockId": "b_ext", "markdown": "gone"}]),
    )
    .unwrap_err();
    assert!(err.to_string().contains("newer version"), "{err}");
    // Deleting it is a person's choice and is allowed.
    patch(&doc, json!([{"op": "delete", "blockId": "b_ext"}])).unwrap();
}
