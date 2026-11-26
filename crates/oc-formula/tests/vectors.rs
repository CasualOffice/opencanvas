// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The shared test vectors (DB-A1): `tests/vectors.json` holds ≥ 500 formulas and their
//! expected values. This test checks the native engine against it; the editor's vitest
//! (`web/packages/database/src/formula/engine.test.ts`) checks the WASM build against the same
//! file. `OC_FORMULA_BLESS=1` regenerates the file (review the diff).

use serde_json::{Value as J, json};

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors.json");

const HAND: &[&str] = &[
    r#"prop("Price") * prop("Qty")"#,
    r#"prop("Name") & " x" & prop("Qty")"#,
    "1 / 0",
    r#"prop("Missing")"#,
    r#"IF(prop("Done"), "yes", "no")"#,
    r#"if(prop("Qty") > 2, 1, 2)"#,
    r#"ROUND(prop("Price") / 3, 2)"#,
    r#"DATEADD(prop("Due"), 1, "months")"#,
    r#"DATEDIFF(TODAY(), prop("Due"), "weeks")"#,
    r#"prop("Due") - TODAY()"#,
    r#"JOIN(prop("Tags"), "/")"#,
    r#"COUNT(prop("Tags"))"#,
    r#"LEN(prop("Name"))"#,
    r#"UPPER(prop("Name"))"#,
    r#"VALUE("12.5") + 1"#,
    r#"VALUE("x")"#,
    r#"SQRT(-1)"#,
    r#"MOD(-7, 3)"#,
    r#"POWER(2, 10)"#,
    "0.1 + 0.2",
    r#"TEXT(0.1 + 0.2)"#,
    r#"ISBLANK(prop("Note"))"#,
    r#"IFERROR(1/0, "none")"#,
    r#"AND(TRUE, prop("Done"))"#,
    r#"OR(FALSE, NOT(prop("Done")))"#,
    r#"CONTAINS(prop("Name"), "ven")"#,
    r#"CONTAINS(prop("Tags"), "B")"#,
    r#"LEFT(prop("Name"), 2) & RIGHT(prop("Name"), 2)"#,
    r#"TRIM("  a  ")"#,
    r#"CONCAT(1, TRUE, "x", prop("Due"))"#,
    r#"YEAR(prop("Due")) * 10000 + MONTH(prop("Due")) * 100 + DAY(prop("Due"))"#,
    r#"WEEKDAY(prop("Due"))"#,
    r#"DATE(2024, 2, 29) + 365"#,
    r#"DATE(2026, 13, 1)"#,
    r#"AVERAGE(1, 2, 3, prop("Tags"))"#,
    r#"AVERAGE(prop("Tags"))"#,
    r#"MIN(prop("Tags"))"#,
    r#"MAX(3, prop("Qty"), 1)"#,
    r#"SUM(prop("Price"), prop("Qty"), prop("Note"))"#,
    r#"prop("Note") + 1"#,
    r#"prop("Note") & "!""#,
    r#"-prop("Price")"#,
    r#"1 = 1.0"#,
    r#""a" = "A""#,
    r#""a" < "b""#,
    r#"prop("Due") > TODAY()"#,
    r#"1e3 + .5"#,
    r#"1 + "a""#,
    r#""a" * 2"#,
    r#"DATEADD(prop("Due"), 1, "fortnights")"#,
    r#"DATEDIFF(prop("Due"), DATE(2027, 3, 14), "months")"#,
    r#"DATEDIFF(DATE(2020,2,29), DATE(2026,2,28), "years")"#,
    r#"FLOOR(-2.5) & "," & CEILING(-2.5) & "," & ABS(-2.5)"#,
    r#"ROUND(1234.5678, -2)"#,
    r#"POWER(10, 400)"#,
    "FOO(1)",
    "x + 1",
    "(1 + 2",
    "1 +",
    "",
    r#"prop(1)"#,
    r#"Prop("Qty") * 2"#,
    r#"true & false"#,
    "1 <> 2 = TRUE",
    r#"IF(prop("Qty") = 0, empty, prop("Qty"))"#,
    r#"prop("Due") - now()"#,
    r#"ISBLANK(EMPTY)"#,
];

