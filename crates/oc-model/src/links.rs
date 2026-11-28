// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Links between canvases (LINK-01/02, ADR-081, docs/38 §2): the `canvasLink` inline node, the
//! host URL patterns that make a pasted URL the same link, and the outgoing edges of a saved
//! `document.json` that the server's link index keeps.
//!
//! An edge is ids only: the source block, the target file, block and row, and a kind. No title,
//! label or text ever leaves this module (LINK-A3).
//!
//! `canvasLink {fileId, targetBlockId?, rowId?, label}`: the target block is `targetBlockId`,
//! not `blockId`, because `blockId` names a node's own id everywhere else (ADR-023; the patch
//! layer finds blocks by it at any depth).

use std::collections::HashSet;

use serde_json::{Value, json};

/// The inline node.
pub const CANVAS_LINK: &str = "canvasLink";
/// Most edges kept per source file; the rest are dropped and counted (docs/38 §2.3).
pub const MAX_EDGES: usize = 2000;
/// Longest id kept in an edge (file ids are host ids; block and row ids are ours).
pub const MAX_ID: usize = 1024;
/// Longest block or row id kept.
pub const MAX_BLOCK_ID: usize = 128;

/// What an edge is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Kind {
    /// A `canvasLink`, or a `link` mark whose URL matches the host's patterns.
    Link,
    /// A `liveBlock` or a `blockRef`.
    Embed,
    /// A database relation field to a database in another canvas.
    Relation,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Link => "link",
            Kind::Embed => "embed",
            Kind::Relation => "relation",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "link" => Kind::Link,
            "embed" => Kind::Embed,
            "relation" => Kind::Relation,
            _ => return None,
        })
    }
}

/// One outgoing edge: ids only. Empty strings mean "none" (the canvas itself, no row).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Edge {
    /// The block in the source that holds the link (its `blockId`; empty when it has none).
    pub src_block: String,
    pub dst_file: String,
    pub dst_block: String,
    pub dst_row: String,
    pub kind: Kind,
}

/// The edges of a document, deduplicated, in document order, at most [`MAX_EDGES`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Extracted {
    pub edges: Vec<Edge>,
    /// Edges past [`MAX_EDGES`] that were dropped.
    pub dropped: usize,
}

/// `[host.links] url_patterns`: URL templates with `{fileId}` and optionally `{blockId}`, e.g.
/// `https://docs.example.com/f/{fileId}` or `https://docs.example.com/f/{fileId}#{blockId}`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UrlPatterns {
    pats: Vec<Vec<Part>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Part {
    Lit(String),
    File,
    Block,
}

/// A host URL taken apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlTarget {
    pub file_id: String,
    pub block_id: Option<String>,
}

impl UrlPatterns {
    /// Checks each template: it must start with `https://` or `http://`, hold `{fileId}`
    /// exactly once and `{blockId}` at most once, and no two placeholders may touch.
    pub fn parse(templates: &[String]) -> Result<Self, String> {
        let mut pats = vec![];
        for t in templates {
            if !(t.starts_with("https://") || t.starts_with("http://")) {
                return Err(format!(
                    "url pattern {t:?} must start with https:// or http://"
                ));
            }
            let mut parts = vec![];
            let mut rest = t.as_str();
            while !rest.is_empty() {
                let next = [("{fileId}", Part::File), ("{blockId}", Part::Block)]
                    .into_iter()
                    .filter_map(|(k, p)| rest.find(k).map(|i| (i, k, p)))
                    .min_by_key(|(i, _, _)| *i);
                match next {
                    Some((i, k, p)) => {
                        if i > 0 {
                            parts.push(Part::Lit(rest[..i].to_string()));
                        } else if matches!(parts.last(), Some(Part::File | Part::Block)) {
                            return Err(format!("url pattern {t:?}: placeholders must not touch"));
                        }
                        parts.push(p);
                        rest = &rest[i + k.len()..];
                    }
                    None => {
                        parts.push(Part::Lit(rest.to_string()));
                        rest = "";
                    }
                }
            }
            let files = parts.iter().filter(|p| **p == Part::File).count();
            let blocks = parts.iter().filter(|p| **p == Part::Block).count();
            if files != 1 || blocks > 1 {
                return Err(format!(
                    "url pattern {t:?} needs {{fileId}} once and {{blockId}} at most once"
                ));
            }
            pats.push(parts);
        }
        Ok(Self { pats })
    }

    pub fn is_empty(&self) -> bool {
        self.pats.is_empty()
    }

