//! Transient state in SQLite or MySQL/MariaDB through the sqlx `Any` driver (docs/04 §5).

use std::time::Duration;

use anyhow::Context;
use sqlx::any::{AnyPoolOptions, install_default_drivers};
use sqlx::migrate::Migrator;
use sqlx::{AnyPool, Executor, Row};

use crate::crypto::{self, Kek};
use crate::grant::{Grant, Role};

static SQLITE: Migrator = sqlx::migrate!("../../migrations/sqlite");
static MYSQL: Migrator = sqlx::migrate!("../../migrations/mysql");

#[derive(Clone)]
pub struct Store {
    pool: AnyPool,
    kek: Option<Kek>,
}

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
        if sqlite {
            SQLITE.run(&pool).await
        } else {
            MYSQL.run(&pool).await
        }
        .context("running migrations")?;
        Ok(Self { pool, kek })
    }

    pub async fn ping(&self) -> bool {
        sqlx::query("SELECT 1").execute(&self.pool).await.is_ok()
    }

    /// Records a launch `jti`; returns false if it was already used.
    pub async fn use_jti(&self, host: &str, jti: &str, expires_at: i64) -> anyhow::Result<bool> {
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
        let row = sqlx::query("SELECT grant_json FROM sessions WHERE id = ?")
            .bind(ticket)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.try_get::<String, _>(0)).transpose()?)
    }

    /// Raw `token` column of a room's newest outbox row (tests check that it is sealed).
    #[doc(hidden)]
    pub async fn raw_outbox_token(&self, room: &str) -> anyhow::Result<String> {
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
        let res = sqlx::query("DELETE FROM sessions WHERE room_id = ?")
            .bind(room)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected())
    }

    // ---------- commit outbox (durable saves) ----------

    /// Records a commit as `pending` before it is sent; older pending rows of the room are
    /// superseded (the new payload contains everything they had).
    pub async fn outbox_insert(&self, row: &OutboxRow, now_ms: i64) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
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

    /// Every pending commit (startup sweeper), oldest first. Unreadable rows are skipped.
    pub async fn outbox_all_pending(&self) -> anyhow::Result<Vec<OutboxRow>> {
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
    pub async fn outbox_finish(&self, id: &str, status: &str) -> anyhow::Result<()> {
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

    pub async fn purge_expired(&self, now: i64) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM sessions WHERE expires_at < ?")
            .bind(now)
            .execute(&self.pool)
            .await?;
        sqlx::query("DELETE FROM launch_jti WHERE expires_at < ?")
            .bind(now)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn room(&self, id: &str) -> anyhow::Result<Option<RoomRow>> {
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

    pub async fn append_update(
        &self,
        room: &str,
        seq: i64,
        data: &[u8],
        origin: &str,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        sqlx::query("INSERT INTO room_updates (room_id, seq, data, origin, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(room)
            .bind(seq)
            .bind(data.to_vec())
            .bind(origin)
            .bind(now_ms)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn load_wal(&self, room: &str) -> anyhow::Result<Wal> {
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

    /// Replaces the snapshot and drops WAL entries it covers.
    pub async fn compact(
        &self,
        room: &str,
        seq: i64,
        state: &[u8],
        now_ms: i64,
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
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
        let row = sqlx::query("SELECT COALESCE(SUM(size), 0) FROM room_assets WHERE room_id = ?")
            .bind(room)
            .fetch_one(&self.pool)
            .await?;
        // SUM is DECIMAL on MySQL and INTEGER on SQLite.
        Ok(row
            .try_get::<i64, _>(0)
            .or_else(|_| row.try_get::<f64, _>(0).map(|f| f as i64))
            .or_else(|_| {
                row.try_get::<String, _>(0)
                    .map(|s| s.parse::<f64>().unwrap_or(0.0) as i64)
            })?)
    }

    /// Deletes assets of rooms that are gone and have no pending commit, created before
    /// `older_than_ms` (so a room being opened right now keeps its freshly extracted assets).
    pub async fn purge_orphan_assets(&self, older_than_ms: i64) -> anyhow::Result<u64> {
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

    pub async fn purge_room(&self, room: &str) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        for sql in [
            "DELETE FROM room_updates WHERE room_id = ?",
            "DELETE FROM room_snapshots WHERE room_id = ?",
            "DELETE FROM rooms WHERE id = ?",
            "DELETE FROM commit_outbox WHERE room_id = ? AND status <> 'pending'",
        ] {
            sqlx::query(sql).bind(room).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }
}
