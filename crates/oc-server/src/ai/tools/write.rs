//! Writing canvas tools. Each runs on a scratch copy of the live doc and returns the update
//! that reproduces it, so a failing call changes nothing and a good one lands as one Yjs
//! transaction in the room actor (docs/24 §6.4).

use serde_json::{Value, json};
use yrs::types::text::{Diff, YChange};
use yrs::types::xml::XmlOut;
use yrs::{
    Any, Array, ArrayRef, Doc, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, Text, Transact,
    TransactionMut, WriteTxn, Xml, XmlElementRef, XmlFragment, XmlTextRef,
};

use oc_model::import::{json_to_any, json_to_in};
use oc_model::patch::{PatchOp, apply_patch};
use oc_model::roots;

use super::read::{self, doc_json, find_block, rev};
use super::{ToolError, WriteMode};

/// The `suggestions` root (ADR-033): `{suggestionId → {id, by, origin, ops, status, at}}`.
pub const SUGGESTIONS: &str = "suggestions";
/// docs/24 §5.2: more deletes than this need confirmation.
pub const CONFIRM_BLOCK_DELETES: usize = 5;
/// docs/24 §9.2: rows written per call.
pub const MAX_ROWS_PER_CALL: usize = 200;
pub const MAX_SHAPES_PER_CALL: usize = 200;

/// Who writes, for records stored in the doc (comments, suggestions).
pub struct Writer {
    pub user_id: String,
    pub name: String,
    pub color: String,
    pub origin: String,
    pub mode_default: WriteMode,
}

pub type Step = Result<(Option<Vec<u8>>, Value), ToolError>;

fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", ulid::Ulid::new().to_string().to_lowercase())
}

fn scratch(doc: &Doc) -> Doc {
    let s = oc_model::new_doc();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    oc_model::ocanvas::apply_update_bytes(&s, &state).expect("own state applies");
    s
}

/// Runs `f` in one transaction on a scratch copy and returns the update plus `f`'s answer.
fn edit(doc: &Doc, f: impl FnOnce(&Doc, &mut TransactionMut) -> Result<Value, ToolError>) -> Step {
    let s = scratch(doc);
    let before = s.transact().state_vector();
    let answer = {
        let mut txn = s.transact_mut();
        f(&s, &mut txn)?
    };
    let update = s.transact().encode_state_as_update_v1(&before);
    Ok((Some(update), answer))
}

fn patch_err(e: oc_model::patch::PatchError) -> ToolError {
    match e {
        oc_model::patch::PatchError::NotFound(_, id) => {
            ToolError::NotFound(format!("BLOCK_NOT_FOUND: no block with blockId {id:?}"))
        }
        other => ToolError::BadInput(other.to_string()),
    }
}

// ---------- canvas_patch ----------

fn mode_of(input: &Value) -> Result<Option<WriteMode>, ToolError> {
    match input["mode"].as_str() {
        None => Ok(None),
        Some("direct") => Ok(Some(WriteMode::Direct)),
        Some("suggest") => Ok(Some(WriteMode::Suggest)),
        Some(m) => Err(ToolError::BadInput(format!("unknown mode {m:?}"))),
    }
}

/// New content lands `direct` unless the call asks for `suggest`; changes to existing content
/// follow the host default (`suggest` unless the host says otherwise), and a call may only
/// downgrade that to `suggest`, never upgrade it.
fn resolve_mode(asked: Option<WriteMode>, changes_existing: bool, default: WriteMode) -> WriteMode {
    match (asked, changes_existing) {
        (Some(WriteMode::Suggest), _) => WriteMode::Suggest,
        (_, false) => WriteMode::Direct,
        (_, true) => default,
    }
}

