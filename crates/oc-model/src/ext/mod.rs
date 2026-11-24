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

// ------------------------------------------------------------------ rendering

/// A block's rendering for exports: Markdown (escaped, safe to embed) and plain text.
#[derive(Debug, Clone, PartialEq)]
pub struct Rendered {
    pub markdown: String,
    pub text: String,
    /// `template`, `fallback` or `placeholder`.
    pub source: &'static str,
}

/// Re-derives safe Markdown from untrusted Markdown: parsed by the importer and written by
/// the exporter, so script links, raw HTML and images with odd URLs cannot pass.
pub fn sanitize_markdown(md: &str) -> String {
    let parsed = crate::import::markdown_to_json(md);
    crate::export::to_markdown(&json!({"content": parsed["content"].clone()}))
        .trim()
        .to_string()
}

fn template_ctx(attrs: &Value, data: &Value) -> Value {
    let mut ctx = attrs.as_object().cloned().unwrap_or_default();
    ctx.insert("data".into(), obj_or_empty(data.clone()));
    Value::Object(ctx)
}

/// Renders a block: the installed package's templates when its data is current (or migrated)
/// and valid, else the stored fallback, else a placeholder naming the type.
pub fn render(reg: &Registry, node: &Value, ext: &Value) -> Rendered {
    let v = view(reg, node, ext);
    if let (Some(m), Some((attrs, data))) = (&v.manifest, &v.current)
        && (m.markdown.is_some() || m.text.is_some())
        && schema_findings(m, attrs, data).is_empty()
    {
        let ctx = template_ctx(attrs, data);
        let text = m
            .text
            .as_ref()
            .map(|t| t.render(&ctx, template::Target::Text));
        let markdown = match &m.markdown {
            Some(t) => t.render(&ctx, template::Target::Markdown),
            None => template::md_escape(text.as_deref().unwrap_or_default()),
        };
        let text = text.unwrap_or_else(|| plain_of_markdown(&markdown));
        return Rendered {
            markdown,
            text,
            source: "template",
        };
    }
    let a = attrs_of(node);
    let fb = a.get("fallback").unwrap_or(&Value::Null);
    let md = fb
        .get("markdown")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let text = fb.get("text").and_then(Value::as_str).unwrap_or_default();
    if !md.trim().is_empty() || !text.trim().is_empty() {
        let markdown = if md.trim().is_empty() {
            template::md_escape(text)
        } else {
            sanitize_markdown(md)
        };
        let text = if text.trim().is_empty() {
            plain_of_markdown(&markdown)
        } else {
            text.to_string()
        };
        return Rendered {
            markdown,
            text,
            source: "fallback",
        };
    }
    let ty = a.get("type").and_then(Value::as_str).unwrap_or("unknown");
    let name = v.manifest.as_ref().map_or(ty, |m| m.title.as_str());
    Rendered {
        markdown: format!("*{}*", template::md_escape(&format!("Block: {name}"))),
        text: format!("Block: {name}"),
        source: "placeholder",
    }
}

fn plain_of_markdown(md: &str) -> String {
    let parsed = crate::import::markdown_to_json(md);
    parsed["content"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(crate::export::plain_text)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// The document with every `extBlock` replaced by ordinary blocks: its rendering (parsed
/// from the safe Markdown) followed by its own children. HTML, DOCX, PDF and previews draw
/// this; Markdown export renders `extBlock` directly.
pub fn expand<'a>(doc: &'a Value, reg: &Registry) -> std::borrow::Cow<'a, Value> {
    use std::borrow::Cow;
    fn has_ext(nodes: &[Value]) -> bool {
        nodes.iter().any(|n| {
            n.get("type").and_then(Value::as_str) == Some(NODE)
                || n.get("content")
                    .and_then(Value::as_array)
                    .is_some_and(|c| has_ext(c))
        })
    }
    fn walk(nodes: &[Value], ext: &Value, reg: &Registry, depth: usize) -> Vec<Value> {
        let mut out = Vec::with_capacity(nodes.len());
        for n in nodes {
            if n.get("type").and_then(Value::as_str) == Some(NODE) {
                let r = render(reg, n, ext);
                if let Some(c) = crate::import::markdown_to_json(&r.markdown)["content"].as_array()
                {
                    out.extend(c.iter().cloned());
                }
                if let Some(c) = n.get("content").and_then(Value::as_array)
                    && depth < 64
                {
                    out.extend(walk(c, ext, reg, depth + 1));
                }
                continue;
            }
            let mut n = n.clone();
            if let Some(c) = n.get("content").and_then(Value::as_array)
                && depth < 64
                && has_ext(c)
            {
                n["content"] = Value::Array(walk(c, ext, reg, depth + 1));
            }
            out.push(n);
        }
        out
    }
    let Some(content) = doc.get("content").and_then(Value::as_array) else {
        return Cow::Borrowed(doc);
    };
    if !has_ext(content) {
        return Cow::Borrowed(doc);
    }
    let ext = doc.get("ext").cloned().unwrap_or(Value::Null);
    let mut out = doc.clone();
    out["content"] = Value::Array(walk(content, &ext, reg, 0));
    Cow::Owned(out)
}

