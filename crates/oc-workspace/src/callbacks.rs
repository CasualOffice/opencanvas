// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The callbacks the engine calls (WS-11, docs/05 §5, §5a): load, save with `If-Match`,
//! copies, assets, members, access, create file, templates, versions, mentions and search.
//! Every call is signed (v2) and, except `/access`, `/search` and scheduled service saves,
//! carries the callback token we put in the launch token.

use axum::body::Bytes;
use axum::extract::{OriginalUri, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;

use crate::Ws;
use crate::access::Role;
use crate::engine::{callback_token, check_callback_token, check_signature};
use crate::model::{self, Canvas, SaveMeta};
use crate::util::{id, now_ms};

/// Saves and copies up to 100 MB (docs/05 §5a).
pub const MAX_BODY: usize = 100 * 1024 * 1024;

pub fn router() -> Router<Ws> {
    Router::new()
        .route("/files/{id}", get(load).put(save))
        .route("/files/{id}/copies", post(copies))
        .route("/files/{id}/assets", post(upload_asset))
        .route("/files/{id}/assets/{asset}", get(get_asset))
        .route("/files/{id}/members", get(members))
        .route("/files/{id}/versions", get(versions))
        .route("/files/{id}/versions/{v}", get(version))
        .route("/files", post(create_file))
        .route("/access", post(access))
        .route("/templates", get(templates))
        .route("/templates/{id}", get(template_file))
        .route("/mentions", post(mentions))
        .route("/search", get(search))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY))
}

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({"error": msg}))).into_response()
}

/// Who a callback acts for.
#[derive(Debug, Clone)]
pub enum Subject {
    User(String),
    /// A public-link visitor (`v_…`): the link's role, while the link is live.
    Visitor(String),
    /// A signed call without a bearer: scheduled automation (docs/05 §5).
    Service,
}

impl Subject {
    pub fn user_id(&self) -> Option<&str> {
        match self {
            Self::User(u) => Some(u),
            _ => None,
        }
    }
}

