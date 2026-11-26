// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Awareness (presence) on the room's hot path (docs/22 §8 weakness 1).
//!
//! Every viewer gets the same presence (docs/21 revision 2), so an incoming update is stamped
//! once with the sender's grant ([`stamp`]) and then fanned out as one shared frame. While the
//! room is busy, updates wait in a [`Coalescer`] (latest state per client wins) and go out as
//! one frame per batch; under overload, awareness frames that find the inbox full wait in the
//! [`Inbox`] mailbox (one per connection, latest wins) instead of queueing. Yjs updates are
//! never shed: they wait for a permit, which pushes back on the client's socket.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::Semaphore;
use yrs::ClientID;
use yrs::sync::AwarenessUpdate;
use yrs::sync::awareness::AwarenessUpdateEntry;

use super::ConnId;

/// Frames a room may hold in its inbox before senders wait (updates) or are coalesced
/// (awareness). Bounds the room's memory at about this many client frames.
pub const INBOX_FRAMES: usize = 2048;

/// Awareness entries a busy room may hold before it flushes them anyway.
pub const MAX_PENDING_CLIENTS: usize = 1024;

/// Returns the awareness state with `user` overwritten by the sender's grant (docs/06 §2).
/// States that are not a JSON object (`null`: the client left) pass through unchanged.
pub fn stamp(json: &str, user: &Value) -> Arc<str> {
    stamp_from(json, user, None)
}

/// [`stamp`], and `from` (LIVE-02, ADR-069) set by the server: where a person in a live file's
/// room is (`{fileId, title}` of the canvas that embeds it), or removed. A client never
/// writes it.
pub fn stamp_from(json: &str, user: &Value, from: Option<&Value>) -> Arc<str> {
    match serde_json::from_str::<Value>(json) {
        Ok(Value::Object(mut state)) => {
            state.insert("user".into(), user.clone());
            state.remove("from");
            if let Some(f) = from {
                state.insert("from".into(), f.clone());
            }
            Value::Object(state).to_string().into()
        }
        _ => Arc::from(json),
    }
}

/// The awareness entries as `viewer_parent` may see them (ADR-069): `from` names a canvas, so
/// it is kept only for viewers in a session derived from that same canvas (who can read its
/// title); everyone else gets the entry without it. `None` when nothing changes.
pub fn without_foreign_from(
    update: &yrs::sync::AwarenessUpdate,
    viewer_parent: Option<&str>,
) -> Option<yrs::sync::AwarenessUpdate> {
    let mut changed = false;
    let mut out = update.clone();
    for entry in out.clients.values_mut() {
        if !entry.json.contains("\"from\"") {
            continue;
        }
        let Ok(Value::Object(mut state)) = serde_json::from_str::<Value>(&entry.json) else {
            continue;
        };
        let same = state
            .get("from")
            .and_then(|f| f.get("fileId"))
            .and_then(Value::as_str)
            .is_some_and(|f| Some(f) == viewer_parent);
        if !same && state.remove("from").is_some() {
            entry.json = Value::Object(state).to_string().into();
            changed = true;
        }
    }
    changed.then_some(out)
}

/// Stamped awareness entries waiting to be applied and fanned out: the latest per client.
#[derive(Default)]
pub struct Coalescer {
    pending: HashMap<ClientID, AwarenessUpdateEntry>,
    senders: HashSet<ConnId>,
}

impl Coalescer {
    /// Queues `entry` for `client`; an older clock never replaces a newer one.
    pub fn push(&mut self, from: ConnId, client: ClientID, entry: AwarenessUpdateEntry) {
        self.senders.insert(from);
        match self.pending.get(&client) {
            Some(old) if old.clock > entry.clock => {}
            _ => {
                self.pending.insert(client, entry);
            }
        }
    }

