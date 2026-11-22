// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Room ownership leases (ADR-006): `room:{id}:owner` = `<node>@<url>#<nonce>`, taken with
//! `SET NX PX`, renewed every 5 s, released with a compare-and-delete.
//!
//! The backend is a trait so the lease logic is unit-tested against an in-memory fake.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;

/// The few atomic operations the lease logic needs. Every one is a single Lua script on Redis.
pub trait LeaseBackend: Send + Sync + 'static {
    /// `SET key value NX PX ttl`; a value already held by this node (`self_prefix`, from an
    /// earlier actor or process with the same node id) is replaced too. Returns `None` when
    /// the lease is now `value`, else the current holder.
    fn acquire<'a>(
        &'a self,
        key: &'a str,
        value: &'a str,
        self_prefix: &'a str,
        ttl_ms: u64,
    ) -> BoxFuture<'a, anyhow::Result<Option<String>>>;
    /// Extends the lease when it still holds `value` (re-takes it when it has expired and
    /// nobody else took it). False = someone else owns it now.
    fn renew<'a>(
        &'a self,
        key: &'a str,
        value: &'a str,
        ttl_ms: u64,
    ) -> BoxFuture<'a, anyhow::Result<bool>>;
    /// Deletes the key only when it holds `value`.
    fn release<'a>(&'a self, key: &'a str, value: &'a str) -> BoxFuture<'a, anyhow::Result<bool>>;
    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, anyhow::Result<Option<String>>>;
    /// Replaces `old` (a dead owner) with `new`; also takes a free key. False when the key
    /// holds anything else.
    fn steal<'a>(
        &'a self,
        key: &'a str,
        old: &'a str,
        new: &'a str,
        ttl_ms: u64,
    ) -> BoxFuture<'a, anyhow::Result<bool>>;
}

/// Who holds a room.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owner {
    pub node: String,
    /// Internal base URL of the owner (`OC_CLUSTER_ADVERTISE`).
    pub url: String,
    /// The raw lease value (compare-and-set target).
    pub value: String,
}

