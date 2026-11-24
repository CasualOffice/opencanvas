// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Block schema validation (MOD-01, docs/15 §4.1).
//!
//! Checks a canvas (as `document.json`) against the schema the web editor declares: every
//! known node type, its attributes and their value types, the child content rules, marks,
//! database and board structure, and ids. Anything a newer client may have written (an
//! unknown node, mark, attribute, field type or shape type) is a **warning**, never an
//! error: it is kept as is (forward compatibility, FC-01/02). Errors are what a reader
//! cannot represent faithfully; a `.ocanvas` with errors is refused, and so are REST
//! patches, imports and MCP writes.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde_json::{Map, Value};
use yrs::Doc;

/// One finding, with a JSON-pointer-style path to the offending node (`/content/3/content/0`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Issue {
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for Issue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Report {
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
}

impl Report {
    pub fn is_ok(&self) -> bool {
        self.errors.is_empty()
    }
    /// The first error as `path: message`, for API and file-read messages.
    pub fn first_error(&self) -> Option<String> {
        self.errors.first().map(ToString::to_string)
    }
    fn err(&mut self, path: &str, msg: impl Into<String>) {
        self.errors.push(Issue {
            path: path.to_string(),
            message: msg.into(),
        });
    }
    fn warn(&mut self, path: &str, msg: impl Into<String>) {
        self.warnings.push(Issue {
            path: path.to_string(),
            message: msg.into(),
        });
    }
}

static WARNINGS_TOTAL: AtomicU64 = AtomicU64::new(0);

/// Warnings seen by [`record`] since start (the server's `oc_schema_warnings_total`).
pub fn warnings_total() -> u64 {
    WARNINGS_TOTAL.load(Ordering::Relaxed)
}

/// Counts a report's warnings in [`warnings_total`] and returns the report.
pub fn record(report: Report) -> Report {
    WARNINGS_TOTAL.fetch_add(report.warnings.len() as u64, Ordering::Relaxed);
    report
}

/// Validates a live document.
pub fn validate(doc: &Doc) -> Report {
    validate_json(&crate::doc_to_json(doc))
}

/// Validates a whole `document.json` (`{type:"doc", content, meta, databases, boards, comments}`).
/// SDK blocks are checked against the packages this process installed ([`crate::ext::install`]).
pub fn validate_json(v: &Value) -> Report {
    validate_json_with(v, &crate::ext::installed())
}

/// [`validate_json`] against an explicit block registry.
pub fn validate_json_with(v: &Value, reg: &crate::ext::Registry) -> Report {
    let mut cx = Cx {
        reg: Some(reg.clone()),
        ext: Some(v.get("ext").cloned().unwrap_or(Value::Null)),
        ..Cx::default()
    };
    let Some(obj) = v.as_object() else {
        cx.r.err("", "the document must be a JSON object");
        return cx.r;
    };
    if let Some(t) = obj.get("type")
        && t != "doc"
    {
        cx.r.err("/type", "the document type must be \"doc\"");
    }
    match obj.get("content") {
        None => {}
        Some(Value::Array(nodes)) => cx.children("/content", nodes, &Content::Blocks(0), "doc"),
        Some(_) => cx.r.err("/content", "content must be an array"),
    }
    if let Some(ext) = obj.get("ext") {
        crate::ext::check_root(ext, &mut |p, m| cx.r.err(&p, m));
    }
    for key in ["meta", "databases", "boards", "comments", "people"] {
        if obj.get(key).is_some_and(|m| !m.is_object()) {
            cx.r.err(&format!("/{key}"), format!("{key} must be an object"));
        }
    }
    if let Some(Value::Object(meta)) = obj.get("meta") {
        for k in ["title", "icon", "tone", "template"] {
            if meta.get(k).is_some_and(|t| !t.is_string() && !t.is_null()) {
                cx.r.err(&format!("/meta/{k}"), format!("meta.{k} must be a string"));
            }
        }
    }
    let dbs = obj.get("databases").and_then(Value::as_object);
    let boards = obj.get("boards").and_then(Value::as_object);
    if let Some(dbs) = dbs {
        for (id, db) in dbs {
            database(&mut cx.r, &format!("/databases/{}", esc(id)), db);
        }
    }
    if let Some(boards) = boards {
        for (id, b) in boards {
            board(&mut cx.r, &format!("/boards/{}", esc(id)), b);
        }
    }
    if let Some(Value::Object(threads)) = obj.get("comments") {
        for (id, th) in threads {
            let p = format!("/comments/{}", esc(id));
            match th {
                Value::Object(t) => {
                    if t.get("messages").is_some_and(|m| !m.is_array()) {
                        cx.r.err(&format!("{p}/messages"), "messages must be an array");
                    }
                }
                _ => cx.r.err(&p, "a comment thread must be an object"),
            }
        }
    }
    // Blocks that point at a database or board the document doesn't have.
    for (path, id) in std::mem::take(&mut cx.db_refs) {
        if !dbs.is_some_and(|d| d.contains_key(&id)) {
            cx.r.warn(&path, format!("database {id:?} is not in databases"));
        }
    }
    for (path, id) in std::mem::take(&mut cx.board_refs) {
        if !boards.is_some_and(|b| b.contains_key(&id)) {
            cx.r.warn(&path, format!("board {id:?} is not in boards"));
        }
    }
    cx.r
}

