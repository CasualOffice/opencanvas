// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! One actor per live room (host, file); the manager hands out handles and restarts closed rooms.

mod actor;
pub mod changes;
pub mod filter;
pub mod mentions;
pub mod presence;
pub mod protocol;
mod remote;

pub use actor::EPHEMERAL_CLOSED;
pub use remote::RemoteOp;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use bytes::Bytes;
use std::time::{Duration, Instant};

use anyhow::anyhow;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;

use crate::cluster::lease::{Claim, Owner};
use crate::cluster::{Cluster, RemoteError, relay};
use crate::config::RoomConfig;
use crate::grant::{Grant, Role};
use crate::host_client::{Fetched, HostClient, PutOutcome};
use crate::hosts::HostConfig;
use crate::metrics::Metrics;
use crate::store::Store;

pub type ConnId = u64;

#[derive(Debug)]
pub enum Outbound {
    /// One frame, shared (not copied) between every peer it is fanned out to.
    Frame(Bytes),
    Close(u16, String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomInfo {
    pub is_new: bool,
}

/// Why a background dump failed: fenced (another owner) or anything else.
#[derive(Debug)]
pub(crate) enum DumpError {
    Fenced(anyhow::Error),
    Other(String),
}

pub(crate) enum Cmd {
    Join {
        conn: ConnId,
        grant: Arc<Grant>,
        tx: mpsc::UnboundedSender<Outbound>,
        reply: oneshot::Sender<()>,
    },
    Leave {
        conn: ConnId,
    },
    Frame {
        conn: ConnId,
        data: Vec<u8>,
        /// The inbox slot this frame holds (local rooms); freed once the room handled it.
        permit: Option<tokio::sync::OwnedSemaphorePermit>,
    },
    Info {
        reply: oneshot::Sender<RoomInfo>,
    },
    State {
        reply: oneshot::Sender<Vec<u8>>,
    },
    SaveDone {
        id: String,
        result: Result<PutOutcome, String>,
    },
    ConflictDone {
        result: Result<ConflictOutcome, String>,
    },
    /// A background state dump (memory durability, ADR-029) finished.
    Dumped {
        seq: i64,
        result: Result<(), DumpError>,
    },
    /// Live role change from the host; `None` revokes access. Replies with the number of
    /// connections affected.
    SetRole {
        user_id: String,
        role: Option<Role>,
        reply: oneshot::Sender<usize>,
    },
    /// Host patch API: apply block ops as one transaction with origin `api:<author>`.
    Patch {
        ops: Vec<oc_model::patch::PatchOp>,
        author: String,
        reply: oneshot::Sender<Result<Patched, PatchFailure>>,
    },
    /// Team template (TPL-01): replace the content with the prepared template as one
    /// transaction with origin `origin`, tracked so [`Cmd::TemplateUndo`] can revert it.
    Template {
        doc: serde_json::Value,
        origin: String,
        author: String,
        reply: oneshot::Sender<Result<Patched, PatchFailure>>,
    },
    /// Version history writes (VH-01b); answers JSON.
    History {
        op: HistoryOp,
        author: String,
        reply: oneshot::Sender<serde_json::Value>,
    },
    /// DGM-17 (ADR-057): a change to the server-written `icons` root, origin `icons`.
    Icons {
        op: oc_model::doc_icons::IconOp,
        author: String,
        reply: oneshot::Sender<Result<Patched, PatchFailure>>,
    },
    /// Revert the template applied with `origin` (only by the user who applied it).
    TemplateUndo {
        origin: String,
        reply: oneshot::Sender<Result<Patched, PatchFailure>>,
    },
    /// Canvas tool call (docs/24 §5): `run` reads the live doc and returns an optional update
    /// (computed on a scratch copy) plus the tool's answer. The update is applied with origin
    /// `origin` as one transaction and handled exactly like a client update.
    Tool {
        run: ToolFn,
        origin: String,
        author: String,
        reply: oneshot::Sender<Result<serde_json::Value, crate::ai::tools::ToolError>>,
    },
    /// Host commit API: save now and answer once the host acknowledged (or it failed).
    Commit {
        reply: oneshot::Sender<CommitResult>,
    },
    /// AI run port (docs/24 §10.5): the user's current role.
    AiRole {
        user_id: String,
        reply: oneshot::Sender<Option<Role>>,
    },
    /// Agent presence at a block (`None` block: in the canvas), or gone (`active` false).
    AiPresence {
        run_id: String,
        block_id: Option<String>,
        active: bool,
    },
    /// Track transactions with this origin for run undo.
    AiTrack {
        origin: String,
    },
    /// Revert every tracked change with this origin.
    AiUndo {
        origin: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Cluster: the lease went to another node. Tell clients to reconnect and stop without
    /// saving (the new owner continues from the WAL).
    StepDown,
    /// Final save, then close every connection. `by_host` = `DELETE /v1/files/:id/session`.
    Shutdown {
        by_host: bool,
        reply: oneshot::Sender<()>,
    },
}

/// A tool step run inside the room actor: `(update, answer)`.
pub type ToolFn = Box<
    dyn FnOnce(
            &yrs::Doc,
        ) -> Result<(Option<Vec<u8>>, serde_json::Value), crate::ai::tools::ToolError>
        + Send,
>;

#[derive(Debug)]
pub struct Patched {
    /// `blockId`s of the inserted top-level blocks.
    pub block_ids: Vec<String>,
}

#[derive(Debug)]
pub enum PatchFailure {
    Invalid(oc_model::patch::PatchError),
    /// The patched document would exceed `OC_MAX_DOC_MB`.
    TooLarge,
    /// The room is handling a save conflict and is read-only.
    Conflict,
    /// The update could not be made durable (WAL write failed, or the room moved to another
    /// node); nothing was applied for clients. Retry.
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CommitResult {
    /// The host acknowledged a save made for this request.
    Saved { version: Option<String> },
    /// Nothing to save; `version` is the last known host version.
    Clean { version: Option<String> },
    /// The save failed and stays queued in the outbox (retried with backoff).
    Queued { message: String },
    /// The host answered 409; the conflict policy runs and the room is read-only.
    Conflict,
}

/// Version history writes (VH-01b, docs/30 §4-5), run by the room that owns the canvas.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HistoryOp {
    /// A checkpoint save now, even when nothing changed; `name` makes it a named version.
    Save { name: Option<String> },
    /// Apply `target` (an older version's `document.json`) as one edit that the restoring
    /// person can undo, then save it as a restore version named `name`.
    Restore {
        target: serde_json::Value,
        from: String,
        name: String,
        restore_id: String,
        by_name: String,
    },
    /// Undo the restore `restore_id` made by the same person, within the undo window.
    Undo { restore_id: String },
}

pub(crate) enum ConflictOutcome {
    Copied { file_id: String, url: String },
    Reloaded(Fetched),
}

pub struct Ctx {
    pub store: Store,
    pub host: HostClient,
    pub cfg: RoomConfig,
    pub metrics: Arc<Metrics>,
    /// Server-side AI (docs/24, ADR-031/034); `None` when `[ai]` is off.
    pub ai: Option<Arc<crate::ai::agent::AiRuntime>>,
    /// Change events (HAPI-05): rooms publish here; streams and webhooks read.
    pub events: Arc<crate::events::Hub>,
}

struct Entry {
    generation: u64,
    tx: mpsc::UnboundedSender<Cmd>,
    inbox: Arc<presence::Inbox>,
    abort: AbortHandle,
}

/// Cluster: the room is owned by another node and this call may not be forwarded.
#[derive(Debug, thiserror::Error)]
#[error("room {0} is owned by another node")]
pub struct NotOwner(pub String);

/// Where a room's actor runs.
enum Placement {
    Local(mpsc::UnboundedSender<Cmd>, Arc<presence::Inbox>),
    Remote(Owner),
}

/// How long a call keeps looking for the room's owner (covers a full lease expiry).
const PLACE_DEADLINE: Duration = Duration::from_secs(30);
const RETRY: Duration = Duration::from_millis(200);

pub struct Rooms {
    ctx: Arc<Ctx>,
    map: Mutex<HashMap<String, Entry>>,
    generation: AtomicU64,
    next_conn: AtomicU64,
    me: Weak<Rooms>,
    cluster: OnceLock<Arc<Cluster>>,
    draining: AtomicBool,
    /// Client connections relayed to another node's room (told to reconnect on drain).
    relays: Mutex<HashMap<ConnId, mpsc::UnboundedSender<Outbound>>>,
}

/// A joined connection: frames go in through `send`, `Drop` leaves the room.
pub struct Membership {
    pub conn: ConnId,
    tx: mpsc::UnboundedSender<Cmd>,
    /// The local room's bounded inbox (`None`: relayed to the owner, which bounds it there).
    inbox: Option<Arc<presence::Inbox>>,
}

impl Membership {
    /// Hands a client frame to the room. When the room's inbox is full, a Yjs update waits
    /// for room (back-pressure on the client's socket; never dropped) and an awareness frame
    /// replaces this connection's parked one instead (latest wins; docs/22 §8 weakness 1).
    pub async fn send(&self, data: Vec<u8>) {
        let permit = match &self.inbox {
            None => None,
            Some(inbox) if data.first() == Some(&protocol::MSG_AWARENESS) => {
                match inbox.permits.clone().try_acquire_owned() {
                    Ok(p) => Some(p),
                    Err(_) => return inbox.park(self.conn, data),
                }
            }
            Some(inbox) => inbox.permits.clone().acquire_owned().await.ok(),
        };
        self.push(data, permit);
    }

    /// Like [`send`](Self::send) but never waits: an update that finds the inbox full is
    /// queued without a slot. For tests and tools, not for client sockets.
    pub fn try_send(&self, data: Vec<u8>) {
        let permit = self
            .inbox
            .as_ref()
            .and_then(|i| i.permits.clone().try_acquire_owned().ok());
        self.push(data, permit);
    }

    fn push(&self, data: Vec<u8>, permit: Option<tokio::sync::OwnedSemaphorePermit>) {
        let _ = self.tx.send(Cmd::Frame {
            conn: self.conn,
            data,
            permit,
        });
    }
}

impl Drop for Membership {
    fn drop(&mut self) {
        let _ = self.tx.send(Cmd::Leave { conn: self.conn });
    }
}

impl Rooms {
    pub fn new(ctx: Arc<Ctx>) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            ctx,
            map: Mutex::default(),
            generation: AtomicU64::new(1),
            next_conn: AtomicU64::new(1),
            me: me.clone(),
            cluster: OnceLock::new(),
            draining: AtomicBool::new(false),
            relays: Mutex::default(),
        })
    }

