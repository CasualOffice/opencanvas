// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Declarative block migrations (BSDK-05, docs/15 §4.2).
//!
//! A manifest's `migrations` maps each data version N to the steps that turn version N into
//! N + 1. A step is data, never code, so the server and the editor can both run it: there is
//! no third-party code on the server (ADR-040). Steps work on `{"attrs": {…}, "data": {…}}`
//! with JSON-pointer paths (`/attrs/title`, `/data/score`):
//!
//! - `{"op": "set", "path", "value"}`: write the value.
//! - `{"op": "default", "path", "value"}`: write it only when nothing is there.
//! - `{"op": "remove", "path"}`
//! - `{"op": "move", "from", "path"}`: rename, or move between `attrs` and `data`.
//! - `{"op": "copy", "from", "path"}`
//! - `{"op": "map", "path", "values": {"old": "new"}}`: replace a string value by the table.
//! - `{"op": "scale", "path", "by"}`: multiply a number (`0.42` → `42` with `by: 100`).
//!
//! A step whose source is missing does nothing, so a migration is total. The result is
//! validated against the new version's schema by the caller. A manifest that names a script
//! (`"migrations": "migrations.js"`) runs in the block sandbox (BSDK-03) instead; the server
//! cannot migrate those blocks and treats older data as read-only until a client with the
//! package migrates it.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Set(Vec<String>, Value),
    Default(Vec<String>, Value),
    Remove(Vec<String>),
    Move(Vec<String>, Vec<String>),
    Copy(Vec<String>, Vec<String>),
    Map(Vec<String>, Map<String, Value>),
    Scale(Vec<String>, f64),
}

#[derive(Debug, Clone, PartialEq, Default)]
pub enum Migrations {
    /// None declared (a major-1 package).
    #[default]
    None,
    /// Steps from each version to the next.
    Declarative(BTreeMap<u64, Vec<Step>>),
    /// A script for the sandbox (BSDK-03); the path inside the package.
    Script(String),
}

/// Most steps per version.
const MAX_STEPS: usize = 200;

fn pointer(p: &Value, what: &str) -> Result<Vec<String>, String> {
    let s = p
        .as_str()
        .ok_or_else(|| format!("{what} must be a JSON pointer string"))?;
    let segs: Vec<String> = s
        .strip_prefix('/')
        .ok_or_else(|| format!("{what} {s:?} must start with /attrs/ or /data/"))?
        .split('/')
        .map(|x| x.replace("~1", "/").replace("~0", "~"))
        .collect();
    if segs.len() < 2
        || !matches!(segs[0].as_str(), "attrs" | "data")
        || segs.iter().any(String::is_empty)
    {
        return Err(format!(
            "{what} {s:?} must name a field under /attrs/ or /data/"
        ));
    }
    Ok(segs)
}

impl Migrations {
    /// Parses a manifest's `migrations` value.
    pub fn parse(v: Option<&Value>) -> Result<Self, String> {
        let Some(v) = v else { return Ok(Self::None) };
        match v {
            Value::Null => Ok(Self::None),
            Value::String(path) => Ok(Self::Script(path.clone())),
            Value::Object(m) => {
                let mut out = BTreeMap::new();
                for (k, steps) in m {
                    let from: u64 = k.parse().ok().filter(|n| *n >= 1).ok_or_else(|| {
                        format!("migrations: key {k:?} must be a version number ≥ 1")
                    })?;
                    let steps = steps
                        .as_array()
                        .ok_or_else(|| format!("migrations.{k} must be an array of steps"))?;
                    if steps.len() > MAX_STEPS {
                        return Err(format!("migrations.{k}: at most {MAX_STEPS} steps"));
                    }
                    let parsed = steps
                        .iter()
                        .enumerate()
                        .map(|(i, s)| step(s).map_err(|e| format!("migrations.{k}[{i}]: {e}")))
                        .collect::<Result<Vec<_>, _>>()?;
                    out.insert(from, parsed);
                }
                Ok(Self::Declarative(out))
            }
            _ => Err("migrations must be a script path or an object of steps".into()),
        }
    }

    /// True when every step from `from` up to `to` is declared (or a script covers them).
    pub fn covers(&self, from: u64, to: u64) -> bool {
        match self {
            Self::None => from >= to,
            Self::Script(_) => true,
            Self::Declarative(m) => (from..to).all(|v| m.contains_key(&v)),
        }
    }

    /// Runs the steps from version `from` to `to` over `attrs` and `data`. `Err` when a step
    /// is missing or the migrations are a script (the server cannot run those).
    pub fn run(
        &self,
        from: u64,
        to: u64,
        attrs: &Value,
        data: &Value,
    ) -> Result<(Value, Value), String> {
        let mut doc = json!({"attrs": obj(attrs), "data": obj(data)});
        if from < to {
            let steps = match self {
                Self::Declarative(m) => m,
                Self::Script(_) => {
                    return Err("this block migrates in its sandbox; the server cannot".into());
                }
                Self::None => return Err(format!("no migration from version {from}")),
            };
            for v in from..to {
                let list = steps
                    .get(&v)
                    .ok_or_else(|| format!("no migration from version {v}"))?;
                for s in list {
                    apply(&mut doc, s);
                }
            }
        }
        let Value::Object(mut m) = doc else {
            unreachable!()
        };
        Ok((
            m.remove("attrs").unwrap_or_default(),
            m.remove("data").unwrap_or_default(),
        ))
    }
}

