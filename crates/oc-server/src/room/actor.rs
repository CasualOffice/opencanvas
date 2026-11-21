//! The room actor: owns the Y.Doc, peers, WAL, autosave and awareness for one file.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use anyhow::Context;
use bytes::Bytes;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use yrs::encoding::read::Cursor;
use yrs::sync::protocol::MessageReader;
use yrs::sync::{Awareness, AwarenessUpdate, Message, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::{ClientID, Doc, Map, ReadTxn, StateVector, Transact, Update};

use super::{
    Cmd, CommitResult, ConflictOutcome, ConnId, Ctx, Outbound, PatchFailure, Patched, RoomInfo,
    Rooms, filter, protocol,
};
use crate::grant::{Grant, Role};
use crate::host_client::{Fetched, PutOutcome, PutRequest};
use crate::hosts::{ConflictPolicy, HostConfig};
use crate::metrics::Metrics;
use crate::people;
use crate::store::{NotifyRow, OutboxRow};
use crate::util::{now_ms, rfc3339};

const BACKOFF_SECS: [u64; 4] = [1, 2, 5, 10];
const MAX_AWARENESS_BYTES: usize = 2048;
/// Connections per room (docs/07 §3: 50 editors + 500 viewers). Later joins are closed
/// with 1013 "room full".
pub const MAX_PEERS: usize = 550;
/// Awareness client ids one connection may own (one per Y.Doc; a few for tabs/reconnects).
const MAX_CLIENTS_PER_CONN: usize = 8;
/// New @mentions are collected once the room has been quiet this long (a burst of edits in one
/// block becomes one notification).
const MENTION_SETTLE: Duration = Duration::from_millis(500);

fn backoff(attempt: u32) -> u64 {
    BACKOFF_SECS[(attempt as usize).min(BACKOFF_SECS.len() - 1)]
}

struct Peer {
    grant: Arc<Grant>,
    tx: mpsc::UnboundedSender<Outbound>,
    clients: HashSet<ClientID>,
    denied: bool,
    synced: bool,
}

/// A commit recorded in `commit_outbox`: retries resend exactly these bytes with this key.
#[derive(Clone)]
struct Pending {
    id: String,
    seq: i64,
    body: Arc<Vec<u8>>,
    if_match: Option<String>,
    authors: Vec<String>,
    token: String,
}

impl From<OutboxRow> for Pending {
    fn from(r: OutboxRow) -> Self {
        Self {
            id: r.id,
            seq: r.seq,
            body: Arc::new(r.payload),
            if_match: r.base_version,
            authors: r.authors,
            token: r.token,
        }
    }
}

#[derive(Default)]
struct SaveState {
    in_flight: bool,
    attempt: u32,
    retry_at: Option<Instant>,
    pending: Option<Pending>,
}

/// After a 409 the room is read-only while the host's conflict policy runs.
struct Conflict {
    policy: ConflictPolicy,
    key: String,
    in_flight: bool,
    attempt: u32,
    retry_at: Option<Instant>,
    /// Copy policy: the copy exists and clients were told; the room closes when empty.
    resolved: bool,
}

struct Room {
    ctx: Arc<Ctx>,
    id: String,
    host: Arc<HostConfig>,
    file_id: String,
    doc: Doc,
    awareness: Awareness,
    peers: HashMap<ConnId, Peer>,
    host_version: Option<String>,
    dirty_since: Option<Instant>,
    last_update: Instant,
    contributors: BTreeSet<String>,
    callback_token: String,
    /// Fencing epoch taken at load (docs/22 §8 weakness 3): every WAL, snapshot and outbox
    /// write is refused once another actor (on any node) has taken a newer one.
    epoch: i64,
    seq: i64,
    compacted_seq: i64,
    last_compact: Instant,
    /// Upper bound of the encoded doc size (exact after load and compaction).
    doc_bytes: usize,
    save: SaveState,
    conflict: Option<Conflict>,
    status: Value,
    idle_since: Option<Instant>,
    self_tx: mpsc::UnboundedSender<Cmd>,
    /// Commit API callers waiting for a save that covers `seq`.
    commit_waiters: Vec<(i64, tokio::sync::oneshot::Sender<CommitResult>)>,
    /// New @mentions to tell the host about (`None`: WOPI or no callbacks, UX-02).
    mentions: Option<super::mentions::Tracker>,
    /// Set when the in-memory doc can no longer be trusted to match the WAL (a write was
    /// fenced, or a WAL append failed): the run loop closes the room without saving and every
    /// client reconnects (1012) to a room rebuilt from the WAL, resending what it missed.
    lost: Option<&'static str>,
}

pub(super) async fn run(
    ctx: Arc<Ctx>,
    rooms: Weak<Rooms>,
    generation: u64,
    host: Arc<HostConfig>,
    seed: Grant,
    self_tx: mpsc::UnboundedSender<Cmd>,
    mut rx: mpsc::UnboundedReceiver<Cmd>,
) {
    let id = seed.room.clone();
    let mut room = match Room::load(ctx.clone(), host, &seed, self_tx).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(room = %id, error = %e, "room load failed");
            if let Some(r) = rooms.upgrade() {
                r.remove(&id, generation);
            }
            return;
        }
    };
    Metrics::inc(&ctx.metrics.rooms_active);
    let mut tick = tokio::time::interval(ctx.cfg.tick);
    let shutdown = loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                None => break End::Idle,
                Some(Cmd::Shutdown { by_host, reply }) => break End::Shutdown(by_host, reply),
                Some(Cmd::StepDown) => break End::StepDown,
                Some(cmd) => room.handle(cmd).await,
            },
            _ = tick.tick() => if room.tick().await { break End::Idle },
        }
        if let Some(why) = room.lost {
            break End::Lost(why);
        }
    };
    match shutdown {
        End::Lost(why) => {
            // No save, no purge: the WAL (ours up to the failure, or the new owner's) is the
            // truth; clients reconnect and resend what it lacks.
            tracing::warn!(room = %id, reason = why, seq = room.seq, "room closed; clients told to reconnect");
            room.tell_reconnect(why);
            if let Some(r) = rooms.upgrade() {
                r.remove(&id, generation);
            }
        }
        End::StepDown => {
            // Another node owns the room now and continues from the WAL: no save, no purge.
            room.step_down();
            if let Some(r) = rooms.upgrade() {
                r.remove(&id, generation);
            }
        }
        End::Shutdown(by_host, reply) => {
            room.shutdown(&mut rx, by_host).await;
            if let Some(r) = rooms.upgrade() {
                r.remove(&id, generation);
            }
            let _ = reply.send(());
        }
        End::Idle => {
            match ctx.store.purge_room_fenced(&id, room.epoch).await {
                Ok(()) => {}
                Err(e) if crate::store::is_fenced(&e) => {
                    tracing::warn!(room = %id, "room taken by a newer owner; its WAL is kept")
                }
                Err(e) => tracing::warn!(room = %id, error = %e, "purge failed"),
            }
            if let Some(r) = rooms.upgrade() {
                r.remove(&id, generation);
            }
        }
    }
    // Requests that raced with closing get their reply dropped and retry on a fresh actor.
    rx.close();
    while rx.try_recv().is_ok() {}
    Metrics::dec(&ctx.metrics.rooms_active);
    tracing::info!(room = %id, "room closed");
}

