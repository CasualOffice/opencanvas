//! OpenCanvas server: launch, sessions, collaboration rooms, autosave and exports.

pub mod assets;
pub mod cluster;
pub mod config;
pub mod crypto;
pub mod grant;
pub mod host_client;
pub mod hosts;
pub mod jwt;
pub mod metrics;
pub mod notify;
pub mod pdf;
pub mod people;
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
    /// Members callback answers per room (docs/21 revision 2).
    pub members: Arc<people::Members>,
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
        let members = Arc::new(people::Members::default());
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
            members,
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
            // Cluster: claim the row first so two nodes never resend the same commit; the
            // room lease (taken by `open`) then keeps it on one node.
            if let Some(c) = self.rooms.cluster() {
                let now = util::now_ms();
                let claimed = self
                    .store
                    .outbox_claim(&row.id, &c.cfg.node_id, now, now + OUTBOX_CLAIM_MS)
                    .await?;
                if !claimed {
                    continue;
                }
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
                    ..Default::default()
                },
                file: grant::FileRef {
                    id: row.file_id.clone(),
                    name: row.file_id.clone(),
                    version: row.base_version.clone(),
                },
                perms: grant::Perms::default(),
                callback_token: row.token.clone(),
                members: vec![],
            };
            if !self.rooms.open(&host, &grant).await {
                continue;
            }
            tracing::info!(room = %row.room_id, attempts = row.attempts, "resuming pending commit");
            resumed.insert(row.room_id);
        }
        Ok(resumed.len())
    }
}

impl AppState {
    /// Notification sweeper (UX-02): sends every pending host notification due at `now_ms`
    /// (the first attempt failed, or the process restarted before it ran). Each row is claimed
    /// first, so two workers or nodes never send the same one. Returns how many were attempted.
    pub async fn deliver_notifications(&self, now_ms: i64) -> anyhow::Result<usize> {
        let mut attempted = 0;
        for row in self.store.notify_due(now_ms, 200).await? {
            if !self
                .store
                .notify_claim(&row.id, row.next_try_at, now_ms + notify::CLAIM_MS)
                .await?
            {
                continue;
            }
            let Some(host) = self.hosts.get(&row.host_id) else {
                tracing::warn!(host = %row.host_id, "notification for an unknown host dropped");
                self.store.notify_finish(&row.id, "failed").await?;
                continue;
            };
            notify::attempt(&self.store, &self.host, &host, &row, now_ms).await;
            attempted += 1;
        }
        Ok(attempted)
    }
}

pub use routes::router;

/// How long a cluster node keeps an outbox row it resumed before another node may.
const OUTBOX_CLAIM_MS: i64 = 60_000;

/// The full HTTP app: the public router plus, in cluster mode, the internal node-to-node
/// endpoints (never route `/v1/internal/` through the load balancer).
pub fn app(state: SharedState) -> axum::Router {
    let public = router(state.clone());
    if state.rooms.cluster().is_some() {
        public.merge(cluster::server::routes(state))
    } else {
        public
    }
}
