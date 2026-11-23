// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! In-file bounded history (ADR-055, docs/30 §13).
//!
//! Earlier versions travel inside the `.ocanvas` as **reverse diffs**: each entry turns the next
//! newer state (the file's own content for the newest entry) back into that version. Nothing is
//! a full copy, and Yjs garbage collection stays on: the diffs are over the `document.json`
//! projection (`content`, `meta`, `databases`, `boards`; comments and people are not history).
//!
//! Layout, additive to format version 1 (readers that do not know it ignore it):
//! - `history/index.json`: `{"format": 1, "versions": [{id, kind, name?, authors, at,
//!   restoredFrom?, size}]}`, oldest first; `size` is the compressed diff's byte count.
//! - `history/<id>.deflate`: the reverse diff as raw-deflate JSON (stored, not re-compressed).
//!
//! Reverse diff JSON (`{"v": 1, …}`):
//! - `content`: `[["k", n] | ["d", n] | ["i", [node…]]]` over the top-level blocks: keep `n`,
//!   drop `n`, insert the older version's blocks.
//! - `meta`, `databases`, `boards`: an object diff `{"s": {key: older value}, "d": [key…],
//!   "o": {key: nested object diff}}` (set, delete, recurse), absent when equal.
//!
//! Bounds: a byte budget and a count. Over either, the oldest automatic version goes first (its
//! neighbours' diffs are recomputed so the chain stays whole); named and restore versions are
//! kept until only they remain, then the oldest of them.

use std::io::{Read, Write};

use serde_json::{Map as JsonMap, Value, json};

use crate::diff::{Op, myers_unbounded};
use crate::ocanvas::CommitKind;

pub const INDEX: &str = "history/index.json";
pub const PREFIX: &str = "history/";
/// One inflated diff may not exceed this (zip-bomb guard on read).
const MAX_INFLATED: u64 = 32 * 1024 * 1024;

/// One kept version.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub id: String,
    pub kind: CommitKind,
    pub name: Option<String>,
    pub authors: Vec<String>,
    pub at: String,
    pub restored_from: Option<String>,
    /// The reverse diff, raw-deflate compressed.
    pub diff: Vec<u8>,
}

/// What a version is, without its diff.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VersionMeta {
    pub id: String,
    pub kind: CommitKind,
    pub name: Option<String>,
    pub authors: Vec<String>,
    pub at: String,
    pub restored_from: Option<String>,
}

