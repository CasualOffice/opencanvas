// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! FC-07: every built-in template loads. `fixtures/templates.json` is what the web editor
//! builds for each of its 40 templates (written and kept current by
//! `web/packages/editor/src/templates.fixture.test.ts`). Each one must pass the block
//! schema with no errors and no warnings, and survive a `.ocanvas` write → read unchanged.

use oc_model::import::apply_document_json;
use oc_model::{CommitInfo, doc_to_json, new_doc, read_ocanvas, validate_json, write_ocanvas};
use serde_json::Value;

#[test]
fn fc07_every_builtin_template_validates_and_round_trips() {
    let all: serde_json::Map<String, Value> =
        serde_json::from_str(include_str!("fixtures/templates.json")).unwrap();
    assert_eq!(all.len(), 40, "the editor ships 40 templates");
    let mut failed = vec![];
    for (id, tpl) in &all {
        let r = validate_json(tpl);
        if !r.errors.is_empty() || !r.warnings.is_empty() {
            failed.push(format!("{id}: {:?} {:?}", r.errors, r.warnings));
            continue;
        }
        let doc = new_doc();
        apply_document_json(&doc, tpl);
        let written = doc_to_json(&doc);
        let bytes = write_ocanvas(&doc, &CommitInfo::default()).unwrap();
        let back = match read_ocanvas(&bytes) {
            Ok(l) => doc_to_json(&l.doc),
            Err(e) => {
                failed.push(format!("{id}: read_ocanvas: {e}"));
                continue;
            }
        };
        if back != written {
            failed.push(format!("{id}: changed in the .ocanvas round trip"));
        }
        for key in ["databases", "boards"] {
            let want = tpl[key].as_object().map_or(0, |m| m.len());
            let got = back[key].as_object().map_or(0, |m| m.len());
            if want != got {
                failed.push(format!("{id}: {key} {want} → {got}"));
            }
        }
        let blocks = |v: &Value| v["content"].as_array().map_or(0, Vec::len);
        if blocks(&back) != blocks(tpl) || blocks(tpl) == 0 {
            failed.push(format!("{id}: {} blocks → {}", blocks(tpl), blocks(&back)));
        }
        if back["meta"]["title"] != tpl["meta"]["title"] {
            failed.push(format!("{id}: title lost"));
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}
