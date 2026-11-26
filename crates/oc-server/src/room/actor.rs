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
use crate::host_client::{Fetched, HostError, PutOutcome, PutRequest, SaveMeta};
use crate::hosts::{ConflictPolicy, HostConfig};
use crate::metrics::Metrics;
use crate::people;
use crate::store::{NotifyRow, OutboxRow, WalRow};
use crate::util::{now_ms, rfc3339};
use reqwest::StatusCode;

#[path = "split.rs"]
mod split;

const BACKOFF_SECS: [u64; 4] = [1, 2, 5, 10];
const MAX_AWARENESS_BYTES: usize = 2048;
/// Connections per room (docs/07 §3: 50 editors + 500 viewers). Later joins are closed
/// with 1013 "room full". The default; `OC_MAX_PEERS` sets it per server up to
/// [`MAX_PEERS_LIMIT`].
pub const MAX_PEERS: usize = 550;
/// The most `OC_MAX_PEERS` may be set to (R1K, docs/36 §4.2).
pub const MAX_PEERS_LIMIT: usize = 1_000;
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
/// A long burst of edits still produces an `edited` event this often (HAPI-05).
const EVENTS_MAX_WAIT: Duration = Duration::from_secs(2);

fn backoff(attempt: u32) -> u64 {
    BACKOFF_SECS[(attempt as usize).min(BACKOFF_SECS.len() - 1)]
}

struct Peer {
    grant: Arc<Grant>,
    tx: mpsc::UnboundedSender<Outbound>,
    clients: HashSet<ClientID>,
    denied: bool,
    synced: bool,
    /// OFF-04 (ADR-064): this connection announced an offline merge (once per connection).
    offline_merge: bool,
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
    meta: SaveMeta,
}