impl VersionMeta {
    /// From a `.ocanvas` manifest's `commit`.
    pub fn from_manifest(m: &Value) -> Self {
        let c = &m["commit"];
        let s = |k: &str| c[k].as_str().map(String::from);
        Self {
            id: s("id").unwrap_or_default(),
            kind: CommitKind::parse(c["kind"].as_str()),
            name: s("message"),
            authors: c["authors"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default(),
            at: s("at").unwrap_or_default(),
            restored_from: s("restoredFrom"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_bytes: usize,
    pub max_versions: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_bytes: 1024 * 1024,
            max_versions: 50,
        }
    }
}

/// The kept versions, oldest first.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FileHistory {
    pub entries: Vec<Entry>,
}

// ---------- compression ----------

fn deflate(v: &Value) -> Vec<u8> {
    let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    let _ = e.write_all(&serde_json::to_vec(v).unwrap_or_default());
    e.finish().unwrap_or_default()
}

fn inflate(b: &[u8]) -> Option<Value> {
    let mut out = Vec::new();
    flate2::read::DeflateDecoder::new(b)
        .take(MAX_INFLATED + 1)
        .read_to_end(&mut out)
        .ok()?;
    if out.len() as u64 > MAX_INFLATED {
        return None;
    }
    serde_json::from_slice(&out).ok()
}

// ---------- reverse diff ----------

fn obj_diff(newer: &Value, older: &Value) -> Option<Value> {
    if newer == older {
        return None;
    }
    let (Some(n), Some(o)) = (newer.as_object(), older.as_object()) else {
        return Some(json!({"replace": older}));
    };
    let mut s = JsonMap::new();
    let mut d = Vec::new();
    let mut sub = JsonMap::new();
    for (k, ov) in o {
        match n.get(k) {
            None => {
                s.insert(k.clone(), ov.clone());
            }
            Some(nv) if nv == ov => {}
            Some(nv) if nv.is_object() && ov.is_object() => {
                if let Some(x) = obj_diff(nv, ov) {
                    sub.insert(k.clone(), x);
                }
            }
            Some(_) => {
                s.insert(k.clone(), ov.clone());
            }
        }
    }
    for k in n.keys() {
        if !o.contains_key(k) {
            d.push(json!(k));
        }
    }
    let mut out = JsonMap::new();
    if !s.is_empty() {
        out.insert("s".into(), Value::Object(s));
    }
    if !d.is_empty() {
        out.insert("d".into(), Value::Array(d));
    }
    if !sub.is_empty() {
        out.insert("o".into(), Value::Object(sub));
    }
    Some(Value::Object(out))
}

fn obj_apply(newer: &Value, diff: &Value) -> Value {
    if let Some(r) = diff.get("replace") {
        return r.clone();
    }
    let mut out = newer.as_object().cloned().unwrap_or_default();
    for k in diff["d"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        out.remove(k);
    }
    for (k, v) in diff["s"].as_object().into_iter().flatten() {
        out.insert(k.clone(), v.clone());
    }
    for (k, d) in diff["o"].as_object().into_iter().flatten() {
        let cur = out.get(k).cloned().unwrap_or_else(|| json!({}));
        out.insert(k.clone(), obj_apply(&cur, d));
    }
    Value::Object(out)
}

const ROOTS: [&str; 3] = ["meta", "databases", "boards"];

/// The diff that turns `newer` back into `older` (both `document.json`).
pub fn reverse_diff(newer: &Value, older: &Value) -> Value {
    let empty = Vec::new();
    let a = newer["content"].as_array().unwrap_or(&empty);
    let b = older["content"].as_array().unwrap_or(&empty);
    let mut ops: Vec<Value> = Vec::new();
    let mut push = |kind: &str, n: usize, ins: Option<Value>| {
        if let Some(last) = ops.last_mut()
            && last[0] == kind
        {
            match ins {
                Some(node) => last[1].as_array_mut().expect("insert list").push(node),
                None => last[1] = json!(last[1].as_u64().unwrap_or(0) + n as u64),
            }
            return;
        }
        ops.push(match ins {
            Some(node) => json!([kind, [node]]),
            None => json!([kind, n]),
        });
    };
    for op in myers_unbounded(a, b) {
        match op {
            Op::Eq(..) => push("k", 1, None),
            Op::Del(_) => push("d", 1, None),
            Op::Ins(j) => push("i", 0, Some(b[j].clone())),
        }
    }
    let mut out = json!({"v": 1});
    // All kept: nothing to say about the content.
    if !(ops.len() == 1 && ops[0][0] == "k") && !(a.is_empty() && b.is_empty()) {
        out["content"] = Value::Array(ops);
    }
    for r in ROOTS {
        let (n, o) = (
            newer.get(r).cloned().unwrap_or_else(|| json!({})),
            older.get(r).cloned().unwrap_or_else(|| json!({})),
        );
        if let Some(d) = obj_diff(&n, &o) {
            out[r] = d;
        }
    }
    out
}

/// Applies a reverse diff to `newer`; comments and people stay those of `newer`.
pub fn apply_reverse(newer: &Value, diff: &Value) -> Value {
    let mut out = newer.clone();
    if let Some(ops) = diff["content"].as_array() {
        let src = newer["content"].as_array().cloned().unwrap_or_default();
        let mut i = 0;
        let mut content = Vec::new();
        for op in ops {
            match op[0].as_str() {
                Some("k") => {
                    let n = op[1].as_u64().unwrap_or(0) as usize;
                    content.extend(src.iter().skip(i).take(n).cloned());
                    i += n;
                }
                Some("d") => i += op[1].as_u64().unwrap_or(0) as usize,
                Some("i") => content.extend(op[1].as_array().cloned().unwrap_or_default()),
                _ => {}
            }
        }
        out["content"] = Value::Array(content);
    }
    for r in ROOTS {
        if let Some(d) = diff.get(r) {
            let cur = newer.get(r).cloned().unwrap_or_else(|| json!({}));
            out[r] = obj_apply(&cur, d);
        }
    }
    out
}

// ---------- the chain ----------

impl FileHistory {
    pub fn bytes(&self) -> usize {
        self.entries.iter().map(|e| e.diff.len()).sum()
    }

    /// Every kept version's `document.json`, oldest first, rebuilt from `current`.
    /// `None` when a diff cannot be read.
    pub fn states(&self, current: &Value) -> Option<Vec<Value>> {
        let mut out = vec![Value::Null; self.entries.len()];
        let mut next = current.clone();
        for (i, e) in self.entries.iter().enumerate().rev() {
            let d = inflate(&e.diff)?;
            next = apply_reverse(&next, &d);
            out[i] = next.clone();
        }
        Some(out)
    }

    /// One version's `document.json` by id.
    pub fn state_of(&self, current: &Value, id: &str) -> Option<Value> {
        let pos = self.entries.iter().position(|e| e.id == id)?;
        let mut next = current.clone();
        for e in self.entries[pos..].iter().rev() {
            next = apply_reverse(&next, &inflate(&e.diff)?);
        }
        Some(next)
    }

