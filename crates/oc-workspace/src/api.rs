// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Setup, sign-in, sign-up, invites and password resets (WS-05, WS-08, WS-09).

use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;

use crate::Ws;
use crate::auth::{self, Me};
use crate::util::{ApiError, ApiResult, clean_name, id, now_ms, sha256_hex};

pub fn router() -> Router<Ws> {
    Router::new()
        .route("/setup", get(setup_state).post(setup))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/signup", post(signup))
        .route("/auth/reset", post(reset))
        .route(
            "/auth/sessions/others",
            axum::routing::delete(sign_out_others),
        )
        .route("/me", get(me).patch(update_me))
        .route("/me/password", post(change_password))
        .route("/invites", post(create_invite).get(list_invites))
        .route(
            "/invites/{token}",
            get(invite_preview).delete(revoke_invite),
        )
        .route("/reset/{token}", get(reset_preview))
}

fn with_cookie(body: serde_json::Value, cookie: String) -> Response {
    let mut r = Json(body).into_response();
    r.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).expect("cookie"),
    );
    r
}

async fn setup_state(
    State(ws): State<Ws>,
    req: axum::extract::Request,
) -> ApiResult<Json<serde_json::Value>> {
    let done = crate::setup::is_done(&ws).await?;
    let loopback = auth::is_loopback(req.extensions(), req.headers());
    Ok(Json(json!({
        "needsSetup": !done,
        "codeRequired": !done && !loopback,
        "publicUrl": ws.cfg.public_url,
        "publicUrlLocked": ws.cfg.public_url.is_some(),
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupBody {
    code: Option<String>,
    org_name: String,
    public_url: Option<String>,
    admin_name: String,
    admin_email: String,
    admin_password: Option<String>,
    workspace_name: String,
    #[serde(default = "yes")]
    sample: bool,
}
fn yes() -> bool {
    true
}

async fn setup(State(ws): State<Ws>, req: axum::extract::Request) -> ApiResult<Response> {
    if crate::setup::is_done(&ws).await? {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "SETUP_DONE",
            "Setup is already done. Sign in instead.",
        ));
    }
    let loopback = auth::is_loopback(req.extensions(), req.headers());
    let ip = auth::client_ip(req.extensions(), req.headers());
    let agent = req
        .headers()
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = axum::body::to_bytes(req.into_body(), 64 * 1024)
        .await
        .map_err(|_| ApiError::bad("BODY", "Body too large"))?;
    let b: SetupBody =
        serde_json::from_slice(&bytes).map_err(|e| ApiError::bad("JSON", e.to_string()))?;
    if !loopback {
        if ws.limiter.blocked(ip) {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "LOCKED",
                "Too many tries. Wait 15 minutes.",
            ));
        }
        let expected = ws.setup_code.lock().unwrap().clone().unwrap_or_default();
        if expected.is_empty()
            || !crate::setup::code_matches(&expected, b.code.as_deref().unwrap_or(""))
        {
            ws.limiter.fail(ip);
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "SETUP_CODE",
                "That setup code doesn't match the one in the container log.",
            ));
        }
    }
    let email = auth::normalize_email(&b.admin_email)
        .ok_or_else(|| ApiError::bad("EMAIL", "Enter a valid e-mail address."))?;
    let name = clean_name(&b.admin_name, 80);
    let org = clean_name(&b.org_name, 80);
    let wsname = clean_name(&b.workspace_name, 80);
    if name.is_empty() || org.is_empty() || wsname.is_empty() {
        return Err(ApiError::bad("REQUIRED", "Fill in every field."));
    }
    let hash = match &b.admin_password {
        Some(pw) => {
            if let Some(p) = auth::password_problem(pw, &email) {
                return Err(ApiError::bad("PASSWORD", p));
            }
            Some(auth::hash_password(pw)?)
        }
        None => {
            return Err(ApiError::bad(
                "PASSWORD",
                "Choose a password (passkeys can be added after setup).",
            ));
        }
    };
    let public_url = match (&ws.cfg.public_url, b.public_url.as_deref().map(str::trim)) {
        (Some(u), _) => u.clone(),
        (None, Some(u)) if u.starts_with("http://") || u.starts_with("https://") => {
            u.trim_end_matches('/').to_string()
        }
        (None, Some("")) | (None, None) => String::new(),
        _ => {
            return Err(ApiError::bad(
                "URL",
                "The public address starts with http:// or https://.",
            ));
        }
    };
    let owner = crate::setup::run(
        &ws,
        &crate::setup::SetupInput {
            org_name: org,
            public_url,
            admin_name: name,
            admin_email: email,
            admin_password_hash: hash,
            workspace_name: wsname,
            sample: b.sample,
        },
    )
    .await
    .map_err(|e| ApiError::new(StatusCode::CONFLICT, "SETUP", e.to_string()))?;
    tracing::info!("setup finished; the setup code is no longer valid");
    let token = auth::create_session(&ws, &owner, &agent).await?;
    Ok(with_cookie(
        json!({"ok": true, "userId": owner}),
        auth::session_cookie(
            &token,
            ws.secure_cookies().await,
            auth::SESSION_DAYS * 86_400,
        ),
    ))
}

