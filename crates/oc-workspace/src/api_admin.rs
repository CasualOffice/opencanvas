// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Admin (WS-19 back end, docs/40 §4.9): members, teams and settings.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;

use crate::Ws;
use crate::access::Instance;
use crate::auth::Admin;
use crate::settings::Settings;
use crate::util::{ApiError, ApiResult, clean_name, id, now_ms};

pub fn router() -> Router<Ws> {
    Router::new()
        .route("/admin/settings", get(get_settings).put(put_settings))
        .route("/admin/users", get(users))
        .route("/admin/users/{id}", axum::routing::patch(update_user))
        .route("/admin/users/{id}/reset-link", post(reset_link))
        .route("/admin/teams", get(teams).post(create_team))
        .route(
            "/admin/teams/{id}",
            axum::routing::patch(rename_team).delete(delete_team),
        )
        .route(
            "/admin/teams/{id}/members/{user}",
            put(add_team_member).delete(remove_team_member),
        )
        .route("/admin/about", get(about))
        .route("/admin/checklist", get(checklist))
        .route("/admin/checklist/dismiss", post(dismiss_checklist))
        .route("/admin/backups", get(list_backups).post(backup_now))
        .route("/branding", get(branding))
}

async fn get_settings(State(ws): State<Ws>, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let (mut s, locked) = Settings::load(&ws.db, &ws.cfg).await?;
    s.smtp.has_password = !s.smtp.password.is_empty();
    s.smtp.password = String::new();
    Ok(Json(json!({"settings": s, "locked": locked})))
}

async fn put_settings(
    State(ws): State<Ws>,
    Admin(_): Admin,
    Json(new): Json<Settings>,
) -> ApiResult<Json<Value>> {
    let (cur, locked) = Settings::load(&ws.db, &ws.cfg).await?;
    let mut s = new;
    // Operator-fixed values cannot be changed here.
    if locked.public_url {
        s.public_url = cur.public_url.clone();
    }
    if locked.public_links_allowed {
        s.public_links.allowed = cur.public_links.allowed;
    }
    if locked.public_links_max_role {
        s.public_links.max_role = cur.public_links.max_role.clone();
    }
    s.public_url = s.public_url.trim().trim_end_matches('/').to_string();
    // The SMTP password is write-only: an empty one keeps what is stored.
    if s.smtp.password.is_empty() {
        s.smtp.password = cur.smtp.password.clone();
    }
    s.smtp.has_password = false;
    s.smtp.host = s.smtp.host.trim().to_string();
    s.sign_in_message = clean_name(&s.sign_in_message, 280);
    s.org_name = clean_name(&s.org_name, 80);
    s.signup_domains = s
        .signup_domains
        .iter()
        .map(|d| d.trim().to_lowercase())
        .filter(|d| d.contains('.'))
        .take(50)
        .collect();
    s.validate().map_err(|m| ApiError::bad("SETTINGS", m))?;
    s.save(&ws.db).await?;
    if !locked.public_url {
        ws.db.set_meta("public_url", &s.public_url).await?;
    }
    if cur.public_links.allowed && !s.public_links.allowed {
        // Public links turned off: every open visitor session ends.
        let ids: Vec<String> =
            sqlx::query_scalar("SELECT id FROM canvases WHERE link_access = 'public'")
                .fetch_all(&ws.db.pool)
                .await?;
        for c in ids {
            ws.engine.close_sessions(&c).await;
        }
    }
    Ok(Json(json!({"ok": true})))
}

async fn users(State(ws): State<Ws>, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let rows = sqlx::query("SELECT id, name, email, role, status, last_active_at, password_hash IS NOT NULL, created_at FROM users ORDER BY name")
        .fetch_all(&ws.db.pool)
        .await?;
    let tm = sqlx::query(
        "SELECT tm.user_id, t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id",
    )
    .fetch_all(&ws.db.pool)
    .await?;
    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            let uid: String = r.try_get(0).unwrap_or_default();
            let teams: Vec<String> = tm.iter().filter(|t| t.try_get::<String, _>(0).ok().as_deref() == Some(uid.as_str())).filter_map(|t| t.try_get(1).ok()).collect();
            json!({
                "id": uid, "name": r.try_get::<String, _>(1).ok(), "email": r.try_get::<String, _>(2).ok(),
                "role": r.try_get::<String, _>(3).ok(), "status": r.try_get::<String, _>(4).ok(),
                "lastActiveAt": r.try_get::<Option<i64>, _>(5).ok().flatten(),
                "signIn": if r.try_get::<bool, _>(6).unwrap_or(false) || r.try_get::<i64, _>(6).unwrap_or(0) != 0 { "Password" } else { "None" },
                "teams": teams, "createdAt": r.try_get::<i64, _>(7).ok(),
            })
        })
        .collect();
    Ok(Json(json!({"users": list})))
}

