// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! JSON Schema 2020-12 for block `attrs` and `data` (BSDK-01, ADR-058).
//!
//! A compiled subset of the 2020-12 core, applicator and validation vocabularies: what a block
//! manifest needs to describe small JSON values. A schema that uses anything else is refused
//! when the package is installed, never silently ignored, so a block author cannot believe a
//! rule is enforced when it is not.
//!
//! Supported: `type`, `enum`, `const`; `minimum`, `maximum`, `exclusiveMinimum`,
//! `exclusiveMaximum`, `multipleOf`; `minLength`, `maxLength`, `pattern`; `items`,
//! `prefixItems`, `minItems`, `maxItems`, `uniqueItems`, `contains`; `properties`, `required`,
//! `additionalProperties`, `patternProperties`, `propertyNames`, `minProperties`,
//! `maxProperties`; `allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/`else`; `$ref` to
//! `#/$defs/<name>` and `#`; `$defs`. Annotations are accepted and ignored: `$schema` (must
//! be 2020-12), `$id`, `$comment`, `title`, `description`, `default`, `examples`,
//! `deprecated`, `readOnly`, `writeOnly`, `format` (annotation only, as 2020-12's default).
//!
//! No reference is ever fetched (`$ref` is local only), and `pattern` uses the `regex`
//! crate's linear-time engine, so a hostile value cannot make validation slow.

use std::collections::HashMap;

use regex::Regex;
use serde_json::{Map, Value};

/// The only `$schema` accepted.
pub const DRAFT_2020_12: &str = "https://json-schema.org/draft/2020-12/schema";

/// Deepest schema nesting compiled, and deepest `$ref` chain followed while validating.
const MAX_DEPTH: usize = 32;
const MAX_REF_DEPTH: usize = 64;
/// At most this many findings per validation.
const MAX_ERRORS: usize = 20;

#[derive(Debug, Clone)]
pub struct Schema {
    root: Node,
    defs: HashMap<String, Node>,
}

#[derive(Debug, Clone)]
enum Node {
    Bool(bool),
    Obj(Box<Obj>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ty {
    Null,
    Bool,
    Int,
    Num,
    Str,
    Arr,
    Obj,
}

impl Ty {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "null" => Self::Null,
            "boolean" => Self::Bool,
            "integer" => Self::Int,
            "number" => Self::Num,
            "string" => Self::Str,
            "array" => Self::Arr,
            "object" => Self::Obj,
            _ => return None,
        })
    }
    fn name(self) -> &'static str {
        match self {
            Self::Null => "null",
            Self::Bool => "boolean",
            Self::Int => "integer",
            Self::Num => "number",
            Self::Str => "string",
            Self::Arr => "array",
            Self::Obj => "object",
        }
    }
    fn matches(self, v: &Value) -> bool {
        match self {
            Self::Null => v.is_null(),
            Self::Bool => v.is_boolean(),
            Self::Int => v.as_f64().is_some_and(|n| n.fract() == 0.0),
            Self::Num => v.is_number(),
            Self::Str => v.is_string(),
            Self::Arr => v.is_array(),
            Self::Obj => v.is_object(),
        }
    }
}

#[derive(Debug, Clone, Default)]
struct Obj {
    types: Option<Vec<Ty>>,
    enum_: Option<Vec<Value>>,
    const_: Option<Value>,
    minimum: Option<f64>,
    maximum: Option<f64>,
    exclusive_minimum: Option<f64>,
    exclusive_maximum: Option<f64>,
    multiple_of: Option<f64>,
    min_length: Option<u64>,
    max_length: Option<u64>,
    pattern: Option<Regex>,
    items: Option<Node>,
    prefix_items: Vec<Node>,
    min_items: Option<u64>,
    max_items: Option<u64>,
    unique_items: bool,
    contains: Option<Node>,
    properties: Vec<(String, Node)>,
    required: Vec<String>,
    additional: Option<Node>,
    pattern_properties: Vec<(Regex, Node)>,
    property_names: Option<Node>,
    min_properties: Option<u64>,
    max_properties: Option<u64>,
    all_of: Vec<Node>,
    any_of: Vec<Node>,
    one_of: Vec<Node>,
    not: Option<Node>,
    if_: Option<Node>,
    then_: Option<Node>,
    else_: Option<Node>,
    ref_: Option<String>,
}

