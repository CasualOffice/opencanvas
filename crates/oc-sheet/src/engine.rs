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

use std::collections::BTreeMap;

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
    MemGrid::new(
        sheets
            .iter()
            .map(|s| (s.id.clone(), s.name.clone(), s.rows.clone(), s.cols.clone()))
            .collect(),
    )
}

/// A block's workbook kept between edits (one per open block): opening builds it once, a cell
/// edit is applied in place and answers only the cells whose display changed.
pub struct Book {
    sheets: Vec<BookSheet>,
    grid: MemGrid,
    session: WorkbookSession,
    /// `(sheet index, row id, col id)` → what it shows, for every cell with an input.
    shown: BTreeMap<(usize, String, String), String>,
}

impl std::fmt::Debug for Book {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Book")
            .field("sheets", &self.sheets.len())
            .field("cells", &self.shown.len())
            .finish()
    }
}

impl Book {
    /// Builds the workbook from the block's sheets and computes it.
    pub fn open(sheets: Vec<BookSheet>) -> Result<Self, BookError> {
        let grid = grid_of(&sheets);
        let mut session = WorkbookSession::blank();
        // Entered cells are computed once, by the recalculation below, not also as each is
        // entered (twice the work for a costly formula, SEC-64).
        session.set_calculation_mode(casual_calc_sdk::CalculationMode::Manual);
        for (k, s) in sheets.iter().enumerate() {
            let sheet = Sheet::new(SheetId(Id::from_parts(1, k as u64 + 1)), s.name.clone());
            session
                .edit(EditOperation::InsertSheet {
                    index: k,
                    sheet: Box::new(sheet),
                })
                .map_err(|e| BookError(format!("sheet {}: {e:?}", s.name)))?;
        }
        let mut book = Book {
            sheets,
            grid,
            session,
            shown: BTreeMap::new(),
        };
        let cells: Vec<(usize, String, String, String)> = book
            .sheets
            .iter()
            .enumerate()
            .flat_map(|(k, s)| {
                s.cells
                    .iter()
                    .map(move |(r, c, v)| (k, r.clone(), c.clone(), v.clone()))
            })
            .collect();
        for (k, rid, cid, stored) in cells {
            if book.enter(k, &rid, &cid, &stored, true)? {
                book.shown.insert((k, rid, cid), String::new());
            }
        }
        book.session.recalculate();
        book.refresh();
        Ok(book)
    }

    /// Enters one stored input as typed; false when its row or column is gone. `bulk` (opening)
    /// applies it without the per-edit recalculation and undo step: an edit rebuilds the
    /// dependency graph, so entering a 100,000-row sheet edit by edit is quadratic. The caller
    /// recalculates once after the last one.
    fn enter(
        &mut self,
        k: usize,
        rid: &str,
        cid: &str,
        stored: &str,
        bulk: bool,
    ) -> Result<bool, BookError> {
        let sid = self.sheets[k].id.clone();
        let (Some(row), Some(col)) = (
            self.grid.row_index(&sid, rid),
            self.grid.col_index(&sid, cid),
        ) else {
            return Ok(false);
        };
        let typed = refs::to_a1(stored, &sid, &self.grid);
        let op = self.session.input_edit(k, CellRef { row, col }, &typed);
        let done = if bulk {
            self.session.apply_raw(op).map(|_| ())
        } else {
            self.session.edit(op)
        };
        done.map_err(|e| BookError(format!("{}!{rid}:{cid}: {e:?}", self.sheets[k].name)))?;
        Ok(true)
    }

    /// Reads every cell's display again; returns the ones that changed.
    fn refresh(&mut self) -> Vec<Shown> {
        let mut changed = Vec::new();
        for ((k, rid, cid), text) in self.shown.iter_mut() {
            let sid = &self.sheets[*k].id;
            let (Some(row), Some(col)) =
                (self.grid.row_index(sid, rid), self.grid.col_index(sid, cid))
            else {
                continue;
            };
            let now = self.session.cell_display(*k, CellRef { row, col });
            if *text != now {
                *text = now.clone();
                changed.push(Shown {
                    sheet: sid.clone(),
                    row: rid.clone(),
                    col: cid.clone(),
                    text: now,
                });
            }
        }
        changed
    }

