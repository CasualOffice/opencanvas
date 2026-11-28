// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The Workspace database: SQLite by default (`<data>/workspace.db`, WAL mode), MySQL 8 /
//! MariaDB 10.6+ with `WS_DATABASE_URL` (ADR-085 §4, matching ADR-004). Migrations run on
//! start; a database migrated by a newer release refuses to start (docs/40 §4.9).

use std::time::Duration;

use anyhow::Context;
use sqlx::any::{AnyPoolOptions, install_default_drivers};
use sqlx::{AnyPool, Executor};

#[derive(Clone)]
pub struct Db {
    pub pool: AnyPool,
    pub sqlite: bool,
}

impl Db {
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        install_default_drivers();
        let sqlite = url.starts_with("sqlite:");
        if sqlite
            && let Some(path) = url
                .strip_prefix("sqlite://")
                .and_then(|p| p.split('?').next())
            && let Some(dir) = std::path::Path::new(path).parent()
            && !dir.as_os_str().is_empty()
        {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let mut opts = AnyPoolOptions::new()
            .max_connections(if sqlite { 8 } else { 16 })
            .acquire_timeout(Duration::from_secs(10));
        if sqlite {
            opts = opts.after_connect(|conn, _| {
                Box::pin(async move {
                    conn.execute("PRAGMA journal_mode=WAL").await?;
                    conn.execute("PRAGMA busy_timeout=5000").await?;
                    conn.execute("PRAGMA synchronous=NORMAL").await?;
                    conn.execute("PRAGMA foreign_keys=ON").await?;
                    Ok(())
                })
            });
        }
        let pool = opts
            .connect(url)
            .await
            .context("connecting to the Workspace database")?;
        let db = Self { pool, sqlite };
        db.migrate().await?;
        Ok(db)
    }

    async fn migrate(&self) -> anyhow::Result<()> {
        let m = if self.sqlite {
            sqlx::migrate!("./migrations/sqlite")
        } else {
            sqlx::migrate!("./migrations/mysql")
        };
        match m.run(&self.pool).await {
            Ok(()) => Ok(()),
            Err(sqlx::migrate::MigrateError::VersionMissing(v)) => anyhow::bail!(
                "this database was upgraded by a newer OpenCanvas Workspace (migration {v} is unknown \
                 to this version). Downgrades are not supported: run the newer image, or restore the \
                 backup taken before the upgrade into an empty volume"
            ),
            Err(e) => Err(e).context("running the Workspace migrations"),
        }
    }

    /// `INSERT OR IGNORE` (SQLite) or `INSERT IGNORE` (MySQL).
    pub fn insert_ignore(&self) -> &'static str {
        if self.sqlite {
            "INSERT OR IGNORE"
        } else {
            "INSERT IGNORE"
        }
    }

    pub async fn meta(&self, k: &str) -> anyhow::Result<Option<String>> {
        Ok(
            sqlx::query_scalar::<_, String>("SELECT v FROM meta WHERE k = ?")
                .bind(k)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    pub async fn set_meta(&self, k: &str, v: &str) -> anyhow::Result<()> {
        let sql = if self.sqlite {
            "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
        } else {
            "INSERT INTO meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)"
        };
        sqlx::query(sql).bind(k).bind(v).execute(&self.pool).await?;
        Ok(())
    }
}
