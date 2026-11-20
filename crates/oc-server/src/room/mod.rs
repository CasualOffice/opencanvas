//! One actor per live room (host, file); the manager hands out handles and restarts closed rooms.

mod actor;
pub mod filter;
pub mod protocol;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use anyhow::anyhow;
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;

use crate::config::RoomConfig;
use crate::grant::Grant;
use crate::host_client::{HostClient, PutOutcome};
use crate::hosts::HostConfig;
use crate::metrics::Metrics;
use crate::store::Store;

pub type ConnId = u64;

#[derive(Debug)]
pub enum Outbound {
    Frame(Vec<u8>),
    Close(u16, String),
}

#[derive(Debug, Clone)]
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
        seq: i64,
        result: Result<PutOutcome, String>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
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

pub struct Rooms {
    ctx: Arc<Ctx>,
    map: Mutex<HashMap<String, Entry>>,
    generation: AtomicU64,
    next_conn: AtomicU64,
    me: Weak<Rooms>,
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
        })
    }

    pub fn ctx(&self) -> &Arc<Ctx> {
        &self.ctx
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

    /// Sends a request to the room, reopening it if it closed in between (up to 3 tries).
    async fn ask<T>(
        &self,
        host: &Arc<HostConfig>,
        grant: &Grant,
        make: impl Fn(oneshot::Sender<T>) -> Cmd,
    ) -> anyhow::Result<T> {
        for _ in 0..3 {
            let (reply, rx) = oneshot::channel();
            if self.sender(host, grant).send(make(reply)).is_err() {
                continue;
            }
            match tokio::time::timeout(Duration::from_secs(30), rx).await {
                Ok(Ok(v)) => return Ok(v),
                Ok(Err(_)) => continue,
                Err(_) => return Err(anyhow!("room did not answer")),
            }
        }
        Err(anyhow!(
            "room unavailable (could not load the file from the host)"
        ))
    }

    pub async fn info(&self, host: &Arc<HostConfig>, grant: &Grant) -> anyhow::Result<RoomInfo> {
        self.ask(host, grant, |reply| Cmd::Info { reply }).await
    }

    /// Full Yjs state of the room as a v1 update.
    pub async fn state(&self, host: &Arc<HostConfig>, grant: &Grant) -> anyhow::Result<Vec<u8>> {
        self.ask(host, grant, |reply| Cmd::State { reply }).await
    }

    pub async fn join(
        &self,
        host: &Arc<HostConfig>,
        grant: Arc<Grant>,
        out: mpsc::UnboundedSender<Outbound>,
    ) -> anyhow::Result<Membership> {
        let conn = self.next_conn.fetch_add(1, Ordering::Relaxed);
        for _ in 0..3 {
            let tx = self.sender(host, &grant);
            let (reply, rx) = oneshot::channel();
            let cmd = Cmd::Join {
                conn,
                grant: grant.clone(),
                tx: out.clone(),
                reply,
            };
            if tx.send(cmd).is_ok() && rx.await.is_ok() {
                return Ok(Membership { conn, tx });
            }
        }
        Err(anyhow!("room unavailable"))
    }

    pub(crate) fn remove(&self, room: &str, generation: u64) {
        let mut map = self.map.lock().expect("rooms lock");
        if map.get(room).is_some_and(|e| e.generation == generation) {
            map.remove(room);
        }
    }

    pub fn live_rooms(&self) -> usize {
        self.map.lock().expect("rooms lock").len()
    }

    /// Final save of every dirty room, then close all connections (SIGTERM path).
    pub async fn shutdown_all(&self) {
        let senders: Vec<_> = self
            .map
            .lock()
            .expect("rooms lock")
            .values()
            .map(|e| e.tx.clone())
            .collect();
        let waits = senders.into_iter().map(|tx| async move {
            let (reply, rx) = oneshot::channel();
            if tx.send(Cmd::Shutdown { reply }).is_ok() {
                let _ = tokio::time::timeout(Duration::from_secs(20), rx).await;
            }
        });
        futures::future::join_all(waits).await;
    }

    /// Kills a room actor without saving, as a crash would (tests only).
    #[doc(hidden)]
    pub fn crash(&self, room: &str) {
        if let Some(e) = self.map.lock().expect("rooms lock").remove(room) {
            e.abort.abort();
        }
    }
}