#[derive(Deserialize)]
struct LoginBody {
    email: String,
    password: String,
}

async fn login(State(ws): State<Ws>, req: axum::extract::Request) -> ApiResult<Response> {
    let ip = auth::client_ip(req.extensions(), req.headers());
    let agent = req
        .headers()
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = axum::body::to_bytes(req.into_body(), 16 * 1024)
        .await
        .map_err(|_| ApiError::bad("BODY", "Body too large"))?;
    let b: LoginBody =
        serde_json::from_slice(&bytes).map_err(|e| ApiError::bad("JSON", e.to_string()))?;
    let wrong = || {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "WRONG",
            "That e-mail and password don't match.",
        )
    };
    if ws.limiter.blocked(ip) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "LOCKED",
            "Too many tries from here. Wait 15 minutes.",
        ));
    }
    let email = auth::normalize_email(&b.email).ok_or_else(wrong)?;
    let row = sqlx::query(
        "SELECT id, password_hash, status, failed_logins, locked_until FROM users WHERE email = ?",
    )
    .bind(&email)
    .fetch_optional(&ws.db.pool)
    .await?;
    let now = now_ms();
    let Some(row) = row else {
        // Same work as a real check, so timing does not tell who has an account.
        let _ = auth::verify_password(&b.password, auth::dummy_hash());
        ws.limiter.fail(ip);
        return Err(wrong());
    };
    let uid: String = row.try_get(0)?;
    let hash: Option<String> = row.try_get(1)?;
    let status: String = row.try_get(2)?;
    let fails: i64 = row.try_get(3)?;
    let locked: Option<i64> = row.try_get(4)?;
    if locked.is_some_and(|l| l > now) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "LOCKED",
            "Too many wrong passwords. Try again in 15 minutes.",
        ));
    }
    let ok = hash
        .as_deref()
        .is_some_and(|h| auth::verify_password(&b.password, h));
    if !ok {
        ws.limiter.fail(ip);
        let n = fails + 1;
        sqlx::query("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?")
            .bind(if n >= auth::LOCK_AFTER { 0 } else { n })
            .bind((n >= auth::LOCK_AFTER).then_some(now + auth::LOCK_MS))
            .bind(&uid)
            .execute(&ws.db.pool)
            .await?;
        return Err(wrong());
    }
    if status != "active" {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "SUSPENDED",
            "This account is suspended. Ask an admin.",
        ));
    }
    ws.limiter.success(ip);
    sqlx::query(
        "UPDATE users SET failed_logins = 0, locked_until = NULL, last_active_at = ? WHERE id = ?",
    )
    .bind(now)
    .bind(&uid)
    .execute(&ws.db.pool)
    .await?;
    let token = auth::create_session(&ws, &uid, &agent).await?;
    Ok(with_cookie(
        json!({"ok": true}),
        auth::session_cookie(
            &token,
            ws.secure_cookies().await,
            auth::SESSION_DAYS * 86_400,
        ),
    ))
}

async fn logout(State(ws): State<Ws>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(t) = auth::cookie_value(&headers, auth::SESSION_COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE id_hash = ?")
            .bind(sha256_hex(&t))
            .execute(&ws.db.pool)
            .await?;
    }
    Ok(with_cookie(
        json!({"ok": true}),
        auth::session_cookie("", ws.secure_cookies().await, 0),
    ))
}

