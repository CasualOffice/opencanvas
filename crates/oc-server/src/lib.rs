// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! OpenCanvas server: launch, sessions, collaboration rooms, autosave and exports.

pub mod ai;
pub mod alloc;
pub mod assets;
pub mod authz;
pub mod blocks;
pub mod clock;
pub mod cluster;
pub mod config;
pub mod crypto;
pub mod editor;
pub mod events;
pub mod grant;
pub mod history;
pub mod host_client;
pub mod hosts;
pub mod jwt;
pub mod live;
pub mod metrics;
pub mod notify;
pub mod offline;
pub mod pdf;
pub mod people;
pub mod proof;
pub mod ratelimit;
pub mod redis_store;
pub mod redis_wal;
pub mod room;
pub mod routes;
pub mod search;
pub mod store;
pub mod team_templates;
pub mod unfurl;
pub mod util;
pub mod webhooks;
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
    /// Host team-template lists (TPL-01), per host for a minute.
    pub team_templates: team_templates::ListCache,
    /// The server-wide AI switch as `"on"` or `"off (<reason>)"` (`/readyz`).
    pub ai_status: String,
    /// Link-preview fetcher, cache and rate limits (UNF-01).
    pub unfurl: unfurl::Unfurler,
    /// RND-01: rendered previews per room version (`GET /v1/preview`).
    pub previews: routes::preview::PreviewCache,
    /// API bookkeeping time (idempotency, rate limits, cursors); tests pin it.
    pub clock: Arc<clock::Clock>,
    /// VH-01b: version history caches (memory only).
    pub history: history::Caches,
    /// One limiter for the API and MCP (HAPI-04); in Redis when there is one.
    pub limiter: ratelimit::Limiter,
    /// Webhook delivery (WH-01): HTTP client and the worker's wake-up.
    pub webhooks: Arc<webhooks::Webhooks>,
    /// SRCH-03: hosts whose `GET /search` answered "not implemented" (entry hidden for a while).
    pub search_probe: search::Probe,
    /// Installed SDK block packages (BSDK-01) and the ones refused at start.
    pub blocks: Arc<blocks::Installed>,
    /// LIVE-02: connected live block rooms per parent session (at most `[host.live] max_open`).
    pub live_slots: Arc<live::OpenSlots>,
    /// OFF-01 (ADR-063): the ES256 key that signs offline grants.
    pub offline_key: offline::GrantKey,
}

#[derive(Clone, Copy)]
pub struct TicketUse {
    pub first_seen: Instant,
    pub connected: bool,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    /// The server-wide AI switch (docs/24 §7.3): `OC_AI_CONFIG` set, `[ai] enabled = true`
    /// and `OC_AI` not `off`. Off overrides every `[host.ai]`.
    pub fn ai_on(&self) -> bool {
        self.rooms.ctx().ai.is_some()
    }

