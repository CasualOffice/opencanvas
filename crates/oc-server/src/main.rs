// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

use std::time::Duration;

use oc_server::cluster::{self, Cluster, ClusterConfig};
use oc_server::config::Config;
use oc_server::hosts::Hosts;
use oc_server::util::now_secs;
use oc_server::{AppState, app};
use tracing_subscriber::EnvFilter;

#[cfg(all(feature = "mimalloc", not(feature = "jemalloc")))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
#[cfg(feature = "jemalloc")]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let level = std::env::var("OC_LOG").unwrap_or_else(|_| "info".into());
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_new(&level).unwrap_or_else(|_| EnvFilter::new("info")))
        .json()
        .init();

    let cfg = Config::from_env()?;
    // REDIS_URL → cluster mode; refused on SQLite before anything else starts (ADR-004/006).
    let cluster_cfg = ClusterConfig::from_env(&cfg.database_url, &cfg.bind)?;
    let hosts = Hosts::load(&cfg.hosts_file, cfg.callback_base_override.as_deref())?;
    if !cfg.web_dir.join("index.html").exists() {
        tracing::warn!(dir = %cfg.web_dir.display(), "web app not built; /app/ will 404");
    }
    let state = AppState::new(cfg.clone(), hosts).await?;
    if let Some(cc) = cluster_cfg {
        let node = cc.node_id.clone();
        let advertise = cc.advertise.clone();
        let c = Cluster::connect(cc).await?;
        state.join_cluster(c.clone());
        cluster::spawn_renewer(state.rooms.clone(), c);
        tracing::info!(node = %node, advertise = %advertise, "cluster mode: room leases in Redis");
    }

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

    // Host notifications (@mentions) whose first call failed: retried with backoff.
    let notifier = state.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_secs(10));
        loop {
            every.tick().await;
            if let Err(e) = notifier
                .deliver_notifications(oc_server::util::now_ms())
                .await
            {
                tracing::warn!(error = %e, "notification sweep failed");
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
    axum::serve(listener, app(state))
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            tracing::info!("shutting down: saving dirty rooms, releasing leases");
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
