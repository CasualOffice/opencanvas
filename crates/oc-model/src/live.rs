// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Portable live blocks (LIVE-02, docs/27 §2, ADR-039; docs/15 §4.4).
//!
//! Two nodes reference content that lives in another host file and is never copied into this
//! document's CRDT:
//!
//! - `liveBlock {blockId, fileId, hostId?, kind, title, snapshot?, snapshotAt?}`: a whole
//!   live file (`meta.kind = "live"`), opened as its own room;
//! - `blockRef {blockId, fileId, refBlockId, title, snapshot?, snapshotAt?}`: a read-only
//!   projection of one block of another canvas.
//!
//! Both are atoms (no content). A live file may contain neither (the depth rule), and a
//! canvas holds at most [`MAX_REFS`] of them. `snapshot` is `{"markdown": "…"}` (at most
//! [`SNAPSHOT_MAX`] bytes) and only present when the host's `[host.live] snapshot` policy is
//! `"content"`; under `"none"` the title is empty too ([`Snapshot`]).

use std::collections::HashMap;

use serde_json::{Map, Value, json};

/// The live block node.
pub const LIVE_BLOCK: &str = "liveBlock";
/// The read-only block reference node.
pub const BLOCK_REF: &str = "blockRef";
/// Most `liveBlock` + `blockRef` nodes in one canvas (docs/27 §2.5).
pub const MAX_REFS: usize = 50;
/// Largest `snapshot` (its JSON) a node may carry (docs/27 §2.3).
pub const SNAPSHOT_MAX: usize = 64 * 1024;
/// `liveBlock.kind` values.
pub const KINDS: &[&str] = &["blocks", "database", "board"];

/// `[host.live] snapshot` (docs/27 §2.5): what of a live file may be kept in the files that
/// embed it (and so be read by anyone who can read those files outside OpenCanvas).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Snapshot {
    /// Nothing: no title, no content.
    None,
    /// The title only (default).
    #[default]
    Title,
    /// Title and a Markdown snapshot of the content.
    Content,
}

impl Snapshot {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "none" => Snapshot::None,
            "title" => Snapshot::Title,
            "content" => Snapshot::Content,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Snapshot::None => "none",
            Snapshot::Title => "title",
            Snapshot::Content => "content",
        }
    }
}

/// True for `liveBlock` and `blockRef`.
pub fn is_ref_node(ty: &str) -> bool {
    ty == LIVE_BLOCK || ty == BLOCK_REF
}

/// A `liveBlock` or `blockRef` found in a document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ref {
    /// `liveBlock` or `blockRef`.
    pub node: &'static str,
    pub block_id: String,
    pub file_id: String,
    /// `blockRef` only: the referenced block in `file_id`.
    pub ref_block_id: Option<String>,
    /// `liveBlock` only: `blocks`, `database` or `board`.
    pub kind: Option<String>,
    pub title: String,
    pub has_snapshot: bool,
}

fn attr_s(n: &Value, k: &str) -> String {
    n["attrs"][k].as_str().unwrap_or_default().to_string()
}

fn has_snapshot(n: &Value) -> bool {
    match &n["attrs"]["snapshot"] {
        Value::Null => false,
        Value::String(s) => !s.is_empty(),
        Value::Object(o) => !o.is_empty(),
        Value::Array(a) => !a.is_empty(),
        _ => true,
    }
}

fn walk<'a>(nodes: &'a [Value], depth: usize, f: &mut dyn FnMut(&'a Value)) {
    if depth > 64 {
        return;
    }
    for n in nodes {
        f(n);
        if let Some(c) = n.get("content").and_then(Value::as_array) {
            walk(c, depth + 1, f);
        }
    }
}

