// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Canvases, versions and access changes (WS-10, WS-11, WS-13, WS-15).

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use serde::Serialize;
use sqlx::Row;

use crate::Ws;
use crate::access::{Role, Snapshot};
use crate::util::now_ms;

/// File types (owner decision 8, docs/05 §2f).
pub const FILE_TYPES: &[&str] = &["document", "spreadsheet", "whiteboard", "database"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Canvas {
    pub id: String,
    pub workspace_id: String,
    pub folder_id: Option<String>,
    pub name: String,
    #[serde(rename = "type")]
    pub ftype: String,
    pub version: i64,
    pub size: i64,
    pub is_template: bool,
    #[serde(skip)]
    pub seed: Option<String>,
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub updated_by: Option<String>,
    pub deleted_at: Option<i64>,
    pub link_access: String,
    pub link_role: String,
    #[serde(skip)]
    pub link_token: Option<String>,
    pub link_expires_at: Option<i64>,
    #[serde(skip)]
    pub link_password_hash: Option<String>,
}

pub const CANVAS_COLS: &str = "id, workspace_id, folder_id, name, ftype, version, size, is_template, seed, created_by, \
    created_at, updated_at, updated_by, deleted_at, link_access, link_role, link_token, link_expires_at, link_password_hash";

pub fn canvas_from(r: &sqlx::any::AnyRow) -> Result<Canvas, sqlx::Error> {
    Ok(Canvas {
        id: r.try_get(0)?,
        workspace_id: r.try_get(1)?,
        folder_id: r.try_get(2)?,
        name: r.try_get(3)?,
        ftype: r.try_get(4)?,
        version: r.try_get(5)?,
        size: r.try_get(6)?,
        is_template: r.try_get::<i64, _>(7)? != 0,
        seed: r.try_get(8)?,
        created_by: r.try_get(9)?,
        created_at: r.try_get(10)?,
        updated_at: r.try_get(11)?,
        updated_by: r.try_get(12)?,
        deleted_at: r.try_get(13)?,
        link_access: r.try_get(14)?,
        link_role: r.try_get(15)?,
        link_token: r.try_get(16)?,
        link_expires_at: r.try_get(17)?,
        link_password_hash: r.try_get(18)?,
    })
}

pub async fn canvas(ws: &Ws, id: &str) -> Result<Option<Canvas>, sqlx::Error> {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {CANVAS_COLS} FROM canvases WHERE id = ?"
    )))
    .bind(id)
    .fetch_optional(&ws.db.pool)
    .await?
    .map(|r| canvas_from(&r))
    .transpose()
}

/// "Workspace › Folder › Sub-folder": where a canvas lives, for headers and search.
pub async fn location(ws: &Ws, c: &Canvas) -> Result<String, sqlx::Error> {
    let mut parts = Vec::new();
    let mut cur = c.folder_id.clone();
    for _ in 0..=crate::access::MAX_DEPTH {
        let Some(f) = cur else { break };
        let Some(r) = sqlx::query("SELECT name, parent_id FROM folders WHERE id = ?")
            .bind(&f)
            .fetch_optional(&ws.db.pool)
            .await?
        else {
            break;
        };
        parts.push(r.try_get::<String, _>(0)?);
        cur = r.try_get(1)?;
    }
    if let Some(w) = sqlx::query_scalar::<_, String>("SELECT name FROM workspaces WHERE id = ?")
        .bind(&c.workspace_id)
        .fetch_optional(&ws.db.pool)
        .await?
    {
        parts.push(w);
    }
    parts.reverse();
    Ok(parts.join(" › "))
}

/// The facts the engine sends with a save (docs/05 §5).
#[derive(Default, Debug)]
pub struct SaveMeta {
    pub autosave: bool,
    pub name: Option<String>,
    pub restored_from: Option<String>,
    pub checkpoint: bool,
    pub authors: Vec<String>,
}

impl SaveMeta {
    pub fn kind(&self) -> &'static str {
        match (self.autosave, &self.restored_from) {
            (true, _) => "auto",
            (false, Some(_)) => "restore",
            (false, None) => "named",
        }
    }
}

