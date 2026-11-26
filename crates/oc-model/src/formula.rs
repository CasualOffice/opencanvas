// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Computed database values for exports, the API, MCP and `search.json` (ADR-078, DB-A6).
//! Only formula expressions and relation row ids are stored; this runs `oc_formula::compute`
//! over a database of the logical JSON ([`crate::doc_to_json`]) with its same-canvas related
//! databases, and overlays the results on the stored rows.

use serde_json::{Map, Value, json};

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// Row ids in display order: `order`, then rows missing from it.
pub fn row_ids(db: &Value) -> Vec<String> {
    let rows = db["rows"].as_object();
    let mut ids: Vec<String> = db["order"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if let Some(r) = rows {
        for k in r.keys() {
            if !ids.contains(k) {
                ids.push(k.clone());
            }
        }
        ids.retain(|id| r.contains_key(id));
    }
    ids
}

/// A stored database as the engine's `{fields, rows: [{id, v}]}`.
fn engine_db(db: &Value) -> Value {
    let rows: Vec<Value> = row_ids(db)
        .into_iter()
        .map(|id| json!({"id": id, "v": db["rows"][&id]}))
        .collect();
    json!({"fields": db["fields"], "rows": rows})
}

fn has_computed(db: &Value) -> bool {
    db["fields"].as_array().is_some_and(|f| {
        f.iter()
            .any(|f| matches!(s(f, "type"), "formula" | "rollup" | "relation"))
    })
}

/// The engine's output for database `id` (`{fields, rows}`), or `None` when it has no
/// formula, rollup or relation fields. Relations across canvases have no rows here (the live
/// projection is the editor's), so their rollups are empty.
pub fn compute(doc: &Value, id: &str) -> Option<Value> {
    let db = &doc["databases"][id];
    if !has_computed(db) {
        return None;
    }
    let mut input = engine_db(db);
    let mut related = Map::new();
    for f in db["fields"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| s(f, "type") == "relation")
    {
        let key = oc_formula::rel_key(f);
        if s(&f["rel"], "file").is_empty() && !related.contains_key(&key) {
            let target = &doc["databases"][&key];
            if target.is_object() {
                related.insert(key, engine_db(target));
            }
        }
    }
    input["related"] = Value::Object(related);
    if let Some(p) = doc["people"].as_object() {
        input["people"] = Value::Object(
            p.iter()
                .map(|(k, v)| (k.clone(), json!(s(v, "name"))))
                .collect(),
        );
    }
    Some(oc_formula::compute(&input))
}

/// Stored rows with computed values overlaid: formula and rollup fields get their values
/// (errors as `{err, msg}`), relation fields stay row ids.
pub fn rows_with_values(doc: &Value, id: &str) -> Map<String, Value> {
    let db = &doc["databases"][id];
    let mut rows = db["rows"].as_object().cloned().unwrap_or_default();
    if let Some(out) = compute(doc, id) {
        for (rid, vals) in out["rows"].as_object().into_iter().flatten() {
            if let (Some(row), Some(vals)) = (
                rows.get_mut(rid).and_then(Value::as_object_mut),
                vals.as_object(),
            ) {
                for (k, v) in vals {
                    row.insert(k.clone(), v.clone());
                }
            }
        }
    }
    rows
}

/// Display text for a computed or relation cell: numbers as people read them, errors as their
/// code, relations as the related rows' titles.
pub fn cell_text(doc: &Value, field: &Value, v: &Value) -> Option<String> {
    match s(field, "type") {
        "formula" | "rollup" => Some(match v {
            Value::Object(o) if o.contains_key("err") => s(v, "err").to_string(),
            Value::Number(n) => {
                let t = oc_formula::eval::fmt_num(n.as_f64().unwrap_or(0.0));
                if s(&field["roll"], "fn") == "percent" {
                    format!("{t}%")
                } else {
                    t
                }
            }
            Value::Null => String::new(),
            other => oc_formula::cell_value("text", other, &Value::Null).text(),
        }),
        "relation" => {
            let target = &doc["databases"][s(&field["rel"], "db")];
            let title = target["fields"]
                .as_array()
                .and_then(|f| f.iter().find(|f| s(f, "type") == "title").or(f.first()))
                .map(|f| s(f, "id"))
                .unwrap_or("");
            let ids = v.as_array()?;
            Some(
                ids.iter()
                    .filter_map(Value::as_str)
                    .filter_map(|rid| {
                        target["rows"]
                            .get(rid)
                            .map(|r| r[title].as_str().unwrap_or(rid).to_string())
                    })
                    .collect::<Vec<_>>()
                    .join(", "),
            )
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_formulas_rollups_and_relation_titles() {
        let doc = json!({"databases": {
            "b": {"name": "Budget", "fields": [
                {"id": "t", "name": "Item", "type": "title"}, {"id": "p", "name": "Price", "type": "number"},
                {"id": "x", "name": "Total", "type": "formula", "formula": "prop(\"Price\") * 2"},
                {"id": "r", "name": "Tasks", "type": "relation", "rel": {"db": "k"}},
                {"id": "c", "name": "Done", "type": "rollup", "roll": {"rel": "r", "f": "d", "fn": "percent"}}],
                "order": ["r1"], "rows": {"r1": {"t": "Venue", "p": 4, "r": ["k1", "k2"]}}},
            "k": {"name": "Tasks", "fields": [{"id": "n", "name": "Task", "type": "title"}, {"id": "d", "name": "Done", "type": "checkbox"}],
                "order": ["k1", "k2"], "rows": {"k1": {"n": "Book", "d": true}, "k2": {"n": "Pay", "d": false}}}
        }});
        let rows = rows_with_values(&doc, "b");
        assert_eq!(rows["r1"]["x"], json!(8.0));
        assert_eq!(rows["r1"]["c"], json!(50.0));
        let f = &doc["databases"]["b"]["fields"];
        assert_eq!(cell_text(&doc, &f[2], &rows["r1"]["x"]).unwrap(), "8");
        assert_eq!(
            cell_text(&doc, &f[3], &rows["r1"]["r"]).unwrap(),
            "Book, Pay"
        );
        assert_eq!(cell_text(&doc, &f[4], &rows["r1"]["c"]).unwrap(), "50%");
        let (_, _, table) = crate::export::database_table(&doc, "b");
        assert_eq!(table[0], vec!["Venue", "4", "8", "Book, Pay", "50%"]);
    }
}
