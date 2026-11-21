//! People (docs/21, ADR-026): the user object as hosts send it, and the per-viewer directory.
//!
//! The host owns its users. OpenCanvas learns about them in four tiers: launch tokens (tier 0),
//! `participants` in a token (tier 1), `GET /users` search (tier 2) and `POST /users/resolve`
//! (tier 3). Everything about *other* people is answered per viewer, with that viewer's
//! callback token, and cached per (room, viewer), never per room.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::StatusCode;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::grant::{Grant, User, derive_color, is_hex_color};
use crate::host_client::{HostClient, HostError, SaveTarget};
use crate::hosts::HostConfig;

/// Tier 1: at most this many `participants` are read from a launch token.
pub const MAX_PARTICIPANTS: usize = 200;
/// Ids per `POST /v1/users/resolve` and per call to the host.
pub const MAX_RESOLVE_IDS: usize = 500;
const HOST_BATCH: usize = 200;
const MAX_ID: usize = 256;
const MAX_NAME: usize = 200;
const MAX_DETAIL: usize = 200;
const MAX_EMAIL: usize = 254;
const MAX_URL: usize = 2048;
/// Resolve answers are kept this long per (room, viewer) (docs/21 tier 3).
pub const RESOLVE_TTL: Duration = Duration::from_secs(600);
/// A failed resolve call is retried after this long; meanwhile the fallback rules apply.
const FAILED_TTL: Duration = Duration::from_secs(30);
/// Search answers per (room, viewer, query).
const SEARCH_TTL: Duration = Duration::from_secs(30);
const MAX_CACHE_ENTRIES: usize = 10_000;

/// What a `hidden` person is called, everywhere.
pub const HIDDEN_NAME: &str = "Someone";
/// The neutral colour of a `hidden` person (WCAG AA with white initials).
pub const HIDDEN_COLOR: &str = "#6b7280";

/// Trimmed, control characters removed, at most `max` bytes (on a char boundary).
pub fn clip(s: &str, max: usize) -> String {
    let s: String = s.chars().filter(|c| !c.is_control()).collect();
    let s = s.trim();
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].trim_end().to_string()
}

fn opt_text(v: &Value, k: &str, max: usize) -> Option<String> {
    v.get(k)
        .and_then(Value::as_str)
        .map(|s| clip(s, max))
        .filter(|s| !s.is_empty())
}

/// http(s) URLs only: an avatar ends up in an `<img src>` of other people's pages.
pub fn safe_url(s: Option<&str>) -> Option<String> {
    let s = s?.trim();
    (s.len() <= MAX_URL
        && (s.starts_with("https://") || s.starts_with("http://"))
        && !s
            .chars()
            .any(|c| c.is_control() || c == '"' || c == '\'' || c == ' '))
    .then(|| s.to_string())
}

/// A user object from a host (token `user`, `participants`, search and resolve answers).
/// `None` without a usable `id`.
pub fn user_from_json(v: &Value) -> Option<User> {
    let id = v.get("id").and_then(|i| match i {
        Value::String(s) => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })?;
    if id.is_empty() || id.len() > MAX_ID || id.chars().any(char::is_control) {
        return None;
    }
    let color = v
        .get("color")
        .and_then(Value::as_str)
        .filter(|c| is_hex_color(c))
        .map(String::from)
        .unwrap_or_else(|| derive_color(&id));
    Some(User {
        name: opt_text(v, "name", MAX_NAME).unwrap_or_else(|| id.clone()),
        detail: opt_text(v, "detail", MAX_DETAIL),
        email: opt_text(v, "email", MAX_EMAIL).filter(|e| e.contains('@')),
        avatar: safe_url(v.get("avatar").and_then(Value::as_str)),
        color,
        id,
    })
}

