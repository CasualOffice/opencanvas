//! Cluster-wide member events (docs/21 revision 2): a revoke, restore or members invalidate on
//! one node reaches every node's members cache and revoke set at once. Events go out on the
//! Redis pub/sub channel [`CHANNEL`], signed with `OC_CLUSTER_SECRET` like every other
//! node-to-node message (see [`super::Cluster::publish_members`]).
//!
//! Pub/sub is fire-and-forget: a node whose subscription drops clears its whole members cache
//! when it resubscribes ([`BusMsg::Resubscribed`]), so a missed invalidate costs one refetch.
//! Socket closes do not depend on the bus: the role API is forwarded to the room's owner,
//! which holds every connection (relayed ones included).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::StreamExt;
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::people::Members;

pub const CHANNEL: &str = "oc:members";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "snake_case")]
pub enum MembersEvent {
    /// Drop the cached members callback answers for `room`.
    Invalidate { room: String },
    /// The host revoked `user` on `room` (role API `none`).
    Revoke { room: String, user: String },
    /// `user` has access to `room` again.
    Restore { room: String, user: String },
}

impl MembersEvent {
    /// Applies the event to this node's members cache and revoke set.
    pub fn apply(&self, m: &Members) {
        match self {
            Self::Invalidate { room } => m.invalidate(room),
            Self::Revoke { room, user } => m.revoke(room, user),
            Self::Restore { room, user } => m.restore(room, user),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BusMsg {
    /// A message some node (possibly this one) published.
    Message(Vec<u8>),
    /// The subscription was (re)established: messages may have been missed before it.
    Resubscribed,
}

/// Broadcast to every node. Redis pub/sub in production, an in-memory fake in tests.
pub trait Bus: Send + Sync + 'static {
    fn publish<'a>(&'a self, msg: Vec<u8>) -> BoxFuture<'a, anyhow::Result<()>>;
    /// Everything published from now on, by any node; ends when the bus is gone.
    fn subscribe(&self) -> mpsc::UnboundedReceiver<BusMsg>;
}

/// In-memory bus: every subscriber of the same `FakeBus` gets every message.
#[derive(Default)]
pub struct FakeBus {
    subs: Mutex<Vec<mpsc::UnboundedSender<BusMsg>>>,
}

impl Bus for FakeBus {
    fn publish<'a>(&'a self, msg: Vec<u8>) -> BoxFuture<'a, anyhow::Result<()>> {
        let mut subs = self.subs.lock().expect("bus");
        subs.retain(|s| s.send(BusMsg::Message(msg.clone())).is_ok());
        Box::pin(async { Ok(()) })
    }

    fn subscribe(&self) -> mpsc::UnboundedReceiver<BusMsg> {
        let (tx, rx) = mpsc::unbounded_channel();
        let _ = tx.send(BusMsg::Resubscribed);
        self.subs.lock().expect("bus").push(tx);
        rx
    }
}

/// Redis pub/sub on [`CHANNEL`]: publishes on the shared connection manager, subscribes on a
/// dedicated connection that is re-opened (every second) whenever it drops.
pub struct RedisBus {
    client: redis::Client,
    conn: redis::aio::ConnectionManager,
}

impl RedisBus {
    pub fn new(client: redis::Client, conn: redis::aio::ConnectionManager) -> Arc<Self> {
        Arc::new(Self { client, conn })
    }

    pub async fn connect(url: &str) -> anyhow::Result<Arc<Self>> {
        let client = redis::Client::open(url)?;
        let conn = client.get_connection_manager().await?;
        Ok(Self::new(client, conn))
    }
}

impl Bus for RedisBus {
    fn publish<'a>(&'a self, msg: Vec<u8>) -> BoxFuture<'a, anyhow::Result<()>> {
        Box::pin(async move {
            let mut c = self.conn.clone();
            let _: i64 = redis::cmd("PUBLISH")
                .arg(CHANNEL)
                .arg(msg)
                .query_async(&mut c)
                .await?;
            Ok(())
        })
    }

    fn subscribe(&self) -> mpsc::UnboundedReceiver<BusMsg> {
        let (tx, rx) = mpsc::unbounded_channel();
        let client = self.client.clone();
        tokio::spawn(async move {
            loop {
                match client.get_async_pubsub().await {
                    Ok(mut ps) => match ps.subscribe(CHANNEL).await {
                        Ok(()) => {
                            if tx.send(BusMsg::Resubscribed).is_err() {
                                return;
                            }
                            let mut stream = ps.on_message();
                            while let Some(m) = stream.next().await {
                                let msg = BusMsg::Message(m.get_payload_bytes().to_vec());
                                if tx.send(msg).is_err() {
                                    return;
                                }
                            }
                            tracing::warn!("members bus: Redis subscription lost; resubscribing");
                        }
                        Err(e) => tracing::warn!(error = %e, "members bus: subscribe failed"),
                    },
                    Err(e) => tracing::warn!(error = %e, "members bus: Redis unreachable"),
                }
                if tx.is_closed() {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
        rx
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_round_trip_as_tagged_json() {
        let ev = MembersEvent::Revoke {
            room: "r_1".into(),
            user: "u_sam".into(),
        };
        let s = serde_json::to_string(&ev).unwrap();
        assert_eq!(s, r#"{"k":"revoke","room":"r_1","user":"u_sam"}"#);
        assert_eq!(serde_json::from_str::<MembersEvent>(&s).unwrap(), ev);
    }

    #[tokio::test]
    async fn fake_bus_reaches_every_subscriber() {
        let bus = FakeBus::default();
        let mut a = bus.subscribe();
        let mut b = bus.subscribe();
        bus.publish(b"x".to_vec()).await.unwrap();
        for rx in [&mut a, &mut b] {
            assert_eq!(rx.recv().await, Some(BusMsg::Resubscribed));
            assert_eq!(rx.recv().await, Some(BusMsg::Message(b"x".to_vec())));
        }
    }
}