const ANNOTATIONS: &[&str] = &[
    "$schema",
    "$id",
    "$comment",
    "$defs",
    "title",
    "description",
    "default",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
    "format",
];

impl Schema {
    /// Compiles `v`; `Err` names the first unsupported or malformed keyword with its path.
    pub fn compile(v: &Value) -> Result<Self, String> {
        if let Some(s) = v.get("$schema")
            && s.as_str() != Some(DRAFT_2020_12)
        {
            return Err(format!("$schema must be {DRAFT_2020_12:?}"));
        }
        let mut defs = HashMap::new();
        if let Some(d) = v.get("$defs") {
            let d = d.as_object().ok_or("$defs must be an object")?;
            for (k, s) in d {
                defs.insert(k.clone(), node(s, &format!("/$defs/{k}"), 1)?);
            }
        }
        let root = node(v, "", 0)?;
        let schema = Self { root, defs };
        schema.check_refs(&schema.root)?;
        for n in schema.defs.values() {
            schema.check_refs(n)?;
        }
        Ok(schema)
    }

    /// The root accepts only objects (block attrs and data are objects).
    pub fn is_object_schema(v: &Value) -> bool {
        v.get("type").and_then(Value::as_str) == Some("object")
    }

    fn check_refs(&self, n: &Node) -> Result<(), String> {
        let Node::Obj(o) = n else { return Ok(()) };
        if let Some(r) = &o.ref_
            && r != "#"
            && !self.defs.contains_key(r.trim_start_matches("#/$defs/"))
        {
            return Err(format!("$ref {r:?} names no entry in $defs"));
        }
        let subs = o
            .items
            .iter()
            .chain(&o.prefix_items)
            .chain(&o.contains)
            .chain(o.properties.iter().map(|(_, n)| n))
            .chain(&o.additional)
            .chain(o.pattern_properties.iter().map(|(_, n)| n))
            .chain(&o.property_names)
            .chain(&o.all_of)
            .chain(&o.any_of)
            .chain(&o.one_of)
            .chain(&o.not)
            .chain(&o.if_)
            .chain(&o.then_)
            .chain(&o.else_);
        for s in subs {
            self.check_refs(s)?;
        }
        Ok(())
    }

    /// Findings as `(JSON pointer into the instance, message)`; empty when `v` is valid.
    pub fn validate(&self, v: &Value) -> Vec<(String, String)> {
        let mut out = Vec::new();
        self.check(&self.root, v, "", &mut out, 0);
        out.truncate(MAX_ERRORS);
        out
    }

    pub fn is_valid(&self, v: &Value) -> bool {
        let mut out = Vec::new();
        self.check(&self.root, v, "", &mut out, 0);
        out.is_empty()
    }

    fn ok(&self, n: &Node, v: &Value, depth: usize) -> bool {
        let mut out = Vec::new();
        self.check(n, v, "", &mut out, depth);
        out.is_empty()
    }

    fn check(&self, n: &Node, v: &Value, at: &str, out: &mut Vec<(String, String)>, depth: usize) {
        if out.len() >= MAX_ERRORS {
            return;
        }
        let o = match n {
            Node::Bool(true) => return,
            Node::Bool(false) => {
                out.push((at.into(), "no value is allowed here".into()));
                return;
            }
            Node::Obj(o) => o,
        };
        if let Some(r) = &o.ref_ {
            if depth >= MAX_REF_DEPTH {
                out.push((at.into(), "$ref nests too deeply".into()));
                return;
            }
            let target = if r == "#" {
                &self.root
            } else {
                &self.defs[r.trim_start_matches("#/$defs/")]
            };
            self.check(target, v, at, out, depth + 1);
        }
        if let Some(types) = &o.types
            && !types.iter().any(|t| t.matches(v))
        {
            let names: Vec<&str> = types.iter().map(|t| t.name()).collect();
            out.push((at.into(), format!("must be {}", names.join(" or "))));
            return;
        }
        if let Some(e) = &o.enum_
            && !e.iter().any(|x| json_eq(x, v))
        {
            out.push((at.into(), "must be one of the allowed values".into()));
        }
        if let Some(c) = &o.const_
            && !json_eq(c, v)
        {
            out.push((at.into(), format!("must be {c}")));
        }
        self.check_rest(o, v, at, out, depth);
    }

