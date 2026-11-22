// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Building a Y.Doc from `document.json` or from plain markdown.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Value, json};
use yrs::types::Attrs;
use yrs::{
    Any, ArrayPrelim, Doc, In, Map, MapPrelim, Text, Transact, TransactionMut, WriteTxn, Xml,
    XmlElementPrelim, XmlFragment, XmlTextPrelim,
};

use crate::roots;

pub fn json_to_any(v: &Value) -> Any {
    match v {
        Value::Null => Any::Null,
        Value::Bool(b) => Any::Bool(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Any::from(i),
            None => Any::from(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => Any::from(s.as_str()),
        Value::Array(a) => Any::Array(a.iter().map(json_to_any).collect()),
        Value::Object(o) => Any::Map(Arc::new(
            o.iter().map(|(k, v)| (k.clone(), json_to_any(v))).collect(),
        )),
    }
}

/// Objects become Y.Maps and arrays Y.Arrays, except `options` which stays a plain JSON value.
pub fn json_to_in(key: &str, v: &Value) -> In {
    match v {
        Value::Object(o) if key != "options" => In::Map(
            o.iter()
                .map(|(k, v)| (k.as_str(), json_to_in(k, v)))
                .collect::<MapPrelim>(),
        ),
        Value::Array(a) if key != "options" => {
            In::Array(a.iter().map(|v| json_to_in("", v)).collect::<ArrayPrelim>())
        }
        other => In::Any(json_to_any(other)),
    }
}

/// Fills an empty doc from the logical JSON produced by [`crate::doc_to_json`].
pub fn apply_document_json(doc: &Doc, value: &Value) {
    let content = doc.get_or_insert_xml_fragment(roots::CONTENT);
    let mut txn = doc.transact_mut();
    if let Some(nodes) = value.get("content").and_then(Value::as_array) {
        let at = content.len(&txn);
        insert_children(&mut txn, &content, at, nodes);
    }
    for name in roots::MAPS {
        let Some(obj) = value.get(name).and_then(Value::as_object) else {
            continue;
        };
        let map = txn.get_or_insert_map(name);
        for (k, v) in obj {
            if name == roots::META {
                map.insert(&mut txn, k.as_str(), json_to_any(v));
            } else {
                map.insert(&mut txn, k.as_str(), json_to_in(k, v));
            }
        }
    }
}

fn is_inline_text(v: &Value) -> bool {
    matches!(v.get("type").and_then(Value::as_str), Some("text"))
}

/// Inserts Tiptap JSON nodes into `parent` starting at child `index`; returns how many Y
/// nodes were created (runs of inline text become one XmlText).
pub(crate) fn insert_children<F: XmlFragment>(
    txn: &mut TransactionMut,
    parent: &F,
    index: u32,
    nodes: &[Value],
) -> u32 {
    let mut at = index;
    let mut i = 0;
    while i < nodes.len() {
        if is_inline_text(&nodes[i]) {
            let text = parent.insert(txn, at, XmlTextPrelim::new(""));
            at += 1;
            let mut seen: Vec<Arc<str>> = Vec::new();
            while i < nodes.len() && is_inline_text(&nodes[i]) {
                let n = &nodes[i];
                let s = n.get("text").and_then(Value::as_str).unwrap_or_default();
                let attrs: Attrs = n
                    .get("marks")
                    .and_then(Value::as_array)
                    .map(|marks| {
                        marks
                            .iter()
                            .filter_map(|m| {
                                let t = m.get("type")?.as_str()?;
                                Some((
                                    Arc::from(t),
                                    json_to_any(m.get("attrs").unwrap_or(&json!({}))),
                                ))
                            })
                            .collect::<HashMap<_, _>>()
                    })
                    .unwrap_or_default();
                let at = text.len(txn);
                // Y.Text inserts inherit the formatting before them: clear marks that end here.
                let mut attrs = attrs;
                for k in &seen {
                    attrs.entry(Arc::clone(k)).or_insert(Any::Null);
                }
                seen.extend(attrs.keys().cloned());
                seen.sort();
                seen.dedup();
                if attrs.is_empty() {
                    text.insert(txn, at, s);
                } else {
                    text.insert_with_attributes(txn, at, s, attrs);
                }
                i += 1;
            }
            continue;
        }
        let node = &nodes[i];
        i += 1;
        let Some(tag) = node.get("type").and_then(Value::as_str) else {
            continue;
        };
        let el = parent.insert(txn, at, XmlElementPrelim::empty(tag));
        at += 1;
        if let Some(attrs) = node.get("attrs").and_then(Value::as_object) {
            for (k, v) in attrs {
                el.insert_attribute(txn, k.as_str(), json_to_any(v));
            }
        }
        if let Some(children) = node.get("content").and_then(Value::as_array) {
            insert_children(txn, &el, 0, children);
        }
    }
    at - index
}

fn text_node(s: &str) -> Value {
    json!({"type": "text", "text": s})
}

fn block(tag: &str, text: &str) -> Value {
    let inline = inline_markdown(text);
    if inline.is_empty() {
        json!({"type": tag})
    } else {
        json!({"type": tag, "content": inline})
    }
}

fn plain_block(tag: &str, text: &str) -> Value {
    if text.is_empty() {
        json!({"type": tag})
    } else {
        json!({"type": tag, "content": [text_node(text)]})
    }
}

/// Inline markdown: `**bold**`, `*italic*` / `_italic_`, `~~strike~~`, `` `code` ``,
/// `[text](url)` and `\` escapes. Unmatched delimiters stay literal.
pub fn inline_markdown(src: &str) -> Vec<Value> {
    let mut out = Vec::new();
    inline_into(src, &[], &mut out, 0);
    out
}

fn text_with(text: &str, marks: &[Value]) -> Value {
    let mut v = text_node(text);
    if !marks.is_empty() {
        v["marks"] = Value::Array(marks.to_vec());
    }
    v
}

fn with_mark(marks: &[Value], mark: Value) -> Vec<Value> {
    let mut m = marks.to_vec();
    m.push(mark);
    m
}

/// Deepest nesting of marks and link labels; past it, delimiters stay literal. Unbounded,
/// `***…` or `[[[…` recursed once per character and overflowed the stack (SEC-29).
const MAX_INLINE_DEPTH: usize = 16;

fn inline_into(src: &str, marks: &[Value], out: &mut Vec<Value>, depth: usize) {
    if depth > MAX_INLINE_DEPTH {
        if !src.is_empty() {
            out.push(text_with(src, marks));
        }
        return;
    }
    let mut buf = String::new();
    let flush = |buf: &mut String, out: &mut Vec<Value>| {
        if !buf.is_empty() {
            out.push(text_with(buf, marks));
            buf.clear();
        }
    };
    let mut i = 0;
    while i < src.len() {
        let rest = &src[i..];
        let prev_alnum = src[..i]
            .chars()
            .next_back()
            .is_some_and(char::is_alphanumeric);
        if let Some(c) = rest.strip_prefix('\\').and_then(|r| r.chars().next())
            && c.is_ascii_punctuation()
        {
            buf.push(c);
            i += 1 + c.len_utf8();
            continue;
        }
        if let Some(r) = rest.strip_prefix('`')
            && let Some(end) = r.find('`').filter(|e| *e > 0)
        {
            flush(&mut buf, out);
            out.push(text_with(
                &r[..end],
                &with_mark(marks, json!({"type": "code"})),
            ));
            i += end + 2;
            continue;
        }
        let pairs: [(&str, &str); 5] = [
            ("**", "bold"),
            ("__", "bold"),
            ("~~", "strike"),
            ("*", "italic"),
            ("_", "italic"),
        ];
        let mut matched = false;
        for (delim, mark) in pairs {
            if !rest.starts_with(delim) || (delim.starts_with('_') && prev_alnum) {
                continue;
            }
            let body = &rest[delim.len()..];
            let close = find_closing(body, delim);
            if let Some(end) = close.filter(|e| *e > 0 && !body.starts_with(' ')) {
                flush(&mut buf, out);
                inline_into(
                    &body[..end],
                    &with_mark(marks, json!({"type": mark})),
                    out,
                    depth + 1,
                );
                i += delim.len() * 2 + end;
                matched = true;
                break;
            }
        }
        if matched {
            continue;
        }
        if rest.starts_with('[')
            && let Some(mid) = rest.find("](")
            && let Some(close) = rest[mid + 2..].find(')')
        {
            let label = &rest[1..mid];
            let href = rest[mid + 2..mid + 2 + close].trim();
            flush(&mut buf, out);
            if crate::export::safe_target(href) {
                let link = json!({"type": "link", "attrs": {"href": href}});
                inline_into(label, &with_mark(marks, link), out, depth + 1);
            } else {
                // `javascript:` and friends never become links (SEC-16).
                inline_into(label, marks, out, depth + 1);
            }
            i += mid + 3 + close;
            continue;
        }
        let c = rest.chars().next().expect("non-empty");
        buf.push(c);
        i += c.len_utf8();
    }
    flush(&mut buf, out);
}

/// Position of the closing `delim` in `body` (a single `*` must not be half of `**`).
fn find_closing(body: &str, delim: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(p) = body[from..].find(delim) {
        let mut at = from + p;
        if body[..at].ends_with('\\') {
            from = at + 1;
            continue;
        }
        let single = delim.len() == 1;
        if !single {
            // `***` closing `**…*…`: the inner emphasis takes the first star.
            let run = body[at..].len() - body[at..].trim_start_matches(&delim[..1]).len();
            at += run - delim.len();
        }
        let doubled = single && body[at + 1..].starts_with(delim);
        let after_double = single && at > 0 && body[..at].ends_with(delim);
        if !(doubled || after_double) && !body[..at].ends_with(' ') {
            return Some(at);
        }
        from = at + if doubled { 2 } else { 1 };
    }
    None
}

fn table_cells(line: &str) -> Vec<String> {
    let t = line.trim().trim_start_matches('|').trim_end_matches('|');
    let mut cells = Vec::new();
    let mut cur = String::new();
    let mut chars = t.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&'|') => {
                cur.push('|');
                chars.next();
            }
            '|' => cells.push(std::mem::take(&mut cur).trim().to_string()),
            c => cur.push(c),
        }
    }
    cells.push(cur.trim().to_string());
    cells
}

