// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `oc-formula` (ADR-078): the one typed formula engine for OpenCanvas databases, native in the
//! server (exports, API, `search.json`) and WASM in the editor (lazy-loaded). Only expressions
//! are stored; values are computed through a dependency graph. Errors are values: `#TYPE`,
//! `#REF`, `#DIV/0`, `#CYCLE`, `#LIMIT`. Limits: 4 KB per formula, depth 64, a step budget per
//! cell. Relations give a formula the related rows' titles; rollups (count, sum, percent,
//! earliest, latest) aggregate a related field and are empty (a dash) when nothing is related.

pub mod check;
pub mod date;
pub mod eval;
pub mod syntax;
#[cfg(target_arch = "wasm32")]
mod wasm;

use serde_json::{Map, Value as J, json};
use std::collections::HashMap;

pub use syntax::{normalize, rename_prop};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrCode {
    Type,
    Ref,
    Div0,
    Cycle,
    Limit,
}

impl ErrCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrCode::Type => "#TYPE",
            ErrCode::Ref => "#REF",
            ErrCode::Div0 => "#DIV/0",
            ErrCode::Cycle => "#CYCLE",
            ErrCode::Limit => "#LIMIT",
        }
    }
}

/// An edit-time error: code, reason, byte offset in the source.
#[derive(Debug, Clone, PartialEq)]
pub struct FormulaError {
    pub code: ErrCode,
    pub msg: String,
    pub pos: usize,
}

/// Static types. `Any` is unknown (an empty value, or a field whose formula is broken).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ty {
    Num,
    Text,
    Bool,
    Date,
    List,
    Any,
}

impl Ty {
    pub fn as_str(self) -> &'static str {
        match self {
            Ty::Num => "number",
            Ty::Text => "text",
            Ty::Bool => "boolean",
            Ty::Date => "date",
            Ty::List => "list",
            Ty::Any => "any",
        }
    }
    pub fn noun(self) -> &'static str {
        match self {
            Ty::Bool => "true/false",
            Ty::Any => "anything",
            t => t.as_str(),
        }
    }
    pub fn article(self) -> String {
        match self {
            Ty::Num => "a number".into(),
            Ty::Date => "a date".into(),
            Ty::List => "a list".into(),
            t => t.noun().into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Num(f64),
    Text(String),
    Bool(bool),
    /// Days since 1970-01-01.
    Date(i64),
    List(Vec<Value>),
    Empty,
    Err(ErrCode, String),
}

impl Value {
    pub fn ty(&self) -> Ty {
        match self {
            Value::Num(_) => Ty::Num,
            Value::Text(_) => Ty::Text,
            Value::Bool(_) => Ty::Bool,
            Value::Date(_) => Ty::Date,
            Value::List(_) => Ty::List,
            Value::Empty | Value::Err(..) => Ty::Any,
        }
    }
    /// JSON as the API and the editor see it: dates `YYYY-MM-DD`, empty `null`,
    /// errors `{err, msg}`.
    pub fn to_json(&self) -> J {
        match self {
            Value::Num(n) => json!(n),
            Value::Text(s) => json!(s),
            Value::Bool(b) => json!(b),
            Value::Date(d) => json!(date::format(*d)),
            Value::List(l) => J::Array(l.iter().map(Value::to_json).collect()),
            Value::Empty => J::Null,
            Value::Err(c, m) => json!({"err": c.as_str(), "msg": m}),
        }
    }
    /// The value as display text (exports, search): errors show their code.
    pub fn text(&self) -> String {
        eval::text_of(self)
    }
}

/// Parses and type-checks `src` against field types by name.
pub fn check(src: &str, schema: &dyn Fn(&str) -> Option<Ty>) -> Result<Ty, FormulaError> {
    check::infer(&syntax::parse(src)?, schema)
}

/// Evaluates `src` for one row; `get` returns a field's value by name (`#REF` when unknown).
pub fn eval(src: &str, get: &dyn Fn(&str) -> Value, today: i64) -> Value {
    match syntax::parse(src) {
        Ok(n) => eval::eval(
            &n,
            &mut eval::Ctx {
                get,
                today,
                steps: 0,
            },
        ),
        Err(e) => Value::Err(e.code, e.msg),
    }
}

/// Built-in functions for autocomplete: `[{name, sig, doc}]`.
pub fn functions() -> J {
    J::Array(
        check::FUNCS
            .iter()
            .map(|f| json!({"name": f.name, "sig": f.sig, "doc": f.doc}))
            .collect(),
    )
}

fn s<'a>(v: &'a J, k: &str) -> &'a str {
    v.get(k).and_then(J::as_str).unwrap_or("")
}

