// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Redis-only storage (ADR-030): a cluster with `REDIS_URL` and no `DATABASE_URL` keeps every
//! piece of transient server state in Redis. [`crate::store::Store`] dispatches here before its
//! SQL code, so the SQLite and MySQL/MariaDB paths are unchanged.
//!
//! Keys (one standalone Redis or a Sentinel-managed primary; the scripts touch keys of one room
//! that are not all passed as `KEYS`, so Redis Cluster is not supported):
//!
//! | SQL table | Redis |
//! |---|---|
//! | `room_epochs` | `oc:epoch:{room}`: authoritative counter, `INCR` per claim (seeded at the clock) |
//! | `room_updates` | `oc:wal:{room}` stream (the hot WAL, [`crate::redis_wal`]) |
//! | `room_snapshots` | `oc:snap:{room}` hash `seq`, `state`, `at` (the periodic sync target) |
//! | `rooms` | `oc:room:{room}` hash; set `oc:rooms` |
//! | `commit_outbox` | `oc:ob:{id}` hash per row; zsets `oc:obroom:{room}` and `oc:obpending` (by `created_at`) |
//! | `notify_outbox` | `oc:nt:{id}` hash; zset `oc:ntdue` (pending rows by `next_try_at`) |
//! | `sessions` | `oc:sess:{ticket}` hash (expires with the ticket); zset `oc:roomsess:{room}` |
//! | `launch_jti` | `oc:jti:{host}:{jti}`, `SET NX EX` |
//! | `ai_usage` | `oc:aiuse:{month}` hash host → tokens, `HINCRBY` (62-day TTL) |
//! | `room_assets` | `oc:asset:{room}` (data) and `oc:assetm:{room}` (JSON meta) hashes; set `oc:assetrooms` |
//!
//! Every guarded write (outbox insert, snapshot, closing purge, WAL append) is one Lua script
//! that first compares the writer's epoch with `oc:epoch:{room}`: a stale writer changes
//! nothing ([`Fenced`]). Secrets are sealed by the caller (`Store`) exactly as in SQL.

use std::collections::HashMap;

use anyhow::Context;
use redis::aio::ConnectionManager;

use crate::redis_wal::{RedisWal, epoch_key, stream_key};
use crate::store::{Fenced, NotifyRow, OutboxRow, RoomRow, Wal};

/// Epoch keys live 8 days past the last claim (the SQL rows are swept after a week).
const EPOCH_TTL_SECS: i64 = 691_200;
/// Sessions are kept an hour past their expiry (the SQL purge runs hourly), like SQL.
const SESSION_GRACE_SECS: i64 = 3_600;
/// Monthly AI usage counters outlive their month by a few weeks (for the operator to read).
const AI_USAGE_TTL_SECS: i64 = 86_400 * 62;
/// Finished notification rows are kept a day (their id still deduplicates).
const NOTIFY_KEEP_SECS: i64 = 86_400;

fn snap_key(room: &str) -> String {
    format!("oc:snap:{{{room}}}")
}
fn room_key(room: &str) -> String {
    format!("oc:room:{{{room}}}")
}
const ROOMS: &str = "oc:rooms";
fn ob_key(id: &str) -> String {
    format!("oc:ob:{id}")
}
fn ob_room_key(room: &str) -> String {
    format!("oc:obroom:{{{room}}}")
}
const OB_PENDING: &str = "oc:obpending";
fn nt_key(id: &str) -> String {
    format!("oc:nt:{id}")
}
const NT_DUE: &str = "oc:ntdue";
fn sess_key(ticket: &str) -> String {
    format!("oc:sess:{ticket}")
}
fn room_sess_key(room: &str) -> String {
    format!("oc:roomsess:{{{room}}}")
}
/// `Idempotency-Key` entries (HAPI-03): `id` is already a hash of host, subject and key.
fn idem_key(host: &str, id: &str) -> String {
    format!("oc:idem:{host}:{id}")
}

/// Deletes an idempotency entry only while it is still this request's running claim.
const IDEM_RELEASE: &str = r"
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
";

fn idem_running(request_hash: &str) -> String {
    serde_json::json!({"h": request_hash, "s": "running"}).to_string()
}

fn jti_key(host: &str, jti: &str) -> String {
    format!("oc:jti:{host}:{jti}")
}
fn asset_key(room: &str) -> String {
    format!("oc:asset:{{{room}}}")
}
fn asset_meta_key(room: &str) -> String {
    format!("oc:assetm:{{{room}}}")
}
const ASSET_ROOMS: &str = "oc:assetrooms";

/// KEYS: epoch. ARGV: now_ms, ttl. The next epoch: `INCR`, or `now_ms` when the room has none
/// (first claim, expired, or Redis lost its data), so an epoch handed out before is never
/// handed out again.
const CLAIM: &str = r"
local e
if redis.call('EXISTS', KEYS[1]) == 1 then
  e = redis.call('INCR', KEYS[1])
else
  e = tonumber(ARGV[1])
  redis.call('SET', KEYS[1], ARGV[1])
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return e
";

