// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! A Spreadsheet block as the server sees it (ADR-080 §4, SHEET-03): the logical JSON of one
//! entry of the `sheets` root (`{order, sheets: {id: {name, rows, cols, cells: {"r:c": {in, s}}}},
//! styles}`), computed into tables of display values for exports, `search.json`, the API and MCP,
//! written to `.xlsx`, and built from an `.xlsx` or `.ods` file.

use serde_json::{Map, Value, json};

use casual_calc_sdk::{SessionFormat, WorkbookSession};

use crate::engine::{self, BookError, BookSheet};
use crate::refs;

/// One sheet computed: its id, name and the used range as display text (row 1 first).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Table {
    pub id: String,
    pub name: String,
    pub rows: Vec<Vec<String>>,
}

/// Most cells an imported workbook may hold (MOD-01 sets the block cap once measured).
pub const MAX_IMPORT_CELLS: usize = 200_000;
/// The grid a new sheet starts with (as `web/packages/sheet/src/model.ts`).
pub const NEW_ROWS: usize = 100;
pub const NEW_COLS: usize = 26;

fn strs(x: &Value) -> Vec<String> {
    x.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// The block's sheets in tab order, as the engine takes them.
pub fn book_sheets(block: &Value) -> Vec<BookSheet> {
    let all = &block["sheets"];
    strs(&block["order"])
        .into_iter()
        .filter_map(|id| {
            let s = all.get(&id)?;
            let cells = s["cells"]
                .as_object()
                .map(|m| {
                    m.iter()
                        .filter_map(|(k, v)| {
                            let (r, c) = k.split_once(':')?;
                            let input = v["in"].as_str().or_else(|| v.as_str())?;
                            (!input.is_empty())
                                .then(|| (r.to_string(), c.to_string(), input.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(BookSheet {
                name: s["name"].as_str().unwrap_or_default().to_string(),
                rows: strs(&s["rows"]),
                cols: strs(&s["cols"]),
                cells,
                id,
            })
        })
        .collect()
}

/// Every sheet of the block as a table of display values, trimmed to the used range (an empty
/// sheet has no rows). A block the engine refuses shows its stored inputs instead.
pub fn tables(block: &Value) -> Vec<Table> {
    let sheets = book_sheets(block);
    let grid = engine::grid_of(&sheets);
    let shown: Vec<(String, String, String, String)> = match engine::compute(&sheets) {
        Ok(v) => v
            .into_iter()
            .map(|s| (s.sheet, s.row, s.col, s.text))
            .collect(),
        Err(_) => sheets
            .iter()
            .flat_map(|s| {
                s.cells.iter().map(|(r, c, v)| {
                    let typed = refs::to_a1(v, &s.id, &grid);
                    (s.id.clone(), r.clone(), c.clone(), typed)
                })
            })
            .collect(),
    };
    sheets
        .iter()
        .map(|s| {
            let at = |ids: &[String], id: &str| ids.iter().position(|x| x == id);
            let mut cells = Vec::new();
            let (mut h, mut w) = (0, 0);
            for (sid, r, c, text) in &shown {
                if sid != &s.id || text.is_empty() {
                    continue;
                }
                if let (Some(r), Some(c)) = (at(&s.rows, r), at(&s.cols, c)) {
                    h = h.max(r + 1);
                    w = w.max(c + 1);
                    cells.push((r, c, text.clone()));
                }
            }
            let mut rows = vec![vec![String::new(); w]; h];
            for (r, c, text) in cells {
                rows[r][c] = text;
            }
            Table {
                id: s.id.clone(),
                name: s.name.clone(),
                rows,
            }
        })
        .collect()
}

/// The block as an `.xlsx` package (inputs as typed, formulas in A1, values computed).
pub fn to_xlsx(block: &Value) -> Result<Vec<u8>, BookError> {
    let sheets = book_sheets(block);
    if sheets.is_empty() {
        return Err(BookError("the block has no sheets".into()));
    }
    engine::Book::open(sheets)?.save_as(SessionFormat::Xlsx)
}

/// Which spreadsheet format a file is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileFormat {
    Xlsx,
    Ods,
}

/// A workbook file as a new block's logical JSON (the shape [`book_sheets`] reads; objects
/// become `Y.Map`s and arrays `Y.Array`s when written to the document). Cells keep what was
/// typed: values as shown in the formula bar, formulas with references stored as ids. Rows and
/// columns get fresh ids (`<sheet>r<n>`, `<sheet>c<n>`), sized to the used range or the new-sheet
/// grid, whichever is larger.
pub fn from_file(bytes: &[u8], format: FileFormat) -> Result<Value, BookError> {
    let session = match format {
        FileFormat::Xlsx => WorkbookSession::open(bytes.to_vec()),
        FileFormat::Ods => WorkbookSession::open_ods(bytes.to_vec()),
    }
    .map_err(|e| BookError(format!("not a readable workbook: {e}")))?;
    let wb = session.workbook();
    let mut total = 0usize;
    let mut sheets = Vec::new();
    let mut inputs = Vec::new();
    for (k, sheet) in wb.sheets.iter().enumerate() {
        let id = format!("s{k}");
        let mut cells = Vec::new();
        let (mut h, mut w) = (NEW_ROWS, NEW_COLS);
        for (at, _) in sheet.cells.iter() {
            let input = session.cell_input(k, at);
            if input.is_empty() {
                continue;
            }
            total += 1;
            if total > MAX_IMPORT_CELLS {
                return Err(BookError(format!(
                    "the workbook has more than {MAX_IMPORT_CELLS} cells"
                )));
            }
            h = h.max(at.row as usize + 1);
            w = w.max(at.col as usize + 1);
            cells.push((at, input));
        }
        let rows: Vec<String> = (0..h).map(|i| format!("{id}r{i}")).collect();
        let cols: Vec<String> = (0..w).map(|i| format!("{id}c{i}")).collect();
        sheets.push(BookSheet {
            id,
            name: sheet.name.clone(),
            rows,
            cols,
            cells: vec![],
        });
        inputs.push(cells);
    }
    if sheets.is_empty() {
        return Err(BookError("the workbook has no sheets".into()));
    }
    let grid = engine::grid_of(&sheets);
    let mut out = Map::new();
    for (s, cells) in sheets.iter().zip(inputs) {
        let mut m = Map::new();
        for (at, input) in cells {
            let key = format!("{}:{}", s.rows[at.row as usize], s.cols[at.col as usize]);
            let stored = if input.starts_with('=') {
                refs::to_ids(&input, &s.id, &grid)
            } else {
                input
            };
            m.insert(key, json!({ "in": stored }));
        }
        out.insert(
            s.id.clone(),
            json!({"name": s.name, "rows": s.rows, "cols": s.cols, "cells": m,
                "widths": {}, "heights": {}, "freeze": {}}),
        );
    }
    let order: Vec<&str> = sheets.iter().map(|s| s.id.as_str()).collect();
    Ok(json!({"order": order, "sheets": out, "styles": {}}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn budget() -> Value {
        json!({
            "order": ["s1", "s2"],
            "sheets": {
                "s1": {"name": "Budget", "rows": ["a", "b", "c", "d"], "cols": ["x", "y", "z"],
                    "cells": {
                        "a:x": {"in": "Item"}, "a:y": {"in": "Cost"},
                        "b:x": {"in": "Venue"}, "b:y": {"in": "4200"},
                        "c:x": {"in": "Food", "s": "k1"}, "c:y": {"in": "800"},
                        "d:x": {"in": "Total"}
                    }},
                "s2": {"name": "Empty", "rows": ["r"], "cols": ["c"], "cells": {}}
            },
            "styles": {}
        })
    }

    fn with_sum(mut b: Value) -> Value {
        let grid = engine::grid_of(&book_sheets(&b));
        let stored = refs::to_ids("=SUM(B2:B3)", "s1", &grid);
        b["sheets"]["s1"]["cells"]["d:y"] = json!({ "in": stored });
        b
    }

    #[test]
    fn tables_show_computed_values_in_the_used_range() {
        let t = tables(&with_sum(budget()));
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].name, "Budget");
        assert_eq!(
            t[0].rows,
            vec![
                vec!["Item", "Cost"],
                vec!["Venue", "4200"],
                vec!["Food", "800"],
                vec!["Total", "5000"],
            ]
        );
        assert!(t[1].rows.is_empty());
    }

    #[test]
    fn xlsx_round_trips_inputs_and_formulas() {
        let bytes = to_xlsx(&with_sum(budget())).unwrap();
        assert!(bytes.starts_with(b"PK"));
        let block = from_file(&bytes, FileFormat::Xlsx).unwrap();
        let t = tables(&block);
        assert_eq!(t[0].name, "Budget");
        assert_eq!(t[0].rows[3], vec!["Total", "5000"]);
        // The formula is stored with ids and reads back as typed.
        let sheets = book_sheets(&block);
        let grid = engine::grid_of(&sheets);
        let (_, _, stored) = sheets[0]
            .cells
            .iter()
            .find(|(_, _, v)| v.starts_with('='))
            .unwrap();
        assert!(stored.contains(refs::OPEN), "{stored}");
        assert_eq!(refs::to_a1(stored, "s0", &grid), "=SUM(B2:B3)");
        assert_eq!(sheets[0].rows.len(), NEW_ROWS);
    }

    #[test]
    fn ods_imports() {
        let book = engine::Book::open(book_sheets(&with_sum(budget()))).unwrap();
        let bytes = book.save_as(SessionFormat::Ods).unwrap();
        let t = tables(&from_file(&bytes, FileFormat::Ods).unwrap());
        assert_eq!(t[0].rows[3], vec!["Total", "5000"]);
    }

    #[test]
    fn garbage_is_refused() {
        assert!(from_file(b"not a zip", FileFormat::Xlsx).is_err());
        assert!(from_file(b"not a zip", FileFormat::Ods).is_err());
    }
}