/// Every `liveBlock` and `blockRef` in a `document.json`, in document order.
pub fn references(doc: &Value) -> Vec<Ref> {
    let mut out = Vec::new();
    let Some(content) = doc.get("content").and_then(Value::as_array) else {
        return out;
    };
    walk(content, 0, &mut |n| {
        let ty = n["type"].as_str().unwrap_or_default();
        let node = match ty {
            LIVE_BLOCK => LIVE_BLOCK,
            BLOCK_REF => BLOCK_REF,
            _ => return,
        };
        let opt = |k: &str| Some(attr_s(n, k)).filter(|s| !s.is_empty());
        out.push(Ref {
            node,
            block_id: attr_s(n, crate::patch::BLOCK_ID),
            file_id: attr_s(n, "fileId"),
            ref_block_id: (node == BLOCK_REF).then(|| attr_s(n, "refBlockId")),
            kind: if node == LIVE_BLOCK {
                opt("kind")
            } else {
                None
            },
            title: attr_s(n, "title"),
            has_snapshot: has_snapshot(n),
        });
    });
    out
}

/// Whether the document is a live file (`meta.kind = "live"`).
pub fn is_live_file(doc: &Value) -> bool {
    doc["meta"]["kind"].as_str() == Some("live")
}

/// What a document breaks of the live block rules for `policy`, as messages (empty: none).
/// The depth rule, the reference limit, the snapshot policy and the snapshot size.
pub fn rule_errors(doc: &Value, policy: Snapshot) -> Vec<String> {
    let refs = references(doc);
    let mut errs = Vec::new();
    if refs.is_empty() {
        return errs;
    }
    if is_live_file(doc) {
        errs.push("a live file cannot contain live blocks or block references".into());
    }
    if refs.len() > MAX_REFS {
        errs.push(format!(
            "a canvas holds at most {MAX_REFS} live blocks and block references"
        ));
    }
    for r in &refs {
        if r.has_snapshot && policy != Snapshot::Content {
            errs.push(format!(
                "{} {}: this host keeps no content snapshots ([host.live] snapshot = \"{}\")",
                r.node,
                r.block_id,
                policy.as_str()
            ));
        }
        if !r.title.is_empty() && policy == Snapshot::None {
            errs.push(format!(
                "{} {}: this host keeps no titles of live blocks ([host.live] snapshot = \"none\")",
                r.node, r.block_id
            ));
        }
    }
    errs
}

/// A snapshot value for a node: `{"markdown": md}`, or `None` when it would be larger than
/// [`SNAPSHOT_MAX`].
pub fn snapshot_value(markdown: &str) -> Option<Value> {
    let v = json!({ "markdown": markdown });
    (v.to_string().len() <= SNAPSHOT_MAX).then_some(v)
}

/// What an export may show for one reference.
#[derive(Debug, Clone)]
pub enum Resolved {
    /// The exporting person can read it: the referenced content as a `document.json` (a live
    /// file, or for a `blockRef` a document whose `content` is the one block).
    Content(Value),
    /// The exporting person cannot read it (or it could not be loaded).
    NoAccess,
}

fn italic(text: &str, href: Option<&str>) -> Value {
    let mut marks = vec![json!({"type": "italic"})];
    if let Some(h) = href {
        marks.push(json!({"type": "link", "attrs": {"href": h}}));
    }
    json!({"type": "text", "text": text, "marks": marks})
}

fn caption(text: &str, href: Option<&str>) -> Value {
    json!({"type": "paragraph", "content": [italic(text, href)]})
}

fn label(r: &Value) -> String {
    let node = r["type"].as_str().unwrap_or_default();
    let title = attr_s(r, "title");
    let what = if node == BLOCK_REF {
        "Block reference"
    } else {
        "Live block"
    };
    if title.trim().is_empty() {
        what.to_string()
    } else {
        format!("{what}: {}", title.trim())
    }
}