/// KEYS: epoch, room index, pending index, row. ARGV: epoch, id, now, then field/value pairs.
/// Older pending rows of the room are superseded (payload dropped) and the row is added, all
/// under the epoch check. A row id is the commit's idempotency key: a second insert is refused.
const OUTBOX_INSERT: &str = r"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return redis.error_reply('FENCED stale epoch') end
if redis.call('EXISTS', KEYS[4]) == 1 then return redis.error_reply('DUPLICATE outbox id') end
for _, id in ipairs(redis.call('ZRANGE', KEYS[2], 0, -1)) do
  local k = 'oc:ob:' .. id
  if redis.call('HGET', k, 'status') == 'pending' then
    redis.call('HSET', k, 'status', 'superseded', 'payload', '')
    redis.call('ZREM', KEYS[3], id)
  end
end
local fields = {}
for i = 4, #ARGV do fields[#fields + 1] = ARGV[i] end
redis.call('HSET', KEYS[4], unpack(fields))
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[2])
return 1
";

/// KEYS: row, pending index. ARGV: id, status.
const OUTBOX_FINISH: &str = r"
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'payload', '')
redis.call('HDEL', KEYS[1], 'last_error')
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
";

/// KEYS: row. ARGV: node, now, until. Same predicate as the SQL `UPDATE … WHERE`.
const OUTBOX_CLAIM: &str = r"
if redis.call('HGET', KEYS[1], 'status') ~= 'pending' then return 0 end
local by = redis.call('HGET', KEYS[1], 'claimed_by')
local untl = redis.call('HGET', KEYS[1], 'claim_until')
if untl and tonumber(untl) >= tonumber(ARGV[2]) and by ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'claimed_by', ARGV[1], 'claim_until', ARGV[3])
return 1
";

/// KEYS: row. ARGV: next_try_at, error.
const OUTBOX_FAILED: &str = r"
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HINCRBY', KEYS[1], 'attempts', 1)
redis.call('HSET', KEYS[1], 'next_try_at', ARGV[1], 'last_error', ARGV[2])
return 1
";

/// KEYS: row, due index. ARGV: id, next_try_at, then field/value pairs.
const NOTIFY_INSERT: &str = r"
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local fields = {}
for i = 3, #ARGV do fields[#fields + 1] = ARGV[i] end
redis.call('HSET', KEYS[1], unpack(fields))
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return 1
";

/// KEYS: row, due index. ARGV: id, seen, until.
const NOTIFY_CLAIM: &str = r"
if redis.call('HGET', KEYS[1], 'status') ~= 'pending' then return 0 end
if redis.call('HGET', KEYS[1], 'next_try_at') ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], 'next_try_at', ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1
";

/// KEYS: row, due index. ARGV: id, status, keep secs.
const NOTIFY_FINISH: &str = r"
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'payload', '')
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
";

/// KEYS: row, due index. ARGV: id, next_try_at.
const NOTIFY_RETRY: &str = r"
if redis.call('HGET', KEYS[1], 'status') ~= 'pending' then return 0 end
redis.call('HINCRBY', KEYS[1], 'attempts', 1)
redis.call('HSET', KEYS[1], 'next_try_at', ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return 1
";

/// KEYS: epoch, snapshot, stream. ARGV: epoch, seq, state, now. The periodic sync: refused
/// when the epoch is stale; a late dump never replaces a newer one; the stream entries the
/// snapshot covers are trimmed in the same script.
const COMPACT: &str = r"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return redis.error_reply('FENCED stale epoch') end
local newer = redis.call('HGET', KEYS[2], 'seq')
if newer and tonumber(newer) > tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[2], 'seq', ARGV[2], 'state', ARGV[3], 'at', ARGV[4])
redis.call('XTRIM', KEYS[3], 'MINID', (tonumber(ARGV[2]) + 1) .. '-0')
return 1
";

/// KEYS: epoch, snapshot, stream, room, room outbox index, rooms set. ARGV: room, epoch ('' =
/// unguarded). Drops the room's WAL, snapshot, row and finished outbox rows (pending ones stay
/// for the sweeper), like SQL `purge_in`.
const PURGE: &str = r"
if ARGV[2] ~= '' and redis.call('GET', KEYS[1]) ~= ARGV[2] then
  return redis.error_reply('FENCED stale epoch')
end
redis.call('DEL', KEYS[2], KEYS[3], KEYS[4])
redis.call('SREM', KEYS[6], ARGV[1])
for _, id in ipairs(redis.call('ZRANGE', KEYS[5], 0, -1)) do
  local k = 'oc:ob:' .. id
  local st = redis.call('HGET', k, 'status')
  if st ~= 'pending' then
    redis.call('DEL', k)
    redis.call('ZREM', KEYS[5], id)
  end
end
return 1
";

/// KEYS: epoch, snap, stream, room, obroom, rooms, roomsess, asset, assetm, assetrooms,
/// obpending. ARGV: room, epoch ('' = unfenced). Deletes everything of the room (ADR-043).
const DESTROY: &str = r"
if ARGV[2] ~= '' and redis.call('GET', KEYS[1]) ~= ARGV[2] then
  return redis.error_reply('FENCED stale epoch')