pub fn canvas_patch(doc: &Doc, input: &Value, w: &Writer) -> Step {
    let ops = input["ops"]
        .as_array()
        .filter(|o| !o.is_empty())
        .ok_or_else(|| ToolError::BadInput("ops must be a non-empty array".into()))?;
    if ops.len() > oc_model::patch::MAX_OPS {
        return Err(ToolError::BadInput(format!(
            "at most {} ops",
            oc_model::patch::MAX_OPS
        )));
    }
    let d = doc_json(doc);
    let mut stale = Vec::new();
    let mut deletes = 0;
    let mut changes_existing = false;
    for (n, op) in ops.iter().enumerate() {
        let kind = op["op"].as_str().unwrap_or_default();
        if !matches!(
            kind,
            "append" | "insertAfter" | "replace" | "delete" | "editText"
        ) {
            return Err(ToolError::BadInput(format!("op {n}: unknown op {kind:?}")));
        }
        if kind == "append" {
            continue;
        }
        let id = op["blockId"]
            .as_str()
            .ok_or_else(|| ToolError::BadInput(format!("op {n}: blockId is required")))?;
        let node = find_block(&d, id).ok_or_else(|| {
            ToolError::NotFound(format!("BLOCK_NOT_FOUND: no block with blockId {id:?}"))
        })?;
        if kind != "insertAfter" {
            changes_existing = true;
        }
        if kind == "delete" {
            deletes += 1;
        }
        if let Some(want) = op["ifMatch"].as_str() {
            let now = rev(node);
            if now != want {
                stale.push(json!({"blockId": id, "rev": now,
                    "markdown": read::markdown_of(&d, std::slice::from_ref(node))}));
            }
        }
    }
    if !stale.is_empty() {
        return Err(ToolError::Stale(read::wrap(json!({"stale": stale}))));
    }
    if deletes > CONFIRM_BLOCK_DELETES && input["confirm"] != true {
        return Err(ToolError::ConfirmationRequired(format!(
            "Delete {deletes} blocks? Repeat the call with \"confirm\": true."
        )));
    }
    let mode = resolve_mode(mode_of(input)?, changes_existing, w.mode_default);
    if mode == WriteMode::Suggest {
        return suggest(doc, ops, &d, w);
    }
    let s = scratch(doc);
    let before = s.transact().state_vector();
    let mut block_ids = Vec::new();
    // Structural ops in order, through the host patch code (oc-model).
    let mut pending: Vec<PatchOp> = Vec::new();
    let flush = |pending: &mut Vec<PatchOp>, ids: &mut Vec<String>| -> Result<(), ToolError> {
        if pending.is_empty() {
            return Ok(());
        }
        let out = apply_patch(&s, pending, &mut || new_id("b")).map_err(patch_err)?;
        oc_model::ocanvas::apply_update_bytes(&s, &out.update)
            .map_err(|e| ToolError::Internal(e.to_string()))?;
        ids.extend(out.block_ids);
        pending.clear();
        Ok(())
    };
    for (n, op) in ops.iter().enumerate() {
        if op["op"] == "editText" {
            flush(&mut pending, &mut block_ids)?;
            edit_text(&s, op, n)?;
            block_ids.push(op["blockId"].as_str().unwrap_or_default().to_string());
        } else {
            let p: PatchOp = serde_json::from_value(op.clone())
                .map_err(|e| ToolError::BadInput(format!("op {n}: {e}")))?;
            pending.push(p);
        }
    }
    flush(&mut pending, &mut block_ids)?;
    let update = s.transact().encode_state_as_update_v1(&before);
    Ok((
        Some(update),
        json!({"applied": ops.len(), "mode": "direct", "blockIds": block_ids, "stale": []}),
    ))
}

/// ADR-033: the ops (with the `rev` each targeted block had) go into the `suggestions` root
/// for a person to accept or reject in the editor. Nothing in `content` changes.
fn suggest(doc: &Doc, ops: &[Value], d: &Value, w: &Writer) -> Step {
    let id = new_id("sg");
    let ops: Vec<Value> = ops
        .iter()
        .map(|op| {
            let mut op = op.clone();
            if let Some(node) = op["blockId"].as_str().and_then(|b| find_block(d, b)) {
                op["rev"] = json!(rev(node));
            }
            op
        })
        .collect();
    let record = json!({
        "id": id, "by": w.user_id, "name": w.name, "origin": w.origin,
        "ops": ops, "status": "pending", "at": crate::util::now_ms(),
    });
    let sid = id.clone();
    edit(doc, move |_, txn| {
        let map = txn.get_or_insert_map(SUGGESTIONS);
        map.insert(txn, sid.as_str(), json_to_any(&record));
        Ok(json!({"applied": 0, "mode": "suggest", "suggestionId": sid, "blockIds": []}))
    })
}