fn obj(v: &Value) -> Value {
    if v.is_object() { v.clone() } else { json!({}) }
}

fn step(s: &Value) -> Result<Step, String> {
    let op = s["op"].as_str().unwrap_or_default();
    let path = || pointer(&s["path"], "path");
    let from = || pointer(&s["from"], "from");
    Ok(match op {
        "set" => Step::Set(path()?, s.get("value").cloned().ok_or("set needs a value")?),
        "default" => Step::Default(
            path()?,
            s.get("value").cloned().ok_or("default needs a value")?,
        ),
        "remove" => Step::Remove(path()?),
        "move" => Step::Move(from()?, path()?),
        "copy" => Step::Copy(from()?, path()?),
        "map" => Step::Map(
            path()?,
            s["values"]
                .as_object()
                .cloned()
                .ok_or("map needs a values object")?,
        ),
        "scale" => Step::Scale(
            path()?,
            s["by"]
                .as_f64()
                .filter(|x| x.is_finite())
                .ok_or("scale needs a number by")?,
        ),
        other => {
            return Err(format!(
                "unknown op {other:?} (set, default, remove, move, copy, map, scale)"
            ));
        }
    })
}

fn get<'a>(doc: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter().try_fold(doc, |v, k| v.get(k))
}

fn take(doc: &mut Value, path: &[String]) -> Option<Value> {
    let (last, parent) = path.split_last()?;
    let mut v = doc;
    for k in parent {
        v = v.get_mut(k)?;
    }
    v.as_object_mut()?.remove(last)
}

fn put(doc: &mut Value, path: &[String], value: Value) {
    let Some((last, parent)) = path.split_last() else {
        return;
    };
    let mut v = doc;
    for k in parent {
        if !v.get(k).is_some_and(Value::is_object) {
            v[k] = json!({});
        }
        v = v.get_mut(k).expect("just set");
    }
    if let Some(o) = v.as_object_mut() {
        o.insert(last.clone(), value);
    }
}

fn apply(doc: &mut Value, s: &Step) {
    match s {
        Step::Set(p, v) => put(doc, p, v.clone()),
        Step::Default(p, v) => {
            if get(doc, p).is_none_or(Value::is_null) {
                put(doc, p, v.clone());
            }
        }
        Step::Remove(p) => {
            take(doc, p);
        }
        Step::Move(from, to) => {
            if let Some(v) = take(doc, from) {
                put(doc, to, v);
            }
        }
        Step::Copy(from, to) => {
            if let Some(v) = get(doc, from).cloned() {
                put(doc, to, v);
            }
        }
        Step::Map(p, table) => {
            if let Some(new) = get(doc, p)
                .and_then(Value::as_str)
                .and_then(|k| table.get(k))
                .cloned()
            {
                put(doc, p, new);
            }
        }
        Step::Scale(p, by) => {
            if let Some(x) = get(doc, p).and_then(Value::as_f64) {
                let y = x * by;
                let v = if y.fract() == 0.0 && y.abs() < 1e15 {
                    json!(y as i64)
                } else {
                    json!(y)
                };
                put(doc, p, v);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_run_in_order_across_versions() {
        let m = Migrations::parse(Some(&json!({
            "1": [{"op": "move", "from": "/attrs/name", "path": "/attrs/objective"},
                  {"op": "default", "path": "/attrs/progress", "value": 0}],
            "2": [{"op": "scale", "path": "/attrs/progress", "by": 100},
                  {"op": "map", "path": "/attrs/state", "values": {"wip": "active"}},
                  {"op": "move", "from": "/attrs/notes", "path": "/data/notes"}]
        })))
        .unwrap();
        assert!(m.covers(1, 3));
        assert!(!m.covers(1, 4));
        let (a, d) = m
            .run(
                1,
                3,
                &json!({"name": "Ship", "progress": 0.5, "state": "wip", "notes": "n", "keep": 1}),
                &json!({}),
            )
            .unwrap();
        assert_eq!(
            a,
            json!({"objective": "Ship", "progress": 50, "state": "active", "keep": 1})
        );
        assert_eq!(d, json!({"notes": "n"}));
        // From version 2 only the second step runs.
        let (a, _) = m.run(2, 3, &json!({"progress": 0.25}), &json!({})).unwrap();
        assert_eq!(a, json!({"progress": 25}));
    }

    #[test]
    fn bad_steps_are_refused_and_scripts_cannot_run_here() {
        for bad in [
            json!({"1": [{"op": "eval", "path": "/attrs/x"}]}),
            json!({"0": []}),
            json!({"1": [{"op": "set", "path": "/meta/x", "value": 1}]}),
            json!({"1": [{"op": "set", "path": "attrs/x", "value": 1}]}),
            json!([1]),
        ] {
            assert!(Migrations::parse(Some(&bad)).is_err(), "{bad}");
        }
        let s = Migrations::parse(Some(&json!("migrations.js"))).unwrap();
        assert!(s.covers(1, 9));
        assert!(s.run(1, 2, &json!({}), &json!({})).is_err());
        assert!(
            Migrations::None
                .run(1, 1, &json!({"a": 1}), &json!(null))
                .is_ok()
        );
    }
}
