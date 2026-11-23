// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Host-supplied team templates (TPL-01, docs/05 §5): the host's `GET /templates` list,
//! cleaned and cached per host, and its `GET /templates/{id}` file turned into a validated
//! document that replaces the canvas content as one server transaction.
//!
//! The editor never calls the host: it asks `GET /v1/templates` and
//! `POST /v1/templates/{id}/apply` (routes/templates.rs) with its session ticket.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value, json};
use yrs::{Doc, ReadTxn, StateVector, Transact, XmlFragment};

/// How long a host's list is reused (per host).
pub const LIST_TTL: Duration = Duration::from_secs(60);
/// Largest list answer read from the host.
pub const MAX_LIST_BYTES: usize = 512 * 1024;
/// Most templates shown per host.
pub const MAX_TEMPLATES: usize = 200;
/// Largest template file (the import limit).
pub const MAX_TEMPLATE_BYTES: usize = crate::routes::import::MAX_IMPORT_BYTES;

/// Tones the gallery has styles for; anything else is shown gray.
const TONES: [&str; 7] = ["gray", "blue", "green", "amber", "red", "pink", "purple"];

/// One entry of the team section, as the editor gets it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: Option<String>,
    pub icon: String,
    pub tone: String,
    pub updated_at: Option<String>,
}

/// A template id the host may use: 1-128 of `[A-Za-z0-9_.-]` (it becomes a URL segment).
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
        && id != "."
        && id != ".."
}

fn text(v: &Value, max: usize) -> Option<String> {
    let s = v.as_str()?.trim();
    (!s.is_empty()).then(|| s.chars().take(max).collect())
}

/// Cleans the host's list answer: `[…]` or `{"templates": […]}`; entries without a valid id
/// or a name are dropped, icons must be Lucide-style names, unknown tones become gray.
pub fn parse_list(v: &Value) -> Vec<TeamTemplate> {
    let items = v
        .as_array()
        .or_else(|| v.get("templates").and_then(Value::as_array));
    let Some(items) = items else {
        return vec![];
    };
    let mut seen = std::collections::HashSet::new();
    items
        .iter()
        .filter_map(|t| {
            let id = t.get("id")?.as_str()?.to_string();
            if !valid_id(&id) || !seen.insert(id.clone()) {
                return None;
            }
            let icon = t
                .get("icon")
                .and_then(Value::as_str)
                .filter(|i| {
                    !i.is_empty()
                        && i.len() <= 40
                        && i.bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                })
                .unwrap_or("layout-template");
            let tone = t
                .get("tone")
                .and_then(Value::as_str)
                .filter(|x| TONES.contains(x))
                .unwrap_or("gray");
            Some(TeamTemplate {
                name: text(t.get("name")?, 120)?,
                description: t
                    .get("description")
                    .and_then(|d| text(d, 300))
                    .unwrap_or_default(),
                category: t.get("category").and_then(|c| text(c, 60)),
                icon: icon.to_string(),
                tone: tone.to_string(),
                updated_at: t.get("updatedAt").and_then(|u| text(u, 40)),
                id,
            })
        })
        .take(MAX_TEMPLATES)
        .collect()
}

/// A host's list as fetched at an instant. `None` = the host has no templates callback.
type CachedList = (Instant, Option<Vec<TeamTemplate>>);

/// The list per host, reused for [`LIST_TTL`].
#[derive(Default)]
pub struct ListCache {
    entries: Mutex<HashMap<String, CachedList>>,
}

impl ListCache {
    pub fn get(&self, host_id: &str) -> Option<Option<Vec<TeamTemplate>>> {
        let m = self.entries.lock().ok()?;
        m.get(host_id)
            .filter(|(at, _)| at.elapsed() < LIST_TTL)
            .map(|(_, l)| l.clone())
    }

