//! The room actor: owns the Y.Doc, peers, WAL, autosave and awareness for one file.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use anyhow::Context;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use yrs::encoding::read::Cursor;
use yrs::sync::protocol::MessageReader;
use yrs::sync::{Awareness, AwarenessUpdate, Message, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::{ClientID, Doc, ReadTxn, StateVector, Transact, Update};

use super::{Cmd, ConflictOutcome, ConnId, Ctx, Outbound, RoomInfo, Rooms, filter, protocol};
use crate::grant::{Grant, Role};
use crate::host_client::{Fetched, PutOutcome, PutRequest};
use crate::hosts::{ConflictPolicy, HostConfig};
use crate::metrics::Metrics;
use crate::store::OutboxRow;
use crate::util::{now_ms, rfc3339};

const BACKOFF_SECS: [u64; 4] = [1, 2, 5, 10];
const MAX_AWARENESS_BYTES: usize = 2048;

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
                None => break None,
                Some(Cmd::Shutdown { by_host, reply }) => break Some((by_host, reply)),
                Some(cmd) => room.handle(cmd).await,
            },
            _ = tick.tick() => if room.tick().await { break None },
        }
    };
    match shutdown {
        Some((by_host, reply)) => {
            room.shutdown(&mut rx, by_host).await;
            if let Some(r) = rooms.upgrade() {
                r.remove(&id, generation);
            }
            let _ = reply.send(());
        }
        None => {
            if let Err(e) = ctx.store.purge_room(&id).await {
                tracing::warn!(room = %id, error = %e, "purge failed");
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
        Ok(Self {
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
            } => self.join(conn, grant, tx, reply),
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
            Cmd::Shutdown { .. } => unreachable!("handled by run loop"),
        }
    }

    fn send(&self, conn: ConnId, frame: Vec<u8>) {
        if let Some(p) = self.peers.get(&conn) {
            let _ = p.tx.send(Outbound::Frame(frame));
        }
    }

    fn broadcast(&self, frame: &[u8], except: Option<ConnId>) {
        for (id, p) in &self.peers {
            if Some(*id) != except {
                let _ = p.tx.send(Outbound::Frame(frame.to_vec()));
            }
        }
    }

    fn set_status(&mut self, status: Value) {
        self.broadcast(&protocol::control(&status), None);
        if status["t"] != "saving" {
            self.status = status;
        }
    }

    fn join(
        &mut self,
        conn: ConnId,
        grant: Arc<Grant>,
        tx: mpsc::UnboundedSender<Outbound>,
        reply: tokio::sync::oneshot::Sender<()>,
    ) {
        if grant.can_write() && !grant.callback_token.is_empty() {
            self.callback_token = grant.callback_token.clone();
        }
        let sv = self.doc.transact().state_vector();
        let _ = tx.send(Outbound::Frame(protocol::step1(sv)));
        if let Ok(update) = self.awareness.update()
            && !update.clients.is_empty()
        {
            let _ = tx.send(Outbound::Frame(protocol::awareness(update)));
        }
        self.peers.insert(
            conn,
            Peer {
                grant,
                tx,
                clients: HashSet::new(),
                denied: false,
                synced: false,
            },
        );
        self.idle_since = None;
        let _ = reply.send(());
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
                self.broadcast(&protocol::awareness(update), None);
            }
        }
        if self.peers.is_empty() {
            self.idle_since = Some(Instant::now());
        }
    }

    /// Host role API (docs/05 §7): switch the role filter live, or disconnect on revoke.
    fn set_role(&mut self, user_id: &str, role: Option<Role>) -> usize {
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
                        let _ = p.tx.send(Outbound::Frame(protocol::control(&closed)));
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
                    let _ = p.tx.send(Outbound::Frame(protocol::control(&msg)));
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
                Message::AwarenessQuery => {
                    if let Ok(update) = self.awareness.update() {
                        self.send(conn, protocol::awareness(update));
                    }
                }
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
            let _ = peer.tx.send(Outbound::Frame(protocol::denied(reason)));
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
        self.doc_bytes += bytes.len();
        self.seq += 1;
        if let Err(e) = self
            .ctx
            .store
            .append_update(&self.id, self.seq, &bytes, &grant.user.id, now_ms())
            .await
        {
            tracing::error!(room = %self.id, error = %e, "WAL append failed");
        }
        self.broadcast(&protocol::update(bytes), Some(conn));
        Metrics::inc(&self.ctx.metrics.updates_total);
        self.last_update = Instant::now();
        self.contributors.insert(grant.user.id.clone());
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
        update.clients.retain(|client, entry| {
            if foreign.contains(client) || entry.json.len() > MAX_AWARENESS_BYTES {
                return false;
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
            self.broadcast(&protocol::awareness(update), Some(conn));
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

    async fn compact(&mut self) {
        let state = self
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        self.doc_bytes = state.len();
        match self
            .ctx
            .store
            .compact(&self.id, self.seq, &state, now_ms())
            .await
        {
            Ok(()) => self.compacted_seq = self.seq,
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
        if let Err(e) = self.ctx.store.outbox_insert(&row, now_ms()).await {
            tracing::error!(room = %self.id, error = %e, "writing the commit outbox failed");
        }
        let pending = Pending::from(row);
        self.save.pending = Some(pending.clone());
        Ok(pending)
    }

    async fn start_save(&mut self) {
        let pending = match self.prepare_save().await {
            Ok(p) => p,
            Err(e) => {
                tracing::error!(room = %self.id, error = %e, "building .ocanvas failed");
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
        let conflict = protocol::control(&json!({"t": "conflict", "policy": "reload"}));
        let closed = protocol::control(
            &json!({"t": "closed", "reason": "the file changed elsewhere; reloading"}),
        );
        for p in self.peers.values() {
            let _ = p.tx.send(Outbound::Frame(conflict.clone()));
            let _ = p.tx.send(Outbound::Frame(closed.clone()));
            let _ = p.tx.send(Outbound::Close(1012, "reload".into()));
        }
        self.peers.clear();
        self.idle_since = Some(Instant::now());
        tracing::info!(room = %self.id, version = ?self.host_version, "conflict: reloaded the host version");
    }

    /// SIGTERM or host close: wait for an in-flight save, make a final one if still dirty,
    /// then close peers.
    async fn shutdown(&mut self, rx: &mut mpsc::UnboundedReceiver<Cmd>, by_host: bool) {
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
        let (reason, code) = if by_host {
            ("closed by the host", 1000)
        } else {
            ("server shutting down", 1012)
        };
        let closed = protocol::control(&json!({"t": "closed", "reason": reason}));
        for p in self.peers.values() {
            let _ = p.tx.send(Outbound::Frame(closed.clone()));
            let _ = p.tx.send(Outbound::Close(code, reason.into()));
        }
        if self.dirty_since.is_none() {
            let _ = self.ctx.store.purge_room(&self.id).await;
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
