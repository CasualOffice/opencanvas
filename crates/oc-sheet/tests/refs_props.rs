// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! SHEET-02 properties of the A1 ⇄ id converter (ADR-080 §3):
//! - A1 → ids → A1 is the identity on canonical formulas;
//! - inserting a row or column moves exactly the references at or after it by one;
//! - deleting one turns exactly the references that touch it into `#REF!`, and moves the rest;
//! - shifting by (dr, dc) and back is the identity when nothing falls off the grid;
//! - text in string literals is never converted.

use oc_sheet::refs::{
    Axis, End, MemGrid, OPEN, REF_ERR, Ref, col_letters, fmt_ref, sheet_prefix, shift, to_a1,
    to_ids,
};
use proptest::prelude::*;

const ROWS: u32 = 40;
const COLS: u32 = 12;
const SHEETS: [&str; 3] = ["Budget", "Q1 plan", "Amara's"];

fn grid() -> MemGrid {
    MemGrid::new(
        SHEETS
            .iter()
            .enumerate()
            .map(|(k, name)| {
                let rows = (0..ROWS).map(|i| format!("r{k}x{i}")).collect();
                let cols = (0..COLS).map(|i| format!("c{k}x{i}")).collect();
                (format!("s{k}"), name.to_string(), rows, cols)
            })
            .collect(),
    )
}

fn axis(max: u32) -> impl Strategy<Value = Axis> {
    (0..max, any::<bool>()).prop_map(|(index, abs)| Axis { index, abs })
}

#[derive(Clone, Debug)]
enum Kind {
    Cell,
    Col,
    Row,
}

fn reference() -> impl Strategy<Value = Ref> {
    let end = |k: Kind| -> BoxedStrategy<End> {
        match k {
            Kind::Cell => (axis(COLS), axis(ROWS))
                .prop_map(|(col, row)| End::Cell { col, row })
                .boxed(),
            Kind::Col => axis(COLS).prop_map(End::Col).boxed(),
            Kind::Row => axis(ROWS).prop_map(End::Row).boxed(),
        }
    };
    let sheet = prop_oneof![
        Just(None),
        (0..SHEETS.len()).prop_map(|i| Some(SHEETS[i].to_string()))
    ];
    let shape = prop_oneof![
        (end(Kind::Cell), Just(None::<End>)).boxed(),
        (end(Kind::Cell), end(Kind::Cell).prop_map(Some)).boxed(),
        (end(Kind::Col), end(Kind::Col).prop_map(Some)).boxed(),
        (end(Kind::Row), end(Kind::Row).prop_map(Some)).boxed(),
    ];
    (sheet, shape).prop_map(|(sheet, (a, b))| Ref { sheet, a, b })
}

/// A formula: references joined by operators, inside functions and next to string literals that
/// look like references.
fn formula() -> impl Strategy<Value = (String, Vec<Ref>)> {
    let part = prop_oneof![
        reference().prop_map(|r| (fmt_ref(&r), Some(r))),
        Just(("\"A1\"".to_string(), None)),
        Just(("\"B2:C3 and \"\"$D$4\"\"\"".to_string(), None)),
        Just(("LOG10(2)".to_string(), None)),
        Just(("3.5".to_string(), None)),
    ];
    (
        prop::collection::vec(part, 1..6),
        prop::collection::vec(prop_oneof![Just("+"), Just("*"), Just("&"), Just(",")], 6),
    )
        .prop_map(|(parts, ops)| {
            let mut s = String::from("=SUM(");
            let mut refs = Vec::new();
            for (i, (text, r)) in parts.into_iter().enumerate() {
                if i > 0 {
                    s.push_str(ops[i % ops.len()]);
                }
                s.push_str(&text);
                refs.extend(r);
            }
            s.push(')');
            (s, refs)
        })
}