/// A small deterministic generator (xorshift) so the vector set is stable and reviewable.
struct Gen(u64);
impl Gen {
    fn n(&mut self, k: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % k
    }
    fn num(&mut self, d: u32) -> String {
        let leaves = [
            r#"prop("Price")"#,
            r#"prop("Qty")"#,
            r#"prop("Note")"#,
            "0",
            "1",
            "2.5",
            "7",
            "-3",
            "100",
        ];
        if d == 0 || self.n(3) == 0 {
            return leaves[self.n(leaves.len() as u64) as usize].into();
        }
        match self.n(6) {
            0 => format!(
                "({} {} {})",
                self.num(d - 1),
                ["+", "-", "*", "/"][self.n(4) as usize],
                self.num(d - 1)
            ),
            1 => format!("ROUND({}, {})", self.num(d - 1), self.n(3)),
            2 => format!(
                "IF({}, {}, {})",
                self.boolean(d - 1),
                self.num(d - 1),
                self.num(d - 1)
            ),
            3 => format!(
                "{}({}, {})",
                ["SUM", "MIN", "MAX", "AVERAGE"][self.n(4) as usize],
                self.num(d - 1),
                self.num(d - 1)
            ),
            4 => format!("LEN({})", self.text(d - 1)),
            _ => format!("MOD({}, {})", self.num(d - 1), self.num(d - 1)),
        }
    }
    fn text(&mut self, d: u32) -> String {
        if d == 0 || self.n(3) == 0 {
            return [r#"prop("Name")"#, r#""ab""#, r#""""#, r#"prop("Note")"#][self.n(4) as usize]
                .into();
        }
        match self.n(3) {
            0 => format!("{} & {}", self.text(d - 1), self.num(d - 1)),
            1 => format!("UPPER({})", self.text(d - 1)),
            _ => format!("TEXT({})", self.num(d - 1)),
        }
    }
    fn boolean(&mut self, d: u32) -> String {
        if d == 0 || self.n(3) == 0 {
            return [r#"prop("Done")"#, "TRUE", "false"][self.n(3) as usize].into();
        }
        match self.n(3) {
            0 => format!(
                "{} {} {}",
                self.num(d - 1),
                ["<", ">", "=", "<>", "<=", ">="][self.n(6) as usize],
                self.num(d - 1)
            ),
            1 => format!("AND({}, {})", self.boolean(d - 1), self.boolean(d - 1)),
            _ => format!("NOT({})", self.boolean(d - 1)),
        }
    }
}

fn fixture() -> J {
    let mut g = Gen(0x9E37_79B9_7F4A_7C15);
    let mut cases: Vec<String> = HAND.iter().map(|s| s.to_string()).collect();
    while cases.len() < 560 {
        let src = match g.n(3) {
            0 => g.num(4),
            1 => g.text(3),
            _ => g.boolean(3),
        };
        if !cases.contains(&src) {
            cases.push(src);
        }
    }
    json!({
        "today": "2026-11-26",
        "fields": [
            {"id": "n", "name": "Name", "type": "title"}, {"id": "p", "name": "Price", "type": "number"},
            {"id": "q", "name": "Qty", "type": "number"}, {"id": "d", "name": "Done", "type": "checkbox"},
            {"id": "due", "name": "Due", "type": "date"}, {"id": "t", "name": "Tags", "type": "tags"},
            {"id": "x", "name": "Note", "type": "text"}
        ],
        "row": {"n": "Venue", "p": 12.5, "q": 4, "d": true, "due": "2026-12-15", "t": ["a", "b"]},
        "cases": cases.into_iter().map(|s| json!({"src": s})).collect::<Vec<_>>()
    })
}

#[test]
fn native_engine_matches_the_shared_vectors() {
    let mut fx = fixture();
    let out = oc_formula::run_vectors(&fx);
    for (c, o) in fx["cases"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(out.as_array().unwrap())
    {
        c["out"] = o.clone();
    }
    if std::env::var("OC_FORMULA_BLESS").is_ok() {
        std::fs::write(PATH, serde_json::to_string_pretty(&fx).unwrap() + "\n").unwrap();
    }
    let stored: J = serde_json::from_str(
        &std::fs::read_to_string(PATH).expect("vectors.json; run with OC_FORMULA_BLESS=1"),
    )
    .unwrap();
    assert!(
        stored["cases"].as_array().unwrap().len() >= 500,
        "DB-A1 needs at least 500 vectors"
    );
    assert_eq!(
        stored, fx,
        "vectors.json is out of date with the engine or the generator"
    );
}