/// `manifest.requires.blocks` of a `.ocanvas`: the types and data versions the document
/// uses, sorted, highest version per type.
pub fn requires(doc: &Value) -> Vec<Value> {
    fn walk(nodes: &[Value], out: &mut BTreeMap<String, u64>, depth: usize) {
        for n in nodes {
            if n.get("type").and_then(Value::as_str) == Some(NODE) {
                let a = attrs_of(n);
                if let Some(t) = a.get("type").and_then(Value::as_str) {
                    let v = stored_v(a);
                    let e = out.entry(t.to_string()).or_insert(v);
                    *e = (*e).max(v);
                }
            }
            if let Some(c) = n.get("content").and_then(Value::as_array)
                && depth < 64
            {
                walk(c, out, depth + 1);
            }
        }
    }
    let mut found = BTreeMap::new();
    if let Some(c) = doc.get("content").and_then(Value::as_array) {
        walk(c, &mut found, 0);
    }
    found
        .into_iter()
        .map(|(t, v)| json!({"type": t, "v": v}))
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The design's example package, at data version `major`; version 2 renames
    /// `name` → `objective` and scales nothing.
    pub fn okr(major: u64) -> Manifest {
        let mut v = json!({
            "type": "acme.okr", "version": format!("{major}.0.0"), "title": "OKR", "icon": "target",
            "attrs": {"type": "object", "additionalProperties": false,
                      "properties": {"objective": {"type": "string", "maxLength": 50},
                                     "progress": {"type": "number", "minimum": 0, "maximum": 1}},
                      "required": ["objective"]},
            "data": {"kind": "map", "schema": {"type": "object",
                      "properties": {"score": {"type": "integer"}}, "additionalProperties": false}},
            "export": {"markdown": "**{{objective}}** ({{progress|percent}}){{#data.score}} score {{data.score}}{{/data.score}}",
                       "text": "{{objective}}"},
            "entry": "block.js",
            "integrity": format!("sha384-{}", "A".repeat(64))
        });
        if major >= 2 {
            v["migrations"] =
                json!({"1": [{"op": "move", "from": "/attrs/name", "path": "/attrs/objective"}]});
        }
        Manifest::from_json(&v, false).unwrap()
    }

    pub fn reg(major: u64) -> Registry {
        let mut r = Registry::new();
        r.insert(okr(major)).unwrap();
        r
    }

    fn block(v: u64, attrs: Value) -> Value {
        json!({"type": "extBlock", "attrs": {"blockId": "b1", "type": "acme.okr", "v": v,
            "attrs": attrs, "dataId": "d1",
            "fallback": {"markdown": "OKR: [x](javascript:alert(1)) <b>hi</b>", "text": "OKR fallback"}}})
    }

    #[test]
    fn current_blocks_render_their_template() {
        let ext = json!({"d1": {"score": 7}});
        let r = render(
            &reg(1),
            &block(1, json!({"objective": "Ship *it*", "progress": 0.5})),
            &ext,
        );
        assert_eq!(r.source, "template");
        assert_eq!(r.markdown, "**Ship \\*it\\*** (50%) score 7");
        assert_eq!(r.text, "Ship *it*");
    }

    #[test]
    fn missing_newer_or_invalid_blocks_render_the_sanitised_fallback() {
        let ext = json!({});
        let b = block(1, json!({"objective": "Ship", "progress": 0.5}));
        for (r, why) in [(Registry::new(), "not installed"), (reg(1), "invalid")] {
            let node = if why == "invalid" {
                block(1, json!({"progress": 3}))
            } else {
                b.clone()
            };
            let out = render(&r, &node, &ext);
            assert_eq!(out.source, "fallback", "{why}");
            assert!(
                !out.markdown.contains("javascript:"),
                "{why}: {}",
                out.markdown
            );
            // `<` only escaped, so it is text, never HTML.
            assert!(
                !out.markdown.replace("\\<", "").contains('<'),
                "{why}: {}",
                out.markdown
            );
            assert_eq!(out.text, "OKR fallback");
        }
        // Data written by v2 on a v1 install: fallback, read-only.
        let v = view(&reg(1), &block(2, json!({"objective": "x"})), &ext);
        assert!(matches!(
            v.status,
            Status::Newer {
                stored: 2,
                installed: 1
            }
        ));
        assert_eq!(
            render(&reg(1), &block(2, json!({"objective": "x"})), &ext).source,
            "fallback"
        );
    }

    #[test]
    fn expand_replaces_blocks_and_keeps_children() {
        let doc = json!({"content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "before"}]},
            {"type": "extBlock", "attrs": {"type": "acme.okr", "v": 1, "attrs": {"objective": "Goal"}},
             "content": [{"type": "paragraph", "content": [{"type": "text", "text": "child"}]}]}
        ]});
        let out = expand(&doc, &reg(1));
        let types: Vec<&str> = out["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["type"].as_str().unwrap())
            .collect();
        assert_eq!(types, ["paragraph", "paragraph", "paragraph"]);
        assert_eq!(crate::export::plain_text(&out["content"][1]), "Goal ()");
        assert_eq!(crate::export::plain_text(&out["content"][2]), "child");
        assert_eq!(requires(&doc), [json!({"type": "acme.okr", "v": 1})]);
    }
}
