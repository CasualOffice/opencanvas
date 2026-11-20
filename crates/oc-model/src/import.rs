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
fn json_to_in(key: &str, v: &Value) -> In {
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
        insert_children(&mut txn, &content, nodes);
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

fn insert_children<F: XmlFragment>(txn: &mut TransactionMut, parent: &F, nodes: &[Value]) {
    let mut i = 0;
    while i < nodes.len() {
        if is_inline_text(&nodes[i]) {
            let text = parent.push_back(txn, XmlTextPrelim::new(""));
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
        let el = parent.push_back(txn, XmlElementPrelim::empty(tag));
        if let Some(attrs) = node.get("attrs").and_then(Value::as_object) {
            for (k, v) in attrs {
                el.insert_attribute(txn, k.as_str(), json_to_any(v));
            }
        }
        if let Some(children) = node.get("content").and_then(Value::as_array) {
            insert_children(txn, &el, children);
        }
    }
}

fn text_node(s: &str) -> Value {
    json!({"type": "text", "text": s})
}

fn block(tag: &str, text: &str) -> Value {
    if text.is_empty() {
        json!({"type": tag})
    } else {
        json!({"type": tag, "content": [text_node(text)]})
    }
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
            let mut v = block("codeBlock", &code.join("\n"));
            v["attrs"] = json!({"language": if lang.trim().is_empty() { Value::Null } else { lang.trim().into() }});
            out.push(v);
        } else if t.is_empty() {
            flush(&mut para, &mut out);
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
        } else {
            para.push(t);
        }
    }
    flush(&mut para, &mut out);
    json!({"type": "doc", "content": out})
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