/// Tier 1: the token's `participants` (≤ 200 usable entries, duplicates dropped).
pub fn participants_from_json(v: Option<&Value>) -> Vec<User> {
    let mut seen = std::collections::HashSet::new();
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(user_from_json)
                .filter(|u| seen.insert(u.id.clone()))
                .take(MAX_PARTICIPANTS)
                .collect()
        })
        .unwrap_or_default()
}

/// How the host says a person relates to the viewer (docs/21 "Every viewer has their own
/// network").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Relation {
    Contact,
    Member,
    External,
    Hidden,
}

impl Relation {
    fn parse(v: &Value) -> Self {
        match v.get("relation").and_then(Value::as_str) {
            Some("contact") => Relation::Contact,
            Some("external") => Relation::External,
            Some("hidden") => Relation::Hidden,
            // Absent or unknown: a member of the same org (the host listed them).
            _ => Relation::Member,
        }
    }
}

/// A person as one viewer sees them, from the host's `resolve` answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Resolved {
    #[serde(flatten)]
    pub user: User,
    pub relation: Relation,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub deactivated: bool,
}

impl Resolved {
    /// Parses one entry of a resolve answer for `viewer`: the e-mail only with
    /// `perms.showEmail`; a `hidden` person keeps nothing but the id.
    pub fn from_json(v: &Value, viewer: &Grant) -> Option<Self> {
        let mut user = user_from_json(v)?;
        let relation = Relation::parse(v);
        if !viewer.perms.show_email {
            user.email = None;
        }
        if relation == Relation::Hidden {
            user = User {
                name: HIDDEN_NAME.into(),
                color: HIDDEN_COLOR.into(),
                id: user.id,
                ..Default::default()
            };
        }
        Some(Self {
            user,
            relation,
            deactivated: v.get("deactivated").and_then(Value::as_bool) == Some(true),
        })
    }

    /// The awareness `user` a viewer receives for this person: `seen` is what the server
    /// stamped from the person's own grant. Contacts and members get the viewer-specific name
    /// and the freshest detail/avatar; `external` people only what the host chose to show;
    /// `hidden` people nothing ([`anonymous`]).
    pub fn awareness(&self, seen: &Value, anon_id: &str) -> Value {
        let mut v = json!({"id": self.user.id, "name": self.user.name, "color": seen["color"]});
        match self.relation {
            Relation::Hidden => return anonymous(anon_id),
            Relation::Contact | Relation::Member => {
                v["avatar"] = self
                    .user
                    .avatar
                    .as_ref()
                    .map_or(seen["avatar"].clone(), |a| json!(a));
                let detail = self
                    .user
                    .detail
                    .clone()
                    .or_else(|| seen["detail"].as_str().map(String::from));
                if let Some(d) = detail {
                    v["detail"] = json!(d);
                }
            }
            Relation::External => {
                v["avatar"] = json!(self.user.avatar);
                if let Some(d) = &self.user.detail {
                    v["detail"] = json!(d);
                }
            }
        }
        v["relation"] = json!(self.relation);
        if self.deactivated {
            v["deactivated"] = json!(true);
        }
        v
    }
}

/// The awareness `user` of someone a viewer must not identify: a per-viewer pseudonymous id
/// (stable for that viewer, unlinkable across viewers), "Someone" and a neutral colour.
pub fn anonymous(anon_id: &str) -> Value {
    json!({"id": anon_id, "name": HIDDEN_NAME, "color": HIDDEN_COLOR, "avatar": null, "relation": "hidden"})
}

/// `anon_` + 12 hex chars of sha256(room, viewer, subject).
pub fn anon_id(room: &str, viewer: &str, subject: &str) -> String {
    let h = Sha256::digest(format!("{room}\u{1f}{viewer}\u{1f}{subject}").as_bytes());
    let hex: String = h.iter().take(6).map(|b| format!("{b:02x}")).collect();
    format!("anon_{hex}")
}