/// The expected A1 after a change, built from the structured references.
fn rebuild(src: &str, refs: &[Ref], map: impl Fn(&Ref) -> Option<Ref>) -> String {
    let mut out = src.to_string();
    // Replace each reference's text in order, scanning forward past what was replaced.
    let mut at = 0;
    for r in refs {
        let old = fmt_ref(r);
        let i = at + out[at..].find(&old).expect("reference in the formula");
        let new = map(r)
            .map(|n| fmt_ref(&n))
            .unwrap_or_else(|| REF_ERR.to_string());
        out.replace_range(i..i + old.len(), &new);
        at = i + new.len();
    }
    out
}

fn sheet_index(r: &Ref) -> usize {
    r.sheet
        .as_deref()
        .map_or(0, |n| SHEETS.iter().position(|s| *s == n).unwrap())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, .. ProptestConfig::default() })]

    #[test]
    fn a1_to_ids_and_back_is_the_identity((src, refs) in formula()) {
        let g = grid();
        let stored = to_ids(&src, "s0", &g);
        prop_assert_eq!(stored.matches(OPEN).count(), refs.len(), "one token per reference: {}", stored);
        prop_assert!(!stored.contains("\"A1\"") || src.contains("\"A1\""));
        prop_assert_eq!(to_a1(&stored, "s0", &g), src);
    }

    #[test]
    fn inserting_a_row_moves_exactly_the_references_at_or_after_it((src, refs) in formula(), sheet in 0..SHEETS.len(), at in 0..ROWS) {
        let mut g = grid();
        let stored = to_ids(&src, "s0", &g);
        g.edit(|s| s[sheet].2.insert(at as usize, "inserted".into()));
        let bump = |a: Axis| Axis { index: if a.index >= at { a.index + 1 } else { a.index }, ..a };
        let expected = rebuild(&src, &refs, |r| {
            if sheet_index(r) != sheet { return Some(r.clone()); }
            let mv = |e: &End| match *e {
                End::Cell { col, row } => End::Cell { col, row: bump(row) },
                End::Row(row) => End::Row(bump(row)),
                c @ End::Col(_) => c,
            };
            Some(Ref { sheet: r.sheet.clone(), a: mv(&r.a), b: r.b.as_ref().map(mv) })
        });
        prop_assert_eq!(to_a1(&stored, "s0", &g), expected);
    }

    #[test]
    fn deleting_a_column_breaks_exactly_the_references_to_it((src, refs) in formula(), sheet in 0..SHEETS.len(), at in 0..COLS) {
        let mut g = grid();
        let stored = to_ids(&src, "s0", &g);
        g.edit(|s| { s[sheet].3.remove(at as usize); });
        let expected = rebuild(&src, &refs, |r| {
            if sheet_index(r) != sheet { return Some(r.clone()); }
            let mv = |e: &End| -> Option<End> {
                let c = |a: Axis| -> Option<Axis> {
                    if a.index == at { None } else { Some(Axis { index: if a.index > at { a.index - 1 } else { a.index }, ..a }) }
                };
                Some(match *e {
                    End::Cell { col, row } => End::Cell { col: c(col)?, row },
                    End::Col(col) => End::Col(c(col)?),
                    r @ End::Row(_) => r,
                })
            };
            Some(Ref { sheet: r.sheet.clone(), a: mv(&r.a)?, b: match &r.b { Some(b) => Some(mv(b)?), None => None } })
        });
        prop_assert_eq!(to_a1(&stored, "s0", &g), expected);
    }

    #[test]
    fn shifting_there_and_back_is_the_identity((src, _refs) in formula(), dr in -5i64..5, dc in -5i64..5) {
        let there = shift(&src, dr, dc);
        prop_assume!(!there.contains(REF_ERR));
        prop_assert_eq!(shift(&there, -dr, -dc), src);
    }

    #[test]
    fn plain_text_is_never_changed(s in "[A-Z0-9 :$!'\"]{0,30}") {
        let g = grid();
        prop_assert_eq!(to_ids(&s, "s0", &g), s.clone());
        prop_assert_eq!(shift(&s, 1, 1), s);
    }
}

#[test]
fn generator_names_are_canonical() {
    assert_eq!(sheet_prefix("Q1 plan"), "'Q1 plan'!");
    assert_eq!(col_letters(COLS - 1), "L");
}
