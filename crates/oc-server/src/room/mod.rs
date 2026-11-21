//! One actor per live room (host, file); the manager hands out handles and restarts closed rooms.

mod actor;
pub mod filter;
pub mod mentions;
pub mod protocol;
mod remote;

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
    /// Host commit API: save now and answer once the host acknowledged (or it failed).
    Commit {
        reply: oneshot::Sender<CommitResult>,
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

pub(crate) enum ConflictOutcome {
    Copied { file_id: String, url: String },
    Reloaded(Fetched),
}

pub struct Ctx {
    pub store: Store,
    pub host: HostClient,
    pub cfg: RoomConfig,
    pub metrics: Arc<Metrics>,
}

struct Entry {
    generation: u64,
    tx: mpsc::UnboundedSender<Cmd>,
    abort: AbortHandle,
}

/// Cluster: the room is owned by another node and this call may not be forwarded.
#[derive(Debug, thiserror::Error)]
#[error("room {0} is owned by another node")]
pub struct NotOwner(pub String);

/// Where a room's actor runs.
enum Placement {
    Local(mpsc::UnboundedSender<Cmd>),
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
}

impl Membership {
    pub fn send(&self, data: Vec<u8>) {
        let _ = self.tx.send(Cmd::Frame {
            conn: self.conn,
            data,
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

    fn sender(&self, host: &Arc<HostConfig>, grant: &Grant) -> mpsc::UnboundedSender<Cmd> {
        let mut map = self.map.lock().expect("rooms lock");
        if let Some(e) = map.get(&grant.room).filter(|e| !e.tx.is_closed()) {
            return e.tx.clone();
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let generation = self.generation.fetch_add(1, Ordering::Relaxed);
        let task = tokio::spawn(actor::run(
            self.ctx.clone(),
            self.me.clone(),
            generation,
            host.clone(),
            grant.clone(),
            tx.clone(),
            rx,
        ));
        map.insert(
            grant.room.clone(),
            Entry {
                generation,
                tx: tx.clone(),
                abort: task.abort_handle(),
            },
        );
        tx
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
            return Ok(Placement::Local(self.sender(host, grant)));
        };
        let _gate = c.leases.gate().await;
        match c.leases.claim(&grant.room).await? {
            Claim::Mine => Ok(Placement::Local(self.sender(host, grant))),
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
                Ok(Placement::Local(tx)) => {
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
                Ok(Placement::Local(tx)) => {
                    local_tries += 1;
                    if self.join_local(&tx, conn, &grant, &out).await {
                        return Ok(Membership { conn, tx });
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
                            return Ok(Membership { conn, tx });
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
        matches!(self.place(host, grant, true).await, Ok(Placement::Local(_)))
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