    pub fn ctx(&self) -> &Arc<Ctx> {
        &self.ctx
    }

    /// Switches this registry to cluster mode (once, before serving).
    pub fn set_cluster(&self, cluster: Arc<Cluster>) {
        let _ = self.cluster.set(cluster);
    }

    pub fn cluster(&self) -> Option<&Arc<Cluster>> {
        self.cluster.get()
    }

    pub fn draining(&self) -> bool {
        self.draining.load(Ordering::SeqCst)
    }

    fn sender(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
    ) -> (mpsc::UnboundedSender<Cmd>, Arc<presence::Inbox>) {
        let mut map = self.map.lock().expect("rooms lock");
        if let Some(e) = map.get(&grant.room).filter(|e| !e.tx.is_closed()) {
            return (e.tx.clone(), e.inbox.clone());
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let inbox = Arc::new(presence::Inbox::default());
        let generation = self.generation.fetch_add(1, Ordering::Relaxed);
        let task = tokio::spawn(actor::run(
            self.ctx.clone(),
            self.me.clone(),
            generation,
            host.clone(),
            grant.clone(),
            actor::Channels {
                self_tx: tx.clone(),
                rx,
                inbox: inbox.clone(),
            },
        ));
        map.insert(
            grant.room.clone(),
            Entry {
                generation,
                tx: tx.clone(),
                inbox: inbox.clone(),
                abort: task.abort_handle(),
            },
        );
        (tx, inbox)
    }

    /// Finds (or becomes) the room's owner. Single node: always local. Cluster: the actor
    /// starts only while this node holds the lease; `forward = false` (a call that another
    /// node already forwarded here) fails with [`NotOwner`] instead of pointing elsewhere.
    async fn place(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        forward: bool,
    ) -> anyhow::Result<Placement> {
        if self.draining() {
            anyhow::bail!("server is draining");
        }
        let Some(c) = self.cluster() else {
            let (tx, inbox) = self.sender(host, grant);
            return Ok(Placement::Local(tx, inbox));
        };
        let _gate = c.leases.gate().await;
        match c.leases.claim(&grant.room).await? {
            Claim::Mine => {
                let (tx, inbox) = self.sender(host, grant);
                Ok(Placement::Local(tx, inbox))
            }
            Claim::Held(o) if forward => Ok(Placement::Remote(o)),
            Claim::Held(_) => Err(NotOwner(grant.room.clone()).into()),
        }
    }

    /// The owner did not answer: take the room over when its process is gone, else wait a
    /// moment (it may be handing the room over).
    async fn owner_failed(&self, room: &str, owner: &Owner, why: &str) {
        let Some(c) = self.cluster() else { return };
        if c.alive(owner).await {
            tokio::time::sleep(RETRY).await;
            return;
        }
        let _gate = c.leases.gate().await;
        match c.leases.steal(room, owner).await {
            Ok(true) => {
                tracing::warn!(room = %room, dead = %owner.node, reason = %why, "owner unreachable; took the room over")
            }
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(room = %room, error = %e, "lease takeover failed");
                tokio::time::sleep(RETRY).await;
            }
        }
    }

