//! Cluster mode (ADR-006, docs/03 §5.2): `REDIS_URL` set → one owner node per room through a
//! Redis lease; other nodes relay WebSocket frames to the owner over an internal, HMAC-signed
//! WebSocket and forward host-API room calls over signed internal HTTP.
//!
//! Failover: a dead owner's lease expires (15 s), or is taken over at once by the first node
//! that finds the owner unreachable (`/healthz` probe fails); the new owner rebuilds the room
//! from snapshot + WAL in MySQL/MariaDB exactly like a single-node restart.

pub mod bus;
pub mod lease;
pub mod relay;
pub mod server;

use std::sync::Arc;
use std::time::Duration;

use axum::http::HeaderMap;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

use crate::people::Members;
use crate::room::RemoteOp;
use crate::util::now_secs;
use bus::{Bus, BusMsg, FakeBus, MembersEvent, RedisBus};
use lease::{LeaseBackend, Leases, Owner, RedisLeases};

pub const LEASE_TTL: Duration = Duration::from_millis(15_000);
pub const RENEW_EVERY: Duration = Duration::from_secs(5);
/// Signed internal requests older (or newer) than this are refused.
const MAX_SKEW_SECS: i64 = 30;

pub const H_TS: &str = "x-oc-cluster-ts";
pub const H_SIG: &str = "x-oc-cluster-sig";
pub const H_NODE: &str = "x-oc-cluster-node";
pub const H_GRANT: &str = "x-oc-cluster-grant";

#[derive(Clone)]
pub struct ClusterConfig {
    pub redis_url: String,
    pub node_id: String,
    /// Base URL other nodes use to reach this one (`OC_CLUSTER_ADVERTISE`).
    pub advertise: String,
    secret: Vec<u8>,
    pub lease_ttl: Duration,
    pub renew_every: Duration,
}

impl std::fmt::Debug for ClusterConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClusterConfig")
            .field("node_id", &self.node_id)
            .field("advertise", &self.advertise)
            .finish_non_exhaustive()
    }
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

impl ClusterConfig {
    /// `REDIS_URL` unset → `None` (single node). Refuses SQLite, a missing or short
    /// `OC_CLUSTER_SECRET`, and an unknown advertise address.
    pub fn from_env(database_url: &str, bind: &str) -> anyhow::Result<Option<Self>> {
        Self::build(
            var("REDIS_URL"),
            database_url,
            var("OC_NODE_ID").or_else(|| var("HOSTNAME")),
            var("OC_CLUSTER_ADVERTISE"),
            var("OC_CLUSTER_SECRET"),
            bind,
        )
    }

    pub fn build(
        redis_url: Option<String>,
        database_url: &str,
        node_id: Option<String>,
        advertise: Option<String>,
        secret: Option<String>,
        bind: &str,
    ) -> anyhow::Result<Option<Self>> {
        let Some(redis_url) = redis_url else {
            return Ok(None);
        };
        if database_url.starts_with("sqlite:") {
            anyhow::bail!(
                "REDIS_URL enables cluster mode, which needs MySQL or MariaDB: SQLite is single-node only. \
                 Set DATABASE_URL=mysql://… or unset REDIS_URL."
            );
        }
        let secret = secret.ok_or_else(|| {
            anyhow::anyhow!("cluster mode (REDIS_URL) needs OC_CLUSTER_SECRET (at least 32 characters, same on every node)")
        })?;
        if secret.len() < 32 {
            anyhow::bail!("OC_CLUSTER_SECRET must be at least 32 characters");
        }
        let node_id = node_id.unwrap_or_else(|| ulid::Ulid::new().to_string().to_lowercase());
        if node_id.contains(['@', '#']) || node_id.len() > 64 {
            anyhow::bail!("OC_NODE_ID must be ≤ 64 characters without '@' or '#'");
        }
        let advertise = match advertise {
            Some(a) => a,
            None => {
                let port = bind.rsplit_once(':').map_or("8080", |(_, p)| p);
                format!("http://{node_id}:{port}")
            }
        };
        let advertise = advertise.trim_end_matches('/').to_string();
        if !advertise.starts_with("http://") && !advertise.starts_with("https://") {
            anyhow::bail!("OC_CLUSTER_ADVERTISE must be an http(s) URL, got {advertise:?}");
        }
        Ok(Some(Self {
            redis_url,
            node_id,
            advertise,
            secret: secret.into_bytes(),
            lease_ttl: LEASE_TTL,
            renew_every: RENEW_EVERY,
        }))
    }
}

