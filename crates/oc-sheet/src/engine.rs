// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Computing a Spreadsheet block with opencalc's engine (ADR-080 §2, SHEET-01).
//!
//! The input is the block as the Yjs document holds it: sheets in tab order, each with its row
//! and column ids and the cells' stored inputs (`rowId:colId` → what was typed, formulas with
//! id references, [`crate::refs`]). The engine sees an ordinary workbook: stored references are
//! turned into A1 from the current order, every cell is entered as if typed, and the workbook is
//! recalculated. The output is each cell's display text (`12.5`, `#DIV/0!`, `$1,200.00`).
//! Values are never written back to the document (ADR-078's rule).

use casual_calc_model::Id;
use casual_calc_sdk::{CellRef, EditOperation, Sheet, SheetId, WorkbookSession};

use crate::refs::{self, Grid, MemGrid};

/// One sheet of a block, as stored.
#[derive(Clone, Debug, Default)]
pub struct BookSheet {
    pub id: String,
    pub name: String,
    pub rows: Vec<String>,
    pub cols: Vec<String>,
    /// `(rowId, colId, stored input)`.
    pub cells: Vec<(String, String, String)>,
}

/// One computed cell: sheet id, row id, column id, display text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shown {
    pub sheet: String,
    pub row: String,
    pub col: String,
    pub text: String,
}

/// What went wrong building the workbook (an engine refusal, not a formula error: those are
/// values such as `#REF!`).
#[derive(Debug)]
pub struct BookError(pub String);

/// The grid the references resolve against.
pub fn grid_of(sheets: &[BookSheet]) -> MemGrid {
    MemGrid {
        sheets: sheets
            .iter()
            .map(|s| (s.id.clone(), s.name.clone(), s.rows.clone(), s.cols.clone()))
            .collect(),
    }
}

/// Builds the workbook and computes every cell that has an input.
pub fn compute(sheets: &[BookSheet]) -> Result<Vec<Shown>, BookError> {
    let grid = grid_of(sheets);
    let mut book = WorkbookSession::blank();
    for (k, s) in sheets.iter().enumerate() {
        let sheet = Sheet::new(SheetId(Id::from_parts(1, k as u64 + 1)), s.name.clone());
        book.edit(EditOperation::InsertSheet {
            index: k,
            sheet: Box::new(sheet),
        })
        .map_err(|e| BookError(format!("sheet {}: {e:?}", s.name)))?;
    }
    let mut placed = Vec::new();
    for (k, s) in sheets.iter().enumerate() {
        for (rid, cid, stored) in &s.cells {
            // A cell whose row or column was deleted is gone with it.
            let (Some(row), Some(col)) = (grid.row_index(&s.id, rid), grid.col_index(&s.id, cid))
            else {
                continue;
            };
            let at = CellRef { row, col };
            let typed = refs::to_a1(stored, &s.id, &grid);
            let op = book.input_edit(k, at, &typed);
            book.edit(op)
                .map_err(|e| BookError(format!("{}!{rid}:{cid}: {e:?}", s.name)))?;
            placed.push((k, at, rid, cid));
        }
    }
    book.recalculate();
    Ok(placed
        .into_iter()
        .map(|(k, at, rid, cid)| Shown {
            sheet: sheets[k].id.clone(),
            row: rid.clone(),
            col: cid.clone(),
            text: book.cell_display(k, at),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(p: &str, n: usize) -> Vec<String> {
        (0..n).map(|i| format!("{p}{i}")).collect()
    }

    /// The prototype's "Launch budget": Budget, Rates and Summary sheets.
    fn launch_budget() -> Vec<BookSheet> {
        let mut sheets = vec![
            BookSheet {
                id: "sb".into(),
                name: "Budget".into(),
                rows: ids("b", 10),
                cols: ids("x", 5),
                cells: vec![],
            },
            BookSheet {
                id: "sr".into(),
                name: "Rates".into(),
                rows: ids("r", 5),
                cols: ids("y", 3),
                cells: vec![],
            },
            BookSheet {
                id: "ss".into(),
                name: "Summary".into(),
                rows: ids("s", 5),
                cols: ids("z", 3),
                cells: vec![],
            },
        ];
        let grid = grid_of(&sheets);
        let put = |sheets: &mut Vec<BookSheet>, k: usize, a1: &str, input: &str| {
            let (col, row) = a1.split_at(1);
            let c = (col.as_bytes()[0] - b'A') as usize;
            let r: usize = row.parse::<usize>().unwrap() - 1;
            let sid = sheets[k].id.clone();
            let stored = refs::to_ids(input, &sid, &grid);
            let (rid, cid) = (sheets[k].rows[r].clone(), sheets[k].cols[c].clone());
            sheets[k].cells.push((rid, cid, stored));
        };
        put(&mut sheets, 1, "A1", "Venue");
        put(&mut sheets, 1, "B1", "4200");
        put(&mut sheets, 1, "A2", "Catering");
        put(&mut sheets, 1, "B2", "35");
        put(&mut sheets, 0, "A1", "Item");
        put(&mut sheets, 0, "B1", "Qty");
        put(&mut sheets, 0, "C1", "Cost");
        put(&mut sheets, 0, "A2", "Venue");
        put(&mut sheets, 0, "B2", "1");
        put(
            &mut sheets,
            0,
            "C2",
            "=B2*VLOOKUP(A2,Rates!$A$1:$B$5,2,FALSE)",
        );
        put(&mut sheets, 0, "A3", "Catering");
        put(&mut sheets, 0, "B3", "120");
        put(
            &mut sheets,
            0,
            "C3",
            "=B3*VLOOKUP(A3,Rates!$A$1:$B$5,2,FALSE)",
        );
        put(&mut sheets, 0, "C4", "=SUM(C2:C3)");
        put(&mut sheets, 2, "A1", "=Budget!C4");
        put(&mut sheets, 2, "B1", "=IFERROR(Budget!C4/0,\"n/a\")");
        sheets
    }

    fn text(out: &[Shown], sheet: &str, row: &str, col: &str) -> String {
        out.iter()
            .find(|s| s.sheet == sheet && s.row == row && s.col == col)
            .map(|s| s.text.clone())
            .unwrap_or_default()
    }

    #[test]
    fn computes_across_sheets_from_stored_ids() {
        let out = compute(&launch_budget()).unwrap();
        assert_eq!(text(&out, "sb", "b1", "x2"), "4200");
        assert_eq!(text(&out, "sb", "b2", "x2"), "4200");
        assert_eq!(text(&out, "sb", "b3", "x2"), "8400"); // the C4 total: 4200 + 120 * 35
        assert_eq!(text(&out, "ss", "s0", "z0"), "8400");
        assert_eq!(text(&out, "ss", "s0", "z1"), "n/a");
    }

    #[test]
    fn an_inserted_row_keeps_formulas_on_their_cells() {
        let mut sheets = launch_budget();
        // A new row above the Catering line: the total still sums both lines.
        sheets[0].rows.insert(2, "new".into());
        let out = compute(&sheets).unwrap();
        assert_eq!(text(&out, "sb", "b3", "x2"), "8400");
        assert_eq!(text(&out, "ss", "s0", "z0"), "8400");
    }

    #[test]
    fn a_deleted_row_reads_ref_error() {
        let mut sheets = launch_budget();
        sheets[0].rows.retain(|r| r != "b2"); // the Catering line
        let out = compute(&sheets).unwrap();
        assert_eq!(text(&out, "sb", "b3", "x2"), "#REF!");
        assert_eq!(text(&out, "ss", "s0", "z0"), "#REF!");
    }
}