/// Validates block nodes on their own (patch and import input), paths `/<i>/content/…`
/// under `prefix`. Each root may be any known node (a patch can replace a list item), but
/// everything inside it must follow the schema.
pub fn validate_blocks(prefix: &str, blocks: &[Value]) -> Report {
    validate_blocks_with(prefix, blocks, &crate::ext::installed())
}

/// [`validate_blocks`] against an explicit block registry. SDK block data is not checked here
/// (patch input carries none); the writer checks it with the `ext` root it writes.
pub fn validate_blocks_with(prefix: &str, blocks: &[Value], reg: &crate::ext::Registry) -> Report {
    let mut cx = Cx {
        reg: Some(reg.clone()),
        ..Cx::default()
    };
    for (i, b) in blocks.iter().enumerate() {
        cx.node(&format!("{prefix}/{i}"), b);
    }
    cx.r
}

// ------------------------------------------------------------------ schema

const TONES: &[&str] = &["gray", "red", "amber", "green", "blue", "purple", "pink"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// In the `block` group: allowed wherever blocks are.
    Block,
    /// Inline content of a textblock.
    Inline,
    /// Only inside a specific parent (listItem, tableRow, toggleSummary, column, …).
    Part,
}

enum Content {
    None,
    /// Text and inline nodes, any marks.
    Inline,
    /// Plain text only (codeBlock).
    Text,
    /// Block-group nodes, at least `n`.
    Blocks(usize),
    /// Only these types, at least `n`.
    Only(&'static [&'static str], usize),
    /// Exactly this sequence.
    Seq(&'static [&'static str]),
}

#[derive(Clone, Copy)]
enum A {
    Str,
    /// Non-empty string (ids).
    Id,
    Bool,
    Int(i64, i64),
    Num(f64, f64),
    /// A number or a numeric string (image width).
    NumLike,
    Enum(&'static [&'static str]),
    /// Unknown values are kept but ignored by the editor: a warning.
    Soft(&'static [&'static str]),
    Date,
    Widths,
    Colwidth,
    Any,
}

struct Spec {
    kind: Kind,
    attrs: &'static [(&'static str, A)],
    content: Content,
    block_id: bool,
}

const fn s(
    kind: Kind,
    attrs: &'static [(&'static str, A)],
    content: Content,
    block_id: bool,
) -> Spec {
    Spec {
        kind,
        attrs,
        content,
        block_id,
    }
}

const CELL: &[(&str, A)] = &[
    ("colspan", A::Int(1, 1000)),
    ("rowspan", A::Int(1, 1000)),
    ("colwidth", A::Colwidth),
];

