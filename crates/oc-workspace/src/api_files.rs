// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Workspaces, folders, files, sharing, links, search, trash and history (WS-10, WS-13, WS-14,
//! WS-15, FTY-08). Anything the person may not open answers 404, never 403, so titles don't leak.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;

use crate::Ws;
use crate::access::{Instance, Principal, Role, Snapshot};
use crate::auth::Me;
use crate::model::{self, CANVAS_COLS, Canvas, FILE_TYPES, canvas_from};
use crate::util::{ApiError, ApiResult, clean_name, id, now_ms};

pub fn router() -> Router<Ws> {
    Router::new()
        .route("/home", get(home))
        .route("/people", get(people))
        .route("/workspaces", post(create_workspace))
        .route("/workspaces/{id}", axum::routing::patch(update_workspace))
        .route("/workspaces/{id}/join", post(join_workspace))
        .route(
            "/workspaces/{id}/members",
            get(workspace_members).put(set_workspace_member),
        )
        .route("/folders", post(create_folder))
        .route(
            "/folders/{id}",
            axum::routing::patch(update_folder).delete(trash_folder),
        )
        .route(
            "/folders/{id}/shares",
            get(folder_shares).put(set_folder_share),
        )
        .route("/canvases", get(list_canvases).post(create_canvas))
        .route(
            "/canvases/{id}",
            get(get_canvas).patch(update_canvas).delete(trash_canvas),
        )
        .route("/canvases/{id}/duplicate", post(duplicate))
        .route("/canvases/{id}/star", put(star).delete(unstar))
        .route("/canvases/{id}/launch", post(launch))
        .route(
            "/canvases/{id}/shares",
            get(canvas_shares).put(set_canvas_share),
        )
        .route("/canvases/{id}/link", put(set_link))
        .route("/canvases/{id}/versions", get(versions))
        .route("/links/{token}", get(link_info))
        .route("/links/{token}/open", post(link_open))
        .route("/search", get(search))
        .route("/trash", get(trash))
        .route("/trash/{kind}/{id}/restore", post(restore))
        .route("/trash/{kind}/{id}", delete(purge_now))
        .route("/notifications", get(notifications))
        .route("/notifications/read", post(read_notifications))
}

async fn snap(ws: &Ws) -> ApiResult<Arc<Snapshot>> {
    Ok(ws.acl.get(&ws.db).await?)
}

/// The canvas if `me` may open it with at least `need`; 404 otherwise.
async fn canvas_for(ws: &Ws, me: &Me, cid: &str, need: Role) -> ApiResult<(Canvas, Role)> {
    let s = snap(ws).await?;
    let role = s.can_open(&me.id, cid).ok_or_else(ApiError::not_found)?;
    let c = model::canvas(ws, cid)
        .await?
        .ok_or_else(ApiError::not_found)?;
    if role < need {
        return Err(ApiError::forbidden(match need {
            Role::Full => "You need full access to do that.",
            Role::Edit => "You can't edit this.",
            _ => "You can't do that here.",
        }));
    }
    Ok((c, role))
}

