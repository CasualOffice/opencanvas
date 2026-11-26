// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The automation engine as pure functions over a document (AUTO-02): what a batch of edits
//! changed ([`Snapshot`], [`diff`]), which rules it triggers ([`triggered`]), their conditions
//! ([`conditions_hold`]), what a run would do ([`plan`]) and the update that does it
//! ([`apply`]), one transaction for the whole run. A test run is [`plan`] without [`apply`].

use std::collections::{BTreeMap, HashMap};

use oc_model::automation::{Action, Condition, Rule, Trigger};
use serde_json::{Map as JsonMap, Value, json};
use yrs::types::xml::XmlOut;
use yrs::{
    Array, Doc, GetString, Map, MapRef, Out, ReadTxn, StateVector, Transact, Xml, XmlFragment,
};

/// What changed in one batch, as automation sees it.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    RowAdded {
        db: String,
        row: String,
    },
    FieldChanged {
        db: String,
        row: String,
        field: String,
        from: Value,
        to: Value,
    },
    Checked {
        block: String,
        list: Option<String>,
        text: String,
    },
    CommentAdded {
        thread: String,
        mentions: Vec<String>,
    },
    /// A date or schedule slot (UTC seconds); date rules act on each row whose date matches.
    Tick {
        slot: i64,
        date: Option<String>,
    },
}

impl Event {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::RowAdded { .. } => "row.added",
            Self::FieldChanged { .. } => "field.changed",
            Self::Checked { .. } => "checklist.checked",
            Self::CommentAdded { mentions, .. } if !mentions.is_empty() => "mention.added",
            Self::CommentAdded { .. } => "comment.added",
            Self::Tick { date: Some(_), .. } => "date.reached",
            Self::Tick { .. } => "schedule",
        }
    }
    /// A stable id for the run this event starts (idempotency, once across nodes).
    pub fn key(&self) -> String {
        match self {
            Self::RowAdded { db, row } => format!("ra:{db}:{row}"),
            Self::FieldChanged {
                db, row, field, to, ..
            } => format!("fc:{db}:{row}:{field}:{to}"),
            Self::Checked { block, .. } => format!("ck:{block}"),
            Self::CommentAdded { thread, .. } => format!("cm:{thread}"),
            Self::Tick { slot, .. } => format!("t:{slot}"),
        }
    }
}

/// The parts of a document automation watches.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Snapshot {
    /// (db, row) → fields.
    rows: BTreeMap<(String, String), JsonMap<String, Value>>,
    /// taskItem blockId → (checked, text, enclosing taskList blockId).
    todos: HashMap<String, (bool, String, Option<String>)>,
    /// thread → message count.
    threads: HashMap<String, usize>,
}

fn out_json<T: ReadTxn>(txn: &T, o: &Out) -> Value {
    oc_model::doc::out_to_json(txn, o)
}

fn map_get<T: ReadTxn>(txn: &T, m: &MapRef, k: &str) -> Option<Out> {
    m.get(txn, k)
}

fn xml_text<T: ReadTxn>(txn: &T, node: &XmlOut) -> String {
    match node {
        XmlOut::Text(t) => t.get_string(txn),
        XmlOut::Element(e) => e.children(txn).map(|c| xml_text(txn, &c)).collect(),
        XmlOut::Fragment(f) => f.children(txn).map(|c| xml_text(txn, &c)).collect(),
    }
}

fn attr<T: ReadTxn>(txn: &T, e: &yrs::XmlElementRef, k: &str) -> Value {
    e.get_attribute(txn, k)
        .map(|o| out_json(txn, &o))
        .unwrap_or(Value::Null)
}

fn walk_todos<T: ReadTxn>(
    txn: &T,
    node: XmlOut,
    list: Option<String>,
    out: &mut HashMap<String, (bool, String, Option<String>)>,
) {
    let XmlOut::Element(e) = node else { return };
    let tag = e.tag().to_string();
    let id = attr(txn, &e, "blockId").as_str().map(String::from);
    if tag == "taskItem"
        && let Some(id) = id.clone()
    {
        let checked = match attr(txn, &e, "checked") {
            Value::Bool(b) => b,
            Value::String(s) => s == "true",
            _ => false,
        };
        let text: String = e
            .children(txn)
            .filter(|c| matches!(c, XmlOut::Element(p) if p.tag().as_ref() == "paragraph"))
            .map(|c| xml_text(txn, &c))
            .collect::<Vec<_>>()
            .join(" ");
        out.insert(id, (checked, text, list.clone()));
    }
    let next = if tag == "taskList" { id.or(list) } else { list };
    for c in e.children(txn) {
        walk_todos(txn, c, next.clone(), out);
    }
}