/// Today from the input (`YYYY-MM-DD`), else the system clock (native), else 1970-01-01.
fn today_of(input: &J) -> i64 {
    if let Some(d) = date::parse(s(input, "today")) {
        return d;
    }
    #[cfg(not(target_arch = "wasm32"))]
    if let Ok(t) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        return (t.as_secs() / 86_400) as i64;
    }
    0
}

/// A stored cell as a formula value, by field type.
pub fn cell_value(ty: &str, v: &J, people: &J) -> Value {
    match (ty, v) {
        (_, J::Null) if ty == "checkbox" => Value::Bool(false),
        (_, J::Null) => Value::Empty,
        ("number" | "progress", J::Number(n)) => Value::Num(n.as_f64().unwrap_or(0.0)),
        ("number" | "progress", J::String(t)) => t.trim().parse().map_or(Value::Empty, Value::Num),
        ("checkbox", J::Bool(b)) => Value::Bool(*b),
        ("checkbox", J::String(t)) => Value::Bool(t == "true"),
        ("date", J::String(t)) => date::parse(t).map_or(Value::Empty, Value::Date),
        ("person", J::String(id)) => {
            Value::Text(people.get(id).and_then(J::as_str).unwrap_or(id).to_string())
        }
        (_, J::Array(a)) => Value::List(a.iter().map(|x| cell_value("text", x, people)).collect()),
        (_, J::String(t)) if t.is_empty() => Value::Empty,
        (_, J::String(t)) => Value::Text(t.clone()),
        (_, J::Number(n)) => Value::Num(n.as_f64().unwrap_or(0.0)),
        (_, J::Bool(b)) => Value::Bool(*b),
        (_, J::Object(o)) => o
            .get("v")
            .map_or(Value::Empty, |x| cell_value(ty, x, people)),
    }
}

/// The key under `related` for a relation field: `dbId`, or `fileId/dbId` across canvases.
pub fn rel_key(f: &J) -> String {
    let r = &f["rel"];
    match s(r, "file") {
        "" => s(r, "db").to_string(),
        file => format!("{file}/{}", s(r, "db")),
    }
}

/// The static type of a non-formula field.
fn field_ty(f: &J) -> Ty {
    match s(f, "type") {
        "number" | "progress" => Ty::Num,
        "checkbox" => Ty::Bool,
        "date" => Ty::Date,
        "tags" | "relation" => Ty::List,
        "rollup" => match s(&f["roll"], "fn") {
            "earliest" | "latest" => Ty::Date,
            _ => Ty::Num,
        },
        "formula" => Ty::Any,
        _ => Ty::Text,
    }
}

struct Analysis {
    /// Formula field index → parsed node, or its field-level error.
    nodes: HashMap<usize, Result<syntax::Node, FormulaError>>,
    /// Formula field indexes in evaluation order (dependencies first).
    order: Vec<usize>,
    types: HashMap<usize, Ty>,
}