/// Stores a new version of `c` and makes it current; returns the new version number.
pub async fn store_version(
    ws: &Ws,
    c: &Canvas,
    bytes: &[u8],
    m: &SaveMeta,
    by: Option<&str>,
) -> anyhow::Result<i64> {
    let v = c.version + 1;
    ws.files.put_version(&c.id, v, bytes).await?;
    let now = now_ms();
    let mut tx = ws.db.pool.begin().await?;
    sqlx::query(
        "INSERT INTO versions (canvas_id, version, at, authors, kind, name, restored_from, checkpoint, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&c.id)
    .bind(v)
    .bind(now)
    .bind(serde_json::to_string(&m.authors)?)
    .bind(m.kind())
    .bind(m.name.as_deref())
    .bind(m.restored_from.as_deref())
    .bind(m.checkpoint as i64)
    .bind(bytes.len() as i64)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE canvases SET version = ?, size = ?, updated_at = ?, updated_by = ?, seed = NULL WHERE id = ? AND version = ?")
        .bind(v)
        .bind(bytes.len() as i64)
        .bind(now)
        .bind(by.or(m.authors.first().map(String::as_str)))
        .bind(&c.id)
        .bind(c.version)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if let Some(x) = crate::search::extract(bytes)
        && let Err(e) = crate::search::index(&ws.db, &c.id, &x).await
    {
        tracing::warn!(canvas = %c.id, error = %e, "search index failed");
    }
    Ok(v)
}

/// Version thinning (docs/40 §4.8): every save for `all_hours`, then the newest per hour for
/// `hourly_days`, then the newest per day for `daily_days`, then none. Named and restore
/// versions, checkpoints and the current version are kept forever. Returns the versions to drop.
pub fn thin(
    versions: &[(i64, i64, String, bool)],
    current: i64,
    now: i64,
    h: &crate::settings::History,
) -> Vec<i64> {
    const HOUR: i64 = 3_600_000;
    const DAY: i64 = 24 * HOUR;
    let mut keep_bucket: HashMap<(u8, i64), i64> = HashMap::new();
    let mut drop = Vec::new();
    // Newest first, so the first version seen in a bucket is the one kept.
    let mut sorted: Vec<_> = versions.to_vec();
    sorted.sort_by_key(|a| std::cmp::Reverse((a.1, a.0)));
    for (v, at, kind, checkpoint) in sorted {
        let age = now - at;
        if v == current || kind != "auto" || checkpoint || age < h.all_hours * HOUR {
            continue;
        }
        let bucket = if age < h.all_hours * HOUR + h.hourly_days * DAY {
            Some((1u8, at / HOUR))
        } else if age < h.all_hours * HOUR + h.hourly_days * DAY + h.daily_days * DAY {
            Some((2u8, at / DAY))
        } else {
            None
        };
        match bucket {
            Some(b) if !keep_bucket.contains_key(&b) => {
                keep_bucket.insert(b, v);
            }
            _ => drop.push(v),
        }
    }
    drop.sort();
    drop
}

pub async fn thin_canvas(ws: &Ws, canvas: &str, current: i64) -> anyhow::Result<usize> {
    let (settings, _) = crate::settings::Settings::load(&ws.db, &ws.cfg).await?;
    let rows =
        sqlx::query("SELECT version, at, kind, checkpoint FROM versions WHERE canvas_id = ?")
            .bind(canvas)
            .fetch_all(&ws.db.pool)
            .await?;
    let mut list = Vec::with_capacity(rows.len());
    for r in rows {
        list.push((
            r.try_get::<i64, _>(0)?,
            r.try_get::<i64, _>(1)?,
            r.try_get::<String, _>(2)?,
            r.try_get::<i64, _>(3)? != 0,
        ));
    }
    let drop = thin(&list, current, now_ms(), &settings.history);
    for v in &drop {
        ws.files.delete_version(canvas, *v).await?;
        sqlx::query("DELETE FROM versions WHERE canvas_id = ? AND version = ?")
            .bind(canvas)
            .bind(v)
            .execute(&ws.db.pool)
            .await?;
    }
    Ok(drop.len())
}

/// After a change to the access tables: tell the engine about every (canvas, person) whose
/// role changed (docs/05 §7), so open sessions switch or close at once (acceptance §6.4).
pub async fn propagate(
    ws: &Ws,
    before: Arc<Snapshot>,
    canvases: &[String],
) -> anyhow::Result<usize> {
    ws.acl.invalidate();
    let after = ws.acl.get(&ws.db).await?;
    let mut calls = Vec::new();
    for c in canvases {
        let users: BTreeSet<&String> = before.users.keys().chain(after.users.keys()).collect();
        let mut changed = false;
        for u in users {
            let a = before.can_open(u, c).map(Role::engine);
            let b = after.can_open(u, c).map(Role::engine);
            if a != b {
                changed = true;
                if a.is_some() {
                    calls.push((c.clone(), u.clone(), b.unwrap_or("none")));
                }
            }
        }
        if changed {
            ws.engine.invalidate_members(c).await;
        }
    }
    let n = calls.len();
    let engine = ws.engine.clone();
    futures::future::join_all(calls.iter().map(|(c, u, r)| engine.set_role(c, u, r))).await;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinning_keeps_recent_named_and_one_per_bucket() {
        let h = crate::settings::History::default();
        const H: i64 = 3_600_000;
        let now = 1000 * 24 * H;
        let mut v = vec![];
        // Five autosaves an hour apart, 30 to 26 hours ago, two in the same hour 50 hours ago.
        for (i, age) in [30, 29, 28, 27, 26].iter().enumerate() {
            v.push((i as i64 + 1, now - age * H, "auto".to_string(), false));
        }
        v.push((6, now - 50 * H + 600_000, "auto".into(), false));
        v.push((7, now - 50 * H + 1_200_000, "auto".into(), false));
        // A named version and a checkpoint 200 days ago, an autosave 200 days ago.
        v.push((8, now - 200 * 24 * H, "named".into(), false));
        v.push((9, now - 200 * 24 * H, "auto".into(), true));
        v.push((10, now - 200 * 24 * H, "auto".into(), false));
        // Recent saves.
        v.push((11, now - H / 2, "auto".into(), false));
        v.push((12, now - H / 4, "auto".into(), false));
        let dropped = thin(&v, 12, now, &h);
        assert_eq!(
            dropped,
            vec![6, 10],
            "one per hour bucket after 24 h; nothing unnamed after 97 days"
        );
    }
}