#[derive(Deserialize)]
struct UserPatch {
    role: Option<String>,
    status: Option<String>,
}

async fn update_user(
    State(ws): State<Ws>,
    Admin(me): Admin,
    Path(uid): Path<String>,
    Json(b): Json<UserPatch>,
) -> ApiResult<Json<Value>> {
    let cur: String = sqlx::query_scalar("SELECT role FROM users WHERE id = ?")
        .bind(&uid)
        .fetch_optional(&ws.db.pool)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let owners: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE role = 'owner' AND status = 'active'")
            .fetch_one(&ws.db.pool)
            .await?;
    let before = ws.acl.get(&ws.db).await?;
    if let Some(r) = &b.role {
        let r = Instance::parse(r)
            .ok_or_else(|| ApiError::bad("ROLE", "Roles are owner, admin, member or guest."))?;
        if (r == Instance::Owner || cur == "owner") && me.role != Instance::Owner {
            return Err(ApiError::forbidden(
                "Only an Owner changes who is an Owner.",
            ));
        }
        if cur == "owner" && r != Instance::Owner && owners <= 1 {
            return Err(ApiError::bad(
                "LAST_OWNER",
                "There must always be at least one Owner.",
            ));
        }
        sqlx::query("UPDATE users SET role = ? WHERE id = ?")
            .bind(r.as_str())
            .bind(&uid)
            .execute(&ws.db.pool)
            .await?;
    }
    if let Some(st) = &b.status {
        if !matches!(st.as_str(), "active" | "suspended") {
            return Err(ApiError::bad("STATUS", "Status is active or suspended."));
        }
        if st == "suspended" {
            if uid == me.id {
                return Err(ApiError::bad("SELF", "You can't suspend yourself."));
            }
            if cur == "owner" && owners <= 1 {
                return Err(ApiError::bad(
                    "LAST_OWNER",
                    "The last Owner can't be suspended.",
                ));
            }
            // Signed out everywhere at once; their canvases stay.
            sqlx::query("DELETE FROM sessions WHERE user_id = ?")
                .bind(&uid)
                .execute(&ws.db.pool)
                .await?;
        }
        sqlx::query("UPDATE users SET status = ? WHERE id = ?")
            .bind(st)
            .bind(&uid)
            .execute(&ws.db.pool)
            .await?;
    }
    // Open editor sessions follow the new role (or close on suspension).
    let affected: Vec<String> = before
        .canvases
        .keys()
        .filter(|c| before.can_open(&uid, c).is_some())
        .cloned()
        .collect();
    crate::model::propagate(&ws, before, &affected).await?;
    Ok(Json(json!({"ok": true})))
}

async fn reset_link(
    State(ws): State<Ws>,
    Admin(me): Admin,
    Path(uid): Path<String>,
) -> ApiResult<Json<Value>> {
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = ?")
        .bind(&uid)
        .fetch_one(&ws.db.pool)
        .await?;
    if exists == 0 {
        return Err(ApiError::not_found());
    }
    let url = crate::api::make_reset_link(&ws, &uid, Some(&me.id)).await?;
    Ok(Json(json!({"url": url, "expiresInHours": 24})))
}

async fn teams(State(ws): State<Ws>, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let rows = sqlx::query("SELECT t.id, t.name, COUNT(tm.user_id) FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id GROUP BY t.id, t.name ORDER BY t.name")
        .fetch_all(&ws.db.pool)
        .await?;
    let members = sqlx::query("SELECT tm.team_id, u.id, u.name FROM team_members tm JOIN users u ON u.id = tm.user_id ORDER BY u.name").fetch_all(&ws.db.pool).await?;
    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            let tid: String = r.try_get(0).unwrap_or_default();
            let m: Vec<Value> = members
                .iter()
                .filter(|x| x.try_get::<String, _>(0).ok().as_deref() == Some(tid.as_str()))
                .map(|x| json!({"id": x.try_get::<String, _>(1).ok(), "name": x.try_get::<String, _>(2).ok()}))
                .collect();
            json!({"id": tid, "name": r.try_get::<String, _>(1).ok(), "count": r.try_get::<i64, _>(2).ok(), "members": m})
        })
        .collect();
    Ok(Json(json!({"teams": list})))
}

#[derive(Deserialize)]
struct TeamBody {
    name: String,
}