async fn names(ws: &Ws, ids: &HashSet<String>) -> ApiResult<HashMap<String, String>> {
    let mut out = HashMap::new();
    let ids: Vec<&String> = ids.iter().collect();
    for chunk in ids.chunks(200) {
        let sql = format!(
            "SELECT id, name FROM users WHERE id IN ({})",
            vec!["?"; chunk.len()].join(",")
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for i in chunk {
            q = q.bind(*i);
        }
        for r in q.fetch_all(&ws.db.pool).await? {
            out.insert(r.try_get(0)?, r.try_get(1)?);
        }
    }
    Ok(out)
}

/// Cards for a list of canvases (already access-checked).
async fn cards(ws: &Ws, me: &Me, s: &Snapshot, list: Vec<Canvas>) -> ApiResult<Vec<Value>> {
    let stars: HashSet<String> =
        sqlx::query_scalar::<_, String>("SELECT canvas_id FROM favourites WHERE user_id = ?")
            .bind(&me.id)
            .fetch_all(&ws.db.pool)
            .await?
            .into_iter()
            .collect();
    let who: HashSet<String> = list
        .iter()
        .filter_map(|c| c.updated_by.clone().or(Some(c.created_by.clone())))
        .collect();
    let nm = names(ws, &who).await?;
    let wsn: HashMap<String, String> = sqlx::query("SELECT id, name FROM workspaces")
        .fetch_all(&ws.db.pool)
        .await?
        .iter()
        .filter_map(|r| Some((r.try_get(0).ok()?, r.try_get(1).ok()?)))
        .collect();
    let fon: HashMap<String, String> = sqlx::query("SELECT id, name FROM folders")
        .fetch_all(&ws.db.pool)
        .await?
        .iter()
        .filter_map(|r| Some((r.try_get(0).ok()?, r.try_get(1).ok()?)))
        .collect();
    Ok(list
        .into_iter()
        .map(|c| {
            let by = c.updated_by.clone().unwrap_or(c.created_by.clone());
            json!({
                "id": c.id, "name": c.name, "type": c.ftype,
                "workspaceId": c.workspace_id, "workspace": wsn.get(&c.workspace_id),
                "folderId": c.folder_id, "folder": c.folder_id.as_ref().and_then(|f| fon.get(f)),
                "updatedAt": c.updated_at, "updatedBy": nm.get(&by), "size": c.size, "version": c.version,
                "star": stars.contains(&c.id), "role": s.can_open(&me.id, &c.id).map(Role::as_str),
                "isTemplate": c.is_template, "deletedAt": c.deleted_at,
            })
        })
        .collect())
}

async fn all_canvases(ws: &Ws, where_: &str, binds: &[&str]) -> ApiResult<Vec<Canvas>> {
    let sql = format!(
        "SELECT {CANVAS_COLS} FROM canvases WHERE {where_} ORDER BY updated_at DESC LIMIT 2000"
    );
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for b in binds {
        q = q.bind(*b);
    }
    Ok(q.fetch_all(&ws.db.pool)
        .await?
        .iter()
        .map(canvas_from)
        .collect::<Result<_, _>>()?)
}

async fn home(State(ws): State<Ws>, me: Me) -> ApiResult<Json<Value>> {
    let s = snap(&ws).await?;
    let rows = sqlx::query("SELECT id, name, icon, color, visibility, personal_owner, description FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at")
        .fetch_all(&ws.db.pool)
        .await?;
    let folders = sqlx::query("SELECT id, workspace_id, parent_id, name FROM folders WHERE deleted_at IS NULL ORDER BY name")
        .fetch_all(&ws.db.pool)
        .await?;
    let mut list = Vec::new();
    for r in rows {
        let wid: String = r.try_get(0)?;
        let personal: Option<String> = r.try_get(5)?;
        if personal.as_ref().is_some_and(|p| p != &me.id) {
            continue;
        }
        let role = s.workspace_role(&me.id, &wid);
        let open = r.try_get::<String, _>(4)? == "open";
        // Members see open workspaces they can join; guests only what they belong to.
        let visible_folders: Vec<Value> = folders
            .iter()
            .filter(|f| f.try_get::<String, _>(1).ok().as_deref() == Some(wid.as_str()))
            .filter(|f| role.is_some() || s.folder_role(&me.id, &f.try_get::<String, _>(0).unwrap_or_default()).is_some())
            .map(|f| json!({"id": f.try_get::<String, _>(0).ok(), "parentId": f.try_get::<Option<String>, _>(2).ok().flatten(), "name": f.try_get::<String, _>(3).ok()}))
            .collect();
        let has_shared = s
            .canvases
            .iter()
            .any(|(cid, c)| c.workspace == wid && s.can_open(&me.id, cid).is_some());
        if role.is_none() && !(open && me.role != Instance::Guest) && !has_shared {
            continue;
        }
        list.push(json!({
            "id": wid, "name": r.try_get::<String, _>(1).ok(), "icon": r.try_get::<String, _>(2).ok(),
            "color": r.try_get::<String, _>(3).ok(), "visibility": if open { "open" } else { "private" },
            "personal": personal.is_some(), "description": r.try_get::<String, _>(6).ok(),
            "role": role.map(Role::workspace_role), "member": role.is_some(), "folders": visible_folders,
        }));
    }
    let recent_ids: Vec<String> = sqlx::query_scalar(
        "SELECT canvas_id FROM recents WHERE user_id = ? ORDER BY opened_at DESC LIMIT 12",
    )
    .bind(&me.id)
    .fetch_all(&ws.db.pool)
    .await?;
    let mut recent = Vec::new();
    for cid in recent_ids {
        if s.can_open(&me.id, &cid).is_some()
            && let Some(c) = model::canvas(&ws, &cid).await?
        {
            recent.push(c);
        }
    }
    let recent = cards(&ws, &me, &s, recent).await?;
    let fav_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM favourites WHERE user_id = ?")
        .bind(&me.id)
        .fetch_one(&ws.db.pool)
        .await?;
    Ok(Json(
        json!({"workspaces": list, "recent": recent, "favourites": fav_count}),
    ))
}

#[derive(Deserialize)]
struct ListQ {
    workspace: Option<String>,
    folder: Option<String>,
    view: Option<String>,
    #[serde(rename = "type")]
    ftype: Option<String>,
}

async fn list_canvases(
    State(ws): State<Ws>,
    me: Me,
    Query(q): Query<ListQ>,
) -> ApiResult<Json<Value>> {
    let s = snap(&ws).await?;
    let mut list: Vec<Canvas> = match q.view.as_deref() {
        Some("favourites") => {
            let ids: Vec<String> = sqlx::query_scalar(
                "SELECT canvas_id FROM favourites WHERE user_id = ? ORDER BY created_at",
            )
            .bind(&me.id)
            .fetch_all(&ws.db.pool)
            .await?;
            let mut v = Vec::new();
            for i in ids {
                if let Some(c) = model::canvas(&ws, &i).await? {
                    v.push(c);
                }
            }
            v
        }
        Some("recent") => all_canvases(&ws, "deleted_at IS NULL", &[])
            .await?
            .into_iter()
            .take(500)
            .collect(),
        Some("shared") => all_canvases(&ws, "deleted_at IS NULL", &[])
            .await?
            .into_iter()
            .filter(|c| {
                // Shared with me: a direct or team share, not my own workspaces.
                s.workspace_role(&me.id, &c.workspace_id).is_none() && c.created_by != me.id
            })
            .collect(),
        _ => match (&q.folder, &q.workspace) {
            (Some(f), _) => all_canvases(&ws, "deleted_at IS NULL AND folder_id = ?", &[f]).await?,
            (None, Some(w)) => {
                all_canvases(
                    &ws,
                    "deleted_at IS NULL AND workspace_id = ? AND folder_id IS NULL",
                    &[w],
                )
                .await?
            }
            _ => all_canvases(&ws, "deleted_at IS NULL", &[]).await?,
        },
    };
    list.retain(|c| c.deleted_at.is_none() && s.can_open(&me.id, &c.id).is_some());
    if let Some(t) = &q.ftype {
        list.retain(|c| &c.ftype == t);
    }
    list.truncate(500);
    Ok(Json(json!({"canvases": cards(&ws, &me, &s, list).await?})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCanvas {
    name: Option<String>,
    #[serde(rename = "type")]
    ftype: Option<String>,
    workspace_id: String,
    folder_id: Option<String>,
    template_id: Option<String>,
}

/// May `me` create things in this workspace or folder?
fn can_create_in(s: &Snapshot, me: &str, ws_id: &str, folder: Option<&str>) -> bool {
    let r = match folder {
        Some(f) => s.folder_role(me, f),
        None => s.workspace_role(me, ws_id),
    };
    r.is_some_and(|r| r >= Role::Edit)
}

async fn create_canvas(
    State(ws): State<Ws>,
    me: Me,
    Json(b): Json<CreateCanvas>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let s = snap(&ws).await?;
    if let Some(f) = &b.folder_id
        && s.folders
            .get(f)
            .is_none_or(|x| x.workspace != b.workspace_id || x.deleted)
    {
        return Err(ApiError::not_found());
    }
    if !can_create_in(&s, &me.id, &b.workspace_id, b.folder_id.as_deref()) {
        return Err(ApiError::forbidden("You can't create files here."));
    }
    let mut ftype = b.ftype.unwrap_or_else(|| "document".into());
    let mut bytes = None;
    if let Some(t) = &b.template_id {
        let tc = model::canvas(&ws, t)
            .await?
            .filter(|c| c.is_template && c.deleted_at.is_none())
            .ok_or_else(ApiError::not_found)?;
        ftype = tc.ftype.clone();
        if tc.version > 0 {
            bytes = ws.files.get_version(&tc.id, tc.version).await?;
        }
    }
    if !FILE_TYPES.contains(&ftype.as_str()) {
        return Err(ApiError::bad(
            "TYPE",
            "Files are documents, spreadsheets, whiteboards or databases.",
        ));
    }
    let default_name = match ftype.as_str() {
        "spreadsheet" => "Untitled spreadsheet",
        "whiteboard" => "Untitled whiteboard",
        "database" => "Untitled database",
        _ => "Untitled",
    };
    let name = clean_name(b.name.as_deref().unwrap_or(""), 200);
    let name = if name.is_empty() {
        default_name.to_string()
    } else {
        name
    };
    let cid = id("c_");
    let now = now_ms();
    sqlx::query("INSERT INTO canvases (id, workspace_id, folder_id, name, ftype, created_by, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&cid)
        .bind(&b.workspace_id)
        .bind(b.folder_id.as_deref())
        .bind(&name)
        .bind(&ftype)
        .bind(&me.id)
        .bind(now)
        .bind(now)
        .bind(&me.id)
        .execute(&ws.db.pool)
        .await?;
    // The creator keeps full access even in a workspace where they are only an editor.
    sqlx::query("INSERT INTO shares (object_kind, object_id, principal_kind, principal_id, role) VALUES ('canvas', ?, 'user', ?, 'full')")
        .bind(&cid)
        .bind(&me.id)
        .execute(&ws.db.pool)
        .await?;
    ws.acl.invalidate();
    if let Some(bytes) = bytes {
        let c = model::canvas(&ws, &cid)
            .await?
            .ok_or_else(ApiError::not_found)?;
        model::store_version(
            &ws,
            &c,
            &bytes,
            &model::SaveMeta {
                autosave: false,
                name: Some("Created from a template".into()),
                ..Default::default()
            },
            Some(&me.id),
        )
        .await?;
    }
    Ok((
        StatusCode::CREATED,
        Json(json!({"id": cid, "type": ftype, "name": name})),
    ))
}

async fn get_canvas(
    State(ws): State<Ws>,
    me: Me,
    Path(cid): Path<String>,
) -> ApiResult<Json<Value>> {
    let (c, role) = canvas_for(&ws, &me, &cid, Role::View).await?;
    let s = snap(&ws).await?;
    let loc = model::location(&ws, &c).await?;
    let card = cards(&ws, &me, &s, vec![c])
        .await?
        .pop()
        .unwrap_or_default();
    Ok(Json(
        json!({"canvas": card, "role": role.as_str(), "location": loc}),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCanvas {
    name: Option<String>,
    /// Move: a folder id, or `""` for the workspace's top level.
    folder_id: Option<String>,
    workspace_id: Option<String>,
    is_template: Option<bool>,
}

async fn update_canvas(
    State(ws): State<Ws>,
    me: Me,
    Path(cid): Path<String>,
    Json(b): Json<UpdateCanvas>,
) -> ApiResult<Json<Value>> {
    let need = if b.folder_id.is_some() || b.workspace_id.is_some() {
        Role::Full
    } else {
        Role::Edit
    };
    let (c, _) = canvas_for(&ws, &me, &cid, need).await?;
    if let Some(n) = b.name {
        let n = clean_name(&n, 200);
        if n.is_empty() {
            return Err(ApiError::bad("NAME", "Give it a name."));
        }
        sqlx::query("UPDATE canvases SET name = ? WHERE id = ?")
            .bind(&n)
            .bind(&cid)
            .execute(&ws.db.pool)
            .await?;
    }
    if let Some(t) = b.is_template {
        if !me.role.is_admin() {
            return Err(ApiError::forbidden("Only admins save templates."));
        }
        sqlx::query("UPDATE canvases SET is_template = ? WHERE id = ?")
            .bind(t as i64)
            .bind(&cid)
            .execute(&ws.db.pool)
            .await?;
    }
    if b.folder_id.is_some() || b.workspace_id.is_some() {
        let before = snap(&ws).await?;
        let target_ws = b.workspace_id.clone().unwrap_or(c.workspace_id.clone());
        let folder = b.folder_id.clone().filter(|f| !f.is_empty());
        if let Some(f) = &folder
            && before
                .folders
                .get(f)
                .is_none_or(|x| x.workspace != target_ws || x.deleted)
        {
            return Err(ApiError::not_found());
        }
        if !can_create_in(&before, &me.id, &target_ws, folder.as_deref()) {
            return Err(ApiError::forbidden("You can't move files there."));
        }
        sqlx::query("UPDATE canvases SET workspace_id = ?, folder_id = ? WHERE id = ?")
            .bind(&target_ws)
            .bind(folder.as_deref())
            .bind(&cid)
            .execute(&ws.db.pool)
            .await?;
        model::propagate(&ws, before, std::slice::from_ref(&cid)).await?;
    }
    Ok(Json(json!({"ok": true})))
}

async fn duplicate(
    State(ws): State<Ws>,
    me: Me,
    Path(cid): Path<String>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let (c, _) = canvas_for(&ws, &me, &cid, Role::View).await?;
    let s = snap(&ws).await?;
    let (wsid, folder) = if can_create_in(&s, &me.id, &c.workspace_id, c.folder_id.as_deref()) {
        (c.workspace_id.clone(), c.folder_id.clone())
    } else {
        // No right to create beside it: the copy goes to My canvases.
        let mine: String = sqlx::query_scalar("SELECT id FROM workspaces WHERE personal_owner = ?")
            .bind(&me.id)
            .fetch_optional(&ws.db.pool)
            .await?
            .ok_or_else(|| ApiError::forbidden("You can't create files here."))?;
        (mine, None)
    };
    let nid = id("c_");
    let now = now_ms();
    sqlx::query("INSERT INTO canvases (id, workspace_id, folder_id, name, ftype, seed, created_by, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&nid)
        .bind(&wsid)
        .bind(folder.as_deref())
        .bind(format!("{} (copy)", c.name.chars().take(190).collect::<String>()))
        .bind(&c.ftype)
        .bind(c.seed.as_deref())
        .bind(&me.id)
        .bind(now)
        .bind(now)
        .bind(&me.id)
        .execute(&ws.db.pool)
        .await?;
    sqlx::query("INSERT INTO shares (object_kind, object_id, principal_kind, principal_id, role) VALUES ('canvas', ?, 'user', ?, 'full')")
        .bind(&nid)
        .bind(&me.id)
        .execute(&ws.db.pool)
        .await?;
    ws.acl.invalidate();
    if c.version > 0
        && let Some(bytes) = ws.files.get_version(&c.id, c.version).await?
    {
        let fresh = model::canvas(&ws, &nid)
            .await?
            .ok_or_else(ApiError::not_found)?;
        model::store_version(
            &ws,
            &fresh,
            &bytes,
            &model::SaveMeta {
                autosave: false,
                name: Some(format!("Copied from {}", c.name)),
                ..Default::default()
            },
            Some(&me.id),
        )
        .await?;
    }
    Ok((StatusCode::CREATED, Json(json!({"id": nid}))))
}

async fn star(State(ws): State<Ws>, me: Me, Path(cid): Path<String>) -> ApiResult<StatusCode> {
    canvas_for(&ws, &me, &cid, Role::View).await?;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "{} INTO favourites (user_id, canvas_id, created_at) VALUES (?, ?, ?)",
        ws.db.insert_ignore()
    )))
    .bind(&me.id)
    .bind(&cid)
    .bind(now_ms())
    .execute(&ws.db.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn unstar(State(ws): State<Ws>, me: Me, Path(cid): Path<String>) -> ApiResult<StatusCode> {
    sqlx::query("DELETE FROM favourites WHERE user_id = ? AND canvas_id = ?")
        .bind(&me.id)
        .bind(&cid)
        .execute(&ws.db.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn touch_recent(ws: &Ws, user: &str, cid: &str) -> ApiResult<()> {
    let sql = if ws.db.sqlite {
        "INSERT INTO recents (user_id, canvas_id, opened_at) VALUES (?, ?, ?) ON CONFLICT(user_id, canvas_id) DO UPDATE SET opened_at = excluded.opened_at"
    } else {
        "INSERT INTO recents (user_id, canvas_id, opened_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE opened_at = VALUES(opened_at)"
    };
    sqlx::query(sql)
        .bind(user)
        .bind(cid)
        .bind(now_ms())
        .execute(&ws.db.pool)
        .await?;
    Ok(())
}

/// A launch token for the editor (docs/05 §3, §4 option A): the page posts it to `/v1/launch`.
async fn launch(State(ws): State<Ws>, me: Me, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    let (c, role) = canvas_for(&ws, &me, &cid, Role::View).await?;
    let s = snap(&ws).await?;
    let members = crate::callbacks::people_with_access(&ws, &s, &cid).await?;
    let user = crate::engine::Person {
        id: me.id.clone(),
        name: me.name.clone(),
        detail: (me.role == Instance::Guest).then(|| "Guest".into()),
        color: Some(me.color.clone()),
    };
    let token = crate::engine::launch_token(&crate::engine::Launch {
        host_id: &ws.cfg.host_id,
        secret: &ws.secrets.host_secret,
        token_key: &ws.secrets.token_key,
        file_id: &c.id,
        file_name: &c.name,
        version: c.version,
        ftype: &c.ftype,
        user: &user,
        members: Some(&members),
        role: role.engine(),
        visitor: false,
    })?;
    touch_recent(&ws, &me.id, &cid).await?;
    Ok(Json(
        json!({"token": token, "action": "/v1/launch", "type": c.ftype, "role": role.as_str()}),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareBody {
    principal_kind: String,
    principal_id: String,
    /// full | edit | comment | view, or null to remove.
    role: Option<String>,
}

async fn describe(ws: &Ws, grants: &[(Principal, Role)]) -> ApiResult<Vec<Value>> {
    let mut out = Vec::new();
    for (p, r) in grants {
        let (name, detail) = match p {
            Principal::User(u) => {
                let row = sqlx::query("SELECT name, email, role FROM users WHERE id = ?")
                    .bind(u)
                    .fetch_optional(&ws.db.pool)
                    .await?;
                match row {
                    Some(r) => (
                        r.try_get::<String, _>(0).unwrap_or_default(),
                        r.try_get::<String, _>(1).unwrap_or_default(),
                    ),
                    None => continue,
                }
            }
            Principal::Team(t) => {
                let n: Option<String> = sqlx::query_scalar("SELECT name FROM teams WHERE id = ?")
                    .bind(t)
                    .fetch_optional(&ws.db.pool)
                    .await?;
                let count: i64 =
                    sqlx::query_scalar("SELECT COUNT(*) FROM team_members WHERE team_id = ?")
                        .bind(t)
                        .fetch_one(&ws.db.pool)
                        .await?;
                match n {
                    Some(n) => (n, format!("Team · {count} people")),
                    None => continue,
                }
            }
        };
        out.push(json!({"principalKind": p.kind(), "principalId": p.id(), "name": name, "detail": detail, "role": r.as_str()}));
    }
    Ok(out)
}

async fn canvas_shares(
    State(ws): State<Ws>,
    me: Me,
    Path(cid): Path<String>,
) -> ApiResult<Json<Value>> {
    let (c, role) = canvas_for(&ws, &me, &cid, Role::View).await?;
    let s = snap(&ws).await?;
    let ca = s.canvases.get(&cid).ok_or_else(ApiError::not_found)?;
    let direct = describe(&ws, &ca.shares).await?;
    // Inherited access, with where it comes from (changed only there, docs/40 §4.6).
    let mut inherited = Vec::new();
    if let Some(w) = s.workspaces.get(&c.workspace_id) {
        let wname: String = sqlx::query_scalar("SELECT name FROM workspaces WHERE id = ?")
            .bind(&c.workspace_id)
            .fetch_one(&ws.db.pool)
            .await?;
        for g in describe(&ws, &w.members).await? {
            inherited.push(json!({"from": format!("the {wname} workspace"), "fromKind": "workspace", "fromId": c.workspace_id, "grant": g}));
        }
    }
    let mut cur = c.folder_id.clone();
    for _ in 0..=crate::access::MAX_DEPTH {
        let Some(f) = cur else { break };
        let Some(fa) = s.folders.get(&f) else { break };
        let fname: String = sqlx::query_scalar("SELECT name FROM folders WHERE id = ?")
            .bind(&f)
            .fetch_one(&ws.db.pool)
            .await?;
        for g in describe(&ws, &fa.shares).await? {
            inherited.push(json!({"from": format!("the {fname} folder"), "fromKind": "folder", "fromId": f, "grant": g}));
        }
        cur = fa.parent.clone();
    }
    let (settings, _) = crate::settings::Settings::load(&ws.db, &ws.cfg).await?;
    let base = ws.public_base().await;
    Ok(Json(json!({
        "canEdit": role == Role::Full,
        "direct": direct,
        "inherited": inherited,
        "link": {
            "access": c.link_access, "role": c.link_role, "expiresAt": c.link_expires_at,
            "hasPassword": c.link_password_hash.is_some(),
            "url": match (&c.link_access[..], &c.link_token) {
                ("public", Some(t)) => format!("{base}/ws/l/{t}"),
                _ => format!("{base}/ws/c/{}", c.id),
            },
            "publicAllowed": settings.public_links.allowed,
            "publicMaxRole": settings.public_links.max_role,
            "requirePassword": settings.public_links.require_password,
            "defaultExpiryDays": settings.public_links.default_expiry_days,
        },
    })))
}

async fn principal_exists(ws: &Ws, kind: &str, pid: &str) -> ApiResult<bool> {
    let sql = match kind {
        "user" => "SELECT COUNT(*) FROM users WHERE id = ?",
        "team" => "SELECT COUNT(*) FROM teams WHERE id = ?",
        _ => return Ok(false),
    };
    Ok(sqlx::query_scalar::<_, i64>(sql)
        .bind(pid)
        .fetch_one(&ws.db.pool)
        .await?
        > 0)
}

async fn set_share(
    ws: &Ws,
    object_kind: &str,
    object_id: &str,
    b: &ShareBody,
    affected: Vec<String>,
) -> ApiResult<()> {
    if !principal_exists(ws, &b.principal_kind, &b.principal_id).await? {
        return Err(ApiError::bad("WHO", "No such person or team."));
    }
    let before = snap(ws).await?;
    sqlx::query("DELETE FROM shares WHERE object_kind = ? AND object_id = ? AND principal_kind = ? AND principal_id = ?")
        .bind(object_kind)
        .bind(object_id)
        .bind(&b.principal_kind)
        .bind(&b.principal_id)
        .execute(&ws.db.pool)
        .await?;
    if let Some(r) = &b.role {
        let r = Role::parse(r)
            .ok_or_else(|| ApiError::bad("ROLE", "Roles are full, edit, comment or view."))?;
        sqlx::query("INSERT INTO shares (object_kind, object_id, principal_kind, principal_id, role) VALUES (?, ?, ?, ?, ?)")
            .bind(object_kind)
            .bind(object_id)
            .bind(&b.principal_kind)
            .bind(&b.principal_id)
            .bind(r.as_str())
            .execute(&ws.db.pool)
            .await?;
        if b.principal_kind == "user" {
            let _ = sqlx::query("INSERT INTO notifications (id, user_id, kind, canvas_id, excerpt, at) VALUES (?, ?, 'share', ?, '', ?)")
                .bind(id("n_"))
                .bind(&b.principal_id)
                .bind((object_kind == "canvas").then_some(object_id))
                .bind(now_ms())
                .execute(&ws.db.pool)
                .await;
        }
    }
    model::propagate(ws, before, &affected).await?;
    Ok(())
}

async fn set_canvas_share(
    State(ws): State<Ws>,
    me: Me,
    Path(cid): Path<String>,
    Json(b): Json<ShareBody>,
) -> ApiResult<Json<Value>> {
    canvas_for(&ws, &me, &cid, Role::Full).await?;
    if b.principal_kind == "user" && b.principal_id == me.id && b.role.as_deref() != Some("full") {
        // Nobody locks themselves out by accident; another Full-access person can do it.
        let others = snap(&ws)
            .await?
            .members_of(&cid)
            .into_iter()
            .filter(|(u, r)| u != &me.id && *r == Role::Full)
            .count();
        if others == 0 {
            return Err(ApiError::bad(
                "LAST",
                "Someone else needs full access before you can step down.",
            ));
        }
    }
    set_share(&ws, "canvas", &cid, &b, vec![cid.clone()]).await?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkBody {
    /// none | org | public
    access: String,
    role: Option<String>,
    /// Days until a public link expires; 0 = never; absent = the admin's default.
    expires_days: Option<i64>,
    /// A password for a public link; "" removes it.
    password: Option<String>,
}

async fn set_link(
    State(ws): State<Ws>,
    me: Me,
    Path(cid): Path<String>,
    Json(b): Json<LinkBody>,
) -> ApiResult<Json<Value>> {
    let (c, _) = canvas_for(&ws, &me, &cid, Role::Full).await?;
    let (settings, _) = crate::settings::Settings::load(&ws.db, &ws.cfg).await?;
    let role = Role::parse(b.role.as_deref().unwrap_or(&c.link_role))
        .filter(|r| *r != Role::Full)
        .ok_or_else(|| ApiError::bad("ROLE", "Links give view, comment or edit."))?;
    let before = snap(&ws).await?;
    match b.access.as_str() {
        "none" | "org" => {
            sqlx::query("UPDATE canvases SET link_access = ?, link_role = ?, link_token = NULL, link_expires_at = NULL, link_password_hash = NULL WHERE id = ?")
                .bind(&b.access)
                .bind(role.as_str())
                .bind(&cid)
                .execute(&ws.db.pool)
                .await?;
        }
        "public" => {
            if !settings.public_links.allowed {
                return Err(ApiError::forbidden(
                    "Public links are turned off by an admin.",
                ));
            }
            let cap = Role::parse(&settings.public_links.max_role).unwrap_or(Role::View);
            if role > cap {
                return Err(ApiError::forbidden(format!(
                    "Public links can give at most {} access here.",
                    cap.as_str()
                )));
            }
            let days = b
                .expires_days
                .unwrap_or(settings.public_links.default_expiry_days)
                .clamp(0, 3650);
            let expires = (days > 0).then(|| now_ms() + days * 86_400_000);
            let pw_hash = match b.password.as_deref() {
                Some("") => None,
                Some(p) => {
                    if p.chars().count() < 6 {
                        return Err(ApiError::bad(
                            "PASSWORD",
                            "Link passwords are at least 6 characters.",
                        ));
                    }
                    Some(crate::auth::hash_password(p)?)
                }
                None => c.link_password_hash.clone(),
            };
            if settings.public_links.require_password && pw_hash.is_none() {
                return Err(ApiError::bad(
                    "PASSWORD",
                    "An admin requires a password on public links.",
                ));
            }
            // A new token each time the link is turned on; turning it off kills the old URL.
            let token = c
                .link_token
                .clone()
                .filter(|_| c.link_access == "public")
                .unwrap_or_else(|| crate::util::token(18));
            sqlx::query("UPDATE canvases SET link_access = 'public', link_role = ?, link_token = ?, link_expires_at = ?, link_password_hash = ? WHERE id = ?")
                .bind(role.as_str())
                .bind(&token)
                .bind(expires)
                .bind(pw_hash.as_deref())
                .bind(&cid)
                .execute(&ws.db.pool)
                .await?;
        }
        _ => {
            return Err(ApiError::bad(
                "ACCESS",
                "General access is none, org or public.",
            ));
        }
    }
    model::propagate(&ws, before, std::slice::from_ref(&cid)).await?;
    if c.link_access == "public" && b.access != "public" {
        // Visitors' open sessions end with the link.
        ws.engine.close_sessions(&cid).await;
    }
    Ok(Json(json!({"ok": true})))
}

async fn link_canvas(ws: &Ws, token: &str) -> ApiResult<(Canvas, Role)> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {CANVAS_COLS} FROM canvases WHERE link_token = ?"
    )))
    .bind(token)
    .fetch_optional(&ws.db.pool)
    .await?
    .ok_or_else(ApiError::not_found)?;
    let c = canvas_from(&row)?;
    let role = crate::callbacks::link_role(ws, &c).await.ok_or_else(|| {
        ApiError::new(
            StatusCode::GONE,
            "LINK_OFF",
            "This link is off or has expired.",
        )
    })?;
    Ok((c, role))
}

async fn link_info(State(ws): State<Ws>, Path(token): Path<String>) -> ApiResult<Json<Value>> {
    let (c, role) = link_canvas(&ws, &token).await?;
    let (s, _) = crate::settings::Settings::load(&ws.db, &ws.cfg).await?;
    Ok(Json(
        json!({"name": c.name, "type": c.ftype, "role": role.as_str(), "needsPassword": c.link_password_hash.is_some(), "org": s.org_name}),
    ))
}

#[derive(Deserialize)]
struct OpenLink {
    password: Option<String>,
    name: Option<String>,
}

async fn link_open(
    State(ws): State<Ws>,
    Path(token): Path<String>,
    req: axum::extract::Request,
) -> ApiResult<Json<Value>> {
    let ip = crate::auth::client_ip(req.extensions(), req.headers());
    let bytes = axum::body::to_bytes(req.into_body(), 4096)
        .await
        .map_err(|_| ApiError::bad("BODY", "Body too large"))?;
    let b: OpenLink = serde_json::from_slice(&bytes).unwrap_or(OpenLink {
        password: None,
        name: None,
    });
    if ws.limiter.blocked(ip) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "LOCKED",
            "Too many tries. Wait 15 minutes.",
        ));
    }
    let (c, role) = link_canvas(&ws, &token).await?;
    if let Some(h) = &c.link_password_hash
        && !b
            .password
            .as_deref()
            .is_some_and(|p| crate::auth::verify_password(p, h))
    {
        ws.limiter.fail(ip);
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "PASSWORD",
            "That password is wrong.",
        ));
    }
    // A link visitor: a fresh id per visit, a name they may choose (docs/40 §2).
    let visitor = format!(
        "v_{}",
        crate::util::token(9).replace('-', "x").replace('_', "y")
    );
    let name = clean_name(b.name.as_deref().unwrap_or(""), 40);
    let user = crate::engine::Person {
        id: visitor,
        name: if name.is_empty() {
            "Visitor".into()
        } else {
            name
        },
        detail: Some("Visitor with the link".into()),
        color: None,
    };
    let tok = crate::engine::launch_token(&crate::engine::Launch {
        host_id: &ws.cfg.host_id,
        secret: &ws.secrets.host_secret,
        token_key: &ws.secrets.token_key,
        file_id: &c.id,
        file_name: &c.name,
        version: c.version,
        ftype: &c.ftype,
        user: &user,
        members: None,
        role: role.engine(),
        visitor: true,
    })?;
    Ok(Json(
        json!({"token": tok, "action": "/v1/launch", "type": c.ftype, "name": c.name, "role": role.as_str()}),
    ))
}

async fn versions(State(ws): State<Ws>, me: Me, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    canvas_for(&ws, &me, &cid, Role::View).await?;
    let rows = sqlx::query("SELECT version, at, authors, kind, name, size FROM versions WHERE canvas_id = ? ORDER BY version DESC LIMIT 200")
        .bind(&cid)
        .fetch_all(&ws.db.pool)
        .await?;
    let list: Vec<Value> = rows
        .iter()
        .map(|r| json!({
            "version": r.try_get::<i64, _>(0).unwrap_or(0), "at": r.try_get::<i64, _>(1).unwrap_or(0),
            "authors": serde_json::from_str::<Value>(&r.try_get::<String, _>(2).unwrap_or_default()).unwrap_or(json!([])),
            "kind": r.try_get::<String, _>(3).unwrap_or_default(), "name": r.try_get::<Option<String>, _>(4).ok().flatten(),
            "size": r.try_get::<i64, _>(5).unwrap_or(0),
        }))
        .collect();
    Ok(Json(json!({"versions": list})))
}

#[derive(Deserialize)]
struct PeopleQ {
    q: Option<String>,
}

/// The directory for the share dialog: people and teams. Guests cannot see it (docs/40 §4.3).
async fn people(State(ws): State<Ws>, me: Me, Query(q): Query<PeopleQ>) -> ApiResult<Json<Value>> {
    if me.role == Instance::Guest {
        return Err(ApiError::forbidden("Guests can't see the member list."));
    }
    let needle = format!(
        "%{}%",
        q.q.unwrap_or_default()
            .to_lowercase()
            .replace(['%', '_', '\\'], "")
    );
    let users = sqlx::query("SELECT id, name, email, role, color FROM users WHERE status = 'active' AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ?) ORDER BY name LIMIT 20")
        .bind(&needle)
        .bind(&needle)
        .fetch_all(&ws.db.pool)
        .await?;
    let teams =
        sqlx::query("SELECT id, name FROM teams WHERE LOWER(name) LIKE ? ORDER BY name LIMIT 10")
            .bind(&needle)
            .fetch_all(&ws.db.pool)
            .await?;
    Ok(Json(json!({
        "people": users.iter().map(|r| json!({"id": r.try_get::<String, _>(0).ok(), "name": r.try_get::<String, _>(1).ok(), "email": r.try_get::<String, _>(2).ok(), "role": r.try_get::<String, _>(3).ok(), "color": r.try_get::<String, _>(4).ok()})).collect::<Vec<_>>(),
        "teams": teams.iter().map(|r| json!({"id": r.try_get::<String, _>(0).ok(), "name": r.try_get::<String, _>(1).ok()})).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceBody {
    name: Option<String>,
    icon: Option<String>,
    color: Option<String>,
    description: Option<String>,
    visibility: Option<String>,
}

const COLORS: &[&str] = &[
    "gray", "blue", "green", "amber", "red", "pink", "purple", "teal",
];

async fn create_workspace(
    State(ws): State<Ws>,
    me: Me,
    Json(b): Json<WorkspaceBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let (settings, _) = crate::settings::Settings::load(&ws.db, &ws.cfg).await?;
    if me.role == Instance::Guest || (!me.role.is_admin() && !settings.members_create_workspaces) {
        return Err(ApiError::forbidden("You can't create workspaces."));
    }
    let name = clean_name(b.name.as_deref().unwrap_or(""), 80);
    if name.is_empty() {
        return Err(ApiError::bad("NAME", "Give the workspace a name."));
    }
    let vis = if b.visibility.as_deref() == Some("private") {
        "private"
    } else {
        "open"
    };
    let color = b
        .color
        .filter(|c| COLORS.contains(&c.as_str()))
        .unwrap_or_else(|| "blue".into());
    let icon: String = b
        .icon
        .unwrap_or_else(|| "layers".into())
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(40)
        .collect();
    let wid = id("w_");
    sqlx::query("INSERT INTO workspaces (id, name, icon, color, description, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&wid)
        .bind(&name)
        .bind(&icon)
        .bind(&color)
        .bind(clean_name(b.description.as_deref().unwrap_or(""), 400))
        .bind(vis)
        .bind(now_ms())
        .execute(&ws.db.pool)
        .await?;
    sqlx::query("INSERT INTO workspace_members (workspace_id, principal_kind, principal_id, role) VALUES (?, 'user', ?, 'admin')")
        .bind(&wid)
        .bind(&me.id)
        .execute(&ws.db.pool)
        .await?;
    ws.acl.invalidate();
    Ok((StatusCode::CREATED, Json(json!({"id": wid}))))
}

async fn update_workspace(
    State(ws): State<Ws>,
    me: Me,
    Path(wid): Path<String>,
    Json(b): Json<WorkspaceBody>,
) -> ApiResult<Json<Value>> {
    let s = snap(&ws).await?;
    if s.workspace_role(&me.id, &wid) != Some(Role::Full)
        || s.workspaces
            .get(&wid)
            .is_some_and(|w| w.personal_owner.is_some())
    {
        return Err(ApiError::not_found());
    }
    if let Some(n) = b.name {
        let n = clean_name(&n, 80);
        if !n.is_empty() {
            sqlx::query("UPDATE workspaces SET name = ? WHERE id = ?")
                .bind(n)
                .bind(&wid)
                .execute(&ws.db.pool)
                .await?;
        }
    }
    if let Some(c) = b.color.filter(|c| COLORS.contains(&c.as_str())) {
        sqlx::query("UPDATE workspaces SET color = ? WHERE id = ?")
            .bind(c)
            .bind(&wid)
            .execute(&ws.db.pool)
            .await?;
    }
    if let Some(d) = b.description {
        sqlx::query("UPDATE workspaces SET description = ? WHERE id = ?")
            .bind(clean_name(&d, 400))
            .bind(&wid)
            .execute(&ws.db.pool)
            .await?;
    }
    if let Some(v) = b.visibility.filter(|v| v == "open" || v == "private") {
        sqlx::query("UPDATE workspaces SET visibility = ? WHERE id = ?")
            .bind(v)
            .bind(&wid)
            .execute(&ws.db.pool)
            .await?;
        ws.acl.invalidate();
    }
    Ok(Json(json!({"ok": true})))
}

async fn join_workspace(
    State(ws): State<Ws>,
    me: Me,
    Path(wid): Path<String>,
) -> ApiResult<Json<Value>> {
    let s = snap(&ws).await?;
    let w = s.workspaces.get(&wid).ok_or_else(ApiError::not_found)?;
    if !w.open || w.personal_owner.is_some() || w.deleted || me.role == Instance::Guest {
        return Err(ApiError::not_found());
    }
    sqlx::query(sqlx::AssertSqlSafe(format!("{} INTO workspace_members (workspace_id, principal_kind, principal_id, role) VALUES (?, 'user', ?, 'editor')", ws.db.insert_ignore())))
        .bind(&wid)
        .bind(&me.id)
        .execute(&ws.db.pool)
        .await?;
    ws.acl.invalidate();
    Ok(Json(json!({"ok": true})))
}

async fn workspace_members(
    State(ws): State<Ws>,
    me: Me,
    Path(wid): Path<String>,
) -> ApiResult<Json<Value>> {
    let s = snap(&ws).await?;
    if s.workspace_role(&me.id, &wid).is_none() {
        return Err(ApiError::not_found());
    }
    let w = s.workspaces.get(&wid).ok_or_else(ApiError::not_found)?;
    let grants: Vec<(Principal, Role)> = w.members.clone();
    let list = describe(&ws, &grants).await?;
    // Workspace roles are admin, editor, commenter, viewer.
    let list: Vec<Value> = list
        .into_iter()
        .map(|mut g| {
            let r = Role::parse(g["role"].as_str().unwrap_or("")).map(Role::workspace_role);
            g["role"] = json!(r);
            g
        })
        .collect();
    Ok(Json(json!({"members": list})))
}

async fn set_workspace_member(
    State(ws): State<Ws>,
    me: Me,
    Path(wid): Path<String>,
    Json(b): Json<ShareBody>,
) -> ApiResult<Json<Value>> {
    let before = snap(&ws).await?;
    if before.workspace_role(&me.id, &wid) != Some(Role::Full)
        || before
            .workspaces
            .get(&wid)
            .is_some_and(|w| w.personal_owner.is_some())
    {
        return Err(ApiError::not_found());
    }
    if !principal_exists(&ws, &b.principal_kind, &b.principal_id).await? {
        return Err(ApiError::bad("WHO", "No such person or team."));
    }
    sqlx::query("DELETE FROM workspace_members WHERE workspace_id = ? AND principal_kind = ? AND principal_id = ?")
        .bind(&wid)
        .bind(&b.principal_kind)
        .bind(&b.principal_id)
        .execute(&ws.db.pool)
        .await?;
    if let Some(r) = &b.role {
        let r = Role::from_workspace_role(r).ok_or_else(|| {
            ApiError::bad(
                "ROLE",
                "Workspace roles are admin, editor, commenter or viewer.",
            )
        })?;
        sqlx::query("INSERT INTO workspace_members (workspace_id, principal_kind, principal_id, role) VALUES (?, ?, ?, ?)")
            .bind(&wid)
            .bind(&b.principal_kind)
            .bind(&b.principal_id)
            .bind(r.workspace_role())
            .execute(&ws.db.pool)
            .await?;
    }
    let affected = before.canvases_in_workspace(&wid);
    model::propagate(&ws, before, &affected).await?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderBody {
    workspace_id: Option<String>,
    parent_id: Option<String>,
    name: Option<String>,
}

fn depth(s: &Snapshot, folder: &str) -> usize {
    let mut d = 0;
    let mut cur = Some(folder.to_string());
    while let Some(f) = cur {
        d += 1;
        if d > crate::access::MAX_DEPTH + 1 {
            break;
        }
        cur = s.folders.get(&f).and_then(|x| x.parent.clone());
    }
    d
}

async fn create_folder(
    State(ws): State<Ws>,
    me: Me,
    Json(b): Json<FolderBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let s = snap(&ws).await?;
    let wid = b
        .workspace_id
        .ok_or_else(|| ApiError::bad("WORKSPACE", "Which workspace?"))?;
    if let Some(p) = &b.parent_id {
        if s.folders
            .get(p)
            .is_none_or(|f| f.workspace != wid || f.deleted)
        {
            return Err(ApiError::not_found());
        }
        if depth(&s, p) >= crate::access::MAX_DEPTH {
            return Err(ApiError::bad("DEPTH", "Folders nest at most 8 deep."));
        }
    }
    if !can_create_in(&s, &me.id, &wid, b.parent_id.as_deref()) {
        return Err(ApiError::forbidden("You can't create folders here."));
    }
    let name = clean_name(b.name.as_deref().unwrap_or("New folder"), 120);
    let fid = id("f_");
    sqlx::query("INSERT INTO folders (id, workspace_id, parent_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&fid)
        .bind(&wid)
        .bind(b.parent_id.as_deref())
        .bind(if name.is_empty() { "New folder" } else { &name })
        .bind(&me.id)
        .bind(now_ms())
        .execute(&ws.db.pool)
        .await?;
    ws.acl.invalidate();
    Ok((StatusCode::CREATED, Json(json!({"id": fid}))))
}

async fn update_folder(
    State(ws): State<Ws>,
    me: Me,
    Path(fid): Path<String>,
    Json(b): Json<FolderBody>,
) -> ApiResult<Json<Value>> {
    let s = snap(&ws).await?;
    let f = s
        .folders
        .get(&fid)
        .filter(|f| !f.deleted)
        .ok_or_else(ApiError::not_found)?;
    let role = s
        .folder_role(&me.id, &fid)
        .ok_or_else(ApiError::not_found)?;
    if let Some(n) = &b.name {
        if role < Role::Edit {
            return Err(ApiError::forbidden("You can't rename this folder."));
        }
        let n = clean_name(n, 120);
        if !n.is_empty() {
            sqlx::query("UPDATE folders SET name = ? WHERE id = ?")
                .bind(n)
                .bind(&fid)
                .execute(&ws.db.pool)
                .await?;
        }
    }
    if let Some(p) = &b.parent_id {
        if role < Role::Full {
            return Err(ApiError::forbidden(
                "You need full access to move this folder.",
            ));
        }
        let p = (!p.is_empty()).then(|| p.clone());
        if let Some(p) = &p {
            if s.folders
                .get(p)
                .is_none_or(|x| x.workspace != f.workspace || x.deleted)
            {
                return Err(ApiError::not_found());
            }
            // Not into itself or a sub-folder.
            let mut cur = Some(p.clone());
            while let Some(c) = cur {
                if c == fid {
                    return Err(ApiError::bad("CYCLE", "A folder can't go inside itself."));
                }
                cur = s.folders.get(&c).and_then(|x| x.parent.clone());
            }
            if depth(&s, p) >= crate::access::MAX_DEPTH {
                return Err(ApiError::bad("DEPTH", "Folders nest at most 8 deep."));
            }
        }
        sqlx::query("UPDATE folders SET parent_id = ? WHERE id = ?")
            .bind(p.as_deref())
            .bind(&fid)
            .execute(&ws.db.pool)
            .await?;
        let affected = s.canvases_under_folder(&fid);
        model::propagate(&ws, s, &affected).await?;
    }
    Ok(Json(json!({"ok": true})))
}

async fn folder_shares(
    State(ws): State<Ws>,
    me: Me,
    Path(fid): Path<String>,
) -> ApiResult<Json<Value>> {
    let s = snap(&ws).await?;
    s.folder_role(&me.id, &fid)
        .ok_or_else(ApiError::not_found)?;
    let f = s.folders.get(&fid).ok_or_else(ApiError::not_found)?;
    Ok(Json(json!({"direct": describe(&ws, &f.shares).await?})))
}

async fn set_folder_share(
    State(ws): State<Ws>,
    me: Me,
    Path(fid): Path<String>,
    Json(b): Json<ShareBody>,
) -> ApiResult<Json<Value>> {
    let s = snap(&ws).await?;
    if s.folder_role(&me.id, &fid) != Some(Role::Full) {
        return Err(ApiError::not_found());
    }
    let affected = s.canvases_under_folder(&fid);
    set_share(&ws, "folder", &fid, &b, affected).await?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct SearchQ {
    q: Option<String>,
    #[serde(rename = "type")]
    ftype: Option<String>,
    workspace: Option<String>,
}

async fn search(State(ws): State<Ws>, me: Me, Query(q): Query<SearchQ>) -> ApiResult<Json<Value>> {
    let s = snap(&ws).await?;
    let mut hits =
        crate::search::query(&ws.db, &s, &me.id, q.q.as_deref().unwrap_or(""), 50).await?;
    if let Some(t) = &q.ftype {
        hits.retain(|h| &h.ftype == t);
    }
    if let Some(w) = &q.workspace {
        hits.retain(|h| {
            s.canvases
                .get(&h.file_id)
                .is_some_and(|c| &c.workspace == w)
        });
    }
    Ok(Json(json!({"items": hits})))
}

/// Moves a canvas or a folder (with everything inside) to Trash.
pub async fn to_trash(ws: &Ws, kind: &str, oid: &str, by: &str) -> ApiResult<Vec<String>> {
    let s = snap(ws).await?;
    let batch = id("t_");
    let now = now_ms();
    let mut canvases = Vec::new();
    match kind {
        "canvas" => {
            sqlx::query("UPDATE canvases SET deleted_at = ?, trash_batch = ?, trashed_by = ? WHERE id = ? AND deleted_at IS NULL")
                .bind(now)
                .bind(&batch)
                .bind(by)
                .bind(oid)
                .execute(&ws.db.pool)
                .await?;
            canvases.push(oid.to_string());
        }
        "folder" => {
            let mut folders = vec![oid.to_string()];
            let mut i = 0;
            while i < folders.len() {
                let p = folders[i].clone();
                folders.extend(
                    s.folders
                        .iter()
                        .filter(|(_, f)| f.parent.as_deref() == Some(p.as_str()) && !f.deleted)
                        .map(|(id, _)| id.clone()),
                );
                i += 1;
            }
            for f in &folders {
                sqlx::query("UPDATE folders SET deleted_at = ?, trash_batch = ?, trashed_by = ? WHERE id = ? AND deleted_at IS NULL")
                    .bind(now)
                    .bind(&batch)
                    .bind(by)
                    .bind(f)
                    .execute(&ws.db.pool)
                    .await?;
            }
            for c in s.canvases_under_folder(oid) {
                if !s.canvases[&c].deleted {
                    sqlx::query("UPDATE canvases SET deleted_at = ?, trash_batch = ?, trashed_by = ? WHERE id = ? AND deleted_at IS NULL")
                        .bind(now)
                        .bind(&batch)
                        .bind(by)
                        .bind(&c)
                        .execute(&ws.db.pool)
                        .await?;
                    canvases.push(c);
                }
            }
        }
        _ => return Err(ApiError::not_found()),
    }
    ws.acl.invalidate();
    for c in &canvases {
        // Final save, then every session closes (docs/05 §7).
        ws.engine.close_sessions(c).await;
    }
    Ok(canvases)
}

async fn trash_canvas(
    State(ws): State<Ws>,
    me: Me,
    Path(cid): Path<String>,
) -> ApiResult<StatusCode> {
    canvas_for(&ws, &me, &cid, Role::Full).await?;
    to_trash(&ws, "canvas", &cid, &me.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn trash_folder(
    State(ws): State<Ws>,
    me: Me,
    Path(fid): Path<String>,
) -> ApiResult<StatusCode> {
    let s = snap(&ws).await?;
    if s.folder_role(&me.id, &fid) != Some(Role::Full)
        || s.folders.get(&fid).is_none_or(|f| f.deleted)
    {
        return Err(ApiError::not_found());
    }
    to_trash(&ws, "folder", &fid, &me.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct TrashQ {
    who: Option<String>,
}

/// Trash: what I deleted, or (admins) everyone's. Folders list once, with their content count.
async fn trash(State(ws): State<Ws>, me: Me, Query(q): Query<TrashQ>) -> ApiResult<Json<Value>> {
    let all = q.who.as_deref() == Some("all") && me.role.is_admin();
    let s = snap(&ws).await?;
    let (settings, _) = crate::settings::Settings::load(&ws.db, &ws.cfg).await?;
    let keep_ms = settings.trash_days * 86_400_000;
    let folders = sqlx::query("SELECT id, name, workspace_id, trash_batch, trashed_by, deleted_at, parent_id FROM folders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500")
        .fetch_all(&ws.db.pool)
        .await?;
    let mut items = Vec::new();
    let mut batch_roots: HashSet<String> = HashSet::new();
    for r in &folders {
        let fid: String = r.try_get(0)?;
        let batch: Option<String> = r.try_get(3)?;
        let by: Option<String> = r.try_get(4)?;
        let parent: Option<String> = r.try_get(6)?;
        // Only the folder that was deleted, not its sub-folders from the same batch.
        let parent_same_batch = parent.as_ref().is_some_and(|p| {
            folders.iter().any(|x| {
                x.try_get::<String, _>(0).ok().as_deref() == Some(p.as_str())
                    && x.try_get::<Option<String>, _>(3).ok().flatten() == batch
            })
        });
        if parent_same_batch {
            continue;
        }
        if !all
            && by.as_deref() != Some(me.id.as_str())
            && s.folder_role(&me.id, &fid) != Some(Role::Full)
        {
            continue;
        }
        let deleted: i64 = r.try_get(5)?;
        let inside: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM canvases WHERE trash_batch = ?")
            .bind(batch.as_deref())
            .fetch_one(&ws.db.pool)
            .await?;
        if let Some(b) = &batch {
            batch_roots.insert(b.clone());
        }
        items.push(json!({"kind": "folder", "id": fid, "name": r.try_get::<String, _>(1).ok(), "workspaceId": r.try_get::<String, _>(2).ok(), "deletedBy": by, "deletedAt": deleted, "purgeAt": deleted + keep_ms, "files": inside}));
    }
    let cs = all_canvases(&ws, "deleted_at IS NOT NULL", &[]).await?;
    for c in cs {
        let batch: Option<String> =
            sqlx::query_scalar("SELECT trash_batch FROM canvases WHERE id = ?")
                .bind(&c.id)
                .fetch_one(&ws.db.pool)
                .await?;
        if batch.as_ref().is_some_and(|b| batch_roots.contains(b)) {
            continue;
        }
        let by: Option<String> = sqlx::query_scalar("SELECT trashed_by FROM canvases WHERE id = ?")
            .bind(&c.id)
            .fetch_one(&ws.db.pool)
            .await?;
        if !all
            && by.as_deref() != Some(me.id.as_str())
            && s.canvas_role(&me.id, &c.id) != Some(Role::Full)
        {
            continue;
        }
        let deleted = c.deleted_at.unwrap_or(0);
        let loc = model::location(&ws, &c).await?;
        items.push(json!({"kind": "canvas", "id": c.id, "name": c.name, "type": c.ftype, "location": loc, "deletedBy": by, "deletedAt": deleted, "purgeAt": deleted + keep_ms}));
    }
    let who: HashSet<String> = items
        .iter()
        .filter_map(|i| i["deletedBy"].as_str().map(String::from))
        .collect();
    let nm = names(&ws, &who).await?;
    for i in &mut items {
        if let Some(b) = i["deletedBy"].as_str() {
            i["deletedByName"] = json!(nm.get(b));
        }
    }
    items.sort_by_key(|i| -i["deletedAt"].as_i64().unwrap_or(0));
    Ok(Json(json!({"items": items, "days": settings.trash_days})))
}

async fn may_manage_trashed(ws: &Ws, me: &Me, kind: &str, oid: &str) -> ApiResult<Option<String>> {
    let s = snap(ws).await?;
    let (by, batch): (Option<String>, Option<String>) = match kind {
        "canvas" => {
            let r = sqlx::query("SELECT trashed_by, trash_batch FROM canvases WHERE id = ? AND deleted_at IS NOT NULL").bind(oid).fetch_optional(&ws.db.pool).await?.ok_or_else(ApiError::not_found)?;
            (r.try_get(0)?, r.try_get(1)?)
        }
        "folder" => {
            let r = sqlx::query("SELECT trashed_by, trash_batch FROM folders WHERE id = ? AND deleted_at IS NOT NULL").bind(oid).fetch_optional(&ws.db.pool).await?.ok_or_else(ApiError::not_found)?;
            (r.try_get(0)?, r.try_get(1)?)
        }
        _ => return Err(ApiError::not_found()),
    };
    let role = if kind == "canvas" {
        s.canvas_role(&me.id, oid)
    } else {
        s.folder_role(&me.id, oid)
    };
    if !(me.role.is_admin() || by.as_deref() == Some(me.id.as_str()) || role == Some(Role::Full)) {
        return Err(ApiError::not_found());
    }
    Ok(batch)
}

async fn restore(
    State(ws): State<Ws>,
    me: Me,
    Path((kind, oid)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let batch = may_manage_trashed(&ws, &me, &kind, &oid).await?;
    let mut note = None;
    match kind.as_str() {
        "canvas" => {
            // The folder it was in is gone: the canvas goes to the workspace's top level.
            let folder: Option<String> =
                sqlx::query_scalar("SELECT folder_id FROM canvases WHERE id = ?")
                    .bind(&oid)
                    .fetch_one(&ws.db.pool)
                    .await?;
            let folder_ok = match &folder {
                Some(f) => {
                    sqlx::query_scalar::<_, i64>(
                        "SELECT COUNT(*) FROM folders WHERE id = ? AND deleted_at IS NULL",
                    )
                    .bind(f)
                    .fetch_one(&ws.db.pool)
                    .await?
                        > 0
                }
                None => true,
            };
            if !folder_ok {
                note = Some("Its folder is gone, so it went to the top of the workspace.");
            }
            sqlx::query("UPDATE canvases SET deleted_at = NULL, trash_batch = NULL, trashed_by = NULL, folder_id = ? WHERE id = ?")
                .bind(if folder_ok { folder } else { None })
                .bind(&oid)
                .execute(&ws.db.pool)
                .await?;
        }
        _ => {
            let parent: Option<String> =
                sqlx::query_scalar("SELECT parent_id FROM folders WHERE id = ?")
                    .bind(&oid)
                    .fetch_one(&ws.db.pool)
                    .await?;
            let parent_ok = match &parent {
                Some(p) => sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM folders WHERE id = ? AND (deleted_at IS NULL OR trash_batch = ?)").bind(p).bind(batch.as_deref()).fetch_one(&ws.db.pool).await? > 0,
                None => true,
            };
            if !parent_ok {
                note = Some("Its parent folder is gone, so it went to the top of the workspace.");
                sqlx::query("UPDATE folders SET parent_id = NULL WHERE id = ?")
                    .bind(&oid)
                    .execute(&ws.db.pool)
                    .await?;
            }
            sqlx::query("UPDATE folders SET deleted_at = NULL, trash_batch = NULL, trashed_by = NULL WHERE trash_batch = ?").bind(batch.as_deref()).execute(&ws.db.pool).await?;
            sqlx::query("UPDATE canvases SET deleted_at = NULL, trash_batch = NULL, trashed_by = NULL WHERE trash_batch = ?").bind(batch.as_deref()).execute(&ws.db.pool).await?;
        }
    }
    ws.acl.invalidate();
    Ok(Json(json!({"ok": true, "note": note})))
}

async fn purge_now(
    State(ws): State<Ws>,
    me: Me,
    Path((kind, oid)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let batch = may_manage_trashed(&ws, &me, &kind, &oid).await?;
    match kind.as_str() {
        "canvas" => crate::jobs::purge_canvas(&ws, &oid).await?,
        _ => {
            for c in
                sqlx::query_scalar::<_, String>("SELECT id FROM canvases WHERE trash_batch = ?")
                    .bind(batch.as_deref())
                    .fetch_all(&ws.db.pool)
                    .await?
            {
                crate::jobs::purge_canvas(&ws, &c).await?;
            }
            sqlx::query("DELETE FROM shares WHERE object_kind = 'folder' AND object_id IN (SELECT id FROM folders WHERE trash_batch = ?)").bind(batch.as_deref()).execute(&ws.db.pool).await?;
            sqlx::query("DELETE FROM folders WHERE trash_batch = ?")
                .bind(batch.as_deref())
                .execute(&ws.db.pool)
                .await?;
        }
    }
    ws.acl.invalidate();
    Ok(StatusCode::NO_CONTENT)
}

async fn notifications(State(ws): State<Ws>, me: Me) -> ApiResult<Json<Value>> {
    let rows = sqlx::query("SELECT n.id, n.kind, n.canvas_id, n.block_id, n.by_user, n.excerpt, n.at, n.read_at, c.name, u.name FROM notifications n LEFT JOIN canvases c ON c.id = n.canvas_id LEFT JOIN users u ON u.id = n.by_user WHERE n.user_id = ? ORDER BY n.at DESC LIMIT 50")
        .bind(&me.id)
        .fetch_all(&ws.db.pool)
        .await?;
    let s = snap(&ws).await?;
    let list: Vec<Value> = rows
        .iter()
        .filter(|r| r.try_get::<Option<String>, _>(2).ok().flatten().is_none_or(|c| s.can_open(&me.id, &c).is_some()))
        .map(|r| json!({
            "id": r.try_get::<String, _>(0).ok(), "kind": r.try_get::<String, _>(1).ok(), "canvasId": r.try_get::<Option<String>, _>(2).ok().flatten(),
            "blockId": r.try_get::<Option<String>, _>(3).ok().flatten(), "excerpt": r.try_get::<String, _>(5).ok(), "at": r.try_get::<i64, _>(6).ok(),
            "read": r.try_get::<Option<i64>, _>(7).ok().flatten().is_some(), "canvasName": r.try_get::<Option<String>, _>(8).ok().flatten(),
            "byName": r.try_get::<Option<String>, _>(9).ok().flatten(),
        }))
        .collect();
    Ok(Json(json!({"items": list})))
}

async fn read_notifications(State(ws): State<Ws>, me: Me) -> ApiResult<StatusCode> {
    sqlx::query("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL")
        .bind(now_ms())
        .bind(&me.id)
        .execute(&ws.db.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
