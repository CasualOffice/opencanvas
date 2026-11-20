//! OpenCanvas server: launch, sessions, collaboration rooms, autosave and exports.

pub mod config;
pub mod grant;
pub mod host_client;
pub mod hosts;
pub mod jwt;
pub mod metrics;
pub mod room;
pub mod routes;
pub mod store;
pub mod util;

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
        let store = Store::connect(&cfg.database_url).await?;
        let metrics = Arc::new(Metrics::default());
        let host = HostClient::new();
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
            tickets: Mutex::default(),
        }))
    }
}

pub use routes::router;