    /// Runs a room request on the owner: the local actor (reopened if it closed in between),
    /// or the owning node over the internal API.
    async fn ask<T>(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        forward: bool,
        make: impl Fn(oneshot::Sender<T>) -> Cmd,
        remote: impl Fn() -> RemoteOp,
        decode: impl Fn(serde_json::Value) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let deadline = Instant::now() + PLACE_DEADLINE;
        let mut local_tries = 0;
        let mut last = String::from("room unavailable");
        while Instant::now() < deadline {
            match self.place(host, grant, forward).await {
                Ok(Placement::Local(tx, _)) => {
                    local_tries += 1;
                    let (reply, rx) = oneshot::channel();
                    if tx.send(make(reply)).is_ok() {
                        match tokio::time::timeout(Duration::from_secs(30), rx).await {
                            Ok(Ok(v)) => return Ok(v),
                            Ok(Err(_)) => {}
                            Err(_) => return Err(anyhow!("room did not answer")),
                        }
                    }
                    if local_tries >= 3 {
                        return Err(anyhow!(
                            "room unavailable (could not load the file from the host)"
                        ));
                    }
                }
                Ok(Placement::Remote(owner)) => {
                    let c = self.cluster().expect("remote implies cluster");
                    match c.call(&owner, &grant.room, &remote()).await {
                        Ok(v) => return decode(v),
                        Err(RemoteError::Moved) => tokio::time::sleep(RETRY).await,
                        Err(RemoteError::Unreachable(e)) => {
                            self.owner_failed(&grant.room, &owner, &e).await
                        }
                        Err(RemoteError::Failed(e)) => return Err(anyhow!(e)),
                    }
                }
                Err(e) if e.is::<NotOwner>() || self.draining() => return Err(e),
                Err(e) => {
                    last = e.to_string();
                    tokio::time::sleep(RETRY).await;
                }
            }
        }
        Err(anyhow!(last))
    }