end
for _, id in ipairs(redis.call('ZRANGE', KEYS[5], 0, -1)) do
  redis.call('DEL', 'oc:ob:' .. id)
  redis.call('ZREM', KEYS[11], id)
end
for _, t in ipairs(redis.call('ZRANGE', KEYS[7], 0, -1)) do
  redis.call('DEL', 'oc:sess:' .. t)
end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[7], KEYS[8], KEYS[9])
redis.call('SREM', KEYS[6], ARGV[1])
redis.call('SREM', KEYS[10], ARGV[1])
return 1
";

/// KEYS: room. ARGV: version ('' = none), has version, dirty, now, committed.
const MARK_ROOM: &str = r"
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if ARGV[2] == '1' then redis.call('HSET', KEYS[1], 'hv', ARGV[1]) else redis.call('HDEL', KEYS[1], 'hv') end
redis.call('HSET', KEYS[1], 'dirty', ARGV[3], 'la', ARGV[4])
if ARGV[5] == '1' then redis.call('HSET', KEYS[1], 'lc', ARGV[4]) end
return 1
";

/// KEYS: session. ARGV: role, sealed grant JSON.
const SESSION_UPDATE: &str = r"
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'role', ARGV[1], 'g', ARGV[2])
return 1
";

type Fields = HashMap<String, Vec<u8>>;

fn text(f: &Fields, k: &str) -> Option<String> {
    f.get(k).map(|v| String::from_utf8_lossy(v).into_owned())
}

fn int(f: &Fields, k: &str) -> i64 {
    text(f, k).and_then(|s| s.parse().ok()).unwrap_or(0)
}

fn fenced_or(room: &str, e: redis::RedisError, what: &'static str) -> anyhow::Error {
    if e.to_string().contains("FENCED") {
        Fenced(room.into()).into()
    } else {
        anyhow::Error::new(e).context(what)
    }
}

/// [`crate::store::Store`]'s Redis-only backend. Values that hold secrets (grants, callback
/// tokens) arrive and leave sealed.
#[derive(Clone)]
pub struct RedisStore {
    conn: ConnectionManager,
    wal: RedisWal,
}