    /// The file (and block) a URL names, when it matches one of the patterns. A placeholder
    /// takes the characters up to the next literal (or the end), never `/`, `?` or `#` unless
    /// the pattern ends there; values are percent-decoded.
    pub fn parse_url(&self, url: &str) -> Option<UrlTarget> {
        if url.len() > 4096 {
            return None;
        }
        'pat: for p in &self.pats {
            let mut rest = url;
            let mut file = None;
            let mut block = None;
            for (i, part) in p.iter().enumerate() {
                match part {
                    Part::Lit(l) => {
                        rest = match rest.strip_prefix(l.as_str()) {
                            Some(r) => r,
                            None => continue 'pat,
                        };
                    }
                    Part::File | Part::Block => {
                        let end = match p.get(i + 1) {
                            Some(Part::Lit(l)) => match rest.find(l.as_str()) {
                                Some(e) => e,
                                None => continue 'pat,
                            },
                            _ => rest.find(['?', '#', '/']).unwrap_or(rest.len()),
                        };
                        let v = decode(&rest[..end]);
                        if v.is_empty() || v.chars().any(|c| c == '/' || c.is_control()) {
                            continue 'pat;
                        }
                        if *part == Part::File {
                            file = Some(v);
                        } else {
                            block = Some(v);
                        }
                        rest = &rest[end..];
                    }
                }
            }
            // Anything after the pattern must be a query or a fragment, not more path.
            if !(rest.is_empty() || rest.starts_with('?') || rest.starts_with('#')) {
                continue;
            }
            return file.map(|file_id| UrlTarget {
                file_id,
                block_id: block,
            });
        }
        None
    }
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// `[host.links] url_template` filled for a link (exports): `{fileId}` and `{blockId}` are
/// percent-encoded; without a block the `{blockId}` part and one separator before it go.
pub fn host_url(template: &str, file_id: &str, block_id: Option<&str>) -> String {
    let mut s = template.replace("{fileId}", &encode(file_id));
    match block_id.filter(|b| !b.is_empty()) {
        Some(b) => s = s.replace("{blockId}", &encode(b)),
        None => {
            if let Some(i) = s.find("{blockId}") {
                let mut start = i;
                if let Some(c) = s[..i].chars().last().filter(|c| "#?&=/".contains(*c)) {
                    start -= c.len_utf8();
                    // `?block=` / `&block=`: drop the whole parameter.
                    if c == '=' {
                        start = s[..start].rfind(['?', '&']).unwrap_or(start);
                    }
                }
                s.replace_range(start..i + "{blockId}".len(), "");
            }
        }
    }
    s
}

fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}

fn ok_id(id: &str, max: usize) -> bool {
    !id.is_empty() && id.len() <= max && !id.chars().any(char::is_control)
}

struct Walk<'a> {
    patterns: &'a UrlPatterns,
    seen: HashSet<Edge>,
    out: Extracted,
}

impl Walk<'_> {
    fn push(&mut self, e: Edge) {
        if !ok_id(&e.dst_file, MAX_ID)
            || e.src_block.len() > MAX_BLOCK_ID
            || e.dst_block.len() > MAX_BLOCK_ID
            || e.dst_row.len() > MAX_BLOCK_ID
        {
            return;
        }
        if self.seen.contains(&e) {
            return;
        }
        if self.out.edges.len() >= MAX_EDGES {
            self.out.dropped += 1;
            return;
        }
        self.seen.insert(e.clone());
        self.out.edges.push(e);
    }

    fn nodes(&mut self, nodes: &[Value], block: &str, depth: usize) {
        if depth > 64 {
            return;
        }
        for n in nodes {
            let own = s(&n["attrs"], crate::patch::BLOCK_ID);
            let ty = s(n, "type");
            // The nearest enclosing node with a block id holds what is inside it. Inline nodes
            // never carry one.
            let here = if own.is_empty() || ty == CANVAS_LINK {
                block
            } else {
                own
            };
            match ty {
                CANVAS_LINK => {
                    let a = &n["attrs"];
                    self.push(Edge {
                        src_block: here.to_string(),
                        dst_file: s(a, "fileId").to_string(),
                        dst_block: s(a, "targetBlockId").to_string(),
                        dst_row: s(a, "rowId").to_string(),
                        kind: Kind::Link,
                    });
                }
                crate::live::LIVE_BLOCK => self.push(Edge {
                    src_block: here.to_string(),
                    dst_file: s(&n["attrs"], "fileId").to_string(),
                    dst_block: String::new(),
                    dst_row: String::new(),
                    kind: Kind::Embed,
                }),
                crate::live::BLOCK_REF => self.push(Edge {
                    src_block: here.to_string(),
                    dst_file: s(&n["attrs"], "fileId").to_string(),
                    dst_block: s(&n["attrs"], "refBlockId").to_string(),
                    dst_row: String::new(),
                    kind: Kind::Embed,
                }),
                "text" if !self.patterns.is_empty() => {
                    for m in n["marks"].as_array().into_iter().flatten() {
                        if s(m, "type") == "link"
                            && let Some(t) = self.patterns.parse_url(s(&m["attrs"], "href"))
                        {
                            self.push(Edge {
                                src_block: here.to_string(),
                                dst_file: t.file_id,
                                dst_block: t.block_id.unwrap_or_default(),
                                dst_row: String::new(),
                                kind: Kind::Link,
                            });
                        }
                    }
                }
                _ => {}
            }
            if let Some(c) = n.get("content").and_then(Value::as_array) {
                self.nodes(c, here, depth + 1);
            }
        }
    }
}