fn spec(ty: &str) -> Option<Spec> {
    use Content as C;
    use Kind::*;
    Some(match ty {
        "paragraph" => s(Block, &[], C::Inline, true),
        "heading" => s(Block, &[("level", A::Int(1, 3))], C::Inline, true),
        "bulletList" => s(Block, &[], C::Only(&["listItem"], 1), true),
        "orderedList" => s(
            Block,
            &[("start", A::Int(i64::MIN, i64::MAX)), ("type", A::Str)],
            C::Only(&["listItem"], 1),
            true,
        ),
        "listItem" => s(Part, &[], C::Blocks(1), true),
        "taskList" => s(Block, &[], C::Only(&["taskItem"], 1), true),
        "taskItem" => s(Part, &[("checked", A::Bool)], C::Blocks(1), true),
        "blockquote" => s(Block, &[], C::Blocks(1), true),
        "codeBlock" => s(Block, &[("language", A::Str)], C::Text, true),
        "horizontalRule" => s(Block, &[], C::None, true),
        "image" => s(
            Block,
            &[
                ("src", A::Str),
                ("alt", A::Str),
                ("title", A::Str),
                ("caption", A::Str),
                ("width", A::NumLike),
                ("align", A::Enum(&["left", "right"])),
                ("upload", A::Any),
            ],
            C::None,
            true,
        ),
        "callout" => s(
            Block,
            &[("tone", A::Soft(TONES)), ("icon", A::Str)],
            C::Only(&["paragraph"], 1),
            true,
        ),
        "toggle" => s(
            Block,
            &[("open", A::Bool)],
            C::Seq(&["toggleSummary", "toggleContent"]),
            true,
        ),
        "toggleSummary" => s(Part, &[], C::Inline, false),
        "toggleContent" => s(Part, &[], C::Blocks(1), false),
        "database" => s(Block, &[("dbId", A::Id)], C::None, true),
        "board" => s(Block, &[("boardId", A::Id)], C::None, true),
        "bookmark" => s(
            Block,
            &[
                ("url", A::Str),
                ("title", A::Str),
                ("description", A::Str),
                ("site", A::Str),
            ],
            C::None,
            true,
        ),
        "embed" => s(
            Block,
            &[("provider", A::Str), ("url", A::Str), ("title", A::Str)],
            C::None,
            true,
        ),
        "fileAttachment" => s(
            Block,
            &[
                ("name", A::Str),
                ("size", A::Num(0.0, f64::MAX)),
                ("url", A::Str),
                ("mime", A::Str),
                ("display", A::Enum(&["card", "preview"])),
                ("height", A::Num(240.0, 1600.0)),
                ("upload", A::Any),
            ],
            C::None,
            true,
        ),
        "columns" => s(
            Block,
            &[("widths", A::Widths)],
            C::Only(&["column"], 1),
            true,
        ),
        "column" => s(Part, &[("title", A::Str)], C::Blocks(1), false),
        "table" => s(Block, &[], C::Only(&["tableRow"], 1), true),
        "tableRow" => s(Part, &[], C::Only(&["tableCell", "tableHeader"], 1), false),
        "tableCell" | "tableHeader" => s(Part, CELL, C::Blocks(1), false),
        "hardBreak" => s(Inline, &[], C::None, false),
        "mention" => s(
            Inline,
            &[
                ("id", A::Id),
                ("label", A::Str),
                ("mentionSuggestionChar", A::Str),
            ],
            C::None,
            false,
        ),
        "dateMention" => s(Inline, &[("date", A::Date)], C::None, false),
        // BSDK-02: every SDK block (docs/15 §4.2); `crate::ext::check` checks its attributes.
        "extBlock" => s(
            Block,
            &[
                ("type", A::Any),
                ("v", A::Any),
                ("attrs", A::Any),
                ("dataId", A::Any),
                ("fallback", A::Any),
            ],
            C::Blocks(0),
            true,
        ),
        _ => return None,
    })
}

