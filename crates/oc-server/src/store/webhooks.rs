// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `webhook_outbox` (WH-01, ADR-056) on SQLite and MySQL/MariaDB: change events waiting for
//! delivery to a host's webhook URL. Event metadata only, never document content (ADR-001).
//! Redis-only storage has no outbox (webhooks are refused at startup there).

use sqlx::Row;

use super::Store;

/// One queued webhook delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookRow {
    /// The event id (`ev_<ulid>`), also the delivery's `Idempotency-Key`.
    pub id: String,
    pub host_id: String,
    pub room_id: String,
    pub file_id: String,
    pub event_type: String,
    /// The event JSON as delivered.
    pub payload: String,
    pub attempts: i64,
    pub next_try_at: i64,
}

/// A row's state, for tests and inspection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookState {
    pub status: String,
    pub attempts: i64,
    pub next_try_at: i64,
    pub last_status: i64,
}

fn int(r: &sqlx::any::AnyRow, i: usize) -> anyhow::Result<i64> {
    Ok(r.try_get::<i64, _>(i)
        .or_else(|_| r.try_get::<i32, _>(i).map(i64::from))?)
}

impl Store {
    fn no_outbox(&self) -> anyhow::Result<()> {
        if self.kv.is_some() {
            anyhow::bail!(
                "webhooks need a database (SQLite, MySQL or MariaDB), not Redis-only storage"
            );
        }
        Ok(())
    }

    /// Queues a delivery as `pending`, due at `row.next_try_at`. False when the event is
    /// already queued (same id): an event is delivered once.
    pub async fn webhook_insert(&self, row: &WebhookRow, now_ms: i64) -> anyhow::Result<bool> {
        self.no_outbox()?;
        let res = sqlx::query(
            "INSERT INTO webhook_outbox (id, host_id, room_id, file_id, event_type, payload, attempts, next_try_at, status, last_status, created_at, done_at) \
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'pending', 0, ?, 0)",
        )
        .bind(&row.id)
        .bind(&row.host_id)
        .bind(&row.room_id)
        .bind(&row.file_id)
        .bind(&row.event_type)
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

    /// Pending deliveries due at `now_ms`, oldest first.
    pub async fn webhook_due(&self, now_ms: i64, limit: i64) -> anyhow::Result<Vec<WebhookRow>> {
        self.no_outbox()?;
        let rows = sqlx::query(
            "SELECT id, host_id, room_id, file_id, event_type, payload, attempts, next_try_at \
             FROM webhook_outbox WHERE status = 'pending' AND next_try_at <= ? \
             ORDER BY next_try_at, id LIMIT ?",
        )
        .bind(now_ms)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for r in &rows {
            out.push(WebhookRow {
                id: r.try_get(0)?,
                host_id: r.try_get(1)?,
                room_id: r.try_get(2)?,
                file_id: r.try_get(3)?,
                event_type: r.try_get(4)?,
                payload: r.try_get(5)?,
                attempts: int(r, 6)?,
                next_try_at: r.try_get(7)?,
            });
        }
        Ok(out)
    }

    /// Takes a due row for one attempt by moving `next_try_at` from `seen` to `until`. False
    /// when another worker (or node) took it first: exactly one claimant wins.
    pub async fn webhook_claim(&self, id: &str, seen: i64, until: i64) -> anyhow::Result<bool> {
        self.no_outbox()?;
        let res = sqlx::query(
            "UPDATE webhook_outbox SET next_try_at = ? WHERE id = ? AND status = 'pending' AND next_try_at = ?",
        )
        .bind(until)
        .bind(id)
        .bind(seen)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() == 1)
    }

    /// A failed attempt (`last_status`: HTTP status, 0 = no answer): try again at `next_try_at`.
    pub async fn webhook_retry(
        &self,
        id: &str,
        next_try_at: i64,
        last_status: i64,
    ) -> anyhow::Result<()> {
        self.no_outbox()?;
        sqlx::query(
            "UPDATE webhook_outbox SET attempts = attempts + 1, next_try_at = ?, last_status = ? \
             WHERE id = ? AND status = 'pending'",
        )
        .bind(next_try_at)
        .bind(last_status)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Final state: `done`, `rejected` (the receiver refused), `failed` (gave up) or `refused`
    /// (the URL is not allowed).
    pub async fn webhook_finish(
        &self,
        id: &str,
        status: &str,
        last_status: i64,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        self.no_outbox()?;
        sqlx::query(
            "UPDATE webhook_outbox SET status = ?, attempts = attempts + 1, last_status = ?, done_at = ? \
             WHERE id = ? AND status = 'pending'",
        )
        .bind(status)
        .bind(last_status)
        .bind(now_ms)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// One row's state (tests, inspection).
    pub async fn webhook_state(&self, id: &str) -> anyhow::Result<Option<WebhookState>> {
        self.no_outbox()?;
        let row = sqlx::query(
            "SELECT status, attempts, next_try_at, last_status FROM webhook_outbox WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(match row {
            Some(r) => Some(WebhookState {
                status: r.try_get(0)?,
                attempts: int(&r, 1)?,
                next_try_at: r.try_get(2)?,
                last_status: int(&r, 3)?,
            }),
            None => None,
        })
    }

    /// Ids of a host's rows, oldest first (tests, inspection).
    pub async fn webhook_ids(&self, host_id: &str) -> anyhow::Result<Vec<String>> {
        self.no_outbox()?;
        let rows =
            sqlx::query("SELECT id FROM webhook_outbox WHERE host_id = ? ORDER BY created_at, id")
                .bind(host_id)
                .fetch_all(&self.pool)
                .await?;
        rows.iter()
            .map(|r| r.try_get(0).map_err(Into::into))
            .collect()
    }

    /// Pending deliveries (the dashboard's backlog gauge).
    pub async fn webhook_pending(&self) -> anyhow::Result<i64> {
        self.no_outbox()?;
        let r = sqlx::query("SELECT COUNT(*) FROM webhook_outbox WHERE status = 'pending'")
            .fetch_one(&self.pool)
            .await?;
        int(&r, 0)
    }

    /// Drops finished rows older than `before_ms` (kept 7 days for inspection).
    pub async fn webhook_purge(&self, before_ms: i64) -> anyhow::Result<()> {
        if self.kv.is_some() {
            return Ok(());
        }
        sqlx::query("DELETE FROM webhook_outbox WHERE status <> 'pending' AND created_at < ?")
            .bind(before_ms)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}
