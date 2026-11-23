// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Restore as an edit (docs/30 §5, ADR-051): the Yjs update that turns a live doc into an
//! older version by touching only what differs. Comments and people are kept as they are now.
//!
//! - `content`: the top-level blocks are matched by a sequence diff; only blocks that differ
//!   are removed and inserted, so concurrent edits elsewhere survive.
//! - `meta`, `databases`, `boards`: keys are set or removed one by one, recursing into nested
//!   maps (a database's rows, a board's shapes), so only changed rows, cells and shapes are
//!   rewritten.

use serde_json::Value;
use yrs::types::ToJson;
use yrs::{Doc, Map, MapRef, Out, ReadTxn, StateVector, Transact, TransactionMut, XmlFragment};

use crate::doc::doc_to_json;
use crate::history::reverse_diff;
use crate::import::{insert_children, json_to_any, json_to_in};
use crate::roots;

/// The update (Yjs v1) that makes `doc` match `target` (`document.json`), computed on a copy.
/// Empty when nothing differs.
pub fn restore_update(doc: &Doc, target: &Value) -> Result<Vec<u8>, String> {
    let scratch = crate::new_doc();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    crate::ocanvas::apply_update_bytes(&scratch, &state).map_err(|e| e.to_string())?;
    let before = scratch.transact().state_vector();
    let current = doc_to_json(&scratch);
    let diff = reverse_diff(&current, target);
    let content = scratch.get_or_insert_xml_fragment(roots::CONTENT);
    let maps: Vec<(&str, MapRef)> = ["meta", "databases", "boards"]
        .into_iter()
        .map(|n| (n, scratch.get_or_insert_map(n)))
        .collect();
    {
        let mut txn = scratch.transact_mut();
        if let Some(ops) = diff["content"].as_array() {
            let blocks = current["content"].as_array().map_or(0, Vec::len) as u32;
            if content.len(&txn) == blocks {
                let mut at = 0u32;
                for op in ops {
                    match op[0].as_str() {
                        Some("k") => at += op[1].as_u64().unwrap_or(0) as u32,
                        Some("d") => {
                            let n = op[1].as_u64().unwrap_or(0) as u32;
                            content.remove_range(&mut txn, at, n);
                        }
                        Some("i") => {
                            let nodes = op[1].as_array().cloned().unwrap_or_default();
                            at += insert_children(&mut txn, &content, at, &nodes);
                        }
                        _ => {}
                    }
                }
            } else {
                // Bare text at the top level splits differently in JSON: replace it all.
                let n = content.len(&txn);
                content.remove_range(&mut txn, 0, n);
                let nodes = target["content"].as_array().cloned().unwrap_or_default();
                insert_children(&mut txn, &content, 0, &nodes);
            }
        }
        for (name, map) in &maps {
            if let Some(d) = diff.get(*name) {
                apply_map(&mut txn, map, d, *name == "meta");
            }
        }
    }
    Ok(scratch.transact().encode_state_as_update_v1(&before))
}

/// Applies an object diff (`history::reverse_diff` form) to a Y.Map.
fn apply_map(txn: &mut TransactionMut, map: &MapRef, d: &Value, plain: bool) {
    for k in d["d"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        map.remove(txn, k);
    }
    for (k, v) in d["s"].as_object().into_iter().flatten() {
        if plain {
            map.insert(txn, k.as_str(), json_to_any(v));
        } else {
            map.insert(txn, k.as_str(), json_to_in(k, v));
        }
    }
    for (k, sub) in d["o"].as_object().into_iter().flatten() {
        match map.get(txn, k) {
            Some(Out::YMap(inner)) if !plain => apply_map(txn, &inner, sub, false),
            other => {
                // A plain JSON value (options, props written as one value): rewrite it whole.
                let cur = other
                    .map(|o| crate::doc::any_to_json(&o.to_json(txn)))
                    .unwrap_or(Value::Null);
                let next = crate::history::apply_object_diff(&cur, sub);
                if plain {
                    map.insert(txn, k.as_str(), json_to_any(&next));
                } else {
                    map.insert(txn, k.as_str(), json_to_in(k, &next));
                }
            }
        }
    }
}
