// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Y.Doc layout and the JSON walk used for `document.json` and exports.

use serde_json::{Map as JsonMap, Value, json};
use yrs::types::ToJson;
use yrs::types::text::{Diff, YChange};
use yrs::types::xml::XmlOut;
use yrs::{
    Any, Doc, GetString, Map, MapRef, Out, ReadTxn, Text, Transact, Xml, XmlFragment, XmlTextRef,
};

use crate::roots;

pub fn new_doc() -> Doc {
    let doc = Doc::new();
    ensure_roots(&doc);
    doc
}

/// Defines every known root with its type, so remote updates integrate into typed branches.
pub fn ensure_roots(doc: &Doc) {
    doc.get_or_insert_xml_fragment(roots::CONTENT);
    for name in roots::MAPS {
        doc.get_or_insert_map(name);
    }
}

/// True when the canvas has no content and no metadata yet (a brand-new file).
pub fn is_empty(doc: &Doc) -> bool {
    let txn = doc.transact();
    let content_empty = txn
        .get_xml_fragment(roots::CONTENT)
        .is_none_or(|f| f.len(&txn) == 0);
    let maps_empty = [roots::META, roots::DATABASES, roots::BOARDS, roots::SHEETS]
        .iter()
        .all(|n| txn.get_map(*n).is_none_or(|m| m.len(&txn) == 0));
    content_empty && maps_empty
}

pub fn any_to_json(any: &Any) -> Value {
    serde_json::to_value(any).unwrap_or(Value::Null)
}

pub fn out_to_json<T: ReadTxn>(txn: &T, out: &Out) -> Value {
    match out {
        Out::Any(a) => any_to_json(a),
        Out::YText(t) => Value::String(t.get_string(txn)),
        other => any_to_json(&other.to_json(txn)),
    }
}

fn map_json<T: ReadTxn>(txn: &T, map: Option<MapRef>) -> Value {
    map.map(|m| any_to_json(&m.to_json(txn)))
        .unwrap_or_else(|| json!({}))
}

/// Logical JSON of the whole canvas: `{content, meta, databases, boards, comments}`.
pub fn doc_to_json(doc: &Doc) -> Value {
    let txn = doc.transact();
    let content = txn
        .get_xml_fragment(roots::CONTENT)
        .map(|f| f.children(&txn).flat_map(|c| node_json(&txn, c)).collect())
        .unwrap_or_default();
    let mut out = json!({
        "type": "doc",
        "content": Value::Array(content),
        "meta": map_json(&txn, txn.get_map(roots::META)),
        "databases": map_json(&txn, txn.get_map(roots::DATABASES)),
        "boards": map_json(&txn, txn.get_map(roots::BOARDS)),
        "comments": map_json(&txn, txn.get_map(roots::COMMENTS)),
    });
    // docs/21 tier 0: optional, written only once someone has opened the file.
    let people = map_json(&txn, txn.get_map(roots::PEOPLE));
    if people.as_object().is_some_and(|p| !p.is_empty()) {
        out["people"] = people;
    }
    // BSDK-02: SDK block data, only when there is some.
    let ext = map_json(&txn, txn.get_map(roots::EXT));
    if ext.as_object().is_some_and(|e| !e.is_empty()) {
        out["ext"] = ext;
    }
    // AUTO-01: automation rules, only when there are some.
    let autos = map_json(&txn, txn.get_map(roots::AUTOMATIONS));
    if autos.as_object().is_some_and(|a| !a.is_empty()) {
        out["automations"] = autos;
    }
    // SHEET-03: Spreadsheet blocks, only when there are some.
    let sheets = map_json(&txn, txn.get_map(roots::SHEETS));
    if sheets.as_object().is_some_and(|s| !s.is_empty()) {
        out["sheets"] = sheets;
    }
    // DGM-17: icons people added (server-written), only when there are some.
    let icons = map_json(&txn, txn.get_map(roots::ICONS));
    if icons.as_object().is_some_and(|i| !i.is_empty()) {
        out["icons"] = icons;
    }
    out
}

fn node_json<T: ReadTxn>(txn: &T, node: XmlOut) -> Vec<Value> {
    match node {
        XmlOut::Element(el) => {
            let mut obj = JsonMap::new();
            obj.insert("type".into(), Value::String(el.tag().to_string()));
            let mut attrs: Vec<(String, Value)> = el
                .attributes(txn)
                .map(|(k, v)| (k.to_string(), out_to_json(txn, &v)))
                .collect();
            if !attrs.is_empty() {
                attrs.sort_by(|a, b| a.0.cmp(&b.0));
                obj.insert("attrs".into(), Value::Object(attrs.into_iter().collect()));
            }
            let children: Vec<Value> = el.children(txn).flat_map(|c| node_json(txn, c)).collect();
            if !children.is_empty() {
                obj.insert("content".into(), Value::Array(children));
            }
            vec![Value::Object(obj)]
        }
        XmlOut::Fragment(f) => f.children(txn).flat_map(|c| node_json(txn, c)).collect(),
        XmlOut::Text(t) => text_json(txn, &t),
    }
}

fn text_json<T: ReadTxn>(txn: &T, text: &XmlTextRef) -> Vec<Value> {
    let chunks: Vec<Diff<()>> = text.diff(txn, |_: YChange| ());
    chunks
        .into_iter()
        .map(|d| {
            let mut obj = JsonMap::new();
            match &d.insert {
                Out::Any(Any::String(s)) => {
                    obj.insert("type".into(), "text".into());
                    obj.insert("text".into(), Value::String(s.to_string()));
                }
                other => {
                    obj.insert("type".into(), "embed".into());
                    obj.insert("value".into(), out_to_json(txn, other));
                }
            }
            if let Some(attrs) = d.attributes.filter(|a| !a.is_empty()) {
                let mut marks: Vec<Value> = attrs
                    .iter()
                    .map(|(k, v)| {
                        // y-prosemirror suffixes overlapping marks with `--<hash>`.
                        let name = k.split("--").next().unwrap_or(k);
                        let mut m = JsonMap::new();
                        m.insert("type".into(), Value::String(name.to_string()));
                        let a = any_to_json(v);
                        if a.as_object().is_some_and(|o| !o.is_empty()) {
                            m.insert("attrs".into(), a);
                        }
                        Value::Object(m)
                    })
                    .collect();
                marks.sort_by(|a, b| a["type"].as_str().cmp(&b["type"].as_str()));
                obj.insert("marks".into(), Value::Array(marks));
            }
            Value::Object(obj)
        })
        .collect()
}