impl Snapshot {
    /// Reads what `rules` watch: their databases, checklists, comments.
    pub fn take(doc: &Doc, rules: &[Rule]) -> Self {
        let mut s = Self::default();
        let txn = doc.transact();
        let dbs: Vec<&str> = rules.iter().filter_map(|r| r.trigger.database()).collect();
        if !dbs.is_empty()
            && let Some(root) = txn.get_map(oc_model::roots::DATABASES)
        {
            for db in dbs {
                let Some(Out::YMap(m)) = map_get(&txn, &root, db) else {
                    continue;
                };
                let Some(Out::YMap(rows)) = map_get(&txn, &m, "rows") else {
                    continue;
                };
                for (rid, row) in rows.iter(&txn) {
                    let fields = match out_json(&txn, &row) {
                        Value::Object(o) => o,
                        _ => JsonMap::new(),
                    };
                    s.rows.insert((db.to_string(), rid.to_string()), fields);
                }
            }
        }
        if rules
            .iter()
            .any(|r| matches!(r.trigger, Trigger::ChecklistChecked { .. }))
            && let Some(f) = txn.get_xml_fragment(oc_model::roots::CONTENT)
        {
            for c in f.children(&txn) {
                walk_todos(&txn, c, None, &mut s.todos);
            }
        }
        if rules.iter().any(|r| {
            matches!(
                r.trigger,
                Trigger::CommentAdded {} | Trigger::MentionAdded {}
            )
        }) && let Some(m) = txn.get_map(oc_model::roots::COMMENTS)
        {
            for (id, t) in m.iter(&txn) {
                let n = out_json(&txn, &t)["messages"]
                    .as_array()
                    .map_or(0, Vec::len);
                s.threads.insert(id.to_string(), n);
            }
        }
        s
    }
}

/// The events between two snapshots, in a stable order.
pub fn diff(before: &Snapshot, after: &Snapshot, doc: &Doc) -> Vec<Event> {
    let mut out = vec![];
    for ((db, row), fields) in &after.rows {
        match before.rows.get(&(db.clone(), row.clone())) {
            None => out.push(Event::RowAdded {
                db: db.clone(),
                row: row.clone(),
            }),
            Some(old) => {
                let mut keys: Vec<&String> = fields.keys().chain(old.keys()).collect();
                keys.sort();
                keys.dedup();
                for k in keys {
                    let (a, b) = (
                        old.get(k).cloned().unwrap_or(Value::Null),
                        fields.get(k).cloned().unwrap_or(Value::Null),
                    );
                    if a != b {
                        out.push(Event::FieldChanged {
                            db: db.clone(),
                            row: row.clone(),
                            field: k.clone(),
                            from: a,
                            to: b,
                        });
                    }
                }
            }
        }
    }
    let mut todos: Vec<_> = after.todos.iter().collect();
    todos.sort_by(|a, b| a.0.cmp(b.0));
    for (id, (checked, text, list)) in todos {
        let was = before.todos.get(id).map(|t| t.0);
        if *checked && was == Some(false) {
            out.push(Event::Checked {
                block: id.clone(),
                list: list.clone(),
                text: text.clone(),
            });
        }
    }
    let mut threads: Vec<_> = after.threads.iter().collect();
    threads.sort();
    for (id, n) in threads {
        if before.threads.get(id).is_none_or(|b| b < n) {
            let mentions = thread_mentions(doc, id);
            out.push(Event::CommentAdded {
                thread: id.clone(),
                mentions,
            });
        }
    }
    out
}

fn thread_mentions(doc: &Doc, thread: &str) -> Vec<String> {
    let txn = doc.transact();
    let Some(m) = txn.get_map(oc_model::roots::COMMENTS) else {
        return vec![];
    };
    let Some(t) = m.get(&txn, thread) else {
        return vec![];
    };
    let v = out_json(&txn, &t);
    v["messages"]
        .as_array()
        .and_then(|a| a.last())
        .and_then(|m| m["mentions"].as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// The text of a cell for conditions and templates (option labels, ids, numbers as text).
pub fn cell_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Array(a) => a.iter().map(cell_text).collect::<Vec<_>>().join(", "),
        Value::Object(o) => o.get("v").map(cell_text).unwrap_or_default(),
        other => other.to_string(),
    }
}

fn same(a: &Value, b: &Value) -> bool {
    a == b || cell_text(a).eq_ignore_ascii_case(&cell_text(b))
}

