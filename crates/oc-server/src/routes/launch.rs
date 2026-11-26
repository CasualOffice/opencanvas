// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `POST|GET /v1/launch` (JWT, or WOPI with `?WOPISrc=`), `GET /v1/sessions/:ticket` (docs/15 §2)
//! and the WOPI discovery endpoints (docs/05 §6).

use std::time::Instant;

use axum::Json;
use axum::extract::{Form, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use super::{ApiError, session};
use crate::host_client::HostError;
use crate::hosts::HostConfig;
use crate::metrics::Metrics;
use crate::util::{now_ms, now_secs};
use crate::wopi;
use crate::{SharedState, TicketUse};

#[derive(Deserialize)]
pub struct LaunchParams {
    #[serde(default)]
    token: String,
    /// Open the canvas at this block (UX-02); passed on as `&block=` in the app fragment.
    #[serde(default)]
    block: Option<String>,
    /// LIVE-06: `view=block`, the compact embed of one live file (`&view=block` in the fragment).
    #[serde(default)]
    view: Option<String>,
}

/// Form fields of a launch POST: a JWT `token`, or WOPI `access_token` + `access_token_ttl`.
#[derive(Deserialize)]
pub struct LaunchForm {
    #[serde(default)]
    token: String,
    #[serde(default)]
    access_token: String,
    /// WOPI: expiry as milliseconds since the epoch; 0 / absent = unknown.
    #[serde(default)]
    access_token_ttl: Option<String>,
    #[serde(default)]
    block: Option<String>,
    #[serde(default)]
    view: Option<String>,
}

/// Query of a launch POST; `WOPISrc` selects WOPI mode. Other WOPI placeholders hosts append
/// (`ui`, `rs`, …) are ignored.
#[derive(Deserialize)]
pub struct LaunchQuery {
    #[serde(rename = "WOPISrc", default)]
    wopi_src: Option<String>,
    #[serde(default)]
    block: Option<String>,
    #[serde(default)]
    view: Option<String>,
}

/// Appends `&block=<id>` to a launch redirect when `block` is a plain id (`[A-Za-z0-9_-]`,
/// at most 64); anything else is dropped.
fn with_block(res: Response, block: Option<&str>) -> Response {
    with_fragment(res, "block", block)
}

/// LIVE-06: `&view=block` (the only view there is) for the compact embed of one live file.
fn with_view(res: Response, view: Option<&str>) -> Response {
    with_fragment(res, "view", view.filter(|v| *v == "block"))
}

/// Appends `&<key>=<value>` to a launch redirect's fragment when the value is a plain id.
fn with_fragment(mut res: Response, key: &str, block: Option<&str>) -> Response {
    let Some(b) = block.filter(|b| {
        !b.is_empty()
            && b.len() <= 64
            && b.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    }) else {
        return res;
    };
    if res.status() != StatusCode::SEE_OTHER {
        return res;
    }
    let loc = res
        .headers()
        .get(header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(|l| format!("{l}&{key}={b}"));
    if let Some(v) = loc.and_then(|l| header::HeaderValue::from_str(&l).ok()) {
        res.headers_mut().insert(header::LOCATION, v);
    }
    res
}

pub async fn launch_post(
    State(state): State<SharedState>,
    Query(q): Query<LaunchQuery>,
    headers: HeaderMap,
    Form(p): Form<LaunchForm>,
) -> Response {
    let res = match q.wopi_src {
        Some(src) => launch_wopi(&state, &src, &p).await,
        None => launch(&state, &p.token).await,
    };
    // docs/23 PERM-07: the editor renews access with the host's fresh token (`Action_RefreshToken`)
    // and asks for JSON, `{"ticket"}`, instead of the redirect that loads the app.
    let wants_json = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|a| a.contains("application/json"));
    let res = res.unwrap_or_else(IntoResponse::into_response);
    if wants_json && res.status() == StatusCode::SEE_OTHER {
        let ticket = res
            .headers()
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|l| l.split_once("#t="))
            // Only the ticket: options such as `&start=page` (ADR-048) follow it.
            .map(|(_, t)| t.split('&').next().unwrap_or_default().to_owned());
        if let Some(ticket) = ticket {
            return (
                [(header::CACHE_CONTROL, "no-store")],
                Json(json!({ "ticket": ticket })),
            )
                .into_response();
        }
    }
    let block = p.block.as_deref().or(q.block.as_deref());
    let view = p.view.as_deref().or(q.view.as_deref());
    with_view(with_block(res, block), view)
}