/// The outgoing edges of a document's logical JSON ([`crate::doc_to_json`]): `canvasLink`
/// nodes, `link` marks matching `patterns`, live blocks and block references, and relation
/// fields to a database in another canvas. Links to `self_file` (the canvas itself) are kept:
/// a block of this canvas linked from another block is a backlink like any other.
pub fn extract(doc: &Value, patterns: &UrlPatterns) -> Extracted {
    let mut w = Walk {
        patterns,
        seen: HashSet::new(),
        out: Extracted::default(),
    };
    if let Some(c) = doc.get("content").and_then(Value::as_array) {
        w.nodes(c, "", 0);
    }
    if let Some(dbs) = doc["databases"].as_object() {
        let mut ids: Vec<&String> = dbs.keys().collect();
        ids.sort();
        for id in ids {
            for f in dbs[id]["fields"].as_array().into_iter().flatten() {
                if s(f, "type") == "relation" && !s(&f["rel"], "file").is_empty() {
                    w.push(Edge {
                        src_block: id.clone(),
                        dst_file: s(&f["rel"], "file").to_string(),
                        dst_block: s(&f["rel"], "db").to_string(),
                        dst_row: String::new(),
                        kind: Kind::Relation,
                    });
                }
            }
        }
    }
    w.out
}

/// The fallback a reader without `canvasLink` shows (docs/38 §2.2 item 5): the label as text
/// with a `link` mark to the host URL.
pub fn fallback_text(attrs: &Value, template: Option<&str>) -> Value {
    let label = s(attrs, "label");
    let label = if label.is_empty() { "Canvas" } else { label };
    let block = Some(s(attrs, "targetBlockId")).filter(|b| !b.is_empty());
    match template {
        Some(t) => json!({
            "type": "text",
            "text": label,
            "marks": [{"type": "link", "attrs": {"href": host_url(t, s(attrs, "fileId"), block)}}],
        }),
        None => json!({"type": "text", "text": label}),
    }
}