    pub async fn info(&self, host: &Arc<HostConfig>, grant: &Grant) -> anyhow::Result<RoomInfo> {
        self.info_at(host, grant, true).await
    }

    async fn info_at(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        forward: bool,
    ) -> anyhow::Result<RoomInfo> {
        self.ask(
            host,
            grant,
            forward,
            |reply| Cmd::Info { reply },
            || RemoteOp::Info {
                grant: grant.clone(),
            },
            remote::decode,
        )
        .await
    }

    /// Full Yjs state of the room as a v1 update.
    pub async fn state(&self, host: &Arc<HostConfig>, grant: &Grant) -> anyhow::Result<Vec<u8>> {
        self.state_at(host, grant, true).await
    }

    async fn state_at(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        forward: bool,
    ) -> anyhow::Result<Vec<u8>> {
        self.ask(
            host,
            grant,
            forward,
            |reply| Cmd::State { reply },
            || RemoteOp::State {
                grant: grant.clone(),
            },
            remote::decode_bytes,
        )
        .await
    }

    async fn join_local(
        &self,
        tx: &mpsc::UnboundedSender<Cmd>,
        conn: ConnId,
        grant: &Arc<Grant>,
        out: &mpsc::UnboundedSender<Outbound>,
    ) -> bool {
        let (reply, rx) = oneshot::channel();
        let cmd = Cmd::Join {
            conn,
            grant: grant.clone(),
            tx: out.clone(),
            reply,
        };
        tx.send(cmd).is_ok() && rx.await.is_ok()
    }