fn bearer(h: &HeaderMap) -> Option<String> {
    h.get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .or_else(|| {
            h.get("x-opencanvas-callback-token")
                .and_then(|v| v.to_str().ok())
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn signed(ws: &Ws, h: &HeaderMap, method: &Method, uri: &OriginalUri, body: &[u8]) -> bool {
    let sig = h
        .get("x-opencanvas-signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let pq = uri.0.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    check_signature(&ws.secrets.host_secret, sig, method.as_str(), pq, body)
}

/// Checks the signature and the token for `file`. The error is the answer to send.
#[allow(clippy::result_large_err)]
fn authenticate(
    ws: &Ws,
    h: &HeaderMap,
    method: &Method,
    uri: &OriginalUri,
    body: &[u8],
    file: &str,
) -> Result<Subject, Response> {
    if !signed(ws, h, method, uri, body) {
        return Err(err(StatusCode::UNAUTHORIZED, "bad signature"));
    }
    let Some(tok) = bearer(h) else {
        return Ok(Subject::Service);
    };
    match check_callback_token(&ws.secrets.token_key, file, &tok) {
        Some(s) if s.starts_with("v_") => Ok(Subject::Visitor(s)),
        Some(s) => Ok(Subject::User(s)),
        None => Err(err(StatusCode::UNAUTHORIZED, "bad callback token")),
    }
}

/// The public link's role right now, capped by the admin's maximum; `None` when off or expired.
pub async fn link_role(ws: &Ws, c: &Canvas) -> Option<Role> {
    let (s, _) = crate::settings::Settings::load(&ws.db, &ws.cfg)
        .await
        .ok()?;
    if !s.public_links.allowed || c.link_access != "public" || c.deleted_at.is_some() {
        return None;
    }
    if c.link_expires_at.is_some_and(|e| e < now_ms()) {
        return None;
    }
    let cap = Role::parse(&s.public_links.max_role).unwrap_or(Role::View);
    Some(
        Role::parse(&c.link_role)
            .unwrap_or(Role::View)
            .min(cap)
            .min(Role::Edit),
    )
}

async fn role_of(ws: &Ws, subject: &Subject, c: &Canvas) -> Option<Role> {
    match subject {
        Subject::Service => Some(Role::Edit),
        Subject::Visitor(_) => link_role(ws, c).await,
        Subject::User(u) => ws.acl.get(&ws.db).await.ok()?.can_open(u, &c.id),
    }
}

async fn load(
    State(ws): State<Ws>,
    Path(fid): Path<String>,
    method: Method,
    uri: OriginalUri,
    h: HeaderMap,
) -> Response {
    let subject = match authenticate(&ws, &h, &method, &uri, &[], &fid) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let Ok(Some(c)) = model::canvas(&ws, &fid).await else {
        return err(StatusCode::NOT_FOUND, "no such file");
    };
    if c.deleted_at.is_some() {
        return err(StatusCode::GONE, "in trash");
    }
    if role_of(&ws, &subject, &c).await.is_none() {
        return err(StatusCode::FORBIDDEN, "no access");
    }
    if c.version == 0 {
        // A new file: sample content as Markdown, else 404 = a new empty canvas (docs/05 §5).
        return match c.seed {
            Some(md) => (
                [
                    (
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("text/markdown; charset=utf-8"),
                    ),
                    (header::ETAG, HeaderValue::from_static("\"0\"")),
                ],
                md,
            )
                .into_response(),
            None => err(StatusCode::NOT_FOUND, "empty"),
        };
    }
    match ws.files.get_version(&c.id, c.version).await {
        Ok(Some(b)) => (
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/vnd.opencanvas+zip"),
                ),
                (
                    header::ETAG,
                    HeaderValue::from_str(&format!("\"{}\"", c.version)).unwrap(),
                ),
            ],
            b,
        )
            .into_response(),
        Ok(None) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "current version missing from storage",
        ),
        Err(e) => {
            tracing::error!(canvas = %c.id, error = %e, "load failed");
            err(StatusCode::INTERNAL_SERVER_ERROR, "storage error")
        }
    }
}

fn header_str(h: &HeaderMap, name: &str) -> Option<String> {
    h.get(name).and_then(|v| v.to_str().ok()).map(String::from)
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(x) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(x);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn idem_get(ws: &Ws, key: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT result FROM idempotency WHERE k = ?")
        .bind(key)
        .fetch_optional(&ws.db.pool)
        .await
        .ok()
        .flatten()
}

async fn idem_put(ws: &Ws, key: &str, result: &str) {
    let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
        "{} INTO idempotency (k, result, at) VALUES (?, ?, ?)",
        ws.db.insert_ignore()
    )))
    .bind(key)
    .bind(result)
    .bind(now_ms())
    .execute(&ws.db.pool)
    .await;
}

async fn save(
    State(ws): State<Ws>,
    Path(fid): Path<String>,
    method: Method,
    uri: OriginalUri,
    h: HeaderMap,
    body: Bytes,
) -> Response {
    let subject = match authenticate(&ws, &h, &method, &uri, &body, &fid) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let lock = ws.canvas_lock(&fid);
    let _g = lock.lock().await;
    let Ok(Some(c)) = model::canvas(&ws, &fid).await else {
        return err(StatusCode::NOT_FOUND, "no such file");
    };
    if c.deleted_at.is_some() {
        return err(StatusCode::GONE, "in trash");
    }
    if role_of(&ws, &subject, &c)
        .await
        .is_none_or(|r| r < Role::Comment)
    {
        return err(StatusCode::FORBIDDEN, "read only");
    }
    let key = header_str(&h, "idempotency-key")
        .map(|k| format!("save:{fid}:{}", k.chars().take(100).collect::<String>()));
    if let Some(k) = &key
        && let Some(prev) = idem_get(&ws, k).await
    {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            prev,
        )
            .into_response();
    }
    if let Some(m) = header_str(&h, "if-match") {
        let m = m.trim().trim_matches('"');
        if !m.is_empty() && m != c.version.to_string() {
            return (
                StatusCode::CONFLICT,
                Json(json!({"version": c.version.to_string()})),
            )
                .into_response();
        }
    }
    let meta = SaveMeta {
        autosave: header_str(&h, "x-opencanvas-autosave").as_deref() != Some("0"),
        name: header_str(&h, "x-opencanvas-commit-message")
            .map(|s| pct_decode(&s).chars().take(120).collect()),
        restored_from: header_str(&h, "x-opencanvas-restored-from")
            .map(|s| pct_decode(&s).chars().take(64).collect()),
        checkpoint: header_str(&h, "x-opencanvas-checkpoint").as_deref() == Some("1"),
        authors: header_str(&h, "x-opencanvas-authors")
            .and_then(|a| serde_json::from_str::<Vec<String>>(&a).ok())
            .unwrap_or_default()
            .into_iter()
            .take(50)
            .collect(),
    };
    let v = match model::store_version(&ws, &c, &body, &meta, subject.user_id()).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(canvas = %fid, error = %e, "save failed");
            return err(StatusCode::INTERNAL_SERVER_ERROR, "storage error");
        }
    };
    let result = json!({"version": v.to_string()}).to_string();
    if let Some(k) = &key {
        idem_put(&ws, k, &result).await;
    }
    if v % 20 == 0 {
        let ws2 = ws.clone();
        let id2 = fid.clone();
        tokio::spawn(async move {
            if let Err(e) = model::thin_canvas(&ws2, &id2, v).await {
                tracing::warn!(canvas = %id2, error = %e, "thinning failed");
            }
        });
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        result,
    )
        .into_response()
}