fn find_el<T: ReadTxn>(txn: &T, parent: &impl XmlFragment, id: &str) -> Option<XmlElementRef> {
    for child in parent.children(txn) {
        if let XmlOut::Element(el) = child {
            if el
                .get_attribute(txn, oc_model::patch::BLOCK_ID)
                .is_some_and(|v| v.to_string(txn) == id)
            {
                return Some(el);
            }
            if let Some(hit) = find_el(txn, &el, id) {
                return Some(hit);
            }
        }
    }
    None
}

fn texts_in<T: ReadTxn>(txn: &T, el: &XmlElementRef, out: &mut Vec<XmlTextRef>) {
    for child in el.children(txn) {
        match child {
            XmlOut::Text(t) => out.push(t),
            XmlOut::Element(e) => texts_in(txn, &e, out),
            XmlOut::Fragment(_) => {}
        }
    }
}

/// Plain string of a Y text with embeds as one placeholder unit each (yrs offsets).
fn text_units<T: ReadTxn>(txn: &T, t: &XmlTextRef) -> String {
    let chunks: Vec<Diff<()>> = t.diff(txn, |_: YChange| ());
    chunks
        .iter()
        .map(|c| match &c.insert {
            Out::Any(Any::String(s)) => s.to_string(),
            _ => "\u{1}".to_string(),
        })
        .collect()
}

/// `editText`: each `{find, replace}` becomes a minimal Y.Text edit (remove + insert at the
/// first match), so people typing elsewhere in the paragraph keep their characters.
fn edit_text(s: &Doc, op: &Value, n: usize) -> Result<(), ToolError> {
    let id = op["blockId"].as_str().unwrap_or_default();
    let edits = op["textEdits"]
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or_else(|| ToolError::BadInput(format!("op {n}: textEdits is required")))?;
    let content = s.get_or_insert_xml_fragment(roots::CONTENT);
    let mut txn = s.transact_mut();
    let el = find_el(&txn, &content, id)
        .ok_or_else(|| ToolError::NotFound(format!("BLOCK_NOT_FOUND: {id:?}")))?;
    for e in edits {
        let find = e["find"]
            .as_str()
            .filter(|f| !f.is_empty())
            .ok_or_else(|| ToolError::BadInput(format!("op {n}: textEdits[].find is required")))?;
        let replace = e["replace"].as_str().unwrap_or_default();
        let mut texts = Vec::new();
        texts_in(&txn, &el, &mut texts);
        let hit = texts.iter().find_map(|t| {
            text_units(&txn, t)
                .find(find)
                .map(|at| (t.clone(), at as u32))
        });
        let Some((t, at)) = hit else {
            return Err(ToolError::BadInput(format!(
                "op {n}: text {find:?} not found in block {id:?}"
            )));
        };
        t.remove_range(&mut txn, at, find.len() as u32);
        if !replace.is_empty() {
            t.insert(&mut txn, at, replace);
        }
    }
    Ok(())
}

// ---------- databases ----------

fn sub_map<T: ReadTxn>(txn: &T, m: &MapRef, key: &str) -> Option<MapRef> {
    match m.get(txn, key) {
        Some(Out::YMap(x)) => Some(x),
        _ => None,
    }
}

fn sub_array<T: ReadTxn>(txn: &T, m: &MapRef, key: &str) -> Option<ArrayRef> {
    match m.get(txn, key) {
        Some(Out::YArray(x)) => Some(x),
        _ => None,
    }
}