enum End {
    Idle,
    Lost(&'static str),
    StepDown,
    Shutdown(bool, tokio::sync::oneshot::Sender<()>),
}

/// Builds a doc from what the host's `GET /files/{id}` returned.
fn doc_from_host(room: &str, fetched: Fetched) -> anyhow::Result<(Doc, Option<String>)> {
    match fetched {
        Fetched::Missing => Ok((oc_model::new_doc(), None)),
        Fetched::Found {
            bytes,
            content_type,
            etag,
        } => {
            let doc = if oc_model::ocanvas::is_zip(&bytes) {
                oc_model::read_ocanvas(&bytes)?.doc
            } else {
                if !content_type.starts_with("text/") && !content_type.is_empty() {
                    tracing::debug!(room, %content_type, "loading non-zip file as text");
                }
                let doc = oc_model::new_doc();
                oc_model::import::apply_markdown(&doc, &String::from_utf8_lossy(&bytes));
                doc
            };
            Ok((doc, etag))
        }
    }
}

fn encoded_len(doc: &Doc) -> usize {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
        .len()
}

impl Room {
    async fn load(
        ctx: Arc<Ctx>,
        host: Arc<HostConfig>,
        seed: &Grant,
        self_tx: mpsc::UnboundedSender<Cmd>,
    ) -> anyhow::Result<Self> {
        let id = seed.room.clone();
        // The epoch comes first: a writer that lost the room can append nothing after this, so
        // the WAL read below is complete.
        let epoch = ctx.store.claim_epoch(&id, now_ms()).await?;
        let row = ctx.store.room(&id).await?;
        let outbox = ctx.store.outbox_pending(&id).await?;
        let mut doc = oc_model::new_doc();
        let mut host_version = seed.file.version.clone();
        let mut dirty_since = None;
        let mut seq = 0;
        let wal = match &row {
            Some(r) if r.dirty => Some(ctx.store.load_wal(&id).await?).filter(|w| !w.is_empty()),
            _ => None,
        };
        if let (Some(wal), Some(row)) = (wal, &row) {
            if let Some((_, state)) = &wal.snapshot {
                oc_model::ocanvas::apply_update_bytes(&doc, state).context("snapshot")?;
            }
            for (_, u) in &wal.updates {
                oc_model::ocanvas::apply_update_bytes(&doc, u).context("wal entry")?;
            }
            seq = wal.last_seq();
            host_version = row.host_version.clone().or(host_version);
            dirty_since = Some(Instant::now());
            tracing::info!(room = %id, seq, "recovered unsaved room state from WAL");
        } else if let Some(p) = &outbox {
            // No WAL, but a commit never reached the host: its payload is the latest state.
            doc = oc_model::read_ocanvas(&p.payload)
                .context("outbox payload")?
                .doc;
            seq = p.seq;
            host_version = p.base_version.clone();
            dirty_since = Some(Instant::now());
            ctx.store.purge_room(&id).await?;
            ctx.store
                .put_room(
                    &id,
                    &host.id,
                    &seed.file.id,
                    host_version.as_deref(),
                    true,
                    now_ms(),
                )
                .await?;
            tracing::info!(room = %id, "recovered unsaved room state from the commit outbox");
        } else {
            ctx.store.purge_room(&id).await?;
            let fetched = ctx
                .host
                .get_file(&host, &seed.callback_token, &seed.file.id)
                .await?;
            let (loaded, etag) = doc_from_host(&id, fetched)?;
            doc = loaded;
            host_version = etag.or(host_version);
            ctx.store
                .put_room(
                    &id,
                    &host.id,
                    &seed.file.id,
                    host_version.as_deref(),
                    false,
                    now_ms(),
                )
                .await?;
        }
        // A pending commit is resent as is when it covers exactly this state; otherwise the
        // next save (which contains everything) replaces it.
        let mut contributors = BTreeSet::new();
        let pending = match outbox {
            Some(p) if p.seq == seq && dirty_since.is_some() => {
                contributors.extend(p.authors.iter().cloned());
                Some(Pending::from(p))
            }
            Some(p) => {
                ctx.store.outbox_finish(&p.id, "superseded").await?;
                None
            }
            None => None,
        };
        let status = json!({"t": "saved", "at": now_ms(), "version": host_version});
        let mentions = crate::notify::enabled(&host, &seed.file.id)
            .then(|| super::mentions::Tracker::new(&doc));
        Ok(Self {
            mentions,
            awareness: Awareness::new(doc.clone()),
            doc_bytes: encoded_len(&doc),
            doc,
            id,
            file_id: seed.file.id.clone(),
            host,
            peers: HashMap::new(),
            host_version,
            dirty_since,
            last_update: Instant::now(),
            contributors,
            callback_token: seed.callback_token.clone(),
            epoch,
            seq,
            compacted_seq: seq,
            last_compact: Instant::now(),
            save: SaveState {
                pending,
                ..SaveState::default()
            },
            conflict: None,
            status,
            idle_since: Some(Instant::now()),
            self_tx,
            commit_waiters: Vec::new(),
            lost: None,
            ctx,
        })
    }