/// Creates a canvas next to `like` with its shares (copies, live block files).
async fn create_beside(
    ws: &Ws,
    like: &Canvas,
    name: &str,
    ftype: &str,
    by: &str,
) -> anyhow::Result<String> {
    let nid = id("c_");
    let now = now_ms();
    let mut tx = ws.db.pool.begin().await?;
    sqlx::query("INSERT INTO canvases (id, workspace_id, folder_id, name, ftype, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&nid)
        .bind(&like.workspace_id)
        .bind(&like.folder_id)
        .bind(name)
        .bind(ftype)
        .bind(by)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO shares (object_kind, object_id, principal_kind, principal_id, role) SELECT 'canvas', ?, principal_kind, principal_id, role FROM shares WHERE object_kind = 'canvas' AND object_id = ?")
        .bind(&nid)
        .bind(&like.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    ws.acl.invalidate();
    Ok(nid)
}

async fn copies(
    State(ws): State<Ws>,
    Path(fid): Path<String>,
    method: Method,
    uri: OriginalUri,
    h: HeaderMap,
    body: Bytes,
) -> Response {
    let subject = match authenticate(&ws, &h, &method, &uri, &body, &fid) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let Ok(Some(c)) = model::canvas(&ws, &fid).await else {
        return err(StatusCode::NOT_FOUND, "no such file");
    };
    if role_of(&ws, &subject, &c)
        .await
        .is_none_or(|r| r < Role::Comment)
    {
        return err(StatusCode::FORBIDDEN, "read only");
    }
    let key = header_str(&h, "idempotency-key")
        .map(|k| format!("copy:{fid}:{}", k.chars().take(100).collect::<String>()));
    if let Some(k) = &key
        && let Some(prev) = idem_get(&ws, k).await
    {
        return (
            StatusCode::CREATED,
            [(header::CONTENT_TYPE, "application/json")],
            prev,
        )
            .into_response();
    }
    let by = subject.user_id().unwrap_or(&c.created_by).to_string();
    let r = async {
        let nid = create_beside(
            &ws,
            &c,
            &format!("{} (copy)", c.name.chars().take(190).collect::<String>()),
            &c.ftype,
            &by,
        )
        .await?;
        let fresh = model::canvas(&ws, &nid)
            .await?
            .ok_or_else(|| anyhow::anyhow!("copy vanished"))?;
        model::store_version(
            &ws,
            &fresh,
            &body,
            &SaveMeta {
                autosave: false,
                name: Some("Saved as a copy after a conflict".into()),
                ..Default::default()
            },
            Some(&by),
        )
        .await?;
        anyhow::Ok(nid)
    }
    .await;
    match r {
        Ok(nid) => {
            let result =
                json!({"fileId": nid, "url": format!("{}/ws/c/{nid}", ws.public_base().await)})
                    .to_string();
            if let Some(k) = &key {
                idem_put(&ws, k, &result).await;
            }
            (
                StatusCode::CREATED,
                [(header::CONTENT_TYPE, "application/json")],
                result,
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "copy failed");
            err(StatusCode::INTERNAL_SERVER_ERROR, "copy failed")
        }
    }
}

/// The first `file` part of a multipart body.
pub fn multipart_file(ctype: &str, body: &[u8]) -> Option<(String, String, Vec<u8>)> {
    let boundary = ctype
        .split(';')
        .find_map(|p| p.trim().strip_prefix("boundary="))?
        .trim_matches('"');
    let sep = format!("--{boundary}");
    let sep = sep.as_bytes();
    let find = |hay: &[u8], needle: &[u8], from: usize| {
        hay.get(from..)?
            .windows(needle.len())
            .position(|w| w == needle)
            .map(|p| p + from)
    };
    let mut start = find(body, sep, 0)?;
    loop {
        let next = find(body, sep, start + sep.len())?;
        let part = body.get(start + sep.len() + 2..next.checked_sub(2)?)?;
        let head_end = find(part, b"\r\n\r\n", 0)?;
        let head = String::from_utf8_lossy(&part[..head_end]).to_string();
        if head.contains("name=\"file\"") {
            let name = head
                .split("filename=\"")
                .nth(1)
                .and_then(|s| s.split('"').next())
                .unwrap_or("upload")
                .to_string();
            let mime = head
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-type:")
                        .map(|m| m.trim().to_string())
                })
                .unwrap_or_else(|| "application/octet-stream".into());
            return Some((name, mime, part[head_end + 4..].to_vec()));
        }
        start = next;
    }
}

