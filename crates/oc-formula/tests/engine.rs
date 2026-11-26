// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Unit tests for the formula engine (ADR-078): syntax, types, values, errors, limits,
//! the dependency graph, relations and rollups.

use oc_formula::{ErrCode, Ty, Value, check, compute, eval, normalize, rename_prop};
use serde_json::{Value as J, json};

fn schema(name: &str) -> Option<Ty> {
    match name {
        "Price" | "Qty" => Some(Ty::Num),
        "Name" | "Status" => Some(Ty::Text),
        "Done" => Some(Ty::Bool),
        "Due" => Some(Ty::Date),
        "Tags" => Some(Ty::List),
        _ => None,
    }
}

fn row(name: &str) -> Value {
    match name {
        "Price" => Value::Num(12.5),
        "Qty" => Value::Num(4.0),
        "Name" => Value::Text("Venue".into()),
        "Status" => Value::Empty,
        "Done" => Value::Bool(true),
        "Due" => Value::Date(oc_formula::date::parse("2026-12-15").unwrap()),
        "Tags" => Value::List(vec![Value::Text("a".into()), Value::Text("b".into())]),
        _ => Value::Err(ErrCode::Ref, format!("No field named “{name}”")),
    }
}

const TODAY: i64 = 20_783; // 2026-11-26

fn ev(src: &str) -> Value {
    eval(src, &row, TODAY)
}

fn err(src: &str) -> ErrCode {
    match ev(src) {
        Value::Err(c, _) => c,
        v => panic!("{src}: expected an error, got {v:?}"),
    }
}