impl From<OutboxRow> for Pending {
    fn from(r: OutboxRow) -> Self {
        let meta = SaveMeta::from_ocanvas(&r.payload);
        Self {
            id: r.id,
            seq: r.seq,
            body: Arc::new(r.payload),
            if_match: r.base_version,
            meta,
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
    /// When the last checkpoint save started (docs/30 §4: a save is a checkpoint again after
    /// `checkpoint_every` of editing).
    last_checkpoint: Instant,
    /// What the next commit is, when someone asked for more than an autosave (VH-01b).
    next_meta: Option<SaveMeta>,
    /// In-file history (ADR-055) while the room is open; `None` until known.
    file_hist: Option<FileHist>,
    /// VH-01b: restore origins and until when their author may undo them.
    restore_until: HashMap<String, Instant>,
    /// Upper bound of the encoded doc size (exact after load and compaction).
    doc_bytes: usize,
    save: SaveState,
    conflict: Option<Conflict>,
    status: Value,
    idle_since: Option<Instant>,
    self_tx: mpsc::UnboundedSender<Cmd>,
    /// Commit API callers waiting for a save that covers `seq`.
    commit_waiters: Vec<(i64, tokio::sync::oneshot::Sender<CommitResult>)>,
    /// New @mentions, for `mentioned` events and (with `notify`) the host (UX-02).
    mentions: Option<super::mentions::Tracker>,
    /// The host gets `POST /mentions` calls (JWT callbacks; not WOPI).
    notify: bool,
    /// HAPI-05: ids each transaction touched, and the edits waiting for their `edited` event.
    watch: super::changes::Watch,
    edits: crate::events::EditBatch,
    /// Comment messages per thread when last reported, and who changed comments since.
    comment_counts: HashMap<String, (u32, Option<String>)>,
    comment_by: BTreeSet<String>,
    comments_dirty: bool,
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
    /// AUTO-02/03: what the rules watch, and the loop guard's chains.
    auto: super::auto::AutoState,
    /// PSYNC-02 (ADR-076): the parts of a split room; `None` when the room is whole.
    split: Option<split::SplitState>,
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
    /// PSYNC-02: the document it belongs to (`""` main; a part key in a split room).
    doc: String,
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
    let loaded = match Room::load(ctx.clone(), host, &seed, self_tx, inbox).await {
        Ok(mut r) => match r.split_on_open().await {
            Ok(()) => Ok(r),
            Err(e) => Err(e.context("partial sync")),
        },
        Err(e) => Err(e),
    };
    let mut room = match loaded {
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
            if by_host {
                room.close_events("host");
            }
            if let Some(r) = rooms.upgrade() {
                r.remove(&id, generation);
            }
            let _ = reply.send(());
        }
        End::Idle if room.ephemeral => {
            room.flush_mentions().await;
            room.close_events("idle");
            room.destroy().await;
            if let Some(r) = rooms.upgrade() {
                r.remove(&id, generation);
            }
        }
        End::Idle => {
            room.flush_mentions().await;
            room.close_events("idle");
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

/// In-file history (ADR-055) as the room keeps it between saves: the kept versions and the
/// previous save's content, which becomes a version when it was a checkpoint.
#[derive(Clone)]
struct FileHist {
    history: oc_model::history::FileHistory,
    prev: Value,
    prev_meta: oc_model::history::VersionMeta,
    keep_prev: bool,
}

impl FileHist {
    /// Starts from what the host's file holds (or a new canvas).
    fn from_file(doc: &Doc, loaded: Option<(oc_model::history::FileHistory, Value)>) -> Self {
        let prev = oc_model::doc_to_json(doc);
        match loaded {
            // The state a room loads is always kept once something newer is saved.
            Some((history, manifest)) => Self {
                history,
                prev,
                prev_meta: oc_model::history::VersionMeta::from_manifest(&manifest),
                keep_prev: true,
            },
            None => Self {
                history: Default::default(),
                prev,
                prev_meta: Default::default(),
                keep_prev: false,
            },
        }
    }
}

/// Builds a doc from what the host's `GET /files/{id}` returned, with the file's in-file
/// history (ADR-055).
fn loaded_from_host(
    room: &str,
    fetched: Fetched,
) -> anyhow::Result<(Doc, Option<String>, FileHist)> {
    if let Fetched::Found { bytes, etag, .. } = &fetched
        && !bytes.starts_with(crate::hosts::TEMPLATE_JSON_TAG)
        && oc_model::ocanvas::is_zip(bytes)
    {
        let loaded = oc_model::read_ocanvas(bytes)?;
        let hist = FileHist::from_file(&loaded.doc, Some((loaded.history, loaded.manifest)));
        return Ok((loaded.doc, etag.clone(), hist));
    }
    let (doc, etag) = doc_from_host_inner(room, fetched)?;
    let hist = FileHist::from_file(&doc, None);
    Ok((doc, etag, hist))
}

fn doc_from_host_inner(room: &str, fetched: Fetched) -> anyhow::Result<(Doc, Option<String>)> {
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

/// A document rebuilt from a room's encoded state (a save built off the actor, PERF-11).
fn doc_from_state(state: &[u8]) -> anyhow::Result<Doc> {
    let doc = oc_model::new_doc();
    let update = Update::decode_v1(state).context("decoding the room state")?;
    doc.transact_mut()
        .apply_update(update)
        .context("applying the room state")?;
    Ok(doc)
}

/// Moves the in-file history forward to `doc` (ADR-055) and writes the `.ocanvas` body.
/// CPU only: runs on a blocking thread for a background save.
fn build_save_body(
    doc: &Doc,
    commit: &oc_model::CommitInfo,
    meta: &SaveMeta,
    history: Option<(crate::hosts::FileHistoryLimits, &mut FileHist)>,
    search: oc_model::search::Options,
) -> Result<Vec<u8>, String> {
    let fh = history.map(|(limits, fh)| {
        let cur = oc_model::doc_to_json(doc);
        fh.history.advance(
            &fh.prev,
            &fh.prev_meta,
            fh.keep_prev,
            &cur,
            oc_model::history::Limits {
                max_bytes: limits.max_bytes,
                max_versions: limits.max_versions,
            },
        );
        fh.prev = cur;
        fh.prev_meta = oc_model::history::VersionMeta {
            id: commit.id.clone(),
            kind: commit.kind,
            name: commit.message.clone(),
            authors: commit.authors.clone(),
            at: commit.at.clone(),
            restored_from: commit.restored_from.clone(),
        };
        fh.keep_prev = meta.checkpoint;
        fh.history.clone()
    });
    oc_model::ocanvas::write_ocanvas_opts(doc, commit, fh.as_ref(), search)
        .map_err(|e| e.to_string())
}

/// Everything a save needs, taken from the room so that the JSON, `.ocanvas` and history work
/// and the outbox write run off the actor while it keeps taking edits (PERF-11: saves built
/// inline were the X10K latency spike).
struct SaveBuild {
    state: Vec<u8>,
    commit: oc_model::CommitInfo,
    meta: SaveMeta,
    /// The history limits and the room's in-file history (`None`: recover it from the host).
    history: Option<(crate::hosts::FileHistoryLimits, Option<FileHist>)>,
    search: oc_model::search::Options,
    row: OutboxRow,
    epoch: i64,
    /// Memory durability: the database gets this state before the host is asked to.
    dump: bool,
    host: Arc<HostConfig>,
}

/// A background save build's result, back on the actor.
pub(crate) struct SaveBuilt {
    seq: i64,
    pending: Result<Pending, (String, Option<anyhow::Error>)>,
    file_hist: Option<FileHist>,
    dumped: Option<Result<(), super::DumpError>>,
}

impl SaveBuild {
    async fn run(self, ctx: Arc<Ctx>) -> SaveBuilt {
        let SaveBuild {
            state,
            commit,
            meta,
            history,
            search,
            mut row,
            epoch,
            dump,
            host,
        } = self;
        let seq = row.seq;
        let mut out = SaveBuilt {
            seq,
            pending: Err((String::new(), None)),
            file_hist: None,
            dumped: None,
        };
        if dump {
            let r = ctx
                .store
                .compact(&row.room_id, epoch, seq, &state, now_ms())
                .await;
            let fenced = r.as_ref().is_err_and(crate::store::is_fenced);
            out.dumped = Some(r.map_err(|e| {
                if crate::store::is_fenced(&e) {
                    super::DumpError::Fenced(e)
                } else {
                    super::DumpError::Other(e.to_string())
                }
            }));
            if fenced {
                out.file_hist = history.and_then(|(_, h)| h);
                out.pending = Err(("the room moved".into(), None));
                return out;
            }
        }
        let history = match history {
            Some((limits, Some(h))) => Some((limits, h, None)),
            Some((limits, None)) => {
                let read = ctx
                    .host
                    .get_file(&host, &row.token, &row.file_id)
                    .await
                    .map_err(anyhow::Error::from)
                    .and_then(|f| loaded_from_host(&row.room_id, f));
                match read {
                    Ok((_, _, h)) => Some((limits, h, None)),
                    Err(e) => Some((
                        limits,
                        FileHist::from_file(&oc_model::new_doc(), None),
                        Some(e),
                    )),
                }
            }
            None => None,
        };
        let room = row.room_id.clone();
        let built = tokio::task::spawn_blocking(move || {
            let mut history = history;
            let body = doc_from_state(&state)
                .map_err(|e| e.to_string())
                .and_then(|doc| {
                    if let Some((_, h, Some(e))) = history.as_mut() {
                        tracing::warn!(room = %room, error = %e, "in-file history not recovered; starting a new one");
                        *h = FileHist::from_file(&doc, None);
                    }
                    build_save_body(
                        &doc,
                        &commit,
                        &meta,
                        history.as_mut().map(|(l, h, _)| (*l, h)),
                        search,
                    )
                });
            // The rebuilt doc is gone: give its blocks back, or this (now idle) blocking
            // thread keeps them cached and they stay resident after the room closes.
            drop(state);
            crate::alloc::flush_thread_cache();
            (body, history.map(|(_, h, _)| h), meta)
        })
        .await;
        let (body, hist, meta) = match built {
            Ok(b) => b,
            Err(e) => {
                out.pending = Err((format!("building the save failed: {e}"), None));
                return out;
            }
        };
        out.file_hist = hist;
        row.payload = match body {
            Ok(b) => b,
            Err(e) => {
                out.pending = Err((e, None));
                return out;
            }
        };
        // No outbox row, no save (docs/22 §8 weakness 5).
        if let Err(e) = ctx.store.outbox_insert(&row, epoch, now_ms()).await {
            out.pending = Err((format!("writing the commit outbox failed: {e}"), Some(e)));
            return out;
        }
        let mut pending = Pending::from(row);
        pending.meta = meta;
        out.pending = Ok(pending);
        out
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
        // ADR-055: unknown (None) after a WAL recovery; read back from the host before a save.
        let mut file_hist: Option<FileHist> = None;
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
            let loaded = oc_model::read_ocanvas(&p.payload).context("outbox payload")?;
            file_hist = Some(FileHist::from_file(
                &loaded.doc,
                Some((loaded.history, loaded.manifest)),
            ));
            doc = loaded.doc;
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
            let (loaded, etag, hist) = loaded_from_host(&id, fetched)?;
            file_hist = Some(hist);
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
        let notify = crate::notify::enabled(&host, &seed.file.id);
        let mentions = Some(super::mentions::Tracker::new(&doc));
        let mut auto = super::auto::AutoState::new(&doc, &host);
        if !host.ephemeral()
            && ctx.store.automation_supported()
            && let Some(rows) = auto.schedule(&doc, &host, ctx.clock.now_ms())
        {
            // Awaited, not spawned: the room is open only once its schedule is written, so a
            // later write (a rule change) can never be overtaken by this one.
            let now = ctx.clock.now_ms();
            if let Err(e) = ctx
                .store
                .automation_schedule_set(&id, &host.id, &seed.file.id, &rows, now)
                .await
            {
                tracing::warn!(room = %id, error = %e, "automation schedule not written");
            }
        }
        Ok(Self {
            auto,
            mentions,
            notify,
            watch: super::changes::Watch::attach(&doc),
            edits: Default::default(),
            comment_counts: super::changes::comment_counts(&doc),
            comment_by: BTreeSet::new(),
            comments_dirty: false,
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
            last_checkpoint: Instant::now(),
            next_meta: None,
            file_hist,
            restore_until: HashMap::new(),
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
            split: None,
            ctx,
        })
    }

    async fn handle(&mut self, cmd: Cmd) {
        // Only Yjs frames join a WAL batch. Everything else (joins, state reads, patches,
        // saves, commits) sees durable state only.
        if !matches!(cmd, Cmd::Frame { .. }) {
            self.flush_wal().await;
        }
        // PSYNC-02: server work on the canvas runs on a whole view of a split room.
        if self.split.is_some()
            && matches!(
                cmd,
                Cmd::Patch { .. }
                    | Cmd::Template { .. }
                    | Cmd::History { .. }
                    | Cmd::Icons { .. }
                    | Cmd::TemplateUndo { .. }
                    | Cmd::Tool { .. }
                    | Cmd::AutomationUndo { .. }
                    | Cmd::AiTrack { .. }
                    | Cmd::AiUndo { .. }
            )
        {
            self.ensure_whole().await;
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
                let no_parts = self.split.as_ref().is_none_or(|s| s.headers.is_empty());
                let _ = reply.send(RoomInfo {
                    is_new: oc_model::is_empty(&self.doc) && no_parts,
                });
            }
            Cmd::State { reply } => {
                // A split room merges the parts' bytes: no whole view for a read.
                let state = if self.split.as_ref().is_some_and(|s| s.whole_since.is_none()) {
                    self.flat_state().await
                } else {
                    self.doc
                        .transact()
                        .encode_state_as_update_v1(&StateVector::default())
                };
                let _ = reply.send(state);
            }
            Cmd::SaveDone { id, result } => self.save_done(&id, result).await,
            Cmd::ConflictDone { result } => self.conflict_done(result).await,
            Cmd::Dumped { seq, result } => self.dumped(seq, result),
            Cmd::SaveBuilt(b) => self.save_built(*b),
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
            Cmd::Template {
                doc,
                origin,
                author,
                reply,
            } => {
                let _ = reply.send(self.template(&doc, &origin, &author).await);
            }
            Cmd::History { op, author, reply } => self.history(op, &author, reply).await,
            Cmd::Icons { op, author, reply } => {
                let _ = reply.send(self.icons(&op, &author).await);
            }
            Cmd::TemplateUndo { origin, reply } => {
                let r = if self.conflict.is_some() {
                    Err(PatchFailure::Conflict)
                } else if !self.ai_undo.contains_key(&origin) {
                    Err(PatchFailure::Invalid(oc_model::patch::PatchError::Request(
                        "nothing to undo".into(),
                    )))
                } else {
                    self.ai_undo(&origin)
                        .await
                        .map(|()| Patched { block_ids: vec![] })
                        .map_err(|_| PatchFailure::Unavailable)
                };
                let _ = reply.send(r);
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
            Cmd::AutomationNotice { user, msg } => {
                let frame: Bytes = protocol::control(&msg).into();
                for p in self.peers.values().filter(|p| p.grant.user.id == user) {
                    let _ = p.tx.send(Outbound::Frame(frame.clone()));
                }
            }
            Cmd::AutomationUndo { origin } => {
                self.auto
                    .pending
                    .insert(origin.clone(), (super::auto::UNDO_DEPTH, vec![]));
                if let Err(e) = self.ai_undo(&origin).await {
                    tracing::info!(room = %self.id, error = %e, "automation undo");
                }
            }
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

    /// Publishes a change event of this room (HAPI-05): ids and users only, no content.
    fn emit(&self, kind: &str, data: Value) {
        self.ctx.events.publish(crate::events::FileEvent::new(
            &self.host.id,
            &self.id,
            &self.file_id,
            kind,
            data,
        ));
    }

    /// Sends the pending `edited` and `commented` events when due (`force`: now). Edits are
    /// debounced by `[host.api] events_coalesce_ms` (default 250 ms; at least one tick) and
    /// reported at least every 2 s during a long burst.
    fn flush_events(&mut self, force: bool) {
        let quiet = Duration::from_millis(
            self.host
                .api
                .get("events_coalesce_ms")
                .and_then(|v| v.as_integer())
                .map_or(250, |n| n.clamp(0, 10_000) as u64),
        );
        let now = Instant::now();
        let due = force || self.edits.due(now, quiet, EVENTS_MAX_WAIT);
        if due && !self.edits.is_empty() {
            let data = self.edits.take();
            self.emit(crate::events::EDITED, data);
        }
        if self.comments_dirty && (due || self.edits.is_empty()) {
            self.comments_dirty = false;
            let by: Vec<String> = std::mem::take(&mut self.comment_by).into_iter().collect();
            let now_counts = super::changes::comment_counts(&self.doc);
            let mut added: Vec<(&String, u32, &Option<String>)> = now_counts
                .iter()
                .filter_map(|(t, (n, b))| {
                    let before = self.comment_counts.get(t).map_or(0, |c| c.0);
                    (*n > before).then_some((t, *n - before, b))
                })
                .collect();
            added.sort();
            for (thread, n, block) in added {
                let mut data = json!({"threadId": thread, "added": n, "by": by});
                if let Some(b) = block {
                    data["blockId"] = json!(b);
                }
                self.emit(crate::events::COMMENTED, data);
            }
            self.comment_counts = now_counts;
        }
    }

    /// The live session ended (`reason`: `host` or `idle`): last events, then `session.closed`.
    fn close_events(&mut self, reason: &str) {
        self.flush_events(true);
        self.emit(crate::events::SESSION_CLOSED, json!({"reason": reason}));
    }

    /// LIVE-07 (ADR-069): `live.embedded` / `live.removed` for references an applied change
    /// added or removed, so the host can keep its own usage index (OpenCanvas keeps none).
    fn live_events(&self, before: Option<HashSet<(String, String, String)>>, by: &str) {
        let Some(before) = before else {
            return;
        };
        let after = filter::live_refs(&self.doc);
        let ev = |kind: &str, set: Vec<&(String, String, String)>| {
            let mut set = set;
            set.sort();
            for (node, block, file) in set {
                self.emit(
                    kind,
                    json!({"blockId": block, "type": node, "liveFileId": file, "by": by}),
                );
            }
        };
        ev(
            crate::events::LIVE_EMBEDDED,
            after.difference(&before).collect(),
        );
        ev(
            crate::events::LIVE_REMOVED,
            before.difference(&after).collect(),
        );
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
        if self.peers.len() >= self.ctx.cfg.max_peers {
            tracing::warn!(room = %self.id, peers = self.peers.len(), "room full; connection refused");
            let _ = tx.send(Outbound::Close(1013, "room full".into()));
            let _ = reply.send(());
            return;
        }
        // PSYNC-02 (owner decision): an editor without `caps=subdoc` cannot hold a split room.
        if self.split.is_some() && !grant.subdoc {
            tracing::info!(room = %self.id, "connection refused: split room, no caps=subdoc");
            let _ = tx.send(Outbound::Close(
                4426,
                "editor out of date: reopen the canvas".into(),
            ));
            let _ = reply.send(());
            return;
        }
        if grant.can_write() && !grant.callback_token.is_empty() {
            self.revoked_tokens.remove(&grant.callback_token);
            self.callback_token = grant.callback_token.clone();
        }
        let sv = self.doc.transact().state_vector();
        let _ = tx.send(Outbound::Frame(protocol::step1(sv).into()));
        if let Some(frame) = self.parts_control() {
            let _ = tx.send(Outbound::Frame(frame.into()));
        }
        if !self
            .peers
            .values()
            .any(|p| p.grant.user.id == grant.user.id)
        {
            self.emit(
                crate::events::MEMBER_JOINED,
                json!({"userId": grant.user.id, "role": grant.role.as_str()}),
            );
        }
        self.peers.insert(
            conn,
            Peer {
                grant: grant.clone(),
                tx,
                clients: HashSet::new(),
                denied: false,
                synced: false,
                offline_merge: false,
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
        // LIVE-02 (ADR-069): `from` names the embedding canvas; only viewers from that same
        // canvas get it, so one frame per parent canvas (in practice one or two).
        if update.clients.values().any(|e| e.json.contains("\"from\"")) {
            let full: Bytes = protocol::awareness(update.clone()).into();
            let mut frames: HashMap<Option<String>, Bytes> = HashMap::new();
            for (id, p) in &self.peers {
                if Some(*id) == except {
                    continue;
                }
                let parent = p.grant.live.parent.as_ref().map(|x| x.file_id.clone());
                let frame = frames
                    .entry(parent.clone())
                    .or_insert_with(|| {
                        presence::without_foreign_from(&update, parent.as_deref())
                            .map_or_else(|| full.clone(), |u| protocol::awareness(u).into())
                    })
                    .clone();
                let _ = p.tx.send(Outbound::Frame(frame));
            }
            return;
        }
        // At most ~16 KB a frame: every socket's write buffer keeps the largest batch it was
        // sent (PERF-11, R1K).
        for f in protocol::awareness_frames(update) {
            self.broadcast(f, except);
        }
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
        let parent = self
            .peers
            .get(&conn)
            .and_then(|p| p.grant.live.parent.as_ref().map(|x| x.file_id.clone()));
        let update = presence::without_foreign_from(&update, parent.as_deref()).unwrap_or(update);
        for f in protocol::awareness_frames(update) {
            self.send(conn, f);
        }
    }

    fn leave(&mut self, conn: ConnId) {
        let Some(peer) = self.peers.remove(&conn) else {
            return;
        };
        self.forget_holder(conn, None);
        self.inbox.forget(conn);
        if !self
            .peers
            .values()
            .any(|p| p.grant.user.id == peer.grant.user.id)
        {
            self.emit(
                crate::events::MEMBER_LEFT,
                json!({"userId": peer.grant.user.id}),
            );
        }
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
                Message::Custom(split::MSG_SUBDOC, body) => self.on_subdoc(conn, &body).await,
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
        if msg["t"] == "offline_merge" {
            self.offline_merge(conn, &msg);
            return;
        }
        // AUTO-06 frame 3a: Undo a run from its toast (editors only; the run's own writes).
        if msg["t"] == "automation-undo" {
            let can_write = self.peers.get(&conn).is_some_and(|p| p.grant.can_write());
            let (rule, run) = (
                msg["ruleId"].as_str().unwrap_or_default(),
                msg["runId"].as_str().unwrap_or_default(),
            );
            if can_write
                && oc_model::automation::valid_id(rule)
                && !run.is_empty()
                && run.len() <= 64
            {
                let _ = self.self_tx.send(Cmd::AutomationUndo {
                    origin: format!("automation:{rule}#{run}"),
                });
            }
            return;
        }
        if msg["t"] == "sub-unload" {
            self.forget_holder(conn, Some(msg["id"].as_str().unwrap_or_default()));
            return;
        }
        let wants_save = msg["t"] == "save";
        let can_write = self.peers.get(&conn).is_some_and(|p| p.grant.can_write());
        if wants_save && can_write && self.dirty_since.is_some() && self.conflict.is_none() {
            self.save.retry_at = None;
            self.dirty_since = Some(Instant::now() - self.ctx.cfg.autosave_max);
        }
    }

    /// `{"t":"offline_merge","changes":N,"since":ms}` (OFF-04, ADR-064, docs/34 §3.3 step 5):
    /// a device is about to send a long offline session (over 10 minutes or 200 changes). The
    /// room saves a checkpoint version "Before <name>'s offline changes" first and answers
    /// `{"t":"offline_checkpoint","version"}` (or `error`) to that connection; the others get
    /// `{"t":"offline_arrived","by","byName","changes"}` once, for the collaborator toast. Only
    /// writers, once per connection; the updates that follow are checked like any other.
    fn offline_merge(&mut self, conn: ConnId, msg: &Value) {
        let Some(peer) = self.peers.get_mut(&conn) else {
            return;
        };
        let out = peer.tx.clone();
        let reply = |v: Value| {
            let _ = out.send(Outbound::Frame(protocol::control(&v).into()));
        };
        if !peer.grant.can_write() || peer.offline_merge || self.conflict.is_some() {
            reply(json!({"t": "offline_checkpoint", "error": "REFUSED"}));
            return;
        }
        peer.offline_merge = true;
        let changes = msg["changes"].as_u64().unwrap_or(0).min(10_000_000);
        let (user_id, name) = (peer.grant.user.id.clone(), peer.grant.user.name.clone());
        let label: String = name.chars().take(80).collect();
        let meta = SaveMeta {
            kind: oc_model::ocanvas::CommitKind::Named,
            message: Some(format!("Before {label}'s offline changes")),
            restored_from: None,
            checkpoint: true,
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.commit_with(meta, tx, json!({"t": "offline_checkpoint"}));
        let fwd = out.clone();
        tokio::spawn(async move {
            if let Ok(v) = rx.await {
                let _ = fwd.send(Outbound::Frame(protocol::control(&v).into()));
            }
        });
        tracing::info!(room = %self.id, changes, "offline merge announced");
        let ctl =
            json!({"t": "offline_arrived", "by": user_id, "byName": name, "changes": changes});
        self.broadcast(protocol::control(&ctl), Some(conn));
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
        // PSYNC-02: an edit of a block that just became a part goes through a whole view.
        if grant.role != Role::View && self.main_update_touches_parts(&bytes) {
            self.ensure_whole().await;
        }
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
        // BSDK-02: an editor older than 0.2 deletes every `extBlock` it receives (its schema
        // has no such node). Refuse that update and end the session; the person reopens the
        // canvas with the current editor. Connections that keep SDK blocks say `caps=ext`.
        if !grant.ext_blocks && filter::removes_ext_block(&self.doc, &bytes) {
            tracing::info!(room = %self.id, "update refused: removes an SDK block from a client without caps=ext");
            self.deny(conn, "this editor is out of date; reopen the canvas");
            if let Some(p) = self.peers.get(&conn) {
                let _ = p.tx.send(Outbound::Close(
                    4426,
                    "editor out of date: reopen the canvas".into(),
                ));
            }
            return;
        }
        // LIVE-02: the same for `liveBlock` and `blockRef` (editors before 0.3 lack them, and
        // `caps=live` says a connection keeps them), plus the depth rule, the reference limit,
        // the snapshot policy, the feature flag and `perms.live` for adding one.
        match filter::live_check(&self.doc, &bytes, &self.live_rules(Some(&*grant))) {
            filter::LiveVerdict::Ok => {}
            filter::LiveVerdict::OutOfDate => {
                tracing::info!(room = %self.id, "update refused: removes a live block from a client without caps=live");
                self.deny(conn, "this editor is out of date; reopen the canvas");
                if let Some(p) = self.peers.get(&conn) {
                    let _ = p.tx.send(Outbound::Close(
                        4426,
                        "editor out of date: reopen the canvas".into(),
                    ));
                }
                return;
            }
            filter::LiveVerdict::Refused(e) => {
                tracing::info!(room = %self.id, "update refused: live block rule");
                return self.deny(conn, &e);
            }
        }
        // BSDK-03: SDK block attrs and data must match their package's schema, whoever writes
        // them (the editor checks the bridge's writes first; this catches every other client).
        if let Some(e) = filter::sdk_block_error(&self.doc, &bytes) {
            tracing::info!(room = %self.id, "update refused: an SDK block does not match its schema");
            return self.deny(
                conn,
                &format!("an SDK block does not match its schema ({e})"),
            );
        }
        // AUTO-01 (ADR-067): rules are changed by editors with perms.automate, valid, owned.
        if let Err(e) = super::auto::check_client(&self.doc, &bytes, &grant, &self.host) {
            tracing::info!(room = %self.id, "update refused: automation rule");
            return self.deny(conn, &e);
        }
        // OFF-05: a queued upload (`oc-pending:`) names the person whose device holds it.
        if let Some(e) = filter::pending_error(&self.doc, &bytes, &grant.user.id) {
            tracing::info!(room = %self.id, "update refused: a pending upload names someone else");
            return self.deny(conn, &e);
        }
        // DGM-17 (ADR-057): only the server writes the `icons` root (POST /v1/icons).
        if filter::touches_root(&self.doc, &bytes, oc_model::roots::ICONS) {
            return self.deny(conn, "icons are changed through the server");
        }
        let cap = self.ctx.cfg.max_doc_bytes;
        if self.doc_bytes + bytes.len() > cap {
            self.doc_bytes = encoded_len(&self.doc);
            if self.doc_bytes + bytes.len() > cap {
                tracing::info!(room = %self.id, size = self.doc_bytes, update = bytes.len(), "update refused: document size limit");
                return self.deny(conn, "document size limit reached");
            }
        }
        let live_before = filter::live_refs_if_relevant(&self.doc, &bytes);
        let Ok(update) = Update::decode_v1(&bytes) else {
            return self.deny(conn, "malformed update");
        };
        let changed = {
            let mut txn = self.doc.transact_mut();
            let was_pending =
                txn.store().pending_update().is_some() || txn.store().pending_ds().is_some();
            // Not `txn.apply_update`: yrs 0.28.2 can strand a pending update for good
            // (oc_model::sync).
            if oc_model::sync::apply_update(&mut txn, update).is_err() {
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
        self.live_events(live_before, &grant.user.id);
    }

    /// An update now in the doc: queued for the next WAL batch as the next `seq`. Nothing is
    /// fanned out or acknowledged until [`Room::flush_wal`] has made it durable.
    fn queue(&mut self, bytes: Vec<u8>, user_id: &str, from: Option<ConnId>, edit: bool) {
        if self.lost.is_some() {
            return;
        }
        if self.route_queued(&bytes, user_id, from, edit).is_some() {
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
            doc: String::new(),
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
                    doc: q.doc.clone(),
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
        // HAPI-05: what this durable batch changed, and who sent it.
        let mut users: Vec<String> = batch
            .iter()
            .filter(|q| q.edit)
            .map(|q| q.user_id.clone())
            .collect();
        users.sort();
        users.dedup();
        let touched = self.watch.take();
        self.automation_batch(&users);
        if touched.comments {
            self.comments_dirty = true;
            self.comment_by.extend(users.iter().cloned());
        }
        self.edits.add(touched, &users, Instant::now());
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
        // PSYNC-02: a batch with part updates goes out update by update, each to its holders.
        if batch.iter().any(|q| !q.doc.is_empty()) {
            self.batch_in_order = true;
            for q in batch {
                if q.doc.is_empty() {
                    self.broadcast(protocol::update(q.bytes), q.from);
                } else {
                    self.fan_out_part(&q.doc, &q.bytes, q.from);
                }
            }
            if edited {
                self.accepted().await;
            }
            return true;
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

    /// AUTO-02/03: the runs a durable batch starts, and the room's schedule rows when its
    /// timed rules changed. Runs are tasks; their writes come back as `Cmd::Tool`.
    fn automation_batch(&mut self, users: &[String]) {
        if self.ephemeral || !self.ctx.store.automation_supported() {
            return;
        }
        let names: HashMap<String, String> = self
            .peers
            .values()
            .map(|p| (p.grant.user.id.clone(), p.grant.user.name.clone()))
            .collect();
        let jobs = self.auto.after_batch(
            &self.doc,
            &self.host,
            &self.id,
            &self.file_id,
            users,
            &|u| names.get(u).cloned(),
        );
        for job in jobs {
            let deps = self.auto_deps();
            let applier = super::auto::ActorApplier(
                self.self_tx.clone(),
                job.depth,
                job.chain.clone(),
                job.run_id.clone(),
            );
            tokio::spawn(async move {
                crate::automation::runner::run(&deps, &applier, job).await;
            });
        }
        let now = self.ctx.clock.now_ms();
        if let Some(rows) = self.auto.schedule(&self.doc, &self.host, now) {
            let (store, room, h, f) = (
                self.ctx.store.clone(),
                self.id.clone(),
                self.host.id.clone(),
                self.file_id.clone(),
            );
            tokio::spawn(async move {
                if let Err(e) = store
                    .automation_schedule_set(&room, &h, &f, &rows, now)
                    .await
                {
                    tracing::warn!(room = %room, error = %e, "automation schedule not written");
                }
            });
        }
    }

    fn auto_deps(&self) -> crate::automation::runner::Deps {
        crate::automation::runner::Deps {
            store: self.ctx.store.clone(),
            host_client: self.ctx.host.clone(),
            events: self.ctx.events.clone(),
            http: self.ctx.auto_http.clone(),
            clock: self.ctx.clock.clone(),
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

    /// Version history writes (VH-01b, docs/30 §4-5).
    async fn history(
        &mut self,
        op: super::HistoryOp,
        author: &str,
        reply: tokio::sync::oneshot::Sender<Value>,
    ) {
        use oc_model::ocanvas::CommitKind;
        if self.ephemeral {
            let _ = reply.send(json!({"error": "HISTORY_OFF"}));
            return;
        }
        if self.conflict.is_some() {
            let _ = reply.send(json!({"error": "CONFLICT"}));
            return;
        }
        match op {
            super::HistoryOp::Save { name } => {
                // "Save first" before a restore: only when there is something to save.
                if name.is_none() && self.dirty_since.is_none() && !self.save.in_flight {
                    let _ = reply.send(json!({"version": self.host_version}));
                    return;
                }
                let meta = SaveMeta {
                    kind: if name.is_some() {
                        CommitKind::Named
                    } else {
                        CommitKind::Auto
                    },
                    message: name,
                    restored_from: None,
                    checkpoint: true,
                };
                self.commit_with(meta, reply, json!({}));
            }
            super::HistoryOp::Restore {
                target,
                from,
                name,
                restore_id,
                by_name,
            } => {
                let update = match oc_model::restore::restore_update(&self.doc, &target) {
                    Ok(u) => u,
                    Err(e) => {
                        tracing::warn!(room = %self.id, error = %e, "restore could not be computed");
                        let _ = reply.send(json!({"error": "VERSION_INVALID"}));
                        return;
                    }
                };
                let origin = format!("restore:{restore_id}:{author}");
                // Only the latest restore per person stays undoable.
                // Exactly `restore:<26-character id>:<author>`: user ids may contain `:`, so a
                // suffix match would drop another person's entry (SEC-51).
                let mine = |o: &str| {
                    o.strip_prefix("restore:")
                        .and_then(|r| r.get(26..))
                        .and_then(|r| r.strip_prefix(':'))
                        == Some(&*author)
                };
                self.ai_undo.retain(|o, _| !mine(o));
                self.restore_until.retain(|o, _| !mine(o));
                self.ai_track(&origin);
                let changed = match self.apply_server_update(update, &origin, author).await {
                    Ok(c) => c,
                    Err(e) => {
                        self.ai_undo.remove(&origin);
                        let code = match e {
                            PatchFailure::TooLarge => "DOC_TOO_LARGE",
                            PatchFailure::Conflict => "CONFLICT",
                            PatchFailure::Unavailable => "UNAVAILABLE",
                            PatchFailure::Invalid(_) => "VERSION_INVALID",
                        };
                        let _ = reply.send(json!({"error": code}));
                        return;
                    }
                };
                self.restore_until
                    .insert(origin, Instant::now() + self.ctx.cfg.restore_undo_window);
                tracing::info!(room = %self.id, changed, "version restored");
                self.flush_events(true);
                self.emit(
                    crate::events::RESTORED,
                    json!({"restoreId": restore_id, "from": from, "by": author}),
                );
                let ctl = json!({"t": "restored", "by": author, "byName": by_name, "from": from,
                    "name": name, "at": now_ms(), "restoreId": restore_id});
                self.broadcast(protocol::control(&ctl), None);
                let meta = SaveMeta {
                    kind: CommitKind::Restore,
                    message: Some(name),
                    restored_from: Some(from),
                    checkpoint: true,
                };
                self.commit_with(
                    meta,
                    reply,
                    json!({"changed": changed, "restoreId": restore_id}),
                );
            }
            super::HistoryOp::Undo { restore_id } => {
                let origin = format!("restore:{restore_id}:{author}");
                let r = match self.restore_until.remove(&origin) {
                    Some(t) if Instant::now() <= t && self.ai_undo.contains_key(&origin) => {
                        match self.ai_undo(&origin).await {
                            Ok(()) => json!({"undone": true}),
                            Err(_) => json!({"error": "UNAVAILABLE"}),
                        }
                    }
                    Some(_) => {
                        self.ai_undo.remove(&origin);
                        json!({"error": "UNDO_EXPIRED"})
                    }
                    None => json!({"error": "NOTHING_TO_UNDO"}),
                };
                let _ = reply.send(r);
            }
        }
    }

    /// Saves now with `meta` (also when nothing changed: a named version still reaches the
    /// host, docs/30 §10 decision 3) and answers `extra` plus `version` once the host has it.
    fn commit_with(
        &mut self,
        meta: SaveMeta,
        reply: tokio::sync::oneshot::Sender<Value>,
        extra: Value,
    ) {
        self.next_meta = Some(meta);
        if self.dirty_since.is_none() {
            self.dirty_since = Some(Instant::now());
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.commit_waiters.push((self.seq, tx));
        self.force_save();
        tokio::spawn(async move {
            let mut out = extra;
            match rx.await {
                Ok(CommitResult::Saved { version } | CommitResult::Clean { version }) => {
                    out["version"] = json!(version);
                }
                Ok(CommitResult::Queued { .. }) => out["queued"] = json!(true),
                Ok(CommitResult::Conflict) => out["error"] = json!("CONFLICT"),
                Err(_) => out["error"] = json!("UNAVAILABLE"),
            }
            let _ = reply.send(out);
        });
    }

    /// Team template (TPL-01): replaces the content with `doc` as one transaction with
    /// `origin` (`template:<user>:<applyId>`), tracked for undo. Only the latest template per
    /// user stays undoable.
    async fn template(
        &mut self,
        doc: &Value,
        origin: &str,
        author: &str,
    ) -> Result<Patched, PatchFailure> {
        if self.conflict.is_some() {
            return Err(PatchFailure::Conflict);
        }
        let (update, block_ids) = crate::team_templates::apply(&self.doc, doc)
            .map_err(|e| PatchFailure::Invalid(oc_model::patch::PatchError::Request(e)))?;
        let mine = format!("template:{author}:");
        self.ai_undo.retain(|o, _| !o.starts_with(&mine));
        self.ai_track(origin);
        if let Err(e) = self.apply_server_update(update, origin, author).await {
            self.ai_undo.remove(origin);
            return Err(e);
        }
        tracing::info!(room = %self.id, blocks = block_ids.len(), "team template applied");
        Ok(Patched { block_ids })
    }

    /// DGM-17: a change to the server-written `icons` root, made on a scratch copy
    /// (`oc_model::doc_icons::apply`, which enforces 200 icons and 1 MB) and applied with origin
    /// `icons`.
    async fn icons(
        &mut self,
        op: &oc_model::doc_icons::IconOp,
        author: &str,
    ) -> Result<Patched, PatchFailure> {
        if self.conflict.is_some() {
            return Err(PatchFailure::Conflict);
        }
        let update = oc_model::doc_icons::apply(&self.doc, op)
            .map_err(|e| PatchFailure::Invalid(oc_model::patch::PatchError::Request(e)))?;
        self.apply_server_update(update, "icons", author).await?;
        Ok(Patched { block_ids: vec![] })
    }

    /// The live block rules for a writer (LIVE-02): a client connection's grant, or `None` for
    /// the server's own writes (which keep every node and may embed).
    fn live_rules(&self, grant: Option<&Grant>) -> filter::LiveRules {
        filter::LiveRules {
            on: self.host.live_blocks(),
            policy: crate::live::LiveCfg::of(&self.host).snapshot,
            may_embed: grant.is_none_or(|g| g.perms.live),
            keeps_nodes: grant.is_none_or(|g| g.live.caps),
        }
    }

    /// Applies an update made by the server (patch API, canvas tools) with `origin`, then logs
    /// and broadcasts it like a client update. Returns whether the doc changed.
    async fn apply_server_update(
        &mut self,
        update: Vec<u8>,
        origin: &str,
        author: &str,
    ) -> Result<bool, PatchFailure> {
        // LIVE-02: server writes (API, MCP, tools) follow the depth rule, the reference limit,
        // the snapshot policy and the feature flag too.
        if let filter::LiveVerdict::Refused(e) =
            filter::live_check(&self.doc, &update, &self.live_rules(None))
        {
            return Err(PatchFailure::Invalid(oc_model::patch::PatchError::Invalid(
                0, e,
            )));
        }
        let cap = self.ctx.cfg.max_doc_bytes;
        if self.doc_bytes + update.len() > cap {
            self.doc_bytes = encoded_len(&self.doc);
            if self.doc_bytes + update.len() > cap {
                tracing::info!(room = %self.id, size = self.doc_bytes, update = update.len(), "server edit refused: document size limit");
                return Err(PatchFailure::TooLarge);
            }
        }
        let live_before = filter::live_refs_if_relevant(&self.doc, &update);
        let decoded = Update::decode_v1(&update).map_err(|e| {
            PatchFailure::Invalid(oc_model::patch::PatchError::Request(e.to_string()))
        })?;
        let changed = {
            let mut txn = self.doc.transact_mut_with(origin);
            if let Err(e) = oc_model::sync::apply_update(&mut txn, decoded) {
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
            self.live_events(live_before, author);
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
        // AUTO-02: an automation write carries its chain; the transaction gets the plain origin.
        let plain;
        let origin = match super::auto::split_origin(origin) {
            Some((rule, depth, chain, run)) => {
                self.auto.pending.insert(author.to_string(), (depth, chain));
                // One transaction origin per run, tracked so its Undo reverts exactly it.
                plain = if run.is_empty() {
                    crate::automation::runner::origin_of(&rule)
                } else {
                    format!("automation:{rule}#{run}")
                };
                if !run.is_empty() && !self.ai_undo.contains_key(&plain) {
                    self.ai_track(&plain);
                    self.auto.tracked.push_back(plain.clone());
                    while self.auto.tracked.len() > 50 {
                        if let Some(old) = self.auto.tracked.pop_front() {
                            self.ai_undo.remove(&old);
                        }
                    }
                }
                plain.as_str()
            }
            None => origin,
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
            // LIVE-02: a live block rule the change would break is the caller's input.
            Err(PatchFailure::Invalid(oc_model::patch::PatchError::Invalid(_, e))) => {
                Err(ToolError::BadInput(e))
            }
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
        let from = peer
            .grant
            .live
            .parent
            .as_ref()
            .map(|p| json!({"fileId": p.file_id, "title": p.title}));
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
            let json = presence::stamp_from(&entry.json, &user, from.as_ref());
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
            self.ensure_whole().await;
            self.start_conflict_task();
        }
        if self.split.is_some() {
            self.evict_parts().await;
            self.release_whole().await;
        }
        if self.mentions.as_ref().is_some_and(|m| m.has_pending())
            && now - self.last_update >= MENTION_SETTLE
        {
            self.flush_mentions().await;
        }
        self.flush_events(false);
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
        for ev in &events {
            let mut data = json!({"mentioned": ev.mentioned, "by": ev.by});
            if let Some(b) = &ev.block_id {
                data["blockId"] = json!(b);
            }
            if let Some(t) = &ev.thread_id {
                data["threadId"] = json!(t);
            }
            self.emit(crate::events::MENTIONED, data);
        }
        if events.is_empty() || !self.notify || self.callback_token.is_empty() {
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
        // PSYNC-02: a split room dumps its written parts; a whole view waits for its split.
        if !self.dump_parts() {
            self.last_compact = Instant::now();
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
        self.dump_result(seq, result);
    }

    fn dump_result(&mut self, seq: i64, result: Result<(), super::DumpError>) {
        match result {
            Ok(()) => self.compacted_seq = self.compacted_seq.max(seq),
            Err(super::DumpError::Fenced(e)) => self.fail(&e, "state dump failed"),
            Err(super::DumpError::Other(e)) => {
                tracing::error!(room = %self.id, error = %e, "state dump failed")
            }
        }
    }

    async fn compact(&mut self) {
        // A whole view's updates are in the parts' rows: the main snapshot waits for the split.
        if self.split.as_ref().is_some_and(|s| s.whole_since.is_some()) {
            self.last_compact = Instant::now();
            return;
        }
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

    /// The commit to send: the pending outbox row when it still matches the doc (`Ok`), else
    /// the build of a new one (`Err`), taken from the room so it can run off the actor.
    async fn save_build(&mut self, dump: bool) -> Result<Result<Pending, SaveBuild>, String> {
        // PSYNC-02: a save flattens the parts (format v1, item ids kept).
        if !self.ensure_whole().await {
            return Err("the canvas parts could not be merged".into());
        }
        if let Some(p) = &self.save.pending
            && p.seq == self.seq
            && self.next_meta.is_none()
        {
            if !self.revoked_tokens.contains(&p.token) {
                return Ok(Ok(p.clone()));
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
        let mut meta = self.next_meta.take().unwrap_or_default();
        // docs/30 §4: the last save of a room, the first after `checkpoint_every` of editing,
        // and every named or restore save are checkpoints.
        meta.checkpoint = meta.checkpoint
            || meta.kind != oc_model::ocanvas::CommitKind::Auto
            || self.peers.is_empty()
            || self.last_checkpoint.elapsed() >= self.ctx.cfg.checkpoint_every;
        if meta.checkpoint {
            self.last_checkpoint = Instant::now();
        }
        let commit = oc_model::CommitInfo {
            id: id.clone(),
            authors: authors.clone(),
            at: rfc3339(now_ms()),
            kind: meta.kind,
            message: meta.message.clone(),
            restored_from: meta.restored_from.clone(),
        };
        let state = self
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        self.doc_bytes = state.len();
        let row = OutboxRow {
            id,
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
            payload: Vec::new(),
            authors,
            attempts: 0,
            status: "pending".into(),
        };
        if dump {
            self.last_compact = Instant::now();
        }
        Ok(Err(SaveBuild {
            state,
            commit,
            meta,
            history: self
                .host
                .file_history()
                .map(|limits| (limits, self.file_hist.take())),
            search: self.host.search().model_options(),
            row,
            epoch: self.epoch,
            dump,
            host: self.host.clone(),
        }))
    }

    /// Takes a finished build back: the in-file history, the dump, the pending row.
    fn take_built(&mut self, b: SaveBuilt) -> Result<Pending, String> {
        if let Some(h) = b.file_hist {
            self.file_hist = Some(h);
        }
        if let Some(r) = b.dumped {
            self.dump_result(b.seq, r);
        }
        match b.pending {
            Ok(p) => {
                self.save.pending = Some(p.clone());
                Ok(p)
            }
            Err((msg, err)) => {
                if let Some(e) = err.filter(crate::store::is_fenced) {
                    self.fail(&e, "writing the commit outbox failed");
                }
                Err(msg)
            }
        }
    }

    /// The commit to send, built in place (role changes and shutdown wait for it).
    async fn prepare_save(&mut self) -> Result<Pending, String> {
        match self.save_build(false).await? {
            Ok(p) => Ok(p),
            Err(build) => {
                let built = build.run(self.ctx.clone()).await;
                self.take_built(built)
            }
        }
    }

    async fn start_save(&mut self) {
        // Memory durability: the database holds this state before the host is asked to; the
        // dump runs with the build, off the actor.
        let dump = self.memory && self.seq > self.compacted_seq;
        match self.save_build(dump).await {
            Ok(Ok(pending)) => self.send_save(pending),
            Ok(Err(build)) => {
                // In flight from now on: no second save starts while this one builds.
                self.save.in_flight = true;
                let (ctx, tx) = (self.ctx.clone(), self.self_tx.clone());
                tokio::spawn(async move {
                    let built = build.run(ctx).await;
                    let _ = tx.send(Cmd::SaveBuilt(Box::new(built)));
                });
            }
            Err(e) => self.save_not_started(e),
        }
    }

    /// A background build came back: send it, or retry with the save backoff.
    fn save_built(&mut self, b: SaveBuilt) {
        self.save.in_flight = false;
        let res = self.take_built(b);
        if self.lost.is_some() {
            return;
        }
        match res {
            Ok(p) => self.send_save(p),
            Err(e) => self.save_not_started(e),
        }
    }

    fn save_not_started(&mut self, e: String) {
        // Loud, and retried with the save backoff (not on every tick).
        tracing::error!(room = %self.id, error = %e, "save not started");
        Metrics::inc(&self.ctx.metrics.save_errors_total);
        let delay = backoff(self.save.attempt);
        self.save.attempt += 1;
        self.save.retry_at = Some(Instant::now() + Duration::from_secs(delay));
        if self.lost.is_none() {
            self.set_status(json!({"t": "save_error", "retryInMs": delay * 1000, "message": e}));
        }
    }

    fn send_save(&mut self, pending: Pending) {
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
            meta: p.meta.clone(),
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
                self.flush_events(true);
                self.emit(crate::events::SAVED, json!({"version": self.host_version}));
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
                    ..Default::default()
                };
                // ADR-067: a copy keeps its automation rules switched off and ownerless.
                let copy = oc_model::new_doc();
                let _ = oc_model::ocanvas::apply_update_bytes(
                    &copy,
                    &oc_model::ocanvas::encode_state(&self.doc),
                );
                oc_model::automation::disable_all(&copy);
                match oc_model::ocanvas::write_ocanvas_opts(
                    &copy,
                    &commit,
                    None,
                    self.host.search().model_options(),
                ) {
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
                let (doc, etag) = match loaded_from_host(&self.id, fetched) {
                    Ok((d, e, h)) => {
                        self.file_hist = Some(h);
                        (d, e)
                    }
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
        self.mentions = Some(super::mentions::Tracker::new(&doc));
        self.watch = super::changes::Watch::attach(&doc);
        self.edits = Default::default();
        self.comment_counts = super::changes::comment_counts(&doc);
        self.comments_dirty = false;
        self.comment_by.clear();
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
        if self.split.take().is_some()
            && let Err(e) = self.split_on_open().await
        {
            tracing::error!(room = %self.id, error = %e, "splitting the reloaded version failed; the room stays whole");
        }
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
                // A save still building: send it now (or give up and save below).
                Ok(Some(Cmd::SaveBuilt(b))) => self.save_built(*b),
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
    meta: SaveMeta,
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
                meta: &self.meta,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// PERF-11: a save is built from a snapshot of the room's state, off the actor. The body
    /// (and the in-file history it carries) must be exactly what the live document gives.
    #[test]
    fn a_save_built_from_a_snapshot_equals_one_built_from_the_live_doc() {
        let doc = oc_model::new_doc();
        {
            let m = doc.get_or_insert_map("meta");
            let mut t = doc.transact_mut();
            m.insert(&mut t, "title", "Plan");
            m.insert(&mut t, "n", 3);
        }
        let commit = oc_model::CommitInfo {
            id: "c1".into(),
            authors: vec!["u1".into()],
            at: "2026-11-26T00:00:00Z".into(),
            ..Default::default()
        };
        let meta = SaveMeta::default();
        let limits = crate::hosts::FileHistoryLimits {
            max_bytes: 1 << 20,
            max_versions: 10,
        };
        let opts = oc_model::search::Options::default();
        let mut live_hist = FileHist::from_file(&doc, None);
        let mut snap_hist = FileHist::from_file(&doc, None);
        let live =
            build_save_body(&doc, &commit, &meta, Some((limits, &mut live_hist)), opts).unwrap();
        let state = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let copy = doc_from_state(&state).unwrap();
        let snap =
            build_save_body(&copy, &commit, &meta, Some((limits, &mut snap_hist)), opts).unwrap();
        assert_eq!(live, snap);
        assert_eq!(live_hist.prev, snap_hist.prev);
    }
}
