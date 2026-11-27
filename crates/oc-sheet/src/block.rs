// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! A Spreadsheet block as the server sees it (ADR-080 §4, SHEET-03): the logical JSON of one
//! entry of the `sheets` root (`{order, sheets: {id: {name, rows, cols, cells: {"r:c": {in, s}}}},
//! styles}`), computed into tables of display values for exports, `search.json`, the API and MCP,
//! written to `.xlsx`, and built from an `.xlsx` or `.ods` file.

use serde_json::{Map, Value, json};

use casual_calc_model::HAlign;
use casual_calc_sdk::{CellRef, EditOperation, SessionFormat, Style, WorkbookSession};

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
    let mut book = engine::Book::open(sheets.clone())?;
    apply_formats(&mut book, block, &sheets)?;
    book.save_as(SessionFormat::Xlsx)
}

/* ---------------------------------------------------------------- cell styles (SHEET-07) */

/// Twips per rem (1 rem = 16 px; 15 twips per px).
const TWIPS_PER_REM: f64 = 240.0;

fn rem_of(twips: i64) -> f64 {
    (twips as f64 / TWIPS_PER_REM * 100.0).round() / 100.0
}

/// `RRGGBB` (or `AARRGGBB`) as a CSS colour.
fn css_colour(hex: &str) -> Option<String> {
    let h = hex.trim_start_matches('#');
    let h = if h.len() == 8 { &h[2..] } else { h };
    (h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| format!("#{}", h.to_ascii_lowercase()))
}

/// A number-format code with quoted text, escapes and `[...]` sections removed (first section).
fn bare_format(code: &str) -> String {
    let first = code.split(';').next().unwrap_or_default();
    let (mut out, mut quoted, mut bracket, mut escaped) = (String::new(), false, false, false);
    for ch in first.chars() {
        if escaped {
            escaped = false;
        } else if quoted {
            quoted = ch != '"';
        } else if bracket {
            bracket = ch != ']';
        } else {
            match ch {
                '"' => quoted = true,
                '[' => bracket = true,
                '\\' | '_' | '*' => escaped = true,
                _ => out.push(ch),
            }
        }
    }
    out
}

/// A number-format code as the editor's `nf` and `dp` (`grid/logic.ts` `CellStyle`).
fn format_of(code: &str) -> (Option<&'static str>, Option<u32>) {
    if code.eq_ignore_ascii_case("general") || code == "@" {
        return (None, None);
    }
    let bare = bare_format(code);
    let low = bare.to_ascii_lowercase();
    let digits = low.contains('0') || low.contains('#');
    let dp = digits.then(|| {
        low.split_once('.')
            .map(|(_, f)| f.chars().take_while(|c| *c == '0' || *c == '#').count() as u32)
            .unwrap_or(0)
    });
    if !digits && (low.contains('y') || low.contains('d') || low.contains('m')) {
        return (Some("date"), None);
    }
    if !digits {
        return (None, None);
    }
    let currency = code.contains(['$', '€', '£', '¥']);
    let nf = if low.contains('%') {
        Some("pct")
    } else if low.contains("e+") || low.contains("e-") {
        Some("sci")
    } else if currency {
        Some("cur")
    } else if low.contains(',') {
        Some("num")
    } else {
        None
    };
    (nf, dp)
}

/// The editor's `nf` and `dp` as a number-format code.
fn code_of(nf: Option<&str>, dp: Option<u32>) -> Option<String> {
    let frac = |n: u32| {
        if n == 0 {
            String::new()
        } else {
            format!(".{}", "0".repeat(n as usize))
        }
    };
    Some(match nf {
        Some("pct") => format!("0{}%", frac(dp.unwrap_or(0))),
        Some("cur") => format!("\"€\"#,##0{}", frac(dp.unwrap_or(2))),
        Some("date") => "mmm d, yyyy".into(),
        Some("sci") => format!("0{}E+00", frac(dp.unwrap_or(2))),
        Some("num") => format!("#,##0{}", frac(dp.unwrap_or(2))),
        _ => format!("0{}", frac(dp?)),
    })
}