    /// Drops whatever is queued for `clients` (their connection left).
    pub fn forget(&mut self, clients: impl IntoIterator<Item = ClientID>) {
        for c in clients {
            self.pending.remove(&c);
        }
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Everything queued, as one update, plus the connection to skip when it came from just
    /// one (it already has its own state).
    pub fn take(&mut self) -> Option<(AwarenessUpdate, Option<ConnId>)> {
        if self.pending.is_empty() {
            self.senders.clear();
            return None;
        }
        let clients = std::mem::take(&mut self.pending);
        let senders = std::mem::take(&mut self.senders);
        let except = (senders.len() == 1).then(|| *senders.iter().next().expect("one sender"));
        Some((AwarenessUpdate { clients }, except))
    }
}

/// A room's bounded inbox: permits for queued client frames, plus a latest-wins mailbox for
/// awareness frames that arrive while every permit is taken.
pub struct Inbox {
    pub permits: Arc<Semaphore>,
    shed: Mutex<HashMap<ConnId, Vec<u8>>>,
}

impl Default for Inbox {
    fn default() -> Self {
        Self::new(INBOX_FRAMES)
    }
}

impl Inbox {
    pub fn new(frames: usize) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(frames)),
            shed: Mutex::default(),
        }
    }

    /// Keeps only the newest awareness frame from `conn` until the room drains the mailbox.
    pub fn park(&self, conn: ConnId, frame: Vec<u8>) {
        self.shed.lock().expect("inbox lock").insert(conn, frame);
    }

    pub fn has_parked(&self) -> bool {
        !self.shed.lock().expect("inbox lock").is_empty()
    }

    pub fn take_parked(&self) -> Vec<(ConnId, Vec<u8>)> {
        std::mem::take(&mut *self.shed.lock().expect("inbox lock"))
            .into_iter()
            .collect()
    }

    pub fn forget(&self, conn: ConnId) {
        self.shed.lock().expect("inbox lock").remove(&conn);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(clock: u32, json: &str) -> AwarenessUpdateEntry {
        AwarenessUpdateEntry {
            clock,
            json: Arc::from(json),
        }
    }

    #[test]
    fn stamp_overwrites_a_spoofed_user_with_the_grant() {
        let grant_user = json!({"id": "u_a", "name": "Alice", "color": "#123456"});
        let spoof = json!({"user": {"id": "u_admin", "name": "Mallory"}, "cursor": {"a": 1}});
        let out: Value = serde_json::from_str(&stamp(&spoof.to_string(), &grant_user)).unwrap();
        assert_eq!(out["user"], grant_user);
        assert_eq!(out["cursor"], json!({"a": 1}));
        // A state without `user` gets one; `null` (left) passes through.
        let out: Value = serde_json::from_str(&stamp("{}", &grant_user)).unwrap();
        assert_eq!(out["user"]["id"], "u_a");
        assert_eq!(&*stamp("null", &grant_user), "null");
    }

    #[test]
    fn coalescer_keeps_the_latest_state_per_client() {
        let mut c = Coalescer::default();
        let (a, b) = (ClientID::new(1), ClientID::new(2));
        c.push(10, a, entry(1, r#"{"cursor":1}"#));
        c.push(10, a, entry(2, r#"{"cursor":2}"#));
        c.push(11, b, entry(5, r#"{"cursor":5}"#));
        c.push(11, b, entry(4, r#"{"cursor":4}"#)); // older clock arriving late
        c.push(10, a, entry(3, r#"{"cursor":3}"#));
        assert_eq!(c.len(), 2);
        let (update, except) = c.take().unwrap();
        assert_eq!(except, None, "two senders: everyone gets the frame");
        assert_eq!(update.clients[&a].clock, 3);
        assert_eq!(&*update.clients[&a].json, r#"{"cursor":3}"#);
        assert_eq!(update.clients[&b].clock, 5);
        assert!(c.take().is_none());

        c.push(10, a, entry(4, "{}"));
        c.forget([a]);
        assert!(c.take().is_none(), "a left: nothing to send");
        c.push(12, b, entry(6, "{}"));
        assert_eq!(c.take().unwrap().1, Some(12), "one sender is skipped");
    }

    #[test]
    fn inbox_mailbox_keeps_one_frame_per_connection() {
        let inbox = Inbox::new(1);
        for i in 0..100u8 {
            inbox.park(7, vec![1, i]);
        }
        inbox.park(8, vec![1, 0]);
        let mut parked = inbox.take_parked();
        parked.sort();
        assert_eq!(parked, vec![(7, vec![1, 99]), (8, vec![1, 0])]);
        assert!(!inbox.has_parked());
    }
}