async fn sign_out_others(State(ws): State<Ws>, me: Me) -> ApiResult<Json<serde_json::Value>> {
    let n = sqlx::query("DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?")
        .bind(&me.id)
        .bind(&me.session_hash)
        .execute(&ws.db.pool)
        .await?
        .rows_affected();
    Ok(Json(json!({"signedOut": n})))
}

async fn me(State(ws): State<Ws>, me: Me) -> ApiResult<Json<serde_json::Value>> {
    let (s, _) = crate::settings::Settings::load(&ws.db, &ws.cfg).await?;
    let unread: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL",
    )
    .bind(&me.id)
    .fetch_one(&ws.db.pool)
    .await?;
    Ok(Json(json!({
        "id": me.id, "name": me.name, "email": me.email, "role": me.role.as_str(), "color": me.color,
        "org": {"name": s.org_name, "accent": s.accent, "publicLinks": s.public_links.allowed},
        "unread": unread,
    })))
}

#[derive(Deserialize)]
struct MeBody {
    name: Option<String>,
    color: Option<String>,
}

async fn update_me(
    State(ws): State<Ws>,
    me: Me,
    Json(b): Json<MeBody>,
) -> ApiResult<Json<serde_json::Value>> {
    if let Some(n) = b.name {
        let n = clean_name(&n, 80);
        if n.is_empty() {
            return Err(ApiError::bad("NAME", "Enter a name."));
        }
        sqlx::query("UPDATE users SET name = ? WHERE id = ?")
            .bind(&n)
            .bind(&me.id)
            .execute(&ws.db.pool)
            .await?;
    }
    if let Some(c) = b.color {
        let ok =
            c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit());
        if !ok {
            return Err(ApiError::bad("COLOR", "Use a colour like #2a5ad7."));
        }
        sqlx::query("UPDATE users SET color = ? WHERE id = ?")
            .bind(&c)
            .bind(&me.id)
            .execute(&ws.db.pool)
            .await?;
    }
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct PasswordBody {
    current: Option<String>,
    password: String,
}

async fn change_password(
    State(ws): State<Ws>,
    me: Me,
    Json(b): Json<PasswordBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let hash: Option<String> = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?")
        .bind(&me.id)
        .fetch_one(&ws.db.pool)
        .await?;
    if let Some(h) = hash
        && !b
            .current
            .as_deref()
            .is_some_and(|c| auth::verify_password(c, &h))
    {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "WRONG",
            "Your current password is wrong.",
        ));
    }
    if let Some(p) = auth::password_problem(&b.password, &me.email) {
        return Err(ApiError::bad("PASSWORD", p));
    }
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(auth::hash_password(&b.password)?)
        .bind(&me.id)
        .execute(&ws.db.pool)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?")
        .bind(&me.id)
        .bind(&me.session_hash)
        .execute(&ws.db.pool)
        .await?;
    Ok(Json(json!({"ok": true})))
}

/// Invites (WS-08): to the organisation (member or guest), a workspace or a canvas. Always a
/// copyable single-use link, 7 days by default.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteBody {
    pub kind: String,
    #[serde(default)]
    pub target_id: String,
    pub role: String,
    pub email: Option<String>,
    pub days: Option<i64>,
}

pub async fn make_invite(ws: &Ws, me: &Me, b: &InviteBody) -> ApiResult<(String, String)> {
    let snap = ws.acl.get(&ws.db).await?;
    let ok_role = match b.kind.as_str() {
        "org" => {
            if !me.role.is_admin() {
                return Err(ApiError::forbidden(
                    "Only admins invite people to the organisation.",
                ));
            }
            matches!(b.role.as_str(), "member" | "guest" | "admin")
        }
        "workspace" => {
            if snap.workspace_role(&me.id, &b.target_id) != Some(crate::access::Role::Full) {
                return Err(ApiError::forbidden(
                    "Only workspace admins invite people to it.",
                ));
            }
            crate::access::Role::from_workspace_role(&b.role).is_some()
        }
        "canvas" => {
            if snap
                .can_open(&me.id, &b.target_id)
                .is_none_or(|r| r < crate::access::Role::Full)
            {
                return Err(ApiError::forbidden(
                    "You need full access to invite people to this canvas.",
                ));
            }
            crate::access::Role::parse(&b.role).is_some()
        }
        _ => return Err(ApiError::bad("KIND", "Invite to org, workspace or canvas.")),
    };
    if !ok_role {
        return Err(ApiError::bad(
            "ROLE",
            "That role can't be given by an invite.",
        ));
    }
    let email = match &b.email {
        Some(e) if !e.trim().is_empty() => Some(
            auth::normalize_email(e)
                .ok_or_else(|| ApiError::bad("EMAIL", "Enter a valid e-mail address."))?,
        ),
        _ => None,
    };
    let token = crate::util::token(24);
    let days = b.days.unwrap_or(7).clamp(1, 30);
    let now = now_ms();
    sqlx::query("INSERT INTO tokens (token_hash, purpose, kind, target_id, role, email, created_by, created_at, expires_at) VALUES (?, 'invite', ?, ?, ?, ?, ?, ?, ?)")
        .bind(sha256_hex(&token))
        .bind(&b.kind)
        .bind(&b.target_id)
        .bind(&b.role)
        .bind(email.as_deref())
        .bind(&me.id)
        .bind(now)
        .bind(now + days * 86_400_000)
        .execute(&ws.db.pool)
        .await?;
    let url = format!("{}/ws/invite/{token}", ws.public_base().await);
    Ok((token, url))
}

