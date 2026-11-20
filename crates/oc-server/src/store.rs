//! Transient state in SQLite or MySQL/MariaDB through the sqlx `Any` driver (docs/04 §5).

use std::time::Duration;

use anyhow::Context;
use sqlx::any::{AnyPoolOptions, install_default_drivers};
use sqlx::migrate::Migrator;
use sqlx::{AnyPool, Executor, Row};

use crate::grant::Grant;

static SQLITE: Migrator = sqlx::migrate!("../../migrations/sqlite");
static MYSQL: Migrator = sqlx::migrate!("../../migrations/mysql");

#[derive(Clone)]
pub struct Store {
    pool: AnyPool,
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
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
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
        Ok(Self { pool })
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
        .bind(serde_json::to_string(grant)?)
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
        let grant: Grant = serde_json::from_str(&row.try_get::<String, _>(0)?)?;
        Ok(Some((grant, row.try_get::<i64, _>(1)?)))
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

    pub async fn purge_room(&self, room: &str) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        for sql in [
            "DELETE FROM room_updates WHERE room_id = ?",
            "DELETE FROM room_snapshots WHERE room_id = ?",
            "DELETE FROM rooms WHERE id = ?",
        ] {
            sqlx::query(sql).bind(room).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }
}