    /// Joins a client connection to the room: locally when this node owns it, else through a
    /// relay to the owner (cluster mode).
    pub async fn join(
        &self,
        host: &Arc<HostConfig>,
        grant: Arc<Grant>,
        out: mpsc::UnboundedSender<Outbound>,
    ) -> anyhow::Result<Membership> {
        self.join_at(host, grant, out, true).await
    }

    /// A relayed connection arriving at the owner: never relayed further.
    pub async fn join_owned(
        &self,
        host: &Arc<HostConfig>,
        grant: Arc<Grant>,
        out: mpsc::UnboundedSender<Outbound>,
    ) -> anyhow::Result<Membership> {
        self.join_at(host, grant, out, false).await
    }

    async fn join_at(
        &self,
        host: &Arc<HostConfig>,
        grant: Arc<Grant>,
        out: mpsc::UnboundedSender<Outbound>,
        forward: bool,
    ) -> anyhow::Result<Membership> {
        let conn = self.next_conn.fetch_add(1, Ordering::Relaxed);
        let deadline = Instant::now() + PLACE_DEADLINE;
        let mut local_tries = 0;
        while Instant::now() < deadline && local_tries < 3 {
            match self.place(host, &grant, forward).await {
                Ok(Placement::Local(tx, inbox)) => {
                    local_tries += 1;
                    if self.join_local(&tx, conn, &grant, &out).await {
                        return Ok(Membership {
                            conn,
                            tx,
                            inbox: Some(inbox),
                        });
                    }
                }
                Ok(Placement::Remote(owner)) => {
                    let c = self.cluster().expect("remote implies cluster").clone();
                    let me = self.me.clone();
                    let on_end = Box::new(move || {
                        if let Some(r) = me.upgrade() {
                            r.relays.lock().expect("relays lock").remove(&conn);
                        }
                    });
                    self.relays
                        .lock()
                        .expect("relays lock")
                        .insert(conn, out.clone());
                    match relay::connect(&c, &owner, &grant, out.clone(), on_end).await {
                        Ok(tx) => {
                            tracing::info!(room = %grant.room, owner = %owner.node, "relaying connection to the room owner");
                            return Ok(Membership {
                                conn,
                                tx,
                                inbox: None,
                            });
                        }
                        Err(e) => {
                            self.relays.lock().expect("relays lock").remove(&conn);
                            match e {
                                RemoteError::Moved => tokio::time::sleep(RETRY).await,
                                RemoteError::Unreachable(why) => {
                                    self.owner_failed(&grant.room, &owner, &why).await
                                }
                                RemoteError::Failed(why) => return Err(anyhow!(why)),
                            }
                        }
                    }
                }
                Err(e) if e.is::<NotOwner>() || self.draining() => return Err(e),
                Err(e) => {
                    tracing::warn!(room = %grant.room, error = %e, "placing room failed; retrying");
                    tokio::time::sleep(RETRY).await;
                }
            }
        }
        Err(anyhow!("room unavailable"))
    }