/// Parses every formula, finds cycles, orders by dependency and infers types.
fn analyse(fields: &[J]) -> Analysis {
    let by_name = |name: &str| fields.iter().position(|f| s(f, "name") == name);
    let formulas: Vec<usize> = (0..fields.len())
        .filter(|&i| s(&fields[i], "type") == "formula")
        .collect();
    let mut nodes: HashMap<usize, Result<syntax::Node, FormulaError>> = formulas
        .iter()
        .map(|&i| (i, syntax::parse(s(&fields[i], "formula"))))
        .collect();
    let deps: HashMap<usize, Vec<usize>> = formulas
        .iter()
        .map(|&i| {
            let mut names = vec![];
            if let Some(Ok(n)) = nodes.get(&i) {
                syntax::props(n, &mut names);
            }
            (
                i,
                names
                    .iter()
                    .filter_map(|n| by_name(n))
                    .filter(|j| formulas.contains(j))
                    .collect(),
            )
        })
        .collect();
    // A field is on a cycle when it reaches itself.
    for &i in &formulas {
        let (mut stack, mut seen) = (deps[&i].clone(), vec![]);
        while let Some(j) = stack.pop() {
            if j == i {
                let names: Vec<&str> = deps[&i].iter().map(|&k| s(&fields[k], "name")).collect();
                nodes.insert(
                    i,
                    Err(FormulaError {
                        code: ErrCode::Cycle,
                        msg: format!("Formula refers to itself through {}", names.join(", ")),
                        pos: 0,
                    }),
                );
                break;
            }
            if !seen.contains(&j) {
                seen.push(j);
                stack.extend(deps[&j].iter().copied());
            }
        }
    }
    let mut order = vec![];
    fn visit(
        i: usize,
        deps: &HashMap<usize, Vec<usize>>,
        order: &mut Vec<usize>,
        mark: &mut Vec<usize>,
    ) {
        if mark.contains(&i) {
            return;
        }
        mark.push(i);
        for &j in &deps[&i] {
            visit(j, deps, order, mark);
        }
        order.push(i);
    }
    let mut mark = vec![];
    for &i in &formulas {
        visit(i, &deps, &mut order, &mut mark);
    }
    let mut types: HashMap<usize, Ty> = HashMap::new();
    for &i in &order {
        let schema = |name: &str| -> Option<Ty> {
            let j = by_name(name)?;
            Some(if s(&fields[j], "type") == "formula" {
                types.get(&j).copied().unwrap_or(Ty::Any)
            } else {
                field_ty(&fields[j])
            })
        };
        let res = match &nodes[&i] {
            Ok(n) => check::infer(n, &schema),
            Err(e) => Err(e.clone()),
        };
        match res {
            Ok(t) => {
                types.insert(i, t);
            }
            Err(e) => {
                nodes.insert(i, Err(e));
            }
        }
    }
    Analysis {
        nodes,
        order,
        types,
    }
}

/// Byte offset → UTF-16 offset (what the editor's text field counts).
fn utf16_pos(src: &str, pos: usize) -> usize {
    src.get(..pos.min(src.len()))
        .map_or(pos, |p| p.encode_utf16().count())
}

fn err_json(e: &FormulaError, src: &str) -> J {
    json!({"code": e.code.as_str(), "msg": e.msg, "pos": utf16_pos(src, e.pos)})
}

fn rows_of(db: &J) -> Vec<&J> {
    db["rows"]
        .as_array()
        .map(|r| r.iter().collect())
        .unwrap_or_default()
}

/// Rollup aggregation over the related values (count ignores them). Empty when nothing relates.
pub fn rollup(func: &str, related: usize, vals: &[Value]) -> Value {
    if related == 0 {
        return Value::Empty;
    }
    let nums = || {
        vals.iter().filter_map(|v| {
            if let Value::Num(n) = v {
                Some(*n)
            } else {
                None
            }
        })
    };
    let dates = || {
        vals.iter().filter_map(|v| {
            if let Value::Date(d) = v {
                Some(*d)
            } else {
                None
            }
        })
    };
    match func {
        "count" => Value::Num(related as f64),
        "sum" => {
            if nums().next().is_none() {
                Value::Empty
            } else {
                Value::Num(nums().sum())
            }
        }
        "percent" => {
            let on = vals
                .iter()
                .filter(|v| matches!(v, Value::Bool(true)))
                .count();
            Value::Num((on as f64 * 1000.0 / related as f64).round() / 10.0)
        }
        "earliest" => dates().min().map_or(Value::Empty, Value::Date),
        "latest" => dates().max().map_or(Value::Empty, Value::Date),
        f => Value::Err(ErrCode::Ref, format!("Unknown rollup “{f}”")),
    }
}

/// Computes every formula and rollup field of a database.
///
/// Input `{today?, fields, rows: [{id, v}], related?: {key: {fields, rows} | {noAccess: true}},
/// people?: {id: name}}`; output `{fields: {fid: {type} | {error: {code, msg, pos}}},
/// rows: {rowId: {fid: value}}}`.
pub fn compute(input: &J) -> J {
    compute_depth(input, 0)
}