pub async fn launch_get(
    State(state): State<SharedState>,
    Query(p): Query<LaunchParams>,
) -> Response {
    let res = launch(&state, &p.token)
        .await
        .unwrap_or_else(IntoResponse::into_response);
    with_view(with_block(res, p.block.as_deref()), p.view.as_deref())
}

fn rejected(state: &SharedState, status: StatusCode, code: &'static str, msg: String) -> ApiError {
    state.metrics.launch_rejected(code);
    tracing::info!(reason = %msg, "launch rejected");
    ApiError::new(status, code, msg)
}

/// `/app/#t=<ticket>`, or `/app/?h=<host id>#t=<ticket>` for a host with its own
/// `frame_ancestors`, so that page is served with them (routes/mod.rs `security_headers`).
fn redirect_to_app(host: &HostConfig, ticket: &str) -> Response {
    let page = if host.frame_ancestors.is_empty() {
        "/app/".to_string()
    } else {
        let mut h = String::new();
        for b in host.id.bytes() {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                h.push(b as char);
            } else {
                h.push_str(&format!("%{b:02X}"));
            }
        }
        format!("/app/?h={h}")
    };
    (
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, format!("{page}#t={ticket}")),
            (header::CACHE_CONTROL, "no-store".into()),
        ],
    )
        .into_response()
}

/// WOPI launch (docs/05 §6): allowlist `WOPISrc`, CheckFileInfo with the opaque access
/// token, then a session like a JWT launch. The token is never logged.
async fn launch_wopi(
    state: &SharedState,
    src: &str,
    form: &LaunchForm,
) -> Result<Response, ApiError> {
    let now = now_secs();
    let Some((host, src)) = state.hosts.wopi_host_for(src) else {
        return Err(rejected(
            state,
            StatusCode::FORBIDDEN,
            "WOPISRC_NOT_ALLOWED",
            "WOPISrc is not in any host's wopi_allowlist".into(),
        ));
    };
    if form.access_token.is_empty() || form.access_token.len() > 4096 {
        return Err(rejected(
            state,
            StatusCode::UNAUTHORIZED,
            "TOKEN_INVALID",
            "access_token missing".into(),
        ));
    }
    let ttl_ms = form
        .access_token_ttl
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::parse::<i64>)
        .transpose()
        .map_err(|_| {
            rejected(
                state,
                StatusCode::BAD_REQUEST,
                "TTL_INVALID",
                "access_token_ttl must be milliseconds since the epoch".into(),
            )
        })?
        .unwrap_or(0);
    // SEC-35: the host's `access_token_ttl` never stretches a session past the JWT cap (10 h);
    // after that the host launches again (docs/05 §6).
    let exp = if ttl_ms > 0 {
        ttl_ms / 1000
    } else {
        now + wopi::DEFAULT_TTL_SECS
    }
    .min(now + crate::jwt::MAX_TTL_SECS);
    if exp <= now {
        return Err(rejected(
            state,
            StatusCode::UNAUTHORIZED,
            "TOKEN_INVALID",
            "access_token_ttl has passed".into(),
        ));
    }
    let info = match wopi::check_file_info(
        state.host.wopi_http(),
        state.host.wopi_proof(),
        &src,
        &form.access_token,
    )
    .await
    {
        Ok(info) => info,
        Err(HostError::Status(s)) if s.is_client_error() => {
            return Err(rejected(
                state,
                StatusCode::UNAUTHORIZED,
                "TOKEN_INVALID",
                format!("CheckFileInfo answered {s}"),
            ));
        }
        Err(e) => return Err(ApiError::host(e)),
    };
    state.host.remember_wopi_name(&src, &info.base_file_name);
    let grant = info.grant(&host.id, &src, &form.access_token);
    let ticket = ulid::Ulid::new().to_string();
    state
        .store
        .insert_session(&ticket, &grant, exp, now_ms())
        .await
        .map_err(ApiError::internal)?;
    Metrics::inc(&state.metrics.launches_total);
    tracing::info!(host = %host.id, room = %grant.room, role = grant.role.as_str(), "WOPI launch accepted");
    Ok(redirect_to_app(&host, &ticket))
}