/// Whether OpenCanvas can ask this host about people at all (JWT callbacks; WOPI has no user API).
pub fn has_callbacks(host: &HostConfig, file_id: &str) -> bool {
    !host.callback_base.is_empty()
        && matches!(SaveTarget::of(host, file_id), Ok(SaveTarget::Callbacks))
}

// ---------------------------------------------------------------- per-viewer cache

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Available,
    NotImplemented,
    Failed,
}

struct ViewerDir {
    status: Status,
    checked: Instant,
    /// id → (fetched at, answer; `None` = the host didn't list them, shown as hidden).
    people: HashMap<String, (Instant, Option<Resolved>)>,
    refreshing: bool,
}

/// What the cache knows about one person for one viewer, without calling anyone.
#[derive(Debug, Clone, PartialEq)]
pub enum Peek {
    /// The host answered (stale entries too; `refresh` says a new call is due). `None`: the
    /// host was asked and didn't list them (tokens and the snapshot apply; presence follows
    /// `directory.coviewers`).
    Known {
        person: Option<Resolved>,
        refresh: bool,
    },
    /// The host has no resolve callback (404/405/501) or this is a WOPI host.
    NoResolve,
    /// The last call failed; fall back until it is retried.
    Failed,
    /// Nobody asked yet.
    Pending,
}

/// The outcome of a resolve request.
#[derive(Debug, Clone)]
pub struct Resolution {
    /// The host implements `POST /users/resolve` and answered.
    pub available: bool,
    pub people: Vec<Resolved>,
}

type Key = (String, String);
/// (room, viewer, query).
type SearchKey = (String, String, String);

/// Per (room, viewer) resolve answers and per (room, viewer, query) search answers.
#[derive(Default)]
pub struct Directory {
    resolved: Mutex<HashMap<Key, ViewerDir>>,
    search: Mutex<HashMap<SearchKey, (Instant, Value)>>,
}

impl Directory {
    /// Drops what a viewer's resolve returned: a fresh launch (reload) asks the host again, so
    /// a rename shows up on the next open.
    pub fn forget_viewer(&self, room: &str, viewer: &str) {
        let key = (room.to_string(), viewer.to_string());
        self.resolved.lock().expect("directory").remove(&key);
        self.search
            .lock()
            .expect("directory")
            .retain(|(r, v, _), _| !(r == room && v == viewer));
    }

    pub fn peek(&self, room: &str, viewer: &str, subject: &str) -> Peek {
        let map = self.resolved.lock().expect("directory");
        let Some(d) = map.get(&(room.to_string(), viewer.to_string())) else {
            return Peek::Pending;
        };
        match d.status {
            Status::NotImplemented if d.checked.elapsed() < RESOLVE_TTL => Peek::NoResolve,
            Status::Failed if d.checked.elapsed() < FAILED_TTL => Peek::Failed,
            Status::NotImplemented | Status::Failed => Peek::Pending,
            Status::Available => match d.people.get(subject) {
                Some((at, p)) => Peek::Known {
                    person: p.clone(),
                    refresh: at.elapsed() >= RESOLVE_TTL && !d.refreshing,
                },
                None => Peek::Pending,
            },
        }
    }