/// Whether `rule`'s trigger fires for `ev`.
pub fn triggered(rule: &Rule, ev: &Event) -> bool {
    match (&rule.trigger, ev) {
        (Trigger::RowAdded { database }, Event::RowAdded { db, .. }) => database == db,
        (
            Trigger::FieldChanged {
                database,
                field,
                to,
            },
            Event::FieldChanged {
                db,
                field: f,
                to: t,
                ..
            },
        ) => database == db && field == f && to.as_ref().is_none_or(|want| same(want, t)),
        (Trigger::ChecklistChecked { block }, Event::Checked { block: b, list, .. }) => block
            .as_ref()
            .is_none_or(|want| want == b || list.as_ref() == Some(want)),
        (Trigger::CommentAdded {}, Event::CommentAdded { .. }) => true,
        (Trigger::MentionAdded {}, Event::CommentAdded { mentions, .. }) => !mentions.is_empty(),
        (Trigger::DateReached { .. } | Trigger::Schedule { .. }, Event::Tick { .. }) => true,
        _ => false,
    }
}

/// A database as automation reads it.
#[derive(Debug, Clone, Default)]
pub struct Db {
    pub id: String,
    pub name: String,
    /// (id, name, type).
    pub fields: Vec<(String, String, String)>,
    pub rows: BTreeMap<String, JsonMap<String, Value>>,
}