pub fn db_upsert_rows(doc: &Doc, input: &Value) -> Step {
    let d = doc_json(doc);
    let db_id = input["dbId"]
        .as_str()
        .ok_or_else(|| ToolError::BadInput("dbId is required".into()))?
        .to_string();
    let db = d["databases"]
        .get(&db_id)
        .filter(|v| v.is_object())
        .ok_or_else(|| ToolError::NotFound(format!("no database {db_id:?}")))?
        .clone();
    let rows = input["rows"]
        .as_array()
        .filter(|r| !r.is_empty())
        .ok_or_else(|| ToolError::BadInput("rows must be a non-empty array".into()))?;
    if rows.len() > MAX_ROWS_PER_CALL {
        return Err(ToolError::BadInput(format!(
            "at most {MAX_ROWS_PER_CALL} rows per call"
        )));
    }
    // Resolve field names to ids up front so a bad row changes nothing.
    let mut plan = Vec::new();
    for (n, r) in rows.iter().enumerate() {
        let values = r["values"]
            .as_object()
            .ok_or_else(|| ToolError::BadInput(format!("rows[{n}].values must be an object")))?;
        let mut cells = Vec::new();
        for (k, v) in values {
            let fid = read::field_id(&db, k)
                .ok_or_else(|| ToolError::BadInput(format!("rows[{n}]: no field {k:?}")))?;
            cells.push((fid, v.clone()));
        }
        plan.push((r["rowId"].as_str().map(str::to_string), cells));
    }
    edit(doc, move |_, txn| {
        let dbs = txn.get_or_insert_map(roots::DATABASES);
        let db = sub_map(txn, &dbs, &db_id)
            .ok_or_else(|| ToolError::NotFound(format!("no database {db_id:?}")))?;
        let rows_map = match sub_map(txn, &db, "rows") {
            Some(m) => m,
            None => db.insert(txn, "rows", MapPrelim::default()),
        };
        let order = match sub_array(txn, &db, "order") {
            Some(a) => a,
            None => db.insert(txn, "order", yrs::ArrayPrelim::default()),
        };
        let (mut ids, mut created, mut updated) = (Vec::new(), 0, 0);
        for (row_id, cells) in plan {
            let existing = row_id.as_deref().and_then(|id| sub_map(txn, &rows_map, id));
            let row = match existing {
                Some(r) => {
                    updated += 1;
                    ids.push(row_id.clone().unwrap_or_default());
                    r
                }
                None => {
                    let id = row_id.unwrap_or_else(|| new_id("r"));
                    created += 1;
                    ids.push(id.clone());
                    order.push_back(txn, Any::from(id.as_str()));
                    rows_map.insert(txn, id.as_str(), MapPrelim::default())
                }
            };
            for (fid, v) in cells {
                row.insert(txn, fid.as_str(), json_to_any(&v));
            }
        }
        Ok(json!({"rowIds": ids, "created": created, "updated": updated}))
    })
}

const FIELD_TYPES: [&str; 11] = [
    "title", "text", "status", "select", "tags", "person", "date", "number", "checkbox", "url",
    "progress",
];

