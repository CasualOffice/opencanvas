// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! A formula the server cannot afford (SEC-64): one `MMULT` of two 1000 x 1000 arrays is a
//! billion multiplications, about 17 s of one core in a release build, and the server computes
//! Spreadsheet blocks in every save (`search.json`), export and API read. The server stops
//! waiting after [`oc_sheet::engine::COMPUTE_BUDGET`], shows the inputs as typed, and does not
//! start the same block again.

use std::time::{Duration, Instant};

use serde_json::json;

#[test]
fn a_formula_too_costly_to_compute_falls_back_to_the_inputs_in_bounded_time() {
    let costly = "=MMULT(SEQUENCE(1000,1000),SEQUENCE(1000,1000))";
    let block = json!({"order": ["s"], "styles": {}, "sheets": {"s": {
        "name": "S", "rows": ["a", "b"], "cols": ["x", "y"],
        "cells": {"a:x": {"in": costly}, "a:y": {"in": costly}, "b:x": {"in": "=1+1"}}}}});
    let t = Instant::now();
    let tables = oc_sheet::block::tables(&block);
    let first = t.elapsed();
    assert!(
        first < oc_sheet::engine::COMPUTE_BUDGET + Duration::from_secs(3),
        "computing took {first:?}"
    );
    // The inputs as typed, not a value nobody waited for.
    assert_eq!(tables[0].rows[0][0], costly, "{:?}", tables[0].rows);
    // The same block again: known to be too costly, not started a second time.
    let t = Instant::now();
    oc_sheet::block::tables(&block);
    assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
    // A cheap block still computes.
    let cheap = json!({"order": ["s"], "styles": {}, "sheets": {"s": {
        "name": "S", "rows": ["a"], "cols": ["x"], "cells": {"a:x": {"in": "=1+1"}}}}});
    assert_eq!(oc_sheet::block::tables(&cheap)[0].rows[0][0], "2");
}