fn mark_attrs(ty: &str) -> Option<&'static [(&'static str, A)]> {
    Some(match ty {
        "bold" | "italic" | "underline" | "strike" | "code" => &[],
        "link" => &[
            ("href", A::Str),
            ("target", A::Str),
            ("rel", A::Str),
            ("class", A::Str),
            ("title", A::Str),
        ],
        "highlight" => &[("color", A::Str)],
        "commentMark" => &[("threadId", A::Id)],
        "textColor" => &[("color", A::Soft(TONES))],
        _ => return None,
    })
}

// ------------------------------------------------------------------ content walk

/// Deepest node nesting the validator walks (as `html::MAX_DEPTH`): deeper content is an
/// error, not a stack overflow (SEC-29 class).
const MAX_NEST: usize = 64;

#[derive(Default)]
struct Cx {
    r: Report,
    /// Installed SDK blocks (`None`: an empty registry).
    reg: Option<crate::ext::Registry>,
    /// The document's `ext` root; `None` for patch input (no data to check).
    ext: Option<Value>,
    depth: usize,
    block_ids: HashMap<String, String>,
    db_refs: Vec<(String, String)>,
    board_refs: Vec<(String, String)>,
}

fn type_of(v: &Value) -> Option<&str> {
    v.get("type")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
}

impl Cx {
    fn children(&mut self, path: &str, nodes: &[Value], rule: &Content, parent: &str) {
        let min = match rule {
            Content::Blocks(n) | Content::Only(_, n) => *n,
            _ => 0,
        };
        if nodes.len() < min {
            self.r
                .err(path, format!("{parent} needs at least {min} child node"));
        }
        if let Content::Seq(seq) = rule {
            let types: Vec<&str> = nodes.iter().filter_map(type_of).collect();
            if types != *seq {
                self.r.err(
                    path,
                    format!("{parent} must contain exactly {}", seq.join(", ")),
                );
            }
        }
        for (i, child) in nodes.iter().enumerate() {
            let p = format!("{path}/{i}");
            let Some(ty) = type_of(child) else {
                self.node(&p, child); // reports the missing type / non-object
                continue;
            };
            let known = if ty == "text" {
                Some(Kind::Inline)
            } else {
                spec(ty).map(|s| s.kind)
            };
            if let Some(kind) = known {
                let ok = match rule {
                    Content::None => false,
                    Content::Inline => kind == Kind::Inline,
                    Content::Text => ty == "text",
                    Content::Blocks(_) => kind == Kind::Block,
                    Content::Only(list, _) => list.contains(&ty),
                    Content::Seq(_) => true, // checked above
                };
                if !ok && parent == "doc" && kind == Kind::Inline {
                    // Bare text at the top level: server-side tools and test harnesses have
                    // always written it and exports read it. Kept, not refused; the editor
                    // (ProseMirror's `block+`) may not show it.
                    self.r
                        .warn(&p, format!("{ty} at the top level, outside a block (kept)"));
                } else if !ok {
                    self.r
                        .err(&p, format!("{ty} is not allowed inside {parent}"));
                }
                if matches!(rule, Content::Text) && child.get("marks").is_some() {
                    self.r
                        .err(&p, format!("text inside {parent} can't have marks"));
                }
            }
            self.node(&p, child);
        }
    }

    fn node(&mut self, path: &str, v: &Value) {
        if self.depth >= MAX_NEST {
            self.r.err(
                path,
                format!("content is nested more than {MAX_NEST} levels"),
            );
            return;
        }
        self.depth += 1;
        self.node_inner(path, v);
        self.depth -= 1;
    }