async fn upload_asset(
    State(ws): State<Ws>,
    Path(fid): Path<String>,
    method: Method,
    uri: OriginalUri,
    h: HeaderMap,
    body: Bytes,
) -> Response {
    let subject = match authenticate(&ws, &h, &method, &uri, &body, &fid) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let Ok(Some(c)) = model::canvas(&ws, &fid).await else {
        return err(StatusCode::NOT_FOUND, "no such file");
    };
    if role_of(&ws, &subject, &c)
        .await
        .is_none_or(|r| r < Role::Comment)
    {
        return err(StatusCode::FORBIDDEN, "read only");
    }
    let ctype = header_str(&h, "content-type").unwrap_or_default();
    let Some((name, mime, data)) = multipart_file(&ctype, &body) else {
        return err(StatusCode::BAD_REQUEST, "expected multipart field 'file'");
    };
    // An unguessable id (128 bits): the asset URL is a capability, like the sample host's.
    let aid = format!("a_{}", hex::encode(crate::util::random_bytes(16)));
    if let Err(e) = ws.files.put_asset(&aid, &data).await {
        tracing::error!(error = %e, "asset write failed");
        return err(StatusCode::INTERNAL_SERVER_ERROR, "storage error");
    }
    let mime: String = mime.chars().take(120).collect();
    let _ = sqlx::query("INSERT INTO assets (id, canvas_id, mime, name, size, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&aid)
        .bind(&fid)
        .bind(&mime)
        .bind(name.chars().take(200).collect::<String>())
        .bind(data.len() as i64)
        .bind(now_ms())
        .execute(&ws.db.pool)
        .await;
    let url = format!("{}/api/ws/assets/{aid}", ws.public_base().await);
    (
        StatusCode::CREATED,
        Json(json!({"assetId": aid, "url": url, "mime": mime, "size": data.len()})),
    )
        .into_response()
}

async fn get_asset(
    State(ws): State<Ws>,
    Path((fid, aid)): Path<(String, String)>,
    method: Method,
    uri: OriginalUri,
    h: HeaderMap,
) -> Response {
    if let Err(r) = authenticate(&ws, &h, &method, &uri, &[], &fid) {
        return r;
    }
    serve_asset(&ws, &aid).await
}

pub async fn serve_asset(ws: &Ws, aid: &str) -> Response {
    let Ok(Some(row)) = sqlx::query("SELECT mime FROM assets WHERE id = ?")
        .bind(aid)
        .fetch_optional(&ws.db.pool)
        .await
    else {
        return err(StatusCode::NOT_FOUND, "no such asset");
    };
    let mime: String = row
        .try_get(0)
        .unwrap_or_else(|_| "application/octet-stream".into());
    // Only images render inline; anything else downloads (no HTML or SVG scripts on our origin).
    let inline = matches!(
        mime.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif"
    );
    match ws.files.get_asset(aid).await {
        Ok(Some(b)) => (
            [
                (
                    header::CONTENT_TYPE,
                    if inline {
                        mime
                    } else {
                        "application/octet-stream".into()
                    },
                ),
                (header::CACHE_CONTROL, "private, max-age=86400".into()),
                (
                    header::HeaderName::from_static("x-content-type-options"),
                    "nosniff".into(),
                ),
                (
                    header::CONTENT_DISPOSITION,
                    if inline {
                        "inline".into()
                    } else {
                        "attachment".into()
                    },
                ),
            ],
            b,
        )
            .into_response(),
        _ => err(StatusCode::NOT_FOUND, "no such asset"),
    }
}

#[derive(Deserialize)]
struct MembersQ {
    q: Option<String>,
    limit: Option<usize>,
}

async fn members(
    State(ws): State<Ws>,
    Path(fid): Path<String>,
    method: Method,
    uri: OriginalUri,
    h: HeaderMap,
    Query(q): Query<MembersQ>,
) -> Response {
    let subject = match authenticate(&ws, &h, &method, &uri, &[], &fid) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let Ok(Some(c)) = model::canvas(&ws, &fid).await else {
        return err(StatusCode::NOT_FOUND, "no such file");
    };
    if role_of(&ws, &subject, &c).await.is_none() {
        return err(StatusCode::FORBIDDEN, "no access");
    }
    let Ok(snap) = ws.acl.get(&ws.db).await else {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "acl");
    };
    let people = match people_with_access(&ws, &snap, &fid).await {
        Ok(p) => p,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "db"),
    };
    let needle = q.q.unwrap_or_default().to_lowercase();
    let limit = q.limit.unwrap_or(500).min(500);
    let out: Vec<_> = people
        .into_iter()
        .filter(|p| p.name.to_lowercase().contains(&needle))
        .take(limit)
        .collect();
    Json(out).into_response()
}

