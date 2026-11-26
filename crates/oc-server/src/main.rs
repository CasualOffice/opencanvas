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
    // `opencanvas seal-proof-key < key.pem`: prints the WOPI proof key sealed with OC_KEK, for
    // a file OC_WOPI_PROOF_KEY / OC_WOPI_PROOF_KEY_OLD can point at (docs/05 §6.4).
    if std::env::args().nth(1).as_deref() == Some("seal-proof-key") {
        let mut pem = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut pem)?;
        oc_server::proof::ProofKeys::from_pem(&pem, None)?;
        let kek = oc_server::crypto::Kek::from_b64(
            &std::env::var("OC_KEK").map_err(|_| anyhow::anyhow!("OC_KEK is required"))?,
        )?;
        println!("{}", kek.seal(pem.trim(), oc_server::proof::SEAL_AAD));
        return Ok(());
    }
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
    oc_server::routes::mcp::warn_if_unreachable(&state);
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

    // Webhooks (WH-01): due deliveries at once when a row is queued, else every 5 s.
    if state.webhooks_on() {
        let worker = state.clone();
        tokio::spawn(async move {
            let mut full = false;
            loop {
                // A full sweep leaves more due rows: take the next batch at once (SEC-48).
                if !full {
                    tokio::select! {
                        _ = worker.webhooks.wake.notified() => {}
                        _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                    }
                }
                full = match worker.deliver_webhooks(worker.clock.now_ms()).await {
                    Ok(n) => n as i64 >= oc_server::webhooks::SWEEP_ROWS,
                    Err(e) => {
                        tracing::warn!(error = %e, "webhook sweep failed");
                        false
                    }
                };
            }
        });
    }

    // Automation (AUTO-03): due date and schedule rules, checked every 20 s on every node.
    if oc_server::automation::worker::any_on(&state) {
        let worker = state.clone();
        let node = state
            .rooms
            .cluster()
            .map(|c| c.cfg.node_id.clone())
            .unwrap_or_else(|| "single".into());
        tokio::spawn(async move {
            let mut every = tokio::time::interval(Duration::from_secs(20));
            loop {
                every.tick().await;
                if let Err(e) = oc_server::automation::worker::sweep(&worker, &node).await {
                    tracing::warn!(error = %e, "automation sweep failed");
                }
            }
        });
    }

    let janitor = state.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_secs(3600));
        loop {
            every.tick().await;
            if let Err(e) = janitor.store.purge_expired(now_secs()).await {
                tracing::warn!(error = %e, "session purge failed");
            }
            oc_server::automation::worker::purge(&janitor).await;
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
