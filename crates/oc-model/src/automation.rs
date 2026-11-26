// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Automation rules (AUTO-01, ADR-067, docs/34 §5.3): the `automations` document root,
//! `Y.Map<ruleId, Y.Map>` with one key per rule field (plain JSON values), so the host stores
//! rules with the file and they travel with copies (switched off and ownerless there).
//!
//! ```json
//! { "v": 1, "name": "Move done items", "enabled": true, "ownerId": "u_lea", "ownerName": "Lea",
//!   "updatedAt": "2026-11-26T09:12:00Z", "timeZone": "Europe/Berlin",
//!   "trigger": { "kind": "field.changed", "database": "db_1", "field": "status", "to": "Done" },
//!   "match": "all",
//!   "conditions": [ { "field": "owner", "op": "isNotEmpty" } ],
//!   "actions": [ { "kind": "row.move", "to": { "database": "db_archive" } },
//!                { "kind": "notify", "people": ["field:owner"], "text": "{row.title} moved" } ],
//!   "paused": { "code": "OWNER_NO_EDIT", "at": "…" } }
//! ```
//!
//! Unknown trigger and action kinds are kept (rule 7) and make the rule not runnable; they are
//! warnings, never errors, so a file with a rule from a newer version still opens.

use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value, json};
use yrs::{Any, Doc, Map, MapRef, Out, ReadTxn, Transact, TransactionMut};

use crate::doc::out_to_json;

/// The root name.
pub const ROOT: &str = "automations";
/// Most rules a canvas may hold (the operator's `max_rules` is at most this).
pub const MAX_RULES: usize = 100;
/// Most actions in one rule.
pub const MAX_ACTIONS: usize = 5;
/// Most conditions in one rule.
pub const MAX_CONDITIONS: usize = 10;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Trigger {
    /// A checklist item is checked; `block`: one item or one checklist (its `blockId`), any
    /// when absent.
    #[serde(rename = "checklist.checked")]
    ChecklistChecked {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block: Option<String>,
    },
    #[serde(rename = "row.added")]
    RowAdded { database: String },
    /// A field changes, to `to` when given (an option label, a person id, `true`).
    #[serde(rename = "field.changed")]
    FieldChanged {
        database: String,
        field: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<Value>,
    },
    /// A date field reaches `offsetDays` from today (−1 = the day before) at `time` (HH:MM) in
    /// the canvas time zone.
    #[serde(rename = "date.reached")]
    DateReached {
        database: String,
        field: String,
        #[serde(default, rename = "offsetDays")]
        offset_days: i64,
        #[serde(default = "nine")]
        time: String,
    },
    /// `every`: `day`, `week` (with `weekday` 0 = Sunday), `month` (with `monthday`), or
    /// `minutes` (with `minutes` ≥ the operator's minimum, 15).
    #[serde(rename = "schedule")]
    Schedule {
        every: String,
        #[serde(default = "nine")]
        time: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        weekday: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        monthday: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        minutes: Option<u32>,
    },
    #[serde(rename = "comment.added")]
    CommentAdded {},
    #[serde(rename = "mention.added")]
    MentionAdded {},
}

fn nine() -> String {
    "09:00".into()
}

