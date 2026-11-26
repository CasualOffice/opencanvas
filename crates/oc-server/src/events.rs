// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Change events of a canvas (docs/27 §4.2, HAPI-05; ADR-056 for webhooks).
//!
//! The room actor that owns a file publishes events as things happen: `edited` (block ids,
//! debounced), `commented`, `mentioned`, `member.joined`, `member.left`, `session.closed`,
//! `restored` and `saved`. Events carry ids, user ids, versions and counts only, never document
//! content (ADR-001, rule 5).
//!
//! [`Hub`] keeps the last [`RING`] events of each room in memory and fans them out to
//! subscribers (`GET /api/v1/files/{id}/events`, SSE or WebSocket). A subscriber that resumes
//! with `Last-Event-ID` gets the events after that id, or one `resync` when the id is no longer
//! in the ring (re-read the file). A subscriber that does not keep up is dropped
//! ([`CLOSE_SLOW`]); it reconnects with its last id.
//!
//! Cluster: the owner publishes each event on the members bus as well (signed like every
//! node-to-node message); every other node records it in its own ring when somebody there
//! listens to that room. Webhooks (WH-01) take the owner's events only, so each event is
//! queued once.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;

/// Events kept per room for `Last-Event-ID` resumes.
pub const RING: usize = 512;
/// Events that may wait for one subscriber before it counts as too slow.
pub const SUB_BUFFER: usize = 256;
/// Streams per room on one node.
pub const MAX_SUBS_PER_ROOM: usize = 100;
/// A room's ring is forgotten this long after its last subscriber left and its last event.
pub const RETAIN: Duration = Duration::from_secs(600);
/// WebSocket close code (and SSE `close` event) for a subscriber that fell behind.
pub const CLOSE_SLOW: u16 = 4008;
/// Close code when a user token's lifetime ends (reconnect with a fresh token).
pub const CLOSE_EXPIRED: u16 = 4001;
/// Close code when the host revoked the caller's access to the file.
pub const CLOSE_REVOKED: u16 = 4003;

pub const EDITED: &str = "edited";
pub const COMMENTED: &str = "commented";
pub const MENTIONED: &str = "mentioned";
pub const MEMBER_JOINED: &str = "member.joined";
pub const MEMBER_LEFT: &str = "member.left";
pub const SESSION_CLOSED: &str = "session.closed";
pub const RESTORED: &str = "restored";
pub const SAVED: &str = "saved";
/// LIVE-07 (ADR-069): a `liveBlock` or `blockRef` was added to the canvas, or removed.
pub const LIVE_EMBEDDED: &str = "live.embedded";
pub const LIVE_REMOVED: &str = "live.removed";
/// AUTO-05 (ADR-067): an automation rule ran (`done`, `skipped`, `stopped`) or failed.
pub const AUTOMATION_RAN: &str = "automation.ran";
pub const AUTOMATION_FAILED: &str = "automation.failed";
/// Stream only: the resume point is gone; re-read the canvas.
pub const RESYNC: &str = "resync";

/// Every event type a room publishes (what `[host.webhooks] events` may list).
pub const TYPES: [&str; 12] = [
    EDITED,
    COMMENTED,
    MENTIONED,
    MEMBER_JOINED,
    MEMBER_LEFT,
    SESSION_CLOSED,
    RESTORED,
    SAVED,
    LIVE_EMBEDDED,
    LIVE_REMOVED,
    AUTOMATION_RAN,
    AUTOMATION_FAILED,
];

/// One event. `host_id` and `room` route it; the public JSON is [`FileEvent::public`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileEvent {
    /// `ev_<ulid>`: unique, stable across nodes and webhook retries.
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub host_id: String,
    pub room: String,
    pub file_id: String,
    /// Unix milliseconds.
    pub at: i64,
    pub data: Value,
}

impl FileEvent {
    pub fn new(host_id: &str, room: &str, file_id: &str, kind: &str, data: Value) -> Self {
        Self {
            id: new_id(),
            kind: kind.to_string(),
            host_id: host_id.to_string(),
            room: room.to_string(),
            file_id: file_id.to_string(),
            at: crate::util::now_ms(),
            data,
        }
    }

