// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Transient state in SQLite or MySQL/MariaDB through the sqlx `Any` driver (docs/04 §5), or,
//! in a cluster without `DATABASE_URL`, in Redis only ([`crate::redis_store`], ADR-030): every
//! public method dispatches there first, so the SQL paths below are unchanged.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use sqlx::any::{AnyPoolOptions, install_default_drivers};
use sqlx::migrate::Migrator;
use sqlx::{AnyPool, Executor, Row};
use tokio::sync::{mpsc, oneshot};

use crate::crypto::{self, Kek};
use crate::grant::{Grant, Role};

mod webhooks;
pub use webhooks::{WebhookRow, WebhookState};

static SQLITE: Migrator = sqlx::migrate!("../../migrations/sqlite");
static MYSQL: Migrator = sqlx::migrate!("../../migrations/mysql");

#[derive(Clone)]
pub struct Store {
    pool: AnyPool,
    kek: Option<Kek>,
    /// SQLite: the single WAL writer task that commits the batches of many rooms in one
    /// transaction (group commit, docs/22 §9.3). `None` on MySQL/MariaDB, where each room
    /// commits its own batch.
    group: Option<mpsc::UnboundedSender<GroupJob>>,
    /// The hot WAL in Redis (`OC_WAL_REDIS_URL`, or `REDIS_URL`): appends go there, and the
    /// database gets snapshots (ADR-021). `None`: the WAL is the `room_updates` table.
    redis: Option<crate::redis_wal::RedisWal>,
    /// SQLite: one write transaction at a time, taken in order here instead of on SQLite's
    /// busy handler (which sleeps and retries; docs/22 §9.2). `None` on MySQL/MariaDB.
    write_lock: Option<Arc<tokio::sync::Mutex<()>>>,
    /// Snapshot writes and room purges (range deletes on `room_updates`) take this exclusively,
    /// WAL batches shared: on InnoDB their gap locks deadlocked (1213) with each other and with
    /// concurrent inserts (docs/22 §10.1), so they never overlap in this process.
    snapshot_gate: Arc<tokio::sync::RwLock<()>>,
    /// Redis-only storage (ADR-030): every method dispatches here, and `pool` is never used.
    kv: Option<crate::redis_store::RedisStore>,
}

/// What [`Store::idem_begin`] found for an `Idempotency-Key` (docs/27 §4.2, HAPI-03).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdemBegin {
    /// The key was free: this request runs and must finish or release it.
    Started,
    /// The same request already finished: its stored answer.
    Replay { status: u16, response: String },
    /// The same request is still running (on any node).
    InProgress,
    /// The key was used with a different request.
    Mismatch,
}

/// One Yjs update for the WAL, at its own `seq`.
#[derive(Debug, Clone)]
pub struct WalRow {
    pub seq: i64,
    pub data: Vec<u8>,
    pub origin: String,
    pub at: i64,
}

/// One room's batch waiting for the SQLite group writer.
struct GroupJob {
    room: String,
    epoch: i64,
    rows: Vec<WalRow>,
    reply: oneshot::Sender<anyhow::Result<()>>,
}

/// Rows per multi-row `INSERT` (5 parameters each: well under SQLite's 32,766 and MySQL's
/// 65,535 placeholders).
const WAL_ROWS_PER_INSERT: usize = 500;
/// The group writer stops collecting more rooms once a transaction holds this many rows.
const GROUP_MAX_ROWS: usize = 4_096;

/// A commit waiting in (or done with) `commit_outbox`; `token` is decrypted.
#[derive(Debug, Clone)]
pub struct OutboxRow {
    pub id: String,
    pub room_id: String,
    pub host_id: String,
    pub file_id: String,
    pub seq: i64,
    pub base_version: Option<String>,
    pub token: String,
    pub payload: Vec<u8>,
    pub authors: Vec<String>,
    pub attempts: i64,
    pub status: String,
}

/// A host notification waiting in `notify_outbox`; `token` is decrypted.
#[derive(Debug, Clone)]
pub struct NotifyRow {
    pub id: String,
    pub room_id: String,
    pub host_id: String,
    pub file_id: String,
    /// `mention`.
    pub kind: String,
    pub token: String,
    /// The JSON body sent to the host.
    pub payload: String,
    pub attempts: i64,
    pub next_try_at: i64,
}

/// A write refused because another writer took the room since (docs/22 §8 weakness 3): the
/// writer's epoch is no longer the room's latest. The writer must stop at once.
#[derive(Debug, thiserror::Error)]
#[error("room {0}: a newer owner holds the room (stale epoch); write refused")]
pub struct Fenced(pub String);

/// True when `e` is a [`Fenced`] refusal.
pub fn is_fenced(e: &anyhow::Error) -> bool {
    e.is::<Fenced>()
}

/// MariaDB/MySQL deadlock (1213, SQLSTATE 40001) or lock wait timeout (1205), or SQLite busy:
/// the transaction was rolled back and may simply be run again.
pub fn is_transient(e: &anyhow::Error) -> bool {
    let Some(sqlx::Error::Database(d)) = e.downcast_ref::<sqlx::Error>() else {
        return false;
    };
    if let Some(m) = d.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>() {
        return matches!(m.number(), 1213 | 1205);
    }
    transient_message(d.code().as_deref(), d.message())
}

fn transient_message(code: Option<&str>, message: &str) -> bool {
    code == Some("40001")
        || message.contains("Deadlock found")
        || message.contains("Lock wait timeout")
        || message.contains("database is locked")
}

/// Attempts made by [`retry_transient`].
pub const RETRY_ATTEMPTS: u32 = 3;

/// Runs `op` up to [`RETRY_ATTEMPTS`] times while it fails with an error `transient` accepts,
/// sleeping a jittered, growing delay (25-50 ms, then 50-100 ms) in between. Other errors,
/// and the last transient one, are returned as they are.
pub async fn retry_with<T, F, Fut>(
    what: &str,
    transient: impl Fn(&anyhow::Error) -> bool,
    mut op: F,
) -> anyhow::Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
{
    let mut attempt = 1;
    loop {
        match op().await {
            Err(e) if attempt < RETRY_ATTEMPTS && transient(&e) => {
                let base = 25u64 << (attempt - 1);
                let delay = base + jitter(base);
                tracing::warn!(op = what, attempt, delay_ms = delay, error = %e, "transient database error; retrying");
                tokio::time::sleep(Duration::from_millis(delay)).await;
                attempt += 1;
            }
            other => return other,
        }
    }
}

/// 0..=max, from the clock's nanoseconds (spreads retries of transactions that deadlocked
/// with each other; no RNG dependency needed).
fn jitter(max: u64) -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::from(d.subsec_nanos()));
    nanos.wrapping_mul(0x9E37_79B9_7F4A_7C15) % (max + 1)
}

pub(crate) async fn retry_transient<T, F, Fut>(what: &str, op: F) -> anyhow::Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
{
    retry_with(what, is_transient, op).await
}

pub struct RoomRow {
    pub host_version: Option<String>,
    pub dirty: bool,
}

pub struct Wal {
    pub snapshot: Option<(i64, Vec<u8>)>,
    pub updates: Vec<(i64, Vec<u8>)>,
}

impl Wal {
    pub fn is_empty(&self) -> bool {
        self.snapshot.is_none() && self.updates.is_empty()
    }
    pub fn last_seq(&self) -> i64 {
        let snap = self.snapshot.as_ref().map_or(0, |s| s.0);
        self.updates.last().map_or(snap, |u| u.0.max(snap))
    }
}

fn ensure_sqlite_dir(url: &str) {
    let path = url
        .trim_start_matches("sqlite://")
        .trim_start_matches("sqlite:");
    let path = path.split('?').next().unwrap_or_default();
    if path.is_empty() || path.starts_with(":memory:") {
        return;
    }
    if let Some(dir) = std::path::Path::new(path)
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
    {
        let _ = std::fs::create_dir_all(dir);
    }
}