    fn check_rest(
        &self,
        o: &Obj,
        v: &Value,
        at: &str,
        out: &mut Vec<(String, String)>,
        depth: usize,
    ) {
        match v {
            Value::Number(num) => {
                let x = num.as_f64().unwrap_or(0.0);
                let mut bad = |m: String| out.push((at.to_string(), m));
                if o.minimum.is_some_and(|m| x < m) {
                    bad(format!("must be at least {}", fmt(o.minimum)));
                }
                if o.maximum.is_some_and(|m| x > m) {
                    bad(format!("must be at most {}", fmt(o.maximum)));
                }
                if o.exclusive_minimum.is_some_and(|m| x <= m) {
                    bad(format!("must be more than {}", fmt(o.exclusive_minimum)));
                }
                if o.exclusive_maximum.is_some_and(|m| x >= m) {
                    bad(format!("must be less than {}", fmt(o.exclusive_maximum)));
                }
                if let Some(m) = o.multiple_of {
                    let q = x / m;
                    if !q.is_finite() || (q - q.round()).abs() > 1e-9 {
                        bad(format!("must be a multiple of {}", fmt(Some(m))));
                    }
                }
            }
            Value::String(s) => {
                let len = s.chars().count() as u64;
                if o.min_length.is_some_and(|m| len < m) {
                    out.push((
                        at.into(),
                        format!("must be at least {} characters", o.min_length.unwrap_or(0)),
                    ));
                }
                if o.max_length.is_some_and(|m| len > m) {
                    out.push((
                        at.into(),
                        format!("must be at most {} characters", o.max_length.unwrap_or(0)),
                    ));
                }
                if let Some(p) = &o.pattern
                    && !p.is_match(s)
                {
                    out.push((at.into(), format!("must match {}", p.as_str())));
                }
            }
            Value::Array(a) => {
                let n = a.len() as u64;
                if o.min_items.is_some_and(|m| n < m) {
                    out.push((
                        at.into(),
                        format!("needs at least {} items", o.min_items.unwrap_or(0)),
                    ));
                }
                if o.max_items.is_some_and(|m| n > m) {
                    out.push((
                        at.into(),
                        format!("takes at most {} items", o.max_items.unwrap_or(0)),
                    ));
                }
                if o.unique_items {
                    'outer: for (i, x) in a.iter().enumerate() {
                        for y in &a[i + 1..] {
                            if json_eq(x, y) {
                                out.push((at.into(), "items must be unique".into()));
                                break 'outer;
                            }
                        }
                    }
                }
                for (i, item) in a.iter().enumerate() {
                    let p = format!("{at}/{i}");
                    if let Some(s) = o.prefix_items.get(i) {
                        self.check(s, item, &p, out, depth);
                    } else if let Some(s) = &o.items {
                        self.check(s, item, &p, out, depth);
                    }
                }
                if let Some(c) = &o.contains
                    && !a.iter().any(|x| self.ok(c, x, depth))
                {
                    out.push((at.into(), "contains no matching item".into()));
                }
            }
            Value::Object(m) => self.check_object(o, m, at, out, depth),
            _ => {}
        }
        for s in &o.all_of {
            self.check(s, v, at, out, depth);
        }
        if !o.any_of.is_empty() && !o.any_of.iter().any(|s| self.ok(s, v, depth)) {
            out.push((at.into(), "matches none of anyOf".into()));
        }
        if !o.one_of.is_empty() {
            let n = o.one_of.iter().filter(|s| self.ok(s, v, depth)).count();
            if n != 1 {
                out.push((
                    at.into(),
                    format!("must match exactly one of oneOf (matches {n})"),
                ));
            }
        }
        if let Some(s) = &o.not
            && self.ok(s, v, depth)
        {
            out.push((at.into(), "matches a schema it must not match".into()));
        }
        if let Some(i) = &o.if_ {
            let branch = if self.ok(i, v, depth) {
                &o.then_
            } else {
                &o.else_
            };
            if let Some(b) = branch {
                self.check(b, v, at, out, depth);
            }
        }
    }

    fn check_object(
        &self,
        o: &Obj,
        m: &Map<String, Value>,
        at: &str,
        out: &mut Vec<(String, String)>,
        depth: usize,
    ) {
        let n = m.len() as u64;
        if o.min_properties.is_some_and(|x| n < x) {
            out.push((
                at.into(),
                format!(
                    "needs at least {} properties",
                    o.min_properties.unwrap_or(0)
                ),
            ));
        }
        if o.max_properties.is_some_and(|x| n > x) {
            out.push((
                at.into(),
                format!("takes at most {} properties", o.max_properties.unwrap_or(0)),
            ));
        }
        for r in &o.required {
            if !m.contains_key(r) {
                out.push((format!("{at}/{}", esc(r)), "is required".into()));
            }
        }
        for (k, v) in m {
            let p = format!("{at}/{}", esc(k));
            if let Some(names) = &o.property_names {
                let mut sub = Vec::new();
                self.check(names, &Value::String(k.clone()), &p, &mut sub, depth);
                if !sub.is_empty() {
                    out.push((p.clone(), "is not an allowed property name".into()));
                }
            }
            let mut matched = false;
            if let Some((_, s)) = o.properties.iter().find(|(name, _)| name == k) {
                matched = true;
                self.check(s, v, &p, out, depth);
            }
            for (re, s) in &o.pattern_properties {
                if re.is_match(k) {
                    matched = true;
                    self.check(s, v, &p, out, depth);
                }
            }
            if !matched && let Some(a) = &o.additional {
                if matches!(a, Node::Bool(false)) {
                    out.push((p, "is not an allowed property".into()));
                } else {
                    self.check(a, v, &p, out, depth);
                }
            }
        }
    }
}