impl Owner {
    pub fn parse(value: &str) -> Option<Self> {
        let (node, rest) = value.split_once('@')?;
        let url = rest.rsplit_once('#').map_or(rest, |(u, _)| u);
        (!node.is_empty() && !url.is_empty()).then(|| Self {
            node: node.into(),
            url: url.into(),
            value: value.into(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Claim {
    /// This node owns the room.
    Mine,
    /// Another node does.
    Held(Owner),
}

pub fn key(room: &str) -> String {
    format!("room:{room}:owner")
}

pub struct Leases {
    backend: Arc<dyn LeaseBackend>,
    node: String,
    url: String,
    ttl: Duration,
    /// Rooms this node owns → the lease value it holds.
    owned: Mutex<HashMap<String, String>>,
    /// Serialises claims and releases on this node, so a release can never delete a lease
    /// that a concurrent claim just reused (callers spawn the room actor while holding it).
    gate: tokio::sync::Mutex<()>,
}

impl Leases {
    pub fn new(backend: Arc<dyn LeaseBackend>, node: &str, url: &str, ttl: Duration) -> Self {
        Self {
            backend,
            node: node.into(),
            url: url.into(),
            ttl,
            owned: Mutex::default(),
            gate: tokio::sync::Mutex::new(()),
        }
    }

    pub fn node(&self) -> &str {
        &self.node
    }

    fn prefix(&self) -> String {
        format!("{}@", self.node)
    }

    fn ttl_ms(&self) -> u64 {
        self.ttl.as_millis() as u64
    }

    fn fresh_value(&self) -> String {
        format!("{}@{}#{}", self.node, self.url, ulid::Ulid::new())
    }

    /// Held while claiming + starting an actor, and while releasing.
    pub async fn gate(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.gate.lock().await
    }

    pub fn owns(&self, room: &str) -> bool {
        self.owned.lock().expect("leases lock").contains_key(room)
    }

    pub fn owned_rooms(&self) -> Vec<String> {
        self.owned
            .lock()
            .expect("leases lock")
            .keys()
            .cloned()
            .collect()
    }

    /// Takes the lease or reports its holder. Call with [`Self::gate`] held.
    pub async fn claim(&self, room: &str) -> anyhow::Result<Claim> {
        if self.owns(room) {
            return Ok(Claim::Mine);
        }
        let value = self.fresh_value();
        let held = self
            .backend
            .acquire(&key(room), &value, &self.prefix(), self.ttl_ms())
            .await?;
        match held {
            None => {
                self.owned
                    .lock()
                    .expect("leases lock")
                    .insert(room.into(), value);
                Ok(Claim::Mine)
            }
            Some(v) => match Owner::parse(&v) {
                Some(o) => Ok(Claim::Held(o)),
                None => anyhow::bail!("unreadable lease value for {room}"),
            },
        }
    }

    /// The current owner as Redis sees it (`None` when nobody holds the room).
    pub async fn owner(&self, room: &str) -> anyhow::Result<Option<Owner>> {
        Ok(self
            .backend
            .get(&key(room))
            .await?
            .and_then(|v| Owner::parse(&v)))
    }

    pub fn is_me(&self, owner: &Owner) -> bool {
        owner.node == self.node
    }

    /// Takes over from an owner known to be dead. Call with [`Self::gate`] held.
    pub async fn steal(&self, room: &str, dead: &Owner) -> anyhow::Result<bool> {
        let value = self.fresh_value();
        let ok = self
            .backend
            .steal(&key(room), &dead.value, &value, self.ttl_ms())
            .await?;
        if ok {
            self.owned
                .lock()
                .expect("leases lock")
                .insert(room.into(), value);
        }
        Ok(ok)
    }

    /// Gives the room up. Call with [`Self::gate`] held.
    pub async fn release(&self, room: &str) -> anyhow::Result<()> {
        let value = self.owned.lock().expect("leases lock").remove(room);
        if let Some(v) = value {
            self.backend.release(&key(room), &v).await?;
        }
        Ok(())
    }

    /// Forgets a room without touching Redis (it was lost to another node).
    pub fn forget(&self, room: &str) {
        self.owned.lock().expect("leases lock").remove(room);
    }

    /// Renews every owned lease; returns the rooms that now belong to someone else (they are
    /// forgotten). A Redis error keeps the room: nobody else can claim it without Redis either.
    pub async fn renew_all(&self) -> Vec<String> {
        let owned: Vec<(String, String)> = self
            .owned
            .lock()
            .expect("leases lock")
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let mut lost = Vec::new();
        for (room, value) in owned {
            match self.backend.renew(&key(&room), &value, self.ttl_ms()).await {
                Ok(true) => {}
                Ok(false) => {
                    let mut owned = self.owned.lock().expect("leases lock");
                    // Only when it was not re-claimed meanwhile with a new value.
                    if owned.get(&room) == Some(&value) {
                        owned.remove(&room);
                        lost.push(room);
                    }
                }
                Err(e) => tracing::warn!(room = %room, error = %e, "lease renew failed"),
            }
        }
        lost
    }

    pub async fn release_all(&self) {
        let _gate = self.gate().await;
        for room in self.owned_rooms() {
            if let Err(e) = self.release(&room).await {
                tracing::warn!(room = %room, error = %e, "lease release failed");
            }
        }
    }
}

// ---------- Redis ----------

const ACQUIRE: &str = r"
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return '' end
local v = redis.call('GET', KEYS[1])
if v and string.sub(v, 1, string.len(ARGV[3])) == ARGV[3] then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return ''
end
return v or ''
";
const RENEW: &str = r"
local v = redis.call('GET', KEYS[1])
if v == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 end
if not v then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
return 0
";
const RELEASE: &str = r"
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
";
const STEAL: &str = r"
local v = redis.call('GET', KEYS[1])
if (not v) or v == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) return 1 end
return 0
";

pub struct RedisLeases {
    conn: redis::aio::ConnectionManager,
}

impl RedisLeases {
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        let client = redis::Client::open(url)?;
        let cfg = redis::aio::ConnectionManagerConfig::new()
            .set_connection_timeout(Some(Duration::from_secs(2)))
            .set_response_timeout(Some(Duration::from_secs(2)));
        let mut conn = client.get_connection_manager_with_config(cfg).await?;
        let _: String = redis::cmd("PING").query_async(&mut conn).await?;
        Ok(Self { conn })
    }

    pub async fn ping(&self) -> bool {
        let mut c = self.conn.clone();
        redis::cmd("PING")
            .query_async::<String>(&mut c)
            .await
            .is_ok()
    }
}

impl LeaseBackend for RedisLeases {
    fn acquire<'a>(
        &'a self,
        key: &'a str,
        value: &'a str,
        self_prefix: &'a str,
        ttl_ms: u64,
    ) -> BoxFuture<'a, anyhow::Result<Option<String>>> {
        Box::pin(async move {
            let mut c = self.conn.clone();
            let held: String = redis::Script::new(ACQUIRE)
                .key(key)
                .arg(value)
                .arg(ttl_ms)
                .arg(self_prefix)
                .invoke_async(&mut c)
                .await?;
            Ok((!held.is_empty()).then_some(held))
        })
    }

    fn renew<'a>(
        &'a self,
        key: &'a str,
        value: &'a str,
        ttl_ms: u64,
    ) -> BoxFuture<'a, anyhow::Result<bool>> {
        Box::pin(async move {
            let mut c = self.conn.clone();
            let n: i64 = redis::Script::new(RENEW)
                .key(key)
                .arg(value)
                .arg(ttl_ms)
                .invoke_async(&mut c)
                .await?;
            Ok(n == 1)
        })
    }

    fn release<'a>(&'a self, key: &'a str, value: &'a str) -> BoxFuture<'a, anyhow::Result<bool>> {
        Box::pin(async move {
            let mut c = self.conn.clone();
            let n: i64 = redis::Script::new(RELEASE)
                .key(key)
                .arg(value)
                .invoke_async(&mut c)
                .await?;
            Ok(n == 1)
        })
    }

    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, anyhow::Result<Option<String>>> {
        Box::pin(async move {
            let mut c = self.conn.clone();
            Ok(redis::cmd("GET").arg(key).query_async(&mut c).await?)
        })
    }

    fn steal<'a>(
        &'a self,
        key: &'a str,
        old: &'a str,
        new: &'a str,
        ttl_ms: u64,
    ) -> BoxFuture<'a, anyhow::Result<bool>> {
        Box::pin(async move {
            let mut c = self.conn.clone();
            let n: i64 = redis::Script::new(STEAL)
                .key(key)
                .arg(old)
                .arg(new)
                .arg(ttl_ms)
                .invoke_async(&mut c)
                .await?;
            Ok(n == 1)
        })
    }
}

