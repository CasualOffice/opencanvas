// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `link_edges` (LINK-02, migration 0014, ADR-081) on SQLite and MySQL/MariaDB: ids and a kind
//! only, never a title or text (ADR-001; LINK-A3). Redis-only storage has no link index
//! (refused at start-up for `[host.flags] links`, as automation and webhooks).

use oc_model::links::{Edge, Kind};
use sqlx::Row;

use super::Store;
use crate::grant::room_id;

/// Rows per `INSERT` (11 values each; well under every backend's bind limit).
const BATCH: usize = 100;
/// Most rows one read returns (a target linked from more sources is cut, newest first).
pub const MAX_READ: i64 = 20_000;

/// One stored edge, as read back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkRow {
    pub src_file: String,
    pub src_block: String,
    pub dst_file: String,
    pub dst_block: String,
    pub dst_row: String,
    pub kind: Kind,
    pub saved_at: i64,
}

fn int(r: &sqlx::any::AnyRow, i: usize) -> anyhow::Result<i64> {
    Ok(r.try_get::<i64, _>(i)
        .or_else(|_| r.try_get::<i32, _>(i).map(i64::from))?)
}

fn rows(rs: Vec<sqlx::any::AnyRow>) -> anyhow::Result<Vec<LinkRow>> {
    rs.iter()
        .map(|r| {
            Ok(LinkRow {
                src_file: r.try_get(0)?,
                src_block: r.try_get(1)?,
                dst_file: r.try_get(2)?,
                dst_block: r.try_get(3)?,
                dst_row: r.try_get(4)?,
                kind: Kind::parse(&r.try_get::<String, _>(5)?).unwrap_or(Kind::Link),
                saved_at: int(r, 6)?,
            })
        })
        .collect()
}

impl Store {
    /// Whether this storage keeps a link index (a database, not Redis-only).
    pub fn links_supported(&self) -> bool {
        self.kv.is_none()
    }

    fn links_tables(&self) -> anyhow::Result<()> {
        if !self.links_supported() {
            anyhow::bail!(
                "the link index needs a database (SQLite, MySQL or MariaDB), not Redis-only storage"
            );
        }
        Ok(())
    }

