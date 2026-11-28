// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `opencanvas-workspace` (ADR-085 §2): the Workspace and the engine in one process on one port,
//! or one of them (`--role workspace | engine`) for the production compose file. This launcher
//! is the only place that uses the engine's code; the halves still talk over HTTP with the real
//! contract signatures (loopback in the single-process shape).
//!
//!   opencanvas-workspace [serve] [--role all|workspace|engine]
//!   opencanvas-workspace admin reset-password <email>     # prints a one-time reset link

use std::net::SocketAddr;

use oc_workspace::config::{Role, WsConfig};
use oc_workspace::secrets::Secrets;
use tracing_subscriber::EnvFilter;

#[cfg(feature = "jemalloc")]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

fn engine_config(cfg: &WsConfig) -> anyhow::Result<oc_server::config::Config> {
    let mut e = oc_server::config::Config::from_env()?;
    e.bind = cfg.bind.clone();
    if std::env::var("DATABASE_URL")
        .map(|v| v.trim().is_empty())
        .unwrap_or(true)
        && e.storage_redis_url.is_none()
    {
        e.database_url = format!("sqlite://{}/engine.db?mode=rwc", cfg.data_dir.display());
    }
    if std::env::var("OC_WEB_DIR").is_err() && std::path::Path::new("/srv/web/index.html").exists()
    {
        e.web_dir = "/srv/web".into();
    }
    if e.public_url.is_none() {
        e.public_url = cfg.public_url.clone();
    }
    Ok(e)
}

/// Data outside a mounted volume is lost with the container (acceptance §6.2).
fn warn_if_ephemeral(cfg: &WsConfig) {
    #[cfg(target_os = "linux")]
    if let Ok(mounts) = std::fs::read_to_string("/proc/self/mountinfo") {
        let dir = std::fs::canonicalize(&cfg.data_dir).unwrap_or(cfg.data_dir.clone());
        let mounted = mounts.lines().any(|l| {
            l.split(' ')
                .nth(4)
                .is_some_and(|m| std::path::Path::new(m) == dir)
        });
        if !mounted && std::path::Path::new("/.dockerenv").exists() {
            tracing::warn!(dir = %dir.display(), "DATA IS EPHEMERAL: no volume is mounted here, so everything is lost when the container is removed. Run with -v opencanvas:/data");
        }
    }
    let _ = cfg;
}

fn main() -> anyhow::Result<()> {
    let level = std::env::var("WS_LOG")
        .or_else(|_| std::env::var("OC_LOG"))
        .unwrap_or_else(|_| "info".into());
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_new(&level).unwrap_or_else(|_| EnvFilter::new("info")))
        .json()
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut role = std::env::var("WS_ROLE")
        .ok()
        .map(|r| Role::parse(&r))
        .transpose()?
        .unwrap_or(Role::All);
    let mut rest = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--role" => {
                role = Role::parse(args.get(i + 1).map(String::as_str).unwrap_or(""))?;
                i += 1;
            }
            "--version" | "-V" => {
                println!("opencanvas-workspace {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            other => rest.push(other.to_string()),
        }
        i += 1;
    }
    let cfg = WsConfig::from_env()?;
    std::fs::create_dir_all(&cfg.data_dir)?;
    let secrets = Secrets::load_or_create(&cfg.secrets_dir())?;
    // The engine reads its key from the environment; set it before any thread starts.
    if std::env::var("OC_KEK")
        .map(|v| v.trim().is_empty())
        .unwrap_or(true)
    {
        // SAFETY: single-threaded here: the runtime is built below.
        unsafe { std::env::set_var("OC_KEK", &secrets.kek_b64) };
    }
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(async move {
        match rest.first().map(String::as_str) {
            None | Some("serve") => serve(cfg, secrets, role).await,
            Some("admin") => admin(cfg, secrets, &rest[1..]).await,
            Some(other) => anyhow::bail!(
                "unknown command {other:?}; try serve, or admin reset-password <email>"
            ),
        }
    })
}

async fn admin(cfg: WsConfig, secrets: Secrets, args: &[String]) -> anyhow::Result<()> {
    match (args.first().map(String::as_str), args.get(1)) {
        (Some("reset-password"), Some(email)) => {
            let ws = oc_workspace::WsState::new(cfg, secrets).await?;
            let email = oc_workspace::auth::normalize_email(email)
                .ok_or_else(|| anyhow::anyhow!("not an e-mail address"))?;
            let uid: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE email = ?")
                .bind(&email)
                .fetch_optional(&ws.db.pool)
                .await?;
            let uid = uid.ok_or_else(|| anyhow::anyhow!("no account with that e-mail"))?;
            let url = oc_workspace::api::make_reset_link(&ws, &uid, None).await?;
            println!("Reset link for {email} (valid 24 hours, single use):\n{url}");
            Ok(())
        }
        _ => anyhow::bail!("usage: opencanvas-workspace admin reset-password <email>"),
    }
}

async fn serve(cfg: WsConfig, secrets: Secrets, role: Role) -> anyhow::Result<()> {
    let _ = oc_server::fdlimit::raise_nofile();
    tracing::info!(version = env!("CARGO_PKG_VERSION"), role = ?role, data = %cfg.data_dir.display(), "OpenCanvas Workspace by CasualOffice");
    warn_if_ephemeral(&cfg);
    // The Workspace first: the engine's host entry needs the public address chosen at setup.
    let ws = if role != Role::Engine {
        let ws = oc_workspace::WsState::new(cfg.clone(), secrets.clone()).await?;
        oc_workspace::jobs::spawn(ws.clone());
        Some(ws)
    } else {
        None
    };
    let public = match &ws {
        Some(w) => w.public_base().await,
        None => cfg.public_url.clone().unwrap_or_default(),
    };
    let engine = if role != Role::Workspace {
        let ecfg = engine_config(&cfg)?;
        let hosts = oc_server::hosts::Hosts::parse(
            &oc_workspace::engine::host_toml(&cfg, &secrets, &public),
            None,
        )?;
        Some(oc_server::build(ecfg, hosts).await?)
    } else {
        None
    };
    let rooms = engine.as_ref().map(|e| e.rooms.clone());
    let app = match ws {
        None => oc_server::app(engine.expect("engine")),
        Some(ws) => {
            if let Some(code) = ws.setup_code.lock().unwrap().clone() {
                let port = cfg.bind.rsplit(':').next().unwrap_or("8080").to_string();
                tracing::warn!(
                    url = %(if public.is_empty() { format!("http://localhost:{port}") } else { public.clone() }),
                    setup_code = %code,
                    "first run: open the URL and enter the setup code (not needed from the same machine)"
                );
            }
            tracing::warn!(
                "back up the data volume with its secrets/ folder: without it saved sessions cannot be read"
            );
            let router = oc_workspace::router(ws);
            match engine {
                Some(e) => router.fallback_service(oc_server::app(e)),
                None => router,
            }
        }
    };
    let listener = tokio::net::TcpListener::bind(&cfg.bind).await?;
    tracing::info!(bind = %cfg.bind, "ready");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        oc_server::shutdown_signal().await;
        if let Some(r) = rooms {
            tracing::info!("shutting down: saving open canvases");
            r.shutdown_all().await;
        }
    })
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_generated_host_entry_parses() {
        let dir = std::env::temp_dir();
        let cfg = WsConfig::for_tests(&dir);
        let h = oc_server::hosts::Hosts::parse(
            &oc_workspace::engine::host_toml(
                &cfg,
                &Secrets::for_tests(),
                "https://canvas.acme.example",
            ),
            None,
        )
        .unwrap();
        assert!(h.get("workspace").is_some());
    }
}
