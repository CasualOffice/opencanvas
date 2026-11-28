// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! People (docs/21 revision 2, ADR-026): the user object as hosts send it, and the canvas's
//! member list.
//!
//! The mention list is the people with access to this canvas. The host says who that is in
//! the launch token (`members[]`) and/or the optional `GET /files/{fileId}/members` callback;
//! without either, it is everyone who has opened the canvas (the saved `people` map). The list
//! is the same for every viewer of a room. E-mail is never read, kept or shown.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::StatusCode;
use serde_json::{Value, json};

use crate::grant::{Grant, Role, User, derive_color, is_hex_color};
use crate::host_client::{HostClient, SaveTarget};
use crate::hosts::HostConfig;

/// At most this many `members` are read from a launch token or a callback answer.
pub const MAX_MEMBERS: usize = 500;
const MAX_ID: usize = 256;
const MAX_NAME: usize = 200;
const MAX_DETAIL: usize = 200;
const MAX_URL: usize = 2048;
/// Callback answers are kept this long per (room, query).
pub const MEMBERS_TTL: Duration = Duration::from_secs(60);
const MAX_CACHE_ENTRIES: usize = 10_000;

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

/// A user object from a host (token `user`, `members`, the members callback, the saved
/// `people` map). `None` without a usable `id`. Any `email` is ignored.
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
        avatar: safe_url(v.get("avatar").and_then(Value::as_str)),
        color,
        id,
    })
}

/// A list of user objects (≤ 500 usable entries, duplicates dropped). Accepts `[user…]` or
/// `{"members":[…]}` / `{"users":[…]}`.
pub fn members_from_json(v: Option<&Value>) -> Vec<User> {
    let Some(v) = v else { return vec![] };
    let list = v
        .as_array()
        .or_else(|| v.get("members").and_then(Value::as_array))
        .or_else(|| v.get("users").and_then(Value::as_array));
    let mut seen = HashSet::new();
    list.map(|a| {
        a.iter()
            .filter_map(user_from_json)
            .filter(|u| seen.insert(u.id.clone()))
            .take(MAX_MEMBERS)
            .collect()
    })
    .unwrap_or_default()
}

/// The saved `people` map of a document (`document.json` shape) as user objects.
pub fn saved_people(doc: &Value) -> Vec<User> {
    doc["people"]
        .as_object()
        .map(|m| m.values().filter_map(user_from_json).collect())
        .unwrap_or_default()
}

/// Whether OpenCanvas can call this host at all (JWT callbacks; WOPI has no user API).
pub fn has_callbacks(host: &HostConfig, file_id: &str) -> bool {
    !host.callback_base.is_empty()
        && matches!(SaveTarget::of(host, file_id), Ok(SaveTarget::Callbacks))
}

/// A host answer meaning "this optional callback isn't implemented".
pub fn not_implemented(status: StatusCode) -> bool {
    matches!(status.as_u16(), 404 | 405 | 410 | 501)
}

fn matches(u: &User, q: &str) -> bool {
    q.is_empty()
        || u.name.to_lowercase().contains(q)
        || u.detail
            .as_ref()
            .is_some_and(|d| d.to_lowercase().contains(q))
}

/// The member list (docs/21 revision 2): merged by id, callback beats token beats the saved
/// `people` map. Membership comes from the host when it said anything (the callback answered
/// or the token has `members`); the saved map only fills in a missing `detail`/`avatar` then.
/// Without a host source, everyone who opened the canvas is a member. `me` (the viewer, who
/// has access) is always in. Filtered by `q` (name or detail, case-insensitive).
pub fn merge(
    callback: Option<&[User]>,
    token: &[User],
    me: &User,
    saved: &[User],
    q: &str,
) -> Vec<User> {
    let from_host = callback.is_some() || !token.is_empty();
    let mut out: Vec<User> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut add = |u: &User, member: bool| match index.get(&u.id) {
        Some(&i) => {
            let e = &mut out[i];
            if e.detail.is_none() {
                e.detail.clone_from(&u.detail);
            }
            if e.avatar.is_none() {
                e.avatar.clone_from(&u.avatar);
            }
        }
        None if member => {
            index.insert(u.id.clone(), out.len());
            out.push(u.clone());
        }
        None => {}
    };
    for u in callback.unwrap_or_default() {
        add(u, true);
    }
    for u in token {
        add(u, true);
    }
    add(me, true);
    for u in saved {
        add(u, !from_host);
    }
    let q = q.trim().to_lowercase();
    out.retain(|u| matches(u, &q));
    out
}