    fn node_inner(&mut self, path: &str, v: &Value) {
        let Some(obj) = v.as_object() else {
            self.r.err(path, "a node must be an object");
            return;
        };
        let Some(ty) = type_of(v) else {
            self.r.err(path, "a node needs a string \"type\"");
            return;
        };
        let attrs = match obj.get("attrs") {
            None | Some(Value::Null) => None,
            Some(Value::Object(a)) => Some(a),
            Some(_) => {
                self.r
                    .err(&format!("{path}/attrs"), "attrs must be an object");
                None
            }
        };
        let content = match obj.get("content") {
            None | Some(Value::Null) => None,
            Some(Value::Array(c)) => Some(c),
            Some(_) => {
                self.r
                    .err(&format!("{path}/content"), "content must be an array");
                None
            }
        };
        if ty == "text" {
            return self.text(path, obj);
        }
        let Some(spec) = spec(ty) else {
            self.r
                .warn(path, format!("unknown node type {ty:?} (kept as is)"));
            if let Some(c) = content {
                for (i, child) in c.iter().enumerate() {
                    self.node(&format!("{path}/content/{i}"), child);
                }
            }
            return;
        };
        if let Some(a) = attrs {
            self.attrs(path, ty, a, spec.attrs, spec.block_id);
        }
        if ty == crate::ext::NODE {
            let reg = self.reg.take().unwrap_or_default();
            let (mut errs, mut warns) = (Vec::new(), Vec::new());
            crate::ext::check(
                &reg,
                path,
                attrs,
                self.ext.as_ref(),
                &mut |p, m| errs.push((p, m)),
                &mut |p, m| warns.push((p, m)),
            );
            self.reg = Some(reg);
            for (p, m) in errs {
                self.r.err(&p, m);
            }
            for (p, m) in warns {
                self.r.warn(&p, m);
            }
        }
        let c = content.map(Vec::as_slice).unwrap_or_default();
        self.children(&format!("{path}/content"), c, &spec.content, ty);
        if ty == "columns" {
            self.columns(path, attrs, c.len());
        }
    }

    fn attrs(
        &mut self,
        path: &str,
        ty: &str,
        attrs: &Map<String, Value>,
        known: &[(&str, A)],
        block_id: bool,
    ) {
        for (k, v) in attrs {
            let p = format!("{path}/attrs/{}", esc(k));
            if block_id && k == crate::patch::BLOCK_ID {
                match v {
                    Value::Null => {}
                    Value::String(id) if !id.is_empty() => {
                        if let Some(first) = self.block_ids.insert(id.clone(), path.to_string()) {
                            self.r
                                .warn(&p, format!("blockId {id:?} is also used at {first}"));
                        }
                    }
                    _ => self.r.err(&p, "blockId must be a non-empty string"),
                }
                continue;
            }
            match known.iter().find(|(n, _)| n == k) {
                Some((_, a)) => check_attr(&mut self.r, &p, ty, k, *a, v),
                None => self
                    .r
                    .warn(&p, format!("unknown attribute {k:?} on {ty} (kept as is)")),
            }
            if let Value::String(id) = v {
                match (ty, k.as_str()) {
                    ("database", "dbId") => self.db_refs.push((p.clone(), id.clone())),
                    ("board", "boardId") => self.board_refs.push((p.clone(), id.clone())),
                    _ => {}
                }
            }
        }
    }

    fn columns(&mut self, path: &str, attrs: Option<&Map<String, Value>>, n: usize) {
        if !(2..=4).contains(&n) {
            self.r.warn(
                path,
                format!("columns has {n} columns (the editor uses 2-4)"),
            );
        }
        if let Some(w) = attrs.and_then(|a| a.get("widths")).and_then(Value::as_str) {
            let count = w.split(',').count();
            if count != n {
                self.r.warn(
                    &format!("{path}/attrs/widths"),
                    format!("widths lists {count} columns but there are {n} (read as equal)"),
                );
            }
        }
    }