impl Db {
    pub fn read(doc: &Doc, id: &str) -> Option<Self> {
        let j = oc_model::doc_to_json(doc);
        let d = j["databases"].get(id)?;
        let fields = d["fields"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|f| {
                        let s = |k: &str| f[k].as_str().unwrap_or_default().to_string();
                        (s("id"), s("name"), s("type"))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let rows = d["rows"]
            .as_object()
            .map(|r| {
                r.iter()
                    .map(|(k, v)| (k.clone(), v.as_object().cloned().unwrap_or_default()))
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            id: id.to_string(),
            name: d["name"].as_str().unwrap_or("Database").to_string(),
            fields,
            rows,
        })
    }
    /// A field by id or (case-insensitively) by name.
    pub fn field(&self, key: &str) -> Option<&(String, String, String)> {
        self.fields
            .iter()
            .find(|f| f.0 == key)
            .or_else(|| self.fields.iter().find(|f| f.1.eq_ignore_ascii_case(key)))
    }
    pub fn title_of(&self, row: &str) -> String {
        let r = self.rows.get(row);
        self.fields
            .iter()
            .find(|f| f.2 == "title")
            .and_then(|f| r.and_then(|r| r.get(&f.0)))
            .map(cell_text)
            .unwrap_or_default()
    }
}

fn condition_holds(
    c: &Condition,
    db: Option<&Db>,
    row: Option<&JsonMap<String, Value>>,
    today: &str,
) -> bool {
    let v = match (db, row) {
        (Some(db), Some(row)) => db
            .field(&c.field)
            .and_then(|f| row.get(&f.0))
            .cloned()
            .unwrap_or(Value::Null),
        _ => Value::Null,
    };
    let text = cell_text(&v);
    let want = c.value.as_ref().map(|w| match w.as_str() {
        Some("today") => today.to_string(),
        _ => cell_text(w),
    });
    let want = want.unwrap_or_default();
    let list: Vec<String> = match &v {
        Value::Array(a) => a.iter().map(cell_text).collect(),
        _ => vec![text.clone()],
    };
    match c.op.as_str() {
        "is" => list.iter().any(|x| x.eq_ignore_ascii_case(&want)),
        "isNot" => !list.iter().any(|x| x.eq_ignore_ascii_case(&want)),
        "contains" => text.to_lowercase().contains(&want.to_lowercase()),
        "notContains" => !text.to_lowercase().contains(&want.to_lowercase()),
        "isEmpty" => text.trim().is_empty(),
        "isNotEmpty" => !text.trim().is_empty(),
        "before" => !text.is_empty() && text.as_str() < want.as_str(),
        "after" => !text.is_empty() && text.as_str() > want.as_str(),
        _ => false,
    }
}

/// `Ok` when the conditions hold; `Err(i)`: the first that failed (`all`), or the first (`any`).
pub fn conditions_hold(
    rule: &Rule,
    db: Option<&Db>,
    row: Option<&str>,
    today: &str,
) -> Result<(), usize> {
    if rule.conditions.is_empty() {
        return Ok(());
    }
    let r = row.and_then(|id| db.and_then(|d| d.rows.get(id)));
    let res: Vec<bool> = rule
        .conditions
        .iter()
        .map(|c| condition_holds(c, db, r, today))
        .collect();
    if rule.match_mode == "any" {
        if res.iter().any(|x| *x) {
            Ok(())
        } else {
            Err(0)
        }
    } else {
        match res.iter().position(|x| !*x) {
            None => Ok(()),
            Some(i) => Err(i),
        }
    }
}

/// What a run does.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Plan {
    pub writes: Vec<Write>,
    /// (user ids, text).
    pub notify: Vec<(Vec<String>, String)>,
    /// (url, fields sent).
    pub calls: Vec<(String, JsonMap<String, Value>)>,
    /// What each action would do, in words (test run).
    pub effects: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Write {
    SetField {
        db: String,
        row: String,
        field: String,
        value: Value,
    },
    MoveRow {
        from: String,
        row: String,
        to: String,
    },
    SetTodo {
        block: String,
        checked: bool,
    },
    AddTodos {
        after: Option<String>,
        heading: Option<String>,
        items: Vec<String>,
    },
    AddComment {
        block: Option<String>,
        text: String,
    },
}

impl Plan {
    /// Changes to the canvas (for `max_changes` and the run log).
    pub fn changes(&self) -> usize {
        self.writes
            .iter()
            .map(|w| match w {
                Write::AddTodos { items, heading, .. } => {
                    items.len() + usize::from(heading.is_some())
                }
                _ => 1,
            })
            .sum()
    }
}

/// What the run is about: the triggering row, block, actor.
#[derive(Debug, Clone, Default)]
pub struct Subject {
    pub db: Option<String>,
    pub row: Option<String>,
    pub block: Option<String>,
    pub actor: Option<(String, String)>,
    pub text: Option<String>,
}

impl Subject {
    pub fn of(ev: &Event) -> Self {
        match ev {
            Event::RowAdded { db, row } | Event::FieldChanged { db, row, .. } => Self {
                db: Some(db.clone()),
                row: Some(row.clone()),
                ..Self::default()
            },
            Event::Checked { block, text, .. } => Self {
                block: Some(block.clone()),
                text: Some(text.clone()),
                ..Self::default()
            },
            _ => Self::default(),
        }
    }
}

/// Context for templates and "today".
pub struct Cx<'a> {
    pub canvas_title: &'a str,
    pub rule_name: &'a str,
    pub today: &'a str,
}

/// `{row.title}`, `{field.<name>}`, `{actor.name}`, `{canvas.title}`, `{rule.name}`,
/// `{item.text}`: plain substitutions, no expressions; unknown ones stay as written.
pub fn render(t: &str, db: Option<&Db>, s: &Subject, cx: &Cx) -> String {
    let mut out = String::with_capacity(t.len());
    let mut rest = t;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let Some(j) = rest[i..].find('}') else {
            out.push_str(&rest[i..]);
            return out;
        };
        let key = &rest[i + 1..i + j];
        let val = match key {
            "row.title" => db.zip(s.row.as_deref()).map(|(d, r)| d.title_of(r)),
            "actor.name" => s.actor.as_ref().map(|a| a.1.clone()),
            "canvas.title" => Some(cx.canvas_title.to_string()),
            "rule.name" => Some(cx.rule_name.to_string()),
            "item.text" => s.text.clone(),
            k if k.starts_with("field.") => db.zip(s.row.as_deref()).and_then(|(d, r)| {
                let f = d.field(&k[6..])?;
                Some(cell_text(d.rows.get(r)?.get(&f.0).unwrap_or(&Value::Null)))
            }),
            _ => None,
        };
        match val {
            Some(v) => out.push_str(&v),
            None => out.push_str(&rest[i..=i + j]),
        }
        rest = &rest[i + j + 1..];
    }
    out.push_str(rest);
    out
}