/// `{"id","name","detail"?,"avatar"?,"color"}` for the SPA (never an e-mail).
pub fn member_json(u: &User) -> Value {
    let mut v = json!({"id": u.id, "name": u.name, "color": u.color});
    if let Some(d) = &u.detail {
        v["detail"] = json!(d);
    }
    if let Some(a) = &u.avatar {
        v["avatar"] = json!(a);
    }
    v
}

/// Members callback answers, cached per (room, query) for [`MEMBERS_TTL`]. `None` = the host
/// has no members callback or it failed (the token and saved map apply).
#[derive(Default)]
pub struct Members {
    cache: Mutex<HashMap<CacheKey, CacheEntry>>,
    /// (room, user) the host revoked while the room was open.
    revoked: Mutex<HashSet<(String, String)>>,
    /// (room, user) -> the role the host last set with the role API (`None` = revoked) and
    /// when (Unix seconds). It wins over launch tokens issued before it.
    roles: Mutex<HashMap<CacheKey, HostRole>>,
}

/// (room, query).
type CacheKey = (String, String);
/// (fetched at, answer).
type CacheEntry = (Instant, Option<Vec<User>>);
/// (role the host set, `None` = revoked; when it was set, Unix seconds).
type HostRole = (Option<Role>, i64);

impl Members {
    /// The host's members for `q` (cached 60 s per room and query); `None` when the host has
    /// no callback, it isn't implemented, or it failed.
    pub async fn callback(
        &self,
        http: &HostClient,
        host: &HostConfig,
        grant: &Grant,
        q: &str,
    ) -> Option<Vec<User>> {
        if !has_callbacks(host, &grant.file.id) {
            return None;
        }
        let key = (grant.room.clone(), q.to_string());
        if let Some((at, v)) = self.cache.lock().expect("members").get(&key)
            && at.elapsed() < MEMBERS_TTL
        {
            return v.clone();
        }
        let answer = match http
            .members(host, &grant.callback_token, &grant.file.id, q, MAX_MEMBERS)
            .await
        {
            Ok((status, body)) if status.is_success() => {
                let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                Some(members_from_json(Some(&v)))
            }
            Ok((status, _)) if not_implemented(status) => None,
            Ok((status, _)) => {
                tracing::warn!(host = %host.id, status = status.as_u16(), "members callback failed");
                None
            }
            Err(e) => {
                tracing::warn!(host = %host.id, error = %e, "members callback unreachable");
                None
            }
        };
        let mut map = self.cache.lock().expect("members");
        if map.len() > MAX_CACHE_ENTRIES {
            map.retain(|_, (at, _)| at.elapsed() < MEMBERS_TTL);
        }
        map.insert(key, (Instant::now(), answer.clone()));
        answer
    }

    /// Drops every cached callback answer for `room`: the next request asks the host again.
    pub fn invalidate(&self, room: &str) {
        self.cache
            .lock()
            .expect("members")
            .retain(|(r, _), _| r != room);
    }

    /// Drops every cached callback answer (cluster: the members bus resubscribed and may have
    /// missed invalidations).
    pub fn invalidate_all(&self) {
        self.cache.lock().expect("members").clear();
    }

    /// The host revoked `user` on `room` (role API `none`): invalidate, and leave them out of
    /// the list even where an older token or the saved `people` map still names them, until
    /// they are granted access again or open the canvas with a new token.
    pub fn revoke(&self, room: &str, user: &str) {
        self.invalidate(room);
        let mut r = self.revoked.lock().expect("members");
        if r.len() > MAX_CACHE_ENTRIES {
            r.clear();
        }
        r.insert((room.to_string(), user.to_string()));
    }

    /// True while the host's revoke of `user` on `room` stands.
    pub fn is_revoked(&self, room: &str, user: &str) -> bool {
        self.revoked
            .lock()
            .expect("members")
            .contains(&(room.to_string(), user.to_string()))
    }

    /// `user` has access to `room` again.
    pub fn restore(&self, room: &str, user: &str) {
        self.revoked
            .lock()
            .expect("members")
            .remove(&(room.to_string(), user.to_string()));
    }

    /// The host set `user`'s role on `room` at `at` (Unix seconds) with the role API.
    pub fn set_role(&self, room: &str, user: &str, role: Option<Role>, at: i64) {
        let mut r = self.roles.lock().expect("members");
        if r.len() > MAX_CACHE_ENTRIES {
            r.clear();
        }
        r.insert((room.to_string(), user.to_string()), (role, at));
    }

    /// The role the host set for `user` on `room` after `iat`, if any: a launch token issued
    /// before the host's last role call carries an outdated role. `Some(None)` = revoked.
    pub fn role_since(&self, room: &str, user: &str, iat: i64) -> Option<Option<Role>> {
        let r = self.roles.lock().expect("members");
        match r.get(&(room.to_string(), user.to_string())) {
            Some((role, at)) if *at >= iat => Some(*role),
            _ => None,
        }
    }

