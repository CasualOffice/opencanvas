// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Which formula cells read which cells, so that an edit reads back only the cells it can have
//! changed (SHEET-08) instead of every cell of the block.
//!
//! The edges are opencalc's own (`precedents_of`, the walk its recalculation follows). A formula
//! whose precedents cannot be read off the expression (a volatile function, `INDIRECT`,
//! `OFFSET`, a name, an open range such as `B:B`, a 3-D reference, unreadable text) is read on
//! every edit, and so is everything that depends on it: conservative, never stale. Spilled
//! arrays are handled by the caller (it reads everything while one exists).

use std::collections::{BTreeSet, HashMap, HashSet};

use casual_calc_formula::Expr;
use casual_calc_model::{CellRef, Workbook};

/// `(sheet index, row, column)`.
pub(crate) type Key = (usize, u32, u32);
/// `(sheet index, r0, c0, r1, c1)`, inclusive.
type Block = (usize, u32, u32, u32, u32);

/// Rows per bucket of the range index.
const BAND: u32 = 256;
/// Ranges over more bands than this are not bucketed but always checked.
const MAX_BANDS: u32 = 8;

#[derive(Debug, Default)]
pub(crate) struct Deps {
    /// A cell → the formula cells that read it as a single cell.
    direct: HashMap<Key, Vec<Key>>,
    /// A formula cell → what it reads (to take its edges out again).
    reads: HashMap<Key, Vec<Block>>,
    /// `(sheet, band)` → formula cells reading a range over rows of that band.
    bands: HashMap<(usize, u32), Vec<Key>>,
    /// Formula cells reading a range too tall to bucket.
    tall: Vec<Key>,
    /// Formula cells whose precedents the walk cannot see: read on every edit.
    always: BTreeSet<Key>,
}

impl Deps {
    /// The edges of every formula cell in `cells`.
    pub(crate) fn build(wb: &Workbook, cells: impl Iterator<Item = Key>) -> Self {
        let mut d = Deps::default();
        for k in cells {
            d.add(wb, k);
        }
        d
    }

    /// Takes `cell`'s old edges out and puts its current ones in (after its input changed).
    pub(crate) fn repoint(&mut self, wb: &Workbook, cell: Key) {
        self.remove(cell);
        self.add(wb, cell);
    }

    fn add(&mut self, wb: &Workbook, cell: Key) {
        let at = CellRef {
            row: cell.1,
            col: cell.2,
        };
        let Some(expr) = wb
            .sheets
            .get(cell.0)
            .and_then(|s| s.cells.get(at))
            .and_then(|c| c.formula)
            .and_then(|h| wb.formula(h))
        else {
            return;
        };
        if !plain(expr, wb) {
            self.always.insert(cell);
        }
        let blocks = casual_calc_eval::precedents_of(wb, cell.0, at);
        for &(s, r0, c0, r1, c1) in &blocks {
            if r0 == r1 && c0 == c1 {
                self.direct.entry((s, r0, c0)).or_default().push(cell);
            } else if let Some(bands) = bands(r0, r1) {
                for b in bands {
                    self.bands.entry((s, b)).or_default().push(cell);
                }
            } else {
                self.tall.push(cell);
            }
        }
        if !blocks.is_empty() {
            self.reads.insert(cell, blocks);
        }
    }

    fn remove(&mut self, cell: Key) {
        self.always.remove(&cell);
        let Some(blocks) = self.reads.remove(&cell) else {
            return;
        };
        for (s, r0, c0, r1, c1) in blocks {
            if r0 == r1 && c0 == c1 {
                if let Some(v) = self.direct.get_mut(&(s, r0, c0)) {
                    v.retain(|&d| d != cell);
                }
            } else if let Some(bands) = bands(r0, r1) {
                for b in bands {
                    if let Some(v) = self.bands.get_mut(&(s, b)) {
                        v.retain(|&d| d != cell);
                    }
                }
            } else {
                self.tall.retain(|&d| d != cell);
            }
        }
    }

    /// `changed`, the cells always read, and every formula cell that reads any of them,
    /// transitively.
    pub(crate) fn affected(&self, changed: &[Key]) -> HashSet<Key> {
        let mut out: HashSet<Key> = HashSet::new();
        let mut work: Vec<Key> = Vec::new();
        for &k in changed.iter().chain(self.always.iter()) {
            if out.insert(k) {
                work.push(k);
            }
        }
        while let Some(x) = work.pop() {
            if let Some(ds) = self.direct.get(&x) {
                for &d in ds {
                    if out.insert(d) {
                        work.push(d);
                    }
                }
            }
            let bucket = self
                .bands
                .get(&(x.0, x.1 / BAND))
                .map_or(&[][..], Vec::as_slice);
            for &d in bucket.iter().chain(self.tall.iter()) {
                if out.contains(&d) {
                    continue;
                }
                let covers = self.reads.get(&d).is_some_and(|bs| {
                    bs.iter().any(|&(s, r0, c0, r1, c1)| {
                        s == x.0 && (r0..=r1).contains(&x.1) && (c0..=c1).contains(&x.2)
                    })
                });
                if covers {
                    out.insert(d);
                    work.push(d);
                }
            }
        }
        out
    }
}

fn bands(r0: u32, r1: u32) -> Option<std::ops::RangeInclusive<u32>> {
    let (lo, hi) = (r0 / BAND, r1 / BAND);
    (hi - lo < MAX_BANDS).then_some(lo..=hi)
}

/// Whether every precedent of `e` is a cell or a closed range the walk sees (the same cases
/// opencalc's recalculation treats as "depends on anything").
fn plain(e: &Expr, wb: &Workbook) -> bool {
    match e {
        Expr::Number(_)
        | Expr::Bool(_)
        | Expr::Text(_)
        | Expr::Error(_)
        | Expr::Empty
        | Expr::Array(_)
        | Expr::Reference(_) => true,
        Expr::Range(a, b) => {
            !(a.row_implicit || b.row_implicit || a.col_implicit || b.col_implicit)
        }
        Expr::Unary { operand, .. } => plain(operand, wb),
        Expr::Binary { left, right, .. } => plain(left, wb) && plain(right, wb),
        Expr::Function { name, args } => {
            !matches!(
                name.as_str(),
                "TODAY" | "NOW" | "RAND" | "RANDBETWEEN" | "RANDARRAY" | "INDIRECT" | "OFFSET"
            ) && wb.custom.spec(name).is_none()
                && args.iter().all(|a| plain(a, wb))
        }
        // Names, 3-D and structured references, calls of a computed function, unreadable text.
        _ => false,
    }
}