fn is_table_rule(line: &str) -> bool {
    let cells = table_cells(line);
    !cells.is_empty()
        && cells.iter().all(|c| {
            let c = c.trim_matches(':');
            !c.is_empty() && c.chars().all(|x| x == '-')
        })
}

fn table_json(header: &[String], rows: &[Vec<String>]) -> Value {
    let row = |cells: &[String], tag: &str| {
        let mut cells: Vec<Value> = cells
            .iter()
            .map(|c| json!({"type": tag, "content": [block("paragraph", c)]}))
            .collect();
        cells.resize(
            header.len(),
            json!({"type": tag, "content": [{"type": "paragraph"}]}),
        );
        json!({"type": "tableRow", "content": cells})
    };
    let mut out = vec![row(header, "tableHeader")];
    out.extend(rows.iter().map(|r| row(r, "tableCell")));
    json!({"type": "table", "content": out})
}

fn list_item(item_tag: &str, text: &str, checked: Option<bool>) -> Value {
    let mut v = json!({"type": item_tag, "content": [block("paragraph", text)]});
    if let Some(c) = checked {
        v["attrs"] = json!({"checked": c});
    }
    v
}

/// A small, line-based markdown reader: headings, lists, task lists, quotes, code, rules, paragraphs.
pub fn markdown_to_json(src: &str) -> Value {
    let mut out: Vec<Value> = Vec::new();
    let mut para: Vec<&str> = Vec::new();
    let mut lines = src.lines().peekable();
    let flush = |para: &mut Vec<&str>, out: &mut Vec<Value>| {
        if !para.is_empty() {
            out.push(block("paragraph", &para.join(" ")));
            para.clear();
        }
    };
    let push_item = |out: &mut Vec<Value>, list: &str, item: Value| {
        if let Some(last) = out.last_mut().filter(|l| l["type"] == list) {
            last["content"]
                .as_array_mut()
                .expect("list content")
                .push(item);
        } else {
            out.push(json!({"type": list, "content": [item]}));
        }
    };
    while let Some(raw) = lines.next() {
        let line = raw.trim_end();
        let t = line.trim_start();
        if let Some(lang) = t.strip_prefix("```") {
            flush(&mut para, &mut out);
            let mut code = Vec::new();
            for l in lines.by_ref() {
                if l.trim_start().starts_with("```") {
                    break;
                }
                code.push(l);
            }
            let mut v = plain_block("codeBlock", &code.join("\n"));
            v["attrs"] = json!({"language": if lang.trim().is_empty() { Value::Null } else { lang.trim().into() }});
            out.push(v);
        } else if t.is_empty() {
            flush(&mut para, &mut out);
        } else if t.starts_with('|') && lines.peek().is_some_and(|n| is_table_rule(n)) {
            flush(&mut para, &mut out);
            let header = table_cells(t);
            lines.next();
            let mut rows = Vec::new();
            while let Some(n) = lines.peek().filter(|n| n.trim_start().starts_with('|')) {
                rows.push(table_cells(n));
                lines.next();
            }
            out.push(table_json(&header, &rows));
        } else if let Some((level, rest)) = heading(t) {
            flush(&mut para, &mut out);
            let mut v = block("heading", rest);
            v["attrs"] = json!({"level": level});
            out.push(v);
        } else if t == "---" || t == "***" || t == "___" {
            flush(&mut para, &mut out);
            out.push(json!({"type": "horizontalRule"}));
        } else if let Some(rest) = t
            .strip_prefix("> ")
            .or_else(|| t.strip_prefix('>').filter(|r| r.is_empty()))
        {
            flush(&mut para, &mut out);
            let p = block("paragraph", rest);
            if let Some(last) = out.last_mut().filter(|l| l["type"] == "blockquote") {
                last["content"]
                    .as_array_mut()
                    .expect("quote content")
                    .push(p);
            } else {
                out.push(json!({"type": "blockquote", "content": [p]}));
            }
        } else if let Some((checked, rest)) = task(t) {
            flush(&mut para, &mut out);
            push_item(
                &mut out,
                "taskList",
                list_item("taskItem", rest, Some(checked)),
            );
        } else if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
            flush(&mut para, &mut out);
            push_item(&mut out, "bulletList", list_item("listItem", rest, None));
        } else if let Some(rest) = ordered(t) {
            flush(&mut para, &mut out);
            push_item(&mut out, "orderedList", list_item("listItem", rest, None));
        } else if let Some((alt, src)) = image_line(t) {
            flush(&mut para, &mut out);
            if crate::export::safe_target(src) {
                out.push(json!({"type": "image", "attrs": {"src": src, "alt": alt}}));
            } else if !alt.is_empty() {
                para.push(alt);
            }
        } else {
            para.push(t);
        }
    }
    flush(&mut para, &mut out);
    json!({"type": "doc", "content": out})
}

