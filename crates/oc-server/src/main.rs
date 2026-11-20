use std::time::Duration;

use oc_server::config::Config;
use oc_server::hosts::Hosts;
use oc_server::util::now_secs;
use oc_server::{AppState, router};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let level = std::env::var("OC_LOG").unwrap_or_else(|_| "info".into());
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_new(&level).unwrap_or_else(|_| EnvFilter::new("info")))
        .json()
        .init();

    let cfg = Config::from_env()?;
    let hosts = Hosts::load(&cfg.hosts_file, cfg.callback_base_override.as_deref())?;
    if !cfg.web_dir.join("index.html").exists() {
        tracing::warn!(dir = %cfg.web_dir.display(), "web app not built; /app/ will 404");
    }
    let state = AppState::new(cfg.clone(), hosts).await?;

    let sweeper = state.clone();
    tokio::spawn(async move {
        // Startup sweep of commits that never reached the host, then a slow safety net.
        let mut every = tokio::time::interval(Duration::from_secs(60));
        loop {
            every.tick().await;
            match sweeper.resume_outbox().await {
                Ok(0) => {}
                Ok(n) => tracing::info!(rooms = n, "resumed pending commits"),
                Err(e) => tracing::warn!(error = %e, "outbox sweep failed"),
            }
        }
    });

    let janitor = state.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_secs(3600));
        loop {
            every.tick().await;
            if let Err(e) = janitor.store.purge_expired(now_secs()).await {
                tracing::warn!(error = %e, "session purge failed");
            }
        }
    });

    let listener = tokio::net::TcpListener::bind(&cfg.bind).await?;
    tracing::info!(bind = %cfg.bind, hosts = state.hosts.len(), "opencanvas listening");
    let rooms = state.rooms.clone();
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            tracing::info!("shutting down: saving dirty rooms");
            rooms.shutdown_all().await;
        })
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    let _ = ctrl_c.await;
}
