// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! People in a document (docs/21): which ids it refers to, and rendering them for one viewer.
//!
//! The document stores ids plus a snapshot label that the author saw. Exports show the canvas
//! members' current names (docs/21 revision 2): [`relabel`] rewrites mention labels, database
//! person cells and the `people` map before a renderer sees them. E-mail is never kept.

use std::collections::{BTreeSet, HashMap};

use serde_json::Value;

fn walk_mentions(n: &Value, out: &mut BTreeSet<String>) {
    if n["type"] == "mention"
        && let Some(id) = n["attrs"]["id"].as_str()
    {
        out.insert(id.to_string());
    }
    if let Some(c) = n["content"].as_array() {
        for x in c {
            walk_mentions(x, out);
        }
    }
}

fn person_fields(db: &Value) -> Vec<String> {
    db["fields"]
        .as_array()
        .map(|f| {
            f.iter()
                .filter(|f| f["type"] == "person")
                .filter_map(|f| f["id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Every person id `doc` (the `document.json` shape) refers to: mentions, database person
/// cells, comment authors and mentions, and the `people` map.
pub fn referenced_ids(doc: &Value) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    if let Some(c) = doc["content"].as_array() {
        for n in c {
            walk_mentions(n, &mut out);
        }
    }
    if let Some(dbs) = doc["databases"].as_object() {
        for db in dbs.values() {
            let fields = person_fields(db);
            if let Some(rows) = db["rows"].as_object() {
                for row in rows.values() {
                    for f in &fields {
                        if let Some(id) = row[f].as_str().filter(|s| !s.is_empty()) {
                            out.insert(id.to_string());
                        }
                    }
                }
            }
        }
    }
    if let Some(threads) = doc["comments"].as_object() {
        for t in threads.values() {
            for m in t["messages"].as_array().into_iter().flatten() {
                if let Some(u) = m["user"].as_str() {
                    out.insert(u.to_string());
                }
                for id in m["mentions"].as_array().into_iter().flatten() {
                    if let Some(id) = id.as_str() {
                        out.insert(id.to_string());
                    }
                }
            }
        }
    }
    if let Some(p) = doc["people"].as_object() {
        out.extend(p.keys().cloned());
    }
    out
}

fn relabel_node(n: &mut Value, names: &HashMap<String, String>) {
    if n["type"] == "mention"
        && let Some(id) = n["attrs"]["id"].as_str().map(String::from)
        && let Some(name) = names.get(&id)
    {
        n["attrs"]["label"] = Value::String(name.clone());
    }
    if let Some(c) = n.get_mut("content").and_then(Value::as_array_mut) {
        for x in c {
            relabel_node(x, names);
        }
    }
}

/// Drops any `email` from the `people` map (older files may carry one; docs/21 revision 2
/// never shows or keeps it).
pub fn strip_emails(doc: &mut Value) {
    if let Some(people) = doc.get_mut("people").and_then(Value::as_object_mut) {
        for p in people.values_mut() {
            if let Some(o) = p.as_object_mut() {
                o.remove("email");
            }
        }
    }
}

/// Rewrites `doc` with current names: `names` maps a member id to their current name; ids not
/// in `names` (no longer members) keep their snapshot label. Person cells become names (an
/// export reader can't look ids up), and e-mail addresses are dropped.
pub fn relabel(doc: &mut Value, names: &HashMap<String, String>) {
    if let Some(c) = doc.get_mut("content").and_then(Value::as_array_mut) {
        for n in c {
            relabel_node(n, names);
        }
    }
    if let Some(dbs) = doc.get_mut("databases").and_then(Value::as_object_mut) {
        for db in dbs.values_mut() {
            let fields = person_fields(db);
            if let Some(rows) = db.get_mut("rows").and_then(Value::as_object_mut) {
                for row in rows.values_mut() {
                    for f in &fields {
                        let Some(id) = row[f].as_str().map(String::from) else {
                            continue;
                        };
                        if let Some(name) = names.get(&id) {
                            row[f] = Value::String(name.clone());
                        }
                    }
                }
            }
        }
    }
    if let Some(people) = doc.get_mut("people").and_then(Value::as_object_mut) {
        for (id, p) in people.iter_mut() {
            if let Some(name) = names.get(id) {
                p["name"] = Value::String(name.clone());
            }
        }
    }
    strip_emails(doc);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc() -> Value {
        json!({
            "content": [{"type": "paragraph", "content": [
                {"type": "text", "text": "Ask "},
                {"type": "mention", "attrs": {"id": "u_ravi", "label": "Ravi Menon"}},
                {"type": "mention", "attrs": {"id": "u_asha", "label": "Asha Rao"}},
                {"type": "mention", "attrs": {"id": "u_old", "label": "Old Name"}}
            ]}],
            "databases": {"d1": {"fields": [{"id": "f1", "type": "title"}, {"id": "f2", "type": "person"}],
                "rows": {"r1": {"f1": "Task", "f2": "u_ravi"}}}},
            "comments": {"t1": {"messages": [{"user": "u_sam", "text": "hi", "mentions": ["u_asha"]}]}},
            "people": {"u_ravi": {"id": "u_ravi", "name": "Ravi Menon", "email": "r@acme.example"},
                       "u_asha": {"id": "u_asha", "name": "Asha Rao", "email": "a@acme.example"}}
        })
    }

    #[test]
    fn finds_every_reference() {
        let ids: Vec<String> = referenced_ids(&doc()).into_iter().collect();
        assert_eq!(ids, ["u_asha", "u_old", "u_ravi", "u_sam"]);
    }

    /// docs/21 revision 2: exports show members' current names and never an e-mail.
    #[test]
    fn relabels_with_current_names() {
        let mut d = doc();
        let names = HashMap::from([
            ("u_ravi".to_string(), "Ravi M.".to_string()),
            ("u_asha".to_string(), "Asha Rao-Iyer".to_string()),
        ]);
        relabel(&mut d, &names);
        let s = d.to_string();
        assert!(!s.contains("@acme"), "{s}");
        assert!(s.contains("Asha Rao-Iyer"));
        assert!(s.contains("Old Name"), "non-members keep the snapshot");
        assert_eq!(d["databases"]["d1"]["rows"]["r1"]["f2"], "Ravi M.");
        assert_eq!(d["people"]["u_ravi"]["name"], "Ravi M.");
    }
}