fn image_line(t: &str) -> Option<(&str, &str)> {
    let rest = t.strip_prefix("![")?.strip_suffix(')')?;
    let (alt, src) = rest.split_once("](")?;
    Some((alt, src.trim()))
}

fn heading(t: &str) -> Option<(u8, &str)> {
    let hashes = t.chars().take_while(|c| *c == '#').count();
    let rest = t.get(hashes..)?.strip_prefix(' ')?;
    (1..=6)
        .contains(&hashes)
        .then(|| (hashes.min(3) as u8, rest.trim()))
}

fn task(t: &str) -> Option<(bool, &str)> {
    let rest = t.strip_prefix("- [").or_else(|| t.strip_prefix("* ["))?;
    let (mark, rest) = rest.split_at_checked(1)?;
    let rest = rest.strip_prefix("] ")?;
    Some((mark.eq_ignore_ascii_case("x"), rest))
}

fn ordered(t: &str) -> Option<&str> {
    let digits = t.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    t[digits..].strip_prefix(". ")
}

/// Fills an empty doc from markdown text.
pub fn apply_markdown(doc: &Doc, src: &str) {
    apply_document_json(doc, &markdown_to_json(src));
}

#[cfg(test)]
mod tests {

    /// SEC-16: imported Markdown keeps only web, mail and relative link targets.
    #[test]
    fn markdown_import_drops_script_links_and_images() {
        let d = crate::new_doc();
        apply_markdown(
            &d,
            "[a](javascript:alert(1)) [b](https://ok.dev)\n\n![x](javascript:alert(2))\n",
        );
        let v = crate::doc_to_json(&d);
        let s = v.to_string().to_ascii_lowercase();
        assert!(!s.contains("javascript:"), "{s}");
        assert!(s.contains("https://ok.dev"), "{s}");
    }
    use super::*;

