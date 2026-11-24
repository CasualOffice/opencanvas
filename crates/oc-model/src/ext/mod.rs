// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! SDK blocks (docs/27 §3, ADR-040, docs/15 §4.2): the one generic `extBlock` node, the `ext`
//! root, the installed-package registry, and how validation, exports and server writes treat
//! them.
//!
//! An `extBlock` stores `{blockId, type, v, attrs, dataId?, fallback}`; its collaborative
//! data lives in the `ext` root as `ext[dataId] = Y.Map` (one key per field, last writer wins
//! per field). The registry holds the operator-installed manifests ([`manifest::Manifest`]);
//! a type that is not installed is kept as is and shown as its `fallback` (rule 7).

pub mod manifest;
pub mod migrate;
pub mod schema;
pub mod template;

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use serde_json::{Map, Value, json};

pub use manifest::Manifest;

/// The node type every SDK block is stored as.
pub const NODE: &str = "extBlock";
/// Largest `attrs` value (serialised JSON).
pub const MAX_ATTRS_BYTES: usize = 64 * 1024;
/// Largest `fallback.markdown` / `fallback.text`.
pub const MAX_FALLBACK_BYTES: usize = 16 * 1024;

/// Installed block packages by type.
#[derive(Debug, Clone, Default)]
pub struct Registry {
    types: BTreeMap<String, Arc<Manifest>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a manifest; one package per type.
    pub fn insert(&mut self, m: Manifest) -> Result<(), String> {
        if self.types.contains_key(&m.ty) {
            return Err(format!("type {:?} is installed twice", m.ty));
        }
        self.types.insert(m.ty.clone(), Arc::new(m));
        Ok(())
    }

    pub fn get(&self, ty: &str) -> Option<&Arc<Manifest>> {
        self.types.get(ty)
    }

    pub fn iter(&self) -> impl Iterator<Item = &Arc<Manifest>> {
        self.types.values()
    }

    pub fn len(&self) -> usize {
        self.types.len()
    }

    pub fn is_empty(&self) -> bool {
        self.types.is_empty()
    }
}

static INSTALLED: RwLock<Option<Arc<Registry>>> = RwLock::new(None);

/// The packages this process has installed (empty until [`install`]).
pub fn installed() -> Arc<Registry> {
    INSTALLED
        .read()
        .expect("block registry lock")
        .clone()
        .unwrap_or_default()
}

/// Installs `reg`'s packages for every later validation, export and write in this process.
/// Types already installed are replaced; others are kept (several servers in one test
/// process install their own types).
pub fn install(reg: &Registry) {
    let mut g = INSTALLED.write().expect("block registry lock");
    let mut next = g.as_deref().cloned().unwrap_or_default();
    for m in reg.iter() {
        next.types.insert(m.ty.clone(), m.clone());
    }
    *g = Some(Arc::new(next));
}

/// How a stored block relates to the installed package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    /// No package for the type: kept, shown as its fallback.
    NotInstalled,
    /// Stored at the package's data version.
    Current,
    /// Stored at an older version; the package migrates it (declaratively here, or in its
    /// sandbox when `migrations` is a script).
    Older { from: u64, to: u64 },
    /// Written by a newer package than the one installed: read-only, shown as its fallback
    /// ("updated by a newer version"), kept as is.
    Newer { stored: u64, installed: u64 },
}

/// A block as the installed package sees it: attrs and data migrated forward when the
/// migration is declarative.
#[derive(Debug, Clone)]
pub struct View {
    pub manifest: Option<Arc<Manifest>>,
    pub status: Status,
    /// Migrated (or stored) attrs and data; `None` when they could not be brought to the
    /// installed version.
    pub current: Option<(Value, Value)>,
    /// Why `current` is `None` (or schema findings for it).
    pub problem: Option<String>,
}

pub fn attrs_of(node: &Value) -> &Value {
    node.get("attrs").unwrap_or(&Value::Null)
}