    /// Sets one cell's stored input (empty clears it); returns every cell whose display changed.
    pub fn set(
        &mut self,
        sheet: &str,
        rid: &str,
        cid: &str,
        stored: &str,
    ) -> Result<Vec<Shown>, BookError> {
        let Some(k) = self.sheets.iter().position(|s| s.id == sheet) else {
            return Err(BookError(format!("no sheet {sheet}")));
        };
        let cells = &mut self.sheets[k].cells;
        cells.retain(|(r, c, _)| !(r == rid && c == cid));
        if !stored.is_empty() {
            cells.push((rid.to_string(), cid.to_string(), stored.to_string()));
        }
        if self.enter(k, rid, cid, stored, false)? {
            let key = (k, rid.to_string(), cid.to_string());
            if stored.is_empty() {
                self.shown.remove(&key);
            } else {
                self.shown.entry(key).or_default();
            }
        }
        self.session.recalculate();
        let mut changed = self.refresh();
        if stored.is_empty() {
            changed.push(Shown {
                sheet: sheet.to_string(),
                row: rid.to_string(),
                col: cid.to_string(),
                text: String::new(),
            });
        }
        Ok(changed)
    }

    /// The workbook as a file (`.xlsx`, `.ods`), formulas in A1 and values as computed.
    pub fn save_as(&self, format: casual_calc_sdk::SessionFormat) -> Result<Vec<u8>, BookError> {
        self.session
            .save_as(format)
            .map_err(|e| BookError(format!("save: {e}")))
    }

    /// The engine's workbook (exports apply cell formats and sizes through it).
    pub(crate) fn session_mut(&mut self) -> &mut WorkbookSession {
        &mut self.session
    }

    /// The grid the block's ids resolve against.
    pub(crate) fn grid(&self) -> &MemGrid {
        &self.grid
    }

    /// Every cell with an input and what it shows.
    pub fn values(&self) -> Vec<Shown> {
        self.shown
            .iter()
            .map(|((k, rid, cid), text)| Shown {
                sheet: self.sheets[*k].id.clone(),
                row: rid.clone(),
                col: cid.clone(),
                text: text.clone(),
            })
            .collect()
    }
}

/// Builds the workbook and computes every cell that has an input (for one-off use: exports).
pub fn compute(sheets: &[BookSheet]) -> Result<Vec<Shown>, BookError> {
    Ok(Book::open(sheets.to_vec())?.values())
}

/// How long the server waits for one block's computation (SEC-64).
pub const COMPUTE_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);
/// Computations past their budget that may still be running in this process; while this many
/// are, new ones are refused (their blocks show the inputs as typed) instead of started.
pub const OVERRUN_THREADS: usize = 2;

/// [`Book::open`] then `f`, on its own thread, for the server (SEC-64). One cell can cost a
/// billion operations (`MMULT` of two 1000 x 1000 arrays) and the engine only checks for
/// cancellation between cells, so a computation that passes [`COMPUTE_BUDGET`] is left to
/// finish on its thread and this answers an error at once; its block (by its inputs) is then
/// not started again by this process. While [`OVERRUN_THREADS`] such computations still run,
/// new ones are refused, so costly canvases hold at most that many cores, and saves, exports
/// and reads go on with the inputs as typed.
#[cfg(not(target_arch = "wasm32"))]
pub fn guarded<T: Send + 'static>(
    sheets: Vec<BookSheet>,
    f: impl FnOnce(&Book) -> Result<T, BookError> + Send + 'static,
) -> Result<T, BookError> {
    use std::hash::{Hash, Hasher};
    let key = {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for s in &sheets {
            (&s.id, &s.rows, &s.cols, &s.cells).hash(&mut h);
        }
        h.finish()
    };
    bounded(key, COMPUTE_BUDGET, move || {
        Book::open(sheets).and_then(|b| f(&b))
    })
}