/// Why a call to the owner did not produce an answer.
#[derive(Debug)]
pub enum RemoteError {
    /// The owner answered but no longer owns the room (or is draining): look again.
    Moved,
    /// The owner could not be reached: it may be dead.
    Unreachable(String),
    /// The owner reached the room but the call failed there.
    Failed(String),
}

impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Moved => f.write_str("room moved"),
            Self::Unreachable(e) => write!(f, "owner unreachable: {e}"),
            Self::Failed(e) => write!(f, "owner failed: {e}"),
        }
    }
}

pub struct Cluster {
    pub cfg: ClusterConfig,
    pub leases: Leases,
    redis: Option<Arc<RedisLeases>>,
    http: reqwest::Client,
    /// Member events to and from every node (docs/21 revision 2).
    bus: Arc<dyn Bus>,
}

/// A signed member event on the bus.
#[derive(Serialize, Deserialize)]
struct Envelope {
    node: String,
    ts: i64,
    ev: MembersEvent,
    sig: String,
}

impl Cluster {
    pub async fn connect(cfg: ClusterConfig) -> anyhow::Result<Arc<Self>> {
        let redis = Arc::new(
            RedisLeases::connect(&cfg.redis_url)
                .await
                .map_err(|e| anyhow::anyhow!("connecting to REDIS_URL: {e}"))?,
        );
        let bus = RedisBus::connect(&cfg.redis_url)
            .await
            .map_err(|e| anyhow::anyhow!("connecting to REDIS_URL (members bus): {e}"))?;
        Ok(Self::build(cfg, redis.clone(), Some(redis), bus))
    }

    /// A cluster on any lease backend (tests use the in-memory fake), with a bus of its own.
    pub fn with_backend(cfg: ClusterConfig, backend: Arc<dyn LeaseBackend>) -> Arc<Self> {
        Self::build(cfg, backend, None, Arc::new(FakeBus::default()))
    }

    /// A cluster on any lease backend and members bus (tests share one fake between nodes).
    pub fn with_backends(
        cfg: ClusterConfig,
        backend: Arc<dyn LeaseBackend>,
        bus: Arc<dyn Bus>,
    ) -> Arc<Self> {
        Self::build(cfg, backend, None, bus)
    }