    fn text(&mut self, path: &str, obj: &Map<String, Value>) {
        match obj.get("text") {
            Some(Value::String(t)) if !t.is_empty() => {}
            _ => self
                .r
                .err(path, "a text node needs a non-empty string \"text\""),
        }
        if obj.get("content").is_some() {
            self.r.err(path, "a text node can't have content");
        }
        let marks = match obj.get("marks") {
            None | Some(Value::Null) => return,
            Some(Value::Array(m)) => m,
            Some(_) => {
                return self
                    .r
                    .err(&format!("{path}/marks"), "marks must be an array");
            }
        };
        for (i, m) in marks.iter().enumerate() {
            let p = format!("{path}/marks/{i}");
            let Some(ty) = type_of(m) else {
                self.r.err(&p, "a mark needs a string \"type\"");
                continue;
            };
            let Some(known) = mark_attrs(ty) else {
                self.r
                    .warn(&p, format!("unknown mark type {ty:?} (kept as is)"));
                continue;
            };
            match m.get("attrs") {
                None | Some(Value::Null) => {}
                Some(Value::Object(a)) => {
                    for (k, v) in a {
                        let ap = format!("{p}/attrs/{}", esc(k));
                        match known.iter().find(|(n, _)| n == k) {
                            Some((_, kind)) => check_attr(&mut self.r, &ap, ty, k, *kind, v),
                            None => self
                                .r
                                .warn(&ap, format!("unknown attribute {k:?} on {ty} (kept as is)")),
                        }
                    }
                }
                Some(_) => self.r.err(&format!("{p}/attrs"), "attrs must be an object"),
            }
        }
    }
}

fn as_int(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
}

pub(crate) fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |r: std::ops::Range<usize>| s.get(r).and_then(|x| x.parse::<u32>().ok());
    let (Some(_), Some(m), Some(d)) = (num(0..4), num(5..7), num(8..10)) else {
        return false;
    };
    s[..4].bytes().all(|c| c.is_ascii_digit()) && (1..=12).contains(&m) && (1..=31).contains(&d)
}

fn check_attr(r: &mut Report, p: &str, ty: &str, k: &str, a: A, v: &Value) {
    if v.is_null() {
        return; // null = the schema default
    }
    let bad = |r: &mut Report, what: &str| r.err(p, format!("{ty}.{k} must be {what}"));
    match a {
        A::Any => {}
        A::Str => {
            if !v.is_string() {
                bad(r, "a string");
            }
        }
        A::Id => {
            if !v.as_str().is_some_and(|s| !s.is_empty()) {
                bad(r, "a non-empty string");
            }
        }
        A::Bool => {
            if !v.is_boolean() {
                bad(r, "true or false");
            }
        }
        A::Int(lo, hi) => {
            if !as_int(v).is_some_and(|n| (lo..=hi).contains(&n)) {
                if lo == i64::MIN {
                    bad(r, "an integer");
                } else {
                    bad(r, &format!("an integer {lo}-{hi}"));
                }
            }
        }
        A::Num(lo, hi) => {
            if !v.as_f64().is_some_and(|n| n >= lo && n <= hi) {
                if hi == f64::MAX {
                    bad(r, &format!("a number ≥ {lo}"));
                } else {
                    bad(r, &format!("a number {lo}-{hi}"));
                }
            }
        }
        A::NumLike => {
            let ok = v.is_number() || v.as_str().is_some_and(|s| s.trim().parse::<f64>().is_ok());
            if !ok {
                bad(r, "a number");
            }
        }
        A::Enum(set) => {
            if !v.as_str().is_some_and(|s| set.contains(&s)) {
                bad(r, &format!("one of {}", set.join(", ")));
            }
        }
        A::Soft(set) => match v.as_str() {
            Some(s) if set.contains(&s) => {}
            Some(s) => r.warn(
                p,
                format!("{ty}.{k} {s:?} is not one of {} (ignored)", set.join(", ")),
            ),
            None => bad(r, "a string"),
        },
        A::Date => {
            if !v.as_str().is_some_and(is_date) {
                bad(r, "a YYYY-MM-DD date");
            }
        }
        A::Widths => {
            let ok = v.as_str().is_some_and(|s| {
                s.split(',').all(|w| {
                    w.trim()
                        .parse::<u32>()
                        .is_ok_and(|n| (1..=100).contains(&n))
                })
            });
            if !ok {
                bad(r, "whole percents separated by commas (\"25,75\")");
            }
        }
        A::Colwidth => {
            let ok = v.as_array().is_some_and(|a| {
                a.iter()
                    .all(|w| w.is_null() || w.as_f64().is_some_and(|n| n >= 0.0))
            });
            if !ok {
                bad(r, "an array of widths");
            }
        }
    }
}