// ---------- in-memory fake (tests) ----------

/// A Redis stand-in with a manual clock: same semantics as the Lua scripts above.
#[derive(Default)]
pub struct FakeLeases {
    now_ms: std::sync::atomic::AtomicU64,
    keys: Mutex<HashMap<String, (String, u64)>>,
    /// When set, every call fails (Redis unreachable).
    pub down: std::sync::atomic::AtomicBool,
}

impl FakeLeases {
    pub fn advance(&self, d: Duration) {
        self.now_ms
            .fetch_add(d.as_millis() as u64, std::sync::atomic::Ordering::SeqCst);
    }

    fn now(&self) -> u64 {
        self.now_ms.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn check(&self) -> anyhow::Result<()> {
        if self.down.load(std::sync::atomic::Ordering::SeqCst) {
            anyhow::bail!("redis down");
        }
        Ok(())
    }

    /// Live value of `key` (expired keys read as absent).
    pub fn value(&self, key: &str) -> Option<String> {
        let now = self.now();
        let mut keys = self.keys.lock().unwrap();
        match keys.get(key) {
            Some((_, exp)) if *exp <= now => {
                keys.remove(key);
                None
            }
            Some((v, _)) => Some(v.clone()),
            None => None,
        }
    }

    fn set(&self, key: &str, value: &str, ttl_ms: u64) {
        let exp = self.now() + ttl_ms;
        self.keys
            .lock()
            .unwrap()
            .insert(key.into(), (value.into(), exp));
    }
}

impl LeaseBackend for FakeLeases {
    fn acquire<'a>(
        &'a self,
        key: &'a str,
        value: &'a str,
        self_prefix: &'a str,
        ttl_ms: u64,
    ) -> BoxFuture<'a, anyhow::Result<Option<String>>> {
        Box::pin(async move {
            self.check()?;
            match self.value(key) {
                Some(v) if !v.starts_with(self_prefix) => Ok(Some(v)),
                _ => {
                    self.set(key, value, ttl_ms);
                    Ok(None)
                }
            }
        })
    }

    fn renew<'a>(
        &'a self,
        key: &'a str,
        value: &'a str,
        ttl_ms: u64,
    ) -> BoxFuture<'a, anyhow::Result<bool>> {
        Box::pin(async move {
            self.check()?;
            match self.value(key) {
                Some(v) if v != value => Ok(false),
                _ => {
                    self.set(key, value, ttl_ms);
                    Ok(true)
                }
            }
        })
    }

    fn release<'a>(&'a self, key: &'a str, value: &'a str) -> BoxFuture<'a, anyhow::Result<bool>> {
        Box::pin(async move {
            self.check()?;
            if self.value(key).as_deref() == Some(value) {
                self.keys.lock().unwrap().remove(key);
                return Ok(true);
            }
            Ok(false)
        })
    }

    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, anyhow::Result<Option<String>>> {
        Box::pin(async move {
            self.check()?;
            Ok(self.value(key))
        })
    }

    fn steal<'a>(
        &'a self,
        key: &'a str,
        old: &'a str,
        new: &'a str,
        ttl_ms: u64,
    ) -> BoxFuture<'a, anyhow::Result<bool>> {
        Box::pin(async move {
            self.check()?;
            match self.value(key) {
                Some(v) if v != old => Ok(false),
                _ => {
                    self.set(key, new, ttl_ms);
                    Ok(true)
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    const TTL: Duration = Duration::from_millis(15_000);

    fn nodes() -> (Arc<FakeLeases>, Leases, Leases) {
        let fake = Arc::new(FakeLeases::default());
        let a = Leases::new(fake.clone(), "n1", "http://n1:8080", TTL);
        let b = Leases::new(fake.clone(), "n2", "http://n2:8080", TTL);
        (fake, a, b)
    }

    #[tokio::test]
    async fn first_claim_wins_and_the_other_node_sees_the_owner() {
        let (fake, a, b) = nodes();
        assert_eq!(a.claim("r1").await.unwrap(), Claim::Mine);
        let Claim::Held(o) = b.claim("r1").await.unwrap() else {
            panic!("b must not own r1")
        };
        assert_eq!((o.node.as_str(), o.url.as_str()), ("n1", "http://n1:8080"));
        assert!(a.owns("r1") && !b.owns("r1"));
        assert!(
            fake.value("room:r1:owner")
                .unwrap()
                .starts_with("n1@http://n1:8080#")
        );
        // Claiming again is a no-op for the owner.
        assert_eq!(a.claim("r1").await.unwrap(), Claim::Mine);
    }

    #[tokio::test]
    async fn renewed_leases_survive_the_ttl_and_expired_ones_move() {
        let (fake, a, b) = nodes();
        a.claim("r1").await.unwrap();
        for _ in 0..5 {
            fake.advance(Duration::from_secs(5));
            assert!(a.renew_all().await.is_empty());
        }
        assert!(matches!(b.claim("r1").await.unwrap(), Claim::Held(_)));
        // The owner stops renewing (it died): after 15 s the room is free.
        fake.advance(TTL);
        assert_eq!(b.claim("r1").await.unwrap(), Claim::Mine);
        // The old owner notices on its next renewal and gives the room up.
        assert_eq!(a.renew_all().await, vec!["r1".to_string()]);
        assert!(!a.owns("r1"));
    }

    #[tokio::test]
    async fn release_only_deletes_our_own_value() {
        let (fake, a, b) = nodes();
        a.claim("r1").await.unwrap();
        fake.advance(TTL);
        b.claim("r1").await.unwrap();
        // a's lease expired and b took the room: a's release must not delete b's lease.
        a.release("r1").await.unwrap();
        assert!(fake.value("room:r1:owner").unwrap().starts_with("n2@"));
        b.release("r1").await.unwrap();
        assert_eq!(fake.value("room:r1:owner"), None);
        assert_eq!(a.claim("r1").await.unwrap(), Claim::Mine);
    }

    #[tokio::test]
    async fn steal_replaces_only_the_dead_owner() {
        let (fake, a, b) = nodes();
        a.claim("r1").await.unwrap();
        let Claim::Held(dead) = b.claim("r1").await.unwrap() else {
            panic!()
        };
        assert!(b.steal("r1", &dead).await.unwrap());
        assert!(b.owns("r1"));
        // A stale view of the owner cannot steal from the new one.
        let c = Leases::new(fake.clone(), "n3", "http://n3:8080", TTL);
        assert!(!c.steal("r1", &dead).await.unwrap());
        assert!(fake.value("room:r1:owner").unwrap().starts_with("n2@"));
        // The dead owner, if it comes back, learns it lost the room.
        assert_eq!(a.renew_all().await, vec!["r1".to_string()]);
    }

    #[tokio::test]
    async fn a_restarted_node_reclaims_its_own_lease() {
        let (fake, a, _) = nodes();
        a.claim("r1").await.unwrap();
        // Same node id, new process (empty `owned`): its old lease is not someone else's.
        let a2 = Leases::new(fake.clone(), "n1", "http://n1:8080", TTL);
        assert_eq!(a2.claim("r1").await.unwrap(), Claim::Mine);
        // The previous incarnation's value is gone, so its release is a no-op.
        a.release("r1").await.unwrap();
        assert!(fake.value("room:r1:owner").is_some());
    }

    #[tokio::test]
    async fn redis_errors_do_not_drop_rooms_and_expired_free_leases_are_retaken() {
        let (fake, a, _) = nodes();
        a.claim("r1").await.unwrap();
        fake.down.store(true, Ordering::SeqCst);
        assert!(a.renew_all().await.is_empty());
        assert!(a.owns("r1"));
        assert!(a.claim("r2").await.is_err());
        fake.down.store(false, Ordering::SeqCst);
        fake.advance(TTL * 2);
        // Expired while Redis was unreachable and nobody else took it: renewal re-takes it.
        assert!(a.renew_all().await.is_empty());
        assert!(fake.value("room:r1:owner").unwrap().starts_with("n1@"));
    }

    #[tokio::test]
    async fn release_all_frees_every_room() {
        let (fake, a, b) = nodes();
        for r in ["r1", "r2", "r3"] {
            a.claim(r).await.unwrap();
        }
        a.release_all().await;
        assert!(a.owned_rooms().is_empty());
        for r in ["r1", "r2", "r3"] {
            assert_eq!(fake.value(&key(r)), None);
            assert_eq!(b.claim(r).await.unwrap(), Claim::Mine);
        }
    }

    #[test]
    fn owner_values_parse() {
        let o = Owner::parse("n1@http://n1:8080#01J").unwrap();
        assert_eq!((o.node.as_str(), o.url.as_str()), ("n1", "http://n1:8080"));
        assert!(Owner::parse("garbage").is_none());
        assert!(Owner::parse("@http://x#1").is_none());
    }
}