/// Plans `rule`'s actions for `s`. `Err`: why the rule cannot run (a broken reference).
pub fn plan(doc: &Doc, rule: &Rule, s: &Subject, cx: &Cx) -> Result<Plan, String> {
    let db = s.db.as_deref().and_then(|id| Db::read(doc, id));
    let mut p = Plan::default();
    for a in &rule.actions {
        match a {
            Action::FieldSet { field, value } => {
                let (Some(db), Some(row)) = (db.as_ref(), s.row.as_ref()) else {
                    return Err("set a field needs a row".into());
                };
                let f = db.field(field).ok_or_else(|| {
                    format!("the field {field:?} no longer exists in {}", db.name)
                })?;
                let value = match value.as_str() {
                    Some("today") => json!(cx.today),
                    Some("actor") => s.actor.as_ref().map(|a| json!(a.0)).unwrap_or(Value::Null),
                    _ => value.clone(),
                };
                p.effects
                    .push(format!("Would set {} to {}", f.1, cell_text(&value)));
                p.writes.push(Write::SetField {
                    db: db.id.clone(),
                    row: row.clone(),
                    field: f.0.clone(),
                    value,
                });
            }
            Action::RowMove { to } => {
                let (Some(db), Some(row)) = (db.as_ref(), s.row.as_ref()) else {
                    return Err("move a row needs a row".into());
                };
                let target = Db::read(doc, &to.database).ok_or_else(|| {
                    "the target database was deleted from this canvas".to_string()
                })?;
                if target.id == db.id {
                    return Err("a row moves to another database".into());
                }
                let matched = db
                    .fields
                    .iter()
                    .filter(|f| target.field(&f.1).is_some())
                    .count();
                p.effects.push(format!(
                    "Would move the row to {} ({matched} fields match)",
                    target.name
                ));
                p.writes.push(Write::MoveRow {
                    from: db.id.clone(),
                    row: row.clone(),
                    to: target.id.clone(),
                });
            }
            Action::TodoSet { block, checked } => {
                let b = block
                    .clone()
                    .or_else(|| s.block.clone())
                    .ok_or("check an item needs an item")?;
                p.effects.push(format!(
                    "Would {} the item",
                    if *checked { "check" } else { "uncheck" }
                ));
                p.writes.push(Write::SetTodo {
                    block: b,
                    checked: *checked,
                });
            }
            Action::TodoAdd {
                items,
                heading,
                after,
            } => {
                let items: Vec<String> = items
                    .iter()
                    .map(|i| render(i, db.as_ref(), s, cx))
                    .collect();
                p.effects
                    .push(format!("Would add a checklist of {} items", items.len()));
                p.writes.push(Write::AddTodos {
                    after: after.clone(),
                    heading: heading.as_ref().map(|h| render(h, db.as_ref(), s, cx)),
                    items,
                });
            }
            Action::CommentAdd { text } => {
                let text = render(text, db.as_ref(), s, cx);
                p.effects.push("Would add a comment".into());
                p.writes.push(Write::AddComment {
                    block: s.block.clone(),
                    text,
                });
            }
            Action::Notify { people, text } => {
                let mut ids = vec![];
                for who in people {
                    if let Some(f) = who.strip_prefix("field:") {
                        let (Some(db), Some(row)) = (db.as_ref(), s.row.as_ref()) else {
                            continue;
                        };
                        let Some(fd) = db.field(f) else {
                            return Err(format!("the person field {f:?} no longer exists"));
                        };
                        match db.rows.get(row).and_then(|r| r.get(&fd.0)) {
                            Some(Value::String(id)) if !id.is_empty() => ids.push(id.clone()),
                            Some(Value::Array(a)) => {
                                ids.extend(a.iter().filter_map(|x| x.as_str().map(String::from)))
                            }
                            _ => {}
                        }
                    } else if who == "actor" {
                        ids.extend(s.actor.as_ref().map(|a| a.0.clone()));
                    } else {
                        ids.push(who.clone());
                    }
                }
                ids.sort();
                ids.dedup();
                p.effects.push(format!(
                    "Would notify {} through the host",
                    if ids.is_empty() {
                        "nobody".to_string()
                    } else {
                        ids.join(", ")
                    }
                ));
                if !ids.is_empty() {
                    p.notify.push((ids, render(text, db.as_ref(), s, cx)));
                }
            }
            Action::HttpPost { url, fields } => {
                let mut sent = JsonMap::new();
                if let (Some(db), Some(row)) = (db.as_ref(), s.row.as_ref()) {
                    for f in fields {
                        if let Some(fd) = db.field(f) {
                            let v = db
                                .rows
                                .get(row)
                                .and_then(|r| r.get(&fd.0))
                                .cloned()
                                .unwrap_or(Value::Null);
                            sent.insert(fd.1.clone(), v);
                        }
                    }
                }
                if let Some(t) = &s.text
                    && fields.iter().any(|f| f == "item text")
                {
                    sent.insert("item text".into(), json!(t));
                }
                p.effects.push(format!("Would call {url}"));
                p.calls.push((url.clone(), sent));
            }
        }
    }
    Ok(p)
}

fn sub_map<T: ReadTxn>(txn: &T, m: &MapRef, k: &str) -> Option<MapRef> {
    match m.get(txn, k) {
        Some(Out::YMap(x)) => Some(x),
        _ => None,
    }
}