impl Store {
    pub async fn connect(url: &str, kek: Option<Kek>) -> anyhow::Result<Self> {
        install_default_drivers();
        let sqlite = url.starts_with("sqlite:");
        let mut opts = AnyPoolOptions::new()
            .max_connections(if sqlite { 8 } else { 16 })
            .acquire_timeout(Duration::from_secs(10));
        if sqlite {
            ensure_sqlite_dir(url);
            opts = opts.after_connect(|conn, _| {
                Box::pin(async move {
                    conn.execute("PRAGMA journal_mode=WAL").await?;
                    conn.execute("PRAGMA busy_timeout=5000").await?;
                    conn.execute("PRAGMA synchronous=NORMAL").await?;
                    Ok(())
                })
            });
        }
        let pool = opts.connect(url).await.context("connecting to database")?;
        // Nodes that start together on an empty database race on the migrations: the loser
        // fails on the migration row the winner wrote (before running its SQL), or sees the
        // winner's migration still marked unfinished. It waits and runs them again; by then
        // they are applied (SEC-47). A database left dirty for good still fails, after ~30 s.
        let mut attempt = 0;
        loop {
            let run = if sqlite {
                SQLITE.run(&pool).await
            } else {
                MYSQL.run(&pool).await
            };
            match run {
                Ok(()) => break,
                Err(e) if attempt < 60 => {
                    attempt += 1;
                    tracing::info!(error = %e, attempt, "migrations raced another node; retrying");
                    tokio::time::sleep(Duration::from_millis(250 + 250 * attempt.min(2))).await;
                }
                Err(e) => return Err(e).context("running migrations"),
            }
        }
        let write_lock = sqlite.then(|| Arc::new(tokio::sync::Mutex::new(())));
        let group = (sqlite && group_commit_enabled()).then(|| {
            let (tx, rx) = mpsc::unbounded_channel();
            tokio::spawn(group_writer(
                pool.clone(),
                rx,
                group_window(),
                write_lock.clone(),
            ));
            tx
        });
        Ok(Self {
            pool,
            kek,
            group,
            redis: None,
            write_lock,
            snapshot_gate: Arc::new(tokio::sync::RwLock::new(())),
            kv: None,
        })
    }

    /// Redis-only storage (ADR-030): snapshots, WAL, epochs, outboxes, sessions, used launch
    /// tokens and assets all live in the Redis at `url`. No database is opened.
    pub async fn connect_redis(url: &str, kek: Option<Kek>) -> anyhow::Result<Self> {
        install_default_drivers();
        let kv = crate::redis_store::RedisStore::connect(url).await?;
        // Never connected: every method returns from `kv` before it could touch the pool, and
        // this URL would fail loudly (no such file, read-only) if one ever did.
        let pool = AnyPoolOptions::new()
            .max_connections(1)
            .connect_lazy("sqlite:///nonexistent/opencanvas-redis-only-has-no-database?mode=ro")
            .context("placeholder pool")?;
        Ok(Self {
            pool,
            kek,
            group: None,
            redis: Some(kv.wal().clone()),
            write_lock: None,
            snapshot_gate: Arc::new(tokio::sync::RwLock::new(())),
            kv: Some(kv),
        })
    }

    /// True with Redis-only storage (no database).
    pub fn is_redis_only(&self) -> bool {
        self.kv.is_some()
    }

    /// Moves the hot WAL to Redis (ADR-021): appends, epoch mirror, replay and trim.
    pub async fn with_redis_wal(mut self, url: &str) -> anyhow::Result<Self> {
        self.redis = Some(crate::redis_wal::RedisWal::connect(url).await?);
        Ok(self)
    }

    /// The Redis WAL, when the hot WAL lives there.
    pub fn redis_wal(&self) -> Option<&crate::redis_wal::RedisWal> {
        self.redis.as_ref()
    }

    /// Waits for this process's turn to write (SQLite only; a no-op on MySQL/MariaDB).
    async fn write_turn(&self) -> Option<tokio::sync::OwnedMutexGuard<()>> {
        match &self.write_lock {
            Some(l) => Some(l.clone().lock_owned().await),
            None => None,
        }
    }

    pub async fn ping(&self) -> bool {
        if let Some(kv) = &self.kv {
            return kv.ping().await;
        }
        sqlx::query("SELECT 1").execute(&self.pool).await.is_ok()
    }

    /// Adds `tokens` to a host's AI usage for `month` (`YYYY-MM`, UTC); returns the new total
    /// across every node (docs/24 §9.1 T8).
    pub async fn ai_usage_add(&self, host: &str, month: &str, tokens: u64) -> anyhow::Result<u64> {
        if let Some(kv) = &self.kv {
            return kv.ai_usage_add(host, month, tokens).await;
        }
        let n = i64::try_from(tokens).unwrap_or(i64::MAX);
        // Portable upsert: update, else insert; a racing insert falls back to the update.
        for _ in 0..3 {
            let up = sqlx::query(
                "UPDATE ai_usage SET tokens = tokens + ? WHERE host_id = ? AND month = ?",
            )
            .bind(n)
            .bind(host)
            .bind(month)
            .execute(&self.pool)
            .await?;
            if up.rows_affected() == 0 {
                let ins =
                    sqlx::query("INSERT INTO ai_usage (host_id, month, tokens) VALUES (?, ?, ?)")
                        .bind(host)
                        .bind(month)
                        .bind(n)
                        .execute(&self.pool)
                        .await;
                match ins {
                    Ok(_) => {}
                    Err(e)
                        if e.as_database_error()
                            .is_some_and(|d| d.is_unique_violation()) =>
                    {
                        continue;
                    }
                    Err(e) => return Err(e.into()),
                }
            }
            let row = sqlx::query("SELECT tokens FROM ai_usage WHERE host_id = ? AND month = ?")
                .bind(host)
                .bind(month)
                .fetch_one(&self.pool)
                .await?;
            return Ok(row.try_get::<i64, _>(0)?.max(0) as u64);
        }
        anyhow::bail!("ai_usage upsert kept racing")
    }

    /// Every host's AI usage for `month` (loaded at start-up).
    pub async fn ai_usage_month(
        &self,
        month: &str,
    ) -> anyhow::Result<std::collections::HashMap<String, u64>> {
        if let Some(kv) = &self.kv {
            return kv.ai_usage_month(month).await;
        }
        let rows = sqlx::query("SELECT host_id, tokens FROM ai_usage WHERE month = ?")
            .bind(month)
            .fetch_all(&self.pool)
            .await?;
        rows.iter()
            .map(|r| {
                Ok((
                    r.try_get::<String, _>(0)?,
                    r.try_get::<i64, _>(1)?.max(0) as u64,
                ))
            })
            .collect()
    }

    /// The offline generation of a person on a host (OFF-01, ADR-063): 0 until the first
    /// revoke. One metadata row per host and user, no content.
    pub async fn offline_gen(&self, host: &str, user: &str) -> anyhow::Result<u64> {
        if let Some(kv) = &self.kv {
            return kv.offline_gen(host, user).await;
        }
        let row =
            sqlx::query("SELECT gen FROM offline_generation WHERE host_id = ? AND user_id = ?")
                .bind(host)
                .bind(user)
                .fetch_optional(&self.pool)
                .await?;
        Ok(match row {
            Some(r) => r.try_get::<i64, _>(0)?.max(0) as u64,
            None => 0,
        })
    }

    /// Raises a person's offline generation by one (`POST /api/v1/offline/revoke`); returns
    /// the new number. Devices holding grants with a lower one delete their copies.
    pub async fn offline_revoke(&self, host: &str, user: &str) -> anyhow::Result<u64> {
        if let Some(kv) = &self.kv {
            return kv.offline_revoke(host, user).await;
        }
        let now = crate::util::now_secs();
        for _ in 0..3 {
            let up = sqlx::query(
                "UPDATE offline_generation SET gen = gen + 1, updated_at = ? \
                 WHERE host_id = ? AND user_id = ?",
            )
            .bind(now)
            .bind(host)
            .bind(user)
            .execute(&self.pool)
            .await?;
            if up.rows_affected() == 0 {
                let ins = sqlx::query(
                    "INSERT INTO offline_generation (host_id, user_id, gen, updated_at) \
                     VALUES (?, ?, 1, ?)",
                )
                .bind(host)
                .bind(user)
                .bind(now)
                .execute(&self.pool)
                .await;
                match ins {
                    Ok(_) => {}
                    Err(e)
                        if e.as_database_error()
                            .is_some_and(|d| d.is_unique_violation()) =>
                    {
                        continue;
                    }
                    Err(e) => return Err(e.into()),
                }
            }
            return self.offline_gen(host, user).await;
        }
        anyhow::bail!("offline_generation upsert kept racing")
    }

    /// Records a launch `jti`; returns false if it was already used.
    pub async fn use_jti(&self, host: &str, jti: &str, expires_at: i64) -> anyhow::Result<bool> {
        if let Some(kv) = &self.kv {
            return kv
                .use_jti(host, jti, expires_at, crate::util::now_secs())
                .await;
        }
        let res = sqlx::query("INSERT INTO launch_jti (host_id, jti, expires_at) VALUES (?, ?, ?)")
            .bind(host)
            .bind(jti)
            .bind(expires_at)
            .execute(&self.pool)
            .await;
        match res {
            Ok(_) => Ok(true),
            Err(e)
                if e.as_database_error()
                    .is_some_and(|d| d.is_unique_violation()) =>
            {
                Ok(false)
            }
            Err(e) => Err(e.into()),
        }
    }

