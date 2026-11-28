// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `search.json` (SRCH-02, ADR-065, docs/34 §4.3): the plain-text projection of a canvas that
//! every save carries inside the `.ocanvas`, so the host can index it in its own engine.
//! OpenCanvas keeps no index; this is computed from the document at save time (or statelessly
//! by `POST /api/v1/extract`) and never stored by the server.
//!
//! Shape: `{v: 1, title, lang?, blocks: [{id?, type, path, text, done?}], databases: [{id,
//! title, rows: [{id, text}]}], boards: [{id, text: [..]}], live: [{blockId, fileId, title}],
//! comments?: [{id, text}], truncated}`. Comments only when asked (`[host.search] comments`);
//! in-file history is never included. At most [`MAX_BYTES`], then `truncated: true`.

use serde_json::{Value, json};

use crate::export::{attr, attr_str, children, s};

/// Largest `search.json`; past it entries are dropped from the end and `truncated` is set.
pub const MAX_BYTES: usize = 2 * 1024 * 1024;
/// The zip entry name.
pub const ENTRY: &str = "search.json";

/// What to put in `search.json`.
#[derive(Debug, Clone, Copy, Default)]
pub struct Options {
    /// Include comment text (`[host.search] comments = true`); off by default because a
    /// comment's audience can differ from the file's in some hosts.
    pub comments: bool,
}

/// Block types that hold text a person reads as a block.
const TEXT_BLOCKS: [&str; 6] = [
    "paragraph",
    "heading",
    "codeBlock",
    "toggleSummary",
    "tableCell",
    "tableHeader",
];

fn inline(n: &Value, out: &mut String) {
    match s(n, "type") {
        "text" => out.push_str(s(n, "text")),
        "mention" => {
            let l = attr_str(n, "label");
            out.push('@');
            out.push_str(l.trim_start_matches('@'));
        }
        "dateMention" => out.push_str(attr_str(n, "date")),
        "canvasLink" => out.push_str(attr_str(n, "label")),
        "hardBreak" => out.push(' '),
        _ => {
            for c in children(n) {
                inline(c, out);
            }
        }
    }
}

fn text_of(n: &Value) -> String {
    let mut t = String::new();
    inline(n, &mut t);
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

struct Walk<'a> {
    doc: &'a Value,
    path: Vec<(u64, String)>,
    blocks: Vec<Value>,
    databases: Vec<Value>,
    boards: Vec<Value>,
    live: Vec<Value>,
    seen_db: Vec<String>,
    seen_board: Vec<String>,
}