    pub async fn new(cfg: Config, hosts: Hosts) -> anyhow::Result<SharedState> {
        let mut store = match &cfg.storage_redis_url {
            Some(url) => {
                let s = Store::connect_redis(url, cfg.kek.clone()).await?;
                tracing::info!(
                    "Redis-only storage (no DATABASE_URL): snapshots, WAL, epochs, outboxes, sessions and launch tokens in Redis; a snapshot every {:?} (ADR-030)",
                    cfg.rooms.compact_interval
                );
                s
            }
            None => Store::connect(&cfg.database_url, cfg.kek.clone()).await?,
        };
        if let Some(url) = cfg
            .wal_redis_url
            .as_ref()
            .filter(|_| !store.is_redis_only())
        {
            store = store.with_redis_wal(url).await?;
            tracing::info!(
                "hot WAL in Redis; the database gets a snapshot every {:?}",
                cfg.rooms.compact_interval
            );
        }
        crate::metrics::mark_start();
        let offline_key = offline::GrantKey::load(
            std::env::var("OC_OFFLINE_KEY").ok().as_deref(),
            cfg.kek.as_ref(),
        )?;
        // BSDK-01: block packages, installed for validation, exports and writes (oc_model::ext).
        let mut installed =
            blocks::Installed::load(&cfg.blocks)?.with_editor_origin(cfg.public_url.as_deref());
        installed.add_first_party();
        let blocks = Arc::new(installed);
        oc_model::ext::install(&blocks.registry);
        blocks::warn_missing(&blocks, &hosts);
        let metrics = Arc::new(Metrics::default());
        if cfg.wopi_proof.is_none() && hosts.iter().any(|h| h.accepts_wopi()) {
            anyhow::bail!(
                "a host speaks WOPI but there are no proof keys: set OC_WOPI_PROOF_KEY (PEM path, 2048-bit RSA; docs/05 §6.4) or OC_DEV=1"
            );
        }
        let host = HostClient::new()
            .with_metrics(metrics.clone())
            .with_store(store.clone())
            .with_proof(cfg.wopi_proof.clone());
        let members = Arc::new(people::Members::default());
        let ai_cfg = match cfg.ai.clone() {
            Some(c) => c,
            None => crate::ai::config::AiConfig::from_env()?,
        };
        // One line, once: the effective server-wide AI switch (docs/24 §7.3).
        tracing::info!("AI: {}", ai_cfg.status());
        let ai_status = ai_cfg.status();
        let ai = ai_cfg.enabled.then(|| {
            // The canvas tool layer is plugged in below, once the app state exists.
            let rt = crate::ai::agent::AiRuntime::new(ai_cfg, None, metrics.clone());
            let probe = rt.clone();
            tokio::spawn(async move { probe.probe_all().await });
            rt
        });
        if let Some(rt) = &ai {
            // The monthly quota counters live in the storage layer (survive restarts).
            rt.persist_quota(store.clone())
                .await
                .map_err(|e| anyhow::anyhow!("loading AI usage: {e:#}"))?;
        }
        let rooms = Rooms::new(Arc::new(Ctx {
            store: store.clone(),
            host: host.clone(),
            cfg: cfg.rooms.clone(),
            metrics: metrics.clone(),
            ai: ai.clone(),
            events: events::Hub::new(),
        }));
        if cfg.unfurl.off {
            tracing::info!("link unfurl: off (OC_UNFURL=off)");
        } else if !cfg.unfurl.allow_private.is_empty() {
            tracing::warn!(
                ranges = cfg.unfurl.allow_private.len(),
                "link unfurl may reach private addresses (OC_UNFURL_ALLOW_PRIVATE)"
            );
        }
        let unfurl = unfurl::Unfurler::new(cfg.unfurl.clone());
        let clock: Arc<clock::Clock> = Default::default();
        let webhooks: Arc<webhooks::Webhooks> = Default::default();
        let hooked: Vec<&str> = hosts
            .iter()
            .filter(|h| !h.webhooks.is_empty())
            .map(|h| h.id.as_str())
            .collect();
        if !hooked.is_empty() {
            if store.is_redis_only() {
                anyhow::bail!(
                    "[host.webhooks] ({}) needs a database for its outbox (DATABASE_URL: SQLite, MySQL or MariaDB); Redis-only storage has none (ADR-056)",
                    hooked.join(", ")
                );
            }
            webhooks::spawn_writer(
                &rooms.ctx().events,
                hosts.clone(),
                store.clone(),
                clock.clone(),
                webhooks.clone(),
            );
            tracing::info!(hosts = %hooked.join(", "), "webhooks on");
        }
        let limiter = ratelimit::Limiter::new(clock.clone(), store.redis_wal().map(|w| w.conn()));
        let state = Arc::new(Self {
            unfurl,
            cfg,
            hosts,
            store,
            host,
            rooms,
            metrics,
            jwks: jwt::Jwks::new(),
            tickets: Mutex::default(),
            members,
            ai_status,
            team_templates: Default::default(),
            previews: Default::default(),
            clock,
            history: Default::default(),
            limiter,
            webhooks,
            search_probe: Default::default(),
            blocks,
            live_slots: Default::default(),
            offline_key,
        });
        if let Some(rt) = &ai {
            // The agent edits through the same tool layer as MCP (docs/24 §5). Weak, so the
            // state -> rooms -> runtime -> tools chain is not a cycle.
            rt.set_tools(Arc::new(crate::ai::StateTools(Arc::downgrade(&state))));
        }
        // Purges what closed rooms freed on other threads (docs/22 §9.7); here rather than in
        // main so every embedder and test server gets it.
        crate::alloc::spawn_sweeper();
        Ok(state)
    }
}

impl AppState {
    /// This node's change events (HAPI-05).
    pub fn events(&self) -> &Arc<events::Hub> {
        &self.rooms.ctx().events
    }

    /// Switches to cluster mode (once, before serving): rooms get one owner node, and member
    /// events from other nodes are applied here as they arrive.
    pub fn join_cluster(&self, cluster: Arc<cluster::Cluster>) {
        self.rooms.set_cluster(cluster.clone());
        cluster::spawn_events(self.events().clone(), cluster.clone());
        cluster::spawn_members_listener(self.members.clone(), cluster);
    }

    /// Applies a member change (revoke, restore, invalidate) here and, in a cluster, on every
    /// other node (docs/21 revision 2: revocation is authoritative cluster-wide).
    pub async fn members_event(&self, ev: cluster::bus::MembersEvent) {
        ev.apply(&self.members);
        if let Some(c) = self.rooms.cluster() {
            c.publish_members(&ev).await;
        }
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
                ext_blocks: false,
                live: Default::default(),
                wopi_history: None,
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

impl AppState {
    /// Webhook worker (WH-01, ADR-056): sends every delivery due at `now_ms` (server clock),
    /// at most 8 at a time. Each row is claimed first, so one node sends each attempt.
    /// Returns how many were attempted.
    pub async fn deliver_webhooks(&self, now_ms: i64) -> anyhow::Result<usize> {
        use futures::StreamExt;
        let mut claimed = Vec::new();
        for row in self.store.webhook_due(now_ms, webhooks::SWEEP_ROWS).await? {
            if self
                .store
                .webhook_claim(&row.id, row.next_try_at, now_ms + webhooks::CLAIM_MS)
                .await?
            {
                claimed.push(row);
            }
        }
        let n = claimed.len();
        futures::stream::iter(claimed)
            .for_each_concurrent(webhooks::PARALLEL, |row| async move {
                let host = self.hosts.get(&row.host_id);
                self.webhooks
                    .attempt(&self.store, &self.metrics, host.as_deref(), &row, now_ms)
                    .await;
            })
            .await;
        Ok(n)
    }

    /// True when some host has `[host.webhooks]`.
    pub fn webhooks_on(&self) -> bool {
        self.hosts.iter().any(|h| !h.webhooks.is_empty())
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