impl Trigger {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ChecklistChecked { .. } => "checklist.checked",
            Self::RowAdded { .. } => "row.added",
            Self::FieldChanged { .. } => "field.changed",
            Self::DateReached { .. } => "date.reached",
            Self::Schedule { .. } => "schedule",
            Self::CommentAdded {} => "comment.added",
            Self::MentionAdded {} => "mention.added",
        }
    }
    /// Date and schedule triggers run from the schedule table, even with the room closed.
    pub fn is_timed(&self) -> bool {
        matches!(self, Self::DateReached { .. } | Self::Schedule { .. })
    }
    /// The database the trigger watches, if any.
    pub fn database(&self) -> Option<&str> {
        match self {
            Self::RowAdded { database }
            | Self::FieldChanged { database, .. }
            | Self::DateReached { database, .. } => Some(database),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Condition {
    pub field: String,
    /// `is`, `isNot`, `contains`, `notContains`, `isEmpty`, `isNotEmpty`, `before`, `after`.
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

pub const CONDITION_OPS: [&str; 8] = [
    "is",
    "isNot",
    "contains",
    "notContains",
    "isEmpty",
    "isNotEmpty",
    "before",
    "after",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Action {
    /// Sets a field of the triggering row: `value` as stored, or `"today"`, `"actor"`.
    #[serde(rename = "field.set")]
    FieldSet { field: String, value: Value },
    /// Moves the triggering row to another database of this canvas (fields matched by name).
    #[serde(rename = "row.move")]
    RowMove { to: MoveTarget },
    #[serde(rename = "todo.set")]
    TodoSet {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block: Option<String>,
        checked: bool,
    },
    /// Adds a checklist (with an optional heading) after the block `after`, else at the end.
    #[serde(rename = "todo.add")]
    TodoAdd {
        items: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        heading: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after: Option<String>,
    },
    /// A comment on the triggering block (or the row's database block).
    #[serde(rename = "comment.add")]
    CommentAdd { text: String },
    /// Notifies people through the host's `POST /mentions`: user ids or `field:<fieldId>`.
    #[serde(rename = "notify")]
    Notify { people: Vec<String>, text: String },
    /// Calls a URL (ADR-068) with the named fields of the triggering row.
    #[serde(rename = "http.post")]
    HttpPost {
        url: String,
        #[serde(default)]
        fields: Vec<String>,
    },
}

impl Action {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::FieldSet { .. } => "field.set",
            Self::RowMove { .. } => "row.move",
            Self::TodoSet { .. } => "todo.set",
            Self::TodoAdd { .. } => "todo.add",
            Self::CommentAdd { .. } => "comment.add",
            Self::Notify { .. } => "notify",
            Self::HttpPost { .. } => "http.post",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MoveTarget {
    pub database: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Paused {
    /// `OWNER_NO_EDIT`, `FAILURES`, `BROKEN`, `NO_OWNER`, `STALE_OWNER`.
    pub code: String,
    #[serde(default)]
    pub at: String,
}

/// One rule as read from the document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    #[serde(skip)]
    pub id: String,
    #[serde(default = "one")]
    pub v: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    pub trigger: Trigger,
    /// `all` (default) or `any`.
    #[serde(default = "all", rename = "match")]
    pub match_mode: String,
    #[serde(default)]
    pub conditions: Vec<Condition>,
    pub actions: Vec<Action>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<Paused>,
}

fn one() -> u32 {
    1
}
fn all() -> String {
    "all".into()
}

impl Rule {
    /// Enabled, owned and not paused.
    pub fn runnable(&self) -> bool {
        self.enabled && self.owner_id.is_some() && self.paused.is_none()
    }
}

/// A rule id: 1-64 of `[A-Za-z0-9_-]`.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Parses and checks one rule's JSON. `Err` says what is wrong, in words.
pub fn parse_rule(id: &str, v: &Value) -> Result<Rule, String> {
    if !valid_id(id) {
        return Err("a rule id is 1-64 letters, digits, - or _".into());
    }
    let mut r: Rule = serde_json::from_value(v.clone()).map_err(|e| {
        let m = e.to_string();
        if m.contains("unknown variant") {
            format!("unknown kind ({m})")
        } else {
            m
        }
    })?;
    r.id = id.to_string();
    if r.v != 1 {
        return Err(format!("rule version {} is newer than this server", r.v));
    }
    if r.name.chars().count() > 120 {
        return Err("a rule name is at most 120 characters".into());
    }
    if r.actions.is_empty() || r.actions.len() > MAX_ACTIONS {
        return Err(format!("a rule has 1-{MAX_ACTIONS} actions"));
    }
    if r.conditions.len() > MAX_CONDITIONS {
        return Err(format!("a rule has at most {MAX_CONDITIONS} conditions"));
    }
    if !matches!(r.match_mode.as_str(), "all" | "any") {
        return Err("match is \"all\" or \"any\"".into());
    }
    for c in &r.conditions {
        if !CONDITION_OPS.contains(&c.op.as_str()) {
            return Err(format!("unknown condition {:?}", c.op));
        }
    }
    if let Trigger::Schedule {
        every,
        time,
        weekday,
        monthday,
        minutes,
    } = &r.trigger
    {
        match every.as_str() {
            "day" => {}
            "week" if weekday.is_some_and(|d| d <= 6) => {}
            "month" if monthday.is_some_and(|d| (1..=28).contains(&d)) => {}
            "minutes" if minutes.is_some_and(|m| (1..=1440).contains(&m)) => {}
            _ => {
                return Err(
                    "a schedule is every day, week (weekday 0-6), month (day 1-28) or N minutes"
                        .into(),
                );
            }
        }
        parse_hhmm(time).ok_or("a time is HH:MM")?;
    }
    if let Trigger::DateReached {
        time, offset_days, ..
    } = &r.trigger
    {
        parse_hhmm(time).ok_or("a time is HH:MM")?;
        if offset_days.abs() > 365 {
            return Err("a date offset is at most 365 days".into());
        }
    }
    for a in &r.actions {
        match a {
            Action::Notify { text, .. } | Action::CommentAdd { text }
                if text.chars().count() > 1000 =>
            {
                return Err("a message is at most 1,000 characters".into());
            }
            Action::Notify { people, .. } if people.is_empty() || people.len() > 20 => {
                return Err("notify names 1-20 people or person fields".into());
            }
            Action::TodoAdd { items, .. } if items.is_empty() || items.len() > 50 => {
                return Err("a checklist has 1-50 items".into());
            }
            Action::HttpPost { url, fields } => {
                if !(url.starts_with("https://") || url.starts_with("http://")) || url.len() > 2048
                {
                    return Err("a URL is http(s):// and at most 2,048 characters".into());
                }
                if fields.len() > 20 {
                    return Err("a URL call sends at most 20 fields".into());
                }
            }
            _ => {}
        }
    }
    Ok(r)
}

/// `"09:30"` → minutes after midnight.
pub fn parse_hhmm(s: &str) -> Option<u32> {
    let (h, m) = s.split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60 && s.len() == 5).then_some(h * 60 + m)
}

fn map_json<T: ReadTxn>(txn: &T, m: &MapRef) -> JsonMap<String, Value> {
    m.iter(txn)
        .map(|(k, v)| (k.to_string(), out_to_json(txn, &v)))
        .collect()
}

/// Every rule in the document: `(id, its JSON, parsed or why not)`, sorted by id.
pub fn read_rules(doc: &Doc) -> Vec<(String, Value, Result<Rule, String>)> {
    let txn = doc.transact();
    let Some(root) = txn.get_map(ROOT) else {
        return vec![];
    };
    let mut out: Vec<_> = root
        .iter(&txn)
        .map(|(id, v)| {
            let json = match &v {
                Out::YMap(m) => Value::Object(map_json(&txn, m)),
                other => out_to_json(&txn, other),
            };
            let parsed = if json.is_object() {
                parse_rule(id, &json)
            } else {
                Err("a rule must be an object".into())
            };
            (id.to_string(), json, parsed)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn to_any(v: &Value) -> Any {
    crate::import::json_to_any(v)
}

/// Writes rule fields (one key each), keeping the rule's other keys (rule 7).
pub fn write_fields(
    txn: &mut TransactionMut,
    root: &MapRef,
    id: &str,
    fields: &JsonMap<String, Value>,
) {
    let rule = match root.get(txn, id) {
        Some(Out::YMap(m)) => m,
        _ => root.insert(txn, id, yrs::MapPrelim::default()),
    };
    for (k, v) in fields {
        if v.is_null() {
            rule.remove(txn, k);
        } else {
            rule.insert(txn, k.as_str(), to_any(v));
        }
    }
}

/// A copied canvas keeps its rules switched off and with no owner until an editor turns them
/// on (ADR-067). Applied to the copy only.
pub fn disable_all(doc: &Doc) {
    let ids: Vec<String> = read_rules(doc).into_iter().map(|(id, ..)| id).collect();
    if ids.is_empty() {
        return;
    }
    let root = doc.get_or_insert_map(ROOT);
    let mut txn = doc.transact_mut();
    for id in ids {
        let mut f = JsonMap::new();
        f.insert("enabled".into(), json!(false));
        f.insert("ownerId".into(), Value::Null);
        f.insert("ownerName".into(), Value::Null);
        f.insert("paused".into(), Value::Null);
        write_fields(&mut txn, &root, &id, &f);
    }
}

/// MOD-01 for the root: the shape is an error (the file is refused), a rule that does not parse
/// is a warning (kept as is, not run).
pub fn check_root(
    v: &Value,
    err: &mut dyn FnMut(String, String),
    warn: &mut dyn FnMut(String, String),
) {
    let Some(rules) = v.as_object() else {
        return err(format!("/{ROOT}"), format!("{ROOT} must be an object"));
    };
    if rules.len() > MAX_RULES {
        warn(
            format!("/{ROOT}"),
            format!("more than {MAX_RULES} rules (kept, none beyond the limit run)"),
        );
    }
    for (id, r) in rules {
        let p = format!("/{ROOT}/{}", id.replace('~', "~0").replace('/', "~1"));
        if !r.is_object() {
            err(p, "a rule must be an object".into());
            continue;
        }
        if let Err(e) = parse_rule(id, r) {
            warn(p, format!("rule not runnable: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule() -> Value {
        json!({"v": 1, "name": "Move done items", "enabled": true, "ownerId": "u_lea",
            "trigger": {"kind": "field.changed", "database": "db_1", "field": "status", "to": "Done"},
            "conditions": [{"field": "owner", "op": "isNotEmpty"}],
            "actions": [{"kind": "row.move", "to": {"database": "db_archive"}},
                        {"kind": "notify", "people": ["field:owner"], "text": "{row.title} moved"}]})
    }

    #[test]
    fn parses_the_documented_rule() {
        let r = parse_rule("au_1", &rule()).unwrap();
        assert!(r.runnable());
        assert_eq!(r.trigger.kind(), "field.changed");
        assert_eq!(r.actions[0].kind(), "row.move");
        assert_eq!(r.match_mode, "all");
    }

    #[test]
    fn refuses_what_cannot_run_in_words() {
        let mut bad = rule();
        bad["trigger"]["kind"] = json!("planet.aligned");
        assert!(parse_rule("au_1", &bad).unwrap_err().contains("unknown"));
        let mut bad = rule();
        bad["actions"] = json!([]);
        assert!(parse_rule("au_1", &bad).is_err());
        let mut bad = rule();
        bad["trigger"] = json!({"kind": "schedule", "every": "minutes", "minutes": 0});
        assert!(parse_rule("au_1", &bad).is_err());
        let mut bad = rule();
        bad["actions"] = json!([{"kind": "http.post", "url": "ftp://x"}]);
        assert!(parse_rule("au_1", &bad).is_err());
        assert!(parse_rule("a/b", &rule()).is_err());
        assert_eq!(parse_hhmm("09:30"), Some(570));
        assert_eq!(parse_hhmm("9:30"), None);
    }

    #[test]
    fn rules_round_trip_and_copies_switch_them_off() {
        let doc = crate::new_doc();
        {
            let root = doc.get_or_insert_map(ROOT);
            let mut txn = doc.transact_mut();
            let f = rule().as_object().unwrap().clone();
            write_fields(&mut txn, &root, "au_1", &f);
        }
        let rules = read_rules(&doc);
        assert_eq!(rules.len(), 1);
        assert!(rules[0].2.as_ref().unwrap().runnable());
        // In document.json too, and validated (warnings only for an unknown kind).
        let j = crate::doc_to_json(&doc);
        assert_eq!(j[ROOT]["au_1"]["name"], "Move done items");
        assert!(crate::validate_json(&j).is_ok());
        // A 0.2 reader defines no `automations` root: the rules ride along in ydoc.bin
        // unchanged and come back when a 0.3 reader opens the file it saved (AUTO-A8).
        let bytes = crate::ocanvas::write_ocanvas(&doc, &Default::default()).unwrap();
        let state = crate::ocanvas::read_ocanvas(&bytes).unwrap();
        let old = yrs::Doc::new();
        old.get_or_insert_xml_fragment(crate::roots::CONTENT);
        crate::ocanvas::apply_update_bytes(&old, &crate::ocanvas::encode_state(&state.doc))
            .unwrap();
        let back = crate::new_doc();
        crate::ocanvas::apply_update_bytes(&back, &crate::ocanvas::encode_state(&old)).unwrap();
        assert_eq!(read_rules(&back)[0].1, read_rules(&doc)[0].1);
        disable_all(&doc);
        let r = read_rules(&doc).remove(0).2.unwrap();
        assert!(!r.enabled && r.owner_id.is_none());
    }
}