impl Walk<'_> {
    fn trail(&self) -> Vec<String> {
        self.path.iter().map(|(_, t)| t.clone()).collect()
    }

    fn push(&mut self, n: &Value, ty: &str, text: String, done: Option<bool>) {
        if text.is_empty() {
            return;
        }
        let mut b = json!({"type": ty, "path": self.trail(), "text": text});
        if let Some(id) = attr(n, "blockId").as_str().filter(|x| !x.is_empty()) {
            b["id"] = json!(id);
        }
        if let Some(d) = done {
            b["done"] = json!(d);
        }
        self.blocks.push(b);
    }

    fn database(&mut self, id: &str) {
        if id.is_empty() || self.seen_db.iter().any(|x| x == id) {
            return;
        }
        self.seen_db.push(id.to_string());
        let db = &self.doc["databases"][id];
        if db.is_null() {
            return;
        }
        let (title, _, rows) = crate::export::database_table(self.doc, id);
        let order: Vec<String> = match db["order"].as_array() {
            Some(o) => o
                .iter()
                .filter_map(|r| r.as_str().map(String::from))
                .collect(),
            None => db["rows"]
                .as_object()
                .map(|r| r.keys().cloned().collect())
                .unwrap_or_default(),
        };
        let rows: Vec<Value> = order
            .iter()
            .zip(rows)
            .filter_map(|(rid, cells)| {
                let text = cells
                    .iter()
                    .map(|c| c.trim())
                    .filter(|c| !c.is_empty())
                    .collect::<Vec<_>>()
                    .join(" · ");
                (!text.is_empty()).then(|| json!({"id": rid, "text": text}))
            })
            .collect();
        self.databases
            .push(json!({"id": id, "title": title, "rows": rows}));
    }

    fn board(&mut self, id: &str) {
        if id.is_empty() || self.seen_board.iter().any(|x| x == id) {
            return;
        }
        self.seen_board.push(id.to_string());
        if self.doc["boards"][id].is_null() {
            return;
        }
        let texts = crate::export::board_info(self.doc, id).texts;
        if !texts.is_empty() {
            self.boards.push(json!({"id": id, "text": texts}));
        }
    }

    fn node(&mut self, n: &Value) {
        let ty = s(n, "type");
        match ty {
            "heading" => {
                let level = attr(n, "level").as_u64().unwrap_or(1);
                let text = text_of(n);
                while self.path.last().is_some_and(|(l, _)| *l >= level) {
                    self.path.pop();
                }
                self.push(n, "heading", text.clone(), None);
                if !text.is_empty() {
                    self.path.push((level, text));
                }
            }
            "taskItem" => {
                let done = attr(n, "checked").as_bool().unwrap_or(false);
                // The item's own line, then any nested blocks.
                let mut own = String::new();
                for c in children(n).iter().filter(|c| s(c, "type") == "paragraph") {
                    if !own.is_empty() {
                        own.push(' ');
                    }
                    own.push_str(&text_of(c));
                }
                self.push(n, "todo", own, Some(done));
                for c in children(n).iter().filter(|c| s(c, "type") != "paragraph") {
                    self.node(c);
                }
            }
            "listItem" => {
                let mut own = String::new();
                for c in children(n).iter().filter(|c| s(c, "type") == "paragraph") {
                    if !own.is_empty() {
                        own.push(' ');
                    }
                    own.push_str(&text_of(c));
                }
                self.push(n, "listItem", own, None);
                for c in children(n).iter().filter(|c| s(c, "type") != "paragraph") {
                    self.node(c);
                }
            }
            "database" => self.database(attr_str(n, "dbId")),
            "board" => self.board(attr_str(n, "boardId")),
            crate::export::SHEET_NODE => {
                // SHEET-03: the displayed values, one line per row, as the grid shows them.
                let mut text = Vec::new();
                for t in crate::export::sheet_tables(self.doc, n) {
                    text.push(t.name.clone());
                    for r in &t.rows {
                        let line: Vec<&str> = r
                            .iter()
                            .map(|c| c.trim())
                            .filter(|c| !c.is_empty())
                            .collect();
                        if !line.is_empty() {
                            text.push(line.join(" · "));
                        }
                    }
                }
                self.push(n, "sheet", text.join("\n"), None);
            }
            "image" => {
                let t = [attr_str(n, "alt"), attr_str(n, "caption")]
                    .iter()
                    .filter(|x| !x.is_empty())
                    .copied()
                    .collect::<Vec<_>>()
                    .join(" · ");
                self.push(n, "image", t, None);
            }
            "bookmark" => {
                let t = [attr_str(n, "title"), attr_str(n, "description")]
                    .iter()
                    .filter(|x| !x.is_empty())
                    .copied()
                    .collect::<Vec<_>>()
                    .join(" · ");
                self.push(n, "bookmark", t, None);
            }
            "fileAttachment" => self.push(n, "file", attr_str(n, "name").to_string(), None),
            "extBlock" => {
                // SDK blocks: their stored fallback text (their content lives in the sandbox).
                let fb = attr(n, "fallback");
                let t = fb["text"]
                    .as_str()
                    .or_else(|| fb["markdown"].as_str())
                    .unwrap_or_default();
                let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
                self.push(n, "ext", t, None);
            }
            "liveBlock" => {
                // Live blocks are listed by title only; their text is in their own file.
                let mut l = json!({"fileId": attr_str(n, "fileId"), "title": attr_str(n, "title")});
                if let Some(id) = attr(n, "blockId").as_str() {
                    l["blockId"] = json!(id);
                }
                self.live.push(l);
            }
            t if TEXT_BLOCKS.contains(&t) => {
                let text = text_of(n);
                self.push(n, t, text, None);
            }
            _ => {
                for c in children(n) {
                    self.node(c);
                }
            }
        }
    }
}

/// `search.json` for a document's logical JSON ([`crate::doc_to_json`]).
pub fn search_json(doc: &Value, opts: Options) -> Value {
    let mut w = Walk {
        doc,
        path: vec![],
        blocks: vec![],
        databases: vec![],
        boards: vec![],
        live: vec![],
        seen_db: vec![],
        seen_board: vec![],
    };
    for n in children(doc) {
        w.node(n);
    }
    // Databases and boards not placed in the content are still the canvas's.
    if let Some(m) = doc["databases"].as_object() {
        let mut ids: Vec<&String> = m.keys().collect();
        ids.sort();
        for id in ids {
            w.database(id);
        }
    }
    if let Some(m) = doc["boards"].as_object() {
        let mut ids: Vec<&String> = m.keys().collect();
        ids.sort();
        for id in ids {
            w.board(id);
        }
    }
    let mut out = json!({
        "v": 1,
        "title": doc["meta"]["title"].as_str().unwrap_or_default(),
        "blocks": w.blocks,
        "databases": w.databases,
        "boards": w.boards,
        "live": w.live,
        "truncated": false,
    });
    if let Some(lang) = doc["meta"]["lang"].as_str() {
        out["lang"] = json!(lang);
    }
    if opts.comments {
        let mut list = vec![];
        if let Some(m) = doc["comments"].as_object() {
            let mut ids: Vec<&String> = m.keys().collect();
            ids.sort();
            for id in ids {
                let text = m[id]["messages"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x["text"].as_str())
                            .collect::<Vec<_>>()
                            .join(" · ")
                    })
                    .unwrap_or_default();
                if !text.is_empty() {
                    list.push(json!({"id": id, "text": text}));
                }
            }
        }
        out["comments"] = json!(list);
    }
    cap(out, MAX_BYTES)
}