fn field_json(f: &Value) -> Result<Value, ToolError> {
    let name = f["name"]
        .as_str()
        .filter(|n| !n.trim().is_empty())
        .ok_or_else(|| ToolError::BadInput("field name is required".into()))?;
    let ty = f["type"].as_str().unwrap_or("text");
    if !FIELD_TYPES.contains(&ty) {
        return Err(ToolError::BadInput(format!("unknown field type {ty:?}")));
    }
    let options: Vec<Value> = f["options"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|o| match o {
                    Value::String(s) => json!({"v": s, "c": "gray"}),
                    other => other.clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    let mut out = json!({"id": new_id("f"), "name": name, "type": ty, "options": options});
    if let Some(d) = f["description"].as_str().filter(|d| !d.trim().is_empty()) {
        out["description"] = json!(d);
    }
    Ok(out)
}

/// Inserts a block node (database or board) after `afterBlockId`, or at the end.
fn insert_block(s: &Doc, input: &Value, node: Value) -> Result<String, ToolError> {
    let op = match input["afterBlockId"].as_str() {
        Some(id) => PatchOp::InsertAfter {
            block_id: id.to_string(),
            markdown: None,
            blocks: Some(vec![node]),
        },
        None => PatchOp::Append {
            markdown: None,
            blocks: Some(vec![node]),
        },
    };
    let out = apply_patch(s, &[op], &mut || new_id("b")).map_err(patch_err)?;
    oc_model::ocanvas::apply_update_bytes(s, &out.update)
        .map_err(|e| ToolError::Internal(e.to_string()))?;
    Ok(out.block_ids.into_iter().next().unwrap_or_default())
}

pub fn db_create(doc: &Doc, input: &Value) -> Step {
    let name = input["name"]
        .as_str()
        .filter(|n| !n.trim().is_empty())
        .ok_or_else(|| ToolError::BadInput("name is required".into()))?;
    let mut fields: Vec<Value> = input["fields"]
        .as_array()
        .map(|a| a.iter().map(field_json).collect::<Result<_, _>>())
        .transpose()?
        .unwrap_or_default();
    if !fields.iter().any(|f| f["type"] == "title") {
        fields.insert(0, field_json(&json!({"name": "Name", "type": "title"}))?);
    }
    let rows = input["rows"].as_array().cloned().unwrap_or_default();
    if rows.len() > MAX_ROWS_PER_CALL {
        return Err(ToolError::BadInput(format!(
            "at most {MAX_ROWS_PER_CALL} rows per call"
        )));
    }
    let db_id = new_id("db");
    let s = scratch(doc);
    let before = s.transact().state_vector();
    let block = insert_block(
        &s,
        input,
        json!({"type": "database", "attrs": {"dbId": db_id}}),
    )?;
    {
        let mut txn = s.transact_mut();
        let dbs = txn.get_or_insert_map(roots::DATABASES);
        let skeleton = json!({"name": name, "icon": "database", "fields": fields,
            "order": [], "notes": {}, "view": "table", "views": {}});
        dbs.insert(&mut txn, db_id.as_str(), json_to_in("", &skeleton));
        if let Some(Out::YMap(db)) = dbs.get(&txn, &db_id) {
            db.insert(&mut txn, "rows", MapPrelim::default());
        }
    }
    let field_ids: Vec<Value> = fields.iter().map(|f| f["id"].clone()).collect();
    let mut row_ids = Vec::new();
    if !rows.is_empty() {
        let (update, out) = db_upsert_rows(&s, &json!({"dbId": db_id, "rows": rows}))?;
        oc_model::ocanvas::apply_update_bytes(&s, &update.unwrap_or_default())
            .map_err(|e| ToolError::Internal(e.to_string()))?;
        row_ids = out["rowIds"].as_array().cloned().unwrap_or_default();
    }
    let update = s.transact().encode_state_as_update_v1(&before);
    Ok((
        Some(update),
        json!({"dbId": db_id, "blockId": block, "fieldIds": field_ids, "rowIds": row_ids}),
    ))
}

pub fn db_add_field(doc: &Doc, input: &Value) -> Step {
    let db_id = input["dbId"]
        .as_str()
        .ok_or_else(|| ToolError::BadInput("dbId is required".into()))?
        .to_string();
    let field = field_json(input)?;
    let fid = field["id"].clone();
    edit(doc, move |_, txn| {
        let dbs = txn.get_or_insert_map(roots::DATABASES);
        let db = sub_map(txn, &dbs, &db_id)
            .ok_or_else(|| ToolError::NotFound(format!("no database {db_id:?}")))?;
        let fields = match sub_array(txn, &db, "fields") {
            Some(a) => a,
            None => db.insert(txn, "fields", yrs::ArrayPrelim::default()),
        };
        fields.push_back(txn, json_to_in("", &field));
        Ok(json!({"fieldId": fid}))
    })
}

// ---------- boards ----------

fn shape_type(kind: &str) -> Result<&'static str, ToolError> {
    Ok(match kind {
        "sticky" => "sticky",
        "rect" => "rect",
        "ellipse" => "ellipse",
        "diamond" => "diamond",
        "text" => "text",
        "arrow" => "arrow",
        other => return Err(ToolError::BadInput(format!("unknown shape kind {other:?}"))),
    })
}

/// Sticky fills are `y p b g`; other shapes take a tone name.
fn fill(kind: &str, tone: Option<&str>) -> Option<String> {
    let tone = tone?;
    if kind == "sticky" {
        return Some(
            match tone {
                "yellow" | "amber" | "y" => "y",
                "pink" | "red" | "purple" | "p" => "p",
                "blue" | "b" => "b",
                "green" | "g" => "g",
                _ => "y",
            }
            .into(),
        );
    }
    Some(tone.to_string())
}

pub fn board_add_shapes(doc: &Doc, input: &Value) -> Step {
    let shapes = input["shapes"]
        .as_array()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ToolError::BadInput("shapes must be a non-empty array".into()))?;
    if shapes.len() > MAX_SHAPES_PER_CALL {
        return Err(ToolError::BadInput(format!(
            "at most {MAX_SHAPES_PER_CALL} shapes per call"
        )));
    }
    let layout = input["layout"].as_str().unwrap_or("grid");
    if !matches!(layout, "grid" | "flow" | "cluster") {
        return Err(ToolError::BadInput(format!("unknown layout {layout:?}")));
    }
    let d = doc_json(doc);
    let s = scratch(doc);
    let before = s.transact().state_vector();
    let (board_id, block) = match input["boardId"].as_str() {
        Some(id) => {
            if !d["boards"].get(id).is_some_and(Value::is_object) {
                return Err(ToolError::NotFound(format!("no board {id:?}")));
            }
            (id.to_string(), None)
        }
        None => {
            let id = new_id("bd");
            let block = insert_block(
                &s,
                input,
                json!({"type": "board", "attrs": {"boardId": id}}),
            )?;
            let mut txn = s.transact_mut();
            let boards = txn.get_or_insert_map(roots::BOARDS);
            boards.insert(
                &mut txn,
                id.as_str(),
                json_to_in("", &json!({"shapes": {}, "order": []})),
            );
            (id, Some(block))
        }
    };
    // Below whatever the board already holds.
    let top = d["boards"][&board_id]["shapes"]
        .as_object()
        .map(|m| {
            m.values()
                .map(|s| s["y"].as_f64().unwrap_or(0.0) + s["h"].as_f64().unwrap_or(0.0))
                .fold(0.0, f64::max)
        })
        .filter(|y| *y > 0.0)
        .map_or(0.0, |y| y + 60.0);
    let boxes: Vec<&Value> = shapes.iter().filter(|s| s["kind"] != "arrow").collect();
    let cols = match layout {
        "flow" => boxes.len().max(1),
        _ => (boxes.len() as f64).sqrt().ceil().max(1.0) as usize,
    };
    let mut refs = serde_json::Map::new();
    let mut placed: Vec<(String, Value)> = Vec::new();
    let mut slot = 0usize;
    for (n, sh) in shapes.iter().enumerate() {
        let kind = shape_type(sh["kind"].as_str().unwrap_or("sticky"))?;
        let id = new_id("s");
        if let Some(r) = sh["ref"].as_str() {
            refs.insert(r.to_string(), json!(id));
        }
        if kind == "arrow" {
            placed.push((id, json!({"type": "arrow", "n": n})));
            continue;
        }
        let (w, h) = match kind {
            "sticky" => (180.0, 120.0),
            "text" => (200.0, 30.0),
            _ => (180.0, 100.0),
        };
        let (gx, gy) = if layout == "flow" {
            (260.0, 0.0)
        } else {
            (220.0, 170.0)
        };
        let x = sh["x"].as_f64().unwrap_or((slot % cols) as f64 * gx);
        let y = sh["y"].as_f64().unwrap_or(top + (slot / cols) as f64 * gy);
        slot += 1;
        let mut v = json!({"type": kind, "x": x, "y": y, "w": w, "h": h});
        if let Some(t) = sh["text"].as_str() {
            v["text"] = json!(t);
        }
        if let Some(f) = fill(kind, sh["tone"].as_str()) {
            v["fill"] = json!(f);
        }
        placed.push((id, v));
    }
    // Arrows: bind ends to refs (or existing shape ids) and draw centre to centre.
    let existing = d["boards"][&board_id]["shapes"].clone();
    let centre = |id: &str, placed: &[(String, Value)]| -> Option<(f64, f64)> {
        let s = placed
            .iter()
            .find(|(i, _)| i == id)
            .map(|(_, v)| v.clone())
            .or_else(|| existing.get(id).cloned())?;
        Some((
            s["x"].as_f64()? + s["w"].as_f64().unwrap_or(0.0) / 2.0,
            s["y"].as_f64()? + s["h"].as_f64().unwrap_or(0.0) / 2.0,
        ))
    };
    let resolve = |r: &Value| -> Option<String> {
        let r = r.as_str()?;
        refs.get(r)
            .and_then(Value::as_str)
            .map(str::to_string)
            .or(Some(r.to_string()))
    };
    let snapshot = placed.clone();
    for (_, v) in placed.iter_mut().filter(|(_, v)| v["type"] == "arrow") {
        let sh = &shapes[v["n"].as_u64().unwrap_or(0) as usize];
        let (from, to) = (resolve(&sh["from"]), resolve(&sh["to"]));
        let (Some(from), Some(to)) = (from, to) else {
            return Err(ToolError::BadInput("arrows need from and to".into()));
        };
        let (Some(a), Some(b)) = (centre(&from, &snapshot), centre(&to, &snapshot)) else {
            return Err(ToolError::BadInput(format!(
                "arrow ends {from:?} → {to:?} not found"
            )));
        };
        let mut arrow = json!({"type": "arrow", "start": {"shapeId": from, "anchor": "center"},
            "end": {"shapeId": to, "anchor": "center"}, "pts": [[a.0, a.1], [b.0, b.1]],
            "x": a.0.min(b.0), "y": a.1.min(b.1), "w": (a.0 - b.0).abs(), "h": (a.1 - b.1).abs()});
        if let Some(t) = sh["text"].as_str() {
            arrow["text"] = json!(t);
        }
        *v = arrow;
    }
    {
        let mut txn = s.transact_mut();
        let boards = txn.get_or_insert_map(roots::BOARDS);
        let board = sub_map(&txn, &boards, &board_id)
            .ok_or_else(|| ToolError::NotFound(format!("no board {board_id:?}")))?;
        let shapes_map = match sub_map(&txn, &board, "shapes") {
            Some(m) => m,
            None => board.insert(&mut txn, "shapes", MapPrelim::default()),
        };
        let order = match sub_array(&txn, &board, "order") {
            Some(a) => a,
            None => board.insert(&mut txn, "order", yrs::ArrayPrelim::default()),
        };
        for (id, v) in &placed {
            let m = shapes_map.insert(&mut txn, id.as_str(), MapPrelim::default());
            for (k, val) in v.as_object().into_iter().flatten() {
                m.insert(&mut txn, k.as_str(), json_to_any(val));
            }
            order.push_back(&mut txn, Any::from(id.as_str()));
        }
    }
    let update = s.transact().encode_state_as_update_v1(&before);
    let ids: Vec<&String> = placed.iter().map(|(i, _)| i).collect();
    Ok((
        Some(update),
        json!({"boardId": board_id, "blockId": block, "shapeIds": refs, "created": ids}),
    ))
}

