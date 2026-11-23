// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Icons people added to a document (DGM-17, ADR-057): the server-written root `icons`,
//! `{id → {name, keywords, format, data, width, height, bytes, by, byName, at}}`, `data` being the
//! cleaned file in base64. Only the server writes it ([`apply`], on a scratch copy; the room
//! refuses client updates that touch it, like `comments` for the comment role), so a document is
//! self-contained and exports never fetch. Limits: 200 icons and 1 MB of icon data per document.
//!
//! Readers check a stored icon again before drawing it ([`data_url`]).

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use yrs::types::ToJson;
use yrs::{Any, Doc, Map, MapPrelim, ReadTxn, StateVector, Transact, WriteTxn};

use crate::icon_clean;
use crate::roots::ICONS;

/// Most icons in one document.
pub const MAX_ICONS: usize = 200;
/// Most icon data (decoded bytes) in one document.
pub const MAX_ICON_BYTES: usize = 1024 * 1024;

const ID_RE_MAX: usize = 40;

/// A change to the `icons` root, made by the server only.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum IconOp {
    Add {
        id: String,
        name: String,
        keywords: Vec<String>,
        format: String,
        data: String,
        width: u32,
        height: u32,
        by: String,
        by_name: String,
        at: String,
    },
    /// New name and keywords.
    Rename {
        id: String,
        name: String,
        keywords: Vec<String>,
    },
    /// A new file for the same icon: every shape using it changes.
    Replace {
        id: String,
        format: String,
        data: String,
        width: u32,
        height: u32,
    },
    Remove {
        id: String,
    },
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= ID_RE_MAX
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Name and keywords as stored: trimmed, at most 60 characters, at most 12 keywords of 30.
pub fn tidy_name(name: &str) -> String {
    name.trim().chars().take(60).collect()
}
pub fn tidy_keywords(k: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in k {
        let w: String = w.trim().to_lowercase().chars().take(30).collect();
        if !w.is_empty() && !out.contains(&w) {
            out.push(w);
        }
        if out.len() == 12 {
            break;
        }
    }
    out
}

fn decoded_len(b64: &str) -> usize {
    b64.len() / 4 * 3
}

/// The stored icons as JSON (`{}` when there are none).
pub fn list(doc: &Doc) -> Value {
    let txn = doc.transact();
    txn.get_map(ICONS)
        .map(|m| crate::doc::any_to_json(&m.to_json(&txn)))
        .unwrap_or_else(|| serde_json::json!({}))
}

/// Applies `op` to a scratch copy of `doc` and returns the update to send through the room, or
/// why it can't be done.
pub fn apply(doc: &Doc, op: &IconOp) -> Result<Vec<u8>, String> {
    let scratch = crate::new_doc();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    crate::ocanvas::apply_update_bytes(&scratch, &state).map_err(|e| e.to_string())?;
    let sv = scratch.transact().state_vector();
    let current = list(&scratch);
    let cur = current.as_object().cloned().unwrap_or_default();
    let total: usize = cur
        .values()
        .map(|v| decoded_len(v["data"].as_str().unwrap_or("")))
        .sum();
    {
        let mut txn = scratch.transact_mut();
        let root = txn.get_or_insert_map(ICONS);
        match op {
            IconOp::Add {
                id,
                name,
                keywords,
                format,
                data,
                width,
                height,
                by,
                by_name,
                at,
            } => {
                if !valid_id(id) || cur.contains_key(id) {
                    return Err("invalid icon id".into());
                }
                if cur.len() >= MAX_ICONS {
                    return Err(format!(
                        "This document already has {MAX_ICONS} icons. Remove one to add another."
                    ));
                }
                if total + decoded_len(data) > MAX_ICON_BYTES {
                    return Err("Icons in this document would use more than 1 MB. Remove one to add another.".into());
                }
                let kw: Vec<Any> = tidy_keywords(keywords).into_iter().map(Any::from).collect();
                let entry = MapPrelim::from([
                    ("name".to_string(), Any::from(tidy_name(name))),
                    ("keywords".to_string(), Any::from(kw)),
                    ("format".to_string(), Any::from(format.clone())),
                    ("data".to_string(), Any::from(data.clone())),
                    ("width".to_string(), Any::from(*width as f64)),
                    ("height".to_string(), Any::from(*height as f64)),
                    ("bytes".to_string(), Any::from(decoded_len(data) as f64)),
                    ("by".to_string(), Any::from(by.clone())),
                    ("byName".to_string(), Any::from(by_name.clone())),
                    ("at".to_string(), Any::from(at.clone())),
                ]);
                root.insert(&mut txn, id.as_str(), entry);
            }
            IconOp::Rename { id, name, keywords } => {
                let Some(yrs::Out::YMap(m)) = root.get(&txn, id) else {
                    return Err("no such icon".into());
                };
                let kw: Vec<Any> = tidy_keywords(keywords).into_iter().map(Any::from).collect();
                m.insert(&mut txn, "name", tidy_name(name));
                m.insert(&mut txn, "keywords", Any::from(kw));
            }
            IconOp::Replace {
                id,
                format,
                data,
                width,
                height,
            } => {
                let Some(yrs::Out::YMap(m)) = root.get(&txn, id) else {
                    return Err("no such icon".into());
                };
                let old = decoded_len(cur[id]["data"].as_str().unwrap_or(""));
                if total - old + decoded_len(data) > MAX_ICON_BYTES {
                    return Err("Icons in this document would use more than 1 MB.".into());
                }
                m.insert(&mut txn, "format", format.clone());
                m.insert(&mut txn, "data", data.clone());
                m.insert(&mut txn, "width", *width as f64);
                m.insert(&mut txn, "height", *height as f64);
                m.insert(&mut txn, "bytes", decoded_len(data) as f64);
            }
            IconOp::Remove { id } => {
                if root.remove(&mut txn, id).is_none() {
                    return Err("no such icon".into());
                }
            }
        }
    }
    Ok(scratch.transact().encode_state_as_update_v1(&sv))
}