/// JSON-pointer escaping of one key.
fn esc(k: &str) -> String {
    k.replace('~', "~0").replace('/', "~1")
}

// ------------------------------------------------------------------ databases and boards

const FIELD_TYPES: &[&str] = &[
    "title", "text", "status", "select", "tags", "person", "date", "number", "checkbox", "url",
    "progress",
];

fn database(r: &mut Report, p: &str, db: &Value) {
    let Some(db) = db.as_object() else {
        return r.err(p, "a database must be an object");
    };
    for k in ["name", "icon", "tone", "view"] {
        if db.get(k).is_some_and(|v| !v.is_string() && !v.is_null()) {
            r.err(
                &format!("{p}/{k}"),
                format!("database {k} must be a string"),
            );
        }
    }
    let mut field_ids = HashSet::new();
    match db.get("fields") {
        None | Some(Value::Null) => {}
        Some(Value::Array(fields)) => {
            for (i, f) in fields.iter().enumerate() {
                let fp = format!("{p}/fields/{i}");
                let Some(f) = f.as_object() else {
                    r.err(&fp, "a field must be an object");
                    continue;
                };
                match f.get("id").and_then(Value::as_str) {
                    Some(id) if !id.is_empty() => {
                        if !field_ids.insert(id.to_string()) {
                            r.err(
                                &format!("{fp}/id"),
                                format!("field id {id:?} is used twice"),
                            );
                        }
                    }
                    _ => r.err(&format!("{fp}/id"), "a field needs a non-empty string id"),
                }
                for k in ["name", "description"] {
                    if f.get(k).is_some_and(|v| !v.is_string() && !v.is_null()) {
                        r.err(&format!("{fp}/{k}"), format!("field {k} must be a string"));
                    }
                }
                match f.get("type") {
                    None | Some(Value::Null) => {}
                    Some(Value::String(t)) if FIELD_TYPES.contains(&t.as_str()) => {}
                    Some(Value::String(t)) => r.warn(
                        &format!("{fp}/type"),
                        format!("unknown field type {t:?} (kept, shown as text)"),
                    ),
                    Some(_) => r.err(&format!("{fp}/type"), "field type must be a string"),
                }
                options(r, &format!("{fp}/options"), f.get("options"));
            }
        }
        Some(_) => r.err(&format!("{p}/fields"), "fields must be an array"),
    }
    let rows = match db.get("rows") {
        None | Some(Value::Null) => None,
        Some(Value::Object(rows)) => {
            for (id, row) in rows {
                if !row.is_object() {
                    r.err(&format!("{p}/rows/{}", esc(id)), "a row must be an object");
                }
            }
            Some(rows)
        }
        Some(_) => {
            r.err(&format!("{p}/rows"), "rows must be an object");
            None
        }
    };
    match db.get("order") {
        None | Some(Value::Null) => {}
        Some(Value::Array(order)) => {
            for (i, id) in order.iter().enumerate() {
                let op = format!("{p}/order/{i}");
                match id.as_str() {
                    None => r.err(&op, "order must list row ids (strings)"),
                    Some(id) if !rows.is_some_and(|rs| rs.contains_key(id)) => {
                        r.warn(&op, format!("row {id:?} is not in rows (skipped)"))
                    }
                    _ => {}
                }
            }
        }
        Some(_) => r.err(&format!("{p}/order"), "order must be an array"),
    }
    for k in ["notes", "views"] {
        if db.get(k).is_some_and(|v| !v.is_object() && !v.is_null()) {
            r.err(
                &format!("{p}/{k}"),
                format!("database {k} must be an object"),
            );
        }
    }
}