fn compute_depth(input: &J, depth: u8) -> J {
    let empty = vec![];
    let fields = input["fields"].as_array().unwrap_or(&empty);
    let people = &input["people"];
    let today = today_of(input);
    let a = analyse(fields);
    let mut fout = Map::new();
    for (&i, n) in &a.nodes {
        let src = s(&fields[i], "formula");
        let v = match n {
            Ok(_) => json!({"type": a.types.get(&i).copied().unwrap_or(Ty::Any).as_str()}),
            Err(e) => json!({"error": err_json(e, src)}),
        };
        fout.insert(s(&fields[i], "id").into(), v);
    }
    // Related databases: title by row id, values by row id, formulas computed one level deep.
    struct Rel<'a> {
        no_access: bool,
        rows: HashMap<&'a str, &'a J>,
        fields: &'a [J],
        computed: J,
    }
    let mut rels: HashMap<String, Rel> = HashMap::new();
    for f in fields.iter().filter(|f| s(f, "type") == "relation") {
        let key = rel_key(f);
        if rels.contains_key(&key) {
            continue;
        }
        let db = &input["related"][&key];
        let rf = db["fields"].as_array().map_or(&[][..], |v| v.as_slice());
        let computed = if depth == 0 && rf.iter().any(|x| s(x, "type") == "formula") {
            let mut sub = db.clone();
            sub["today"] = json!(date::format(today));
            sub.as_object_mut().map(|o| o.remove("related"));
            compute_depth(&sub, depth + 1)
        } else {
            J::Null
        };
        rels.insert(
            key,
            Rel {
                no_access: db["noAccess"].as_bool().unwrap_or(false),
                rows: rows_of(db).into_iter().map(|r| (s(r, "id"), r)).collect(),
                fields: rf,
                computed,
            },
        );
    }
    let rel_value = |rel: &Rel, rid: &str, fid: &str| -> Value {
        let Some(row) = rel.rows.get(rid) else {
            return Value::Empty;
        };
        match rel.fields.iter().find(|f| s(f, "id") == fid) {
            Some(f) if s(f, "type") == "formula" => {
                let c = &rel.computed["rows"][rid][fid];
                match c {
                    J::Object(o) if o.contains_key("err") => {
                        Value::Err(ErrCode::Ref, "Error in the related row".into())
                    }
                    _ => cell_value(
                        match rel.computed["fields"][fid]["type"].as_str() {
                            Some("number") => "number",
                            Some("date") => "date",
                            Some("boolean") => "checkbox",
                            _ => "text",
                        },
                        c,
                        &J::Null,
                    ),
                }
            }
            Some(f) => cell_value(s(f, "type"), &row["v"][fid], &J::Null),
            None => Value::Empty,
        }
    };
    let title_fid = |rel: &Rel| -> String {
        rel.fields
            .iter()
            .find(|f| s(f, "type") == "title")
            .or(rel.fields.first())
            .map(|f| s(f, "id").to_string())
            .unwrap_or_default()
    };
    let field_idx: HashMap<&str, usize> = fields
        .iter()
        .enumerate()
        .map(|(i, f)| (s(f, "name"), i))
        .rev()
        .collect();
    let mut rout = Map::new();
    for row in rows_of(input) {
        let v = &row["v"];
        let mut done: HashMap<usize, Value> = HashMap::new();
        // Raw values, relations (titles) and rollups.
        let base = |i: usize| -> Value {
            let f = &fields[i];
            let fid = s(f, "id");
            match s(f, "type") {
                "relation" => {
                    let Some(rel) = rels.get(&rel_key(f)) else {
                        return Value::Empty;
                    };
                    if rel.no_access {
                        return Value::Err(ErrCode::Ref, "No access".into());
                    }
                    let tf = title_fid(rel);
                    let ids = v[fid].as_array().map_or(&[][..], |a| a.as_slice());
                    Value::List(
                        ids.iter()
                            .filter_map(|id| rel.rows.get(id.as_str().unwrap_or("")))
                            .map(|r| cell_value("text", &r["v"][&tf], &J::Null))
                            .collect(),
                    )
                }
                "rollup" => {
                    let roll = &f["roll"];
                    let Some(relf) = fields
                        .iter()
                        .find(|x| s(x, "id") == s(roll, "rel") && s(x, "type") == "relation")
                    else {
                        return Value::Err(
                            ErrCode::Ref,
                            "The rollup's relation field is gone".into(),
                        );
                    };
                    let Some(rel) = rels.get(&rel_key(relf)) else {
                        return Value::Empty;
                    };
                    if rel.no_access {
                        return Value::Err(ErrCode::Ref, "No access".into());
                    }
                    let ids: Vec<&str> = v[s(relf, "id")]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(J::as_str)
                                .filter(|id| rel.rows.contains_key(id))
                                .collect()
                        })
                        .unwrap_or_default();
                    let vals: Vec<Value> = ids
                        .iter()
                        .map(|id| rel_value(rel, id, s(roll, "f")))
                        .collect();
                    rollup(s(roll, "fn"), ids.len(), &vals)
                }
                t => cell_value(t, &v[fid], people),
            }
        };
        let mut out = Map::new();
        for (i, f) in fields.iter().enumerate() {
            if s(f, "type") == "rollup" {
                let val = base(i);
                out.insert(s(f, "id").into(), val.to_json());
                done.insert(i, val);
            }
        }
        for &i in &a.order {
            let val = match &a.nodes[&i] {
                Err(e) => Value::Err(e.code, e.msg.clone()),
                Ok(n) => {
                    let get = |name: &str| -> Value {
                        match field_idx.get(name) {
                            None => Value::Err(ErrCode::Ref, format!("No field named “{name}”")),
                            Some(&j) => done.get(&j).cloned().unwrap_or_else(|| base(j)),
                        }
                    };
                    eval::eval(
                        n,
                        &mut eval::Ctx {
                            get: &get,
                            today,
                            steps: 0,
                        },
                    )
                }
            };
            out.insert(s(&fields[i], "id").into(), val.to_json());
            done.insert(i, val);
        }
        rout.insert(s(row, "id").into(), J::Object(out));
    }
    json!({"fields": fout, "rows": rout})
}