    fn build(
        cfg: ClusterConfig,
        backend: Arc<dyn LeaseBackend>,
        redis: Option<Arc<RedisLeases>>,
        bus: Arc<dyn Bus>,
    ) -> Arc<Self> {
        let leases = Leases::new(backend, &cfg.node_id, &cfg.advertise, cfg.lease_ttl);
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(1))
            .build()
            .expect("http client");
        Arc::new(Self {
            cfg,
            leases,
            redis,
            http,
            bus,
        })
    }

    fn members_mac(&self, ts: i64, node: &str, ev: &MembersEvent) -> Hmac<Sha256> {
        let body = serde_json::to_vec(ev).expect("event json");
        self.mac(ts, &format!("{}:{node}", bus::CHANNEL), &body)
    }

    /// Tells every other node about a member change. Best effort: a Redis error is logged
    /// (the other nodes' caches then expire within 60 s, as without a bus).
    pub async fn publish_members(&self, ev: &MembersEvent) {
        let ts = now_secs();
        let node = self.cfg.node_id.clone();
        let sig = hex::encode(self.members_mac(ts, &node, ev).finalize().into_bytes());
        let env = Envelope {
            node,
            ts,
            ev: ev.clone(),
            sig,
        };
        let msg = serde_json::to_vec(&env).expect("envelope json");
        if let Err(e) = self.bus.publish(msg).await {
            tracing::warn!(error = %e, "members bus: publish failed");
        }
    }

    /// The event in a bus message from another node, if its signature and time check out.
    fn open_members(&self, msg: &[u8]) -> Option<MembersEvent> {
        let env: Envelope = serde_json::from_slice(msg).ok()?;
        if env.node == self.cfg.node_id || (now_secs() - env.ts).abs() > MAX_SKEW_SECS {
            return None;
        }
        let sig = hex::decode(&env.sig).ok()?;
        self.members_mac(env.ts, &env.node, &env.ev)
            .verify_slice(&sig)
            .ok()?;
        Some(env.ev)
    }

    pub async fn redis_ok(&self) -> bool {
        match &self.redis {
            Some(r) => r.ping().await,
            None => true,
        }
    }

    fn mac(&self, ts: i64, room: &str, payload: &[u8]) -> Hmac<Sha256> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.cfg.secret).expect("hmac key");
        mac.update(format!("oc-cluster-v1\n{ts}\n{room}\n").as_bytes());
        mac.update(payload);
        mac
    }

    /// Headers that authenticate an internal request about `room` carrying `payload`.
    pub fn sign(&self, room: &str, payload: &[u8]) -> Vec<(&'static str, String)> {
        let ts = now_secs();
        let sig = hex::encode(self.mac(ts, room, payload).finalize().into_bytes());
        vec![
            (H_TS, ts.to_string()),
            (H_SIG, sig),
            (H_NODE, self.cfg.node_id.clone()),
        ]
    }

    pub fn verify(&self, headers: &HeaderMap, room: &str, payload: &[u8]) -> bool {
        let get = |h: &str| headers.get(h).and_then(|v| v.to_str().ok());
        let (Some(ts), Some(sig)) = (get(H_TS), get(H_SIG)) else {
            return false;
        };
        let (Ok(ts), Ok(sig)) = (ts.parse::<i64>(), hex::decode(sig)) else {
            return false;
        };
        if (now_secs() - ts).abs() > MAX_SKEW_SECS {
            return false;
        }
        self.mac(ts, room, payload).verify_slice(&sig).is_ok()
    }

    /// True when the owner's process answers `/healthz` within a second.
    pub async fn alive(&self, owner: &Owner) -> bool {
        let res = self
            .http
            .get(format!("{}/healthz", owner.url))
            .timeout(Duration::from_secs(1))
            .send()
            .await;
        res.is_ok_and(|r| r.status().is_success())
    }

    /// Runs a room call on the owner (`POST /v1/internal/rooms/:room`).
    pub async fn call(
        &self,
        owner: &Owner,
        room: &str,
        op: &RemoteOp,
    ) -> Result<Value, RemoteError> {
        let body = serde_json::to_vec(op).map_err(|e| RemoteError::Failed(e.to_string()))?;
        let mut req = self
            .http
            .post(format!("{}/v1/internal/rooms/{room}", owner.url))
            .timeout(Duration::from_secs(40))
            .header("content-type", "application/json");
        for (k, v) in self.sign(room, &body) {
            req = req.header(k, v);
        }
        let res = req.body(body).send().await.map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                RemoteError::Unreachable(e.to_string())
            } else {
                RemoteError::Failed(e.to_string())
            }
        })?;
        match res.status().as_u16() {
            200 => res
                .json::<Value>()
                .await
                .map_err(|e| RemoteError::Failed(e.to_string())),
            409 | 503 => Err(RemoteError::Moved),
            s => Err(RemoteError::Failed(format!("owner answered {s}"))),
        }
    }
}

/// Renews this node's leases every 5 s; a room lost to another node is stepped down (its
/// clients are told to reconnect, nothing is saved: the new owner has the WAL).
pub fn spawn_renewer(rooms: Arc<crate::room::Rooms>, cluster: Arc<Cluster>) {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(cluster.cfg.renew_every);
        loop {
            every.tick().await;
            for room in cluster.leases.renew_all().await {
                tracing::warn!(room = %room, "room lease lost to another node; stepping down");
                rooms.step_down(&room);
            }
        }
    });
}