fn find_element<T: ReadTxn>(txn: &T, node: XmlOut, id: &str) -> Option<yrs::XmlElementRef> {
    let XmlOut::Element(e) = node else {
        return None;
    };
    if attr(txn, &e, "blockId").as_str() == Some(id) {
        return Some(e);
    }
    e.children(txn).find_map(|c| find_element(txn, c, id))
}

/// The update that does `plan`'s writes: one update, applied by the room as one transaction.
pub fn apply(
    doc: &Doc,
    plan: &Plan,
    by: &crate::ai::tools::write::Writer,
) -> Result<Option<Vec<u8>>, String> {
    if plan.writes.is_empty() {
        return Ok(None);
    }
    let s = oc_model::new_doc();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    oc_model::ocanvas::apply_update_bytes(&s, &state).map_err(|e| e.to_string())?;
    let before = s.transact().state_vector();
    for w in &plan.writes {
        match w {
            Write::SetField {
                db,
                row,
                field,
                value,
            } => {
                let root = s.get_or_insert_map(oc_model::roots::DATABASES);
                let mut txn = s.transact_mut();
                let d = sub_map(&txn, &root, db).ok_or("the database is gone")?;
                let rows = sub_map(&txn, &d, "rows").ok_or("the database has no rows")?;
                let r = sub_map(&txn, &rows, row).ok_or("the row is gone")?;
                if value.is_null() {
                    r.remove(&mut txn, field);
                } else {
                    r.insert(
                        &mut txn,
                        field.as_str(),
                        oc_model::import::json_to_any(value),
                    );
                }
            }
            Write::MoveRow { from, row, to } => {
                let src = Db::read(&s, from).ok_or("the database is gone")?;
                let dst = Db::read(&s, to).ok_or("the target database is gone")?;
                let values = src.rows.get(row).cloned().ok_or("the row is gone")?;
                let mut mapped = JsonMap::new();
                for (fid, v) in &values {
                    if let Some(sf) = src.fields.iter().find(|f| &f.0 == fid)
                        && let Some(df) = dst.field(&sf.1)
                    {
                        mapped.insert(df.0.clone(), v.clone());
                    }
                }
                let root = s.get_or_insert_map(oc_model::roots::DATABASES);
                let mut txn = s.transact_mut();
                let sd = sub_map(&txn, &root, from).ok_or("the database is gone")?;
                let dd = sub_map(&txn, &root, to).ok_or("the target database is gone")?;
                if let Some(rows) = sub_map(&txn, &sd, "rows") {
                    rows.remove(&mut txn, row);
                }
                if let Some(Out::YArray(order)) = sd.get(&txn, "order") {
                    let pos = order
                        .iter(&txn)
                        .position(|x| out_json(&txn, &x).as_str() == Some(row.as_str()));
                    if let Some(i) = pos {
                        order.remove(&mut txn, i as u32);
                    }
                }
                if let Some(notes) = sub_map(&txn, &sd, "notes") {
                    notes.remove(&mut txn, row);
                }
                let rows = match sub_map(&txn, &dd, "rows") {
                    Some(r) => r,
                    None => dd.insert(&mut txn, "rows", yrs::MapPrelim::default()),
                };
                let prelim: yrs::MapPrelim = mapped
                    .iter()
                    .map(|(k, v)| (k.clone(), yrs::In::Any(oc_model::import::json_to_any(v))))
                    .collect();
                rows.insert(&mut txn, row.as_str(), prelim);
                if let Some(Out::YArray(order)) = dd.get(&txn, "order") {
                    order.insert(&mut txn, 0, row.as_str());
                }
            }
            Write::SetTodo { block, checked } => {
                let content = s.get_or_insert_xml_fragment(oc_model::roots::CONTENT);
                let mut txn = s.transact_mut();
                let el = content
                    .children(&txn)
                    .find_map(|c| find_element(&txn, c, block))
                    .ok_or("the checklist item is gone")?;
                el.insert_attribute(&mut txn, "checked", yrs::Any::Bool(*checked));
            }
            Write::AddTodos {
                after,
                heading,
                items,
            } => {
                let mut md = String::new();
                if let Some(h) = heading {
                    md.push_str(&format!("### {}\n\n", h.replace('\n', " ")));
                }
                for i in items {
                    md.push_str(&format!("- [ ] {}\n", i.replace('\n', " ")));
                }
                let op = match after {
                    Some(b) => oc_model::patch::PatchOp::InsertAfter {
                        block_id: b.clone(),
                        markdown: Some(md),
                        blocks: None,
                    },
                    None => oc_model::patch::PatchOp::Append {
                        markdown: Some(md),
                        blocks: None,
                    },
                };
                let mut n = 0u32;
                let out = oc_model::patch::apply_patch(&s, &[op], &mut || {
                    n += 1;
                    format!("b_{}", ulid::Ulid::new().to_string().to_lowercase())
                })
                .map_err(|e| e.to_string())?;
                oc_model::ocanvas::apply_update_bytes(&s, &out.update)
                    .map_err(|e| e.to_string())?;
            }
            Write::AddComment { block, text } => {
                let input = match block {
                    Some(b) => json!({"blockId": b, "text": text}),
                    None => json!({"quote": "", "text": text}),
                };
                let (u, _) = crate::ai::tools::write::comment_add(&s, &input, by)
                    .map_err(|e| e.message())?;
                if let Some(u) = u {
                    oc_model::ocanvas::apply_update_bytes(&s, &u).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    let update = s.transact().encode_state_as_update_v1(&before);
    Ok(Some(update))
}

/// For `date.reached`: the rows of `db` whose `field` is `date` (a `YYYY-MM-DD` prefix).
pub fn rows_dated(doc: &Doc, db: &str, field: &str, date: &str) -> Vec<String> {
    let Some(d) = Db::read(doc, db) else {
        return vec![];
    };
    let Some(f) = d.field(field).map(|f| f.0.clone()) else {
        return vec![];
    };
    d.rows
        .iter()
        .filter(|(_, r)| {
            r.get(&f)
                .map(cell_text)
                .is_some_and(|v| v.starts_with(date))
        })
        .map(|(id, _)| id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use oc_model::automation::parse_rule;

    pub(crate) fn doc() -> Doc {
        let j = json!({"type": "doc", "content": [
            {"type": "taskList", "attrs": {"blockId": "b_list"}, "content": [
                {"type": "taskItem", "attrs": {"blockId": "b_t1", "checked": false}, "content": [
                    {"type": "paragraph", "content": [{"type": "text", "text": "Changelog reviewed"}]}]}]}],
            "meta": {"title": "Sprint 42"},
            "databases": {
                "db_1": {"name": "Backlog", "fields": [
                    {"id": "t", "name": "Task", "type": "title"}, {"id": "s", "name": "Status", "type": "status"},
                    {"id": "o", "name": "Owner", "type": "person"}, {"id": "due", "name": "Due", "type": "date"}],
                    "order": ["r1", "r2"], "rows": {"r1": {"t": "Rate limit", "s": "In review", "o": "u_noor", "due": "2026-11-27"},
                                                   "r2": {"t": "Docs", "s": "Done"}}},
                "db_a": {"name": "Archive", "fields": [{"id": "x", "name": "Task", "type": "title"}, {"id": "y", "name": "Status", "type": "status"}],
                    "order": [], "rows": {}}},
            "boards": {}, "comments": {}});
        let d = oc_model::new_doc();
        oc_model::import::apply_document_json(&d, &j);
        d
    }

    fn rule(trigger: Value, actions: Value) -> Rule {
        parse_rule("au_1", &json!({"v": 1, "name": "Move done items", "enabled": true, "ownerId": "u_lea",
            "trigger": trigger, "conditions": [{"field": "Owner", "op": "isNotEmpty"}], "actions": actions})).unwrap()
    }

    fn set_status(d: &Doc, row: &str, v: &str) {
        let root = d.get_or_insert_map(oc_model::roots::DATABASES);
        let mut txn = d.transact_mut();
        let db = sub_map(&txn, &root, "db_1").unwrap();
        let rows = sub_map(&txn, &db, "rows").unwrap();
        let r = sub_map(&txn, &rows, row).unwrap();
        r.insert(&mut txn, "s", v);
    }

    fn writer() -> crate::ai::tools::write::Writer {
        crate::ai::tools::write::Writer {
            user_id: "automation:au_1".into(),
            name: "Automation".into(),
            color: "#6b7280".into(),
            origin: "automation:au_1".into(),
            mode_default: crate::ai::tools::WriteMode::Direct,
        }
    }

    #[test]
    fn a_status_change_moves_the_row_and_plans_the_notification() {
        let d = doc();
        let r = rule(
            json!({"kind": "field.changed", "database": "db_1", "field": "s", "to": "Done"}),
            json!([{"kind": "row.move", "to": {"database": "db_a"}},
                   {"kind": "notify", "people": ["field:Owner"], "text": "{row.title} is done and archived"}]),
        );
        let before = Snapshot::take(&d, std::slice::from_ref(&r));
        set_status(&d, "r1", "Done");
        let evs = diff(&before, &Snapshot::take(&d, std::slice::from_ref(&r)), &d);
        assert_eq!(evs.len(), 1);
        assert!(triggered(&r, &evs[0]));
        let s = Subject::of(&evs[0]);
        let db = Db::read(&d, "db_1");
        assert_eq!(
            conditions_hold(&r, db.as_ref(), s.row.as_deref(), "2026-11-26"),
            Ok(())
        );
        let cx = Cx {
            canvas_title: "Sprint 42",
            rule_name: "Move done items",
            today: "2026-11-26",
        };
        let p = plan(&d, &r, &s, &cx).unwrap();
        assert_eq!(
            p.notify,
            vec![(
                vec!["u_noor".to_string()],
                "Rate limit is done and archived".to_string()
            )]
        );
        assert_eq!(
            p.effects[0],
            "Would move the row to Archive (2 fields match)"
        );
        let u = apply(&d, &p, &writer()).unwrap().unwrap();
        oc_model::ocanvas::apply_update_bytes(&d, &u).unwrap();
        let after = Db::read(&d, "db_a").unwrap();
        assert_eq!(after.rows["r1"]["x"], "Rate limit");
        assert_eq!(after.rows["r1"]["y"], "Done");
        assert!(!Db::read(&d, "db_1").unwrap().rows.contains_key("r1"));
        // The other value of Status does not trigger it; a failing condition names itself.
        let other = Subject {
            db: Some("db_1".into()),
            row: Some("r2".into()),
            ..Default::default()
        };
        assert_eq!(
            conditions_hold(&r, Db::read(&d, "db_1").as_ref(), other.row.as_deref(), "x"),
            Err(0)
        );
    }

    #[test]
    fn checklist_rows_and_comments_are_events() {
        let d = doc();
        let r = rule(
            json!({"kind": "checklist.checked", "block": "b_list"}),
            json!([{"kind": "comment.add", "text": "{item.text} done"}]),
        );
        let before = Snapshot::take(&d, std::slice::from_ref(&r));
        let p = plan(
            &d,
            &r,
            &Subject::default(),
            &Cx {
                canvas_title: "",
                rule_name: "",
                today: "",
            },
        );
        assert!(p.is_ok());
        // Check the item through the engine's own write.
        let set = Plan {
            writes: vec![Write::SetTodo {
                block: "b_t1".into(),
                checked: true,
            }],
            ..Default::default()
        };
        let u = apply(&d, &set, &writer()).unwrap().unwrap();
        oc_model::ocanvas::apply_update_bytes(&d, &u).unwrap();
        let evs = diff(&before, &Snapshot::take(&d, std::slice::from_ref(&r)), &d);
        assert_eq!(
            evs,
            vec![Event::Checked {
                block: "b_t1".into(),
                list: Some("b_list".into()),
                text: "Changelog reviewed".into()
            }]
        );
        assert!(triggered(&r, &evs[0]));
        let added = rule(
            json!({"kind": "row.added", "database": "db_1"}),
            json!([{"kind": "todo.add", "items": ["Due dates checked"], "heading": "Week of {canvas.title}"}]),
        );
        let p = plan(
            &d,
            &added,
            &Subject::default(),
            &Cx {
                canvas_title: "Dec 1",
                rule_name: "",
                today: "",
            },
        )
        .unwrap();
        assert_eq!(p.changes(), 2);
        let u = apply(&d, &p, &writer()).unwrap().unwrap();
        oc_model::ocanvas::apply_update_bytes(&d, &u).unwrap();
        let md = oc_model::export::to_markdown(&oc_model::doc_to_json(&d));
        assert!(
            md.contains("Week of Dec 1") && md.contains("Due dates checked"),
            "{md}"
        );
    }

    #[test]
    fn broken_references_are_named_and_templates_are_plain() {
        let d = doc();
        let r = rule(
            json!({"kind": "row.added", "database": "db_1"}),
            json!([{"kind": "row.move", "to": {"database": "db_gone"}}]),
        );
        let s = Subject {
            db: Some("db_1".into()),
            row: Some("r1".into()),
            ..Default::default()
        };
        let cx = Cx {
            canvas_title: "C",
            rule_name: "R",
            today: "2026-11-26",
        };
        assert!(plan(&d, &r, &s, &cx).unwrap_err().contains("deleted"));
        let db = Db::read(&d, "db_1");
        assert_eq!(
            render(
                "{row.title} · {field.Status} · {nope} · {canvas.title}",
                db.as_ref(),
                &s,
                &cx
            ),
            "Rate limit · In review · {nope} · C"
        );
        assert_eq!(
            rows_dated(&d, "db_1", "Due", "2026-11-27"),
            vec!["r1".to_string()]
        );
    }
}