/// The formula editor's check (prototype 1c): `{fields, id?, formula}` → `{ok, type, error?,
/// normalized}`. The candidate replaces field `id`'s formula (or is a new field), so cycles
/// through it show as `#CYCLE` while typing.
pub fn check_json(input: &J) -> J {
    let src = s(input, "formula");
    let mut fields: Vec<J> = input["fields"].as_array().cloned().unwrap_or_default();
    let id = s(input, "id");
    let idx = match fields
        .iter()
        .position(|f| s(f, "id") == id && !id.is_empty())
    {
        Some(i) => {
            fields[i]["type"] = json!("formula");
            fields[i]["formula"] = json!(src);
            i
        }
        None => {
            fields.push(
                json!({"id": "\u{0}new", "name": "\u{0}new", "type": "formula", "formula": src}),
            );
            fields.len() - 1
        }
    };
    let a = analyse(&fields);
    let normalized = normalize(src);
    match &a.nodes[&idx] {
        Ok(_) => json!({"ok": true, "type": a.types[&idx].as_str(), "normalized": normalized}),
        Err(e) => json!({"ok": false, "error": err_json(e, src), "normalized": normalized}),
    }
}

/// Runs the shared test vectors (`tests/vectors.json`): every case evaluated against the
/// fixture row; the same function runs natively and in WASM (DB-A1).
pub fn run_vectors(v: &J) -> J {
    let fields = v["fields"].as_array().map_or(&[][..], |f| f.as_slice());
    let row = &v["row"];
    let today = today_of(v);
    let get = |name: &str| -> Value {
        match fields.iter().find(|f| s(f, "name") == name) {
            Some(f) => cell_value(s(f, "type"), &row[s(f, "id")], &J::Null),
            None => Value::Err(ErrCode::Ref, format!("No field named “{name}”")),
        }
    };
    let cases = v["cases"].as_array().map_or(&[][..], |c| c.as_slice());
    J::Array(
        cases
            .iter()
            .map(|c| eval(s(c, "src"), &get, today).to_json())
            .collect(),
    )
}

/// One entry point for the WASM bridge (and tests): `op` names the call.
pub fn dispatch(op: u32, input: &J) -> J {
    match op {
        0 => compute(input),
        1 => check_json(input),
        2 => functions(),
        3 => json!(normalize(s(input, "src"))),
        4 => json!(rename_prop(
            s(input, "src"),
            s(input, "old"),
            s(input, "new")
        )),
        5 => run_vectors(input),
        _ => json!({"error": "unknown op"}),
    }
}
