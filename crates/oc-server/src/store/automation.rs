// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `automation_schedule` and `automation_runs` (AUTO-03/05, migration 0010) on SQLite and
//! MySQL/MariaDB: ids, times, counts and codes only (ADR-001, AGENTS rules 5 and 9). Redis-only
//! storage has no automation (refused at start-up, as webhooks).

use sqlx::Row;

use super::Store;

/// Run log retention.
pub const KEEP_MS: i64 = 30 * 86_400_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleRow {
    pub room_id: String,
    pub rule_id: String,
    pub host_id: String,
    pub file_id: String,
    pub next_run_at: i64,
    pub claimed_until: i64,
}

/// One run, as logged. No text and no field values.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    #[serde(skip)]
    pub room_id: String,
    #[serde(skip)]
    pub host_id: String,
    pub file_id: String,
    pub rule_id: String,
    pub trigger: String,
    /// `done`, `skipped`, `failed`, `stopped`.
    pub result: String,
    pub error_code: String,
    pub http_status: i64,
    pub changes: i64,
    pub notified: i64,
    pub depth: i64,
    pub duration_ms: i64,
    pub at: i64,
}

fn int(r: &sqlx::any::AnyRow, i: usize) -> anyhow::Result<i64> {
    Ok(r.try_get::<i64, _>(i)
        .or_else(|_| r.try_get::<i32, _>(i).map(i64::from))?)
}

impl Store {
    pub fn automation_supported(&self) -> bool {
        self.kv.is_none()
    }
    fn no_tables(&self) -> anyhow::Result<()> {
        if !self.automation_supported() {
            anyhow::bail!(
                "automation needs a database (SQLite, MySQL or MariaDB), not Redis-only storage"
            );
        }
        Ok(())
    }

    /// Makes the room's schedule rows exactly `rules` (rule id, next run): rows of other rules
    /// go; a row whose time is unchanged keeps its claim. A row already due at `now_ms` keeps its
    /// slot (and claim) when the new time is later: the sweep runs it, then advances it. The
    /// room opening at 09:00:05, before the sweep, used to move the 09:00 slot to tomorrow and
    /// skip the run (RLB-04).
    pub async fn automation_schedule_set(
        &self,
        room_id: &str,
        host_id: &str,
        file_id: &str,
        rules: &[(String, i64)],
        now_ms: i64,
    ) -> anyhow::Result<()> {
        self.no_tables()?;
        let have =
            sqlx::query("SELECT rule_id, next_run_at FROM automation_schedule WHERE room_id = ?")
                .bind(room_id)
                .fetch_all(&self.pool)
                .await?;
        let mut existing = std::collections::HashMap::new();
        for r in &have {
            existing.insert(r.try_get::<String, _>(0)?, int(r, 1)?);
        }
        for rule in existing.keys() {
            if !rules.iter().any(|(id, _)| id == rule) {
                sqlx::query("DELETE FROM automation_schedule WHERE room_id = ? AND rule_id = ?")
                    .bind(room_id)
                    .bind(rule)
                    .execute(&self.pool)
                    .await?;
            }
        }
        for (rule, next) in rules {
            match existing.get(rule) {
                Some(n) if n == next => {}
                Some(n) if *n <= now_ms && *next > now_ms => {}
                Some(_) => {
                    sqlx::query(
                        "UPDATE automation_schedule SET next_run_at = ?, claimed_by = '', claimed_until = 0 \
                         WHERE room_id = ? AND rule_id = ?",
                    )
                    .bind(next)
                    .bind(room_id)
                    .bind(rule)
                    .execute(&self.pool)
                    .await?;
                }
                None => {
                    let res = sqlx::query(
                        "INSERT INTO automation_schedule (room_id, rule_id, host_id, file_id, next_run_at, claimed_by, claimed_until) \
                         VALUES (?, ?, ?, ?, ?, '', 0)",
                    )
                    .bind(room_id)
                    .bind(rule)
                    .bind(host_id)
                    .bind(file_id)
                    .bind(next)
                    .execute(&self.pool)
                    .await;
                    match res {
                        Ok(_) => {}
                        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {}
                        Err(e) => return Err(e.into()),
                    }
                }
            }
        }
        Ok(())
    }