    #[test]
    fn inline_marks_links_and_literals() {
        let v = inline_markdown("a **b *c*** `d` [e](https://x.dev) snake_case 2*3 \\*no\\*");
        let texts: Vec<(&str, Vec<&str>)> = v
            .iter()
            .map(|n| {
                (
                    n["text"].as_str().unwrap(),
                    n["marks"]
                        .as_array()
                        .map(|m| m.iter().map(|m| m["type"].as_str().unwrap()).collect())
                        .unwrap_or_default(),
                )
            })
            .collect();
        assert_eq!(
            texts,
            vec![
                ("a ", vec![]),
                ("b ", vec!["bold"]),
                ("c", vec!["bold", "italic"]),
                (" ", vec![]),
                ("d", vec!["code"]),
                (" ", vec![]),
                ("e", vec!["link"]),
                (" snake_case 2*3 *no*", vec![]),
            ]
        );
        assert_eq!(v[6]["marks"][0]["attrs"]["href"], "https://x.dev");
    }

    #[test]
    fn text_after_a_mark_is_not_formatted() {
        // Y.Text inserts inherit the formatting before them; found via convert md→html.
        let doc = crate::new_doc();
        apply_markdown(&doc, "Some **bold** text");
        let v = crate::doc_to_json(&doc);
        let runs = v["content"][0]["content"].as_array().unwrap();
        assert_eq!(runs.len(), 3, "{v}");
        assert_eq!(runs[2]["text"], " text");
        assert!(runs[2].get("marks").is_none(), "{v}");
    }

    #[test]
    fn markdown_tables_and_images() {
        let v = markdown_to_json(
            "| A | B |\n| --- | :-: |\n| 1 | x\\|y |\n\n![cat](https://h/cat.png)",
        );
        let c = v["content"].as_array().unwrap();
        assert_eq!(c[0]["type"], "table");
        assert_eq!(c[0]["content"][0]["content"][1]["type"], "tableHeader");
        assert_eq!(
            c[0]["content"][1]["content"][1]["content"][0]["content"][0]["text"],
            "x|y"
        );
        assert_eq!(c[1]["type"], "image");
        assert_eq!(c[1]["attrs"]["alt"], "cat");
    }
}
