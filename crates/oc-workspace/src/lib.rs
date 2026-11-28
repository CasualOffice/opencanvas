// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! OpenCanvas Workspace by CasualOffice (ADR-085, docs/40): a first-party host that owns
//! people, sign-in, workspaces, folders, canvases, access, search, trash and version history.
//! It speaks to the engine only through the docs/05 host contract: launch tokens, signed
//! callbacks and the REST API. This library never uses the engine's code; only the launcher
//! (`src/main.rs`) starts the engine in the same process.
//!
//! Routes (docs/40 §8): `/` and `/ws/*` (the web app), `/api/ws/*` (its API), `/api/ws/oc/*`
//! (the engine's callbacks). Everything else belongs to the engine.

pub mod access;
pub mod api;
pub mod api_admin;
pub mod api_files;
pub mod auth;
pub mod callbacks;
pub mod config;
pub mod db;
pub mod engine;
pub mod jobs;
pub mod model;
pub mod passkeys;
pub mod search;
pub mod secrets;
pub mod settings;
pub mod setup;
pub mod storage;
pub mod util;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;

pub struct WsState {
    pub cfg: config::WsConfig,
    pub db: db::Db,
    pub files: storage::Files,
    pub secrets: secrets::Secrets,
    pub acl: access::AclCache,
    pub engine: engine::EngineClient,
    pub limiter: auth::Limiter,
    /// The one-time setup code while setup is open (docs/40 §4.1).
    pub setup_code: Mutex<Option<String>>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

pub type Ws = Arc<WsState>;

impl WsState {
    pub async fn new(cfg: config::WsConfig, secrets: secrets::Secrets) -> anyhow::Result<Ws> {
        let db = db::Db::connect(&cfg.database_url).await?;
        let files = storage::Files::new(&cfg.files_dir())?;
        let engine =
            engine::EngineClient::new(&cfg.engine_url, &cfg.host_id, &secrets.host_api_key);
        let ws = Arc::new(Self {
            cfg,
            db,
            files,
            secrets,
            acl: access::AclCache::default(),
            engine,
            limiter: auth::Limiter::default(),
            setup_code: Mutex::new(None),
            locks: Mutex::new(HashMap::new()),
        });
        if !setup::is_done(&ws).await? {
            let code = setup::new_code();
            *ws.setup_code.lock().unwrap() = Some(code);
        }
        Ok(ws)
    }

    /// One writer per canvas at a time (saves and copies).
    pub fn canvas_lock(&self, canvas: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut m = self.locks.lock().unwrap();
        if m.len() > 10_000 {
            m.retain(|_, l| Arc::strong_count(l) > 1);
        }
        m.entry(canvas.to_string()).or_default().clone()
    }

    /// The public address (operator, then setup), without a trailing slash; empty = relative.
    pub async fn public_base(&self) -> String {
        if let Some(u) = &self.cfg.public_url {
            return u.clone();
        }
        self.db
            .meta("public_url")
            .await
            .ok()
            .flatten()
            .unwrap_or_default()
    }

    pub async fn secure_cookies(&self) -> bool {
        match self.cfg.secure_cookies {
            Some(v) => v,
            None => self.public_base().await.starts_with("https://"),
        }
    }
}

async fn csrf(State(ws): State<Ws>, req: Request, next: Next) -> Response {
    let public = ws.public_base().await;
    if !auth::csrf_ok(
        req.method(),
        req.headers(),
        (!public.is_empty()).then_some(public.as_str()),
    ) {
        return auth::forbidden_csrf().into_response();
    }
    next.run(req).await
}

async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.entry(header::X_CONTENT_TYPE_OPTIONS)
        .or_insert(header::HeaderValue::from_static("nosniff"));
    h.entry(header::REFERRER_POLICY)
        .or_insert(header::HeaderValue::from_static("same-origin"));
    h.entry(header::CACHE_CONTROL)
        .or_insert(header::HeaderValue::from_static("no-store"));
    res
}

async fn healthz() -> &'static str {
    "ok"
}

async fn readyz(State(ws): State<Ws>) -> Response {
    match sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&ws.db.pool)
        .await
    {
        Ok(_) => (StatusCode::OK, "ready").into_response(),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, "database unavailable").into_response(),
    }
}

async fn asset(
    State(ws): State<Ws>,
    axum::extract::Path(aid): axum::extract::Path<String>,
) -> Response {
    callbacks::serve_asset(&ws, &aid).await
}

/// The web app: files from `web_dir`, `index.html` for every client route.
async fn web(State(ws): State<Ws>, req: Request) -> Response {
    let path = req
        .uri()
        .path()
        .trim_start_matches("/ws")
        .trim_start_matches('/');
    let dir = ws.cfg.web_dir.clone();
    let safe = !path.split('/').any(|p| p == ".." || p.starts_with('.'));
    let file = if safe && !path.is_empty() {
        dir.join(path)
    } else {
        dir.join("index.html")
    };
    let file = if file.is_file() {
        file
    } else {
        dir.join("index.html")
    };
    match tokio::fs::read(&file).await {
        Ok(b) => {
            let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("");
            let ctype = match ext {
                "html" => "text/html; charset=utf-8",
                "js" | "mjs" => "text/javascript; charset=utf-8",
                "css" => "text/css; charset=utf-8",
                "svg" => "image/svg+xml",
                "png" => "image/png",
                "woff2" => "font/woff2",
                "json" | "webmanifest" => "application/json",
                "ico" => "image/x-icon",
                _ => "application/octet-stream",
            };
            let cache = if ext == "html" { "no-cache" } else if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "public, max-age=3600" };
            ([(header::CONTENT_TYPE, ctype), (header::CACHE_CONTROL, cache)], b).into_response()
        }
        Err(_) => (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            "<!doctype html><meta charset=utf-8><title>OpenCanvas Workspace</title><p>OpenCanvas Workspace is running. The web app is not built in this copy (WS_WEB_DIR).</p>",
        )
            .into_response(),
    }
}

/// The Workspace's routes. The launcher puts the engine behind them as the fallback.
pub fn router(ws: Ws) -> Router {
    let api = Router::new()
        .merge(api::router())
        .merge(api_files::router())
        .merge(api_admin::router())
        .merge(passkeys::router())
        .layer(middleware::from_fn_with_state(ws.clone(), csrf));
    Router::new()
        .route("/", get(|| async { Redirect::temporary("/ws/") }))
        .route("/ws", get(|| async { Redirect::permanent("/ws/") }))
        .route("/ws/", get(web))
        .route("/ws/{*path}", get(web))
        .route("/api/ws/healthz", get(healthz))
        .route("/api/ws/readyz", get(readyz))
        .route("/api/ws/assets/{aid}", get(asset))
        .nest("/api/ws/oc", callbacks::router())
        .nest("/api/ws", api)
        .layer(middleware::from_fn(security_headers))
        .with_state(ws)
}

/// True for paths the Workspace answers; everything else goes to the engine (docs/40 §8).
pub fn owns_path(path: &str) -> bool {
    path == "/"
        || path == "/ws"
        || path.starts_with("/ws/")
        || path == "/api/ws"
        || path.starts_with("/api/ws/")
}