    /// What clients and webhook receivers get: `{id, type, fileId, at, data}`.
    pub fn public(&self) -> Value {
        json!({"id": self.id, "type": self.kind, "fileId": self.file_id, "at": self.at,
            "data": self.data})
    }
}

pub fn new_id() -> String {
    format!("ev_{}", ulid::Ulid::new().to_string().to_lowercase())
}

struct SubTx {
    id: u64,
    tx: mpsc::Sender<Arc<FileEvent>>,
    lagged: Arc<AtomicBool>,
}

#[derive(Default)]
struct RoomLog {
    ring: VecDeque<Arc<FileEvent>>,
    subs: Vec<SubTx>,
    /// Last event or subscriber change (for [`RETAIN`]).
    touched: Option<Instant>,
}

/// Why [`Hub::subscribe`] refused.
#[derive(Debug, PartialEq, Eq)]
pub struct TooManyStreams;

/// The event fan-out of one node.
pub struct Hub {
    rooms: Mutex<HashMap<String, RoomLog>>,
    next_sub: AtomicU64,
    last_sweep: Mutex<Option<Instant>>,
    me: Weak<Hub>,
    /// Cluster: this node's events go out on the bus through here.
    bus: OnceLock<mpsc::UnboundedSender<FileEvent>>,
    /// Webhooks (WH-01): this node's events go to the outbox writer through here.
    sink: OnceLock<mpsc::UnboundedSender<FileEvent>>,
    pub sub_buffer: usize,
}

/// One stream's end: the backlog to send first, then live events. Dropping it unsubscribes.
pub struct Subscription {
    pub backlog: Vec<Arc<FileEvent>>,
    pub rx: mpsc::Receiver<Arc<FileEvent>>,
    lagged: Arc<AtomicBool>,
    hub: Weak<Hub>,
    room: String,
    id: u64,
}

impl Subscription {
    /// True once the hub dropped this subscriber for not keeping up.
    pub fn lagged(&self) -> bool {
        self.lagged.load(Ordering::Relaxed)
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            hub.unsubscribe(&self.room, self.id);
        }
    }
}

impl Hub {
    pub fn new() -> Arc<Self> {
        Self::with_buffer(SUB_BUFFER)
    }