    /// Rows due at `now_ms` and not claimed, oldest first.
    pub async fn automation_due(
        &self,
        now_ms: i64,
        limit: i64,
    ) -> anyhow::Result<Vec<ScheduleRow>> {
        self.no_tables()?;
        let rows = sqlx::query(
            "SELECT room_id, rule_id, host_id, file_id, next_run_at, claimed_until FROM automation_schedule \
             WHERE next_run_at <= ? AND claimed_until < ? ORDER BY next_run_at, room_id, rule_id LIMIT ?",
        )
        .bind(now_ms)
        .bind(now_ms)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        let mut out = vec![];
        for r in &rows {
            out.push(ScheduleRow {
                room_id: r.try_get(0)?,
                rule_id: r.try_get(1)?,
                host_id: r.try_get(2)?,
                file_id: r.try_get(3)?,
                next_run_at: int(r, 4)?,
                claimed_until: int(r, 5)?,
            });
        }
        Ok(out)
    }

    /// Claims a due row for this node: exactly one claimant wins (a conditional update).
    pub async fn automation_claim(
        &self,
        row: &ScheduleRow,
        node: &str,
        until: i64,
    ) -> anyhow::Result<bool> {
        self.no_tables()?;
        let res = sqlx::query(
            "UPDATE automation_schedule SET claimed_by = ?, claimed_until = ? \
             WHERE room_id = ? AND rule_id = ? AND next_run_at = ? AND claimed_until = ?",
        )
        .bind(node)
        .bind(until)
        .bind(&row.room_id)
        .bind(&row.rule_id)
        .bind(row.next_run_at)
        .bind(row.claimed_until)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() == 1)
    }

    /// After a run (or a retry): the row's next time, unclaimed.
    pub async fn automation_advance(
        &self,
        room_id: &str,
        rule_id: &str,
        seen: i64,
        next: i64,
    ) -> anyhow::Result<()> {
        self.no_tables()?;
        sqlx::query(
            "UPDATE automation_schedule SET next_run_at = ?, claimed_by = '', claimed_until = 0 \
             WHERE room_id = ? AND rule_id = ? AND next_run_at = ?",
        )
        .bind(next)
        .bind(room_id)
        .bind(rule_id)
        .bind(seen)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn automation_schedule_of(
        &self,
        room_id: &str,
    ) -> anyhow::Result<Vec<(String, i64)>> {
        self.no_tables()?;
        let rows = sqlx::query("SELECT rule_id, next_run_at FROM automation_schedule WHERE room_id = ? ORDER BY rule_id")
            .bind(room_id)
            .fetch_all(&self.pool)
            .await?;
        rows.iter()
            .map(|r| Ok((r.try_get(0)?, int(r, 1)?)))
            .collect()
    }

    /// Logs a run. False when a run with this id is already logged (the run happened: a run id
    /// comes from its trigger, so a retry or a second node does not run it again).
    pub async fn automation_run_insert(&self, r: &RunRow) -> anyhow::Result<bool> {
        self.no_tables()?;
        let res = sqlx::query(
            "INSERT INTO automation_runs (id, room_id, host_id, file_id, rule_id, trigger_kind, result, error_code, \
             http_status, changes, notified, depth, duration_ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&r.id)
        .bind(&r.room_id)
        .bind(&r.host_id)
        .bind(&r.file_id)
        .bind(&r.rule_id)
        .bind(&r.trigger)
        .bind(&r.result)
        .bind(&r.error_code)
        .bind(r.http_status)
        .bind(r.changes)
        .bind(r.notified)
        .bind(r.depth)
        .bind(r.duration_ms)
        .bind(r.at)
        .execute(&self.pool)
        .await;
        match res {
            Ok(_) => Ok(true),
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    /// Updates a logged run's outcome (after its actions ran).
    pub async fn automation_run_finish(&self, r: &RunRow) -> anyhow::Result<()> {
        self.no_tables()?;
        sqlx::query(
            "UPDATE automation_runs SET result = ?, error_code = ?, http_status = ?, changes = ?, notified = ?, duration_ms = ? WHERE id = ?",
        )
        .bind(&r.result)
        .bind(&r.error_code)
        .bind(r.http_status)
        .bind(r.changes)
        .bind(r.notified)
        .bind(r.duration_ms)
        .bind(&r.id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// The room's runs, newest first; `rule` and `result` filter; `before` pages.
    pub async fn automation_runs(
        &self,
        room_id: &str,
        rule: Option<&str>,
        result: Option<&str>,
        before: Option<i64>,
        limit: i64,
    ) -> anyhow::Result<Vec<RunRow>> {
        self.no_tables()?;
        let rows = sqlx::query(
            "SELECT id, room_id, host_id, file_id, rule_id, trigger_kind, result, error_code, http_status, changes, notified, depth, duration_ms, at \
             FROM automation_runs WHERE room_id = ? AND (? = '' OR rule_id = ?) AND (? = '' OR result = ?) AND at < ? \
             ORDER BY at DESC, id DESC LIMIT ?",
        )
        .bind(room_id)
        .bind(rule.unwrap_or(""))
        .bind(rule.unwrap_or(""))
        .bind(result.unwrap_or(""))
        .bind(result.unwrap_or(""))
        .bind(before.unwrap_or(i64::MAX))
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        let mut out = vec![];
        for r in &rows {
            out.push(RunRow {
                id: r.try_get(0)?,
                room_id: r.try_get(1)?,
                host_id: r.try_get(2)?,
                file_id: r.try_get(3)?,
                rule_id: r.try_get(4)?,
                trigger: r.try_get(5)?,
                result: r.try_get(6)?,
                error_code: r.try_get(7)?,
                http_status: int(r, 8)?,
                changes: int(r, 9)?,
                notified: int(r, 10)?,
                depth: int(r, 11)?,
                duration_ms: int(r, 12)?,
                at: int(r, 13)?,
            });
        }
        Ok(out)
    }

    /// Consecutive failed runs of a rule, newest first, up to `max` (auto-pause).
    pub async fn automation_failures(
        &self,
        room_id: &str,
        rule: &str,
        max: i64,
    ) -> anyhow::Result<i64> {
        let runs = self
            .automation_runs(room_id, Some(rule), None, None, max)
            .await?;
        Ok(runs
            .iter()
            .filter(|r| r.result != "skipped")
            .take_while(|r| r.result == "failed")
            .count() as i64)
    }

    /// Runs still `running` that started before `before_ms` become `failed` / `INTERRUPTED`.
    pub async fn automation_interrupt_stale(&self, before_ms: i64) -> anyhow::Result<u64> {
        self.no_tables()?;
        let res = sqlx::query(
            "UPDATE automation_runs SET result = 'failed', error_code = 'INTERRUPTED' WHERE result = 'running' AND at < ?",
        )
        .bind(before_ms)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    /// Runs of the room since `since_ms` (the daily limit).
    pub async fn automation_runs_since(&self, room_id: &str, since_ms: i64) -> anyhow::Result<i64> {
        self.no_tables()?;
        let r = sqlx::query("SELECT COUNT(*) FROM automation_runs WHERE room_id = ? AND at >= ? AND result <> 'skipped'")
            .bind(room_id)
            .bind(since_ms)
            .fetch_one(&self.pool)
            .await?;
        int(&r, 0)
    }

    /// Drops runs older than 30 days.
    pub async fn automation_purge(&self, now_ms: i64) -> anyhow::Result<u64> {
        self.no_tables()?;
        let res = sqlx::query("DELETE FROM automation_runs WHERE at < ?")
            .bind(now_ms - KEEP_MS)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected())
    }
}