    /// Makes `src_file`'s outgoing edges exactly `edges`, in one transaction (LINK-02: called
    /// only after the host acknowledged the save that holds them).
    pub async fn links_replace(
        &self,
        host_id: &str,
        src_file: &str,
        edges: &[Edge],
        saved_at: i64,
    ) -> anyhow::Result<()> {
        self.links_tables()?;
        let src_key = room_id(host_id, src_file);
        let _w = self.write_turn().await;
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM link_edges WHERE src_key = ?")
            .bind(&src_key)
            .execute(&mut *tx)
            .await?;
        for (c, chunk) in edges.chunks(BATCH).enumerate() {
            let mut sql = String::from(
                "INSERT INTO link_edges (src_key, n, host_id, src_file, src_block, dst_key, dst_file, dst_block, dst_row, kind, saved_at) VALUES ",
            );
            for i in 0..chunk.len() {
                if i > 0 {
                    sql.push_str(", ");
                }
                sql.push_str("(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
            }
            // Only placeholders are added to the statement; every value is bound.
            let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
            for (i, e) in chunk.iter().enumerate() {
                q = q
                    .bind(src_key.clone())
                    .bind((c * BATCH + i) as i32)
                    .bind(host_id.to_string())
                    .bind(src_file.to_string())
                    .bind(e.src_block.clone())
                    .bind(room_id(host_id, &e.dst_file))
                    .bind(e.dst_file.clone())
                    .bind(e.dst_block.clone())
                    .bind(e.dst_row.clone())
                    .bind(e.kind.as_str())
                    .bind(saved_at);
            }
            q.execute(&mut *tx).await?;
        }
        tx.commit().await?;
        crate::links::GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    /// Edges pointing at `dst_file`, newest save first.
    pub async fn links_to(&self, host_id: &str, dst_file: &str) -> anyhow::Result<Vec<LinkRow>> {
        self.links_tables()?;
        let rs = sqlx::query(
            "SELECT src_file, src_block, dst_file, dst_block, dst_row, kind, saved_at FROM link_edges \
             WHERE dst_key = ? AND dst_file = ? AND host_id = ? ORDER BY saved_at DESC, src_key, n LIMIT ?",
        )
        .bind(room_id(host_id, dst_file))
        .bind(dst_file)
        .bind(host_id)
        .bind(MAX_READ)
        .fetch_all(&self.pool)
        .await?;
        rows(rs)
    }

    /// Edges leaving `src_file`, in document order.
    pub async fn links_from(&self, host_id: &str, src_file: &str) -> anyhow::Result<Vec<LinkRow>> {
        self.links_tables()?;
        let rs = sqlx::query(
            "SELECT src_file, src_block, dst_file, dst_block, dst_row, kind, saved_at FROM link_edges \
             WHERE src_key = ? AND src_file = ? AND host_id = ? ORDER BY n LIMIT ?",
        )
        .bind(room_id(host_id, src_file))
        .bind(src_file)
        .bind(host_id)
        .bind(MAX_READ)
        .fetch_all(&self.pool)
        .await?;
        rows(rs)
    }

    /// Edges leaving or reaching any of `files` (one graph level, GRAPH-01), in one query per
    /// 200 files instead of two per file.
    pub async fn links_touching(
        &self,
        host_id: &str,
        files: &[String],
    ) -> anyhow::Result<Vec<LinkRow>> {
        self.links_tables()?;
        let mut out = vec![];
        for chunk in files.chunks(200) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let sql = format!(
                "SELECT src_file, src_block, dst_file, dst_block, dst_row, kind, saved_at FROM link_edges \
                 WHERE host_id = ? AND (src_key IN ({marks}) OR dst_key IN ({marks})) LIMIT ?"
            );
            // Only placeholders are added to the statement; every value is bound.
            let mut q = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(host_id.to_string());
            for _ in 0..2 {
                for f in chunk {
                    q = q.bind(room_id(host_id, f));
                }
            }
            out.extend(rows(q.bind(MAX_READ).fetch_all(&self.pool).await?)?);
        }
        Ok(out)
    }

    /// A host's edges, newest saves first, at most `limit` (the full graph, GRAPH-01).
    pub async fn links_all(&self, host_id: &str, limit: i64) -> anyhow::Result<Vec<LinkRow>> {
        self.links_tables()?;
        let rs = sqlx::query(
            "SELECT src_file, src_block, dst_file, dst_block, dst_row, kind, saved_at FROM link_edges \
             WHERE host_id = ? ORDER BY saved_at DESC, src_key, n LIMIT ?",
        )
        .bind(host_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows(rs)
    }

    /// Drops `src_file`'s outgoing edges (a deleted source). Answers how many went.
    pub async fn links_delete_src(&self, host_id: &str, src_file: &str) -> anyhow::Result<u64> {
        self.links_tables()?;
        let _w = self.write_turn().await;
        let r = sqlx::query("DELETE FROM link_edges WHERE src_key = ?")
            .bind(room_id(host_id, src_file))
            .execute(&self.pool)
            .await?;
        crate::links::GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(r.rows_affected())
    }

    /// Every stored string, for the LINK-A3 test (no text at rest).
    #[doc(hidden)]
    pub async fn links_dump(&self) -> anyhow::Result<Vec<String>> {
        self.links_tables()?;
        let rs = sqlx::query(
            "SELECT src_key, host_id, src_file, src_block, dst_key, dst_file, dst_block, dst_row, kind FROM link_edges",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut out = vec![];
        for r in &rs {
            for i in 0..9 {
                out.push(r.try_get::<String, _>(i)?);
            }
        }
        Ok(out)
    }
}
