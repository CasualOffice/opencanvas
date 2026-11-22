// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The hot WAL in Redis (ADR-021, docs/03 §5.4): one stream per room, `oc:wal:{room}`, one
//! entry per update with id `<seq>-0`. Appends are a Lua script that checks the room's
//! fencing epoch (`oc:epoch:{room}`, mirrored from `room_epochs` when an actor claims the
//! room) and adds a whole batch atomically. The database gets a snapshot every
//! `OC_DB_SYNC_MS` (the room's compaction); only then is the stream trimmed up to that `seq`.
//!
//! Durability: an update is acknowledged once Redis has it. With AOF `appendfsync always`
//! nothing acknowledged is lost when Redis crashes; with `everysec`, up to about one second.

use anyhow::Context;
use redis::aio::ConnectionManager;

use crate::store::{Fenced, WalRow};

/// How often every node checks the instance id key.
const INSTANCE_CHECK: std::time::Duration = std::time::Duration::from_secs(2);

/// Raises the mirrored epoch (never lowers it). Kept for 8 days after the last claim.
const MIRROR: &str = r"
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local e = tonumber(ARGV[1])
if e > cur then redis.call('SET', KEYS[1], ARGV[1], 'EX', 691200) else redis.call('EXPIRE', KEYS[1], 691200) end
return 1
";

/// KEYS: stream, epoch. ARGV: epoch, then (seq, data, origin) per row, seq increasing.
/// A missing epoch key (Redis lost its data) is `NOEPOCH`, not `FENCED`: with a database the
/// caller restores the epoch from `room_epochs` and tries again (ADR-030). Refuses the whole batch when the epoch is stale or a seq is not above the stream's last
/// entry, before anything is added (a script is not rolled back on a later error).
const APPEND: &str = r"
local cur = redis.call('GET', KEYS[2])
if not cur then return redis.error_reply('NOEPOCH no fencing epoch') end
if cur ~= ARGV[1] then return redis.error_reply('FENCED stale epoch') end
local last = redis.call('XREVRANGE', KEYS[1], '+', '-', 'COUNT', 1)
local prev = 0
if #last > 0 then prev = tonumber(string.match(last[1][1], '^(%d+)-')) end
for i = 2, #ARGV, 3 do
  local s = tonumber(ARGV[i])
  if s <= prev then return redis.error_reply('WALSEQ seq ' .. s .. ' not above ' .. prev) end
  prev = s
end
for i = 2, #ARGV, 3 do
  redis.call('XADD', KEYS[1], ARGV[i] .. '-0', 'd', ARGV[i + 1], 'o', ARGV[i + 2])
end
return #ARGV
";

/// KEYS: stream, epoch. ARGV: epoch. Deletes the stream only while `epoch` is current.
const PURGE: &str = r"
local cur = redis.call('GET', KEYS[2])
if cur and cur ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
";

#[derive(Clone)]
pub struct RedisWal {
    conn: ConnectionManager,
    /// The value of [`INSTANCE_KEY`] this process last saw (ADR-030): when the key is gone,
    /// Redis lost its data (restart without AOF, `FLUSHALL`, failover to an empty replica).
    instance: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    /// Redis-only storage (no database behind it): a wipe is data loss, logged as such.
    storage: bool,
}

/// Set once (`SET NX`) by the first node to connect; its disappearance means a wipe.
pub const INSTANCE_KEY: &str = "oc:instance";

/// An append found no fencing epoch for the room in Redis (Redis lost its data).
#[derive(Debug, thiserror::Error)]
#[error("room {0}: no fencing epoch in Redis (Redis lost its data?)")]
pub struct NoEpoch(pub String);

pub fn stream_key(room: &str) -> String {
    format!("oc:wal:{{{room}}}")
}

pub fn epoch_key(room: &str) -> String {
    format!("oc:epoch:{{{room}}}")
}

