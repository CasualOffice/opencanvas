// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Background work (WS-15): purge Trash after its retention, thin version history, drop
//! expired sessions and tokens. One sweep an hour; cheap when there is nothing to do.

use std::time::Duration;

use crate::Ws;
use crate::util::now_ms;

/// Removes a canvas for good: files on disk (or S3), versions, search entry, shares, stars.
pub async fn purge_canvas(ws: &Ws, canvas: &str) -> anyhow::Result<()> {
    ws.engine.close_sessions(canvas).await;
    ws.files.delete_canvas(canvas).await?;
    let assets: Vec<String> = sqlx::query_scalar("SELECT id FROM assets WHERE canvas_id = ?")
        .bind(canvas)
        .fetch_all(&ws.db.pool)
        .await?;
    for a in assets {
        ws.files.delete_asset(&a).await?;
    }
    crate::search::remove(&ws.db, canvas).await?;
    let mut tx = ws.db.pool.begin().await?;
    for sql in [
        "DELETE FROM versions WHERE canvas_id = ?",
        "DELETE FROM assets WHERE canvas_id = ?",
        "DELETE FROM shares WHERE object_kind = 'canvas' AND object_id = ?",
        "DELETE FROM favourites WHERE canvas_id = ?",
        "DELETE FROM recents WHERE canvas_id = ?",
        "DELETE FROM notifications WHERE canvas_id = ?",
        "DELETE FROM canvases WHERE id = ?",
    ] {
        sqlx::query(sql).bind(canvas).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    ws.acl.invalidate();
    Ok(())
}

pub struct SweepReport {
    pub purged: usize,
    pub thinned: usize,
}

pub async fn sweep(ws: &Ws, now: i64) -> anyhow::Result<SweepReport> {
    let (settings, _) = crate::settings::Settings::load(&ws.db, &ws.cfg).await?;
    let cutoff = now - settings.trash_days * 86_400_000;
    let old: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM canvases WHERE deleted_at IS NOT NULL AND deleted_at < ?",
    )
    .bind(cutoff)
    .fetch_all(&ws.db.pool)
    .await?;
    let purged = old.len();
    for c in old {
        purge_canvas(ws, &c).await?;
    }
    sqlx::query("DELETE FROM shares WHERE object_kind = 'folder' AND object_id IN (SELECT id FROM folders WHERE deleted_at IS NOT NULL AND deleted_at < ?)")
        .bind(cutoff)
        .execute(&ws.db.pool)
        .await?;
    sqlx::query("DELETE FROM folders WHERE deleted_at IS NOT NULL AND deleted_at < ?")
        .bind(cutoff)
        .execute(&ws.db.pool)
        .await?;
    let mut thinned = 0;
    let live: Vec<(String, i64)> =
        sqlx::query_as("SELECT id, version FROM canvases WHERE version > 1")
            .fetch_all(&ws.db.pool)
            .await?;
    for (c, v) in live {
        thinned += crate::model::thin_canvas(ws, &c, v).await?;
    }
    sqlx::query("DELETE FROM sessions WHERE expires_at < ?")
        .bind(now)
        .execute(&ws.db.pool)
        .await?;
    sqlx::query("DELETE FROM tokens WHERE expires_at < ?")
        .bind(now - 30 * 86_400_000)
        .execute(&ws.db.pool)
        .await?;
    sqlx::query("DELETE FROM idempotency WHERE at < ?")
        .bind(now - 7 * 86_400_000)
        .execute(&ws.db.pool)
        .await?;
    ws.acl.invalidate();
    Ok(SweepReport { purged, thinned })
}

pub fn spawn(ws: Ws) {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_secs(3600));
        loop {
            every.tick().await;
            match sweep(&ws, now_ms()).await {
                Ok(r) if r.purged + r.thinned > 0 => {
                    tracing::info!(purged = r.purged, thinned = r.thinned, "workspace sweep")
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "workspace sweep failed"),
            }
        }
    });
}