    /// The file is about to be saved as `new_current`. `prev` is the previous save's content
    /// and description; when `keep_prev` it becomes a version (a checkpoint, a named or restore
    /// save, or the state the room loaded), else it is dropped and the newest version's diff is
    /// rebased onto `new_current`. Then the bounds apply.
    pub fn advance(
        &mut self,
        prev: &Value,
        prev_meta: &VersionMeta,
        keep_prev: bool,
        new_current: &Value,
        limits: Limits,
    ) {
        if keep_prev {
            if prev != new_current || prev_meta.kind != CommitKind::Auto {
                self.entries.push(Entry {
                    id: prev_meta.id.clone(),
                    kind: prev_meta.kind,
                    name: prev_meta.name.clone(),
                    authors: prev_meta.authors.clone(),
                    at: prev_meta.at.clone(),
                    restored_from: prev_meta.restored_from.clone(),
                    diff: deflate(&reverse_diff(new_current, prev)),
                });
            }
        } else if let Some(last) = self.entries.last_mut()
            && let Some(d) = inflate(&last.diff)
        {
            let newest = apply_reverse(prev, &d);
            last.diff = deflate(&reverse_diff(new_current, &newest));
        }
        self.prune(new_current, limits);
    }

    /// Drops versions until both bounds hold (oldest automatic first, then oldest).
    pub fn prune(&mut self, current: &Value, limits: Limits) {
        while !self.entries.is_empty()
            && (self.entries.len() > limits.max_versions || self.bytes() > limits.max_bytes)
        {
            let victim = self
                .entries
                .iter()
                .position(|e| e.kind == CommitKind::Auto)
                .unwrap_or(0);
            if victim > 0 {
                // Rebase the older neighbour onto the newer one.
                let Some(states) = self.states(current) else {
                    self.entries.clear();
                    return;
                };
                let newer = states.get(victim + 1).unwrap_or(current);
                self.entries[victim - 1].diff = deflate(&reverse_diff(newer, &states[victim - 1]));
            }
            self.entries.remove(victim);
        }
    }

    // ---------- zip layout ----------

    /// `history/index.json` and the entries' file names and bytes.
    pub fn to_files(&self) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        let mut index = Vec::new();
        for e in &self.entries {
            let mut m = json!({"id": e.id, "kind": e.kind.as_str(), "authors": e.authors, "at": e.at, "size": e.diff.len()});
            if let Some(n) = &e.name {
                m["name"] = json!(n);
            }
            if let Some(r) = &e.restored_from {
                m["restoredFrom"] = json!(r);
            }
            index.push(m);
            out.push((
                format!("{PREFIX}{}.deflate", safe_id(&e.id)),
                e.diff.clone(),
            ));
        }
        out.insert(
            0,
            (
                INDEX.to_string(),
                serde_json::to_vec(&json!({"format": 1, "versions": index})).unwrap_or_default(),
            ),
        );
        out
    }

    /// Reads the layout back; entries whose file is missing are dropped (with every older one,
    /// as the chain would break there).
    pub fn from_files(index: &[u8], get: impl Fn(&str) -> Option<Vec<u8>>) -> Self {
        let Ok(v) = serde_json::from_slice::<Value>(index) else {
            return Self::default();
        };
        let mut entries = Vec::new();
        for m in v["versions"].as_array().into_iter().flatten() {
            let Some(id) = m["id"].as_str().filter(|i| !i.is_empty()) else {
                entries.clear();
                continue;
            };
            let Some(diff) = get(&format!("{PREFIX}{}.deflate", safe_id(id))) else {
                entries.clear();
                continue;
            };
            let s = |k: &str| m[k].as_str().map(String::from);
            entries.push(Entry {
                id: id.to_string(),
                kind: CommitKind::parse(m["kind"].as_str()),
                name: s("name"),
                authors: m["authors"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(String::from)
                            .collect()
                    })
                    .unwrap_or_default(),
                at: s("at").unwrap_or_default(),
                restored_from: s("restoredFrom"),
                diff,
            });
        }
        Self { entries }
    }

    /// The versions, newest first, as the history API lists them.
    pub fn list(&self) -> Vec<Value> {
        self.entries
            .iter()
            .rev()
            .map(|e| {
                let mut m = json!({"version": e.id, "kind": e.kind.as_str(), "authors": e.authors, "at": e.at, "size": e.diff.len()});
                if let Some(n) = &e.name {
                    m["name"] = json!(n);
                }
                if let Some(r) = &e.restored_from {
                    m["restoredFrom"] = json!(r);
                }
                m
            })
            .collect()
    }
}

/// Entry file names: the id with anything outside `[A-Za-z0-9_-]` replaced.
fn safe_id(id: &str) -> String {
    id.chars()
        .take(64)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}
