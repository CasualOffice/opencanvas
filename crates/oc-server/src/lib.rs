//! OpenCanvas server: launch, sessions, collaboration rooms, autosave and exports.

pub mod assets;
pub mod config;
pub mod crypto;
pub mod grant;
pub mod host_client;
pub mod hosts;
pub mod jwt;
pub mod metrics;
pub mod pdf;
pub mod room;
pub mod routes;
pub mod store;
pub mod util;
pub mod wopi;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use config::Config;
use host_client::HostClient;
use hosts::Hosts;
use metrics::Metrics;
use room::{Ctx, Rooms};
use store::Store;

pub struct AppState {
    pub cfg: Config,
    pub hosts: Hosts,
    pub store: Store,
    pub host: HostClient,
    pub rooms: Arc<Rooms>,
    pub metrics: Arc<Metrics>,
    /// Launch-token verification incl. the JWKS cache.
    pub jwks: jwt::Jwks,
    /// First `GET /v1/sessions` per ticket, for the 60 s WebSocket connect window.
    pub tickets: Mutex<HashMap<String, TicketUse>>,
}

#[derive(Clone, Copy)]
pub struct TicketUse {
    pub first_seen: Instant,
    pub connected: bool,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub async fn new(cfg: Config, hosts: Hosts) -> anyhow::Result<SharedState> {
        let store = Store::connect(&cfg.database_url, cfg.kek.clone()).await?;
        let metrics = Arc::new(Metrics::default());
        let host = HostClient::new().with_store(store.clone());
        let rooms = Rooms::new(Arc::new(Ctx {
            store: store.clone(),
            host: host.clone(),
            cfg: cfg.rooms.clone(),
            metrics: metrics.clone(),
        }));
        Ok(Arc::new(Self {
            cfg,
            hosts,
            store,
            host,
            rooms,
            metrics,
            jwks: jwt::Jwks::new(),
            tickets: Mutex::default(),
        }))
    }
}

impl AppState {
    /// Startup sweeper: reopens every room that has a pending commit so its save is retried
    /// (with the same idempotency key). Returns how many rooms were resumed.
    pub async fn resume_outbox(&self) -> anyhow::Result<usize> {
        // WOPI-mode assets of rooms that closed (and have nothing left to save).
        if let Err(e) = self
            .store
            .purge_orphan_assets(util::now_ms() - 10 * 60 * 1000)
            .await
        {
            tracing::warn!(error = %e, "asset sweep failed");
        }
        let mut resumed = std::collections::HashSet::new();
        for row in self.store.outbox_all_pending().await? {
            if resumed.contains(&row.room_id) || self.rooms.is_live(&row.room_id) {
                continue;
            }
            let Some(host) = self.hosts.get(&row.host_id) else {
                tracing::warn!(room = %row.room_id, host = %row.host_id, "pending commit for an unknown host");
                continue;
            };
            let grant = grant::Grant {
                host_id: row.host_id.clone(),
                room: row.room_id.clone(),
                role: grant::Role::Edit,
                user: grant::User {
                    id: "opencanvas".into(),
                    name: "OpenCanvas".into(),
                    color: "#71717a".into(),
                    avatar: None,
                },
                file: grant::FileRef {
                    id: row.file_id.clone(),
                    name: row.file_id.clone(),
                    version: row.base_version.clone(),
                },
                perms: grant::Perms::default(),
                callback_token: row.token.clone(),
            };
            tracing::info!(room = %row.room_id, attempts = row.attempts, "resuming pending commit");
            self.rooms.open(&host, &grant);
            resumed.insert(row.room_id);
        }
        Ok(resumed.len())
    }
}

pub use routes::router;