    /// Leaves out people revoked on `room`.
    pub fn without_revoked(&self, room: &str, list: Vec<User>) -> Vec<User> {
        let r = self.revoked.lock().expect("members");
        list.into_iter()
            .filter(|u| !r.contains(&(room.to_string(), u.id.clone())))
            .collect()
    }
}

/// The `people` entry written into the Y.Doc for someone who opened the file: id, name,
/// detail, avatar and last seen. Never an e-mail.
pub fn people_entry(g: &Grant, now_ms: i64) -> Value {
    let mut v = json!({"id": g.user.id, "name": g.user.name, "lastSeen": now_ms});
    if let Some(d) = &g.user.detail {
        v["detail"] = json!(d);
    }
    if let Some(a) = &g.user.avatar {
        v["avatar"] = json!(a);
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(id: &str, name: &str, detail: Option<&str>) -> User {
        User {
            id: id.into(),
            name: name.into(),
            detail: detail.map(String::from),
            color: derive_color(id),
            avatar: None,
        }
    }

    #[test]
    fn user_objects_are_sanitised_and_never_keep_email() {
        let v = user_from_json(&json!({
            "id": "u_1", "name": "  Asha\u{7} Rao ", "detail": "Design · Bengaluru",
            "email": "asha@acme.example", "avatar": "javascript:alert(1)", "color": "red"
        }))
        .unwrap();
        assert_eq!(v.name, "Asha Rao");
        assert_eq!(v.detail.as_deref(), Some("Design · Bengaluru"));
        assert_eq!(v.avatar, None);
        assert!(v.color.starts_with('#'));
        assert!(!serde_json::to_string(&v).unwrap().contains('@'));
        assert!(user_from_json(&json!({"name": "no id"})).is_none());
        assert_eq!(user_from_json(&json!({"id": 7})).unwrap().name, "7");
    }

    #[test]
    fn members_are_capped_and_deduplicated() {
        let list: Vec<Value> = (0..700)
            .map(|i| json!({"id": format!("u_{}", i % 600), "name": "P"}))
            .collect();
        let m = members_from_json(Some(&Value::Array(list)));
        assert_eq!(m.len(), MAX_MEMBERS);
        assert_eq!(m[0].id, "u_0");
        assert!(members_from_json(None).is_empty());
        let wrapped = members_from_json(Some(&json!({"members": [{"id": "a"}]})));
        assert_eq!(wrapped.len(), 1);
    }

    /// docs/21 revision 2: callback beats token beats the saved `people` map.
    #[test]
    fn merge_order() {
        let me = u("u_me", "Me", None);
        let cb = [u("u_a", "Asha (callback)", None)];
        let token = [
            u("u_a", "Asha (token)", Some("Design")),
            u("u_b", "Ben", None),
        ];
        let saved = [
            u("u_b", "Ben (saved)", Some("Ops")),
            u("u_gone", "Removed person", None),
        ];
        let m = merge(Some(&cb), &token, &me, &saved, "");
        let ids: Vec<&str> = m.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(
            ids,
            ["u_a", "u_b", "u_me"],
            "saved-only people are not members"
        );
        assert_eq!(m[0].name, "Asha (callback)");
        assert_eq!(
            m[0].detail.as_deref(),
            Some("Design"),
            "detail filled from the token"
        );
        assert_eq!(m[1].name, "Ben");
        assert_eq!(
            m[1].detail.as_deref(),
            Some("Ops"),
            "detail filled from saved"
        );

        // Token only.
        let m = merge(None, &token, &me, &saved, "");
        assert_eq!(m[0].name, "Asha (token)");
        assert!(!m.iter().any(|x| x.id == "u_gone"));

        // No host source: everyone who opened the canvas.
        let m = merge(None, &[], &me, &saved, "");
        let ids: Vec<&str> = m.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["u_me", "u_b", "u_gone"]);

        // q filters by name or detail.
        let m = merge(None, &token, &me, &saved, "desi");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].id, "u_a");
    }

    #[test]
    fn people_entries_have_no_email() {
        let g = Grant {
            ext_blocks: false,
            subdoc: false,
            live: Default::default(),
            wopi_history: None,
            host_id: "h".into(),
            room: "r".into(),
            role: crate::grant::Role::Edit,
            user: u("u_v", "V", Some("Ops")),
            file: crate::grant::FileRef {
                id: "f".into(),
                name: "F".into(),
                version: None,
                app: None,
            },
            perms: crate::grant::Perms::default(),
            callback_token: "t".into(),
            members: vec![],
        };
        let e = people_entry(&g, 1);
        assert_eq!(e["detail"], "Ops");
        assert!(e.get("email").is_none());
    }
}