/// `GET /hosting/discovery` (WOPI discovery XML).
pub async fn discovery(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let public = public_base(&state, &headers);
    // Derived from the request's Host header unless OC_PUBLIC_URL is set: never let a shared
    // cache keep a copy someone built with a forged Host (SEC-06).
    let cache = if state.cfg.public_url.is_some() {
        "public, max-age=3600"
    } else {
        "private, no-store"
    };
    (
        [
            (header::CONTENT_TYPE, "text/xml; charset=utf-8"),
            (header::CACHE_CONTROL, cache),
        ],
        wopi::discovery_xml(&public, state.host.wopi_proof()),
    )
        .into_response()
}

/// `GET /hosting/capabilities`.
pub async fn capabilities() -> Response {
    Json(wopi::capabilities()).into_response()
}

/// `OC_PUBLIC_URL`, else the request's own origin.
fn public_base(state: &SharedState, headers: &HeaderMap) -> String {
    if let Some(base) = &state.cfg.public_url {
        return base.clone();
    }
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost:8080");
    let secure = headers
        .get("x-forwarded-proto")
        .and_then(|h| h.to_str().ok())
        == Some("https");
    format!("{}://{host}", if secure { "https" } else { "http" })
}

async fn launch(state: &SharedState, token: &str) -> Result<Response, ApiError> {
    let now = now_secs();
    let reject = |code, msg: String| rejected(state, StatusCode::UNAUTHORIZED, code, msg);
    let (host, claims) = state
        .jwks
        .verify(token, &state.hosts, now)
        .await
        .map_err(|e| reject("TOKEN_INVALID", e.to_string()))?;
    if host.wopi_only() {
        return Err(reject(
            "TOKEN_INVALID",
            "this host launches through WOPI only".into(),
        ));
    }
    let exp = claims.exp;
    if !state
        .store
        .use_jti(&host.id, &claims.jti, exp)
        .await
        .map_err(ApiError::internal)?
    {
        return Err(reject("TOKEN_REUSED", "launch token already used".into()));
    }
    let iat = claims.iat;
    let start_page = claims.start_page();
    let mut grant = claims.into_grant();
    if let Some(iat) = iat {
        match state.members.role_since(&grant.room, &grant.user.id, iat) {
            Some(Some(role)) => grant.role = role,
            Some(None) => {
                return Err(rejected(
                    state,
                    StatusCode::FORBIDDEN,
                    "ROLE_REVOKED",
                    "the host removed this person's access after the token was issued".into(),
                ));
            }
            None => {}
        }
    }
    let ticket = ulid::Ulid::new().to_string();
    state
        .store
        .insert_session(&ticket, &grant, exp, now_ms())
        .await
        .map_err(ApiError::internal)?;
    Metrics::inc(&state.metrics.launches_total);
    tracing::info!(host = %host.id, room = %grant.room, role = grant.role.as_str(), "launch accepted");
    // ADR-048: the host chose the kind already, so the editor skips its template picker.
    let ticket = if start_page {
        format!("{ticket}&start=page")
    } else {
        ticket
    };
    Ok(redirect_to_app(&host, &ticket))
}

pub(crate) fn ws_url(state: &SharedState, headers: &HeaderMap) -> String {
    if let Some(base) = &state.cfg.public_url {
        let base = base
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        return format!("{base}/v1/collab");
    }
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost:8080");
    let secure = headers
        .get("x-forwarded-proto")
        .and_then(|h| h.to_str().ok())
        == Some("https");
    format!("{}://{host}/v1/collab", if secure { "wss" } else { "ws" })
}