impl RedisStore {
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        let wal = RedisWal::connect_storage(url).await?;
        Ok(Self {
            conn: wal.conn(),
            wal,
        })
    }

    pub fn wal(&self) -> &RedisWal {
        &self.wal
    }

    fn c(&self) -> ConnectionManager {
        self.conn.clone()
    }

    pub async fn ping(&self) -> bool {
        redis::cmd("PING")
            .query_async::<String>(&mut self.c())
            .await
            .is_ok()
    }

    // ---------- AI usage ----------

    pub async fn ai_usage_add(&self, host: &str, month: &str, tokens: u64) -> anyhow::Result<u64> {
        let key = format!("oc:aiuse:{month}");
        let n = i64::try_from(tokens).unwrap_or(i64::MAX);
        let (total, _): (i64, i64) = redis::pipe()
            .atomic()
            .cmd("HINCRBY")
            .arg(&key)
            .arg(host)
            .arg(n)
            .cmd("EXPIRE")
            .arg(&key)
            .arg(AI_USAGE_TTL_SECS)
            .query_async(&mut self.c())
            .await
            .context("adding AI usage")?;
        Ok(total.max(0) as u64)
    }

    pub async fn ai_usage_month(&self, month: &str) -> anyhow::Result<HashMap<String, u64>> {
        let m: HashMap<String, i64> = redis::cmd("HGETALL")
            .arg(format!("oc:aiuse:{month}"))
            .query_async(&mut self.c())
            .await
            .context("reading AI usage")?;
        Ok(m.into_iter().map(|(k, v)| (k, v.max(0) as u64)).collect())
    }

    // ---------- launch jti ----------

    pub async fn use_jti(
        &self,
        host: &str,
        jti: &str,
        expires_at: i64,
        now: i64,
    ) -> anyhow::Result<bool> {
        let ttl = (expires_at - now).max(60);
        let set: Option<String> = redis::cmd("SET")
            .arg(jti_key(host, jti))
            .arg(1)
            .arg("NX")
            .arg("EX")
            .arg(ttl)
            .query_async(&mut self.c())
            .await
            .context("recording the launch jti")?;
        Ok(set.is_some())
    }

    // ---------- idempotency (HAPI-03) ----------

    pub async fn idem_begin(
        &self,
        host: &str,
        id: &str,
        request_hash: &str,
        lease: i64,
    ) -> anyhow::Result<crate::store::IdemBegin> {
        use crate::store::IdemBegin;
        let key = idem_key(host, id);
        for _ in 0..4 {
            let set: Option<String> = redis::cmd("SET")
                .arg(&key)
                .arg(idem_running(request_hash))
                .arg("NX")
                .arg("EX")
                .arg(lease.max(1))
                .query_async(&mut self.c())
                .await
                .context("claiming an idempotency key")?;
            if set.is_some() {
                return Ok(IdemBegin::Started);
            }
            let got: Option<String> = redis::cmd("GET")
                .arg(&key)
                .query_async(&mut self.c())
                .await?;
            // Expired between the two calls: claim again.
            let Some(v) = got.and_then(|g| serde_json::from_str::<serde_json::Value>(&g).ok())
            else {
                continue;
            };
            if v["h"].as_str() != Some(request_hash) {
                return Ok(IdemBegin::Mismatch);
            }
            if v["s"] != "done" {
                return Ok(IdemBegin::InProgress);
            }
            return Ok(IdemBegin::Replay {
                status: v["status"].as_u64().unwrap_or(200) as u16,
                response: v["r"].as_str().unwrap_or_default().to_string(),
            });
        }
        anyhow::bail!("idempotency key claim kept racing")
    }

    pub async fn idem_finish(
        &self,
        host: &str,
        id: &str,
        request_hash: &str,
        status: u16,
        response: &str,
        ttl: i64,
    ) -> anyhow::Result<()> {
        let v =
            serde_json::json!({"h": request_hash, "s": "done", "status": status, "r": response});
        let _: () = redis::cmd("SET")
            .arg(idem_key(host, id))
            .arg(v.to_string())
            .arg("EX")
            .arg(ttl.max(1))
            .query_async(&mut self.c())
            .await
            .context("storing an idempotent answer")?;
        Ok(())
    }

    pub async fn idem_release(
        &self,
        host: &str,
        id: &str,
        request_hash: &str,
    ) -> anyhow::Result<()> {
        let _: i64 = redis::Script::new(IDEM_RELEASE)
            .key(idem_key(host, id))
            .arg(idem_running(request_hash))
            .invoke_async(&mut self.c())
            .await
            .context("releasing an idempotency key")?;
        Ok(())
    }

    // ---------- sessions ----------

    /// `sealed` is the grant JSON with its callback token sealed.
    pub async fn insert_session(
        &self,
        ticket: &str,
        grant: &crate::grant::Grant,
        sealed: &str,
        expires_at: i64,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        let (room, user, role) = (&grant.room, &grant.user.id, grant.role.as_str());
        let k = sess_key(ticket);
        let idx = room_sess_key(room);
        redis::pipe()
            .atomic()
            .hset_multiple(
                &k,
                &[
                    ("g", sealed),
                    ("room", room),
                    ("user", user),
                    ("role", role),
                    ("exp", &expires_at.to_string()),
                ],
            )
            .ignore()
            .cmd("EXPIREAT")
            .arg(&k)
            .arg(expires_at + SESSION_GRACE_SECS)
            .ignore()
            .zadd(&idx, ticket, now_ms)
            .ignore()
            .cmd("EXPIREAT")
            .arg(&idx)
            .arg(expires_at + SESSION_GRACE_SECS)
            .arg("GT")
            .ignore()
            .cmd("EXPIREAT")
            .arg(&idx)
            .arg(expires_at + SESSION_GRACE_SECS)
            .arg("NX")
            .ignore()
            .query_async::<()>(&mut self.c())
            .await
            .context("storing the session")?;
        Ok(())
    }

    /// Sealed grant JSON and expiry (unix seconds).
    pub async fn session(&self, ticket: &str) -> anyhow::Result<Option<(String, i64)>> {
        let (g, exp): (Option<String>, Option<i64>) = redis::cmd("HMGET")
            .arg(sess_key(ticket))
            .arg("g")
            .arg("exp")
            .query_async(&mut self.c())
            .await?;
        Ok(g.zip(exp))
    }

    /// `(ticket, user, sealed grant)` of every live session of `room`, oldest first.
    pub async fn room_sessions(&self, room: &str) -> anyhow::Result<Vec<(String, String, String)>> {
        let idx = room_sess_key(room);
        let tickets: Vec<String> = redis::cmd("ZRANGE")
            .arg(&idx)
            .arg(0)
            .arg(-1)
            .query_async(&mut self.c())
            .await?;
        if tickets.is_empty() {
            return Ok(vec![]);
        }
        let mut pipe = redis::pipe();
        for t in &tickets {
            pipe.cmd("HMGET").arg(sess_key(t)).arg("user").arg("g");
        }
        let rows: Vec<(Option<String>, Option<String>)> = pipe.query_async(&mut self.c()).await?;
        let mut out = Vec::new();
        let mut gone = Vec::new();
        for (t, (u, g)) in tickets.into_iter().zip(rows) {
            match (u, g) {
                (Some(u), Some(g)) => out.push((t, u, g)),
                _ => gone.push(t),
            }
        }
        if !gone.is_empty() {
            let _: Result<i64, _> = redis::cmd("ZREM")
                .arg(&idx)
                .arg(&gone)
                .query_async(&mut self.c())
                .await;
        }
        Ok(out)
    }

    pub async fn update_session(
        &self,
        ticket: &str,
        role: &str,
        sealed: &str,
    ) -> anyhow::Result<bool> {
        let n: i64 = redis::Script::new(SESSION_UPDATE)
            .key(sess_key(ticket))
            .arg(role)
            .arg(sealed)
            .invoke_async(&mut self.c())
            .await?;
        Ok(n == 1)
    }

    /// Deletes the given sessions of `room`; returns how many existed.
    pub async fn delete_sessions(&self, room: &str, tickets: &[String]) -> anyhow::Result<u64> {
        if tickets.is_empty() {
            return Ok(0);
        }
        let keys: Vec<String> = tickets.iter().map(|t| sess_key(t)).collect();
        let (n, _): (u64, i64) = redis::pipe()
            .atomic()
            .del(&keys)
            .zrem(room_sess_key(room), tickets)
            .query_async(&mut self.c())
            .await?;
        Ok(n)
    }

    // ---------- commit outbox ----------

    /// `row.token` must be sealed already.
    pub async fn outbox_insert(
        &self,
        row: &OutboxRow,
        epoch: i64,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        let mut fields: Vec<(&str, Vec<u8>)> = vec![
            ("room_id", row.room_id.clone().into_bytes()),
            ("host_id", row.host_id.clone().into_bytes()),
            ("file_id", row.file_id.clone().into_bytes()),
            ("seq", row.seq.to_string().into_bytes()),
            ("token", row.token.clone().into_bytes()),
            ("payload", row.payload.clone()),
            ("authors", serde_json::to_string(&row.authors)?.into_bytes()),
            ("attempts", b"0".to_vec()),
            ("next_try_at", now_ms.to_string().into_bytes()),
            ("status", b"pending".to_vec()),
            ("created_at", now_ms.to_string().into_bytes()),
        ];
        if let Some(v) = &row.base_version {
            fields.push(("base_version", v.clone().into_bytes()));
        }
        let script = redis::Script::new(OUTBOX_INSERT);
        let mut inv = script.key(epoch_key(&row.room_id));
        inv.key(ob_room_key(&row.room_id))
            .key(OB_PENDING)
            .key(ob_key(&row.id))
            .arg(epoch)
            .arg(&row.id)
            .arg(now_ms);
        for (k, v) in &fields {
            inv.arg(*k).arg(v.as_slice());
        }
        inv.invoke_async::<i64>(&mut self.c())
            .await
            .map_err(|e| fenced_or(&row.room_id, e, "writing the commit outbox"))?;
        Ok(())
    }

    async fn outbox_read(&self, ids: &[String]) -> anyhow::Result<Vec<OutboxRow>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let mut pipe = redis::pipe();
        for id in ids {
            pipe.hgetall(ob_key(id));
        }
        let rows: Vec<Fields> = pipe.query_async(&mut self.c()).await?;
        Ok(ids
            .iter()
            .zip(rows)
            .filter(|(_, f)| !f.is_empty())
            .map(|(id, f)| OutboxRow {
                id: id.clone(),
                room_id: text(&f, "room_id").unwrap_or_default(),
                host_id: text(&f, "host_id").unwrap_or_default(),
                file_id: text(&f, "file_id").unwrap_or_default(),
                seq: int(&f, "seq"),
                base_version: text(&f, "base_version"),
                token: text(&f, "token").unwrap_or_default(),
                payload: f.get("payload").cloned().unwrap_or_default(),
                authors: text(&f, "authors")
                    .and_then(|a| serde_json::from_str(&a).ok())
                    .unwrap_or_default(),
                attempts: int(&f, "attempts"),
                status: text(&f, "status").unwrap_or_default(),
            })
            .collect())
    }

    /// All rows of a room, oldest first (tokens sealed).
    pub async fn outbox_rows(&self, room: &str) -> anyhow::Result<Vec<OutboxRow>> {
        let ids: Vec<String> = redis::cmd("ZRANGE")
            .arg(ob_room_key(room))
            .arg(0)
            .arg(-1)
            .query_async(&mut self.c())
            .await?;
        self.outbox_read(&ids).await
    }

    /// Every pending row, oldest first (tokens sealed).
    pub async fn outbox_all_pending(&self) -> anyhow::Result<Vec<OutboxRow>> {
        let ids: Vec<String> = redis::cmd("ZRANGE")
            .arg(OB_PENDING)
            .arg(0)
            .arg(-1)
            .query_async(&mut self.c())
            .await?;
        Ok(self
            .outbox_read(&ids)
            .await?
            .into_iter()
            .filter(|r| r.status == "pending")
            .collect())
    }

    pub async fn outbox_finish(&self, id: &str, status: &str) -> anyhow::Result<()> {
        redis::Script::new(OUTBOX_FINISH)
            .key(ob_key(id))
            .key(OB_PENDING)
            .arg(id)
            .arg(status)
            .invoke_async::<i64>(&mut self.c())
            .await
            .context("marking the commit done")?;
        Ok(())
    }

    pub async fn outbox_claim(
        &self,
        id: &str,
        node: &str,
        now_ms: i64,
        until_ms: i64,
    ) -> anyhow::Result<bool> {
        let n: i64 = redis::Script::new(OUTBOX_CLAIM)
            .key(ob_key(id))
            .arg(node)
            .arg(now_ms)
            .arg(until_ms)
            .invoke_async(&mut self.c())
            .await?;
        Ok(n == 1)
    }

    pub async fn outbox_failed(
        &self,
        id: &str,
        next_try_at: i64,
        error: &str,
    ) -> anyhow::Result<()> {
        redis::Script::new(OUTBOX_FAILED)
            .key(ob_key(id))
            .arg(next_try_at)
            .arg(error)
            .invoke_async::<i64>(&mut self.c())
            .await?;
        Ok(())
    }

    /// Room ids that have a pending commit.
    async fn rooms_with_pending(&self) -> anyhow::Result<std::collections::HashSet<String>> {
        Ok(self
            .outbox_all_pending()
            .await?
            .into_iter()
            .map(|r| r.room_id)
            .collect())
    }

    // ---------- notification outbox ----------

    /// `row.token` must be sealed already.
    pub async fn notify_insert(&self, row: &NotifyRow, now_ms: i64) -> anyhow::Result<bool> {
        let n: i64 = redis::Script::new(NOTIFY_INSERT)
            .key(nt_key(&row.id))
            .key(NT_DUE)
            .arg(&row.id)
            .arg(row.next_try_at)
            .arg("room_id")
            .arg(&row.room_id)
            .arg("host_id")
            .arg(&row.host_id)
            .arg("file_id")
            .arg(&row.file_id)
            .arg("kind")
            .arg(&row.kind)
            .arg("token")
            .arg(&row.token)
            .arg("payload")
            .arg(&row.payload)
            .arg("attempts")
            .arg(0)
            .arg("next_try_at")
            .arg(row.next_try_at)
            .arg("status")
            .arg("pending")
            .arg("created_at")
            .arg(now_ms)
            .invoke_async(&mut self.c())
            .await
            .context("queueing the notification")?;
        Ok(n == 1)
    }

    /// Pending rows due at `now_ms`, by `next_try_at` then id (tokens sealed).
    pub async fn notify_due(&self, now_ms: i64, limit: i64) -> anyhow::Result<Vec<NotifyRow>> {
        let ids: Vec<String> = redis::cmd("ZRANGEBYSCORE")
            .arg(NT_DUE)
            .arg("-inf")
            .arg(now_ms)
            .arg("LIMIT")
            .arg(0)
            .arg(limit)
            .query_async(&mut self.c())
            .await?;
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let mut pipe = redis::pipe();
        for id in &ids {
            pipe.hgetall(nt_key(id));
        }
        let rows: Vec<Fields> = pipe.query_async(&mut self.c()).await?;
        Ok(ids
            .into_iter()
            .zip(rows)
            .filter(|(_, f)| text(f, "status").as_deref() == Some("pending"))
            .map(|(id, f)| NotifyRow {
                id,
                room_id: text(&f, "room_id").unwrap_or_default(),
                host_id: text(&f, "host_id").unwrap_or_default(),
                file_id: text(&f, "file_id").unwrap_or_default(),
                kind: text(&f, "kind").unwrap_or_default(),
                token: text(&f, "token").unwrap_or_default(),
                payload: text(&f, "payload").unwrap_or_default(),
                attempts: int(&f, "attempts"),
                next_try_at: int(&f, "next_try_at"),
            })
            .collect())
    }

    pub async fn notify_claim(&self, id: &str, seen: i64, until: i64) -> anyhow::Result<bool> {
        let n: i64 = redis::Script::new(NOTIFY_CLAIM)
            .key(nt_key(id))
            .key(NT_DUE)
            .arg(id)
            .arg(seen)
            .arg(until)
            .invoke_async(&mut self.c())
            .await?;
        Ok(n == 1)
    }

    pub async fn notify_finish(&self, id: &str, status: &str) -> anyhow::Result<()> {
        redis::Script::new(NOTIFY_FINISH)
            .key(nt_key(id))
            .key(NT_DUE)
            .arg(id)
            .arg(status)
            .arg(NOTIFY_KEEP_SECS)
            .invoke_async::<i64>(&mut self.c())
            .await?;
        Ok(())
    }

    pub async fn notify_retry(&self, id: &str, next_try_at: i64) -> anyhow::Result<()> {
        redis::Script::new(NOTIFY_RETRY)
            .key(nt_key(id))
            .key(NT_DUE)
            .arg(id)
            .arg(next_try_at)
            .invoke_async::<i64>(&mut self.c())
            .await?;
        Ok(())
    }

    pub async fn notify_status(&self, id: &str) -> anyhow::Result<Option<(String, String)>> {
        let (s, p): (Option<String>, Option<String>) = redis::cmd("HMGET")
            .arg(nt_key(id))
            .arg("status")
            .arg("payload")
            .query_async(&mut self.c())
            .await?;
        Ok(s.map(|s| (s, p.unwrap_or_default())))
    }

    // ---------- epochs, rooms, WAL, snapshots ----------

    /// The room's next epoch (authoritative here).
    pub async fn claim_epoch(&self, room: &str, now_ms: i64) -> anyhow::Result<i64> {
        redis::Script::new(CLAIM)
            .key(epoch_key(room))
            .arg(now_ms)
            .arg(EPOCH_TTL_SECS)
            .invoke_async(&mut self.c())
            .await
            .context("claiming the room epoch")
    }

    pub async fn room_epoch(&self, room: &str) -> anyhow::Result<Option<i64>> {
        Ok(redis::cmd("GET")
            .arg(epoch_key(room))
            .query_async(&mut self.c())
            .await?)
    }

    pub async fn room(&self, id: &str) -> anyhow::Result<Option<RoomRow>> {
        let f: Fields = redis::cmd("HGETALL")
            .arg(room_key(id))
            .query_async(&mut self.c())
            .await?;
        if f.is_empty() {
            return Ok(None);
        }
        Ok(Some(RoomRow {
            host_version: text(&f, "hv"),
            dirty: int(&f, "dirty") != 0,
        }))
    }

    pub async fn put_room(
        &self,
        id: &str,
        host: &str,
        file: &str,
        version: Option<&str>,
        dirty: bool,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        let k = room_key(id);
        let mut fields = vec![
            ("host_id", host.to_string()),
            ("file_id", file.to_string()),
            ("dirty", i32::from(dirty).to_string()),
            ("la", now_ms.to_string()),
        ];
        if let Some(v) = version {
            fields.push(("hv", v.to_string()));
        }
        redis::pipe()
            .atomic()
            .del(&k)
            .ignore()
            .hset_multiple(&k, &fields)
            .ignore()
            .sadd(ROOMS, id)
            .ignore()
            .query_async::<()>(&mut self.c())
            .await
            .context("storing the room row")?;
        Ok(())
    }

    pub async fn mark_room(
        &self,
        id: &str,
        version: Option<&str>,
        dirty: bool,
        now_ms: i64,
        committed: bool,
    ) -> anyhow::Result<()> {
        redis::Script::new(MARK_ROOM)
            .key(room_key(id))
            .arg(version.unwrap_or(""))
            .arg(if version.is_some() { "1" } else { "0" })
            .arg(i32::from(dirty))
            .arg(now_ms)
            .arg(if committed { "1" } else { "0" })
            .invoke_async::<i64>(&mut self.c())
            .await
            .context("marking the room")?;
        Ok(())
    }

    /// Snapshot (the last periodic sync) plus the stream entries after it.
    pub async fn load_wal(&self, room: &str) -> anyhow::Result<Wal> {
        let (seq, state): (Option<i64>, Option<Vec<u8>>) = redis::cmd("HMGET")
            .arg(snap_key(room))
            .arg("seq")
            .arg("state")
            .query_async(&mut self.c())
            .await
            .context("reading the room snapshot")?;
        let snapshot = seq.zip(state);
        let after = snapshot.as_ref().map_or(0, |s| s.0);
        let updates = self.wal.read_after(room, after).await?;
        Ok(Wal { snapshot, updates })
    }

    pub async fn compact(
        &self,
        room: &str,
        epoch: i64,
        seq: i64,
        state: &[u8],
        now_ms: i64,
    ) -> anyhow::Result<()> {
        redis::Script::new(COMPACT)
            .key(epoch_key(room))
            .key(snap_key(room))
            .key(stream_key(room))
            .arg(epoch)
            .arg(seq)
            .arg(state)
            .arg(now_ms)
            .invoke_async::<i64>(&mut self.c())
            .await
            .map_err(|e| fenced_or(room, e, "writing the room snapshot"))?;
        Ok(())
    }

    /// Ephemeral storage (ADR-043): every key of the room (state, WAL, room row, every outbox
    /// row, sessions, assets, epoch); with `epoch`, only while it is the room's latest.
    pub async fn destroy_room(&self, room: &str, epoch: Option<i64>) -> anyhow::Result<()> {
        redis::Script::new(DESTROY)
            .key(epoch_key(room))
            .key(snap_key(room))
            .key(stream_key(room))
            .key(room_key(room))
            .key(ob_room_key(room))
            .key(ROOMS)
            .key(room_sess_key(room))
            .key(asset_key(room))
            .key(asset_meta_key(room))
            .key(ASSET_ROOMS)
            .key(OB_PENDING)
            .arg(room)
            .arg(epoch.map(|e| e.to_string()).unwrap_or_default())
            .invoke_async::<i64>(&mut self.c())
            .await
            .map_err(|e| fenced_or(room, e, "destroying the room"))?;
        Ok(())
    }

    /// How many of the room's keys exist (tests).
    pub async fn room_keys(&self, room: &str) -> anyhow::Result<i64> {
        Ok(redis::cmd("EXISTS")
            .arg(epoch_key(room))
            .arg(snap_key(room))
            .arg(stream_key(room))
            .arg(room_key(room))
            .arg(ob_room_key(room))
            .arg(room_sess_key(room))
            .arg(asset_key(room))
            .arg(asset_meta_key(room))
            .query_async(&mut self.c())
            .await?)
    }

    /// Drops a room's state; with `epoch`, only while it is the room's latest ([`Fenced`]).
    pub async fn purge_room(&self, room: &str, epoch: Option<i64>) -> anyhow::Result<()> {
        redis::Script::new(PURGE)
            .key(epoch_key(room))
            .key(snap_key(room))
            .key(stream_key(room))
            .key(room_key(room))
            .key(ob_room_key(room))
            .key(ROOMS)
            .arg(room)
            .arg(epoch.map(|e| e.to_string()).unwrap_or_default())
            .invoke_async::<i64>(&mut self.c())
            .await
            .map_err(|e| fenced_or(room, e, "purging the room"))?;
        Ok(())
    }

    // ---------- WOPI assets ----------

    pub async fn asset_put(
        &self,
        room: &str,
        asset: &oc_model::ocanvas::Asset,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        let meta = serde_json::json!({
            "mime": asset.mime,
            "size": asset.data.len(),
            "at": now_ms,
        })
        .to_string();
        redis::pipe()
            .atomic()
            .hset(asset_key(room), &asset.id, asset.data.as_slice())
            .ignore()
            .hset(asset_meta_key(room), &asset.id, meta)
            .ignore()
            .sadd(ASSET_ROOMS, room)
            .ignore()
            .query_async::<()>(&mut self.c())
            .await
            .context("storing the asset")?;
        Ok(())
    }

    async fn asset_meta(&self, room: &str) -> anyhow::Result<Vec<(String, serde_json::Value)>> {
        let m: HashMap<String, String> = redis::cmd("HGETALL")
            .arg(asset_meta_key(room))
            .query_async(&mut self.c())
            .await?;
        let mut out: Vec<(String, serde_json::Value)> = m
            .into_iter()
            .map(|(k, v)| (k, serde_json::from_str(&v).unwrap_or_default()))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }

    pub async fn asset_get(
        &self,
        room: &str,
        id: &str,
    ) -> anyhow::Result<Option<oc_model::ocanvas::Asset>> {
        let (data, meta): (Option<Vec<u8>>, Option<String>) = redis::pipe()
            .hget(asset_key(room), id)
            .hget(asset_meta_key(room), id)
            .query_async(&mut self.c())
            .await?;
        let (Some(data), Some(meta)) = (data, meta) else {
            return Ok(None);
        };
        let meta: serde_json::Value = serde_json::from_str(&meta)?;
        Ok(Some(oc_model::ocanvas::Asset {
            id: id.to_string(),
            mime: meta["mime"].as_str().unwrap_or_default().to_string(),
            data,
        }))
    }

    pub async fn room_assets(&self, room: &str) -> anyhow::Result<Vec<oc_model::ocanvas::Asset>> {
        let data: HashMap<String, Vec<u8>> = redis::cmd("HGETALL")
            .arg(asset_key(room))
            .query_async(&mut self.c())
            .await?;
        let mut data = data;
        Ok(self
            .asset_meta(room)
            .await?
            .into_iter()
            .filter_map(|(id, m)| {
                let bytes = data.remove(&id)?;
                Some(oc_model::ocanvas::Asset {
                    mime: m["mime"].as_str().unwrap_or_default().to_string(),
                    id,
                    data: bytes,
                })
            })
            .collect())
    }

    pub async fn room_assets_size(&self, room: &str) -> anyhow::Result<i64> {
        Ok(self
            .asset_meta(room)
            .await?
            .iter()
            .map(|(_, m)| m["size"].as_i64().unwrap_or(0))
            .sum())
    }

    /// Assets of rooms that are gone and have no pending commit, created before
    /// `older_than_ms`.
    pub async fn purge_orphan_assets(&self, older_than_ms: i64) -> anyhow::Result<u64> {
        let rooms: Vec<String> = redis::cmd("SMEMBERS")
            .arg(ASSET_ROOMS)
            .query_async(&mut self.c())
            .await?;
        if rooms.is_empty() {
            return Ok(0);
        }
        let pending = self.rooms_with_pending().await?;
        let mut n = 0;
        for room in rooms {
            let live: bool = redis::cmd("SISMEMBER")
                .arg(ROOMS)
                .arg(&room)
                .query_async(&mut self.c())
                .await?;
            if live || pending.contains(&room) {
                continue;
            }
            let meta = self.asset_meta(&room).await?;
            let old: Vec<&String> = meta
                .iter()
                .filter(|(_, m)| m["at"].as_i64().unwrap_or(0) < older_than_ms)
                .map(|(id, _)| id)
                .collect();
            if !old.is_empty() {
                redis::pipe()
                    .atomic()
                    .hdel(asset_key(&room), &old)
                    .ignore()
                    .hdel(asset_meta_key(&room), &old)
                    .ignore()
                    .query_async::<()>(&mut self.c())
                    .await?;
                n += old.len() as u64;
            }
            if old.len() == meta.len() {
                let _: i64 = redis::cmd("SREM")
                    .arg(ASSET_ROOMS)
                    .arg(&room)
                    .query_async(&mut self.c())
                    .await?;
            }
        }
        Ok(n)
    }
}