    /// A hub whose subscribers may fall `sub_buffer` events behind (tests use small values).
    pub fn with_buffer(sub_buffer: usize) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            rooms: Mutex::default(),
            next_sub: AtomicU64::new(1),
            last_sweep: Mutex::default(),
            me: me.clone(),
            bus: OnceLock::new(),
            sink: OnceLock::new(),
            sub_buffer: sub_buffer.max(1),
        })
    }

    /// Cluster: hands every event published here to `tx` (the bus publisher).
    pub fn set_bus(&self, tx: mpsc::UnboundedSender<FileEvent>) {
        let _ = self.bus.set(tx);
    }

    /// Webhooks: hands every event published here to `tx` (the outbox writer).
    pub fn set_sink(&self, tx: mpsc::UnboundedSender<FileEvent>) {
        let _ = self.sink.set(tx);
    }

    /// An event of a room this node owns: recorded, fanned out, sent to the other nodes and
    /// to the webhook outbox.
    pub fn publish(&self, ev: FileEvent) {
        if let Some(tx) = self.bus.get() {
            let _ = tx.send(ev.clone());
        }
        if let Some(tx) = self.sink.get() {
            let _ = tx.send(ev.clone());
        }
        self.record(Arc::new(ev), true);
    }

    /// An event another node published: recorded only where somebody listens to the room
    /// (or listened recently).
    pub fn remote(&self, ev: FileEvent) {
        self.record(Arc::new(ev), false);
    }

    fn record(&self, ev: Arc<FileEvent>, create: bool) {
        self.sweep();
        let mut rooms = self.rooms.lock().expect("events");
        let log = match rooms.get_mut(&ev.room) {
            Some(l) => l,
            None if create => rooms.entry(ev.room.clone()).or_default(),
            None => return,
        };
        if log.ring.iter().rev().take(8).any(|e| e.id == ev.id) {
            return;
        }
        if log.ring.len() >= RING {
            log.ring.pop_front();
        }
        log.ring.push_back(ev.clone());
        log.touched = Some(Instant::now());
        log.subs.retain(|s| match s.tx.try_send(ev.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                s.lagged.store(true, Ordering::Relaxed);
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        });
    }

    /// Subscribes to `room`. With `last_id`, the backlog holds the events after it, or one
    /// `resync` when it is no longer known.
    pub fn subscribe(
        &self,
        room: &str,
        file_id: &str,
        host_id: &str,
        last_id: Option<&str>,
    ) -> Result<Subscription, TooManyStreams> {
        self.sweep();
        let mut rooms = self.rooms.lock().expect("events");
        let log = rooms.entry(room.to_string()).or_default();
        if log.subs.len() >= MAX_SUBS_PER_ROOM {
            return Err(TooManyStreams);
        }
        let backlog = match last_id.filter(|s| !s.is_empty()) {
            None => vec![],
            Some(last) => match log.ring.iter().position(|e| e.id == last) {
                Some(i) => log.ring.iter().skip(i + 1).cloned().collect(),
                None => {
                    let mut ev = FileEvent::new(
                        host_id,
                        room,
                        file_id,
                        RESYNC,
                        json!({"reason": "the resume point is no longer known; re-read the canvas"}),
                    );
                    // Resuming from the newest known event next time costs nothing.
                    if let Some(newest) = log.ring.back() {
                        ev.id = newest.id.clone();
                    }
                    vec![Arc::new(ev)]
                }
            },
        };
        let (tx, rx) = mpsc::channel(self.sub_buffer);
        let lagged = Arc::new(AtomicBool::new(false));
        let id = self.next_sub.fetch_add(1, Ordering::Relaxed);
        log.subs.push(SubTx {
            id,
            tx,
            lagged: lagged.clone(),
        });
        log.touched = Some(Instant::now());
        Ok(Subscription {
            backlog,
            rx,
            lagged,
            hub: self.me.clone(),
            room: room.to_string(),
            id,
        })
    }

    fn unsubscribe(&self, room: &str, id: u64) {
        let mut rooms = self.rooms.lock().expect("events");
        if let Some(log) = rooms.get_mut(room) {
            log.subs.retain(|s| s.id != id);
            log.touched = Some(Instant::now());
        }
    }

    /// Streams open on `room` on this node.
    pub fn subscribers(&self, room: &str) -> usize {
        self.rooms
            .lock()
            .expect("events")
            .get(room)
            .map_or(0, |l| l.subs.len())
    }

    /// Rooms whose ring is kept on this node.
    pub fn rooms(&self) -> usize {
        self.rooms.lock().expect("events").len()
    }

    /// Forgets rings nobody listens to that have been quiet for [`RETAIN`] (at most once a
    /// minute).
    fn sweep(&self) {
        let now = Instant::now();
        {
            let mut last = self.last_sweep.lock().expect("events");
            if last.is_some_and(|t| now.duration_since(t) < Duration::from_secs(60)) {
                return;
            }
            *last = Some(now);
        }
        self.sweep_older_than(now, RETAIN);
    }

    /// Forgets idle rings quiet for `retain` as of `now` (tests call it directly).
    pub fn sweep_older_than(&self, now: Instant, retain: Duration) {
        self.rooms.lock().expect("events").retain(|_, l| {
            !l.subs.is_empty() || l.touched.is_some_and(|t| now.duration_since(t) < retain)
        });
    }
}

/// Edits gathered for one `edited` event (debounced in the room).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct EditBatch {
    pub blocks: std::collections::BTreeSet<String>,
    pub removed: std::collections::BTreeSet<String>,
    pub databases: std::collections::BTreeSet<String>,
    pub boards: std::collections::BTreeSet<String>,
    pub by: std::collections::BTreeSet<String>,
    /// Some change had no block id (`untracked: true` in the event: re-read the canvas).
    pub untracked: bool,
    first: Option<Instant>,
    last: Option<Instant>,
}

/// Block ids per `edited` event (larger edits say `truncated: true`; re-read the canvas).
pub const MAX_IDS: usize = 500;

impl EditBatch {
    pub fn is_empty(&self) -> bool {
        self.blocks.is_empty()
            && self.removed.is_empty()
            && self.databases.is_empty()
            && self.boards.is_empty()
            && !self.untracked
    }