// ---------- comments ----------

pub fn comment_add(doc: &Doc, input: &Value, w: &Writer) -> Step {
    let text = input["text"]
        .as_str()
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| ToolError::BadInput("text is required".into()))?
        .to_string();
    let d = doc_json(doc);
    let message = json!({"user": w.user_id, "name": w.name, "color": w.color, "text": text,
        "at": crate::util::now_ms()});
    if let Some(thread) = input["threadId"].as_str() {
        let thread = thread.to_string();
        return edit(doc, move |_, txn| {
            let comments = txn.get_or_insert_map(roots::COMMENTS);
            let t = sub_map(txn, &comments, &thread)
                .ok_or_else(|| ToolError::NotFound(format!("no thread {thread:?}")))?;
            let messages = match sub_array(txn, &t, "messages") {
                Some(a) => a,
                None => t.insert(txn, "messages", yrs::ArrayPrelim::default()),
            };
            messages.push_back(txn, json_to_in("", &message));
            Ok(json!({"threadId": thread}))
        });
    }
    let quote = match (input["blockId"].as_str(), input["quote"].as_str()) {
        (Some(b), q) => {
            let node = find_block(&d, b).ok_or_else(|| {
                ToolError::NotFound(format!("BLOCK_NOT_FOUND: no block with blockId {b:?}"))
            })?;
            q.map(str::to_string)
                .unwrap_or_else(|| read::plain(node).chars().take(200).collect())
        }
        (None, Some(q)) => q.to_string(),
        (None, None) => return Err(ToolError::BadInput("blockId or quote is required".into())),
    };
    let id = new_id("t");
    let mut thread = json!({"quote": quote, "resolved": false, "messages": [message]});
    if let Some(b) = input["blockId"].as_str() {
        thread["blockId"] = json!(b);
    }
    edit(doc, move |_, txn| {
        let comments = txn.get_or_insert_map(roots::COMMENTS);
        comments.insert(txn, id.as_str(), json_to_in("", &thread));
        Ok(json!({"threadId": id}))
    })
}

/// Pending suggestions (`suggestions` root), for tests and `suggestions_list` later.
pub fn suggestions(doc: &Doc) -> Value {
    let txn = doc.transact();
    txn.get_map(SUGGESTIONS)
        .map(|m| oc_model::doc::any_to_json(&yrs::types::ToJson::to_json(&m, &txn)))
        .unwrap_or_else(|| json!({}))
}
