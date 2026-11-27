// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! One 100,000-row sheet (SHEET-08): the time to open it (build the workbook from the block's
//! ids and compute every cell) and the time one edit takes to recompute. Release build only:
//!
//! ```sh
//! cargo test --release -p oc-sheet --test bench_100k -- --ignored --nocapture
//! ```
//!
//! The sheet: A = n, B = `=A{n}*2` on every row, and C1 = `=SUM(B1:B100000)` (200,001 cells).
//! The edit sets A50000, which changes B50000 and C1.

use std::time::Instant;

use oc_sheet::engine::{Book, BookSheet, grid_of};
use oc_sheet::refs;

const ROWS: usize = 100_000;

fn sheet() -> BookSheet {
    let mut s = BookSheet {
        id: "s".into(),
        name: "Big".into(),
        rows: (0..ROWS).map(|i| format!("r{i}")).collect(),
        cols: (0..26).map(|i| format!("c{i}")).collect(),
        cells: Vec::with_capacity(2 * ROWS + 1),
    };
    let grid = grid_of(std::slice::from_ref(&s));
    for i in 0..ROWS {
        let r = s.rows[i].clone();
        s.cells.push((r.clone(), "c0".into(), i.to_string()));
        let f = refs::to_ids(&format!("=A{}*2", i + 1), "s", &grid);
        s.cells.push((r, "c1".into(), f));
    }
    let total = refs::to_ids(&format!("=SUM(B1:B{ROWS})"), "s", &grid);
    s.cells.push(("r0".into(), "c2".into(), total));
    s
}

#[test]
#[ignore = "bench: run in release with --ignored"]
fn one_hundred_thousand_rows() {
    let s = sheet();
    let t = Instant::now();
    let mut book = Book::open(vec![s]).unwrap();
    let open = t.elapsed();
    let sum: u64 = (0..ROWS as u64).map(|n| n * 2).sum();
    let shown = |b: &Book, r: &str, c: &str| {
        b.values()
            .into_iter()
            .find(|v| v.row == r && v.col == c)
            .map(|v| v.text)
            .unwrap_or_default()
    };
    assert_eq!(shown(&book, "r0", "c2"), sum.to_string());

    let t = Instant::now();
    let changed = book.set("s", "r49999", "c0", "1000000").unwrap();
    let edit = t.elapsed();
    let mut got: Vec<(String, String, String)> = changed
        .into_iter()
        .map(|v| (v.row, v.col, v.text))
        .collect();
    got.sort();
    let after = sum - 49_999 * 2 + 2_000_000;
    assert_eq!(
        got,
        vec![
            ("r0".into(), "c2".into(), after.to_string()),
            ("r49999".into(), "c0".into(), "1000000".into()),
            ("r49999".into(), "c1".into(), "2000000".into()),
        ]
    );
    println!(
        "bench_100k: rows={ROWS} cells={} open_ms={} edit_ms={}",
        2 * ROWS + 1,
        open.as_millis(),
        edit.as_millis()
    );
    // Budgets (SHEET-08): far above the measured numbers, far below linear lookups'.
    assert!(open.as_secs() < 30, "open took {open:?}");
    assert!(edit.as_secs() < 3, "one edit took {edit:?}");
}