fn fmt(x: Option<f64>) -> String {
    let x = x.unwrap_or(0.0);
    if x.fract() == 0.0 && x.abs() < 1e15 {
        format!("{}", x as i64)
    } else {
        x.to_string()
    }
}

/// JSON-pointer escaping of one key.
fn esc(k: &str) -> String {
    k.replace('~', "~0").replace('/', "~1")
}

/// JSON equality with numbers compared by value (`1` equals `1.0`), as JSON Schema requires.
pub fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => match (x.as_i64(), y.as_i64()) {
            (Some(i), Some(j)) => i == j,
            _ => x.as_f64() == y.as_f64(),
        },
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w)))
        }
        _ => a == b,
    }
}

fn regex(src: &str, at: &str) -> Result<Regex, String> {
    regex::RegexBuilder::new(src)
        .size_limit(1 << 20)
        .build()
        .map_err(|_| format!("{at}: pattern {src:?} is not a valid regular expression"))
}

fn count(v: &Value, at: &str, k: &str) -> Result<u64, String> {
    v.as_u64()
        .ok_or_else(|| format!("{at}/{k} must be a non-negative integer"))
}

fn number(v: &Value, at: &str, k: &str) -> Result<f64, String> {
    v.as_f64()
        .ok_or_else(|| format!("{at}/{k} must be a number"))
}

fn list(v: &Value, at: &str, k: &str, depth: usize) -> Result<Vec<Node>, String> {
    let a = v
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or_else(|| format!("{at}/{k} must be a non-empty array of schemas"))?;
    a.iter()
        .enumerate()
        .map(|(i, s)| node(s, &format!("{at}/{k}/{i}"), depth + 1))
        .collect()
}