    pub fn put(&self, host_id: &str, list: Option<Vec<TeamTemplate>>) {
        if let Ok(mut m) = self.entries.lock() {
            m.insert(host_id.to_string(), (Instant::now(), list));
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum TemplateError {
    TooLarge,
    Invalid(String),
}

/// The template file as document JSON: an `.ocanvas` (read with the zip limits and the
/// MOD-01 schema check) or UTF-8 Markdown.
pub fn read_file(bytes: &[u8]) -> Result<Value, TemplateError> {
    if bytes.len() > MAX_TEMPLATE_BYTES {
        return Err(TemplateError::TooLarge);
    }
    if oc_model::ocanvas::is_zip(bytes) {
        let loaded = oc_model::read_ocanvas(bytes).map_err(|e| match e {
            oc_model::ocanvas::Error::Limit(_) => TemplateError::TooLarge,
            e => TemplateError::Invalid(e.to_string()),
        })?;
        return Ok(oc_model::doc_to_json(&loaded.doc));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| {
        TemplateError::Invalid("the template must be .ocanvas or UTF-8 Markdown".into())
    })?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if text.trim().is_empty() {
        return Err(TemplateError::Invalid("the template is empty".into()));
    }
    Ok(oc_model::import::markdown_to_json(text))
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}{}", ulid::Ulid::new().to_string().to_lowercase())
}

/// Gives every database and board fresh ids (so applying a template twice, or into a canvas
/// with its own databases, never shares one), drops block ids (fresh ones are set when the
/// blocks are inserted) and keeps only `content`, `databases`, `boards` and the meta
/// `title`/`icon`/`tone`/`template`. Comments, people and assets of the template file are
/// not copied.
pub fn prepare(tpl: &Value, meta: Map<String, Value>) -> Result<Value, TemplateError> {
    let mut remap: HashMap<String, String> = HashMap::new();
    let mut copy = |key: &str, prefix: &str| -> Map<String, Value> {
        tpl.get(key)
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .map(|(k, v)| {
                        let id = new_id(prefix);
                        remap.insert(k.clone(), id.clone());
                        (id, v.clone())
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let databases = copy("databases", "db");
    let boards = copy("boards", "bd");
    let mut content: Vec<Value> = tpl
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    fn walk(n: &mut Value, remap: &HashMap<String, String>) {
        if let Some(attrs) = n.get_mut("attrs").and_then(Value::as_object_mut) {
            attrs.remove(oc_model::patch::BLOCK_ID);
            for key in ["dbId", "boardId"] {
                if let Some(new) = attrs
                    .get(key)
                    .and_then(Value::as_str)
                    .and_then(|old| remap.get(old))
                {
                    attrs.insert(key.into(), json!(new));
                }
            }
        }
        if let Some(marks) = n.get_mut("marks").and_then(Value::as_array_mut) {
            // Comment threads stay with the template file.
            marks.retain(|m| m.get("type").and_then(Value::as_str) != Some("comment"));
        }
        if let Some(kids) = n.get_mut("content").and_then(Value::as_array_mut) {
            for k in kids {
                walk(k, remap);
            }
        }
    }
    for n in &mut content {
        walk(n, &remap);
    }
    if content.is_empty() {
        return Err(TemplateError::Invalid("the template has no blocks".into()));
    }
    let out = json!({
        "type": "doc",
        "content": content,
        "meta": meta,
        "databases": databases,
        "boards": boards,
    });
    // MOD-01: the template must fit the block schema (unknown content is kept, as on load).
    let report = oc_model::validate::record(oc_model::validate::validate_json(&out));
    if let Some(e) = report.first_error() {
        return Err(TemplateError::Invalid(e));
    }
    Ok(out)
}

/// The update that replaces `doc`'s content with the prepared template (and adds its
/// databases, boards and meta), computed on a scratch copy; plus the new top-level block ids.
pub fn apply(doc: &Doc, prepared: &Value) -> Result<(Vec<u8>, Vec<String>), String> {
    let scratch = oc_model::new_doc();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    oc_model::ocanvas::apply_update_bytes(&scratch, &state).map_err(|e| e.to_string())?;
    let before = scratch.transact().state_vector();
    let mut prepared = prepared.clone();
    // The title follows the template unless someone named the canvas (as in the gallery).
    let current = oc_model::doc_to_json(&scratch)["meta"].clone();
    let named = current["title"]
        .as_str()
        .is_some_and(|t| !t.trim().is_empty())
        && current["template"].as_str().is_none_or(str::is_empty);
    if named && let Some(m) = prepared["meta"].as_object_mut() {
        m.remove("title");
    }
    let mut ids = Vec::new();
    if let Some(nodes) = prepared["content"].as_array_mut() {
        for n in nodes {
            let id = format!("b_{}", ulid::Ulid::new().to_string().to_lowercase());
            if let Some(o) = n.as_object_mut() {
                let attrs = o.entry("attrs").or_insert_with(|| json!({}));
                attrs[oc_model::patch::BLOCK_ID] = json!(id);
            }
            ids.push(id);
        }
    }
    {
        let content = scratch.get_or_insert_xml_fragment(oc_model::roots::CONTENT);
        let mut txn = scratch.transact_mut();
        let len = content.len(&txn);
        if len > 0 {
            content.remove_range(&mut txn, 0, len);
        }
    }
    oc_model::import::apply_document_json(&scratch, &prepared);
    let update = scratch.transact().encode_state_as_update_v1(&before);
    Ok((update, ids))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_is_cleaned() {
        let v = json!({"templates": [
            {"id": "acme-retro", "name": " Acme retro ", "description": "Ours", "icon": "repeat", "tone": "green", "updatedAt": "2026-11-20T10:00:00Z", "category": "Meetings"},
            {"id": "../etc", "name": "Bad id"},
            {"id": "no-name"},
            {"id": "acme-retro", "name": "Duplicate"},
            {"id": "x", "name": "Odd icon", "icon": "<svg>", "tone": "neon"}
        ]});
        let l = parse_list(&v);
        assert_eq!(l.len(), 2, "{l:?}");
        assert_eq!(l[0].name, "Acme retro");
        assert_eq!(l[0].category.as_deref(), Some("Meetings"));
        assert_eq!(
            (l[1].icon.as_str(), l[1].tone.as_str()),
            ("layout-template", "gray")
        );
        assert_eq!(parse_list(&json!([{"id": "a", "name": "A"}])).len(), 1);
        assert!(parse_list(&json!({"nope": 1})).is_empty());
    }

    #[test]
    fn prepare_gives_fresh_ids_and_refuses_bad_schema() {
        let tpl = oc_model::templates::builtin("retro").unwrap();
        let p = prepare(tpl, Map::new()).unwrap();
        let db = p["databases"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        assert!(!tpl["databases"].as_object().unwrap().contains_key(&db));
        assert!(p.to_string().contains(&format!("\"dbId\":\"{db}\"")));
        let bad = json!({"content": [{"type": "heading", "attrs": {"level": 9}}]});
        assert!(matches!(
            prepare(&bad, Map::new()),
            Err(TemplateError::Invalid(_))
        ));
        assert!(matches!(
            prepare(&json!({"content": []}), Map::new()),
            Err(TemplateError::Invalid(_))
        ));
    }

    #[test]
    fn oversized_and_binary_files_are_refused() {
        assert_eq!(
            read_file(&vec![b'a'; MAX_TEMPLATE_BYTES + 1]),
            Err(TemplateError::TooLarge)
        );
        assert!(matches!(
            read_file(&[0xff, 0xfe, 0x00]),
            Err(TemplateError::Invalid(_))
        ));
        assert!(read_file(b"# Plan\n\nHello").is_ok());
    }

    #[test]
    fn apply_replaces_the_content() {
        let doc = oc_model::new_doc();
        oc_model::import::apply_markdown(&doc, "old text");
        let p = prepare(
            &oc_model::import::markdown_to_json("# New\n\nfresh"),
            Map::from_iter([("title".to_string(), json!("Acme plan"))]),
        )
        .unwrap();
        let (u, ids) = apply(&doc, &p).unwrap();
        oc_model::ocanvas::apply_update_bytes(&doc, &u).unwrap();
        let md = oc_model::export::to_markdown(&oc_model::doc_to_json(&doc));
        assert!(md.contains("# New") && !md.contains("old text"), "{md}");
        assert_eq!(ids.len(), 2);
        assert_eq!(oc_model::doc_to_json(&doc)["meta"]["title"], "Acme plan");
    }
}