    pub async fn insert_session(
        &self,
        ticket: &str,
        grant: &Grant,
        expires_at: i64,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        if let Some(kv) = &self.kv {
            let sealed = self.seal_grant(ticket, grant)?;
            return kv
                .insert_session(ticket, grant, &sealed, expires_at, now_ms)
                .await;
        }
        sqlx::query(
            "INSERT INTO sessions (id, room_id, host_id, file_id, user_id, role, grant_json, expires_at, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(ticket)
        .bind(&grant.room)
        .bind(&grant.host_id)
        .bind(&grant.file.id)
        .bind(&grant.user.id)
        .bind(grant.role.as_str())
        .bind(self.seal_grant(ticket, grant)?)
        .bind(expires_at)
        .bind(now_ms)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Returns the grant and its expiry (unix seconds) when the ticket exists.
    pub async fn session(&self, ticket: &str) -> anyhow::Result<Option<(Grant, i64)>> {
        if let Some(kv) = &self.kv {
            return match kv.session(ticket).await? {
                Some((json, exp)) => Ok(Some((self.open_grant(ticket, &json)?, exp))),
                None => Ok(None),
            };
        }
        let row = sqlx::query("SELECT grant_json, expires_at FROM sessions WHERE id = ?")
            .bind(ticket)
            .fetch_optional(&self.pool)
            .await?;
        let Some(row) = row else { return Ok(None) };
        let grant = self.open_grant(ticket, &row.try_get::<String, _>(0)?)?;
        Ok(Some((grant, row.try_get::<i64, _>(1)?)))
    }

    /// `grant_json` with the host callback token sealed under `OC_KEK` (bound to the ticket).
    fn seal_grant(&self, ticket: &str, grant: &Grant) -> anyhow::Result<String> {
        let mut g = grant.clone();
        g.callback_token = crypto::seal(self.kek.as_ref(), &grant.callback_token, ticket);
        Ok(serde_json::to_string(&g)?)
    }

    fn open_grant(&self, ticket: &str, json: &str) -> anyhow::Result<Grant> {
        let mut g: Grant = serde_json::from_str(json)?;
        g.callback_token = crypto::open(self.kek.as_ref(), &g.callback_token, ticket)?;
        Ok(g)
    }

    /// Raw `grant_json` as stored (tests check that secrets are sealed).
    #[doc(hidden)]
    pub async fn raw_grant_json(&self, ticket: &str) -> anyhow::Result<Option<String>> {
        if let Some(kv) = &self.kv {
            return Ok(kv.session(ticket).await?.map(|s| s.0));
        }
        let row = sqlx::query("SELECT grant_json FROM sessions WHERE id = ?")
            .bind(ticket)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.try_get::<String, _>(0)).transpose()?)
    }