    /// Adds what one durable batch changed, by these users, at `now`.
    pub fn add(&mut self, changes: crate::room::changes::Touched, by: &[String], now: Instant) {
        if changes.is_empty() {
            return;
        }
        for b in &changes.removed {
            self.blocks.remove(b);
        }
        self.blocks.extend(changes.blocks);
        self.removed.extend(changes.removed);
        self.databases.extend(changes.databases);
        self.boards.extend(changes.boards);
        self.untracked |= changes.untracked;
        self.by.extend(by.iter().cloned());
        self.first.get_or_insert(now);
        self.last = Some(now);
    }

    /// Due once edits paused for `quiet`, or `max` after the first one (a long burst still
    /// reports every `max`).
    pub fn due(&self, now: Instant, quiet: Duration, max: Duration) -> bool {
        match (self.first, self.last) {
            (Some(f), Some(l)) => now.duration_since(l) >= quiet || now.duration_since(f) >= max,
            _ => false,
        }
    }

    /// The event data, and an empty batch in its place.
    pub fn take(&mut self) -> Value {
        let b = std::mem::take(self);
        let cut = |s: std::collections::BTreeSet<String>| -> Vec<String> {
            s.into_iter().take(MAX_IDS).collect()
        };
        let truncated = b.blocks.len() > MAX_IDS || b.removed.len() > MAX_IDS;
        let mut v = json!({
            "blockIds": cut(b.blocks),
            "removedBlockIds": cut(b.removed),
            "by": b.by.into_iter().collect::<Vec<_>>(),
        });
        if !b.databases.is_empty() {
            v["databaseIds"] = json!(cut(b.databases));
        }
        if !b.boards.is_empty() {
            v["boardIds"] = json!(cut(b.boards));
        }
        if truncated {
            v["truncated"] = json!(true);
        }
        if b.untracked {
            v["untracked"] = json!(true);
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(room: &str, kind: &str) -> FileEvent {
        FileEvent::new("h", room, "f", kind, json!({}))
    }

    #[tokio::test]
    async fn fans_out_and_resumes_from_the_ring() {
        let hub = Hub::new();
        let mut a = hub.subscribe("r1", "f", "h", None).unwrap();
        let e1 = ev("r1", SAVED);
        let e2 = ev("r1", EDITED);
        hub.publish(e1.clone());
        hub.publish(e2.clone());
        hub.publish(ev("r2", SAVED));
        assert_eq!(a.rx.recv().await.unwrap().id, e1.id);
        assert_eq!(a.rx.recv().await.unwrap().id, e2.id);
        assert!(a.rx.try_recv().is_err(), "other rooms are not mixed in");
        let b = hub.subscribe("r1", "f", "h", Some(&e1.id)).unwrap();
        assert_eq!(
            b.backlog.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
            vec![e2.id.clone()]
        );
        let c = hub.subscribe("r1", "f", "h", Some(&e2.id)).unwrap();
        assert!(c.backlog.is_empty());
        let d = hub.subscribe("r1", "f", "h", Some("ev_unknown")).unwrap();
        assert_eq!(d.backlog.len(), 1);
        assert_eq!(d.backlog[0].kind, RESYNC);
        assert_eq!(d.backlog[0].id, e2.id, "resync points at the newest event");
        assert_eq!(hub.subscribers("r1"), 4);
        drop((a, b, c, d));
        assert_eq!(hub.subscribers("r1"), 0);
    }

    #[test]
    fn the_ring_keeps_the_newest_events() {
        let hub = Hub::new();
        let first = ev("r1", SAVED);
        hub.publish(first.clone());
        for _ in 0..RING {
            hub.publish(ev("r1", SAVED));
        }
        let s = hub.subscribe("r1", "f", "h", Some(&first.id)).unwrap();
        assert_eq!(
            s.backlog[0].kind, RESYNC,
            "the first event fell out of the ring"
        );
    }

    #[test]
    fn a_slow_subscriber_is_dropped_and_told() {
        let hub = Hub::with_buffer(4);
        let slow = hub.subscribe("r1", "f", "h", None).unwrap();
        let mut fast = hub.subscribe("r1", "f", "h", None).unwrap();
        for i in 0..4 {
            hub.publish(ev("r1", SAVED));
            assert!(fast.rx.try_recv().is_ok(), "event {i}");
        }
        assert!(!slow.lagged());
        hub.publish(ev("r1", SAVED));
        assert!(slow.lagged(), "the fifth event found its buffer full");
        assert!(!fast.lagged());
        assert_eq!(hub.subscribers("r1"), 1);
    }

    #[test]
    fn remote_events_are_kept_only_where_someone_listens() {
        let hub = Hub::new();
        hub.remote(ev("r1", SAVED));
        assert_eq!(hub.rooms(), 0);
        let _s = hub.subscribe("r1", "f", "h", None).unwrap();
        let e = ev("r1", SAVED);
        hub.remote(e.clone());
        hub.remote(e);
        let t = hub.subscribe("r1", "f", "h", Some("ev_x")).unwrap();
        assert_eq!(t.backlog[0].kind, RESYNC);
        let mut rooms = hub.rooms.lock().unwrap();
        assert_eq!(
            rooms.get_mut("r1").unwrap().ring.len(),
            1,
            "duplicates ignored"
        );
    }

    #[test]
    fn idle_rings_are_forgotten_and_streams_are_capped() {
        let hub = Hub::new();
        hub.publish(ev("r1", SAVED));
        let _s = hub.subscribe("r2", "f", "h", None).unwrap();
        hub.sweep_older_than(Instant::now() + RETAIN, RETAIN);
        assert_eq!(hub.rooms(), 1, "r2 has a subscriber, r1 is forgotten");
        let subs: Vec<_> = (0..MAX_SUBS_PER_ROOM - 1)
            .map(|_| hub.subscribe("r2", "f", "h", None).unwrap())
            .collect();
        assert!(hub.subscribe("r2", "f", "h", None).is_err());
        drop(subs);
        assert!(hub.subscribe("r2", "f", "h", None).is_ok());
    }

    #[test]
    fn publish_feeds_the_bus_and_the_webhook_sink() {
        let hub = Hub::new();
        let (btx, mut brx) = mpsc::unbounded_channel();
        let (stx, mut srx) = mpsc::unbounded_channel();
        hub.set_bus(btx);
        hub.set_sink(stx);
        let e = ev("r1", SAVED);
        hub.publish(e.clone());
        assert_eq!(brx.try_recv().unwrap(), e);
        assert_eq!(srx.try_recv().unwrap(), e);
        hub.remote(ev("r1", SAVED));
        assert!(
            brx.try_recv().is_err() && srx.try_recv().is_err(),
            "never re-sent"
        );
    }

    #[test]
    fn edits_are_debounced_and_capped() {
        let t0 = Instant::now();
        let quiet = Duration::from_millis(250);
        let max = Duration::from_secs(2);
        let mut b = EditBatch::default();
        assert!(!b.due(t0, quiet, max));
        let touched = |blocks: &[&str], removed: &[&str]| crate::room::changes::Touched {
            blocks: blocks.iter().map(|s| s.to_string()).collect(),
            removed: removed.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        };
        b.add(touched(&["b1", "b2"], &[]), &["u_a".into()], t0);
        assert!(!b.due(t0 + Duration::from_millis(100), quiet, max));
        b.add(
            touched(&[], &["b2"]),
            &["u_b".into()],
            t0 + Duration::from_millis(200),
        );
        assert!(!b.due(t0 + Duration::from_millis(400), quiet, max));
        assert!(b.due(t0 + Duration::from_millis(450), quiet, max));
        // A burst that never pauses still reports every `max`.
        let mut c = b.clone();
        for i in 0..40 {
            c.add(
                touched(&["b3"], &[]),
                &["u_a".into()],
                t0 + Duration::from_millis(i * 50),
            );
        }
        assert!(c.due(t0 + Duration::from_millis(2000), quiet, max));
        let v = b.take();
        assert_eq!(
            v,
            json!({"blockIds": ["b1"], "removedBlockIds": ["b2"], "by": ["u_a", "u_b"]})
        );
        assert!(b.is_empty() && !b.due(t0 + max * 2, quiet, max));
        let many: Vec<String> = (0..MAX_IDS + 5).map(|i| format!("b{i}")).collect();
        b.add(
            crate::room::changes::Touched {
                blocks: many.into_iter().collect(),
                ..Default::default()
            },
            &[],
            t0,
        );
        let v = b.take();
        assert_eq!(v["blockIds"].as_array().unwrap().len(), MAX_IDS);
        assert_eq!(v["truncated"], true);
    }
}