    /// Resolves `ids` for `viewer` (their callback token): cached answers first, one batched
    /// host call for the rest. `available` is false when the host has no resolve callback or
    /// could not be reached (callers then fall back to tokens and the document's snapshot).
    pub async fn resolve(
        &self,
        http: &HostClient,
        host: &HostConfig,
        viewer: &Grant,
        ids: &[String],
    ) -> Resolution {
        let key: Key = (viewer.room.clone(), viewer.user.id.clone());
        let mut ids: Vec<String> = ids
            .iter()
            .filter(|i| !i.is_empty() && i.len() <= MAX_ID)
            .cloned()
            .collect();
        ids.sort();
        ids.dedup();
        ids.truncate(MAX_RESOLVE_IDS);
        if !has_callbacks(host, &viewer.file.id) {
            return Resolution {
                available: false,
                people: vec![],
            };
        }
        let missing: Vec<String> = {
            let mut map = self.resolved.lock().expect("directory");
            match map.get_mut(&key) {
                Some(d)
                    if d.status == Status::NotImplemented && d.checked.elapsed() < RESOLVE_TTL =>
                {
                    return Resolution {
                        available: false,
                        people: vec![],
                    };
                }
                Some(d) if d.status == Status::Available => {
                    let m: Vec<String> = ids
                        .iter()
                        .filter(|i| {
                            d.people
                                .get(*i)
                                .is_none_or(|(at, _)| at.elapsed() >= RESOLVE_TTL)
                        })
                        .cloned()
                        .collect();
                    if !m.is_empty() {
                        d.refreshing = true;
                    }
                    m
                }
                _ => ids.clone(),
            }
        };
        if !missing.is_empty() {
            let mut answers: HashMap<String, Option<Resolved>> = HashMap::new();
            let mut outcome = Status::Available;
            for chunk in missing.chunks(HOST_BATCH) {
                match http
                    .resolve_users(host, &viewer.callback_token, &viewer.file.id, chunk)
                    .await
                {
                    Ok((status, body)) if status.is_success() => {
                        let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                        let list = v
                            .as_array()
                            .or_else(|| v.get("users").and_then(Value::as_array))
                            .cloned()
                            .unwrap_or_default();
                        for id in chunk {
                            answers.insert(id.clone(), None);
                        }
                        for e in &list {
                            if let Some(r) = Resolved::from_json(e, viewer)
                                && answers.contains_key(&r.user.id)
                            {
                                answers.insert(r.user.id.clone(), Some(r));
                            }
                        }
                    }
                    Ok((status, _)) if not_implemented(status) => {
                        outcome = Status::NotImplemented;
                        break;
                    }
                    Ok((status, _)) => {
                        tracing::warn!(host = %host.id, status = status.as_u16(), "users/resolve failed");
                        outcome = Status::Failed;
                        break;
                    }
                    Err(e) => {
                        tracing::warn!(host = %host.id, error = %e, "users/resolve unreachable");
                        outcome = Status::Failed;
                        break;
                    }
                }
            }
            let now = Instant::now();
            let mut map = self.resolved.lock().expect("directory");
            if map.len() > MAX_CACHE_ENTRIES {
                map.retain(|_, d| d.checked.elapsed() < RESOLVE_TTL);
            }
            let d = map.entry(key.clone()).or_insert_with(|| ViewerDir {
                status: outcome,
                checked: now,
                people: HashMap::new(),
                refreshing: false,
            });
            d.refreshing = false;
            d.checked = now;
            if outcome == Status::Available {
                d.status = Status::Available;
                for (id, p) in answers {
                    d.people.insert(id, (now, p));
                }
            } else if d.status != Status::Available || outcome == Status::NotImplemented {
                // A failed refresh keeps the answers we have; a host that turned the callback
                // off (or never had it) falls back for everyone.
                d.status = outcome;
                d.people.clear();
            }
        }
        let map = self.resolved.lock().expect("directory");
        let Some(d) = map.get(&key).filter(|d| d.status == Status::Available) else {
            return Resolution {
                available: false,
                people: vec![],
            };
        };
        Resolution {
            available: true,
            // Ids the host didn't list are left out: the editor falls back to tokens and the
            // snapshot for them (a host hides someone by answering `relation: "hidden"`).
            people: ids
                .iter()
                .filter_map(|id| d.people.get(id).and_then(|(_, p)| p.clone()))
                .collect(),
        }
    }

    /// A cached search answer for this viewer and query (never shared between viewers).
    pub fn search_cached(&self, viewer: &Grant, q: &str) -> Option<Value> {
        let map = self.search.lock().expect("directory");
        map.get(&(viewer.room.clone(), viewer.user.id.clone(), q.to_string()))
            .filter(|(at, _)| at.elapsed() < SEARCH_TTL)
            .map(|(_, v)| v.clone())
    }