/// Drops entries from the end (comments, boards, database rows, blocks) until it fits.
fn cap(mut v: Value, max: usize) -> Value {
    let size = |v: &Value| serde_json::to_vec(v).map_or(0, |b| b.len());
    if size(&v) <= max {
        return v;
    }
    v["truncated"] = json!(true);
    for key in ["comments", "live", "boards", "databases", "blocks"] {
        loop {
            if size(&v) <= max {
                return v;
            }
            let Some(arr) = v.get_mut(key).and_then(Value::as_array_mut) else {
                break;
            };
            if key == "databases" {
                // Rows first, then the database itself.
                if let Some(last) = arr.last_mut()
                    && let Some(rows) = last["rows"].as_array_mut()
                    && !rows.is_empty()
                {
                    let n = rows.len().div_ceil(8).max(1);
                    rows.truncate(rows.len() - n);
                    continue;
                }
            }
            if arr.is_empty() {
                break;
            }
            let n = arr.len().div_ceil(8).max(1);
            arr.truncate(arr.len() - n);
        }
    }
    v
}

/// `search.json` as stored in a `.ocanvas`, when present (hosts and tests read it).
pub fn read_entry(bytes: &[u8]) -> Option<Value> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let entry = zip.by_name(ENTRY).ok()?;
    if entry.size() > MAX_BYTES as u64 {
        return None;
    }
    let mut buf = Vec::new();
    entry
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .ok()?;
    serde_json::from_slice(&buf).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(text: &str) -> Value {
        json!({"type": "paragraph", "content": [{"type": "text", "text": text}]})
    }

    fn doc() -> Value {
        json!({
            "type": "doc",
            "meta": {"title": "Sprint 42 planning"},
            "content": [
                {"type": "heading", "attrs": {"level": 1, "blockId": "b_h1"}, "content": [{"type": "text", "text": "Release 4.2"}]},
                {"type": "taskList", "content": [
                    {"type": "taskItem", "attrs": {"checked": false, "blockId": "b_t1"}, "content": [p("SSO set-up docs updated")]}
                ]},
                {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Risks"}]},
                {"type": "paragraph", "attrs": {"blockId": "b_p1"}, "content": [
                    {"type": "text", "text": "Ask "},
                    {"type": "mention", "attrs": {"id": "u1", "label": "Lea"}},
                    {"type": "text", "text": "  about SSO", "marks": [{"type": "bold"}]}
                ]},
                {"type": "database", "attrs": {"dbId": "db_1"}},
                {"type": "board", "attrs": {"boardId": "bd_1"}}
            ],
            "databases": {"db_1": {"name": "Backlog", "fields": [{"id": "t", "name": "Task", "type": "title"}, {"id": "s", "name": "Status", "type": "status"}],
                "order": ["r_1"], "rows": {"r_1": {"t": "Fix CSV export", "s": "In review"}}}},
            "boards": {"bd_1": {"order": ["s1"], "shapes": {"s1": {"type": "sticky", "text": "Hero copy too long"}}}},
            "comments": {"th1": {"quote": "x", "messages": [{"text": "secret remark"}]}}
        })
    }

    #[test]
    fn projects_blocks_with_ids_trails_and_done() {
        let s = search_json(&doc(), Options::default());
        assert_eq!(s["v"], 1);
        assert_eq!(s["title"], "Sprint 42 planning");
        let b = s["blocks"].as_array().unwrap();
        assert_eq!(b[0]["id"], "b_h1");
        assert_eq!(b[0]["path"], json!([]));
        assert_eq!(b[1]["type"], "todo");
        assert_eq!(b[1]["done"], false);
        assert_eq!(b[1]["path"], json!(["Release 4.2"]));
        assert_eq!(b[3]["text"], "Ask @Lea about SSO");
        assert_eq!(b[3]["path"], json!(["Release 4.2", "Risks"]));
        assert_eq!(
            s["databases"][0]["rows"][0]["text"],
            "Fix CSV export · In review"
        );
        assert_eq!(s["boards"][0]["text"][0], "Hero copy too long");
        assert_eq!(s["truncated"], false);
    }

    #[test]
    fn comments_only_when_asked() {
        let off = serde_json::to_string(&search_json(&doc(), Options::default())).unwrap();
        assert!(!off.contains("secret remark"));
        let on = search_json(&doc(), Options { comments: true });
        assert_eq!(on["comments"][0]["text"], "secret remark");
    }

    #[test]
    fn caps_at_the_limit_and_says_so() {
        let mut d = doc();
        let many: Vec<Value> = (0..2000)
            .map(|i| p(&format!("line {i} {}", "x".repeat(50))))
            .collect();
        d["content"] = json!(many);
        let s = cap(search_json(&d, Options::default()), 20_000);
        assert_eq!(s["truncated"], true);
        assert!(serde_json::to_vec(&s).unwrap().len() <= 20_000);
        assert!(!s["blocks"].as_array().unwrap().is_empty());
    }
}