#[test]
fn spreadsheet_syntax_with_prop_and_operators() {
    assert_eq!(ev(r#"prop("Price") * prop("Qty")"#), Value::Num(50.0));
    assert_eq!(
        ev(r#"prop("Name") & " (" & prop("Qty") & ")""#),
        Value::Text("Venue (4)".into())
    );
    assert_eq!(ev("1 + 2 * 3 - 4 / 2"), Value::Num(5.0));
    assert_eq!(ev("-(2 + 3)"), Value::Num(-5.0));
    assert_eq!(
        ev(r#"IF(prop("Qty") > 3, "many", "few")"#),
        Value::Text("many".into())
    );
    assert_eq!(ev("3 <> 4"), Value::Bool(true));
    assert_eq!(ev(r#""a""b""#), Value::Text("a\"b".into()));
}

#[test]
fn function_names_in_any_case_normalised_to_upper_case() {
    assert_eq!(ev(r#"round(prop("Price") / 3, 2)"#), Value::Num(4.17));
    assert_eq!(
        normalize(r#"round( prop("Price") , 1) & if(true, "x", "y")"#),
        r#"ROUND( prop("Price") , 1) & IF(TRUE, "x", "y")"#
    );
    // prop stays lower case, as in the prototype; text inside strings is untouched.
    assert_eq!(normalize(r#"Prop("sum(x)")"#), r#"prop("sum(x)")"#);
}

#[test]
fn types_are_inferred_and_checked_at_edit_time_with_a_position() {
    assert_eq!(
        check(r#"prop("Price") * prop("Qty")"#, &schema),
        Ok(Ty::Num)
    );
    assert_eq!(check(r#"prop("Name") & 1"#, &schema), Ok(Ty::Text));
    assert_eq!(
        check(r#"DATEADD(prop("Due"), 7, "days")"#, &schema),
        Ok(Ty::Date)
    );
    let e = check(r#"IF(prop("Done"), 1, "no")"#, &schema).unwrap_err();
    assert_eq!(e.code, ErrCode::Type);
    assert!(
        e.msg.contains("number") && e.msg.contains("text"),
        "{}",
        e.msg
    );
    let e = check(r#"1 + prop("Name")"#, &schema).unwrap_err();
    assert_eq!((e.code, e.pos), (ErrCode::Type, 4));
    let e = check(r#"prop("Nope") + 1"#, &schema).unwrap_err();
    assert_eq!((e.code, e.pos), (ErrCode::Ref, 0));
    assert!(e.msg.contains("Nope"));
    let e = check("FOO(1)", &schema).unwrap_err();
    assert_eq!(e.code, ErrCode::Ref);
    let e = check("1 +", &schema).unwrap_err();
    assert_eq!((e.code, e.pos), (ErrCode::Type, 3));
}

#[test]
fn errors_are_values() {
    assert_eq!(err("1 / 0"), ErrCode::Div0);
    assert_eq!(err(r#"prop("Missing") + 1"#), ErrCode::Ref);
    assert_eq!(err(r#"VALUE("abc")"#), ErrCode::Type);
    // Errors propagate through operators, IFERROR catches them.
    assert_eq!(err("(1 / 0) + 2"), ErrCode::Div0);
    assert_eq!(ev(r#"IFERROR(1 / 0, -1)"#), Value::Num(-1.0));
    assert_eq!(ev("ISBLANK(prop(\"Status\"))"), Value::Bool(true));
}

#[test]
fn limits_give_limit_errors() {
    let long = format!("1{}", " + 1".repeat(1100));
    assert_eq!(err(&long), ErrCode::Limit);
    let deep = format!("{}1{}", "(".repeat(70), ")".repeat(70));
    assert_eq!(err(&deep), ErrCode::Limit);
    // A step budget per cell: big list functions count each element.
    let huge = |_: &str| Value::List(vec![Value::Num(1.0); 50_000]);
    match eval(r#"SUM(prop("L")) + SUM(prop("L"))"#, &huge, TODAY) {
        Value::Err(ErrCode::Limit, _) => {}
        v => panic!("expected #LIMIT, got {v:?}"),
    }
    assert_eq!(
        eval(
            r#"SUM(prop("L"))"#,
            &|_: &str| Value::List(vec![Value::Num(1.0); 5_000]),
            TODAY
        ),
        Value::Num(5000.0)
    );
}

#[test]
fn dates_durations_and_lists() {
    assert_eq!(
        ev(r#"DATEADD(prop("Due"), 1, "months")"#),
        Value::Date(oc_formula::date::parse("2027-01-15").unwrap())
    );
    assert_eq!(
        ev(r#"DATEDIFF(TODAY(), prop("Due"), "days")"#),
        Value::Num(19.0)
    );
    assert_eq!(ev(r#"prop("Due") - TODAY()"#), Value::Num(19.0));
    assert_eq!(
        ev(r#"TEXT(DATE(2026, 2, 31))"#),
        Value::Text("2026-03-03".into())
    );
    assert_eq!(ev(r#"COUNT(prop("Tags"))"#), Value::Num(2.0));
    assert_eq!(ev(r#"JOIN(prop("Tags"), "+")"#), Value::Text("a+b".into()));
    assert_eq!(
        ev(r#"SUM(1, 2, 3) + MAX(4, 9) + MIN(2, 5)"#),
        Value::Num(17.0)
    );
    assert_eq!(ev(r#"0.1 + 0.2 & """#), Value::Text("0.3".into()));
}

#[test]
fn rename_rewrites_prop_references() {
    assert_eq!(
        rename_prop(r#"prop("Qty") * PROP("Qty")"#, "Qty", "Count"),
        r#"prop("Count") * prop("Count")"#
    );
}

fn fields() -> J {
    json!([
        {"id": "t", "name": "Item", "type": "title"},
        {"id": "p", "name": "Price", "type": "number"},
        {"id": "q", "name": "Qty", "type": "number"},
        {"id": "tot", "name": "Total", "type": "formula", "formula": "prop(\"Price\") * prop(\"Qty\")"},
        {"id": "big", "name": "Big", "type": "formula", "formula": "prop(\"Total\") > 100"},
        {"id": "a", "name": "A", "type": "formula", "formula": "prop(\"C\") + 1"},
        {"id": "b", "name": "B", "type": "formula", "formula": "prop(\"A\") + 1"},
        {"id": "c", "name": "C", "type": "formula", "formula": "prop(\"B\") + 1"},
        {"id": "r", "name": "Tasks", "type": "relation", "rel": {"db": "tasks"}},
        {"id": "n", "name": "Open", "type": "rollup", "roll": {"rel": "r", "fn": "count"}},
        {"id": "s", "name": "Hours", "type": "rollup", "roll": {"rel": "r", "f": "h", "fn": "sum"}},
        {"id": "pc", "name": "Done %", "type": "rollup", "roll": {"rel": "r", "f": "d", "fn": "percent"}},
        {"id": "e", "name": "First", "type": "rollup", "roll": {"rel": "r", "f": "due", "fn": "earliest"}},
        {"id": "l", "name": "Last", "type": "rollup", "roll": {"rel": "r", "f": "due", "fn": "latest"}},
        {"id": "x", "name": "Names", "type": "formula", "formula": "JOIN(prop(\"Tasks\"), \", \") & \" \" & prop(\"Hours\")"}
    ])
}

fn input(rows: J) -> J {
    json!({
        "today": "2026-11-26",
        "fields": fields(),
        "rows": rows,
        "related": {"tasks": {
            "fields": [{"id": "tt", "name": "Task", "type": "title"}, {"id": "h", "name": "Hours", "type": "number"},
                       {"id": "d", "name": "Done", "type": "checkbox"}, {"id": "due", "name": "Due", "type": "date"}],
            "rows": [
                {"id": "k1", "v": {"tt": "Book", "h": 2, "d": true, "due": "2026-12-03"}},
                {"id": "k2", "v": {"tt": "Pay", "h": 3.5, "d": false, "due": "2026-12-01"}}
            ]
        }}
    })
}

#[test]
fn compute_follows_the_dependency_graph() {
    let out = compute(&input(
        json!([{"id": "r1", "v": {"t": "Venue", "p": 40, "q": 3, "r": ["k1", "k2", "gone"]}}]),
    ));
    let r = &out["rows"]["r1"];
    assert_eq!(r["tot"], json!(120.0));
    assert_eq!(r["big"], json!(true));
    assert_eq!(out["fields"]["tot"]["type"], "number");
    assert_eq!(out["fields"]["big"]["type"], "boolean");
    assert_eq!(r["n"], json!(2.0));
    assert_eq!(r["s"], json!(5.5));
    assert_eq!(r["pc"], json!(50.0));
    assert_eq!(r["e"], json!("2026-12-01"));
    assert_eq!(r["l"], json!("2026-12-03"));
    assert_eq!(r["x"], json!("Book, Pay 5.5"));
}

#[test]
fn a_three_field_cycle_is_cycle_and_recovers() {
    let out = compute(&input(json!([{"id": "r1", "v": {}}])));
    for f in ["a", "b", "c"] {
        assert_eq!(out["fields"][f]["error"]["code"], "#CYCLE", "{f}");
        assert_eq!(out["rows"]["r1"][f]["err"], "#CYCLE");
    }
    // Break the cycle: C no longer refers to B.
    let mut inp = input(json!([{"id": "r1", "v": {}}]));
    inp["fields"][7]["formula"] = json!("10");
    let out = compute(&inp);
    assert_eq!(out["rows"]["r1"]["c"], json!(10.0));
    assert_eq!(out["rows"]["r1"]["a"], json!(11.0));
    assert_eq!(out["rows"]["r1"]["b"], json!(12.0));
}

#[test]
fn rollups_with_no_related_rows_are_empty_not_zero() {
    let out = compute(&input(json!([{"id": "r1", "v": {"r": []}}])));
    for f in ["n", "s", "pc", "e", "l"] {
        assert_eq!(out["rows"]["r1"][f], J::Null, "{f}");
    }
}

#[test]
fn a_target_without_access_gives_no_access() {
    let mut inp = input(json!([{"id": "r1", "v": {"r": ["k1"]}}]));
    inp["related"]["tasks"] = json!({"noAccess": true});
    let out = compute(&inp);
    assert_eq!(out["rows"]["r1"]["n"]["err"], "#REF");
    assert_eq!(out["rows"]["r1"]["n"]["msg"], "No access");
}
