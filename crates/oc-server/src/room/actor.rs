// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The room actor: owns the Y.Doc, peers, WAL, autosave and awareness for one file.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use anyhow::Context;
use bytes::Bytes;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use yrs::encoding::read::Cursor;
use yrs::sync::awareness::AwarenessUpdateEntry;
use yrs::sync::protocol::MessageReader;
use yrs::sync::{Awareness, AwarenessUpdate, Message, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::{ClientID, Doc, Map, ReadTxn, StateVector, Transact, Update};

use super::{
    Cmd, CommitResult, ConflictOutcome, ConnId, Ctx, Outbound, PatchFailure, Patched, RoomInfo,
    Rooms, filter, presence, protocol,
};
use crate::grant::{Grant, Role};
use crate::host_client::{Fetched, HostError, PutOutcome, PutRequest};
use crate::hosts::{ConflictPolicy, HostConfig};
use crate::metrics::Metrics;
use crate::people;
use crate::store::{NotifyRow, OutboxRow, WalRow};
use crate::util::{now_ms, rfc3339};
use reqwest::StatusCode;

const BACKOFF_SECS: [u64; 4] = [1, 2, 5, 10];
const MAX_AWARENESS_BYTES: usize = 2048;
/// Connections per room (docs/07 §3: 50 editors + 500 viewers). Later joins are closed
/// with 1013 "room full".
pub const MAX_PEERS: usize = 550;
/// Awareness client ids one connection may own (one per Y.Doc; a few for tabs/reconnects).
const MAX_CLIENTS_PER_CONN: usize = 8;
/// Outbound tick (docs/22 §9.3): a room writes its WAL batch and sends one merged update frame
/// and one presence frame at most this often, so a peer gets ≤ 25 + 25 frames/s however many
/// people type. Edit latency is bounded by about this plus the WAL commit.
const OUT_TICK: Duration = Duration::from_millis(40);
/// A busy room writes its WAL batch after this many queued updates, even if more frames wait.
const WAL_BATCH: usize = 256;
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
    /// Which connection owns each awareness client id (kept in step with `Peer::clients`).
    owners: HashMap<ClientID, ConnId>,
    /// Stamped awareness waiting for the next fan-out (latest per client).
    presence: presence::Coalescer,
    /// Awareness frames since the last fan-out.
    presence_frames: usize,
    inbox: Arc<presence::Inbox>,
    host_version: Option<String>,
    dirty_since: Option<Instant>,
    last_update: Instant,
    contributors: BTreeSet<String>,
    callback_token: String,
    /// Callback tokens of grants the host revoked (or downgraded to view) in this room: never
    /// used for a save again (PERM-05), even when a pending outbox row still carries one.
    revoked_tokens: HashSet<String>,
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
    /// Updates applied to the doc and waiting for the next WAL batch (docs/22 §9.3): not yet
    /// durable, so not yet fanned out, and flushed before anything reads the doc's state.
    wal_queue: Vec<Queued>,
    /// When the queued updates and presence go out (armed by the first one, `OUT_TICK` later).
    flush_at: Option<tokio::time::Instant>,
    /// Every update queued since the last flush integrated in order (none left pending).
    batch_in_order: bool,
    /// Memory durability (ADR-029): no per-update WAL write; the state is dumped instead.
    memory: bool,
    /// A background dump is running (memory durability).
    dump_in_flight: bool,
    /// Per-run undo managers by origin `ai:<runId>` (in memory; lost with the node).
    ai_undo: HashMap<String, yrs::UndoManager>,
    /// Agent presence: awareness client id and clock per run.
    ai_presence: HashMap<String, (ClientID, u32)>,
    /// `storage = "ephemeral"` (ADR-043): never loaded from or saved to the host; destroyed
    /// when the room closes.
    ephemeral: bool,
}

/// What clients of an ephemeral room are told when it ends (ADR-043).
pub const EPHEMERAL_CLOSED: &str = "This canvas ended with the meeting";

/// An update applied to the doc, waiting for its WAL batch.
struct Queued {
    seq: i64,
    bytes: Vec<u8>,
    user_id: String,
    /// The sender, who does not get its own update back.
    from: Option<ConnId>,
    /// An edit (makes the room dirty, counts as a contribution); false for the `people` entry.
    edit: bool,
}

/// The room task's channels: its own sender (for timers), its command queue and the
/// shared inbox that bounds it.
pub(super) struct Channels {
    pub self_tx: mpsc::UnboundedSender<Cmd>,
    pub rx: mpsc::UnboundedReceiver<Cmd>,
    pub inbox: Arc<presence::Inbox>,
}