/// An engine cell style as the editor's style JSON (keys sorted, as `writeStyle` writes them),
/// `None` when nothing the editor shows is set. Black text and white fill are the defaults.
fn style_json(st: &Style) -> Option<String> {
    let mut m = Map::new();
    match st.align {
        Some(HAlign::Left) => m.insert("al".into(), json!("l")),
        Some(HAlign::Center | HAlign::CenterContinuous) => m.insert("al".into(), json!("c")),
        Some(HAlign::Right) => m.insert("al".into(), json!("r")),
        _ => None,
    };
    if st.bold {
        m.insert("b".into(), json!(true));
    }
    if let Some(c) = st.fill_color.as_deref().and_then(css_colour)
        && c != "#ffffff"
    {
        m.insert("bg".into(), json!(c));
    }
    if let Some(code) = &st.number_format {
        let (nf, dp) = format_of(code);
        if let Some(dp) = dp {
            m.insert("dp".into(), json!(dp));
        }
        if let Some(nf) = nf {
            m.insert("nf".into(), json!(nf));
        }
    }
    if let Some(c) = st.font_color.as_deref().and_then(css_colour)
        && c != "#000000"
    {
        m.insert("fg".into(), json!(c));
    }
    if st.italic {
        m.insert("i".into(), json!(true));
    }
    if st.strike {
        m.insert("st".into(), json!(true));
    }
    // serde_json's map is ordered by key, as `JSON.stringify(next, sortedKeys)`.
    (!m.is_empty()).then(|| Value::Object(m).to_string())
}

/// The editor's style JSON as an engine style.
fn engine_style(j: &Value) -> Style {
    let hex = |k: &str| {
        j[k].as_str()
            .and_then(css_colour)
            .map(|c| c[1..].to_ascii_uppercase())
    };
    Style {
        bold: j["b"] == true,
        italic: j["i"] == true,
        strike: j["st"] == true,
        font_color: hex("fg"),
        fill_color: hex("bg"),
        align: match j["al"].as_str() {
            Some("l") => Some(HAlign::Left),
            Some("c") => Some(HAlign::Center),
            Some("r") => Some(HAlign::Right),
            _ => None,
        },
        number_format: code_of(j["nf"].as_str(), j["dp"].as_u64().map(|d| d.min(30) as u32)),
        ..Style::default()
    }
}

/// Applies the block's cell styles, column widths and row heights to an opened book (exports).
fn apply_formats(
    book: &mut engine::Book,
    block: &Value,
    sheets: &[BookSheet],
) -> Result<(), BookError> {
    use crate::refs::Grid;
    let styles = &block["styles"];
    let mut ops = Vec::new();
    for (k, s) in sheets.iter().enumerate() {
        let raw = &block["sheets"][&s.id];
        let grid = book.grid();
        if let Some(cells) = raw["cells"].as_object() {
            for (key, v) in cells {
                let Some(json) = v["s"].as_str().and_then(|sk| styles[sk].as_str()) else {
                    continue;
                };
                let Ok(j) = serde_json::from_str::<Value>(json) else {
                    continue;
                };
                let Some((r, c)) = key.split_once(':') else {
                    continue;
                };
                if let (Some(row), Some(col)) = (grid.row_index(&s.id, r), grid.col_index(&s.id, c))
                {
                    ops.push((k, Some(CellRef { row, col }), None, engine_style(&j)));
                }
            }
        }
        for (field, is_col) in [("widths", true), ("heights", false)] {
            for (id, rem) in raw[field].as_object().into_iter().flatten() {
                let Some(rem) = rem.as_f64().filter(|r| *r > 0.0) else {
                    continue;
                };
                let at = if is_col {
                    grid.col_index(&s.id, id)
                } else {
                    grid.row_index(&s.id, id)
                };
                if let Some(at) = at {
                    let twips = (rem * TWIPS_PER_REM).round() as i64;
                    ops.push((k, None, Some((is_col, at, twips)), Style::default()));
                }
            }
        }
    }
    let session = book.session_mut();
    for (k, at, size, style) in ops {
        let op = match (at, size) {
            (Some(at), _) => {
                let id = session.workbook_mut().intern_style(style);
                EditOperation::SetStyle {
                    sheet: k,
                    at,
                    style: Some(id),
                }
            }
            (None, Some((true, col, w))) => EditOperation::SetColumnWidth {
                sheet: k,
                col,
                width: Some(w),
            },
            (None, Some((false, row, h))) => EditOperation::SetRowHeight {
                sheet: k,
                row,
                height: Some(h),
            },
            _ => continue,
        };
        session
            .apply_raw(op)
            .map_err(|e| BookError(format!("format: {e:?}")))?;
    }
    Ok(())
}