impl RedisWal {
    /// The hot WAL in front of a database (ADR-028).
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        Self::connect_inner(url, false).await
    }

    /// The Redis of Redis-only storage (ADR-030): everything lives here.
    pub async fn connect_storage(url: &str) -> anyhow::Result<Self> {
        Self::connect_inner(url, true).await
    }

    async fn connect_inner(url: &str, storage: bool) -> anyhow::Result<Self> {
        let client = redis::Client::open(url).context("WAL Redis URL")?;
        let cfg = redis::aio::ConnectionManagerConfig::new()
            .set_connection_timeout(Some(std::time::Duration::from_secs(5)))
            .set_response_timeout(Some(std::time::Duration::from_secs(5)));
        let conn = ConnectionManager::new_with_config(client, cfg)
            .await
            .context("connecting to the WAL Redis")?;
        let wal = Self {
            conn,
            instance: Default::default(),
            storage,
        };
        wal.check_persistence().await;
        wal.check_instance().await?;
        let watch = wal.clone();
        tokio::spawn(async move {
            let mut every = tokio::time::interval(INSTANCE_CHECK);
            loop {
                every.tick().await;
                if let Err(e) = watch.check_instance().await {
                    tracing::debug!(error = %e, "Redis instance check failed");
                }
            }
        });
        Ok(wal)
    }

    pub fn conn(&self) -> ConnectionManager {
        self.conn.clone()
    }

    /// Reads (and, when missing, sets) the instance id key. Returns true when the key this
    /// process saw before is gone or changed: Redis lost its data since the last check.
    pub async fn check_instance(&self) -> anyhow::Result<bool> {
        let mut c = self.conn.clone();
        let fresh = ulid::Ulid::new().to_string();
        let _: Option<String> = redis::cmd("SET")
            .arg(INSTANCE_KEY)
            .arg(&fresh)
            .arg("NX")
            .query_async(&mut c)
            .await?;
        let now: Option<String> = redis::cmd("GET")
            .arg(INSTANCE_KEY)
            .query_async(&mut c)
            .await?;
        let mut seen = self.instance.lock().expect("instance lock");
        let wiped = seen.is_some() && *seen != now;
        if wiped {
            if self.storage {
                tracing::error!(
                    "REDIS LOST ITS DATA (instance id key {INSTANCE_KEY} gone): with Redis-only storage every room snapshot, \
                     WAL entry, epoch, outbox row, session and used launch token in it is gone. Rooms close with 1012 \
                     and rebuild from the host's last saved file plus what reconnecting clients resend; commits not yet \
                     saved by the host and edits of clients that do not come back are lost; open sessions must relaunch. \
                     Run Redis with appendonly yes (docs/13, ADR-030)"
                );
            } else {
                tracing::error!(
                    "Redis lost its data (instance id key {INSTANCE_KEY} gone): fencing epochs are restored from the \
                     database's room_epochs as rooms write; WAL entries since each room's last DB sync exist only \
                     in the owners' memory until the next sync (docs/13, ADR-030)"
                );
            }
        }
        *seen = now;
        Ok(wiped)
    }

    /// Warns when Redis would lose acknowledged edits on a crash (no AOF, or AOF without
    /// `appendfsync always`).
    async fn check_persistence(&self) {
        let mut c = self.conn.clone();
        let aof: Result<(String, String), _> = redis::cmd("CONFIG")
            .arg("GET")
            .arg("appendonly")
            .query_async(&mut c)
            .await;
        let fsync: Result<(String, String), _> = redis::cmd("CONFIG")
            .arg("GET")
            .arg("appendfsync")
            .query_async(&mut c)
            .await;
        match (aof, fsync) {
            (Ok((_, a)), _) if a == "no" && self.storage => tracing::warn!(
                "Redis-only storage on a Redis with appendonly=no: a Redis restart loses every room snapshot, WAL entry, epoch, pending commit and session; set appendonly yes and appendfsync always, or everysec with a replica (docs/13, ADR-030)"
            ),
            (Ok((_, a)), _) if a == "no" => tracing::warn!(
                "WAL Redis has appendonly=no: a Redis crash loses acknowledged edits since the last DB sync; set appendonly yes and appendfsync always (docs/13)"
            ),
            (Ok(_), Ok((_, f))) if f != "always" => tracing::warn!(
                appendfsync = %f,
                "WAL Redis is not fsyncing every write: a Redis crash can lose about the last second of acknowledged edits (docs/13)"
            ),
            (Ok(_), Ok(_)) => tracing::info!("WAL Redis: appendonly yes, appendfsync always"),
            (Err(e), _) | (_, Err(e)) => {
                tracing::warn!(error = %e, "could not read the WAL Redis persistence settings (CONFIG GET refused?)")
            }
        }
    }

    pub async fn mirror_epoch(&self, room: &str, epoch: i64) -> anyhow::Result<()> {
        let mut c = self.conn.clone();
        let _: i64 = redis::Script::new(MIRROR)
            .key(epoch_key(room))
            .arg(epoch)
            .invoke_async(&mut c)
            .await
            .context("mirroring the room epoch to Redis")?;
        Ok(())
    }

    /// Appends a batch in one round trip; [`Fenced`] when `epoch` is stale.
    pub async fn append(&self, room: &str, epoch: i64, rows: &[WalRow]) -> anyhow::Result<()> {
        let mut c = self.conn.clone();
        let script = redis::Script::new(APPEND);
        let mut inv = script.key(stream_key(room));
        inv.key(epoch_key(room)).arg(epoch);
        for r in rows {
            inv.arg(r.seq).arg(r.data.as_slice()).arg(r.origin.as_str());
        }
        match inv.invoke_async::<i64>(&mut c).await {
            Ok(_) => Ok(()),
            Err(e) if e.to_string().contains("NOEPOCH") => Err(NoEpoch(room.into()).into()),
            Err(e) if e.to_string().contains("FENCED") => Err(Fenced(room.into()).into()),
            Err(e) => Err(anyhow::Error::new(e).context("Redis WAL append")),
        }
    }

    /// Entries with `seq > after`, in order.
    pub async fn read_after(&self, room: &str, after: i64) -> anyhow::Result<Vec<(i64, Vec<u8>)>> {
        let mut c = self.conn.clone();
        let reply: redis::streams::StreamRangeReply = redis::cmd("XRANGE")
            .arg(stream_key(room))
            .arg(format!("({after}-0"))
            .arg("+")
            .query_async(&mut c)
            .await
            .context("reading the Redis WAL")?;
        reply
            .ids
            .into_iter()
            .map(|e| {
                let seq =
                    e.id.split('-')
                        .next()
                        .and_then(|s| s.parse::<i64>().ok())
                        .context("Redis WAL entry id")?;
                let data: Vec<u8> = e.get("d").context("Redis WAL entry without data")?;
                Ok((seq, data))
            })
            .collect()
    }

    /// Drops entries with `seq <= upto` (they are in the DB snapshot now).
    pub async fn trim(&self, room: &str, upto: i64) -> anyhow::Result<()> {
        let mut c = self.conn.clone();
        let _: i64 = redis::cmd("XTRIM")
            .arg(stream_key(room))
            .arg("MINID")
            .arg(format!("{}-0", upto + 1))
            .query_async(&mut c)
            .await
            .context("trimming the Redis WAL")?;
        Ok(())
    }

    /// Deletes the room's stream; with `epoch`, only while it is still the room's latest.
    pub async fn purge(&self, room: &str, epoch: Option<i64>) -> anyhow::Result<bool> {
        let mut c = self.conn.clone();
        let n: i64 = match epoch {
            Some(e) => {
                redis::Script::new(PURGE)
                    .key(stream_key(room))
                    .key(epoch_key(room))
                    .arg(e)
                    .invoke_async(&mut c)
                    .await?
            }
            None => redis::cmd("DEL")
                .arg(stream_key(room))
                .query_async::<i64>(&mut c)
                .await
                .map(|_| 1)?,
        };
        Ok(n == 1)
    }

    /// Ephemeral storage (ADR-043): deletes the room's stream and its epoch mirror.
    pub async fn destroy(&self, room: &str) -> anyhow::Result<()> {
        let mut c = self.conn.clone();
        redis::cmd("DEL")
            .arg(stream_key(room))
            .arg(epoch_key(room))
            .query_async::<i64>(&mut c)
            .await?;
        Ok(())
    }

    /// How many of the room's keys exist (tests).
    pub async fn room_keys(&self, room: &str) -> anyhow::Result<i64> {
        let mut c = self.conn.clone();
        Ok(redis::cmd("EXISTS")
            .arg(stream_key(room))
            .arg(epoch_key(room))
            .query_async(&mut c)
            .await?)
    }

    /// Entries in the room's stream (tests and diagnostics).
    pub async fn len(&self, room: &str) -> anyhow::Result<i64> {
        let mut c = self.conn.clone();
        Ok(redis::cmd("XLEN")
            .arg(stream_key(room))
            .query_async(&mut c)
            .await?)
    }
}
