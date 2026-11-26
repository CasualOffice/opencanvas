// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `oc-sheet` (ADR-080): the Spreadsheet block's model rules and its bridge to opencalc's engine,
//! shared by the server (native) and the editor (WASM, loaded lazily). Yjs is the source of
//! truth; each sheet's rows and columns are lists of stable ids, and a formula is stored with its
//! references as those ids ([`refs`]), shown and computed as A1 ([`engine`]). Inserting or
//! deleting rows and columns is then one list edit with no formula rewrites, so concurrent edits
//! converge, and a reference to a deleted row or column reads `#REF!`.

pub mod engine;
pub mod refs;

#[cfg(target_arch = "wasm32")]
mod wasm;

use serde_json::{Value, json};

use engine::BookSheet;

/// Sheets from the bridge's JSON: `[{id, name, rows: [id], cols: [id], cells: {"row:col": input}}]`.
fn sheets_of(v: &Value) -> Vec<BookSheet> {
    let strs = |x: &Value| -> Vec<String> {
        x.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|s| BookSheet {
                    id: s["id"].as_str().unwrap_or_default().to_string(),
                    name: s["name"].as_str().unwrap_or_default().to_string(),
                    rows: strs(&s["rows"]),
                    cols: strs(&s["cols"]),
                    cells: s["cells"]
                        .as_object()
                        .map(|m| {
                            m.iter()
                                .filter_map(|(k, v)| {
                                    let (r, c) = k.split_once(':')?;
                                    Some((r.to_string(), c.to_string(), v.as_str()?.to_string()))
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The bridge's operations (JSON in, JSON out), the same natively and in WASM:
/// 1 compute `{sheets}` → `{values: [[sheet, row, col, text]]}`;
/// 2 to A1 `{src, here, sheets}` → `{a1}`; 3 to ids `{src, here, sheets}` → `{stored}`;
/// 4 shift `{src, dr, dc}` → `{a1}`.
pub fn dispatch(op: u32, input: &Value) -> Value {
    match op {
        1 => match engine::compute(&sheets_of(&input["sheets"])) {
            Ok(out) => json!({
                "values": out.into_iter().map(|s| json!([s.sheet, s.row, s.col, s.text])).collect::<Vec<_>>()
            }),
            Err(e) => json!({ "error": e.0 }),
        },
        2 | 3 => {
            let grid = engine::grid_of(&sheets_of(&input["sheets"]));
            let src = input["src"].as_str().unwrap_or_default();
            let here = input["here"].as_str().unwrap_or_default();
            if op == 2 {
                json!({ "a1": refs::to_a1(src, here, &grid) })
            } else {
                json!({ "stored": refs::to_ids(src, here, &grid) })
            }
        }
        4 => json!({
            "a1": refs::shift(
                input["src"].as_str().unwrap_or_default(),
                input["dr"].as_i64().unwrap_or(0),
                input["dc"].as_i64().unwrap_or(0),
            )
        }),
        _ => json!({ "error": format!("unknown operation {op}") }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bridge_computes_and_converts() {
        let sheets = json!([{ "id": "s", "name": "Budget", "rows": ["r1", "r2", "r3"], "cols": ["a", "b"],
            "cells": { "r1:a": "2", "r2:a": "3" } }]);
        let stored = dispatch(
            3,
            &json!({ "src": "=SUM(A1:A2)*2", "here": "s", "sheets": sheets }),
        );
        let stored = stored["stored"].as_str().unwrap().to_string();
        let mut with_sum = sheets.clone();
        with_sum[0]["cells"]["r3:a"] = json!(stored);
        let out = dispatch(1, &json!({ "sheets": with_sum }));
        assert!(
            out["values"]
                .as_array()
                .unwrap()
                .contains(&json!(["s", "r3", "a", "10"])),
            "{out}"
        );
        assert_eq!(
            dispatch(2, &json!({ "src": stored, "here": "s", "sheets": sheets }))["a1"],
            "=SUM(A1:A2)*2"
        );
        assert_eq!(
            dispatch(4, &json!({ "src": "=A1+$B$1", "dr": 1, "dc": 1 }))["a1"],
            "=B2+$B$1"
        );
    }
}