/// The block's data from the document's `ext` root.
pub fn data_of<'a>(node: &Value, ext: &'a Value) -> &'a Value {
    attrs_of(node)
        .get("dataId")
        .and_then(Value::as_str)
        .and_then(|id| ext.get(id))
        .unwrap_or(&Value::Null)
}

/// The stored data version, or 1 when missing.
pub fn stored_v(attrs: &Value) -> u64 {
    attrs.get("v").and_then(Value::as_u64).unwrap_or(1)
}

/// Looks the block up in `reg` and migrates its attrs and data to the installed version.
pub fn view(reg: &Registry, node: &Value, ext: &Value) -> View {
    let a = attrs_of(node);
    let ty = a.get("type").and_then(Value::as_str).unwrap_or_default();
    let Some(m) = reg.get(ty).cloned() else {
        return View {
            manifest: None,
            status: Status::NotInstalled,
            current: None,
            problem: None,
        };
    };
    let v = stored_v(a);
    let inner = a.get("attrs").cloned().unwrap_or_else(|| json!({}));
    let data = data_of(node, ext).clone();
    let major = m.major();
    let status = match v.cmp(&major) {
        std::cmp::Ordering::Equal => Status::Current,
        std::cmp::Ordering::Less => Status::Older { from: v, to: major },
        std::cmp::Ordering::Greater => Status::Newer {
            stored: v,
            installed: major,
        },
    };
    let (current, problem) = match &status {
        Status::Current => (Some((inner, obj_or_empty(data))), None),
        Status::Older { .. } => (
            None,
            Some("older data is migrated by the block's package".to_string()),
        ),
        Status::Newer { stored, installed } => (
            None,
            Some(format!(
                "updated by a newer version (data v{stored}, installed v{installed})"
            )),
        ),
        Status::NotInstalled => (None, None),
    };
    View {
        manifest: Some(m),
        status,
        current,
        problem,
    }
}

fn obj_or_empty(v: Value) -> Value {
    if v.is_object() { v } else { json!({}) }
}