/// A cell style's key in the block's `styles` (as `styleKey` in `web/packages/sheet/src/model.ts`:
/// FNV-1a over the JSON's UTF-16 code units, base 36), so equal styles share one entry.
pub fn style_key(json: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for u in json.encode_utf16() {
        h = (h ^ u32::from(u)).wrapping_mul(0x0100_0193);
    }
    let mut digits = Vec::new();
    loop {
        digits.push(std::char::from_digit(h % 36, 36).unwrap_or('0'));
        h /= 36;
        if h == 0 {
            break;
        }
    }
    let mut out = String::from("s");
    out.extend(digits.iter().rev());
    out
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
    let mut sizes_of = Vec::new();
    let mut styles = Map::new();
    for (k, sheet) in wb.sheets.iter().enumerate() {
        let id = format!("s{k}");
        let mut cells = Vec::new();
        let (mut h, mut w) = (NEW_ROWS, NEW_COLS);
        for (at, cell) in sheet.cells.iter() {
            let input = session.cell_input(k, at);
            let style = cell
                .style
                .and_then(|id| wb.styles.get(id))
                .and_then(style_json)
                .map(|j| {
                    let key = style_key(&j);
                    styles.entry(key.clone()).or_insert(Value::String(j));
                    key
                });
            if input.is_empty() && style.is_none() {
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
            cells.push((at, input, style));
        }
        let sizes =
            |axis: &casual_calc_model::AxisSizing, n: usize, p: char| -> Map<String, Value> {
                axis.sizes
                    .iter()
                    .filter(|(i, t)| (**i as usize) < n && **t > 0)
                    .map(|(i, t)| (format!("{id}{p}{i}"), json!(rem_of(*t))))
                    .collect()
            };
        sizes_of.push((sizes(&sheet.columns, w, 'c'), sizes(&sheet.rows, h, 'r')));
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
    for ((s, cells), (widths, heights)) in sheets.iter().zip(inputs).zip(sizes_of) {
        let mut m = Map::new();
        for (at, input, style) in cells {
            let key = format!("{}:{}", s.rows[at.row as usize], s.cols[at.col as usize]);
            let stored = if input.starts_with('=') {
                refs::to_ids(&input, &s.id, &grid)
            } else {
                input
            };
            let mut cell = if stored.is_empty() {
                json!({})
            } else {
                json!({ "in": stored })
            };
            if let Some(sk) = style {
                cell["s"] = json!(sk);
            }
            m.insert(key, cell);
        }
        out.insert(
            s.id.clone(),
            json!({"name": s.name, "rows": s.rows, "cols": s.cols, "cells": m,
                "widths": widths, "heights": heights, "freeze": {}}),
        );
    }
    let order: Vec<&str> = sheets.iter().map(|s| s.id.as_str()).collect();
    Ok(json!({"order": order, "sheets": out, "styles": styles}))
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
    fn style_keys_match_the_editor() {
        // Values from the editor's `styleKey` (model.ts) for the same JSON.
        assert_eq!(
            style_key(r##"{"b":true,"dp":2,"fg":"#c00000","nf":"cur"}"##),
            "smcxb24"
        );
        assert_eq!(style_key(r#"{"i":true,"fg":"€"}"#), "slaw8gl");
    }

    /// The budget with cell styles, a column width and a row height, stored as the editor does.
    fn styled() -> Value {
        let mut b = with_sum(budget());
        let put = |b: &mut Value, json: &str| {
            let k = style_key(json);
            b["styles"][&k] = json!(json);
            k
        };
        let head = put(
            &mut b,
            r##"{"al":"c","b":true,"bg":"#ffeb9c","fg":"#c00000"}"##,
        );
        let money = put(&mut b, r#"{"dp":2,"i":true,"nf":"cur"}"#);
        let pct = put(&mut b, r#"{"dp":1,"nf":"pct"}"#);
        let plain = put(&mut b, r#"{"al":"r","dp":3}"#);
        let cells = &mut b["sheets"]["s1"]["cells"];
        cells["a:x"]["s"] = json!(head);
        cells["a:y"]["s"] = json!(head);
        cells["b:y"]["s"] = json!(money);
        cells["c:y"]["s"] = json!(pct);
        cells["d:y"]["s"] = json!(plain);
        cells["c:x"].as_object_mut().unwrap().remove("s"); // the fixture's unknown key
        b["sheets"]["s1"]["widths"] = json!({"x": 12.5});
        b["sheets"]["s1"]["heights"] = json!({"a": 2.5});
        b
    }

    #[test]
    fn styled_xlsx_round_trips_formats_styles_and_widths() {
        let bytes = to_xlsx(&styled()).unwrap();
        let block = from_file(&bytes, FileFormat::Xlsx).unwrap();
        let s0 = &block["sheets"]["s0"];
        let style_at = |key: &str| -> Value {
            let k = s0["cells"][key]["s"]
                .as_str()
                .unwrap_or_else(|| panic!("{key} has no style: {block}"));
            let j = block["styles"][k].as_str().unwrap();
            assert_eq!(style_key(j), k, "the key is the JSON's hash");
            serde_json::from_str(j).unwrap()
        };
        assert_eq!(
            style_at("s0r0:s0c0"),
            json!({"al": "c", "b": true, "bg": "#ffeb9c", "fg": "#c00000"})
        );
        assert_eq!(style_at("s0r0:s0c1"), style_at("s0r0:s0c0"));
        assert_eq!(
            style_at("s0r1:s0c1"),
            json!({"dp": 2, "i": true, "nf": "cur"})
        );
        assert_eq!(style_at("s0r2:s0c1"), json!({"dp": 1, "nf": "pct"}));
        assert_eq!(style_at("s0r3:s0c1"), json!({"al": "r", "dp": 3}));
        assert!(
            s0["cells"]["s0r2:s0c0"].get("s").is_none(),
            "unstyled stays unstyled"
        );
        // Inputs still read as typed (a currency cell keeps its number).
        assert_eq!(s0["cells"]["s0r1:s0c1"]["in"], "4200");
        assert_eq!(s0["widths"]["s0c0"], json!(12.5));
        assert!(s0["widths"].get("s0c1").is_none());
        assert_eq!(s0["heights"]["s0r0"], json!(2.5));
        // And the same again from the imported block.
        let again = from_file(&to_xlsx(&block).unwrap(), FileFormat::Xlsx).unwrap();
        assert_eq!(again["styles"], block["styles"]);
        assert_eq!(again["sheets"]["s0"]["widths"], s0["widths"]);
    }

    #[test]
    fn garbage_is_refused() {
        assert!(from_file(b"not a zip", FileFormat::Xlsx).is_err());
        assert!(from_file(b"not a zip", FileFormat::Ods).is_err());
    }
}