/// Everyone who may open the canvas, as the engine sees people (never an e-mail).
pub async fn people_with_access(
    ws: &Ws,
    snap: &crate::access::Snapshot,
    canvas: &str,
) -> anyhow::Result<Vec<crate::engine::Person>> {
    let ids: Vec<String> = snap
        .members_of(canvas)
        .into_iter()
        .map(|(u, _)| u)
        .collect();
    let mut out = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(200) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql =
            format!("SELECT id, name, color, role FROM users WHERE id IN ({marks}) ORDER BY name");
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for i in chunk {
            q = q.bind(i);
        }
        for r in q.fetch_all(&ws.db.pool).await? {
            let role: String = r.try_get(3)?;
            out.push(crate::engine::Person {
                id: r.try_get(0)?,
                name: r.try_get(1)?,
                detail: (role == "guest").then(|| "Guest".to_string()),
                color: Some(r.try_get(2)?),
            });
        }
    }
    out.truncate(500);
    Ok(out)
}

#[derive(Deserialize)]
struct Page {
    cursor: Option<String>,
    limit: Option<i64>,
}

async fn versions(
    State(ws): State<Ws>,
    Path(fid): Path<String>,
    method: Method,
    uri: OriginalUri,
    h: HeaderMap,
    Query(p): Query<Page>,
) -> Response {
    let subject = match authenticate(&ws, &h, &method, &uri, &[], &fid) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let Ok(Some(c)) = model::canvas(&ws, &fid).await else {
        return err(StatusCode::NOT_FOUND, "no such file");
    };
    if matches!(subject, Subject::Visitor(_)) || role_of(&ws, &subject, &c).await.is_none() {
        return err(StatusCode::FORBIDDEN, "no access");
    }
    let limit = p.limit.unwrap_or(50).clamp(1, 100);
    let from: i64 = p.cursor.and_then(|c| c.parse().ok()).unwrap_or(0).max(0);
    let rows = match sqlx::query("SELECT version, at, authors, kind, name, size, restored_from FROM versions WHERE canvas_id = ? ORDER BY version DESC LIMIT ? OFFSET ?")
        .bind(&fid)
        .bind(limit + 1)
        .bind(from)
        .fetch_all(&ws.db.pool)
        .await
    {
        Ok(r) => r,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "db"),
    };
    let more = rows.len() as i64 > limit;
    let list: Vec<_> = rows
        .iter()
        .take(limit as usize)
        .map(|r| {
            let authors: String = r.try_get(2).unwrap_or_default();
            let mut v = json!({
                "version": r.try_get::<i64, _>(0).unwrap_or(0).to_string(),
                "at": crate::util::rfc3339(r.try_get(1).unwrap_or(0)),
                "authors": serde_json::from_str::<serde_json::Value>(&authors).unwrap_or(json!([])),
                "kind": r.try_get::<String, _>(3).unwrap_or_default(),
                "size": r.try_get::<i64, _>(5).unwrap_or(0),
            });
            if let Ok(Some(n)) = r.try_get::<Option<String>, _>(4) {
                v["name"] = json!(n);
            }
            if let Ok(Some(n)) = r.try_get::<Option<String>, _>(6) {
                v["restoredFrom"] = json!(n);
            }
            v
        })
        .collect();
    let mut out = json!({"versions": list});
    if more {
        out["next"] = json!((from + limit).to_string());
    }
    Json(out).into_response()
}