pub async fn session_info(
    State(state): State<SharedState>,
    Path(ticket): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &ticket).await?;
    // docs/23 PERM-07: the editor warns before this (seconds since the epoch).
    let exp = state
        .store
        .session(&ticket)
        .await
        .map_err(ApiError::internal)?
        .map(|(_, exp)| exp);
    let info = state
        .rooms
        .info(&host, &grant)
        .await
        .map_err(ApiError::host)?;
    state
        .tickets
        .lock()
        .expect("tickets lock")
        .entry(ticket.clone())
        .or_insert(TicketUse {
            first_seen: Instant::now(),
            connected: false,
        });
    // A fresh token means the host granted access (again).
    state.members.restore(&grant.room, &grant.user.id);
    // docs/15 §2: whether the assistant shows, from `[host.ai]` and the role (the run modes the
    // server would accept; viewers never get it).
    let host_ai = crate::ai::HostAi(&host);
    // The server-wide switch beats `[host.ai]` (docs/24 §7.3).
    let server_ai = state.ai_on();
    let ai_on = server_ai && host_ai.agent().is_some_and(|a| a.enabled);
    let modes: &[&str] = match (ai_on, grant.role) {
        (false, _) | (_, crate::grant::Role::View) => &[],
        (true, crate::grant::Role::Comment) => &["answer", "comment"],
        (true, crate::grant::Role::Edit) => &["edit", "comment", "answer"],
    };
    let history = if host.version_history_on() {
        crate::history::Sources::of(&host, &grant).session_json(&host)
    } else {
        json!({"history": "none"})
    };
    let hist = host.version_history_on();
    let import_formats = super::import::formats(&state, &host, grant.role);
    // EDP-01: the profile, its insertable blocks and the feature switches (aliases applied).
    let editor = host.editor().session_json(
        server_ai && host_ai.agent().is_some_and(|a| a.enabled),
        !state.cfg.import_off && !host.import_formats().is_empty(),
    );
    // OFF-01 (ADR-063): the person's offline generation, and a grant when this launch may keep
    // the canvas offline.
    let offline = crate::offline::session_json(
        &state,
        &host,
        &grant,
        host.wopi_only() || grant.wopi_history.is_some(),
    )
    .await
    .map_err(ApiError::internal)?;
    let mut body = json!({
        "offline": offline,
        "ai": {"enabled": !modes.is_empty(), "modes": modes, "mcp": super::mcp::mcp_enabled(&state, &host)},
        // docs/23 FC-10: what the editor may offer to import (empty: hide the entry).
        "import": {"formats": import_formats},
        "editor": editor,
        // UNF-01: link cards may ask the server for previews.
        "unfurl": super::unfurl::enabled(&state, &host),
        // TPL-01: whether the gallery shows "From your team" (applying needs the edit role).
        "templates": {"team": host.team_templates()},
        // SRCH-04 (ADR-065): "Search all canvases" only when the host has the callback.
        "search": {"enabled": state.search_probe.available(&host)},
        "ticket": ticket,
        "room": grant.room,
        "role": grant.role,
        "user": grant.user,
        "file": {"id": grant.file.id, "name": grant.file.name},
        "host": {"id": host.id, "name": host.name},
        // docs/30 §7: what this person may do with history (effective, role included).
        "perms": {
            "export": grant.perms.export, "download": grant.perms.download,
            "comment": grant.perms.comment && host.comments_on(), "print": grant.perms.print,
            "history": hist && grant.can_see_history(), "restore": hist && grant.can_restore(),
            "commitMessage": grant.can_name_version(),
        },
        // ADR-043: "ephemeral" = nothing is saved; users export to keep anything.
        "storage": if host.ephemeral() { "ephemeral" } else { "host" },
        // ADR-049: the wording of a temporary canvas ("meeting" | "room").
        "wording": host.temporary_wording(),
        // DGM-14 S9: the document limit; a diagram warns at 80 % of a quarter of it.
        "maxDocBytes": state.cfg.rooms.max_doc_bytes,
        // BSDK-01: the SDK block packages this host enables (type, version, schemas, bundle URL
        // on the block origin and its integrity); empty when none.
        "blocks": state.blocks.for_host(&host),
        "isNew": info.is_new,
        "wsUrl": ws_url(&state, &headers),
        "exp": exp,
        // LIVE-03 (ADR-069/070): whether live blocks show, and whether "Make live" may (the host
        // may still answer 501 to `POST /files`, and the editor then hides it for the session).
        "live": crate::live::session_json(&host, &grant),
    });
    if let (Some(b), Some(h)) = (body.as_object_mut(), history.as_object()) {
        b.extend(h.clone());
    }
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response())
}