    /// Raw `token` column of a room's newest outbox row (tests check that it is sealed).
    #[doc(hidden)]
    pub async fn raw_outbox_token(&self, room: &str) -> anyhow::Result<String> {
        if let Some(kv) = &self.kv {
            return kv
                .outbox_rows(room)
                .await?
                .pop()
                .map(|r| r.token)
                .context("no outbox row");
        }
        let row = sqlx::query(
            "SELECT token FROM commit_outbox WHERE room_id = ? ORDER BY created_at DESC, id DESC",
        )
        .bind(room)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.try_get::<String, _>(0)?)
    }

    /// Changes (or with `None` revokes) the role of every session of `user` in `room`.
    /// Returns how many sessions were touched.
    pub async fn set_session_role(
        &self,
        room: &str,
        user: &str,
        role: Option<Role>,
    ) -> anyhow::Result<u64> {
        if let Some(kv) = &self.kv {
            let mine: Vec<(String, String)> = kv
                .room_sessions(room)
                .await?
                .into_iter()
                .filter(|(_, u, _)| u == user)
                .map(|(t, _, g)| (t, g))
                .collect();
            let Some(role) = role else {
                let tickets: Vec<String> = mine.into_iter().map(|(t, _)| t).collect();
                return kv.delete_sessions(room, &tickets).await;
            };
            let mut n = 0;
            for (id, json) in mine {
                let mut grant = self.open_grant(&id, &json)?;
                grant.set_role(role);
                if kv
                    .update_session(&id, role.as_str(), &self.seal_grant(&id, &grant)?)
                    .await?
                {
                    n += 1;
                }
            }
            return Ok(n);
        }
        let Some(role) = role else {
            let res = sqlx::query("DELETE FROM sessions WHERE room_id = ? AND user_id = ?")
                .bind(room)
                .bind(user)
                .execute(&self.pool)
                .await?;
            return Ok(res.rows_affected());
        };
        let rows =
            sqlx::query("SELECT id, grant_json FROM sessions WHERE room_id = ? AND user_id = ?")
                .bind(room)
                .bind(user)
                .fetch_all(&self.pool)
                .await?;
        let mut n = 0;
        for row in rows {
            let id: String = row.try_get(0)?;
            let mut grant = self.open_grant(&id, &row.try_get::<String, _>(1)?)?;
            grant.set_role(role);
            sqlx::query("UPDATE sessions SET role = ?, grant_json = ? WHERE id = ?")
                .bind(role.as_str())
                .bind(self.seal_grant(&id, &grant)?)
                .bind(&id)
                .execute(&self.pool)
                .await?;
            n += 1;
        }
        Ok(n)
    }

    /// Drops every session of a room (the host closed it: file deleted or moved).
    pub async fn delete_room_sessions(&self, room: &str) -> anyhow::Result<u64> {
        if let Some(kv) = &self.kv {
            let tickets: Vec<String> = kv
                .room_sessions(room)
                .await?
                .into_iter()
                .map(|(t, _, _)| t)
                .collect();
            return kv.delete_sessions(room, &tickets).await;
        }
        let res = sqlx::query("DELETE FROM sessions WHERE room_id = ?")
            .bind(room)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected())
    }

    // ---------- commit outbox (durable saves) ----------

    /// Records a commit as `pending` before it is sent; older pending rows of the room are
    /// superseded (the new payload contains everything they had).
    ///
    /// Refused with [`Fenced`] when `epoch` is no longer the room's latest; deadlocks are
    /// retried ([`retry_transient`]); any other failure is returned, never skipped.
    pub async fn outbox_insert(
        &self,
        row: &OutboxRow,
        epoch: i64,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        if let Some(kv) = &self.kv {
            let mut sealed = row.clone();
            sealed.token = crypto::seal(self.kek.as_ref(), &row.token, &row.id);
            return kv.outbox_insert(&sealed, epoch, now_ms).await;
        }
        retry_transient("outbox write", move || {
            self.outbox_insert_once(row, epoch, now_ms)
        })
        .await
    }

    async fn outbox_insert_once(
        &self,
        row: &OutboxRow,
        epoch: i64,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        let _w = self.write_turn().await;
        let mut tx = self.pool.begin().await?;
        hold_epoch(&mut tx, &row.room_id, epoch).await?;
        sqlx::query(
            "UPDATE commit_outbox SET status = 'superseded', payload = ? WHERE room_id = ? AND status = 'pending'",
        )
        .bind(Vec::<u8>::new())
        .bind(&row.room_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO commit_outbox (id, room_id, host_id, file_id, seq, base_version, token, payload, authors, attempts, next_try_at, status, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?)",
        )
        .bind(&row.id)
        .bind(&row.room_id)
        .bind(&row.host_id)
        .bind(&row.file_id)
        .bind(row.seq)
        .bind(row.base_version.as_deref())
        .bind(crypto::seal(self.kek.as_ref(), &row.token, &row.id))
        .bind(row.payload.clone())
        .bind(serde_json::to_string(&row.authors)?)
        .bind(now_ms)
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    fn outbox_row(&self, r: &sqlx::any::AnyRow) -> anyhow::Result<OutboxRow> {
        let id: String = r.try_get(0)?;
        let token = crypto::open(self.kek.as_ref(), &r.try_get::<String, _>(6)?, &id)?;
        let attempts = r
            .try_get::<i64, _>(9)
            .or_else(|_| r.try_get::<i32, _>(9).map(i64::from))?;
        Ok(OutboxRow {
            room_id: r.try_get(1)?,
            host_id: r.try_get(2)?,
            file_id: r.try_get(3)?,
            seq: r.try_get(4)?,
            base_version: r.try_get(5)?,
            token,
            payload: r.try_get(7)?,
            authors: serde_json::from_str(&r.try_get::<String, _>(8)?).unwrap_or_default(),
            attempts,
            status: r.try_get(10)?,
            id,
        })
    }

    /// All outbox rows of a room, oldest first.
    pub async fn outbox_rows(&self, room: &str) -> anyhow::Result<Vec<OutboxRow>> {
        if let Some(kv) = &self.kv {
            return kv
                .outbox_rows(room)
                .await?
                .into_iter()
                .map(|r| self.open_outbox(r))
                .collect();
        }
        retry_transient("room load", move || self.outbox_rows_once(room)).await
    }

    async fn outbox_rows_once(&self, room: &str) -> anyhow::Result<Vec<OutboxRow>> {
        let rows = sqlx::query(
            "SELECT id, room_id, host_id, file_id, seq, base_version, token, payload, authors, attempts, status \
             FROM commit_outbox WHERE room_id = ? ORDER BY created_at, id",
        )
        .bind(room)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(|r| self.outbox_row(r)).collect()
    }

    /// The newest pending commit of a room, if any.
    pub async fn outbox_pending(&self, room: &str) -> anyhow::Result<Option<OutboxRow>> {
        Ok(self
            .outbox_rows(room)
            .await?
            .into_iter()
            .rfind(|r| r.status == "pending"))
    }

    /// Number of commits waiting for the host, across the whole store (`/metrics`).
    pub async fn outbox_pending_count(&self) -> anyhow::Result<usize> {
        if let Some(kv) = &self.kv {
            return kv.outbox_pending_count().await;
        }
        let n: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM commit_outbox WHERE status = 'pending'")
                .fetch_one(&self.pool)
                .await?;
        Ok(usize::try_from(n).unwrap_or(0))
    }

    /// Every pending commit (startup sweeper), oldest first. Unreadable rows are skipped.
    pub async fn outbox_all_pending(&self) -> anyhow::Result<Vec<OutboxRow>> {
        if let Some(kv) = &self.kv {
            let mut out = Vec::new();
            for r in kv.outbox_all_pending().await? {
                match self.open_outbox(r) {
                    Ok(row) => out.push(row),
                    Err(e) => tracing::error!(error = %e, "unreadable outbox row skipped"),
                }
            }
            return Ok(out);
        }
        let rows = sqlx::query(
            "SELECT id, room_id, host_id, file_id, seq, base_version, token, payload, authors, attempts, status \
             FROM commit_outbox WHERE status = 'pending' ORDER BY created_at, id",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut out = Vec::new();
        for r in &rows {
            match self.outbox_row(r) {
                Ok(row) => out.push(row),
                Err(e) => tracing::error!(error = %e, "unreadable outbox row skipped"),
            }
        }
        Ok(out)
    }

    /// Final state of a commit: `done` (payload dropped), `conflict` or `superseded`.
    /// A row read sealed from Redis, with its token opened.
    fn open_outbox(&self, mut r: OutboxRow) -> anyhow::Result<OutboxRow> {
        r.token = crypto::open(self.kek.as_ref(), &r.token, &r.id)?;
        Ok(r)
    }

    pub async fn outbox_finish(&self, id: &str, status: &str) -> anyhow::Result<()> {
        if let Some(kv) = &self.kv {
            return kv.outbox_finish(id, status).await;
        }
        retry_transient("outbox mark done", move || {
            self.outbox_finish_once(id, status)
        })
        .await
    }

    async fn outbox_finish_once(&self, id: &str, status: &str) -> anyhow::Result<()> {
        let _w = self.write_turn().await;
        sqlx::query(
            "UPDATE commit_outbox SET status = ?, payload = ?, last_error = NULL WHERE id = ?",
        )
        .bind(status)
        .bind(Vec::<u8>::new())
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Cluster sweeper: claims a pending row for `node` until `until_ms`. False when another
    /// node holds an unexpired claim (or the row is no longer pending).
    pub async fn outbox_claim(
        &self,
        id: &str,
        node: &str,
        now_ms: i64,
        until_ms: i64,
    ) -> anyhow::Result<bool> {
        if let Some(kv) = &self.kv {
            return kv.outbox_claim(id, node, now_ms, until_ms).await;
        }
        let res = sqlx::query(
            "UPDATE commit_outbox SET claimed_by = ?, claim_until = ? WHERE id = ? AND status = 'pending' \
             AND (claim_until IS NULL OR claim_until < ? OR claimed_by = ?)",
        )
        .bind(node)
        .bind(until_ms)
        .bind(id)
        .bind(now_ms)
        .bind(node)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() == 1)
    }

    pub async fn outbox_failed(
        &self,
        id: &str,
        next_try_at: i64,
        error: &str,
    ) -> anyhow::Result<()> {
        if let Some(kv) = &self.kv {
            return kv.outbox_failed(id, next_try_at, error).await;
        }
        sqlx::query(
            "UPDATE commit_outbox SET attempts = attempts + 1, next_try_at = ?, last_error = ? WHERE id = ?",
        )
        .bind(next_try_at)
        .bind(error)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // ---------- notification outbox (host callbacks other than saves) ----------

    /// Queues a notification as `pending`, due at `next_try_at`. False when a row with this id
    /// already exists (the same message was queued before): nothing is sent twice.
    pub async fn notify_insert(&self, row: &NotifyRow, now_ms: i64) -> anyhow::Result<bool> {
        if let Some(kv) = &self.kv {
            let mut sealed = row.clone();
            sealed.token = crypto::seal(self.kek.as_ref(), &row.token, &row.id);
            return kv.notify_insert(&sealed, now_ms).await;
        }
        let res = sqlx::query(
            "INSERT INTO notify_outbox (id, room_id, host_id, file_id, kind, token, payload, attempts, next_try_at, status, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?)",
        )
        .bind(&row.id)
        .bind(&row.room_id)
        .bind(&row.host_id)
        .bind(&row.file_id)
        .bind(&row.kind)
        .bind(crypto::seal(self.kek.as_ref(), &row.token, &row.id))
        .bind(&row.payload)
        .bind(row.next_try_at)
        .bind(now_ms)
        .execute(&self.pool)
        .await;
        match res {
            Ok(_) => Ok(true),
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    /// Pending notifications due at `now_ms`, oldest first. Unreadable rows are skipped.
    pub async fn notify_due(&self, now_ms: i64, limit: i64) -> anyhow::Result<Vec<NotifyRow>> {
        if let Some(kv) = &self.kv {
            let mut out = Vec::new();
            for mut r in kv.notify_due(now_ms, limit).await? {
                match crypto::open(self.kek.as_ref(), &r.token, &r.id) {
                    Ok(t) => {
                        r.token = t;
                        out.push(r);
                    }
                    Err(e) => tracing::error!(error = %e, "unreadable notification row skipped"),
                }
            }
            return Ok(out);
        }
        let rows = sqlx::query(
            "SELECT id, room_id, host_id, file_id, kind, token, payload, attempts, next_try_at \
             FROM notify_outbox WHERE status = 'pending' AND next_try_at <= ? ORDER BY next_try_at, id LIMIT ?",
        )
        .bind(now_ms)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        let mut out = Vec::new();
        for r in &rows {
            let read = || -> anyhow::Result<NotifyRow> {
                let id: String = r.try_get(0)?;
                let token = crypto::open(self.kek.as_ref(), &r.try_get::<String, _>(5)?, &id)?;
                Ok(NotifyRow {
                    room_id: r.try_get(1)?,
                    host_id: r.try_get(2)?,
                    file_id: r.try_get(3)?,
                    kind: r.try_get(4)?,
                    token,
                    payload: r.try_get(6)?,
                    attempts: r
                        .try_get::<i64, _>(7)
                        .or_else(|_| r.try_get::<i32, _>(7).map(i64::from))?,
                    next_try_at: r.try_get(8)?,
                    id,
                })
            };
            match read() {
                Ok(row) => out.push(row),
                Err(e) => tracing::error!(error = %e, "unreadable notification row skipped"),
            }
        }
        Ok(out)
    }

    /// Takes a due row for one attempt by pushing its `next_try_at` from `seen` to `until`.
    /// False when another worker (or node) took it first.
    pub async fn notify_claim(&self, id: &str, seen: i64, until: i64) -> anyhow::Result<bool> {
        if let Some(kv) = &self.kv {
            return kv.notify_claim(id, seen, until).await;
        }
        let res = sqlx::query(
            "UPDATE notify_outbox SET next_try_at = ? WHERE id = ? AND status = 'pending' AND next_try_at = ?",
        )
        .bind(until)
        .bind(id)
        .bind(seen)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() == 1)
    }

    /// Final state: `done`, `unsupported` (the host has no such callback) or `failed`. The
    /// payload (it holds an excerpt of the canvas) is dropped.
    pub async fn notify_finish(&self, id: &str, status: &str) -> anyhow::Result<()> {
        if let Some(kv) = &self.kv {
            return kv.notify_finish(id, status).await;
        }
        sqlx::query("UPDATE notify_outbox SET status = ?, payload = '' WHERE id = ?")
            .bind(status)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// A failed attempt: try again at `next_try_at`.
    pub async fn notify_retry(&self, id: &str, next_try_at: i64) -> anyhow::Result<()> {
        if let Some(kv) = &self.kv {
            return kv.notify_retry(id, next_try_at).await;
        }
        sqlx::query(
            "UPDATE notify_outbox SET attempts = attempts + 1, next_try_at = ? WHERE id = ? AND status = 'pending'",
        )
        .bind(next_try_at)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Status of one notification row (tests).
    #[doc(hidden)]
    pub async fn notify_status(&self, id: &str) -> anyhow::Result<Option<(String, String)>> {
        if let Some(kv) = &self.kv {
            return kv.notify_status(id).await;
        }
        let row = sqlx::query("SELECT status, payload FROM notify_outbox WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(match row {
            Some(r) => Some((r.try_get(0)?, r.try_get(1)?)),
            None => None,
        })
    }

    /// Claims an idempotency key (`id` = hash of host, subject and key) for a request whose
    /// hash is `request_hash`, for `lease` seconds; or reports what holds it. Atomic across
    /// nodes: the primary key (SQL) or `SET NX` (Redis) decides. `now` in seconds.
    pub async fn idem_begin(
        &self,
        id: &str,
        host: &str,
        request_hash: &str,
        now: i64,
        lease: i64,
    ) -> anyhow::Result<IdemBegin> {
        if let Some(kv) = &self.kv {
            return kv.idem_begin(host, id, request_hash, lease).await;
        }
        for _ in 0..4 {
            let ins = sqlx::query(
                "INSERT INTO api_idempotency (id, host_id, request_hash, state, status, response, expires_at) \
                 VALUES (?, ?, ?, 'running', 0, '', ?)",
            )
            .bind(id)
            .bind(host)
            .bind(request_hash)
            .bind(now + lease)
            .execute(&self.pool)
            .await;
            match ins {
                Ok(_) => return Ok(IdemBegin::Started),
                Err(e)
                    if e.as_database_error()
                        .is_some_and(|d| d.is_unique_violation()) => {}
                Err(e) => return Err(e.into()),
            }
            let row = sqlx::query(
                "SELECT request_hash, state, status, response, expires_at FROM api_idempotency WHERE id = ?",
            )
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
            let Some(row) = row else { continue };
            let expires: i64 = row.try_get(4)?;
            if expires < now {
                // A finished answer past its 24 h, or a running claim whose node died.
                sqlx::query("DELETE FROM api_idempotency WHERE id = ? AND expires_at < ?")
                    .bind(id)
                    .bind(now)
                    .execute(&self.pool)
                    .await?;
                continue;
            }
            if row.try_get::<String, _>(0)? != request_hash {
                return Ok(IdemBegin::Mismatch);
            }
            if row.try_get::<String, _>(1)? != "done" {
                return Ok(IdemBegin::InProgress);
            }
            return Ok(IdemBegin::Replay {
                status: u16::try_from(row.try_get::<i64, _>(2)?).unwrap_or(200),
                response: row.try_get(3)?,
            });
        }
        anyhow::bail!("idempotency key claim kept racing")
    }

    /// Stores the answer of a request that [`Store::idem_begin`] started; it is replayed until
    /// `expires_at` (seconds). Never document content (ADR-001): callers store write answers.
    #[allow(clippy::too_many_arguments)]
    pub async fn idem_finish(
        &self,
        id: &str,
        host: &str,
        request_hash: &str,
        status: u16,
        response: &str,
        ttl: i64,
        now: i64,
    ) -> anyhow::Result<()> {
        if let Some(kv) = &self.kv {
            return kv
                .idem_finish(host, id, request_hash, status, response, ttl)
                .await;
        }
        sqlx::query(
            "UPDATE api_idempotency SET state = 'done', status = ?, response = ?, expires_at = ? \
             WHERE id = ? AND request_hash = ?",
        )
        .bind(i64::from(status))
        .bind(response)
        .bind(now + ttl)
        .bind(id)
        .bind(request_hash)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Frees a key whose request did not succeed, so a retry runs again.
    pub async fn idem_release(
        &self,
        id: &str,
        host: &str,
        request_hash: &str,
    ) -> anyhow::Result<()> {
        if let Some(kv) = &self.kv {
            return kv.idem_release(host, id, request_hash).await;
        }
        sqlx::query(
            "DELETE FROM api_idempotency WHERE id = ? AND request_hash = ? AND state = 'running'",
        )
        .bind(id)
        .bind(request_hash)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn purge_expired(&self, now: i64) -> anyhow::Result<()> {
        if self.kv.is_some() {
            // Sessions, used launch tokens, finished notifications and idle epochs expire
            // through their Redis TTLs.
            return Ok(());
        }
        // Finished notifications are kept a day (their id still deduplicates), payload-free.
        sqlx::query("DELETE FROM notify_outbox WHERE status <> 'pending' AND created_at < ?")
            .bind((now - 86_400) * 1000)
            .execute(&self.pool)
            .await?;
        // Epoch rows of rooms closed for a week (a fresh claim restarts at the clock).
        sqlx::query(
            "DELETE FROM room_epochs WHERE updated_at < ? AND room_id NOT IN (SELECT id FROM rooms)",
        )
        .bind((now - 7 * 86_400) * 1000)
        .execute(&self.pool)
        .await?;
        sqlx::query("DELETE FROM sessions WHERE expires_at < ?")
            .bind(now)
            .execute(&self.pool)
            .await?;
        sqlx::query("DELETE FROM launch_jti WHERE expires_at < ?")
            .bind(now)
            .execute(&self.pool)
            .await?;
        sqlx::query("DELETE FROM api_idempotency WHERE expires_at < ?")
            .bind(now)
            .execute(&self.pool)
            .await?;
        self.webhook_purge(now * 1000 - crate::webhooks::KEEP_MS)
            .await?;
        Ok(())
    }

    /// Takes the room's next fencing epoch (docs/22 §8 weakness 3). Called by a new room actor,
    /// with the lease held, before it reads the WAL: from then on, writes made with an older
    /// epoch are refused with [`Fenced`]. A room seen for the first time (or swept) starts at
    /// `now_ms`, so an epoch never goes back.
    pub async fn claim_epoch(&self, room: &str, now_ms: i64) -> anyhow::Result<i64> {
        if let Some(kv) = &self.kv {
            return kv.claim_epoch(room, now_ms).await;
        }
        let epoch =
            retry_transient("epoch claim", move || self.claim_epoch_once(room, now_ms)).await?;
        if let Some(r) = &self.redis {
            r.mirror_epoch(room, epoch).await?;
        }
        Ok(epoch)
    }

    async fn claim_epoch_once(&self, room: &str, now_ms: i64) -> anyhow::Result<i64> {
        let _w = self.write_turn().await;
        let mut tx = self.pool.begin().await?;
        let bumped = sqlx::query(
            "UPDATE room_epochs SET epoch = epoch + 1, updated_at = ? WHERE room_id = ?",
        )
        .bind(now_ms)
        .bind(room)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if bumped == 0 {
            sqlx::query(
                "INSERT INTO room_epochs (room_id, epoch, checks, updated_at) VALUES (?, ?, 0, ?)",
            )
            .bind(room)
            .bind(now_ms)
            .bind(now_ms)
            .execute(&mut *tx)
            .await?;
        }
        let epoch: i64 = sqlx::query("SELECT epoch FROM room_epochs WHERE room_id = ?")
            .bind(room)
            .fetch_one(&mut *tx)
            .await?
            .try_get(0)?;
        tx.commit().await?;
        Ok(epoch)
    }

    /// The room's latest epoch (tests and diagnostics).
    pub async fn room_epoch(&self, room: &str) -> anyhow::Result<Option<i64>> {
        if let Some(kv) = &self.kv {
            return kv.room_epoch(room).await;
        }
        let row = sqlx::query("SELECT epoch FROM room_epochs WHERE room_id = ?")
            .bind(room)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.try_get::<i64, _>(0)).transpose()?)
    }

    pub async fn room(&self, id: &str) -> anyhow::Result<Option<RoomRow>> {
        if let Some(kv) = &self.kv {
            return kv.room(id).await;
        }
        retry_transient("room load", move || self.room_once(id)).await
    }

    async fn room_once(&self, id: &str) -> anyhow::Result<Option<RoomRow>> {
        let row = sqlx::query("SELECT host_version, dirty FROM rooms WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(match row {
            Some(r) => Some(RoomRow {
                host_version: r.try_get::<Option<String>, _>(0)?,
                dirty: r.try_get::<i64, _>(1)? != 0,
            }),
            None => None,
        })
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
        if let Some(kv) = &self.kv {
            return kv.put_room(id, host, file, version, dirty, now_ms).await;
        }
        retry_transient("room load", move || {
            self.put_room_once(id, host, file, version, dirty, now_ms)
        })
        .await
    }

    async fn put_room_once(
        &self,
        id: &str,
        host: &str,
        file: &str,
        version: Option<&str>,
        dirty: bool,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        let _w = self.write_turn().await;
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM rooms WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO rooms (id, host_id, file_id, host_version, dirty, last_active_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(host)
        .bind(file)
        .bind(version)
        .bind(i32::from(dirty))
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
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
        if let Some(kv) = &self.kv {
            return kv.mark_room(id, version, dirty, now_ms, committed).await;
        }
        let _w = self.write_turn().await;
        sqlx::query(
            "UPDATE rooms SET host_version = ?, dirty = ?, last_active_at = ?, \
             last_commit_at = CASE WHEN ? = 1 THEN ? ELSE last_commit_at END WHERE id = ?",
        )
        .bind(version)
        .bind(i32::from(dirty))
        .bind(now_ms)
        .bind(i32::from(committed))
        .bind(now_ms)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Appends one update to the room's WAL (a batch of one). Refused with [`Fenced`] when
    /// `epoch` is no longer the room's latest.
    pub async fn append_update(
        &self,
        room: &str,
        epoch: i64,
        seq: i64,
        data: &[u8],
        origin: &str,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        let row = WalRow {
            seq,
            data: data.to_vec(),
            origin: origin.into(),
            at: now_ms,
        };
        self.append_updates(room, epoch, vec![row]).await
    }

    /// Appends a room's batch of updates (in `seq` order) to its WAL, all or nothing. The
    /// whole batch is refused with [`Fenced`] when `epoch` is no longer the room's latest.
    /// On SQLite the batch goes to the single group writer, which commits it together with
    /// other rooms' batches; on MySQL/MariaDB it is one guarded multi-row insert. Deadlocks
    /// and `busy` are retried.
    pub async fn append_updates(
        &self,
        room: &str,
        epoch: i64,
        rows: Vec<WalRow>,
    ) -> anyhow::Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        if let Some(r) = &self.redis {
            let started = std::time::Instant::now();
            let mut res = r.append(room, epoch, &rows).await;
            if res
                .as_ref()
                .is_err_and(|e| e.is::<crate::redis_wal::NoEpoch>())
            {
                res = self.append_without_epoch(r, room, epoch, &rows).await;
            }
            if started.elapsed() > Duration::from_millis(500) {
                tracing::warn!(
                    room,
                    rows = rows.len(),
                    ms = started.elapsed().as_millis() as u64,
                    "slow Redis WAL append"
                );
            }
            return res;
        }
        if let Some(group) = &self.group {
            let (reply, done) = oneshot::channel();
            let job = GroupJob {
                room: room.into(),
                epoch,
                rows,
                reply,
            };
            group
                .send(job)
                .map_err(|_| anyhow::anyhow!("WAL writer stopped"))?;
            return done
                .await
                .unwrap_or_else(|_| Err(anyhow::anyhow!("WAL writer stopped")));
        }
        let _g = self.snapshot_gate.read().await;
        let rows = rows.as_slice();
        retry_transient("WAL append", move || async move {
            if rows.len() <= WAL_ROWS_PER_INSERT {
                // One statement is atomic on its own: no transaction round trips.
                return insert_guarded(&self.pool, room, epoch, rows).await;
            }
            commit_batches(&self.pool, &[(room, epoch, rows)])
                .await?
                .pop()
                .unwrap_or(Ok(()))
        })
        .await
    }

    /// The Redis WAL had no epoch for the room: Redis lost its data (ADR-030). With a
    /// database, the epoch is restored from `room_epochs` (the authoritative one) and the batch
    /// tried again, so a wipe no longer fences every room of the cluster; a writer whose epoch
    /// is not the database's latest is still refused. Redis-only: there is nothing to restore
    /// from, the writer is fenced and its room rebuilds from the host's file and the clients.
    async fn append_without_epoch(
        &self,
        r: &crate::redis_wal::RedisWal,
        room: &str,
        epoch: i64,
        rows: &[WalRow],
    ) -> anyhow::Result<()> {
        let restored = match &self.kv {
            Some(_) => None,
            None => self.room_epoch(room).await?,
        };
        let Some(latest) = restored else {
            tracing::error!(
                room,
                epoch,
                "no fencing epoch in Redis and none to restore it from: Redis lost its data; the room rebuilds from the host's file and reconnecting clients"
            );
            return Err(Fenced(room.into()).into());
        };
        r.mirror_epoch(room, latest).await?;
        tracing::warn!(
            room,
            epoch = latest,
            "Redis had no fencing epoch for the room (Redis lost its data); restored from room_epochs"
        );
        match r.append(room, epoch, rows).await {
            Err(e) if e.is::<crate::redis_wal::NoEpoch>() => Err(Fenced(room.into()).into()),
            other => other,
        }
    }

    pub async fn load_wal(&self, room: &str) -> anyhow::Result<Wal> {
        if let Some(kv) = &self.kv {
            return kv.load_wal(room).await;
        }
        let mut wal = retry_transient("room load", move || self.load_wal_once(room)).await?;
        if let Some(r) = &self.redis {
            let after = wal.last_seq();
            wal.updates.extend(r.read_after(room, after).await?);
        }
        Ok(wal)
    }

    async fn load_wal_once(&self, room: &str) -> anyhow::Result<Wal> {
        let snapshot = sqlx::query("SELECT seq, state FROM room_snapshots WHERE room_id = ?")
            .bind(room)
            .fetch_optional(&self.pool)
            .await?
            .map(|r| Ok::<_, sqlx::Error>((r.try_get::<i64, _>(0)?, r.try_get::<Vec<u8>, _>(1)?)))
            .transpose()?;
        let after = snapshot.as_ref().map_or(0, |s| s.0);
        let rows = sqlx::query(
            "SELECT seq, data FROM room_updates WHERE room_id = ? AND seq > ? ORDER BY seq",
        )
        .bind(room)
        .bind(after)
        .fetch_all(&self.pool)
        .await?;
        let updates = rows
            .into_iter()
            .map(|r| Ok((r.try_get::<i64, _>(0)?, r.try_get::<Vec<u8>, _>(1)?)))
            .collect::<Result<_, sqlx::Error>>()?;
        Ok(Wal { snapshot, updates })
    }

    /// Replaces the snapshot and drops WAL entries it covers. Refused with [`Fenced`] when
    /// `epoch` is no longer the room's latest; deadlocks are retried.
    pub async fn compact(
        &self,
        room: &str,
        epoch: i64,
        seq: i64,
        state: &[u8],
        now_ms: i64,
    ) -> anyhow::Result<()> {
        if let Some(kv) = &self.kv {
            return kv.compact(room, epoch, seq, state, now_ms).await;
        }
        retry_transient("compaction", move || {
            self.compact_once(room, epoch, seq, state, now_ms)
        })
        .await?;
        // Only once the snapshot is in the database: the Redis entries it covers can go.
        if let Some(r) = &self.redis
            && let Err(e) = r.trim(room, seq).await
        {
            tracing::warn!(room, seq, error = %e, "trimming the Redis WAL failed; replay skips the covered entries");
        }
        Ok(())
    }

    async fn compact_once(
        &self,
        room: &str,
        epoch: i64,
        seq: i64,
        state: &[u8],
        now_ms: i64,
    ) -> anyhow::Result<()> {
        let _g = self.snapshot_gate.write().await;
        let _w = self.write_turn().await;
        let mut tx = self.pool.begin().await?;
        hold_epoch(&mut tx, room, epoch).await?;
        // A dump that finishes late never replaces a newer one (memory durability runs
        // dumps in the background, ADR-029).
        let newer: Option<i64> = sqlx::query("SELECT seq FROM room_snapshots WHERE room_id = ?")
            .bind(room)
            .fetch_optional(&mut *tx)
            .await?
            .map(|r| r.try_get::<i64, _>(0))
            .transpose()?;
        if newer.is_some_and(|s| s > seq) {
            tx.commit().await?;
            return Ok(());
        }
        sqlx::query("DELETE FROM room_snapshots WHERE room_id = ?")
            .bind(room)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO room_snapshots (room_id, seq, state, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(room)
        .bind(seq)
        .bind(state.to_vec())
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM room_updates WHERE room_id = ? AND seq <= ?")
            .bind(room)
            .bind(seq)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Stores (or replaces) a WOPI-mode asset of `room`.
    pub async fn asset_put(
        &self,
        room: &str,
        asset: &oc_model::ocanvas::Asset,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        if let Some(kv) = &self.kv {
            return kv.asset_put(room, asset, now_ms).await;
        }
        let _w = self.write_turn().await;
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM room_assets WHERE room_id = ? AND asset_id = ?")
            .bind(room)
            .bind(&asset.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO room_assets (room_id, asset_id, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(room)
        .bind(&asset.id)
        .bind(&asset.mime)
        .bind(asset.data.len() as i64)
        .bind(asset.data.clone())
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn asset_get(
        &self,
        room: &str,
        id: &str,
    ) -> anyhow::Result<Option<oc_model::ocanvas::Asset>> {
        if let Some(kv) = &self.kv {
            return kv.asset_get(room, id).await;
        }
        let row =
            sqlx::query("SELECT mime, data FROM room_assets WHERE room_id = ? AND asset_id = ?")
                .bind(room)
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(match row {
            Some(r) => Some(oc_model::ocanvas::Asset {
                id: id.to_string(),
                mime: r.try_get::<String, _>(0)?,
                data: r.try_get::<Vec<u8>, _>(1)?,
            }),
            None => None,
        })
    }

    pub async fn room_assets(&self, room: &str) -> anyhow::Result<Vec<oc_model::ocanvas::Asset>> {
        if let Some(kv) = &self.kv {
            return kv.room_assets(room).await;
        }
        let rows = sqlx::query(
            "SELECT asset_id, mime, data FROM room_assets WHERE room_id = ? ORDER BY asset_id",
        )
        .bind(room)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|r| {
                Ok(oc_model::ocanvas::Asset {
                    id: r.try_get::<String, _>(0)?,
                    mime: r.try_get::<String, _>(1)?,
                    data: r.try_get::<Vec<u8>, _>(2)?,
                })
            })
            .collect()
    }

    /// Total bytes of the assets of `room`.
    pub async fn room_assets_size(&self, room: &str) -> anyhow::Result<i64> {
        if let Some(kv) = &self.kv {
            return kv.room_assets_size(room).await;
        }
        // Summed here: SQL SUM is DECIMAL on MySQL/MariaDB, a type the sqlx Any driver cannot
        // decode at all (the query failed before any `try_get`). A room has few assets.
        let rows = sqlx::query("SELECT size FROM room_assets WHERE room_id = ?")
            .bind(room)
            .fetch_all(&self.pool)
            .await?;
        rows.iter()
            .try_fold(0i64, |n, r| Ok(n.saturating_add(r.try_get::<i64, _>(0)?)))
    }

    /// Deletes assets of rooms that are gone and have no pending commit, created before
    /// `older_than_ms` (so a room being opened right now keeps its freshly extracted assets).
    pub async fn purge_orphan_assets(&self, older_than_ms: i64) -> anyhow::Result<u64> {
        if let Some(kv) = &self.kv {
            return kv.purge_orphan_assets(older_than_ms).await;
        }
        let res = sqlx::query(
            "DELETE FROM room_assets WHERE created_at < ? \
             AND room_id NOT IN (SELECT id FROM rooms) \
             AND room_id NOT IN (SELECT room_id FROM commit_outbox WHERE status = 'pending')",
        )
        .bind(older_than_ms)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    /// The users that opened `room` (one entry per user id), from the session rows. In WOPI
    /// mode this is the mention directory: WOPI has no user lookup.
    pub async fn room_users(&self, room: &str) -> anyhow::Result<Vec<crate::grant::User>> {
        if let Some(kv) = &self.kv {
            let mut seen = std::collections::HashSet::new();
            let mut out = Vec::new();
            for (_, _, json) in kv.room_sessions(room).await? {
                let v: serde_json::Value = serde_json::from_str(&json)?;
                if let Ok(u) = serde_json::from_value::<crate::grant::User>(v["user"].clone())
                    && seen.insert(u.id.clone())
                {
                    out.push(u);
                }
            }
            return Ok(out);
        }
        let rows =
            sqlx::query("SELECT grant_json FROM sessions WHERE room_id = ? ORDER BY created_at")
                .bind(room)
                .fetch_all(&self.pool)
                .await?;
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for r in rows {
            // Only the `user` part is read; the sealed token is never opened here.
            let v: serde_json::Value = serde_json::from_str(&r.try_get::<String, _>(0)?)?;
            if let Ok(u) = serde_json::from_value::<crate::grant::User>(v["user"].clone())
                && seen.insert(u.id.clone())
            {
                out.push(u);
            }
        }
        Ok(out)
    }

    /// [`Self::purge_room`] by the room's actor when it closes: refused with [`Fenced`] when
    /// another writer took the room since (its WAL is not ours to drop).
    pub async fn purge_room_fenced(&self, room: &str, epoch: i64) -> anyhow::Result<()> {
        if let Some(kv) = &self.kv {
            return kv.purge_room(room, Some(epoch)).await;
        }
        retry_transient("room purge", move || async move {
            let _g = self.snapshot_gate.write().await;
            let _w = self.write_turn().await;
            let mut tx = self.pool.begin().await?;
            hold_epoch(&mut tx, room, epoch).await?;
            purge_in(&mut tx, room).await?;
            tx.commit().await?;
            Ok(())
        })
        .await?;
        if let Some(r) = &self.redis {
            r.purge(room, Some(epoch)).await?;
        }
        Ok(())
    }

    /// Ephemeral storage (ADR-043): deletes everything the server keeps for `room` (WAL,
    /// snapshot, room row, every outbox and notification row, sessions, assets, epoch).
    /// With `epoch`, refused with [`Fenced`] when another actor took the room since.
    pub async fn destroy_room(&self, room: &str, epoch: Option<i64>) -> anyhow::Result<()> {
        if let Some(kv) = &self.kv {
            return kv.destroy_room(room, epoch).await;
        }
        retry_transient("room destroy", move || async move {
            let _g = self.snapshot_gate.write().await;
            let _w = self.write_turn().await;
            let mut tx = self.pool.begin().await?;
            if let Some(e) = epoch {
                hold_epoch(&mut tx, room, e).await?;
            }
            purge_in(&mut tx, room).await?;
            for sql in [
                "DELETE FROM commit_outbox WHERE room_id = ?",
                "DELETE FROM notify_outbox WHERE room_id = ?",
                "DELETE FROM sessions WHERE room_id = ?",
                "DELETE FROM room_assets WHERE room_id = ?",
                "DELETE FROM room_epochs WHERE room_id = ?",
            ] {
                sqlx::query(sql).bind(room).execute(&mut *tx).await?;
            }
            tx.commit().await?;
            Ok(())
        })
        .await?;
        if let Some(r) = &self.redis {
            r.destroy(room).await?;
        }
        Ok(())
    }

    /// Rows and keys left for `room`, per table (tests: an ephemeral room leaves nothing).
    pub async fn room_footprint(&self, room: &str) -> anyhow::Result<Vec<(&'static str, i64)>> {
        let mut out = Vec::new();
        if let Some(kv) = &self.kv {
            out.push(("redis", kv.room_keys(room).await?));
            return Ok(out);
        }
        for (table, sql) in [
            (
                "room_updates",
                "SELECT COUNT(*) FROM room_updates WHERE room_id = ?",
            ),
            (
                "room_snapshots",
                "SELECT COUNT(*) FROM room_snapshots WHERE room_id = ?",
            ),
            ("rooms", "SELECT COUNT(*) FROM rooms WHERE id = ?"),
            (
                "commit_outbox",
                "SELECT COUNT(*) FROM commit_outbox WHERE room_id = ?",
            ),
            (
                "notify_outbox",
                "SELECT COUNT(*) FROM notify_outbox WHERE room_id = ?",
            ),
            (
                "sessions",
                "SELECT COUNT(*) FROM sessions WHERE room_id = ?",
            ),
            (
                "room_assets",
                "SELECT COUNT(*) FROM room_assets WHERE room_id = ?",
            ),
            (
                "room_epochs",
                "SELECT COUNT(*) FROM room_epochs WHERE room_id = ?",
            ),
        ] {
            let n: i64 = sqlx::query(sql)
                .bind(room)
                .fetch_one(&self.pool)
                .await?
                .try_get(0)?;
            out.push((table, n));
        }
        if let Some(r) = &self.redis {
            out.push(("redis", r.room_keys(room).await?));
        }
        Ok(out)
    }

    pub async fn purge_room(&self, room: &str) -> anyhow::Result<()> {
        if let Some(kv) = &self.kv {
            return kv.purge_room(room, None).await;
        }
        retry_transient("room purge", move || async move {
            let _g = self.snapshot_gate.write().await;
            let _w = self.write_turn().await;
            let mut tx = self.pool.begin().await?;
            purge_in(&mut tx, room).await?;
            tx.commit().await?;
            Ok(())
        })
        .await?;
        if let Some(r) = &self.redis {
            r.purge(room, None).await?;
        }
        Ok(())
    }
}

type Tx<'c> = sqlx::Transaction<'c, sqlx::Any>;

/// First statement of a guarded transaction: takes the write lock on the room's epoch row,
/// and fails with [`Fenced`] unless `epoch` is still the room's latest. A newer claim
/// ([`Store::claim_epoch`]) waits for this transaction, so it then sees everything it wrote.
async fn hold_epoch(tx: &mut Tx<'_>, room: &str, epoch: i64) -> anyhow::Result<()> {
    let n =
        sqlx::query("UPDATE room_epochs SET checks = checks + 1 WHERE room_id = ? AND epoch = ?")
            .bind(room)
            .bind(epoch)
            .execute(&mut **tx)
            .await?
            .rows_affected();
    if n == 0 {
        return Err(Fenced(room.into()).into());
    }
    Ok(())
}

/// One guarded statement for up to [`WAL_ROWS_PER_INSERT`] rows: each row is selected from
/// the room's `room_epochs` row only while `epoch` is the latest (read in the same statement,
/// under a shared lock on InnoDB), so either every row lands or none does ([`Fenced`]).
async fn insert_guarded<'e, E>(ex: E, room: &str, epoch: i64, rows: &[WalRow]) -> anyhow::Result<()>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let one = "SELECT ?, ?, ?, ?, ? FROM room_epochs WHERE room_id = ? AND epoch = ?";
    let sql = format!(
        "INSERT INTO room_updates (room_id, seq, data, origin, created_at) {}",
        vec![one; rows.len()].join(" UNION ALL ")
    );
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for r in rows {
        q = q
            .bind(room)
            .bind(r.seq)
            .bind(r.data.clone())
            .bind(r.origin.clone())
            .bind(r.at)
            .bind(room)
            .bind(epoch);
    }
    let n = q.execute(ex).await?.rows_affected();
    if n == 0 {
        return Err(Fenced(room.into()).into());
    }
    anyhow::ensure!(
        n == rows.len() as u64,
        "WAL append for room {room}: {n} of {} rows inserted",
        rows.len()
    );
    Ok(())
}

/// Commits the batches of one or more rooms in one transaction, each in `seq` order. A fenced
/// room gets its [`Fenced`] error and writes nothing; the others commit. Any other error
/// rolls the whole transaction back and is returned.
async fn commit_batches(
    pool: &AnyPool,
    batches: &[(&str, i64, &[WalRow])],
) -> anyhow::Result<Vec<anyhow::Result<()>>> {
    let mut tx = pool.begin().await?;
    let mut out = Vec::new();
    for &(room, epoch, rows) in batches {
        let mut res = Ok(());
        for chunk in rows.chunks(WAL_ROWS_PER_INSERT) {
            if let Err(e) = insert_guarded(&mut *tx, room, epoch, chunk).await {
                if !is_fenced(&e) {
                    return Err(e);
                }
                // Only the first chunk can be fenced: the epoch row stays locked until commit.
                res = Err(e);
                break;
            }
        }
        out.push(res);
    }
    tx.commit().await?;
    Ok(out)
}

/// `OC_WAL_GROUP_COMMIT=0` turns the SQLite group writer off: each room then commits its own
/// batch on the pool, as on MySQL/MariaDB.
fn group_commit_enabled() -> bool {
    std::env::var("OC_WAL_GROUP_COMMIT").map_or(true, |v| v.trim() != "0")
}

/// `OC_WAL_GROUP_WINDOW_MS` (default 0, at most 5): how long the group writer waits for more
/// rooms after the first. With 0 it takes whatever queued while the previous commit ran.
fn group_window() -> Duration {
    let ms = std::env::var("OC_WAL_GROUP_WINDOW_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(0);
    Duration::from_millis(ms.min(5))
}

/// The SQLite WAL writer: takes every room batch queued (up to [`GROUP_MAX_ROWS`] rows, or
/// what arrives within `window`) and commits them in one transaction, so pooled connections
/// no longer queue on SQLite's single writer lock for one row each.
async fn group_writer(
    pool: AnyPool,
    mut rx: mpsc::UnboundedReceiver<GroupJob>,
    window: Duration,
    write_lock: Option<Arc<tokio::sync::Mutex<()>>>,
) {
    while let Some(first) = rx.recv().await {
        let deadline = tokio::time::Instant::now() + window;
        let mut rows = first.rows.len();
        let mut jobs = vec![first];
        while rows < GROUP_MAX_ROWS {
            let next = match rx.try_recv() {
                Ok(j) => Some(j),
                Err(mpsc::error::TryRecvError::Empty) if !window.is_zero() => {
                    tokio::time::timeout_at(deadline, rx.recv())
                        .await
                        .ok()
                        .flatten()
                }
                Err(_) => None,
            };
            let Some(j) = next else { break };
            rows += j.rows.len();
            jobs.push(j);
        }
        let _w = match &write_lock {
            Some(l) => Some(l.clone().lock_owned().await),
            None => None,
        };
        commit_group(&pool, jobs).await;
    }
}

/// Commits a group and answers each room. When the shared transaction fails for a reason
/// other than fencing, each room's batch is retried alone, so one bad batch cannot fail the
/// rooms it happened to share a transaction with.
async fn commit_group(pool: &AnyPool, jobs: Vec<GroupJob>) {
    let batches: Vec<(&str, i64, &[WalRow])> = jobs
        .iter()
        .map(|j| (j.room.as_str(), j.epoch, j.rows.as_slice()))
        .collect();
    let batches = batches.as_slice();
    let res = retry_transient("WAL group commit", move || commit_batches(pool, batches)).await;
    match res {
        Ok(results) => {
            for (j, r) in jobs.into_iter().zip(results) {
                let _ = j.reply.send(r);
            }
        }
        Err(e) if jobs.len() == 1 => {
            if let Some(j) = jobs.into_iter().next() {
                let _ = j.reply.send(Err(e));
            }
        }
        Err(e) => {
            tracing::warn!(rooms = jobs.len(), error = %e, "WAL group commit failed; committing each room alone");
            for j in jobs {
                let one = &(j.room.as_str(), j.epoch, j.rows.as_slice());
                let r = retry_transient("WAL append", move || {
                    commit_batches(pool, std::slice::from_ref(one))
                })
                .await
                .and_then(|mut r| r.pop().unwrap_or(Ok(())));
                let _ = j.reply.send(r);
            }
        }
    }
}

async fn purge_in(tx: &mut Tx<'_>, room: &str) -> anyhow::Result<()> {
    for sql in [
        "DELETE FROM room_updates WHERE room_id = ?",
        "DELETE FROM room_snapshots WHERE room_id = ?",
        "DELETE FROM rooms WHERE id = ?",
        "DELETE FROM commit_outbox WHERE room_id = ? AND status <> 'pending'",
    ] {
        sqlx::query(sql).bind(room).execute(&mut **tx).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[derive(Debug, thiserror::Error)]
    #[error("{0}")]
    struct Flaky(&'static str);

    fn flaky(e: &anyhow::Error) -> bool {
        e.downcast_ref::<Flaky>().is_some_and(|f| f.0 == "deadlock")
    }

    #[tokio::test]
    async fn transient_errors_are_retried_up_to_three_attempts() {
        // Two deadlocks, then success: the caller sees the success.
        let calls = AtomicU32::new(0);
        let out = retry_with("test", flaky, || async {
            if calls.fetch_add(1, Ordering::SeqCst) < 2 {
                Err(Flaky("deadlock").into())
            } else {
                Ok(7)
            }
        })
        .await;
        assert_eq!(out.unwrap(), 7);
        assert_eq!(calls.load(Ordering::SeqCst), 3);

        // Always deadlocking: three attempts, then the error is returned (loudly, not dropped).
        let calls = AtomicU32::new(0);
        let started = std::time::Instant::now();
        let out: anyhow::Result<()> = retry_with("test", flaky, || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(Flaky("deadlock").into())
        })
        .await;
        assert_eq!(out.unwrap_err().to_string(), "deadlock");
        assert_eq!(calls.load(Ordering::SeqCst), RETRY_ATTEMPTS);
        assert!(started.elapsed() >= std::time::Duration::from_millis(25 + 50));

        // Anything else fails at once.
        let calls = AtomicU32::new(0);
        let out: anyhow::Result<()> = retry_with("test", flaky, || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(Flaky("syntax error").into())
        })
        .await;
        assert!(out.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn deadlocks_and_lock_waits_are_transient() {
        assert!(transient_message(
            Some("40001"),
            "Deadlock found when trying to get lock; try restarting transaction"
        ));
        assert!(transient_message(
            Some("HY000"),
            "Lock wait timeout exceeded; try restarting transaction"
        ));
        assert!(transient_message(None, "database is locked"));
        assert!(!transient_message(
            Some("23000"),
            "Duplicate entry 'r-1' for key 'PRIMARY'"
        ));
    }
}