pub(super) async fn run(
    ctx: Arc<Ctx>,
    rooms: Weak<Rooms>,
    generation: u64,
    host: Arc<HostConfig>,
    seed: Grant,
    chans: Channels,
) {
    let Channels {
        self_tx,
        mut rx,
        inbox,
    } = chans;
    let id = seed.room.clone();
    let mut room = match Room::load(ctx.clone(), host, &seed, self_tx, inbox).await {
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
                None => {
                    room.flush_wal().await;
                    break End::Idle;
                }
                Some(Cmd::Shutdown { by_host, reply }) => {
                    room.flush_wal().await;
                    break End::Shutdown(by_host, reply);
                }
                // Another node owns the room: whatever is queued is not written (clients resend).
                Some(Cmd::StepDown) => break End::StepDown,
                Some(cmd) => {
                    room.handle(cmd).await;
                    // A full batch is written at once; otherwise the outbound tick does it.
                    if room.wal_batch_full() {
                        room.flush_wal().await;
                    }
                    // The first queued update or presence arms the outbound tick (docs/22 §9.3).
                    if room.flush_at.is_none() && room.has_outbound() {
                        room.flush_at = Some(tokio::time::Instant::now() + OUT_TICK);
                    }
                }
            },
            // Outbound tick: one durable WAL batch, then one merged update frame and one
            // presence frame shared by every peer, at most once per OUT_TICK.
            _ = tokio::time::sleep_until(room.flush_at.unwrap_or_else(tokio::time::Instant::now)),
                if room.flush_at.is_some() => {
                room.flush_at = None;
                room.flush_wal().await;
                room.flush_awareness();
            }
            _ = tick.tick() => {
                room.flush_wal().await;
                room.flush_awareness();
                if room.tick().await { break End::Idle }
            }
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
        End::Idle if room.ephemeral => {
            room.destroy().await;
            if let Some(r) = rooms.upgrade() {
                r.remove(&id, generation);
            }
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
    // Free the doc here and hand the memory back (docs/22 §9.6).
    drop(room);
    crate::alloc::room_closed();
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
            let doc = if let Some(json) = bytes.strip_prefix(crate::hosts::TEMPLATE_JSON_TAG) {
                // ADR-043: a built-in template named in the host's config.
                let doc = oc_model::new_doc();
                oc_model::import::apply_document_json(&doc, &serde_json::from_slice(json)?);
                doc
            } else if oc_model::ocanvas::is_zip(&bytes) {
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
        inbox: Arc<presence::Inbox>,
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
            let fetched = if host.ephemeral() {
                // ADR-043: no load callback; a new canvas, or the host's template.
                match &host.template_bytes {
                    Some(b) => Fetched::Found {
                        bytes: b.as_ref().clone().into(),
                        content_type: String::new(),
                        etag: None,
                    },
                    None => Fetched::Missing,
                }
            } else {
                ctx.host
                    .get_file(&host, &seed.callback_token, &seed.file.id)
                    .await?
            };
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
        let status = if host.ephemeral() {
            json!({"t": "temporary"})
        } else {
            json!({"t": "saved", "at": now_ms(), "version": host_version})
        };
        let ephemeral = host.ephemeral();
        let mentions = crate::notify::enabled(&host, &seed.file.id)
            .then(|| super::mentions::Tracker::new(&doc));
        Ok(Self {
            mentions,
            awareness: Awareness::new(doc.clone()),
            owners: HashMap::new(),
            presence: presence::Coalescer::default(),
            presence_frames: 0,
            inbox,
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
            revoked_tokens: HashSet::new(),
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
            wal_queue: Vec::new(),
            flush_at: None,
            batch_in_order: true,
            memory: ctx.cfg.durability == crate::config::Durability::Memory
                && ctx.store.redis_wal().is_none(),
            dump_in_flight: false,
            ai_undo: HashMap::new(),
            ai_presence: HashMap::new(),
            ephemeral,
            ctx,
        })
    }

    async fn handle(&mut self, cmd: Cmd) {
        // Only Yjs frames join a WAL batch. Everything else (joins, state reads, patches,
        // saves, commits) sees durable state only.
        if !matches!(cmd, Cmd::Frame { .. }) {
            self.flush_wal().await;
        }
        match cmd {
            Cmd::Join {
                conn,
                grant,
                tx,
                reply,
            } => self.join(conn, grant, tx, reply).await,
            Cmd::Leave { conn } => self.leave(conn),
            Cmd::Frame { conn, data, permit } => {
                self.frame(conn, &data).await;
                drop(permit);
            }
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
            Cmd::Dumped { seq, result } => self.dumped(seq, result),
            Cmd::SetRole {
                user_id,
                role,
                reply,
            } => {
                let _ = reply.send(self.set_role(&user_id, role));
                // A pending row that carries a revoked grant is rewritten now, so a restart's
                // outbox resume never sends it (PERM-05).
                if !self.save.in_flight
                    && self
                        .save
                        .pending
                        .as_ref()
                        .is_some_and(|p| self.revoked_tokens.contains(&p.token))
                    && let Err(e) = self.prepare_save().await
                {
                    tracing::warn!(room = %self.id, error = %e, "rewriting the pending commit failed");
                }
            }
            Cmd::Patch { ops, author, reply } => {
                let _ = reply.send(self.patch(&ops, &author).await);
            }
            Cmd::Tool {
                run,
                origin,
                author,
                reply,
            } => {
                let _ = reply.send(self.tool(run, &origin, &author).await);
            }
            Cmd::Commit { reply } => self.commit(reply),
            Cmd::AiRole { user_id, reply } => {
                let role = self
                    .peers
                    .values()
                    .filter(|p| p.grant.user.id == user_id)
                    .map(|p| p.grant.role)
                    .max_by_key(|r| *r as u8);
                let _ = reply.send(role);
            }
            Cmd::AiPresence {
                run_id,
                block_id,
                active,
            } => self.ai_presence(&run_id, block_id.as_deref(), active),
            Cmd::AiTrack { origin } => self.ai_track(&origin),
            Cmd::AiUndo { origin, reply } => {
                let _ = reply.send(self.ai_undo(&origin).await);
            }
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
            self.revoked_tokens.remove(&grant.callback_token);
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
        // Logged and fanned out with the next WAL batch; a visit alone never makes the room
        // dirty.
        self.queue(update, &grant.user.id, None, false);
    }

    /// Sends `update` to every peer but `except`. Everyone with access sees the same names
    /// (docs/21 revision 2); `user` is stamped from each sender's grant on the way in, so one
    /// encoded frame serves every peer.
    fn fan_out_awareness(&mut self, update: AwarenessUpdate, except: Option<ConnId>) {
        Metrics::inc(&self.ctx.metrics.awareness_broadcasts_total);
        self.broadcast(protocol::awareness(update), except);
    }

    /// Applies the queued presence (and any frames parked while the inbox was full) and fans
    /// it out as one frame.
    fn flush_awareness(&mut self) {
        self.presence_frames = 0;
        if self.inbox.has_parked() {
            for (conn, data) in self.inbox.take_parked() {
                Metrics::inc(&self.ctx.metrics.awareness_coalesced_total);
                let mut decoder = DecoderV1::new(Cursor::new(&data));
                for msg in MessageReader::new(&mut decoder).flatten() {
                    if let Message::Awareness(update) = msg {
                        self.on_awareness(conn, update);
                    }
                }
            }
        }
        let Some((update, except)) = self.presence.take() else {
            return;
        };
        if self.awareness.apply_update(update.clone()).is_ok() {
            self.fan_out_awareness(update, except);
        }
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
        self.inbox.forget(conn);
        // A run never outlives its requester's last connection (docs/24 §10.5).
        if let Some(rt) = &self.ctx.ai
            && !self
                .peers
                .values()
                .any(|p| p.grant.user.id == peer.grant.user.id)
        {
            rt.cancel_all(&self.id, Some(&peer.grant.user.id));
        }
        if !peer.clients.is_empty() {
            self.presence.forget(peer.clients.iter().copied());
            for c in &peer.clients {
                self.owners.remove(c);
                self.awareness.remove_state(*c);
            }
            if let Ok(update) = self
                .awareness
                .update_with_clients(peer.clients.iter().copied())
            {
                self.fan_out_awareness(update, None);
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
                        self.revoked_tokens.insert(p.grant.callback_token.clone());
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
                    if grant.can_write() {
                        self.revoked_tokens.remove(&grant.callback_token);
                        if !grant.callback_token.is_empty() {
                            self.callback_token = grant.callback_token.clone();
                        }
                    } else {
                        self.revoked_tokens.insert(grant.callback_token.clone());
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
        self.revoked_tokens.remove("");
        if self.revoked_tokens.contains(&self.callback_token) {
            self.callback_token = self
                .save_tokens(None)
                .into_iter()
                .next()
                .unwrap_or_default();
        }
        conns.len()
    }

    /// Callback tokens a save may use, best first (PERM-05): connected editors (the room's
    /// token first among them), then connected commenters, then the room's token and the
    /// pending row's own. Revoked grants never appear; the host's 401/403 on one moves the
    /// save to the next.
    fn save_tokens(&self, pending: Option<&Pending>) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut push = |t: &str| {
            if !t.is_empty() && !self.revoked_tokens.contains(t) && !out.iter().any(|o| o == t) {
                out.push(t.to_string());
            }
        };
        let connected = |role: Role| {
            self.peers
                .values()
                .filter(move |p| p.grant.role == role)
                .map(|p| p.grant.callback_token.as_str())
        };
        if connected(Role::Edit).any(|t| t == self.callback_token) {
            push(&self.callback_token);
        }
        let mut editors: Vec<&str> = connected(Role::Edit).collect();
        editors.sort_unstable();
        let mut commenters: Vec<&str> = connected(Role::Comment).collect();
        commenters.sort_unstable();
        for t in editors.into_iter().chain(commenters) {
            push(t);
        }
        push(&self.callback_token);
        if let Some(p) = pending {
            push(&p.token);
        }
        out
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
                    // The answer must not carry updates that are not durable yet.
                    if !self.flush_wal().await {
                        return;
                    }
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
        let msg = std::str::from_utf8(body)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or(Value::Null);
        if matches!(
            msg["t"].as_str(),
            Some("ai-run" | "ai-cancel" | "ai-approve" | "ai-undo")
        ) {
            self.on_ai_control(conn, &msg);
            return;
        }
        let wants_save = msg["t"] == "save";
        let can_write = self.peers.get(&conn).is_some_and(|p| p.grant.can_write());
        if wants_save && can_write && self.dirty_since.is_some() && self.conflict.is_none() {
            self.save.retry_at = None;
            self.dirty_since = Some(Instant::now() - self.ctx.cfg.autosave_max);
        }
    }

    /// `ai-run`, `ai-cancel`, `ai-approve`, `ai-undo` (docs/15, docs/24 §10.5). Replies go to `conn` only.
    fn on_ai_control(&mut self, conn: ConnId, msg: &Value) {
        let Some(peer) = self.peers.get(&conn) else {
            return;
        };
        let grant = (*peer.grant).clone();
        let out = peer.tx.clone();
        let reply = |v: Value| {
            let _ = out.send(Outbound::Frame(protocol::control(&v).into()));
        };
        let run_id = msg["runId"].as_str().unwrap_or_default().to_string();
        let Some(rt) = self.ctx.ai.clone() else {
            // AI is off server-wide (docs/24 §7.3).
            reply(json!({"t":"ai-done","runId":run_id,"outcome":"refused","reason":"ai_disabled"}));
            return;
        };
        let Some(host_ai) = crate::ai::HostAi(&self.host).agent() else {
            reply(
                json!({"t":"ai-done","runId":run_id,"outcome":"refused","reason":"AI is not enabled for this host"}),
            );
            return;
        };
        let (emit, mut rx) = mpsc::unbounded_channel::<Value>();
        let fwd = out.clone();
        tokio::spawn(async move {
            while let Some(v) = rx.recv().await {
                if fwd
                    .send(Outbound::Frame(protocol::control(&v).into()))
                    .is_err()
                {
                    break;
                }
            }
        });
        let env = crate::ai::agent::RunEnv {
            room_id: self.id.clone(),
            host_ai,
            port: Arc::new(crate::ai::agent_room::ActorPort {
                tx: self.self_tx.clone(),
            }),
            audit: Arc::new(crate::ai::agent_room::OutboxAudit {
                ctx: self.ctx.clone(),
                host: self.host.clone(),
                room: self.id.clone(),
                file_id: self.file_id.clone(),
                token: self.callback_token.clone(),
                seq: Default::default(),
            }),
            grant,
            emit,
        };
        match msg["t"].as_str() {
            Some("ai-run") => match crate::ai::agent::RunRequest::from_control(msg) {
                Some(req) => {
                    let _ = rt.start(env, req);
                }
                None => reply(
                    json!({"t":"ai-done","runId":run_id,"outcome":"refused","reason":"bad request"}),
                ),
            },
            Some("ai-cancel") => {
                rt.cancel(&self.id, &run_id, &env.grant.user.id);
            }
            Some("ai-approve") => {
                rt.approve(&self.id, &run_id, &env.grant.user.id);
            }
            _ => {
                tokio::spawn(async move {
                    if let Err(e) = rt.undo(&env, &run_id).await {
                        let _ = env.emit.send(
                            json!({"t":"ai-done","runId":run_id,"outcome":"error","reason":e}),
                        );
                    }
                });
            }
        }
    }

    /// Starts an undo manager over every root for transactions with `origin`.
    fn ai_track(&mut self, origin: &str) {
        let mut mgr = yrs::UndoManager::with_options(yrs::undo::Options::default());
        let content = self
            .doc
            .get_or_insert_xml_fragment(oc_model::roots::CONTENT);
        mgr.expand_scope(&self.doc, &content);
        for name in oc_model::roots::MAPS {
            let map = self.doc.get_or_insert_map(name);
            mgr.expand_scope(&self.doc, &map);
        }
        mgr.include_origin(origin);
        self.ai_undo.insert(origin.to_string(), mgr);
    }

    /// Reverts a run: undoes every tracked change with `origin` and ships the result like a
    /// client update (WAL, fan-out, autosave).
    async fn ai_undo(&mut self, origin: &str) -> Result<(), String> {
        let Some(mut mgr) = self.ai_undo.remove(origin) else {
            return Err("nothing to undo".into());
        };
        let before = self.doc.transact().state_vector();
        // An undo of inserts only deletes, which leaves the state vector as it was: track
        // whether anything was undone instead of comparing state vectors.
        let mut undone = false;
        while mgr.undo_blocking() {
            undone = true;
        }
        drop(mgr);
        let update = self.doc.transact().encode_state_as_update_v1(&before);
        if undone {
            self.queue(update, origin, None, true);
            if !self.flush_wal().await {
                return Err("storage unavailable".into());
            }
        }
        Ok(())
    }

    /// Server-side agent presence: an awareness entry with the agent identity and a cursor
    /// at the last touched block (docs/24 §6.1).
    fn ai_presence(&mut self, run_id: &str, block_id: Option<&str>, active: bool) {
        let (client, clock) = match self.ai_presence.get(run_id) {
            Some((c, k)) => (*c, k + 1),
            None => {
                let h = <sha2::Sha256 as sha2::Digest>::digest(
                    format!("{}:{run_id}", self.id).as_bytes(),
                );
                let c = ClientID::new(u64::from(
                    u32::from_le_bytes([h[0], h[1], h[2], h[3]]) | (1 << 31),
                ));
                (c, 1)
            }
        };
        let json: Arc<str> = if active {
            json!({
                "user": {"id": format!("ai:{run_id}"), "name": "Assistant", "color": "#7a45f0", "agent": true},
                "cursor": block_id.map(|b| json!({"blockId": b})),
            })
            .to_string()
            .into()
        } else {
            Arc::from("null")
        };
        if active {
            self.ai_presence.insert(run_id.to_string(), (client, clock));
        } else {
            self.ai_presence.remove(run_id);
        }
        let update = AwarenessUpdate {
            clients: [(client, AwarenessUpdateEntry { clock, json })].into(),
        };
        let _ = self.awareness.apply_update(update.clone());
        self.fan_out_awareness(update, None);
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
            let was_pending =
                txn.store().pending_update().is_some() || txn.store().pending_ds().is_some();
            if txn.apply_update(update).is_err() {
                drop(txn);
                return self.deny(conn, "update could not be applied");
            }
            txn.commit();
            let pending =
                txn.store().pending_update().is_some() || txn.store().pending_ds().is_some();
            // A batch is merged into one frame only if every update in it integrated in order
            // (no gaps): merging updates with gaps loses structs (seen in tests/fuzz.rs).
            if was_pending || pending {
                self.batch_in_order = false;
            }
            // Out-of-order updates wait in yrs' pending structs and must still be relayed and
            // logged: a delete-only update for items not yet integrated lands in `pending_ds`.
            txn.has_changes() || pending
        };
        if !changed {
            return;
        }
        self.queue(bytes, &grant.user.id, Some(conn), true);
    }

    /// An update now in the doc: queued for the next WAL batch as the next `seq`. Nothing is
    /// fanned out or acknowledged until [`Room::flush_wal`] has made it durable.
    fn queue(&mut self, bytes: Vec<u8>, user_id: &str, from: Option<ConnId>, edit: bool) {
        if self.lost.is_some() {
            return;
        }
        self.doc_bytes += bytes.len();
        self.seq += 1;
        self.wal_queue.push(Queued {
            seq: self.seq,
            bytes,
            user_id: user_id.to_string(),
            from,
            edit,
        });
    }

    /// Updates or presence waiting for the outbound tick.
    pub(super) fn has_outbound(&self) -> bool {
        !self.wal_queue.is_empty() || !self.presence.is_empty() || self.inbox.has_parked()
    }

    /// True when the batch should be written before taking more frames.
    pub(super) fn wal_batch_full(&self) -> bool {
        self.wal_queue.len() >= WAL_BATCH
    }

    /// Writes every queued update to the WAL in one batch (one transaction, epoch-guarded),
    /// then fans each out in `seq` order and marks the room dirty. False when the batch is not
    /// durable: the room is marked lost (closed with 1012 by the run loop), nothing of the
    /// batch is fanned out, and later queued updates are dropped with it.
    async fn flush_wal(&mut self) -> bool {
        if self.lost.is_some() {
            self.wal_queue.clear();
            return false;
        }
        if self.wal_queue.is_empty() {
            return true;
        }
        let batch = std::mem::take(&mut self.wal_queue);
        let at = now_ms();
        let rows = if self.memory {
            Vec::new()
        } else {
            batch
                .iter()
                .map(|q| WalRow {
                    seq: q.seq,
                    data: q.bytes.clone(),
                    origin: q.user_id.clone(),
                    at,
                })
                .collect::<Vec<_>>()
        };
        if self.dirty_since.is_none() && batch.iter().any(|q| q.edit) && !self.mark_dirty().await {
            return false;
        }
        // Memory durability (ADR-029): acknowledged after the in-memory apply; the periodic
        // dump makes it durable.
        if !self.memory {
            let started = Instant::now();
            let res = self
                .ctx
                .store
                .append_updates(&self.id, self.epoch, rows)
                .await;
            let m = &self.ctx.metrics;
            m.wal_append_seconds.observe(started.elapsed());
            Metrics::inc(&m.wal_batches_total);
            m.wal_rows_total
                .fetch_add(batch.len() as i64, std::sync::atomic::Ordering::Relaxed);
            if let Err(e) = res {
                self.fail(&e, "WAL append failed");
                return false;
            }
        }
        let mut edited = false;
        // The sender does not get its own update back; with several senders in one batch the
        // merged frame goes to everyone (Yjs ignores structs it already has).
        let first = batch[0].from;
        let except = first.filter(|_| batch.iter().all(|q| q.from == first));
        for q in &batch {
            if q.edit {
                if let Some(m) = self.mentions.as_mut() {
                    m.note(&q.bytes, &q.user_id);
                }
                Metrics::inc(&self.ctx.metrics.updates_total);
                self.contributors.insert(q.user_id.clone());
                edited = true;
            }
        }
        // One frame for the whole batch, shared by every peer (docs/22 §9.3).
        let in_order = std::mem::replace(&mut self.batch_in_order, true);
        let merged = if !in_order {
            Err((None, batch))
        } else if batch.len() == 1 {
            Ok(batch
                .into_iter()
                .next()
                .map(|q| q.bytes)
                .unwrap_or_default())
        } else {
            yrs::merge_updates_v1(batch.iter().map(|q| q.bytes.as_slice()))
                .map_err(|e| (Some(e), batch))
        };
        match merged {
            Ok(update) => self.broadcast(protocol::update(update), except),
            Err((e, batch)) => {
                if let Some(e) = e {
                    tracing::warn!(room = %self.id, error = %e, "merging a batch failed; sending it update by update");
                }
                for q in batch {
                    self.broadcast(protocol::update(q.bytes), q.from);
                }
            }
        }
        if edited {
            self.accepted().await;
        }
        true
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

    /// Edits of a durable batch were fanned out: the room is dirty.
    async fn accepted(&mut self) {
        self.last_update = Instant::now();
    }

    /// The room row is marked dirty before the first edit of a clean room is appended, so a
    /// restart always replays the WAL (a clean row is purged on load, Redis stream included).
    async fn mark_dirty(&mut self) -> bool {
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
            self.fail(&e, "marking room dirty failed");
            return false;
        }
        self.dirty_since = Some(Instant::now());
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
        let changed = self
            .apply_server_update(out.update, &format!("api:{author}"), author)
            .await?;
        tracing::info!(room = %self.id, ops = ops.len(), changed, "patch applied by host API");
        Ok(Patched {
            block_ids: out.block_ids,
        })
    }

    /// Applies an update made by the server (patch API, canvas tools) with `origin`, then logs
    /// and broadcasts it like a client update. Returns whether the doc changed.
    async fn apply_server_update(
        &mut self,
        update: Vec<u8>,
        origin: &str,
        author: &str,
    ) -> Result<bool, PatchFailure> {
        let cap = self.ctx.cfg.max_doc_bytes;
        if self.doc_bytes + update.len() > cap {
            self.doc_bytes = encoded_len(&self.doc);
            if self.doc_bytes + update.len() > cap {
                tracing::info!(room = %self.id, size = self.doc_bytes, update = update.len(), "server edit refused: document size limit");
                return Err(PatchFailure::TooLarge);
            }
        }
        let decoded = Update::decode_v1(&update).map_err(|e| {
            PatchFailure::Invalid(oc_model::patch::PatchError::Request(e.to_string()))
        })?;
        let changed = {
            let mut txn = self.doc.transact_mut_with(origin);
            if let Err(e) = txn.apply_update(decoded) {
                return Err(PatchFailure::Invalid(oc_model::patch::PatchError::Request(
                    e.to_string(),
                )));
            }
            txn.commit();
            txn.has_changes()
        };
        if changed {
            self.queue(update, author, None, true);
            if !self.flush_wal().await {
                return Err(PatchFailure::Unavailable);
            }
        }
        Ok(changed)
    }

    /// Canvas tool step (docs/24 §5): runs against the live doc; a resulting update is one
    /// transaction with the tool's origin (`ai:<runId>` / `mcp:<clientId>`).
    async fn tool(
        &mut self,
        run: super::ToolFn,
        origin: &str,
        author: &str,
    ) -> Result<Value, crate::ai::tools::ToolError> {
        use crate::ai::tools::ToolError;
        let (update, answer) = run(&self.doc)?;
        let Some(update) = update.filter(|u| !u.is_empty()) else {
            return Ok(answer);
        };
        if self.conflict.is_some() {
            return Err(ToolError::Internal(
                "CONFLICT: the room is handling a save conflict and is read-only".into(),
            ));
        }
        match self.apply_server_update(update, origin, author).await {
            Ok(_) => Ok(answer),
            Err(PatchFailure::TooLarge) => Err(ToolError::BadInput(
                "DOC_TOO_LARGE: the change would exceed the document size limit".into(),
            )),
            Err(PatchFailure::Invalid(e)) => Err(ToolError::Internal(e.to_string())),
            Err(PatchFailure::Conflict) => Err(ToolError::Internal("CONFLICT".into())),
            Err(PatchFailure::Unavailable) => Err(ToolError::Internal(
                "the change could not be stored; retry".into(),
            )),
        }
    }

    /// Host commit API: answers at once when clean, else forces a save and waits for it.
    fn commit(&mut self, reply: tokio::sync::oneshot::Sender<CommitResult>) {
        if self.ephemeral {
            // Nothing is ever saved to the host (ADR-043).
            let _ = reply.send(CommitResult::Clean { version: None });
            return;
        }
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

    /// Stamps each entry once with the sender's grant (docs/06 §2) and queues it; the next
    /// [`flush_awareness`](Self::flush_awareness) fans everything out as one frame.
    fn on_awareness(&mut self, conn: ConnId, update: AwarenessUpdate) {
        let Some(peer) = self.peers.get_mut(&conn) else {
            return;
        };
        self.presence_frames += 1;
        let user = peer.grant.awareness_user();
        let mut room_left = MAX_CLIENTS_PER_CONN.saturating_sub(peer.clients.len());
        for (client, entry) in update.clients {
            if entry.json.len() > MAX_AWARENESS_BYTES {
                continue;
            }
            match self.owners.get(&client) {
                Some(owner) if *owner != conn => continue,
                Some(_) => {}
                None if room_left == 0 => continue,
                None => {
                    room_left -= 1;
                    self.owners.insert(client, conn);
                    peer.clients.insert(client);
                }
            }
            let json = presence::stamp(&entry.json, &user);
            self.presence.push(
                conn,
                client,
                AwarenessUpdateEntry {
                    clock: entry.clock,
                    json,
                },
            );
        }
        if self.presence.len() >= presence::MAX_PENDING_CLIENTS {
            self.flush_awareness();
        }
    }

    /// Periodic work; returns true when the room should close.
    async fn tick(&mut self) -> bool {
        let now = Instant::now();
        let ctx = self.ctx.clone();
        let cfg = &ctx.cfg;
        if let Some(since) = self.dirty_since
            && !self.ephemeral
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
            && (self.seq - self.compacted_seq >= cfg.compact_every.min(i64::MAX as u64) as i64
                || self.last_compact.elapsed() >= cfg.compact_interval)
        {
            if self.memory {
                self.start_dump();
            } else {
                self.compact().await;
            }
        }
        if !self.peers.is_empty() || self.save.in_flight {
            return false;
        }
        match &self.conflict {
            // The copy holds the session's work: close as soon as everyone has left so the
            // next open loads the host's version.
            Some(c) => c.resolved,
            None => {
                (self.ephemeral || self.dirty_since.is_none())
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

    /// Memory durability: encodes the state here and writes it (epoch-fenced) in the
    /// background, so the room keeps serving while the database works.
    fn start_dump(&mut self) {
        if self.dump_in_flight {
            return;
        }
        self.dump_in_flight = true;
        self.last_compact = Instant::now();
        let state = self
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        self.doc_bytes = state.len();
        let (ctx, id, epoch, seq, tx) = (
            self.ctx.clone(),
            self.id.clone(),
            self.epoch,
            self.seq,
            self.self_tx.clone(),
        );
        tokio::spawn(async move {
            let started = Instant::now();
            let result = ctx
                .store
                .compact(&id, epoch, seq, &state, now_ms())
                .await
                .map_err(|e| {
                    if crate::store::is_fenced(&e) {
                        super::DumpError::Fenced(e)
                    } else {
                        super::DumpError::Other(e.to_string())
                    }
                });
            ctx.metrics.wal_append_seconds.observe(started.elapsed());
            let _ = tx.send(Cmd::Dumped { seq, result });
        });
    }

    fn dumped(&mut self, seq: i64, result: Result<(), super::DumpError>) {
        self.dump_in_flight = false;
        match result {
            Ok(()) => self.compacted_seq = self.compacted_seq.max(seq),
            Err(super::DumpError::Fenced(e)) => self.fail(&e, "state dump failed"),
            Err(super::DumpError::Other(e)) => {
                tracing::error!(room = %self.id, error = %e, "state dump failed")
            }
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
            if !self.revoked_tokens.contains(&p.token) {
                return Ok(p.clone());
            }
            // The row was written with a grant that has since been revoked: replace it with
            // one carrying a current editor's token (so a restart's resume cannot use it).
            if let Err(e) = self.ctx.store.outbox_finish(&p.id, "superseded").await {
                return Err(format!("replacing the commit outbox row failed: {e}"));
            }
            self.save.pending = None;
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
            token: self
                .save_tokens(None)
                .into_iter()
                .next()
                .unwrap_or_default(),
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
        // Memory durability: the database holds this state before the host is asked to.
        if self.memory && self.seq > self.compacted_seq {
            self.compact().await;
            if self.lost.is_some() {
                return;
            }
        }
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
        PutPayload {
            host: self.host.clone(),
            tokens: self.save_tokens(Some(p)),
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

    /// Ephemeral storage (ADR-043): deletes everything the room left in storage.
    async fn destroy(&mut self) {
        match self
            .ctx
            .store
            .destroy_room(&self.id, Some(self.epoch))
            .await
        {
            Ok(()) => tracing::info!(room = %self.id, "ephemeral canvas destroyed"),
            Err(e) if crate::store::is_fenced(&e) => {
                tracing::warn!(room = %self.id, "room taken by a newer owner; not destroyed")
            }
            Err(e) => tracing::error!(room = %self.id, error = %e, "destroying the room failed"),
        }
    }

    fn step_down(&mut self) {
        tracing::warn!(room = %self.id, seq = self.seq, "room moved to another node");
        self.tell_reconnect("room moved");
    }

    /// SIGTERM or host close: wait for an in-flight save, make a final one if still dirty,
    /// then close peers.
    async fn shutdown(&mut self, rx: &mut mpsc::UnboundedReceiver<Cmd>, by_host: bool) {
        if self.ephemeral && !by_host {
            // ADR-043: a drain (restart, deploy) is not the end of the meeting. The edits are
            // in the WAL and the row is dirty, so the canvas reopens as it was when people
            // reconnect; the idle close or the host's close destroys it as usual.
            if self.seq > self.compacted_seq {
                self.compact().await;
            }
            self.tell_reconnect("server restarting");
            return;
        }
        if self.ephemeral {
            // ADR-043: the host closed the session (the meeting ended): nothing is kept.
            self.flush_mentions().await;
            let closed = Bytes::from(protocol::control(
                &json!({"t": "closed", "reason": EPHEMERAL_CLOSED}),
            ));
            for p in self.peers.values() {
                let _ = p.tx.send(Outbound::Frame(closed.clone()));
                let _ = p.tx.send(Outbound::Close(1000, EPHEMERAL_CLOSED.into()));
            }
            self.destroy().await;
            return;
        }
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
    /// Tried in order: a 401/403 on one moves to the next (PERM-05).
    tokens: Vec<String>,
    file_id: String,
    if_match: Option<String>,
    key: String,
    authors: Vec<String>,
    body: Arc<Vec<u8>>,
}

impl PutPayload {
    async fn send(self, ctx: &Ctx) -> Result<PutOutcome, String> {
        let mut last = String::from("no editor with a valid grant is connected");
        for token in &self.tokens {
            let req = PutRequest {
                file_id: &self.file_id,
                body: self.body.as_ref().clone(),
                if_match: self.if_match.as_deref(),
                idempotency_key: &self.key,
                authors: &self.authors,
            };
            match ctx.host.put_file(&self.host, token, req).await {
                Err(HostError::Status(s))
                    if s == StatusCode::UNAUTHORIZED || s == StatusCode::FORBIDDEN =>
                {
                    tracing::warn!(status = %s, "host refused a save token; trying the next editor");
                    last = HostError::Status(s).to_string();
                }
                other => return other.map_err(|e| e.to_string()),
            }
        }
        Err(last)
    }
}