/// A stored icon as a `data:` URL, checked again (format, base64, PNG magic or the SVG
/// allow-list, size). `None` for anything else: the icon draws as missing.
pub fn data_url(entry: &Value) -> Option<String> {
    let format = entry["format"].as_str()?;
    let b64 = entry["data"].as_str()?;
    if b64.len() > icon_clean::MAX_INPUT * 4 / 3 + 4 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    match format {
        "svg" => {
            let s = std::str::from_utf8(&bytes).ok()?;
            (bytes.len() <= icon_clean::MAX_CLEANED_SVG && icon_clean::allowed(s))
                .then(|| format!("data:image/svg+xml;base64,{b64}"))
        }
        "png" => bytes
            .starts_with(b"\x89PNG\r\n\x1a\n")
            .then(|| format!("data:image/png;base64,{b64}")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add(id: &str, data: &str) -> IconOp {
        IconOp::Add {
            id: id.into(),
            name: "  Jitsi Meet ".into(),
            keywords: vec!["Video".into(), "video".into(), " meetings ".into()],
            format: "svg".into(),
            data: data.into(),
            width: 24,
            height: 24,
            by: "u1".into(),
            by_name: "Lea".into(),
            at: "2026-11-24T10:00:00Z".into(),
        }
    }

    fn run(doc: &Doc, op: &IconOp) -> Result<(), String> {
        let u = apply(doc, op)?;
        crate::ocanvas::apply_update_bytes(doc, &u).map_err(|e| e.to_string())
    }

    #[test]
    fn add_rename_replace_remove_with_limits() {
        let doc = crate::new_doc();
        let svg = base64::engine::general_purpose::STANDARD
            .encode(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0H24V24Z"/></svg>"#);
        run(&doc, &add("jitsi", &svg)).unwrap();
        let l = list(&doc);
        assert_eq!(l["jitsi"]["name"], "Jitsi Meet");
        assert_eq!(
            l["jitsi"]["keywords"],
            serde_json::json!(["video", "meetings"])
        );
        assert!(
            data_url(&l["jitsi"])
                .unwrap()
                .starts_with("data:image/svg+xml;base64,")
        );
        assert!(run(&doc, &add("jitsi", &svg)).is_err(), "ids are unique");
        assert!(run(&doc, &add("Bad Id", &svg)).is_err());
        run(
            &doc,
            &IconOp::Rename {
                id: "jitsi".into(),
                name: "Jitsi".into(),
                keywords: vec![],
            },
        )
        .unwrap();
        assert_eq!(list(&doc)["jitsi"]["name"], "Jitsi");
        run(&doc, &IconOp::Remove { id: "jitsi".into() }).unwrap();
        assert_eq!(list(&doc), serde_json::json!({}));
        // 1 MB of icon data per document.
        let big = "A".repeat(700 * 1024);
        run(&doc, &add("a", &big)).unwrap();
        assert!(run(&doc, &add("b", &big)).unwrap_err().contains("1 MB"));
    }

    #[test]
    fn at_most_200_icons() {
        let doc = crate::new_doc();
        for i in 0..MAX_ICONS {
            run(&doc, &add(&format!("i{i}"), "QUJD")).unwrap();
        }
        assert!(
            run(&doc, &add("one-more", "QUJD"))
                .unwrap_err()
                .contains("200")
        );
    }

    #[test]
    fn a_stored_icon_is_checked_again_before_drawing() {
        let bad = base64::engine::general_purpose::STANDARD
            .encode(r#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#);
        assert!(data_url(&serde_json::json!({"format": "svg", "data": bad})).is_none());
        let fake = base64::engine::general_purpose::STANDARD.encode(b"<svg/>");
        assert!(data_url(&serde_json::json!({"format": "png", "data": fake})).is_none());
        assert!(data_url(&serde_json::json!({"format": "gif", "data": "QUJD"})).is_none());
    }
}