/// Runs `f` on its own thread and waits at most `budget` for it (SEC-64): past that, `f` is
/// left to finish, `key` is remembered as too costly (and refused at once from then on), and
/// while [`OVERRUN_THREADS`] such jobs still run every new one is refused instead of started.
#[cfg(not(target_arch = "wasm32"))]
pub fn bounded<T: Send + 'static>(
    key: u64,
    budget: std::time::Duration,
    f: impl FnOnce() -> Result<T, BookError> + Send + 'static,
) -> Result<T, BookError> {
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    static OVERRUN: AtomicUsize = AtomicUsize::new(0);
    static SLOW: Mutex<Option<HashSet<u64>>> = Mutex::new(None);
    let slow = |add: bool| {
        let mut g = SLOW.lock().unwrap_or_else(|e| e.into_inner());
        let set = g.get_or_insert_with(HashSet::new);
        if add {
            if set.len() >= 4096 {
                set.clear();
            }
            set.insert(key);
        }
        set.contains(&key)
    };
    if slow(false) {
        return Err(BookError("too costly to compute".into()));
    }
    if OVERRUN.load(Ordering::SeqCst) >= OVERRUN_THREADS {
        return Err(BookError("busy with costly spreadsheets".into()));
    }
    // Set by the waiter when it gives up; the thread then counts itself out when it ends.
    let abandoned = Arc::new(AtomicBool::new(false));
    let mine = abandoned.clone();
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("oc-sheet-compute".into())
        .spawn(move || {
            let r = f();
            if mine.swap(true, Ordering::SeqCst) {
                OVERRUN.fetch_sub(1, Ordering::SeqCst);
            }
            let _ = tx.send(r);
        })
        .map_err(|e| BookError(format!("no thread: {e}")))?;
    match rx.recv_timeout(budget) {
        Ok(r) => r,
        Err(_) => {
            OVERRUN.fetch_add(1, Ordering::SeqCst);
            if abandoned.swap(true, Ordering::SeqCst) {
                // It finished just now.
                OVERRUN.fetch_sub(1, Ordering::SeqCst);
            }
            slow(true);
            Err(BookError("too costly to compute".into()))
        }
    }
}

/// On the editor's WebAssembly there are no threads: the person's own browser computes.
#[cfg(target_arch = "wasm32")]
pub fn guarded<T: Send + 'static>(
    sheets: Vec<BookSheet>,
    f: impl FnOnce(&Book) -> Result<T, BookError> + Send + 'static,
) -> Result<T, BookError> {
    Book::open(sheets).and_then(|b| f(&b))
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

    #[test]
    fn a_kept_book_answers_only_what_an_edit_changed() {
        let mut book = Book::open(launch_budget()).unwrap();
        // Catering quantity 120 -> 100: its cost, the total and the summary change; nothing else.
        let changed = book.set("sb", "b2", "x1", "100").unwrap();
        let mut got: Vec<(String, String, String)> = changed
            .into_iter()
            .map(|s| (s.row, s.col, s.text))
            .collect();
        got.sort();
        assert_eq!(
            got,
            vec![
                ("b2".into(), "x1".into(), "100".into()),
                ("b2".into(), "x2".into(), "3500".into()),
                ("b3".into(), "x2".into(), "7700".into()),
                ("s0".into(), "z0".into(), "7700".into()),
            ]
        );
        // The same edit from scratch gives the same values.
        let mut sheets = launch_budget();
        for c in sheets[0].cells.iter_mut() {
            if c.0 == "b2" && c.1 == "x1" {
                c.2 = "100".into();
            }
        }
        let mut a = book.values();
        let mut b = compute(&sheets).unwrap();
        a.sort_by(|x, y| (&x.sheet, &x.row, &x.col).cmp(&(&y.sheet, &y.row, &y.col)));
        b.sort_by(|x, y| (&x.sheet, &x.row, &x.col).cmp(&(&y.sheet, &y.row, &y.col)));
        assert_eq!(a, b);
        // Clearing a cell answers it as empty.
        let cleared = book.set("sb", "b2", "x1", "").unwrap();
        assert!(
            cleared
                .iter()
                .any(|s| s.row == "b2" && s.col == "x1" && s.text.is_empty())
        );
    }
}