/// Applies other nodes' member events (revoke, restore, invalidate) to this node's members
/// cache and revoke set as they arrive. A (re)subscription clears the whole cache: events
/// published while the subscription was down are lost.
pub fn spawn_members_listener(members: Arc<Members>, cluster: Arc<Cluster>) {
    let mut rx = cluster.bus.subscribe();
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match msg {
                BusMsg::Resubscribed => members.invalidate_all(),
                BusMsg::Message(m) => {
                    if let Some(ev) = cluster.open_members(&m) {
                        tracing::debug!(event = ?ev, "members event from another node");
                        ev.apply(&members);
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn member_events_are_signed_and_skip_their_own_node() {
        let cfg = |id: &str, secret: &str| {
            ClusterConfig::build(
                Some("redis://r".into()),
                "mysql://db/oc",
                Some(id.into()),
                None,
                Some(secret.into()),
                "0.0.0.0:8080",
            )
            .unwrap()
            .unwrap()
        };
        let bus = Arc::new(FakeBus::default());
        let fake = || Arc::new(lease::FakeLeases::default());
        let a = Cluster::with_backends(cfg("a", SECRET), fake(), bus.clone());
        let b = Cluster::with_backends(cfg("b", SECRET), fake(), bus.clone());
        let evil = Cluster::with_backends(
            cfg("c", "another-secret-another-secret-xx"),
            fake(),
            bus.clone(),
        );
        let mut rx = bus.subscribe();
        assert_eq!(rx.recv().await, Some(BusMsg::Resubscribed));
        let ev = MembersEvent::Revoke {
            room: "r_1".into(),
            user: "u_sam".into(),
        };
        a.publish_members(&ev).await;
        let Some(BusMsg::Message(m)) = rx.recv().await else {
            panic!()
        };
        assert_eq!(b.open_members(&m), Some(ev.clone()));
        assert_eq!(a.open_members(&m), None, "own events are already applied");
        evil.publish_members(&ev).await;
        let Some(BusMsg::Message(evil_m)) = rx.recv().await else {
            panic!()
        };
        assert_eq!(b.open_members(&evil_m), None, "wrong secret");
        let mut tampered: serde_json::Value = serde_json::from_slice(&m).unwrap();
        tampered["ev"]["user"] = "u_other".into();
        assert_eq!(
            b.open_members(&serde_json::to_vec(&tampered).unwrap()),
            None
        );
    }

    fn build(
        redis: Option<&str>,
        db: &str,
        secret: Option<&str>,
    ) -> anyhow::Result<Option<ClusterConfig>> {
        ClusterConfig::build(
            redis.map(Into::into),
            db,
            Some("oc1".into()),
            None,
            secret.map(Into::into),
            "0.0.0.0:8080",
        )
    }

    const SECRET: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn no_redis_is_single_node() {
        assert!(build(None, "sqlite://x.db", None).unwrap().is_none());
    }

    #[test]
    fn sqlite_with_redis_is_refused() {
        let err = build(
            Some("redis://r:6379"),
            "sqlite://./data/x.db?mode=rwc",
            Some(SECRET),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("SQLite is single-node only"), "{err}");
    }

    #[test]
    fn cluster_needs_a_secret_and_defaults_the_advertise_url() {
        assert!(build(Some("redis://r"), "mysql://db/oc", None).is_err());
        assert!(build(Some("redis://r"), "mysql://db/oc", Some("short")).is_err());
        let c = build(Some("redis://r"), "mysql://db/oc", Some(SECRET))
            .unwrap()
            .unwrap();
        assert_eq!(c.advertise, "http://oc1:8080");
        assert_eq!(c.node_id, "oc1");
    }

    #[test]
    fn signatures_bind_room_payload_and_time() {
        let cfg = build(Some("redis://r"), "mysql://db/oc", Some(SECRET))
            .unwrap()
            .unwrap();
        let c = Cluster::with_backend(cfg.clone(), Arc::new(lease::FakeLeases::default()));
        let headers = |pairs: Vec<(&'static str, String)>| {
            let mut h = HeaderMap::new();
            for (k, v) in pairs {
                h.insert(k, v.parse().unwrap());
            }
            h
        };
        let h = headers(c.sign("r_1", b"grant"));
        assert!(c.verify(&h, "r_1", b"grant"));
        assert!(!c.verify(&h, "r_2", b"grant"));
        assert!(!c.verify(&h, "r_1", b"grant2"));
        let mut other = cfg;
        other.secret = b"another-secret-another-secret-xx".to_vec();
        let c2 = Cluster::with_backend(other, Arc::new(lease::FakeLeases::default()));
        assert!(!c2.verify(&h, "r_1", b"grant"));
        let mut stale = h.clone();
        stale.insert(H_TS, (now_secs() - 120).to_string().parse().unwrap());
        assert!(!c.verify(&stale, "r_1", b"grant"));
    }
}