    async fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Join {
                conn,
                grant,
                tx,
                reply,
            } => self.join(conn, grant, tx, reply).await,
            Cmd::Leave { conn } => self.leave(conn),
            Cmd::Frame { conn, data } => self.frame(conn, &data).await,
            Cmd::Info { reply } => {
                let _ = reply.send(RoomInfo {
                    is_new: oc_model::is_empty(&self.doc),
                });
            }
            Cmd::State { reply } => {
                let _ = reply.send(
                    self.doc
                        .transact()
                        .encode_state_as_update_v1(&StateVector::default()),
                );
            }
            Cmd::SaveDone { id, result } => self.save_done(&id, result).await,
            Cmd::ConflictDone { result } => self.conflict_done(result).await,
            Cmd::SetRole {
                user_id,
                role,
                reply,
            } => {
                let _ = reply.send(self.set_role(&user_id, role));
            }
            Cmd::Patch { ops, author, reply } => {
                let _ = reply.send(self.patch(&ops, &author).await);
            }
            Cmd::Commit { reply } => self.commit(reply),
            Cmd::Shutdown { .. } | Cmd::StepDown => unreachable!("handled by run loop"),
        }
    }

    fn send(&self, conn: ConnId, frame: Vec<u8>) {
        if let Some(p) = self.peers.get(&conn) {
            let _ = p.tx.send(Outbound::Frame(frame.into()));
        }
    }

    /// Sends `frame` to every peer but `except`. One buffer, shared by reference count: no
    /// per-peer copy (docs/22 §7).
    fn broadcast(&self, frame: impl Into<Bytes>, except: Option<ConnId>) {
        let frame: Bytes = frame.into();
        for (id, p) in &self.peers {
            if Some(*id) != except {
                let _ = p.tx.send(Outbound::Frame(frame.clone()));
            }
        }
    }

    fn set_status(&mut self, status: Value) {
        self.broadcast(protocol::control(&status), None);
        if status["t"] != "saving" {
            self.status = status;
        }
    }

    async fn join(
        &mut self,
        conn: ConnId,
        grant: Arc<Grant>,
        tx: mpsc::UnboundedSender<Outbound>,
        reply: tokio::sync::oneshot::Sender<()>,
    ) {
        if self.peers.len() >= MAX_PEERS {
            tracing::warn!(room = %self.id, peers = self.peers.len(), "room full; connection refused");
            let _ = tx.send(Outbound::Close(1013, "room full".into()));
            let _ = reply.send(());
            return;
        }
        if grant.can_write() && !grant.callback_token.is_empty() {
            self.callback_token = grant.callback_token.clone();
        }
        let sv = self.doc.transact().state_vector();
        let _ = tx.send(Outbound::Frame(protocol::step1(sv).into()));
        self.peers.insert(
            conn,
            Peer {
                grant: grant.clone(),
                tx,
                clients: HashSet::new(),
                denied: false,
                synced: false,
            },
        );
        self.send_awareness_to(conn);
        self.idle_since = None;
        let _ = reply.send(());
        self.note_person(&grant).await;
    }

    /// Tier 0 (docs/21): remembers who opened the file in the `people` root (id, name,
    /// detail, avatar, last seen), so mentions work with nothing but launch tokens. Saved with
    /// the next commit; a visit alone never makes the room dirty.
    async fn note_person(&mut self, grant: &Grant) {
        let now = now_ms();
        let entry = people::people_entry(grant, now);
        let update = {
            let people_map = self.doc.get_or_insert_map(oc_model::roots::PEOPLE);
            let mut txn = self.doc.transact_mut_with("people");
            let old = people_map
                .get(&txn, grant.user.id.as_str())
                .map(|v| oc_model::doc::out_to_json(&txn, &v));
            let same = old.as_ref().is_some_and(|o| {
                let mut a = o.clone();
                let mut b = entry.clone();
                let seen = a["lastSeen"].as_i64().unwrap_or(0);
                if let (Some(a), Some(b)) = (a.as_object_mut(), b.as_object_mut()) {
                    a.remove("lastSeen");
                    b.remove("lastSeen");
                }
                a == b && now - seen < 3_600_000
            });
            if same {
                return;
            }
            let any: yrs::Any = match serde_json::from_value(entry) {
                Ok(a) => a,
                Err(_) => return,
            };
            people_map.insert(&mut txn, grant.user.id.as_str(), any);
            txn.encode_update_v1()
        };
        self.doc_bytes += update.len();
        if !self.wal_append(&update, &grant.user.id).await {
            return;
        }
        self.broadcast(protocol::update(update), None);
    }

    /// Sends `update` to every peer but `except`. Everyone with access sees the same names
    /// (docs/21 revision 2); `user` is stamped from each sender's grant on the way in.
    fn fan_out_awareness(&mut self, update: &AwarenessUpdate, except: Option<ConnId>) {
        let frame = protocol::awareness(update.clone());
        self.broadcast(frame, except);
    }

    /// Everyone's current presence, for one connection.
    fn send_awareness_to(&mut self, conn: ConnId) {
        let Ok(update) = self.awareness.update() else {
            return;
        };
        if update.clients.is_empty() {
            return;
        }
        self.send(conn, protocol::awareness(update));
    }

    fn leave(&mut self, conn: ConnId) {
        let Some(peer) = self.peers.remove(&conn) else {
            return;
        };
        if !peer.clients.is_empty() {
            for c in &peer.clients {
                self.awareness.remove_state(*c);
            }
            if let Ok(update) = self
                .awareness
                .update_with_clients(peer.clients.iter().copied())
            {
                self.fan_out_awareness(&update, None);
            }
        }
        if self.peers.is_empty() {
            self.idle_since = Some(Instant::now());
        }
    }

    /// Host role API (docs/05 §7): switch the role filter live, or disconnect on revoke.
    fn set_role(&mut self, user_id: &str, role: Option<Role>) -> usize {
        if role.is_none() {
            // docs/21 revision 2: the member list changed; open editors refetch it.
            let msg = json!({"t": "members"});
            for (_, p) in self
                .peers
                .iter()
                .filter(|(_, p)| p.grant.user.id != user_id)
            {
                let _ = p.tx.send(Outbound::Frame(protocol::control(&msg).into()));
            }
        }
        let conns: Vec<ConnId> = self
            .peers
            .iter()
            .filter(|(_, p)| p.grant.user.id == user_id)
            .map(|(c, _)| *c)
            .collect();
        for conn in &conns {
            match role {
                None => {
                    if let Some(p) = self.peers.get(conn) {
                        let closed = json!({"t": "closed", "reason": "access revoked"});
                        let _ =
                            p.tx.send(Outbound::Frame(protocol::control(&closed).into()));
                        let _ = p.tx.send(Outbound::Close(1008, "access revoked".into()));
                    }
                    self.leave(*conn);
                }
                Some(role) => {
                    let Some(p) = self.peers.get_mut(conn) else {
                        continue;
                    };
                    let mut grant = (*p.grant).clone();
                    grant.set_role(role);
                    if grant.can_write() && !grant.callback_token.is_empty() {
                        self.callback_token = grant.callback_token.clone();
                    }
                    p.grant = Arc::new(grant);
                    p.denied = false;
                    let msg = json!({"t": "role", "role": role.as_str()});
                    let _ = p.tx.send(Outbound::Frame(protocol::control(&msg).into()));
                }
            }
        }
        if !conns.is_empty() {
            tracing::info!(room = %self.id, connections = conns.len(), role = role.map_or("none", Role::as_str), "role changed by host");
        }
        conns.len()
    }

    async fn frame(&mut self, conn: ConnId, data: &[u8]) {
        let mut decoder = DecoderV1::new(Cursor::new(data));
        let messages: Vec<Message> = match MessageReader::new(&mut decoder).collect() {
            Ok(m) => m,
            Err(e) => {
                tracing::debug!(room = %self.id, conn, error = %e, "undecodable frame dropped");
                return;
            }
        };
        for msg in messages {
            if self.lost.is_some() {
                return;
            }
            match msg {
                Message::Sync(SyncMessage::SyncStep1(sv)) => {
                    let diff = self.doc.transact().encode_state_as_update_v1(&sv);
                    self.send(conn, protocol::step2(diff));
                    self.after_handshake(conn);
                }
                Message::Sync(SyncMessage::SyncStep2(u) | SyncMessage::Update(u)) => {
                    self.apply(conn, u).await
                }
                Message::Awareness(update) => self.on_awareness(conn, update),
                Message::AwarenessQuery => self.send_awareness_to(conn),
                Message::Custom(protocol::MSG_CONTROL, body) => self.on_control(conn, &body),
                Message::Auth(_) | Message::Custom(..) => {}
            }
        }
    }

    /// Client control JSON. Only `{"t":"save"}` (the "Retry now" button) is acted on:
    /// it skips the retry backoff so the next tick saves straight away.
    fn on_control(&mut self, conn: ConnId, body: &[u8]) {
        let wants_save = std::str::from_utf8(body)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .is_some_and(|v| v["t"] == "save");
        let can_write = self.peers.get(&conn).is_some_and(|p| p.grant.can_write());
        if wants_save && can_write && self.dirty_since.is_some() && self.conflict.is_none() {
            self.save.retry_at = None;
            self.dirty_since = Some(Instant::now() - self.ctx.cfg.autosave_max);
        }
    }

    fn after_handshake(&mut self, conn: ConnId) {
        let Some(peer) = self.peers.get_mut(&conn) else {
            return;
        };
        if peer.synced {
            return;
        }
        peer.synced = true;
        let role = json!({"t": "role", "role": peer.grant.role.as_str()});
        let status = if self.save.in_flight {
            json!({"t": "saving"})
        } else {
            self.status.clone()
        };
        self.send(conn, protocol::control(&role));
        self.send(conn, protocol::control(&status));
    }

    fn deny(&mut self, conn: ConnId, reason: &str) {
        Metrics::inc(&self.ctx.metrics.updates_rejected_total);
        let Some(peer) = self.peers.get_mut(&conn) else {
            return;
        };
        if !peer.denied {
            peer.denied = true;
            let _ = peer
                .tx
                .send(Outbound::Frame(protocol::denied(reason).into()));
        }
    }

    async fn apply(&mut self, conn: ConnId, bytes: Vec<u8>) {
        let Some(grant) = self.peers.get(&conn).map(|p| p.grant.clone()) else {
            return;
        };
        let read_only = grant.role != Role::Edit || self.conflict.is_some();
        if read_only && filter::adds_nothing(&self.doc, &bytes) {
            return;
        }
        if self.conflict.is_some() {
            return self.deny(
                conn,
                "the file changed elsewhere; this session is read-only",
            );
        }
        match grant.role {
            Role::View => return self.deny(conn, "read-only session"),
            Role::Comment if !filter::touches_only_comments(&self.doc, &bytes) => {
                return self.deny(conn, "comment role may only change comments");
            }
            _ => {}
        }
        let cap = self.ctx.cfg.max_doc_bytes;
        if self.doc_bytes + bytes.len() > cap {
            self.doc_bytes = encoded_len(&self.doc);
            if self.doc_bytes + bytes.len() > cap {
                tracing::info!(room = %self.id, size = self.doc_bytes, update = bytes.len(), "update refused: document size limit");
                return self.deny(conn, "document size limit reached");
            }
        }
        let Ok(update) = Update::decode_v1(&bytes) else {
            return self.deny(conn, "malformed update");
        };
        let changed = {
            let mut txn = self.doc.transact_mut();
            if txn.apply_update(update).is_err() {
                drop(txn);
                return self.deny(conn, "update could not be applied");
            }
            txn.commit();
            // Out-of-order updates wait in yrs' pending structs and must still be relayed and
            // logged: a delete-only update for items not yet integrated lands in `pending_ds`.
            txn.has_changes()
                || txn.store().pending_update().is_some()
                || txn.store().pending_ds().is_some()
        };
        if !changed {
            return;
        }
        self.accepted(bytes, &grant.user.id, Some(conn)).await;
    }

    /// Appends `update` to the WAL as the next `seq`. False when it is not durable: the room
    /// is then marked lost (closed with 1012 by the run loop) and nothing may be fanned out.
    async fn wal_append(&mut self, update: &[u8], user_id: &str) -> bool {
        if self.lost.is_some() {
            return false;
        }
        self.seq += 1;
        let started = Instant::now();
        let res = self
            .ctx
            .store
            .append_update(&self.id, self.epoch, self.seq, update, user_id, now_ms())
            .await;
        self.ctx
            .metrics
            .wal_append_seconds
            .observe(started.elapsed());
        match res {
            Ok(()) => true,
            Err(e) => {
                self.fail(&e, "WAL append failed");
                false
            }
        }
    }

    /// A persistence write failed for good: a fenced write means another node owns the room
    /// now; any other failure leaves the doc ahead of the WAL. Either way the room must close.
    fn fail(&mut self, e: &anyhow::Error, what: &str) {
        if crate::store::is_fenced(e) {
            tracing::warn!(room = %self.id, epoch = self.epoch, "a newer owner holds the room; this node stops writing");
            self.lost = Some("room moved");
        } else {
            tracing::error!(room = %self.id, error = %e, "{what}; closing the room so clients resync");
            self.lost = Some("storage error");
        }
    }

    /// An update now in the doc: WAL first, then fan-out, then mark the room dirty. False when
    /// the WAL append failed: nothing was fanned out or acknowledged, and the room closes.
    async fn accepted(&mut self, bytes: Vec<u8>, user_id: &str, from: Option<ConnId>) -> bool {
        self.doc_bytes += bytes.len();
        if !self.wal_append(&bytes, user_id).await {
            return false;
        }
        if let Some(m) = self.mentions.as_mut() {
            m.note(&bytes, user_id);
        }
        self.broadcast(protocol::update(bytes), from);
        Metrics::inc(&self.ctx.metrics.updates_total);
        self.last_update = Instant::now();
        self.contributors.insert(user_id.to_string());
        if self.dirty_since.is_none() {
            self.dirty_since = Some(Instant::now());
            if let Err(e) = self
                .ctx
                .store
                .mark_room(
                    &self.id,
                    self.host_version.as_deref(),
                    true,
                    now_ms(),
                    false,
                )
                .await
            {
                tracing::error!(room = %self.id, error = %e, "marking room dirty failed");
            }
        }
        true
    }

    /// Host patch API: ops run on a scratch copy; the resulting update is applied with origin
    /// `api:<author>` and then handled exactly like a client update.
    async fn patch(
        &mut self,
        ops: &[oc_model::patch::PatchOp],
        author: &str,
    ) -> Result<Patched, PatchFailure> {
        if self.conflict.is_some() {
            return Err(PatchFailure::Conflict);
        }
        let out = oc_model::patch::apply_patch(&self.doc, ops, &mut || {
            format!("b_{}", ulid::Ulid::new().to_string().to_lowercase())
        })
        .map_err(PatchFailure::Invalid)?;
        let cap = self.ctx.cfg.max_doc_bytes;
        if self.doc_bytes + out.update.len() > cap {
            self.doc_bytes = encoded_len(&self.doc);
            if self.doc_bytes + out.update.len() > cap {
                tracing::info!(room = %self.id, size = self.doc_bytes, update = out.update.len(), "patch refused: document size limit");
                return Err(PatchFailure::TooLarge);
            }
        }
        let update = Update::decode_v1(&out.update).map_err(|e| {
            PatchFailure::Invalid(oc_model::patch::PatchError::Request(e.to_string()))
        })?;
        let origin = format!("api:{author}");
        let changed = {
            let mut txn = self.doc.transact_mut_with(origin.as_str());
            if let Err(e) = txn.apply_update(update) {
                return Err(PatchFailure::Invalid(oc_model::patch::PatchError::Request(
                    e.to_string(),
                )));
            }
            txn.commit();
            txn.has_changes()
        };
        if changed && !self.accepted(out.update, author, None).await {
            return Err(PatchFailure::Unavailable);
        }
        tracing::info!(room = %self.id, ops = ops.len(), changed, "patch applied by host API");
        Ok(Patched {
            block_ids: out.block_ids,
        })
    }

    /// Host commit API: answers at once when clean, else forces a save and waits for it.
    fn commit(&mut self, reply: tokio::sync::oneshot::Sender<CommitResult>) {
        if self.conflict.is_some() {
            let _ = reply.send(CommitResult::Conflict);
            return;
        }
        if self.dirty_since.is_none() && !self.save.in_flight {
            let _ = reply.send(CommitResult::Clean {
                version: self.host_version.clone(),
            });
            return;
        }
        self.commit_waiters.push((self.seq, reply));
        self.force_save();
    }

    /// Makes the next tick save immediately (skipping debounce and retry backoff).
    fn force_save(&mut self) {
        if self.dirty_since.is_some() {
            self.save.retry_at = None;
            self.dirty_since = Some(Instant::now() - self.ctx.cfg.autosave_max);
        }
    }

    /// Answers commit waiters: those covered by `saved_seq` (all when `None`).
    fn answer_commits(&mut self, saved_seq: Option<i64>, result: &CommitResult) {
        let waiters = std::mem::take(&mut self.commit_waiters);
        for (seq, reply) in waiters {
            if saved_seq.is_none_or(|s| seq <= s) {
                let _ = reply.send(result.clone());
            } else {
                self.commit_waiters.push((seq, reply));
            }
        }
        if !self.commit_waiters.is_empty() {
            self.force_save();
        }
    }

    fn on_awareness(&mut self, conn: ConnId, mut update: AwarenessUpdate) {
        let Some(peer) = self.peers.get(&conn) else {
            return;
        };
        let user = peer.grant.awareness_user();
        let foreign: HashSet<ClientID> = self
            .peers
            .iter()
            .filter(|(id, _)| **id != conn)
            .flat_map(|(_, p)| p.clients.iter().copied())
            .collect();
        let mut owned = Vec::new();
        let mut room_left = MAX_CLIENTS_PER_CONN.saturating_sub(peer.clients.len());
        update.clients.retain(|client, entry| {
            if foreign.contains(client) || entry.json.len() > MAX_AWARENESS_BYTES {
                return false;
            }
            if !peer.clients.contains(client) {
                if room_left == 0 {
                    return false;
                }
                room_left -= 1;
            }
            if let Ok(Value::Object(mut state)) = serde_json::from_str::<Value>(&entry.json) {
                state.insert("user".into(), user.clone());
                entry.json = Value::Object(state).to_string().into();
            }
            owned.push(*client);
            true
        });
        if update.clients.is_empty() {
            return;
        }
        if let Some(peer) = self.peers.get_mut(&conn) {
            peer.clients.extend(owned);
        }
        if self.awareness.apply_update(update.clone()).is_ok() {
            self.fan_out_awareness(&update, Some(conn));
        }
    }

    /// Periodic work; returns true when the room should close.
    async fn tick(&mut self) -> bool {
        let now = Instant::now();
        let ctx = self.ctx.clone();
        let cfg = &ctx.cfg;
        if let Some(since) = self.dirty_since
            && !self.save.in_flight
            && self.conflict.is_none()
            && self.save.retry_at.is_none_or(|t| now >= t)
            && (self.peers.is_empty()
                || now - self.last_update >= cfg.autosave_debounce
                || now - since >= cfg.autosave_max)
        {
            self.start_save().await;
        }
        if let Some(c) = &self.conflict
            && !c.resolved
            && !c.in_flight
            && c.retry_at.is_none_or(|t| now >= t)
        {
            self.start_conflict_task();
        }
        if self.mentions.as_ref().is_some_and(|m| m.has_pending())
            && now - self.last_update >= MENTION_SETTLE
        {
            self.flush_mentions().await;
        }
        if self.seq > self.compacted_seq
            && (self.seq - self.compacted_seq >= cfg.compact_every as i64
                || self.last_compact.elapsed() >= cfg.compact_interval)
        {
            self.compact().await;
        }
        if !self.peers.is_empty() || self.save.in_flight {
            return false;
        }
        match &self.conflict {
            // The copy holds the session's work: close as soon as everyone has left so the
            // next open loads the host's version.
            Some(c) => c.resolved,
            None => {
                self.dirty_since.is_none()
                    && self.idle_since.is_some_and(|t| now - t >= cfg.room_ttl)
            }
        }
    }

    /// Queues new @mentions in `notify_outbox` and sends each once in the background; failures
    /// are retried by the notification sweeper. Never blocks or fails the room.
    async fn flush_mentions(&mut self) {
        let Some(tracker) = self.mentions.as_mut() else {
            return;
        };
        let events = tracker.collect(&self.doc);
        if events.is_empty() || self.callback_token.is_empty() {
            return;
        }
        let now = now_ms();
        for ev in events {
            let row = NotifyRow {
                id: crate::notify::row_id(&self.id, "mention", &ev.key),
                room_id: self.id.clone(),
                host_id: self.host.id.clone(),
                file_id: self.file_id.clone(),
                kind: "mention".into(),
                token: self.callback_token.clone(),
                payload: ev.body(&self.file_id).to_string(),
                attempts: 0,
                // Held for the first attempt below; the sweeper takes over if it fails.
                next_try_at: now + crate::notify::CLAIM_MS,
            };
            match self.ctx.store.notify_insert(&row, now).await {
                Ok(true) => {}
                Ok(false) => continue,
                Err(e) => {
                    tracing::error!(room = %self.id, error = %e, "queueing a mention notification failed");
                    continue;
                }
            }
            tracing::info!(room = %self.id, mentioned = ev.mentioned.len(), "mention notification queued");
            let ctx = self.ctx.clone();
            let host = self.host.clone();
            tokio::spawn(async move {
                crate::notify::attempt(&ctx.store, &ctx.host, &host, &row, now_ms()).await;
            });
        }
    }

    async fn compact(&mut self) {
        let state = self
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        self.doc_bytes = state.len();
        match self
            .ctx
            .store
            .compact(&self.id, self.epoch, self.seq, &state, now_ms())
            .await
        {
            Ok(()) => self.compacted_seq = self.seq,
            Err(e) if crate::store::is_fenced(&e) => self.fail(&e, "compaction failed"),
            Err(e) => tracing::error!(room = %self.id, error = %e, "compaction failed"),
        }
        self.last_compact = Instant::now();
    }

    /// The commit to send: the pending outbox row when it still matches the doc, else a new
    /// one, written to `commit_outbox` before anything goes to the host.
    async fn prepare_save(&mut self) -> Result<Pending, String> {
        if let Some(p) = &self.save.pending
            && p.seq == self.seq
        {
            return Ok(p.clone());
        }
        let id = ulid::Ulid::new().to_string();
        let authors: Vec<String> = self.contributors.iter().cloned().collect();
        let commit = oc_model::CommitInfo {
            id: id.clone(),
            authors: authors.clone(),
            at: rfc3339(now_ms()),
        };
        let body = oc_model::write_ocanvas(&self.doc, &commit).map_err(|e| e.to_string())?;
        let row = OutboxRow {
            id: id.clone(),
            room_id: self.id.clone(),
            host_id: self.host.id.clone(),
            file_id: self.file_id.clone(),
            seq: self.seq,
            base_version: self.host_version.clone(),
            token: self.callback_token.clone(),
            payload: body,
            authors,
            attempts: 0,
            status: "pending".into(),
        };
        // No outbox row, no save: a commit the host may have but the outbox does not know
        // about would break the crash guarantee (docs/22 §8 weakness 5).
        if let Err(e) = self
            .ctx
            .store
            .outbox_insert(&row, self.epoch, now_ms())
            .await
        {
            if crate::store::is_fenced(&e) {
                self.fail(&e, "writing the commit outbox failed");
            }
            return Err(format!("writing the commit outbox failed: {e}"));
        }
        let pending = Pending::from(row);
        self.save.pending = Some(pending.clone());
        Ok(pending)
    }

    async fn start_save(&mut self) {
        let pending = match self.prepare_save().await {
            Ok(p) => p,
            Err(e) => {
                // Loud, and retried with the save backoff (not on every tick).
                tracing::error!(room = %self.id, error = %e, "save not started");
                Metrics::inc(&self.ctx.metrics.save_errors_total);
                let delay = backoff(self.save.attempt);
                self.save.attempt += 1;
                self.save.retry_at = Some(Instant::now() + Duration::from_secs(delay));
                if self.lost.is_none() {
                    self.set_status(
                        json!({"t": "save_error", "retryInMs": delay * 1000, "message": e}),
                    );
                }
                return;
            }
        };
        self.save.in_flight = true;
        self.set_status(json!({"t": "saving"}));
        let payload = self.put_payload(&pending);
        let ctx = self.ctx.clone();
        let tx = self.self_tx.clone();
        tokio::spawn(async move {
            let result = payload.send(&ctx).await;
            let _ = tx.send(Cmd::SaveDone {
                id: pending.id,
                result,
            });
        });
    }

    fn put_payload(&self, p: &Pending) -> PutPayload {
        let token = if self.callback_token.is_empty() {
            p.token.clone()
        } else {
            self.callback_token.clone()
        };
        PutPayload {
            host: self.host.clone(),
            token,
            file_id: self.file_id.clone(),
            if_match: p.if_match.clone(),
            key: p.id.clone(),
            authors: p.authors.clone(),
            body: p.body.clone(),
        }
    }

    async fn save_done(&mut self, id: &str, result: Result<PutOutcome, String>) {
        self.save.in_flight = false;
        let Some(pending) = self.save.pending.clone().filter(|p| p.id == id) else {
            return;
        };
        let store = self.ctx.store.clone();
        match result {
            Ok(PutOutcome::Saved { version }) => {
                Metrics::inc(&self.ctx.metrics.saves_total);
                if let Err(e) = store.outbox_finish(id, "done").await {
                    tracing::error!(room = %self.id, error = %e, "marking commit done failed");
                }
                self.save.pending = None;
                self.host_version = version.or(self.host_version.take());
                self.save.attempt = 0;
                self.save.retry_at = None;
                let clean = self.seq == pending.seq;
                if clean {
                    self.dirty_since = None;
                    self.contributors.clear();
                } else {
                    self.dirty_since = Some(Instant::now());
                }
                if let Err(e) = store
                    .mark_room(
                        &self.id,
                        self.host_version.as_deref(),
                        !clean,
                        now_ms(),
                        true,
                    )
                    .await
                {
                    tracing::error!(room = %self.id, error = %e, "recording save failed");
                }
                tracing::info!(room = %self.id, version = ?self.host_version, "saved to host");
                let version = self.host_version.clone();
                self.answer_commits(Some(pending.seq), &CommitResult::Saved { version });
                self.set_status(
                    json!({"t": "saved", "at": now_ms(), "version": self.host_version}),
                );
            }
            Ok(PutOutcome::Conflict) => {
                Metrics::inc(&self.ctx.metrics.save_conflicts_total);
                let _ = store.outbox_finish(id, "conflict").await;
                self.save.pending = None;
                let policy = self.host.on_conflict();
                tracing::warn!(room = %self.id, ?policy, "host reported a conflict; autosave stopped");
                self.conflict = Some(Conflict {
                    policy,
                    key: ulid::Ulid::new().to_string(),
                    in_flight: false,
                    attempt: 0,
                    retry_at: None,
                    resolved: false,
                });
                self.answer_commits(None, &CommitResult::Conflict);
                self.start_conflict_task();
            }
            Err(message) => {
                Metrics::inc(&self.ctx.metrics.save_errors_total);
                let delay = backoff(self.save.attempt);
                self.save.attempt += 1;
                self.save.retry_at = Some(Instant::now() + Duration::from_secs(delay));
                let next = now_ms() + delay as i64 * 1000;
                if let Err(e) = store.outbox_failed(id, next, &message).await {
                    tracing::error!(room = %self.id, error = %e, "recording failed commit failed");
                }
                tracing::warn!(room = %self.id, error = %message, retry_in = delay, "save failed");
                let queued = CommitResult::Queued {
                    message: message.clone(),
                };
                let waiters = std::mem::take(&mut self.commit_waiters);
                for (_, reply) in waiters {
                    let _ = reply.send(queued.clone());
                }
                self.set_status(
                    json!({"t": "save_error", "retryInMs": delay * 1000, "message": message}),
                );
            }
        }
    }

    /// Runs the host's conflict policy in the background: save a copy, or fetch its version.
    fn start_conflict_task(&mut self) {
        let Some(c) = self.conflict.as_mut() else {
            return;
        };
        c.in_flight = true;
        let (policy, key) = (c.policy, c.key.clone());
        let ctx = self.ctx.clone();
        let host = self.host.clone();
        let token = self.callback_token.clone();
        let file_id = self.file_id.clone();
        let tx = self.self_tx.clone();
        let body = match policy {
            ConflictPolicy::Copy => {
                let commit = oc_model::CommitInfo {
                    id: key.clone(),
                    authors: self.contributors.iter().cloned().collect(),
                    at: rfc3339(now_ms()),
                };
                match oc_model::write_ocanvas(&self.doc, &commit) {
                    Ok(b) => Some(b),
                    Err(e) => {
                        tracing::error!(room = %self.id, error = %e, "building .ocanvas failed");
                        return;
                    }
                }
            }
            ConflictPolicy::Reload => None,
        };
        tokio::spawn(async move {
            let result = match body {
                Some(body) => ctx
                    .host
                    .post_copy(&host, &token, &file_id, body, &key)
                    .await
                    .map(|(file_id, url)| ConflictOutcome::Copied { file_id, url }),
                None => ctx
                    .host
                    .get_file(&host, &token, &file_id)
                    .await
                    .map(ConflictOutcome::Reloaded),
            };
            let _ = tx.send(Cmd::ConflictDone {
                result: result.map_err(|e| e.to_string()),
            });
        });
    }

    async fn conflict_done(&mut self, result: Result<ConflictOutcome, String>) {
        let Some(c) = self.conflict.as_mut() else {
            return;
        };
        c.in_flight = false;
        let outcome = match result {
            Ok(o) => o,
            Err(message) => {
                let delay = backoff(c.attempt);
                c.attempt += 1;
                c.retry_at = Some(Instant::now() + Duration::from_secs(delay));
                tracing::warn!(room = %self.id, error = %message, retry_in = delay, "conflict handling failed");
                self.set_status(
                    json!({"t": "save_error", "retryInMs": delay * 1000, "message": message}),
                );
                return;
            }
        };
        match outcome {
            ConflictOutcome::Copied { file_id, url } => {
                c.resolved = true;
                // The session's work now lives in the copy; nothing is left to save here.
                self.dirty_since = None;
                self.contributors.clear();
                let _ = self
                    .ctx
                    .store
                    .mark_room(
                        &self.id,
                        self.host_version.as_deref(),
                        false,
                        now_ms(),
                        false,
                    )
                    .await;
                tracing::info!(room = %self.id, "conflict: session saved as a copy");
                self.set_status(
                    json!({"t": "conflict", "policy": "copy", "fileId": file_id, "url": url}),
                );
            }
            ConflictOutcome::Reloaded(fetched) => {
                let (doc, etag) = match doc_from_host(&self.id, fetched) {
                    Ok(v) => v,
                    Err(e) => {
                        let delay = backoff(c.attempt);
                        c.attempt += 1;
                        c.retry_at = Some(Instant::now() + Duration::from_secs(delay));
                        tracing::warn!(room = %self.id, error = %e, "host file unreadable on reload");
                        return;
                    }
                };
                self.reset_to(doc, etag).await;
            }
        }
    }

    /// Conflict policy `reload`: replace the room with the host's version and disconnect
    /// everyone so clients reconnect onto it.
    async fn reset_to(&mut self, doc: Doc, version: Option<String>) {
        let store = self.ctx.store.clone();
        if let Err(e) = store.purge_room(&self.id).await {
            tracing::error!(room = %self.id, error = %e, "purge on reload failed");
        }
        if let Err(e) = store
            .put_room(
                &self.id,
                &self.host.id,
                &self.file_id,
                version.as_deref(),
                false,
                now_ms(),
            )
            .await
        {
            tracing::error!(room = %self.id, error = %e, "recording reload failed");
        }
        self.awareness = Awareness::new(doc.clone());
        if self.mentions.is_some() {
            self.mentions = Some(super::mentions::Tracker::new(&doc));
        }
        self.doc_bytes = encoded_len(&doc);
        self.doc = doc;
        self.host_version = version;
        self.dirty_since = None;
        self.contributors.clear();
        self.seq = 0;
        self.compacted_seq = 0;
        self.save = SaveState::default();
        self.conflict = None;
        self.status = json!({"t": "saved", "at": now_ms(), "version": self.host_version});
        let conflict = Bytes::from(protocol::control(
            &json!({"t": "conflict", "policy": "reload"}),
        ));
        let closed = Bytes::from(protocol::control(
            &json!({"t": "closed", "reason": "the file changed elsewhere; reloading"}),
        ));
        for p in self.peers.values() {
            let _ = p.tx.send(Outbound::Frame(conflict.clone()));
            let _ = p.tx.send(Outbound::Frame(closed.clone()));
            let _ = p.tx.send(Outbound::Close(1012, "reload".into()));
        }
        self.peers.clear();
        self.idle_since = Some(Instant::now());
        tracing::info!(room = %self.id, version = ?self.host_version, "conflict: reloaded the host version");
    }

    /// Control `{"t":"reconnect"}` then close 1012 for every peer.
    fn tell_reconnect(&mut self, reason: &str) {
        let frame = Bytes::from(protocol::control(&json!({"t": "reconnect"})));
        for p in self.peers.values() {
            let _ = p.tx.send(Outbound::Frame(frame.clone()));
            let _ = p.tx.send(Outbound::Close(1012, reason.into()));
        }
        self.peers.clear();
    }

    fn step_down(&mut self) {
        tracing::warn!(room = %self.id, seq = self.seq, "room moved to another node");
        self.tell_reconnect("room moved");
    }

    /// SIGTERM or host close: wait for an in-flight save, make a final one if still dirty,
    /// then close peers.
    async fn shutdown(&mut self, rx: &mut mpsc::UnboundedReceiver<Cmd>, by_host: bool) {
        self.flush_mentions().await;
        while self.save.in_flight {
            match tokio::time::timeout(Duration::from_secs(15), rx.recv()).await {
                Ok(Some(Cmd::SaveDone { id, result })) => self.save_done(&id, result).await,
                Ok(Some(_)) => {}
                _ => break,
            }
        }
        if self.dirty_since.is_some()
            && self.conflict.is_none()
            && let Ok(pending) = self.prepare_save().await
        {
            self.set_status(json!({"t": "saving"}));
            let result = self.put_payload(&pending).send(&self.ctx).await;
            self.save_done(&pending.id, result).await;
        }
        if self.seq > self.compacted_seq {
            self.compact().await;
        }
        if by_host {
            let reason = "closed by the host";
            let closed = Bytes::from(protocol::control(&json!({"t": "closed", "reason": reason})));
            for p in self.peers.values() {
                let _ = p.tx.send(Outbound::Frame(closed.clone()));
                let _ = p.tx.send(Outbound::Close(1000, reason.into()));
            }
        } else {
            // Drain (SIGTERM): the work is committed; clients reconnect to another node.
            self.tell_reconnect("server shutting down");
        }
        if self.dirty_since.is_none() {
            let _ = self.ctx.store.purge_room_fenced(&self.id, self.epoch).await;
        }
    }
}

struct PutPayload {
    host: Arc<HostConfig>,
    token: String,
    file_id: String,
    if_match: Option<String>,
    key: String,
    authors: Vec<String>,
    body: Arc<Vec<u8>>,
}

impl PutPayload {
    async fn send(self, ctx: &Ctx) -> Result<PutOutcome, String> {
        let req = PutRequest {
            file_id: &self.file_id,
            body: self.body.as_ref().clone(),
            if_match: self.if_match.as_deref(),
            idempotency_key: &self.key,
            authors: &self.authors,
        };
        ctx.host
            .put_file(&self.host, &self.token, req)
            .await
            .map_err(|e| e.to_string())
    }
}