    pub fn search_store(&self, viewer: &Grant, q: &str, v: Value) {
        let mut map = self.search.lock().expect("directory");
        if map.len() > MAX_CACHE_ENTRIES {
            map.retain(|_, (at, _)| at.elapsed() < SEARCH_TTL);
        }
        map.insert(
            (viewer.room.clone(), viewer.user.id.clone(), q.to_string()),
            (Instant::now(), v),
        );
    }
}

/// A host answer meaning "this optional callback isn't implemented".
pub fn not_implemented(status: StatusCode) -> bool {
    matches!(status.as_u16(), 404 | 405 | 410 | 501)
}

/// One search result for a viewer: a sanitised user, `access` passed through, the e-mail
/// only with `perms.showEmail`.
pub fn search_entry(v: &Value, viewer: &Grant) -> Option<Value> {
    let u = viewer.for_viewer(&user_from_json(v)?);
    let mut out = serde_json::to_value(&u).ok()?;
    if let Some(a) = v.get("access").and_then(Value::as_bool) {
        out["access"] = json!(a);
    }
    if v.get("deactivated").and_then(Value::as_bool) == Some(true) {
        out["deactivated"] = json!(true);
    }
    Some(out)
}

/// Normalises a host's search answer (`[user…]` or `{"users":[…]}`), at most 50 entries.
pub fn search_answer(body: &[u8], viewer: &Grant) -> Result<Value, HostError> {
    let v: Value =
        serde_json::from_slice(body).map_err(|_| HostError::Body("users: not JSON".into()))?;
    let list = v
        .as_array()
        .or_else(|| v.get("users").and_then(Value::as_array))
        .ok_or_else(|| HostError::Body("users: expected an array".into()))?;
    Ok(Value::Array(
        list.iter()
            .filter_map(|e| search_entry(e, viewer))
            .take(50)
            .collect(),
    ))
}