async fn create_team(
    State(ws): State<Ws>,
    Admin(_): Admin,
    Json(b): Json<TeamBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = clean_name(&b.name, 80);
    if name.is_empty() {
        return Err(ApiError::bad("NAME", "Give the team a name."));
    }
    let tid = id("t_");
    sqlx::query("INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)")
        .bind(&tid)
        .bind(&name)
        .bind(now_ms())
        .execute(&ws.db.pool)
        .await?;
    Ok((StatusCode::CREATED, Json(json!({"id": tid}))))
}

async fn rename_team(
    State(ws): State<Ws>,
    Admin(_): Admin,
    Path(tid): Path<String>,
    Json(b): Json<TeamBody>,
) -> ApiResult<Json<Value>> {
    let name = clean_name(&b.name, 80);
    if name.is_empty() {
        return Err(ApiError::bad("NAME", "Give the team a name."));
    }
    sqlx::query("UPDATE teams SET name = ? WHERE id = ?")
        .bind(name)
        .bind(&tid)
        .execute(&ws.db.pool)
        .await?;
    Ok(Json(json!({"ok": true})))
}

async fn team_change(
    ws: &Ws,
    f: impl std::future::Future<Output = Result<(), sqlx::Error>>,
) -> ApiResult<()> {
    let before = ws.acl.get(&ws.db).await?;
    f.await?;
    let all: Vec<String> = before.canvases.keys().cloned().collect();
    crate::model::propagate(ws, before, &all).await?;
    Ok(())
}