    pub(crate) fn remove(&self, room: &str, generation: u64) {
        let removed = {
            let mut map = self.map.lock().expect("rooms lock");
            if map.get(room).is_some_and(|e| e.generation == generation) {
                map.remove(room);
                true
            } else {
                false
            }
        };
        // Cluster: free the lease once the actor is gone (unless a new actor took the room).
        if removed && let Some(c) = self.cluster().cloned() {
            let me = self.me.clone();
            let room = room.to_string();
            tokio::spawn(async move {
                let _gate = c.leases.gate().await;
                if me.upgrade().is_some_and(|r| !r.is_live(&room))
                    && let Err(e) = c.leases.release(&room).await
                {
                    tracing::warn!(room = %room, error = %e, "lease release failed");
                }
            });
        }
    }

    pub fn live_rooms(&self) -> usize {
        self.map.lock().expect("rooms lock").len()
    }

    /// SIGTERM drain: refuse new rooms, commit every dirty room, tell every client (local or
    /// relayed) to reconnect (control `reconnect`, close 1012), then release all leases.
    pub async fn shutdown_all(&self) {
        self.draining.store(true, Ordering::SeqCst);
        let relays: Vec<_> = self
            .relays
            .lock()
            .expect("relays lock")
            .drain()
            .map(|(_, out)| out)
            .collect();
        for out in relays {
            let _ = out.send(Outbound::Frame(relay::reconnect_frame().into()));
            let _ = out.send(Outbound::Close(
                relay::RECONNECT,
                "server shutting down".into(),
            ));
        }
        let senders: Vec<_> = self
            .map
            .lock()
            .expect("rooms lock")
            .values()
            .map(|e| e.tx.clone())
            .collect();
        let waits = senders.into_iter().map(|tx| async move {
            let (reply, rx) = oneshot::channel();
            if tx
                .send(Cmd::Shutdown {
                    by_host: false,
                    reply,
                })
                .is_ok()
            {
                let _ = tokio::time::timeout(Duration::from_secs(20), rx).await;
            }
        });
        futures::future::join_all(waits).await;
        if let Some(c) = self.cluster() {
            c.leases.release_all().await;
            tracing::info!("drained: room leases released");
        }
    }

    fn live(&self, room: &str) -> Option<mpsc::UnboundedSender<Cmd>> {
        self.map
            .lock()
            .expect("rooms lock")
            .get(room)
            .filter(|e| !e.tx.is_closed())
            .map(|e| e.tx.clone())
    }

    /// Live on this node.
    pub fn is_live(&self, room: &str) -> bool {
        self.live(room).is_some()
    }

    /// Starts the room actor if it is not running (outbox sweeper). Cluster: only when this
    /// node owns or can claim the room; false when another node owns it.
    pub async fn open(&self, host: &Arc<HostConfig>, grant: &Grant) -> bool {
        matches!(
            self.place(host, grant, true).await,
            Ok(Placement::Local(..))
        )
    }

    /// Cluster: the lease is gone; the actor tells its clients to reconnect and stops.
    pub fn step_down(&self, room: &str) {
        if let Some(tx) = self.live(room) {
            let _ = tx.send(Cmd::StepDown);
        }
    }