async fn create_invite(
    State(ws): State<Ws>,
    me: Me,
    Json(b): Json<InviteBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let (token, url) = make_invite(&ws, &me, &b).await?;
    // Sent by e-mail only when SMTP is set up (a later row); the link always works.
    Ok(Json(json!({"token": token, "url": url, "emailed": false})))
}

async fn list_invites(
    State(ws): State<Ws>,
    crate::auth::Admin(_me): crate::auth::Admin,
) -> ApiResult<Json<serde_json::Value>> {
    let rows = sqlx::query("SELECT token_hash, kind, target_id, role, email, created_by, expires_at FROM tokens WHERE purpose = 'invite' AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 200")
        .bind(now_ms())
        .fetch_all(&ws.db.pool)
        .await?;
    let list: Vec<_> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.try_get::<String, _>(0).unwrap_or_default(),
                "kind": r.try_get::<String, _>(1).unwrap_or_default(),
                "targetId": r.try_get::<String, _>(2).unwrap_or_default(),
                "role": r.try_get::<String, _>(3).unwrap_or_default(),
                "email": r.try_get::<Option<String>, _>(4).unwrap_or_default(),
                "createdBy": r.try_get::<Option<String>, _>(5).unwrap_or_default(),
                "expiresAt": r.try_get::<i64, _>(6).unwrap_or_default(),
            })
        })
        .collect();
    Ok(Json(json!({"invites": list})))
}