/// Rewrites every `canvasLink` of a document into its fallback text (exports to formats that
/// have no such node). `template`: `[host.links] url_template`.
pub fn lower(doc: &mut Value, template: Option<&str>) {
    fn go(n: &mut Value, template: Option<&str>, depth: usize) {
        if depth > 64 {
            return;
        }
        if let Some(c) = n.get_mut("content").and_then(Value::as_array_mut) {
            for child in c.iter_mut() {
                if s(child, "type") == CANVAS_LINK {
                    *child = fallback_text(&child["attrs"], template);
                } else {
                    go(child, template, depth + 1);
                }
            }
        }
    }
    go(doc, template, 0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pats() -> UrlPatterns {
        UrlPatterns::parse(&[
            "https://docs.acme.test/f/{fileId}#{blockId}".into(),
            "https://docs.acme.test/f/{fileId}".into(),
        ])
        .unwrap()
    }

    fn link(file: &str, block: &str) -> Value {
        json!({"type": "canvasLink", "attrs": {"fileId": file, "targetBlockId": block, "label": "MARKER-LABEL"}})
    }

    #[test]
    fn extracts_links_embeds_relations_and_matching_urls() {
        let doc = json!({
            "meta": {"title": "MARKER-TITLE"},
            "content": [
                {"type": "heading", "attrs": {"blockId": "h1"}, "content": [
                    {"type": "text", "text": "MARKER-TEXT "},
                    link("f2", "b9"),
                    {"type": "text", "text": "x", "marks": [{"type": "link", "attrs": {"href": "https://docs.acme.test/f/f3"}}]},
                    {"type": "text", "text": "y", "marks": [{"type": "link", "attrs": {"href": "https://elsewhere.test/f/f4"}}]},
                ]},
                {"type": "paragraph", "content": [link("f2", "b9"), link("f5", "")]},
                {"type": "liveBlock", "attrs": {"blockId": "l1", "fileId": "f6", "title": "MARKER"}},
                {"type": "blockRef", "attrs": {"blockId": "r1", "fileId": "f7", "refBlockId": "p3", "title": "MARKER"}},
            ],
            "databases": {"d1": {"fields": [
                {"id": "a", "type": "relation", "rel": {"db": "k", "file": "f8"}},
                {"id": "b", "type": "relation", "rel": {"db": "local"}},
            ]}},
        });
        let e = extract(&doc, &pats());
        let got: Vec<(&str, &str, &str, &str)> = e
            .edges
            .iter()
            .map(|e| {
                (
                    e.src_block.as_str(),
                    e.dst_file.as_str(),
                    e.dst_block.as_str(),
                    e.kind.as_str(),
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                ("h1", "f2", "b9", "link"),
                ("h1", "f3", "", "link"),
                ("", "f2", "b9", "link"),
                ("", "f5", "", "link"),
                ("l1", "f6", "", "embed"),
                ("r1", "f7", "p3", "embed"),
                ("d1", "f8", "k", "relation"),
            ]
        );
        // LINK-A3: no text reaches an edge.
        assert!(!format!("{:?}", e).contains("MARKER"));
    }

    #[test]
    fn caps_edges_and_counts_the_rest() {
        let links: Vec<Value> = (0..MAX_EDGES + 5)
            .map(|i| link(&format!("f{i}"), ""))
            .collect();
        let doc = json!({"content": [{"type": "paragraph", "content": links}]});
        let e = extract(&doc, &UrlPatterns::default());
        assert_eq!(e.edges.len(), MAX_EDGES);
        assert_eq!(e.dropped, 5);
    }

    #[test]
    fn url_patterns_match_and_refuse() {
        let p = pats();
        assert_eq!(
            p.parse_url("https://docs.acme.test/f/abc%20d#blk"),
            Some(UrlTarget {
                file_id: "abc d".into(),
                block_id: Some("blk".into())
            })
        );
        assert_eq!(
            p.parse_url("https://docs.acme.test/f/abc?x=1")
                .unwrap()
                .file_id,
            "abc"
        );
        assert_eq!(p.parse_url("https://docs.acme.test/f/abc/more"), None);
        assert_eq!(p.parse_url("https://docs.acme.test.evil/f/abc"), None);
        assert_eq!(p.parse_url("https://docs.acme.test/f/"), None);
        assert_eq!(
            p.parse_url("https://docs.acme.test/f/%é%").unwrap().file_id,
            "%é%"
        );
        assert!(UrlPatterns::parse(&["ftp://x/{fileId}".into()]).is_err());
        assert!(UrlPatterns::parse(&["https://x/{blockId}".into()]).is_err());
        assert!(UrlPatterns::parse(&["https://x/{fileId}{blockId}".into()]).is_err());
    }

    #[test]
    fn host_urls_are_built_with_and_without_a_block() {
        let t = "https://docs.acme.test/f/{fileId}#{blockId}";
        assert_eq!(
            host_url(t, "a b", Some("h1")),
            "https://docs.acme.test/f/a%20b#h1"
        );
        assert_eq!(host_url(t, "a", None), "https://docs.acme.test/f/a");
        let q = "https://x.test/open?file={fileId}&block={blockId}";
        assert_eq!(host_url(q, "a", None), "https://x.test/open?file=a");
    }

    #[test]
    fn lowering_writes_the_label_with_the_host_url() {
        let mut doc = json!({"content": [{"type": "paragraph", "content": [link("f2", "b9")]}]});
        lower(
            &mut doc,
            Some("https://docs.acme.test/f/{fileId}#{blockId}"),
        );
        assert_eq!(
            doc["content"][0]["content"][0],
            json!({"type": "text", "text": "MARKER-LABEL", "marks": [{"type": "link", "attrs": {"href": "https://docs.acme.test/f/f2#b9"}}]})
        );
    }
}