/// Rewrites every `liveBlock` and `blockRef` of an export into ordinary blocks (LIVE-05,
/// docs/27 §2.2 "Export"): content the exporting person can read is inlined after a caption
/// "Live block: <title>" (a link when `link` gives one); anything else becomes that caption
/// with "(no access)", or the node's content snapshot when it has one. `resolve` answers per
/// node; `None` means "not resolved" (exports outside a session: the caption, or the
/// snapshot). The resolved documents' databases, boards and SDK data join the export's own
/// roots. Returns how many nodes were rewritten.
pub fn rewrite_for_export(
    doc: &mut Value,
    resolve: &dyn Fn(&Ref) -> Option<Resolved>,
    link: &dyn Fn(&str) -> Option<String>,
) -> usize {
    let refs = references(doc);
    if refs.is_empty() {
        return 0;
    }
    let mut extra: Vec<Value> = Vec::new();
    let mut answers: HashMap<String, Option<Resolved>> = HashMap::new();
    for r in &refs {
        answers.insert(key(r), resolve(r));
    }
    let mut n = 0;
    if let Some(content) = doc.get_mut("content").and_then(Value::as_array_mut) {
        rewrite_list(content, &answers, link, &mut extra, &mut n, 0);
    }
    for e in extra {
        for root in ["databases", "boards", "ext"] {
            let Some(src) = e.get(root).and_then(Value::as_object) else {
                continue;
            };
            if !doc.get(root).is_some_and(Value::is_object) {
                doc[root] = Value::Object(Map::new());
            }
            let dst = doc[root].as_object_mut().expect("an object");
            for (k, v) in src {
                dst.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
    }
    n
}

fn key(r: &Ref) -> String {
    format!(
        "{}\u{0}{}\u{0}{}\u{0}{}",
        r.node,
        r.block_id,
        r.file_id,
        r.ref_block_id.as_deref().unwrap_or_default()
    )
}

fn node_key(n: &Value) -> String {
    let node = n["type"].as_str().unwrap_or_default();
    format!(
        "{}\u{0}{}\u{0}{}\u{0}{}",
        node,
        attr_s(n, crate::patch::BLOCK_ID),
        attr_s(n, "fileId"),
        if node == BLOCK_REF {
            attr_s(n, "refBlockId")
        } else {
            String::new()
        }
    )
}

fn rewrite_list(
    list: &mut Vec<Value>,
    answers: &HashMap<String, Option<Resolved>>,
    link: &dyn Fn(&str) -> Option<String>,
    extra: &mut Vec<Value>,
    n: &mut usize,
    depth: usize,
) {
    if depth > 64 {
        return;
    }
    let mut out = Vec::with_capacity(list.len());
    for mut node in std::mem::take(list) {
        let ty = node["type"].as_str().unwrap_or_default().to_string();
        if !is_ref_node(&ty) {
            if let Some(c) = node.get_mut("content").and_then(Value::as_array_mut) {
                rewrite_list(c, answers, link, extra, n, depth + 1);
            }
            out.push(node);
            continue;
        }
        *n += 1;
        let file_id = attr_s(&node, "fileId");
        let href = link(&file_id);
        let text = label(&node);
        match answers.get(&node_key(&node)).cloned().flatten() {
            Some(Resolved::Content(d)) => {
                out.push(caption(&text, href.as_deref()));
                let mut body: Vec<Value> = d["content"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    // The depth rule: a live file holds no references; drop any that slipped in.
                    .filter(|c| !is_ref_node(c["type"].as_str().unwrap_or_default()))
                    .collect();
                out.append(&mut body);
                extra.push(d);
            }
            answer => {
                let md = node["attrs"]["snapshot"]["markdown"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty());
                match md {
                    Some(md) => {
                        let at = attr_s(&node, "snapshotAt");
                        let when = if at.is_empty() {
                            "snapshot".to_string()
                        } else {
                            format!("snapshot of {at}")
                        };
                        out.push(caption(&format!("{text} ({when})"), href.as_deref()));
                        let body = crate::import::markdown_to_json(md);
                        out.extend(
                            body["content"]
                                .as_array()
                                .cloned()
                                .unwrap_or_default()
                                .into_iter()
                                .filter(|c| !is_ref_node(c["type"].as_str().unwrap_or_default())),
                        );
                    }
                    None => {
                        let text = if matches!(answer, Some(Resolved::NoAccess)) {
                            format!("{text} (no access)")
                        } else {
                            text
                        };
                        out.push(caption(&text, href.as_deref()));
                    }
                }
            }
        }
    }
    *list = out;
}

/// The exporters' view of a document: references not yet resolved by the server become
/// their caption or snapshot ([`rewrite_for_export`] with nothing resolved). Borrowed when
/// the document has none.
pub fn expand(doc: &Value) -> std::borrow::Cow<'_, Value> {
    if references(doc).is_empty() {
        return std::borrow::Cow::Borrowed(doc);
    }
    let mut d = doc.clone();
    rewrite_for_export(&mut d, &|_| None, &|_| None);
    std::borrow::Cow::Owned(d)
}

/// The `document.json` holding one block of `doc` (by `blockId`, at any depth), with the
/// document's roots (a `blockRef` projection, LIVE-04). `None` when there is no such block.
pub fn block_document(doc: &Value, block_id: &str) -> Option<Value> {
    let mut found = None;
    if let Some(content) = doc.get("content").and_then(Value::as_array) {
        walk(content, 0, &mut |n| {
            if found.is_none() && n["attrs"][crate::patch::BLOCK_ID].as_str() == Some(block_id) {
                found = Some(n.clone());
            }
        });
    }
    let block = found?;
    let mut out = json!({"type": "doc", "content": [block]});
    for root in ["databases", "boards", "ext"] {
        if let Some(v) = doc.get(root) {
            out[root] = v.clone();
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(content: Value) -> Value {
        json!({"type": "doc", "content": content})
    }

    fn live(id: &str, file: &str, title: &str) -> Value {
        json!({"type": "liveBlock", "attrs": {"blockId": id, "fileId": file, "kind": "blocks", "title": title}})
    }

    #[test]
    fn finds_references_at_any_depth() {
        let d = doc(json!([
            live("b1", "f1", "OKRs"),
            {"type": "columns", "content": [{"type": "column", "content": [
                {"type": "blockRef", "attrs": {"blockId": "b2", "fileId": "f2", "refBlockId": "x", "title": "T"}}
            ]}]}
        ]));
        let r = references(&d);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].node, LIVE_BLOCK);
        assert_eq!(r[1].ref_block_id.as_deref(), Some("x"));
    }

    #[test]
    fn rules_depth_limit_and_snapshot_policy() {
        let mut d = doc(json!([live("b1", "f1", "OKRs")]));
        assert!(rule_errors(&d, Snapshot::Title).is_empty());
        // Depth: a live file holds no references.
        d["meta"] = json!({"kind": "live"});
        assert!(rule_errors(&d, Snapshot::Title)[0].contains("live file"));
        // Limit.
        let many: Vec<Value> = (0..=MAX_REFS)
            .map(|i| live(&format!("b{i}"), "f", "t"))
            .collect();
        let errs = rule_errors(&doc(json!(many)), Snapshot::Title);
        assert!(errs.iter().any(|e| e.contains("at most 50")), "{errs:?}");
        // Snapshot policy.
        let mut n = live("b1", "f1", "OKRs");
        n["attrs"]["snapshot"] = json!({"markdown": "secret"});
        let d = doc(json!([n]));
        assert!(!rule_errors(&d, Snapshot::Title).is_empty());
        assert!(rule_errors(&d, Snapshot::Content).is_empty());
        let d = doc(json!([live("b1", "f1", "OKRs")]));
        assert!(!rule_errors(&d, Snapshot::None).is_empty());
        assert!(rule_errors(&doc(json!([live("b1", "f1", "")])), Snapshot::None).is_empty());
    }

    #[test]
    fn export_rewrite_inlines_readable_content_and_hides_the_rest() {
        let mut d = doc(json!([
            {"type": "paragraph", "content": [{"type": "text", "text": "Before"}]},
            live("b1", "f_ok", "OKRs"),
            live("b2", "f_no", "Secret plan"),
        ]));
        let n = rewrite_for_export(
            &mut d,
            &|r| {
                Some(if r.file_id == "f_ok" {
                    Resolved::Content(
                        json!({"content": [{"type": "paragraph", "content": [{"type": "text", "text": "Ship it"}]}],
                        "databases": {"db1": {"name": "D"}}}),
                    )
                } else {
                    Resolved::NoAccess
                })
            },
            &|f| Some(format!("https://host/files/{f}")),
        );
        assert_eq!(n, 2);
        let s = d.to_string();
        assert!(s.contains("Live block: OKRs"));
        assert!(s.contains("Ship it"));
        assert!(s.contains("https://host/files/f_ok"));
        assert!(s.contains("Live block: Secret plan (no access)"));
        assert!(d["databases"]["db1"].is_object());
        assert!(references(&d).is_empty());
    }

    #[test]
    fn unresolved_nodes_show_the_snapshot_or_the_caption() {
        let mut n = live("b1", "f1", "OKRs");
        n["attrs"]["snapshot"] = json!({"markdown": "**Q1** done"});
        n["attrs"]["snapshotAt"] = json!("2026-11-26T10:00:00Z");
        let mut d = doc(json!([n, live("b2", "f2", "")]));
        rewrite_for_export(&mut d, &|_| None, &|_| None);
        let s = d.to_string();
        assert!(s.contains("snapshot of 2026-11-26T10:00:00Z"), "{s}");
        assert!(s.contains("Q1"));
        assert!(s.contains("\"Live block\""), "{s}");
    }

    #[test]
    fn validation_knows_the_nodes_and_refuses_references_in_live_files() {
        let mut n = live("b1", "f1", "OKRs");
        n["attrs"]["snapshot"] = json!({"markdown": "x"});
        let d = doc(
            json!([n, {"type": "blockRef", "attrs": {"blockId": "b2", "fileId": "f2", "refBlockId": "p", "title": ""}}]),
        );
        let r = crate::validate::validate_json(&d);
        assert!(r.is_ok(), "{:?}", r.errors);
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
        let mut live_file = d.clone();
        live_file["meta"] = json!({"kind": "live"});
        let r = crate::validate::validate_json(&live_file);
        assert!(
            r.first_error().unwrap().contains("live file"),
            "{:?}",
            r.errors
        );
        let mut big = live("b1", "f1", "OKRs");
        big["attrs"]["snapshot"] = json!({"markdown": "x".repeat(SNAPSHOT_MAX)});
        let r = crate::validate::validate_json(&doc(json!([big])));
        assert!(
            r.first_error().unwrap().contains("snapshot"),
            "{:?}",
            r.errors
        );
    }

    #[test]
    fn nodes_round_trip_through_the_crdt_and_export_as_captions() {
        let mut n = live("b1", "f1", "OKRs");
        n["attrs"]["hostId"] = json!("acme");
        n["attrs"]["snapshot"] = json!({"markdown": "kept"});
        let d = doc(json!([n]));
        let y = crate::new_doc();
        crate::import::apply_document_json(&y, &d);
        let back = crate::doc_to_json(&y);
        assert_eq!(back["content"], d["content"]);
        let md = crate::export::to_markdown(&back);
        assert!(md.contains("Live block: OKRs"), "{md}");
        let html = crate::export::to_html(&back);
        assert!(html.contains("Live block: OKRs"), "{html}");
    }

    #[test]
    fn block_document_finds_nested_blocks() {
        let d = json!({"type": "doc", "content": [{"type": "blockquote", "content": [
            {"type": "paragraph", "attrs": {"blockId": "p1"}, "content": [{"type": "text", "text": "x"}]}
        ]}], "databases": {}});
        let b = block_document(&d, "p1").unwrap();
        assert_eq!(b["content"][0]["attrs"]["blockId"], "p1");
        assert!(block_document(&d, "nope").is_none());
    }
}