async fn revoke_invite(
    State(ws): State<Ws>,
    crate::auth::Admin(_me): crate::auth::Admin,
    Path(token_or_id): Path<String>,
) -> ApiResult<StatusCode> {
    // The admin list shows hashes as ids; a raw token works too.
    sqlx::query(
        "DELETE FROM tokens WHERE purpose = 'invite' AND (token_hash = ? OR token_hash = ?)",
    )
    .bind(&token_or_id)
    .bind(sha256_hex(&token_or_id))
    .execute(&ws.db.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

struct Invite {
    hash: String,
    kind: String,
    target: String,
    role: String,
    email: Option<String>,
    by: Option<String>,
    expires: i64,
}

async fn find_token(ws: &Ws, token: &str, purpose: &str) -> ApiResult<Invite> {
    let hash = sha256_hex(token);
    let r = sqlx::query("SELECT kind, target_id, role, email, created_by, expires_at, used_at, user_id FROM tokens WHERE token_hash = ? AND purpose = ?")
        .bind(&hash)
        .bind(purpose)
        .fetch_optional(&ws.db.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "INVALID", "This link isn't valid. Ask for a new one."))?;
    let used: Option<i64> = r.try_get(6)?;
    let expires: i64 = r.try_get(5)?;
    if used.is_some() || expires < now_ms() {
        return Err(ApiError::new(
            StatusCode::GONE,
            "EXPIRED",
            "This link was used or has expired. Ask for a new one.",
        ));
    }
    Ok(Invite {
        hash,
        kind: r.try_get(0)?,
        target: r.try_get(1)?,
        role: r.try_get(2)?,
        email: r.try_get(3)?,
        by: if purpose == "reset" {
            r.try_get(7)?
        } else {
            r.try_get(4)?
        },
        expires,
    })
}

async fn invite_preview(
    State(ws): State<Ws>,
    Path(token): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let inv = find_token(&ws, &token, "invite").await?;
    let by: Option<String> = match &inv.by {
        Some(u) => {
            sqlx::query_scalar("SELECT name FROM users WHERE id = ?")
                .bind(u)
                .fetch_optional(&ws.db.pool)
                .await?
        }
        None => None,
    };
    let target_name: Option<String> = match inv.kind.as_str() {
        "workspace" => {
            sqlx::query_scalar("SELECT name FROM workspaces WHERE id = ?")
                .bind(&inv.target)
                .fetch_optional(&ws.db.pool)
                .await?
        }
        "canvas" => {
            sqlx::query_scalar("SELECT name FROM canvases WHERE id = ?")
                .bind(&inv.target)
                .fetch_optional(&ws.db.pool)
                .await?
        }
        _ => None,
    };
    let (s, _) = crate::settings::Settings::load(&ws.db, &ws.cfg).await?;
    Ok(Json(json!({
        "org": s.org_name, "invitedBy": by, "kind": inv.kind, "targetName": target_name,
        "role": inv.role, "email": inv.email, "expiresAt": inv.expires,
    })))
}

#[derive(Deserialize)]
struct SignupBody {
    invite: Option<String>,
    name: String,
    email: Option<String>,
    /// Absent with `passkey: true`: the account signs in with a passkey only (2b).
    password: Option<String>,
    #[serde(default)]
    passkey: bool,
}

async fn signup(State(ws): State<Ws>, req: axum::extract::Request) -> ApiResult<Response> {
    let agent = req
        .headers()
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = axum::body::to_bytes(req.into_body(), 16 * 1024)
        .await
        .map_err(|_| ApiError::bad("BODY", "Body too large"))?;
    let b: SignupBody =
        serde_json::from_slice(&bytes).map_err(|e| ApiError::bad("JSON", e.to_string()))?;
    let name = clean_name(&b.name, 80);
    if name.is_empty() {
        return Err(ApiError::bad("NAME", "Enter your name."));
    }
    let (s, _) = crate::settings::Settings::load(&ws.db, &ws.cfg).await?;
    let inv = match &b.invite {
        Some(t) => Some(find_token(&ws, t, "invite").await?),
        None => None,
    };
    let email = match (&inv, &b.email) {
        (Some(Invite { email: Some(e), .. }), _) => e.clone(),
        (_, Some(e)) => auth::normalize_email(e)
            .ok_or_else(|| ApiError::bad("EMAIL", "Enter a valid e-mail address."))?,
        _ => return Err(ApiError::bad("EMAIL", "Enter your e-mail address.")),
    };
    if inv.is_none() {
        let domain = email.rsplit('@').next().unwrap_or("");
        if !s
            .signup_domains
            .iter()
            .any(|d| d.eq_ignore_ascii_case(domain))
        {
            return Err(ApiError::forbidden(
                "Sign-up needs an invite. Ask an admin for one.",
            ));
        }
    }
    match (&b.password, b.passkey) {
        (Some(pw), _) => {
            if let Some(p) = auth::password_problem(pw, &email) {
                return Err(ApiError::bad("PASSWORD", p));
            }
        }
        (None, true) => {}
        (None, false) => {
            return Err(ApiError::bad(
                "PASSWORD",
                "Choose a password, or create the account with a passkey.",
            ));
        }
    }
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE email = ?")
        .bind(&email)
        .fetch_optional(&ws.db.pool)
        .await?;
    if exists.is_some() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "EXISTS",
            "There is already an account with this e-mail. Sign in instead.",
        ));
    }
    let role = match &inv {
        Some(i) if i.kind == "org" => i.role.clone(),
        Some(i) if i.kind == "canvas" => "guest".to_string(),
        _ => "member".to_string(),
    };
    let uid = id("u_");
    let now = now_ms();
    let hash = b.password.as_deref().map(auth::hash_password).transpose()?;
    let mut tx = ws.db.pool.begin().await?;
    if let Some(i) = &inv {
        // Single use, even when two people race on one link.
        let n = sqlx::query(
            "UPDATE tokens SET used_at = ?, used_by = ? WHERE token_hash = ? AND used_at IS NULL",
        )
        .bind(now)
        .bind(&uid)
        .bind(&i.hash)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if n != 1 {
            return Err(ApiError::new(
                StatusCode::GONE,
                "EXPIRED",
                "This invite was just used. Ask for a new one.",
            ));
        }
    }
    sqlx::query("INSERT INTO users (id, email, name, password_hash, role, status, color, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)")
        .bind(&uid)
        .bind(&email)
        .bind(&name)
        .bind(&hash)
        .bind(&role)
        .bind(auth::color_for(&uid))
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    if let Some(i) = &inv {
        match i.kind.as_str() {
            "workspace" => {
                sqlx::query("INSERT INTO workspace_members (workspace_id, principal_kind, principal_id, role) VALUES (?, 'user', ?, ?)")
                    .bind(&i.target)
                    .bind(&uid)
                    .bind(&i.role)
                    .execute(&mut *tx)
                    .await?;
            }
            "canvas" => {
                sqlx::query("INSERT INTO shares (object_kind, object_id, principal_kind, principal_id, role) VALUES ('canvas', ?, 'user', ?, ?)")
                    .bind(&i.target)
                    .bind(&uid)
                    .bind(&i.role)
                    .execute(&mut *tx)
                    .await?;
            }
            _ => {}
        }
    }
    if role != "guest" {
        crate::setup::personal_space(&ws, &mut tx, &uid, now).await?;
    }
    tx.commit().await?;
    ws.acl.invalidate();
    let token = auth::create_session(&ws, &uid, &agent).await?;
    let landing = match &inv {
        Some(i) if i.kind == "canvas" => format!("/ws/c/{}", i.target),
        Some(i) if i.kind == "workspace" => format!("/ws/w/{}", i.target),
        _ => "/ws/".into(),
    };
    Ok(with_cookie(
        json!({"ok": true, "userId": uid, "next": landing}),
        auth::session_cookie(
            &token,
            ws.secure_cookies().await,
            auth::SESSION_DAYS * 86_400,
        ),
    ))
}