/// Schema findings for attrs and data at the installed version, as `(where, path, message)`
/// with `where` = `"attrs"` or `"data"`.
pub fn schema_findings(
    m: &Manifest,
    attrs: &Value,
    data: &Value,
) -> Vec<(&'static str, String, String)> {
    let mut out: Vec<(&'static str, String, String)> = m
        .attrs
        .validate(attrs)
        .into_iter()
        .map(|(p, e)| ("attrs", p, e))
        .collect();
    match &m.data {
        Some(s) => out.extend(
            s.validate(&obj_or_empty(data.clone()))
                .into_iter()
                .map(|(p, e)| ("data", p, e)),
        ),
        None => {
            if data.as_object().is_some_and(|d| !d.is_empty()) {
                out.push(("data", String::new(), format!("{} declares no data", m.ty)));
            }
        }
    }
    out
}

// ------------------------------------------------------------------ validation (MOD-01)

/// Checks one `extBlock`'s own attributes (`node_attrs` is the ProseMirror attrs object) and,
/// for an installed type, its attrs and data against the package schema. Findings go to
/// `err` / `warn` as `(path, message)`.
pub(crate) fn check(
    reg: &Registry,
    path: &str,
    node_attrs: Option<&Map<String, Value>>,
    ext: Option<&Value>,
    err: &mut dyn FnMut(String, String),
    warn: &mut dyn FnMut(String, String),
) {
    let empty = Map::new();
    let a = node_attrs.unwrap_or(&empty);
    let ap = |k: &str| format!("{path}/attrs/{k}");
    let ty = match a.get("type") {
        Some(Value::String(t)) => t.as_str(),
        _ => {
            err(
                ap("type"),
                "extBlock needs a string type (\"acme.okr\")".into(),
            );
            return;
        }
    };
    if let Err(e) = manifest::check_type_name(ty) {
        err(ap("type"), e);
        return;
    }
    match a.get("v") {
        Some(v) if v.as_u64().is_some_and(|n| n >= 1) => {}
        _ => err(
            ap("v"),
            "extBlock.v must be a whole number ≥ 1 (the data version)".into(),
        ),
    }
    match a.get("attrs") {
        None | Some(Value::Null) | Some(Value::Object(_)) => {}
        Some(_) => err(ap("attrs"), "extBlock.attrs must be a JSON object".into()),
    }
    if let Some(x) = a.get("attrs")
        && serde_json::to_vec(x).map_or(0, |b| b.len()) > MAX_ATTRS_BYTES
    {
        err(
            ap("attrs"),
            format!("extBlock.attrs is larger than {MAX_ATTRS_BYTES} bytes"),
        );
    }
    match a.get("dataId") {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) if !s.is_empty() => {}
        Some(_) => err(
            ap("dataId"),
            "extBlock.dataId must be a non-empty string".into(),
        ),
    }
    match a.get("fallback") {
        None | Some(Value::Null) => {}
        Some(Value::Object(f)) => {
            for (k, v) in f {
                let p = format!("{}/{k}", ap("fallback"));
                match (k.as_str(), v) {
                    ("markdown" | "text", Value::String(s)) if s.len() <= MAX_FALLBACK_BYTES => {}
                    ("markdown" | "text", Value::Null) => {}
                    ("markdown" | "text", Value::String(_)) => err(
                        p,
                        format!("a fallback is at most {MAX_FALLBACK_BYTES} bytes"),
                    ),
                    ("markdown" | "text", _) => err(p, "a fallback is a string".into()),
                    _ => warn(p, format!("unknown fallback field {k:?} (kept as is)")),
                }
            }
        }
        Some(_) => err(
            ap("fallback"),
            "extBlock.fallback must be {markdown, text}".into(),
        ),
    }
    let node = json!({"attrs": Value::Object(a.clone())});
    let v = view(reg, &node, ext.unwrap_or(&Value::Null));
    // Patch input carries no `ext` root: its data is checked where it is written.
    let with_data = ext.is_some();
    let data_path = match a.get("dataId").and_then(Value::as_str) {
        Some(id) => format!("/ext/{}", id.replace('~', "~0").replace('/', "~1")),
        None => format!("{path}/data"),
    };
    match (&v.status, &v.manifest, &v.current) {
        (Status::NotInstalled, ..) => warn(
            path.to_string(),
            format!("block type {ty:?} is not installed (kept as is, shown as its fallback)"),
        ),
        (Status::Newer { .. }, ..) => warn(
            path.to_string(),
            format!(
                "{ty}: {} (kept, read-only)",
                v.problem.as_deref().unwrap_or_default()
            ),
        ),
        (Status::Older { from, to }, Some(_), None) => warn(
            path.to_string(),
            format!(
                "{ty}: data v{from} is migrated to v{to} by the block in the editor ({}); kept",
                v.problem.as_deref().unwrap_or("not here")
            ),
        ),
        (Status::Older { from, to }, Some(m), Some((attrs, data))) => {
            let f: Vec<_> = schema_findings(m, attrs, data)
                .into_iter()
                .filter(|(w, ..)| with_data || *w == "attrs")
                .collect();
            if !f.is_empty() {
                let (w, p, e) = &f[0];
                warn(
                    path.to_string(),
                    format!(
                        "{ty}: data v{from} migrated to v{to} does not match the schema at {w}{p}: {e} (kept)"
                    ),
                );
            }
        }
        (Status::Current, Some(m), Some((attrs, data))) => {
            for (w, p, e) in schema_findings(m, attrs, data) {
                if w == "data" && !with_data {
                    continue;
                }
                let at = if w == "attrs" {
                    format!("{}{p}", ap("attrs"))
                } else {
                    format!("{data_path}{p}")
                };
                err(at, format!("{ty}: {e}"));
            }
        }
        _ => {}
    }
}

/// Checks the `ext` root of `document.json`: `{dataId: {field: value}}`.
pub(crate) fn check_root(ext: &Value, err: &mut dyn FnMut(String, String)) {
    let Some(m) = ext.as_object() else {
        err("/ext".into(), "ext must be an object".into());
        return;
    };
    for (id, d) in m {
        if !d.is_object() {
            err(format!("/ext/{id}"), "block data must be an object".into());
        }
    }
}