/// The `people` entry (tier 0) written into the Y.Doc for someone who opened the file: id,
/// name, detail, avatar and last seen; the e-mail only when their token allows it.
pub fn people_entry(g: &Grant, now_ms: i64) -> Value {
    let mut v = json!({"id": g.user.id, "name": g.user.name, "lastSeen": now_ms});
    if let Some(d) = &g.user.detail {
        v["detail"] = json!(d);
    }
    if let Some(a) = &g.user.avatar {
        v["avatar"] = json!(a);
    }
    if g.perms.show_email
        && let Some(e) = &g.user.email
    {
        v["email"] = json!(e);
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grant::{FileRef, Perms, Role};

    fn viewer(show_email: bool) -> Grant {
        Grant {
            host_id: "h".into(),
            room: "r".into(),
            role: Role::Edit,
            user: User {
                id: "u_v".into(),
                name: "V".into(),
                color: "#123456".into(),
                ..Default::default()
            },
            file: FileRef {
                id: "f".into(),
                name: "F".into(),
                version: None,
            },
            perms: Perms {
                show_email,
                ..Perms::default()
            },
            callback_token: "t".into(),
            participants: vec![],
        }
    }

    #[test]
    fn user_objects_are_sanitised() {
        let u = user_from_json(&json!({
            "id": "u_1", "name": "  Asha\u{7} Rao ", "detail": "Design · Bengaluru",
            "email": "asha@acme.example", "avatar": "javascript:alert(1)", "color": "red"
        }))
        .unwrap();
        assert_eq!(u.name, "Asha Rao");
        assert_eq!(u.detail.as_deref(), Some("Design · Bengaluru"));
        assert_eq!(u.avatar, None);
        assert!(u.color.starts_with('#'));
        assert!(user_from_json(&json!({"name": "no id"})).is_none());
        assert_eq!(user_from_json(&json!({"id": 7})).unwrap().name, "7");
        let long = "é".repeat(300);
        assert!(
            user_from_json(&json!({"id": "x", "name": long}))
                .unwrap()
                .name
                .len()
                <= MAX_NAME
        );
    }

    #[test]
    fn participants_are_capped_and_deduplicated() {
        let list: Vec<Value> = (0..300)
            .map(|i| json!({"id": format!("u_{}", i % 250), "name": "P"}))
            .collect();
        let p = participants_from_json(Some(&Value::Array(list)));
        assert_eq!(p.len(), MAX_PARTICIPANTS);
        assert_eq!(p[0].id, "u_0");
        assert!(participants_from_json(None).is_empty());
    }

    /// docs/21: "No email is shown unless perms.showEmail."
    #[test]
    fn email_needs_show_email() {
        let e = json!({"id": "u_1", "name": "A", "email": "a@acme.example", "access": false});
        let hidden = search_entry(&e, &viewer(false)).unwrap();
        assert!(hidden.get("email").is_none(), "{hidden}");
        assert_eq!(hidden["access"], false);
        let shown = search_entry(&e, &viewer(true)).unwrap();
        assert_eq!(shown["email"], "a@acme.example");
        assert!(
            Resolved::from_json(&e, &viewer(false))
                .unwrap()
                .user
                .email
                .is_none()
        );
        assert_eq!(
            Resolved::from_json(&e, &viewer(true))
                .unwrap()
                .user
                .email
                .as_deref(),
            Some("a@acme.example")
        );
        let mut g = viewer(false);
        g.user.email = Some("v@acme.example".into());
        assert!(people_entry(&g, 1).get("email").is_none());
        assert!(g.for_viewer(&g.user).email.is_none());
        g.perms.show_email = true;
        assert_eq!(people_entry(&g, 1)["email"], "v@acme.example");
    }

    #[test]
    fn hidden_people_keep_nothing_but_the_id() {
        let r = Resolved::from_json(
            &json!({"id": "u_1", "name": "Ravi Menon", "detail": "Ops", "avatar": "https://a/b.png", "relation": "hidden"}),
            &viewer(true),
        )
        .unwrap();
        assert_eq!(r.user.name, HIDDEN_NAME);
        assert_eq!(r.user.detail, None);
        assert_eq!(r.user.avatar, None);
        let seen = json!({"id": "u_1", "name": "Ravi Menon", "color": "#2563eb", "detail": "Ops"});
        let a = r.awareness(&seen, "anon_x").to_string();
        assert!(
            !a.contains("Ravi") && !a.contains("u_1") && !a.contains("Ops"),
            "{a}"
        );
    }

    #[test]
    fn external_people_show_only_what_the_host_chose() {
        let r = Resolved::from_json(
            &json!({"id": "u_p", "name": "Priya S.", "relation": "external"}),
            &viewer(false),
        )
        .unwrap();
        let seen = json!({"id": "u_p", "name": "Priya Shah", "color": "#2563eb", "detail": "Product", "avatar": "https://a/p.png"});
        let a = r.awareness(&seen, "anon_x");
        assert_eq!(a["name"], "Priya S.");
        assert_eq!(a["relation"], "external");
        assert!(a.get("detail").is_none());
        assert!(a["avatar"].is_null());
        let c = Resolved::from_json(
            &json!({"id": "u_p", "name": "Pri (team lead)", "relation": "contact", "deactivated": true}),
            &viewer(false),
        )
        .unwrap()
        .awareness(&seen, "anon_x");
        assert_eq!(c["name"], "Pri (team lead)");
        assert_eq!(c["detail"], "Product");
        assert_eq!(c["deactivated"], true);
    }

    #[test]
    fn anon_ids_differ_per_viewer() {
        assert_ne!(anon_id("r", "a", "s"), anon_id("r", "b", "s"));
        assert_eq!(anon_id("r", "a", "s"), anon_id("r", "a", "s"));
        assert!(!anon_id("r", "a", "u_ravi").contains("ravi"));
    }
}