async fn delete_team(
    State(ws): State<Ws>,
    Admin(_): Admin,
    Path(tid): Path<String>,
) -> ApiResult<StatusCode> {
    let pool = ws.db.pool.clone();
    team_change(&ws, async move {
        sqlx::query("DELETE FROM team_members WHERE team_id = ?")
            .bind(&tid)
            .execute(&pool)
            .await?;
        sqlx::query("DELETE FROM shares WHERE principal_kind = 'team' AND principal_id = ?")
            .bind(&tid)
            .execute(&pool)
            .await?;
        sqlx::query(
            "DELETE FROM workspace_members WHERE principal_kind = 'team' AND principal_id = ?",
        )
        .bind(&tid)
        .execute(&pool)
        .await?;
        sqlx::query("DELETE FROM teams WHERE id = ?")
            .bind(&tid)
            .execute(&pool)
            .await?;
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn add_team_member(
    State(ws): State<Ws>,
    Admin(_): Admin,
    Path((tid, uid)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let ok: i64 = sqlx::query_scalar("SELECT (SELECT COUNT(*) FROM teams WHERE id = ?) + (SELECT COUNT(*) FROM users WHERE id = ?)").bind(&tid).bind(&uid).fetch_one(&ws.db.pool).await?;
    if ok != 2 {
        return Err(ApiError::not_found());
    }
    let pool = ws.db.pool.clone();
    let sql = format!(
        "{} INTO team_members (team_id, user_id) VALUES (?, ?)",
        ws.db.insert_ignore()
    );
    team_change(&ws, async move {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(&tid)
            .bind(&uid)
            .execute(&pool)
            .await?;
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_team_member(
    State(ws): State<Ws>,
    Admin(_): Admin,
    Path((tid, uid)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let pool = ws.db.pool.clone();
    team_change(&ws, async move {
        sqlx::query("DELETE FROM team_members WHERE team_id = ? AND user_id = ?")
            .bind(&tid)
            .bind(&uid)
            .execute(&pool)
            .await?;
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn about(State(ws): State<Ws>, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let canvases: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM canvases WHERE deleted_at IS NULL")
            .fetch_one(&ws.db.pool)
            .await?;
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&ws.db.pool)
        .await?;
    let bytes: Option<i64> = sqlx::query_scalar("SELECT SUM(size) FROM versions")
        .fetch_one(&ws.db.pool)
        .await
        .unwrap_or(None);
    Ok(Json(json!({
        "version": env!("CARGO_PKG_VERSION"), "engineVersion": env!("CARGO_PKG_VERSION"), "license": "Apache-2.0",
        "database": if ws.db.sqlite { "SQLite" } else { "MySQL / MariaDB" }, "storage": "Local disk",
        "canvases": canvases, "users": users, "versionBytes": bytes.unwrap_or(0),
    })))
}

/// The sign-in page's branding (public: shown before anyone signs in).
async fn branding(State(ws): State<Ws>) -> ApiResult<Json<Value>> {
    let (s, _) = Settings::load(&ws.db, &ws.cfg).await?;
    Ok(Json(
        json!({"orgName": s.org_name, "accent": s.accent, "signInMessage": s.sign_in_message}),
    ))
}

/// The Home setup checklist (prototype 1c, 3a): what an admin still has to do.
async fn checklist(State(ws): State<Ws>, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let (s, _) = Settings::load(&ws.db, &ws.cfg).await?;
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&ws.db.pool)
        .await?;
    let invites: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tokens WHERE purpose = 'invite'")
        .fetch_one(&ws.db.pool)
        .await?;
    let rules = ws.db.meta("checklist_signin").await?.is_some()
        || s.public_links.allowed
        || !s.signup_domains.is_empty();
    Ok(Json(json!({
        "account": true,
        "invite": users > 1 || invites > 0,
        "signIn": rules,
        "email": s.smtp.enabled,
        "backup": !backup_dirs(&ws).is_empty(),
        "dismissed": ws.db.meta("checklist_dismissed").await?.is_some(),
    })))
}

async fn dismiss_checklist(State(ws): State<Ws>, Admin(_): Admin) -> ApiResult<StatusCode> {
    ws.db.set_meta("checklist_dismissed", "1").await?;
    Ok(StatusCode::NO_CONTENT)
}

fn dir_bytes(p: &std::path::Path) -> u64 {
    std::fs::read_dir(p)
        .map(|it| {
            it.flatten()
                .map(|e| match e.file_type() {
                    Ok(t) if t.is_dir() => dir_bytes(&e.path()),
                    Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
                    Err(_) => 0,
                })
                .sum()
        })
        .unwrap_or(0)
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let t = e.file_type()?;
        if t.is_dir() {
            copy_dir(&e.path(), &to.join(e.file_name()))?;
        } else if t.is_file() && !e.file_name().to_string_lossy().contains(".tmp-") {
            std::fs::copy(e.path(), to.join(e.file_name()))?;
        }
    }
    Ok(())
}

/// Backups in `<data>/backups`, newest first: (name, bytes).
fn backup_dirs(ws: &Ws) -> Vec<(String, u64)> {
    let root = ws.cfg.data_dir.join("backups");
    let mut v: Vec<(String, u64)> = std::fs::read_dir(&root)
        .map(|it| {
            it.flatten()
                .filter(|e| e.path().join("manifest.json").exists())
                .map(|e| {
                    (
                        e.file_name().to_string_lossy().into_owned(),
                        dir_bytes(&e.path()),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v
}

async fn list_backups(State(ws): State<Ws>, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let list: Vec<Value> = backup_dirs(&ws)
        .into_iter()
        .map(|(n, b)| json!({"name": n, "bytes": b}))
        .collect();
    Ok(Json(
        json!({"backups": list, "dir": ws.cfg.data_dir.join("backups").display().to_string()}),
    ))
}

/// "Back up now" (WS-20, first step): a consistent copy of the database (SQLite `VACUUM INTO`)
/// and every file, in `<data>/backups/<time>`. The generated secrets are not copied (WS-20 adds
/// them encrypted with a passphrase); MySQL deployments use their database's own dumps.
async fn backup_now(State(ws): State<Ws>, Admin(me): Admin) -> ApiResult<Json<Value>> {
    if !ws.db.sqlite {
        return Err(ApiError::new(
            StatusCode::NOT_IMPLEMENTED,
            "MYSQL",
            "With MySQL or MariaDB, back up the database with its own tools (mysqldump) and the data volume's files/ folder.",
        ));
    }
    let now = now_ms();
    let name = format!(
        "{}-{}",
        crate::util::rfc3339(now)
            .replace([':', '-'], "")
            .replace('T', "-")
            .trim_end_matches('Z'),
        crate::util::token(3)
    );
    let dir = ws.cfg.data_dir.join("backups").join(&name);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(anyhow::Error::from)?;
    let db_path = dir.join("workspace.db");
    let quoted = db_path.display().to_string().replace('\'', "''");
    sqlx::query(sqlx::AssertSqlSafe(format!("VACUUM INTO '{quoted}'")))
        .execute(&ws.db.pool)
        .await?;
    let (files, to) = (ws.cfg.files_dir(), dir.join("files"));
    tokio::task::spawn_blocking(move || {
        if files.exists() {
            copy_dir(&files, &to)
        } else {
            Ok(())
        }
    })
    .await
    .map_err(anyhow::Error::from)?
    .map_err(anyhow::Error::from)?;
    let manifest = json!({"format": "opencanvas-workspace-backup", "version": env!("CARGO_PKG_VERSION"), "createdAt": now, "by": me.id, "database": "sqlite", "secrets": false});
    tokio::fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(anyhow::Error::from)?,
    )
    .await
    .map_err(anyhow::Error::from)?;
    let bytes = dir_bytes(&dir);
    tracing::info!(backup = %name, bytes, "backup written");
    Ok(Json(
        json!({"name": name, "bytes": bytes, "secretsIncluded": false}),
    ))
}