async fn version(
    State(ws): State<Ws>,
    Path((fid, v)): Path<(String, String)>,
    method: Method,
    uri: OriginalUri,
    h: HeaderMap,
) -> Response {
    let subject = match authenticate(&ws, &h, &method, &uri, &[], &fid) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let Ok(Some(c)) = model::canvas(&ws, &fid).await else {
        return err(StatusCode::NOT_FOUND, "no such file");
    };
    if matches!(subject, Subject::Visitor(_)) || role_of(&ws, &subject, &c).await.is_none() {
        return err(StatusCode::FORBIDDEN, "no access");
    }
    let Ok(n) = v.parse::<i64>() else {
        return err(StatusCode::NOT_FOUND, "no such version");
    };
    match ws.files.get_version(&fid, n).await {
        Ok(Some(b)) => (
            [(header::CONTENT_TYPE, "application/vnd.opencanvas+zip")],
            b,
        )
            .into_response(),
        _ => err(StatusCode::GONE, "version expired"),
    }
}

#[derive(Deserialize)]
struct AccessQ {
    #[serde(rename = "fileId")]
    file_id: String,
    #[serde(rename = "userId")]
    user_id: String,
}

async fn access(
    State(ws): State<Ws>,
    method: Method,
    uri: OriginalUri,
    h: HeaderMap,
    body: Bytes,
) -> Response {
    if !signed(&ws, &h, &method, &uri, &body) {
        return err(StatusCode::UNAUTHORIZED, "bad signature");
    }
    let Ok(q) = serde_json::from_slice::<AccessQ>(&body) else {
        return err(StatusCode::BAD_REQUEST, "expected JSON");
    };
    let Ok(Some(c)) = model::canvas(&ws, &q.file_id).await else {
        return Json(json!({"role": "none"})).into_response();
    };
    if c.deleted_at.is_some() {
        return err(StatusCode::GONE, "in trash");
    }
    let Ok(snap) = ws.acl.get(&ws.db).await else {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "acl");
    };
    let Some(role) = snap.can_open(&q.user_id, &c.id) else {
        return Json(json!({"role": "none"})).into_response();
    };
    let path: String = model::location(&ws, &c)
        .await
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect();
    Json(json!({
        "role": role.engine(),
        "name": c.name,
        "path": path,
        "callbackToken": callback_token(&ws.secrets.token_key, &c.id, &q.user_id),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct CreateQ {
    name: Option<String>,
    #[serde(rename = "parentFileId")]
    parent: String,
    #[serde(rename = "type")]
    ftype: Option<String>,
}

async fn create_file(
    State(ws): State<Ws>,
    method: Method,
    uri: OriginalUri,
    h: HeaderMap,
    body: Bytes,
) -> Response {
    let Ok(q) = serde_json::from_slice::<CreateQ>(&body) else {
        return err(StatusCode::BAD_REQUEST, "expected JSON");
    };
    let subject = match authenticate(&ws, &h, &method, &uri, &body, &q.parent) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let Ok(Some(parent)) = model::canvas(&ws, &q.parent).await else {
        return err(StatusCode::NOT_FOUND, "no such canvas");
    };
    let Some(user) = subject.user_id() else {
        return err(StatusCode::FORBIDDEN, "people only");
    };
    if role_of(&ws, &subject, &parent)
        .await
        .is_none_or(|r| r < Role::Edit)
    {
        return err(StatusCode::FORBIDDEN, "read only");
    }
    let ftype = q.ftype.unwrap_or_else(|| "document".into());
    if !model::FILE_TYPES.contains(&ftype.as_str()) {
        return err(StatusCode::BAD_REQUEST, "unknown type");
    }
    let key = header_str(&h, "idempotency-key").map(|k| {
        format!(
            "create:{}:{}",
            q.parent,
            k.chars().take(100).collect::<String>()
        )
    });
    if let Some(k) = &key
        && let Some(prev) = idem_get(&ws, k).await
    {
        return (
            StatusCode::CREATED,
            [(header::CONTENT_TYPE, "application/json")],
            prev,
        )
            .into_response();
    }
    let name = crate::util::clean_name(q.name.as_deref().unwrap_or("Live block"), 200);
    match create_beside(
        &ws,
        &parent,
        if name.is_empty() { "Untitled" } else { &name },
        &ftype,
        user,
    )
    .await
    {
        Ok(nid) => {
            // The person who made it can edit it, whatever the parent's shares say.
            let _ = sqlx::query(sqlx::AssertSqlSafe(format!("{} INTO shares (object_kind, object_id, principal_kind, principal_id, role) VALUES ('canvas', ?, 'user', ?, 'full')", ws.db.insert_ignore())))
                .bind(&nid)
                .bind(user)
                .execute(&ws.db.pool)
                .await;
            ws.acl.invalidate();
            let result = json!({"fileId": nid}).to_string();
            if let Some(k) = &key {
                idem_put(&ws, k, &result).await;
            }
            (
                StatusCode::CREATED,
                [(header::CONTENT_TYPE, "application/json")],
                result,
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "create file failed");
            err(StatusCode::INTERNAL_SERVER_ERROR, "create failed")
        }
    }
}

/// The bearer must be a callback token we issued for some file the person can still open.
async fn user_from_any_token(ws: &Ws, h: &HeaderMap) -> Option<String> {
    let tok = bearer(h)?;
    let (subject, _) = tok.rsplit_once('.')?;
    if subject.starts_with("v_") {
        return None;
    }
    let snap = ws.acl.get(&ws.db).await.ok()?;
    snap.canvases
        .keys()
        .find(|c| check_callback_token(&ws.secrets.token_key, c, &tok).is_some())
        .map(|_| subject.to_string())
}

async fn templates(
    State(ws): State<Ws>,
    method: Method,
    uri: OriginalUri,
    h: HeaderMap,
) -> Response {
    if !signed(&ws, &h, &method, &uri, &[]) || user_from_any_token(&ws, &h).await.is_none() {
        return err(StatusCode::UNAUTHORIZED, "bad signature or token");
    }
    let (s, _) = crate::settings::Settings::load(&ws.db, &ws.cfg)
        .await
        .unwrap_or_default();
    let rows = sqlx::query("SELECT id, name, updated_at, ftype FROM canvases WHERE is_template = 1 AND deleted_at IS NULL AND version > 0 ORDER BY name LIMIT 200")
        .fetch_all(&ws.db.pool)
        .await
        .unwrap_or_default();
    let list: Vec<_> = rows
        .iter()
        .map(|r| {
            let ftype: String = r.try_get(3).unwrap_or_default();
            json!({
                "id": r.try_get::<String, _>(0).unwrap_or_default(),
                "name": r.try_get::<String, _>(1).unwrap_or_default(),
                "description": format!("{} template", s.org_name),
                "category": s.org_name,
                "icon": match ftype.as_str() { "spreadsheet" => "sheet", "whiteboard" => "shapes", "database" => "database", _ => "file-text" },
                "tone": "blue",
                "updatedAt": crate::util::rfc3339(r.try_get(2).unwrap_or(0)),
            })
        })
        .collect();
    Json(list).into_response()
}

async fn template_file(
    State(ws): State<Ws>,
    Path(tid): Path<String>,
    method: Method,
    uri: OriginalUri,
    h: HeaderMap,
) -> Response {
    if !signed(&ws, &h, &method, &uri, &[]) || user_from_any_token(&ws, &h).await.is_none() {
        return err(StatusCode::UNAUTHORIZED, "bad signature or token");
    }
    let Ok(Some(c)) = model::canvas(&ws, &tid).await else {
        return err(StatusCode::NOT_FOUND, "no such template");
    };
    if !c.is_template || c.deleted_at.is_some() || c.version == 0 {
        return err(StatusCode::GONE, "gone");
    }
    match ws.files.get_version(&c.id, c.version).await {
        Ok(Some(b)) if b.len() <= 5 * 1024 * 1024 => (
            [(header::CONTENT_TYPE, "application/vnd.opencanvas+zip")],
            b,
        )
            .into_response(),
        _ => err(StatusCode::GONE, "gone"),
    }
}

#[derive(Deserialize)]
struct Mention {
    #[serde(rename = "fileId")]
    file_id: String,
    #[serde(rename = "blockId")]
    block_id: Option<String>,
    mentioned: Vec<String>,
    by: Option<String>,
    excerpt: Option<String>,
}

async fn mentions(
    State(ws): State<Ws>,
    method: Method,
    uri: OriginalUri,
    h: HeaderMap,
    body: Bytes,
) -> Response {
    let Ok(n) = serde_json::from_slice::<Mention>(&body) else {
        return err(StatusCode::BAD_REQUEST, "expected JSON");
    };
    if let Err(r) = authenticate(&ws, &h, &method, &uri, &body, &n.file_id) {
        return r;
    }
    let key = header_str(&h, "idempotency-key")
        .map(|k| format!("mention:{}", k.chars().take(100).collect::<String>()));
    if let Some(k) = &key
        && idem_get(&ws, k).await.is_some()
    {
        return Json(json!({"duplicate": true})).into_response();
    }
    let Ok(snap) = ws.acl.get(&ws.db).await else {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "acl");
    };
    let now = now_ms();
    // Only people who can open the file are told (docs/05 §5).
    for u in n
        .mentioned
        .iter()
        .take(100)
        .filter(|u| snap.can_open(u, &n.file_id).is_some())
    {
        let _ = sqlx::query("INSERT INTO notifications (id, user_id, kind, canvas_id, block_id, by_user, excerpt, at) VALUES (?, ?, 'mention', ?, ?, ?, ?, ?)")
            .bind(id("n_"))
            .bind(u)
            .bind(&n.file_id)
            .bind(n.block_id.as_deref())
            .bind(n.by.as_deref())
            .bind(n.excerpt.as_deref().unwrap_or("").chars().take(280).collect::<String>())
            .bind(now)
            .execute(&ws.db.pool)
            .await;
    }
    if let Some(k) = &key {
        idem_put(&ws, k, "1").await;
    }
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct SearchQ {
    q: Option<String>,
    #[serde(rename = "userId")]
    user_id: Option<String>,
    limit: Option<usize>,
}

async fn search(
    State(ws): State<Ws>,
    method: Method,
    uri: OriginalUri,
    h: HeaderMap,
    Query(q): Query<SearchQ>,
) -> Response {
    if !signed(&ws, &h, &method, &uri, &[]) {
        return err(StatusCode::UNAUTHORIZED, "bad signature");
    }
    let user = q.user_id.unwrap_or_default();
    let Ok(snap) = ws.acl.get(&ws.db).await else {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "acl");
    };
    let items = crate::search::query(
        &ws.db,
        &snap,
        &user,
        q.q.as_deref().unwrap_or(""),
        q.limit.unwrap_or(20).min(50),
    )
    .await
    .unwrap_or_default();
    Json(json!({"items": items, "scopes": [{"id": "all", "label": "All canvases"}], "partial": false, "next": null})).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multipart_finds_the_file_part() {
        let body = b"--XyZ\r\nContent-Disposition: form-data; name=\"other\"\r\n\r\nx\r\n--XyZ\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\n\x89PNG\r\n--XyZ--\r\n";
        let (name, mime, data) = multipart_file("multipart/form-data; boundary=XyZ", body).unwrap();
        assert_eq!(name, "a.png");
        assert_eq!(mime, "image/png");
        assert_eq!(data, b"\x89PNG");
        assert!(multipart_file("multipart/form-data; boundary=Q", body).is_none());
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(
            pct_decode("Before%20the%20review%20%E2%9C%93"),
            "Before the review ✓"
        );
        assert_eq!(pct_decode("100%"), "100%");
    }
}