    /// For a room that is not live here: runs `op` on the node that owns it, if any.
    async fn forward_live(&self, room: &str, op: RemoteOp) -> Option<serde_json::Value> {
        let c = self.cluster()?;
        let owner = c.leases.owner(room).await.ok()??;
        if c.leases.is_me(&owner) {
            return None;
        }
        match c.call(&owner, room, &op).await {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::warn!(room = %room, error = %e, "forwarding to the room owner failed");
                None
            }
        }
    }

    /// Applies a role change to the live connections of `user`; 0 when the room is not live.
    pub async fn set_role(&self, room: &str, user_id: &str, role: Option<Role>) -> usize {
        if !self.is_live(room) {
            let op = RemoteOp::SetRole {
                user_id: user_id.into(),
                role,
            };
            return self
                .forward_live(room, op)
                .await
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize;
        }
        self.set_role_local(room, user_id, role).await
    }

    async fn set_role_local(&self, room: &str, user_id: &str, role: Option<Role>) -> usize {
        let Some(tx) = self.live(room) else { return 0 };
        let (reply, rx) = oneshot::channel();
        let cmd = Cmd::SetRole {
            user_id: user_id.to_string(),
            role,
            reply,
        };
        if tx.send(cmd).is_err() {
            return 0;
        }
        tokio::time::timeout(Duration::from_secs(10), rx)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(0)
    }

    /// Applies a block patch, opening the room (loading the file from the host) when needed.
    pub async fn patch(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        ops: Vec<oc_model::patch::PatchOp>,
        author: &str,
    ) -> anyhow::Result<Result<Patched, PatchFailure>> {
        self.patch_at(host, grant, ops, author, true).await
    }

    async fn patch_at(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        ops: Vec<oc_model::patch::PatchOp>,
        author: &str,
        forward: bool,
    ) -> anyhow::Result<Result<Patched, PatchFailure>> {
        self.ask(
            host,
            grant,
            forward,
            |reply| Cmd::Patch {
                ops: ops.clone(),
                author: author.to_string(),
                reply,
            },
            || RemoteOp::Patch {
                grant: grant.clone(),
                ops: ops.clone(),
                author: author.to_string(),
            },
            remote::decode_patch,
        )
        .await
    }

    /// Applies a prepared team template (TPL-01) to `grant.room`, opening the room when needed.
    pub async fn apply_template(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        doc: serde_json::Value,
        origin: &str,
    ) -> anyhow::Result<Result<Patched, PatchFailure>> {
        self.template_at(host, grant, doc, origin, true).await
    }

    pub(super) async fn template_at(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        doc: serde_json::Value,
        origin: &str,
        forward: bool,
    ) -> anyhow::Result<Result<Patched, PatchFailure>> {
        self.ask(
            host,
            grant,
            forward,
            |reply| Cmd::Template {
                doc: doc.clone(),
                origin: origin.to_string(),
                author: grant.user.id.clone(),
                reply,
            },
            || RemoteOp::Template {
                grant: grant.clone(),
                doc: doc.clone(),
                origin: origin.to_string(),
            },
            remote::decode_patch,
        )
        .await
    }

    /// Version history writes (VH-01b): name, restore, undo a restore. Answers JSON:
    /// `{"version"}` / `{"version","changed"}` / `{"undone":true}`, or `{"error": CODE}`.
    pub async fn history(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        op: HistoryOp,
    ) -> anyhow::Result<serde_json::Value> {
        self.history_at(host, grant, op, true).await
    }

    pub(super) async fn history_at(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        op: HistoryOp,
        forward: bool,
    ) -> anyhow::Result<serde_json::Value> {
        self.ask(
            host,
            grant,
            forward,
            |reply| Cmd::History {
                op: op.clone(),
                author: grant.user.id.clone(),
                reply,
            },
            || RemoteOp::History {
                grant: grant.clone(),
                history: op.clone(),
            },
            Ok,
        )
        .await
    }

    /// Changes the document's `icons` root (DGM-17), opening the room when needed. Only the
    /// server writes that root; the room refuses client updates that touch it.
    pub async fn icons(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        op: oc_model::doc_icons::IconOp,
        author: &str,
    ) -> anyhow::Result<Result<Patched, PatchFailure>> {
        self.icons_at(host, grant, op, author, true).await
    }

    pub(super) async fn icons_at(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        op: oc_model::doc_icons::IconOp,
        author: &str,
        forward: bool,
    ) -> anyhow::Result<Result<Patched, PatchFailure>> {
        self.ask(
            host,
            grant,
            forward,
            |reply| Cmd::Icons {
                op: op.clone(),
                author: author.to_string(),
                reply,
            },
            || RemoteOp::Icons {
                grant: grant.clone(),
                icon_op: op.clone(),
                author: author.to_string(),
            },
            remote::decode_patch,
        )
        .await
    }

    /// Reverts a team template applied with `origin` (TPL-01).
    pub async fn undo_template(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        origin: &str,
    ) -> anyhow::Result<Result<Patched, PatchFailure>> {
        self.template_undo_at(host, grant, origin, true).await
    }

    pub(super) async fn template_undo_at(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        origin: &str,
        forward: bool,
    ) -> anyhow::Result<Result<Patched, PatchFailure>> {
        self.ask(
            host,
            grant,
            forward,
            |reply| Cmd::TemplateUndo {
                origin: origin.to_string(),
                reply,
            },
            || RemoteOp::TemplateUndo {
                grant: grant.clone(),
                origin: origin.to_string(),
            },
            remote::decode_patch,
        )
        .await
    }

    /// Where a tool call on `grant.room` must run: `None` here (the room is placed on this
    /// node), `Some(owner)` on another node (the caller forwards it, docs/24 §5.6).
    pub async fn tool_owner(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
    ) -> anyhow::Result<Option<Owner>> {
        Ok(match self.place(host, grant, true).await? {
            Placement::Local(..) => None,
            Placement::Remote(o) => Some(o),
        })
    }

    /// Runs a canvas tool step on the room's actor (opening the room when needed). The room
    /// must be placed on this node: callers forward first ([`Rooms::tool_owner`]).
    pub async fn tool(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        origin: &str,
        run: ToolFn,
    ) -> Result<serde_json::Value, crate::ai::tools::ToolError> {
        use crate::ai::tools::ToolError;
        let tx = match self.place(host, grant, true).await {
            Ok(Placement::Local(tx, _)) => tx,
            Ok(Placement::Remote(_)) => {
                return Err(ToolError::Unavailable(
                    "the room moved to another node; retry".into(),
                ));
            }
            Err(e) => return Err(ToolError::Internal(e.to_string())),
        };
        let (reply, rx) = oneshot::channel();
        let cmd = Cmd::Tool {
            run,
            origin: origin.to_string(),
            author: grant.user.id.clone(),
            reply,
        };
        if tx.send(cmd).is_err() {
            return Err(ToolError::Internal("room unavailable; retry".into()));
        }
        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => Err(ToolError::Internal(
                "room unavailable (could not load the file from the host)".into(),
            )),
            Err(_) => Err(ToolError::Internal("room did not answer".into())),
        }
    }

    /// Forces a save of the room `grant` names (opening it if needed) and waits for the host.
    pub async fn commit(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
    ) -> anyhow::Result<CommitResult> {
        self.commit_at(host, grant, true).await
    }

    async fn commit_at(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        forward: bool,
    ) -> anyhow::Result<CommitResult> {
        self.ask(
            host,
            grant,
            forward,
            |reply| Cmd::Commit { reply },
            || RemoteOp::Commit {
                grant: grant.clone(),
            },
            remote::decode,
        )
        .await
    }

    /// `commit` for a room that is live (here or, in a cluster, on its owner); `None` when it
    /// is not.
    pub async fn commit_live(&self, room: &str) -> Option<CommitResult> {
        if !self.is_live(room) {
            let v = self.forward_live(room, RemoteOp::CommitLive).await?;
            return serde_json::from_value(v).ok().flatten();
        }
        self.commit_live_local(room).await
    }

    async fn commit_live_local(&self, room: &str) -> Option<CommitResult> {
        let tx = self.live(room)?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::Commit { reply }).ok()?;
        tokio::time::timeout(Duration::from_secs(30), rx)
            .await
            .ok()
            .and_then(Result::ok)
    }

    /// Saves and closes a live room for the host; false when it was not live.
    pub async fn close(&self, room: &str) -> bool {
        if !self.is_live(room) {
            return self
                .forward_live(room, RemoteOp::Close)
                .await
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
        }
        self.close_local(room).await
    }

    async fn close_local(&self, room: &str) -> bool {
        let Some(tx) = self.live(room) else {
            return false;
        };
        let (reply, rx) = oneshot::channel();
        if tx
            .send(Cmd::Shutdown {
                by_host: true,
                reply,
            })
            .is_err()
        {
            return false;
        }
        let _ = tokio::time::timeout(Duration::from_secs(30), rx).await;
        true
    }

    /// Kills a room actor without saving, as a crash would (tests only).
    #[doc(hidden)]
    pub fn crash(&self, room: &str) {
        if let Some(e) = self.map.lock().expect("rooms lock").remove(room) {
            e.abort.abort();
        }
    }
}