fn node(v: &Value, at: &str, depth: usize) -> Result<Node, String> {
    if depth > MAX_DEPTH {
        return Err(format!(
            "{at}: the schema nests more than {MAX_DEPTH} levels"
        ));
    }
    let m = match v {
        Value::Bool(b) => return Ok(Node::Bool(*b)),
        Value::Object(m) => m,
        _ => return Err(format!("{at}: a schema must be an object or a boolean")),
    };
    let mut o = Obj::default();
    let sub = |s: &Value, k: &str| node(s, &format!("{at}/{k}"), depth + 1);
    for (k, val) in m {
        match k.as_str() {
            "type" => {
                let names: Vec<&Value> = match val {
                    Value::Array(a) => a.iter().collect(),
                    other => vec![other],
                };
                let mut types = Vec::new();
                for n in names {
                    types.push(
                        n.as_str()
                            .and_then(Ty::parse)
                            .ok_or_else(|| format!("{at}/type: unknown type {n}"))?,
                    );
                }
                o.types = Some(types);
            }
            "enum" => {
                o.enum_ = Some(
                    val.as_array()
                        .cloned()
                        .ok_or_else(|| format!("{at}/enum must be an array"))?,
                )
            }
            "const" => o.const_ = Some(val.clone()),
            "minimum" => o.minimum = Some(number(val, at, k)?),
            "maximum" => o.maximum = Some(number(val, at, k)?),
            "exclusiveMinimum" => o.exclusive_minimum = Some(number(val, at, k)?),
            "exclusiveMaximum" => o.exclusive_maximum = Some(number(val, at, k)?),
            "multipleOf" => {
                let x = number(val, at, k)?;
                if x <= 0.0 {
                    return Err(format!("{at}/multipleOf must be more than 0"));
                }
                o.multiple_of = Some(x);
            }
            "minLength" => o.min_length = Some(count(val, at, k)?),
            "maxLength" => o.max_length = Some(count(val, at, k)?),
            "pattern" => {
                let p = val
                    .as_str()
                    .ok_or_else(|| format!("{at}/pattern must be a string"))?;
                o.pattern = Some(regex(p, at)?);
            }
            "items" => o.items = Some(sub(val, k)?),
            "prefixItems" => o.prefix_items = list(val, at, k, depth)?,
            "minItems" => o.min_items = Some(count(val, at, k)?),
            "maxItems" => o.max_items = Some(count(val, at, k)?),
            "uniqueItems" => {
                o.unique_items = val
                    .as_bool()
                    .ok_or_else(|| format!("{at}/uniqueItems must be true or false"))?
            }
            "contains" => o.contains = Some(sub(val, k)?),
            "properties" => {
                let p = val
                    .as_object()
                    .ok_or_else(|| format!("{at}/properties must be an object"))?;
                for (name, s) in p {
                    o.properties.push((
                        name.clone(),
                        node(s, &format!("{at}/properties/{name}"), depth + 1)?,
                    ));
                }
            }
            "required" => {
                let r = val
                    .as_array()
                    .ok_or_else(|| format!("{at}/required must be an array of names"))?;
                for name in r {
                    o.required.push(
                        name.as_str()
                            .ok_or_else(|| format!("{at}/required must be an array of names"))?
                            .to_string(),
                    );
                }
            }
            "additionalProperties" => o.additional = Some(sub(val, k)?),
            "patternProperties" => {
                let p = val
                    .as_object()
                    .ok_or_else(|| format!("{at}/patternProperties must be an object"))?;
                for (re, s) in p {
                    o.pattern_properties.push((
                        regex(re, at)?,
                        node(s, &format!("{at}/patternProperties/{re}"), depth + 1)?,
                    ));
                }
            }
            "propertyNames" => o.property_names = Some(sub(val, k)?),
            "minProperties" => o.min_properties = Some(count(val, at, k)?),
            "maxProperties" => o.max_properties = Some(count(val, at, k)?),
            "allOf" => o.all_of = list(val, at, k, depth)?,
            "anyOf" => o.any_of = list(val, at, k, depth)?,
            "oneOf" => o.one_of = list(val, at, k, depth)?,
            "not" => o.not = Some(sub(val, k)?),
            "if" => o.if_ = Some(sub(val, k)?),
            "then" => o.then_ = Some(sub(val, k)?),
            "else" => o.else_ = Some(sub(val, k)?),
            "$ref" => {
                let r = val
                    .as_str()
                    .ok_or_else(|| format!("{at}/$ref must be a string"))?;
                let local = r == "#"
                    || r.strip_prefix("#/$defs/")
                        .is_some_and(|n| !n.is_empty() && !n.contains('/'));
                if !local {
                    return Err(format!(
                        "{at}/$ref {r:?}: only \"#\" and \"#/$defs/<name>\" are supported (nothing is fetched)"
                    ));
                }
                o.ref_ = Some(r.to_string());
            }
            "$defs" if depth > 0 => {
                return Err(format!("{at}/$defs: only the root may define $defs"));
            }
            other if ANNOTATIONS.contains(&other) => {}
            other => {
                return Err(format!(
                    "{at}: keyword {other:?} is not supported (docs/15 §4.2)"
                ));
            }
        }
    }
    Ok(Node::Obj(Box::new(o)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn errs(schema: Value, v: Value) -> Vec<String> {
        Schema::compile(&schema)
            .unwrap()
            .validate(&v)
            .into_iter()
            .map(|(p, m)| format!("{p}: {m}"))
            .collect()
    }

    #[test]
    fn the_manifest_example_validates_attrs() {
        let s = json!({"$schema": DRAFT_2020_12, "type": "object", "additionalProperties": false,
            "properties": {"objective": {"type": "string", "maxLength": 5},
                           "progress": {"type": "number", "minimum": 0, "maximum": 1}},
            "required": ["objective"]});
        assert!(errs(s.clone(), json!({"objective": "Ship", "progress": 0.5})).is_empty());
        assert_eq!(
            errs(s.clone(), json!({"progress": 2, "x": 1})),
            [
                "/objective: is required",
                "/progress: must be at most 1",
                "/x: is not an allowed property"
            ]
        );
        assert_eq!(
            errs(s, json!({"objective": "Shipped"})),
            ["/objective: must be at most 5 characters"]
        );
    }

    #[test]
    fn combinators_refs_and_arrays() {
        let s = json!({"$defs": {"tag": {"type": "string", "pattern": "^[a-z]+$"}},
        "type": "object",
        "properties": {
            "tags": {"type": "array", "items": {"$ref": "#/$defs/tag"}, "uniqueItems": true, "maxItems": 3},
            "n": {"oneOf": [{"type": "integer"}, {"type": "string"}]},
            "pair": {"type": "array", "prefixItems": [{"type": "string"}, {"type": "number"}], "items": false}
        }});
        assert!(
            errs(
                s.clone(),
                json!({"tags": ["a", "b"], "n": 3, "pair": ["x", 1]})
            )
            .is_empty()
        );
        let e = errs(
            s,
            json!({"tags": ["a", "a", "B"], "n": 1.5, "pair": ["x", 1, 2]}),
        );
        assert_eq!(
            e,
            [
                "/n: must match exactly one of oneOf (matches 0)",
                "/pair/2: no value is allowed here",
                "/tags: items must be unique",
                "/tags/2: must match ^[a-z]+$"
            ]
        );
    }

    #[test]
    fn numbers_compare_by_value() {
        assert!(errs(json!({"enum": [1, "a"]}), json!(1.0)).is_empty());
        assert!(errs(json!({"type": "integer"}), json!(2.0)).is_empty());
        assert_eq!(
            errs(json!({"type": "integer"}), json!(2.5)),
            [": must be integer"]
        );
        assert!(errs(json!({"multipleOf": 0.1}), json!(0.3)).is_empty());
    }

    #[test]
    fn unsupported_or_remote_keywords_are_refused() {
        for s in [
            json!({"$dynamicRef": "#x"}),
            json!({"$ref": "https://example.com/s.json"}),
            json!({"$ref": "#/$defs/missing"}),
            json!({"unevaluatedProperties": false}),
            json!({"$schema": "http://json-schema.org/draft-07/schema#"}),
            json!({"pattern": "("}),
            json!({"type": "integr"}),
        ] {
            assert!(Schema::compile(&s).is_err(), "{s}");
        }
        // Self-references are fine and do not loop.
        let s = Schema::compile(&json!({"type": "object", "properties": {"child": {"$ref": "#"}}}))
            .unwrap();
        assert!(s.is_valid(&json!({"child": {"child": {}}})));
        assert!(!s.is_valid(&json!({"child": 1})));
    }
}