fn options(r: &mut Report, p: &str, v: Option<&Value>) {
    let parsed;
    let list = match v {
        None | Some(Value::Null) => return,
        Some(Value::Array(a)) => a,
        // Older writers stored the options as a JSON string.
        Some(Value::String(s)) => match serde_json::from_str::<Value>(s) {
            Ok(Value::Array(a)) => {
                parsed = a;
                &parsed
            }
            _ => return r.err(p, "options must be an array of {v, c}"),
        },
        Some(_) => return r.err(p, "options must be an array of {v, c}"),
    };
    for (i, o) in list.iter().enumerate() {
        if !o.get("v").is_some_and(Value::is_string) {
            r.err(&format!("{p}/{i}"), "an option needs a string \"v\"");
        }
    }
}

const SHAPE_TYPES: &[&str] = &[
    "sticky", "rect", "ellipse", "diamond", "text", "arrow", "pen", "swatch", "image",
];

fn board(r: &mut Report, p: &str, b: &Value) {
    let Some(b) = b.as_object() else {
        return r.err(p, "a board must be an object");
    };
    let shapes = match b.get("shapes") {
        None | Some(Value::Null) => None,
        Some(Value::Object(s)) => Some(s),
        Some(_) => {
            r.err(&format!("{p}/shapes"), "shapes must be an object");
            None
        }
    };
    for (id, sh) in shapes.into_iter().flatten() {
        shape(r, &format!("{p}/shapes/{}", esc(id)), sh);
    }
    match b.get("order") {
        None | Some(Value::Null) => {}
        Some(Value::Array(order)) => {
            for (i, id) in order.iter().enumerate() {
                let op = format!("{p}/order/{i}");
                match id.as_str() {
                    None => r.err(&op, "order must list shape ids (strings)"),
                    Some(id) if !shapes.is_some_and(|s| s.contains_key(id)) => {
                        r.warn(&op, format!("shape {id:?} is not in shapes (skipped)"))
                    }
                    _ => {}
                }
            }
        }
        Some(_) => r.err(&format!("{p}/order"), "order must be an array"),
    }
}

fn shape(r: &mut Report, p: &str, sh: &Value) {
    let Some(sh) = sh.as_object() else {
        return r.err(p, "a shape must be an object");
    };
    match sh.get("type").and_then(Value::as_str) {
        Some(t) if SHAPE_TYPES.contains(&t) => {}
        Some(t) => r.warn(
            &format!("{p}/type"),
            format!("unknown shape type {t:?} (kept; exports draw its box as a rect)"),
        ),
        None => r.err(&format!("{p}/type"), "a shape needs a string type"),
    }
    for k in ["x", "y", "w", "h", "size"] {
        if sh.get(k).is_some_and(|v| !v.is_number() && !v.is_null()) {
            r.err(&format!("{p}/{k}"), format!("shape {k} must be a number"));
        }
    }
    for k in ["pts", "via"] {
        let ok = match sh.get(k) {
            None | Some(Value::Null) => true,
            Some(Value::Array(pts)) => pts.iter().all(|pt| {
                pt.as_array()
                    .is_some_and(|xy| xy.len() >= 2 && xy.iter().all(Value::is_number))
            }),
            Some(_) => false,
        };
        // `via` reads bad entries as missing (docs/15 §4), so only `pts` is an error.
        if !ok {
            if k == "pts" {
                r.err(
                    &format!("{p}/{k}"),
                    "pts must be an array of [x, y] numbers",
                );
            } else {
                r.warn(
                    &format!("{p}/{k}"),
                    "via has entries that aren't [x, y] (ignored)",
                );
            }
        }
    }
    for k in ["start", "end"] {
        match sh.get(k) {
            None | Some(Value::Null) => {}
            Some(Value::Object(e)) if e.get("shapeId").is_some_and(Value::is_string) => {}
            Some(_) => r.err(
                &format!("{p}/{k}"),
                format!("{k} must be {{shapeId, anchor}}"),
            ),
        }
    }
    for k in [
        "text", "fill", "stroke", "label", "group", "route", "src", "alt",
    ] {
        if sh.get(k).is_some_and(|v| !v.is_string() && !v.is_null()) {
            r.err(&format!("{p}/{k}"), format!("shape {k} must be a string"));
        }
    }
}
