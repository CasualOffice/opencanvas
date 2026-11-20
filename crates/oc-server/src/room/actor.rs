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

use super::{Cmd, ConnId, Ctx, Outbound, RoomInfo, Rooms, filter, protocol};
use crate::grant::{Grant, Role};
use crate::host_client::{Fetched, PutOutcome, PutRequest};
use crate::hosts::HostConfig;
use crate::metrics::Metrics;
use crate::util::{now_ms, rfc3339};

const BACKOFF_SECS: [u64; 4] = [1, 2, 5, 10];
const MAX_AWARENESS_BYTES: usize = 2048;

struct Peer {
    grant: Arc<Grant>,
    tx: mpsc::UnboundedSender<Outbound>,
    clients: HashSet<ClientID>,
    denied: bool,
    synced: bool,
}

#[derive(Default)]
struct SaveState {
    in_flight: bool,
    attempt: u32,
    retry_at: Option<Instant>,
    conflict: bool,
    key: Option<(String, i64)>,
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
    save: SaveState,
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
                Some(Cmd::Shutdown { reply }) => break Some(reply),
                Some(cmd) => room.handle(cmd).await,
            },
            _ = tick.tick() => if room.tick().await { break None },
        }
    };
    match shutdown {
        Some(reply) => {
            room.shutdown(&mut rx).await;
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

impl Room {
    async fn load(
        ctx: Arc<Ctx>,
        host: Arc<HostConfig>,
        seed: &Grant,
        self_tx: mpsc::UnboundedSender<Cmd>,
    ) -> anyhow::Result<Self> {
        let id = seed.room.clone();
        let row = ctx.store.room(&id).await?;
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
        } else {
            ctx.store.purge_room(&id).await?;
            match ctx
                .host
                .get_file(&host, &seed.callback_token, &seed.file.id)
                .await?
            {
                Fetched::Missing => {}
                Fetched::Found {
                    bytes,
                    content_type,
                    etag,
                } => {
                    if oc_model::ocanvas::is_zip(&bytes) {
                        doc = oc_model::read_ocanvas(&bytes)?.doc;
                    } else {
                        if !content_type.starts_with("text/") && !content_type.is_empty() {
                            tracing::debug!(room = %id, %content_type, "loading non-zip file as text");
                        }
                        oc_model::import::apply_markdown(&doc, &String::from_utf8_lossy(&bytes));
                    }
                    host_version = etag.or(host_version);
                }
            }
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
        let status = json!({"t": "saved", "at": now_ms(), "version": host_version});
        Ok(Self {
            awareness: Awareness::new(doc.clone()),
            doc,
            id,
            file_id: seed.file.id.clone(),
            host,
            peers: HashMap::new(),
            host_version,
            dirty_since,
            last_update: Instant::now(),
            contributors: BTreeSet::new(),
            callback_token: seed.callback_token.clone(),
            seq,
            compacted_seq: seq,
            last_compact: Instant::now(),
            save: SaveState::default(),
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
            Cmd::SaveDone { seq, result } => self.save_done(seq, result).await,
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
                Message::Custom(protocol::MSG_CONTROL, body) => {
                    tracing::debug!(room = %self.id, conn, bytes = body.len(), "client control message ignored");
                }
                Message::Auth(_) | Message::Custom(..) => {}
            }
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
        match grant.role {
            Role::View => return self.deny(conn, "read-only session"),
            Role::Comment if !filter::touches_only_comments(&self.doc, &bytes) => {
                return self.deny(conn, "comment role may only change comments");
            }
            _ => {}
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
            txn.has_changes() || txn.store().pending_update().is_some()
        };
        if !changed {
            return;
        }
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
            && !self.save.conflict
            && self.save.retry_at.is_none_or(|t| now >= t)
            && (self.peers.is_empty()
                || now - self.last_update >= cfg.autosave_debounce
                || now - since >= cfg.autosave_max)
        {
            self.start_save();
        }
        if self.seq > self.compacted_seq
            && (self.seq - self.compacted_seq >= cfg.compact_every as i64
                || self.last_compact.elapsed() >= cfg.compact_interval)
        {
            self.compact().await;
        }
        self.peers.is_empty()
            && !self.save.in_flight
            && (self.dirty_since.is_none() || self.save.conflict)
            && self.idle_since.is_some_and(|t| now - t >= cfg.room_ttl)
    }

    async fn compact(&mut self) {
        let state = self
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
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

    fn prepare_save(&mut self) -> Result<(PutPayload, i64), String> {
        let key = match &self.save.key {
            Some((k, s)) if *s == self.seq => k.clone(),
            _ => ulid::Ulid::new().to_string(),
        };
        self.save.key = Some((key.clone(), self.seq));
        let authors: Vec<String> = self.contributors.iter().cloned().collect();
        let commit = oc_model::CommitInfo {
            id: key.clone(),
            authors: authors.clone(),
            at: rfc3339(now_ms()),
        };
        let body = oc_model::write_ocanvas(&self.doc, &commit).map_err(|e| e.to_string())?;
        Ok((
            PutPayload {
                host: self.host.clone(),
                token: self.callback_token.clone(),
                file_id: self.file_id.clone(),
                if_match: self.host_version.clone(),
                key,
                authors,
                body,
            },
            self.seq,
        ))
    }

    fn start_save(&mut self) {
        let (payload, seq) = match self.prepare_save() {
            Ok(p) => p,
            Err(e) => {
                tracing::error!(room = %self.id, error = %e, "building .ocanvas failed");
                return;
            }
        };
        self.save.in_flight = true;
        self.set_status(json!({"t": "saving"}));
        let ctx = self.ctx.clone();
        let tx = self.self_tx.clone();
        tokio::spawn(async move {
            let result = payload.send(&ctx).await;
            let _ = tx.send(Cmd::SaveDone { seq, result });
        });
    }

    async fn save_done(&mut self, seq: i64, result: Result<PutOutcome, String>) {
        self.save.in_flight = false;
        match result {
            Ok(PutOutcome::Saved { version }) => {
                Metrics::inc(&self.ctx.metrics.saves_total);
                self.host_version = version.or(self.host_version.take());
                self.save.attempt = 0;
                self.save.retry_at = None;
                let clean = self.seq == seq;
                if clean {
                    self.dirty_since = None;
                    self.contributors.clear();
                } else {
                    self.dirty_since = Some(Instant::now());
                }
                if let Err(e) = self
                    .ctx
                    .store
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
                tracing::warn!(room = %self.id, "host reported a conflict; autosave stopped");
                self.save.conflict = true;
                self.set_status(json!({"t": "conflict"}));
            }
            Err(message) => {
                Metrics::inc(&self.ctx.metrics.save_errors_total);
                let delay = BACKOFF_SECS[(self.save.attempt as usize).min(BACKOFF_SECS.len() - 1)];
                self.save.attempt += 1;
                self.save.retry_at = Some(Instant::now() + Duration::from_secs(delay));
                tracing::warn!(room = %self.id, error = %message, retry_in = delay, "save failed");
                self.set_status(
                    json!({"t": "save_error", "retryInMs": delay * 1000, "message": message}),
                );
            }
        }
    }

    /// SIGTERM: wait for an in-flight save, make a final one if still dirty, then close peers.
    async fn shutdown(&mut self, rx: &mut mpsc::UnboundedReceiver<Cmd>) {
        while self.save.in_flight {
            match tokio::time::timeout(Duration::from_secs(15), rx.recv()).await {
                Ok(Some(Cmd::SaveDone { seq, result })) => self.save_done(seq, result).await,
                Ok(Some(_)) => {}
                _ => break,
            }
        }
        if self.dirty_since.is_some()
            && !self.save.conflict
            && let Ok((payload, seq)) = self.prepare_save()
        {
            self.set_status(json!({"t": "saving"}));
            let result = payload.send(&self.ctx).await;
            self.save_done(seq, result).await;
        }
        if self.seq > self.compacted_seq {
            self.compact().await;
        }
        let closed = protocol::control(&json!({"t": "closed", "reason": "server shutting down"}));
        for p in self.peers.values() {
            let _ = p.tx.send(Outbound::Frame(closed.clone()));
            let _ = p.tx.send(Outbound::Close(1012, "server restart".into()));
        }
        if self.dirty_since.is_none() || self.save.conflict {
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
    body: Vec<u8>,
}

impl PutPayload {
    async fn send(self, ctx: &Ctx) -> Result<PutOutcome, String> {
        let req = PutRequest {
            file_id: &self.file_id,
            body: self.body,
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