/// An admin-made reset link (no SMTP needed), valid 24 hours.
pub async fn make_reset_link(ws: &Ws, user: &str, by: Option<&str>) -> anyhow::Result<String> {
    let token = crate::util::token(24);
    let now = now_ms();
    sqlx::query("INSERT INTO tokens (token_hash, purpose, user_id, created_by, created_at, expires_at) VALUES (?, 'reset', ?, ?, ?, ?)")
        .bind(sha256_hex(&token))
        .bind(user)
        .bind(by)
        .bind(now)
        .bind(now + 86_400_000)
        .execute(&ws.db.pool)
        .await?;
    Ok(format!("{}/ws/reset/{token}", ws.public_base().await))
}

async fn reset_preview(
    State(ws): State<Ws>,
    Path(token): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let t = find_token(&ws, &token, "reset").await?;
    let email: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = ?")
        .bind(t.by.as_deref())
        .fetch_optional(&ws.db.pool)
        .await?;
    Ok(Json(json!({"email": email, "expiresAt": t.expires})))
}

#[derive(Deserialize)]
struct ResetBody {
    token: String,
    password: String,
}

async fn reset(
    State(ws): State<Ws>,
    Json(b): Json<ResetBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let t = find_token(&ws, &b.token, "reset").await?;
    let uid = t.by.ok_or_else(ApiError::not_found)?;
    let email: String = sqlx::query_scalar("SELECT email FROM users WHERE id = ?")
        .bind(&uid)
        .fetch_one(&ws.db.pool)
        .await?;
    if let Some(p) = auth::password_problem(&b.password, &email) {
        return Err(ApiError::bad("PASSWORD", p));
    }
    let n = sqlx::query("UPDATE tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
        .bind(now_ms())
        .bind(&t.hash)
        .execute(&ws.db.pool)
        .await?
        .rows_affected();
    if n != 1 {
        return Err(ApiError::new(
            StatusCode::GONE,
            "EXPIRED",
            "This link was just used.",
        ));
    }
    sqlx::query(
        "UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?",
    )
    .bind(auth::hash_password(&b.password)?)
    .bind(&uid)
    .execute(&ws.db.pool)
    .await?;
    // Everyone signed in as this person is signed out.
    sqlx::query("DELETE FROM sessions WHERE user_id = ?")
        .bind(&uid)
        .execute(&ws.db.pool)
        .await?;
    Ok(Json(json!({"ok": true})))
}
