//! Environment configuration (docs/04 §7, docs/15 §7-8).

use std::path::PathBuf;
use std::time::Duration;

use crate::crypto::{Kek, load_kek};

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: String,
    pub public_url: Option<String>,
    pub database_url: String,
    pub hosts_file: PathBuf,
    pub web_dir: PathBuf,
    pub callback_base_override: Option<String>,
    /// `OC_PDF_RENDERER=gotenberg:<url>`: PDF export through a Gotenberg sidecar (ADR-010).
    pub pdf_renderer: Option<PdfRenderer>,
    /// Key-encryption key for secrets at rest; `None` only with `OC_DEV=1`.
    pub kek: Option<Kek>,
    /// `OC_METRICS_TOKEN`: when set, `/metrics` needs `Authorization: Bearer <token>`.
    pub metrics_token: Option<String>,
    /// `OC_WAL_REDIS_URL` (default: `REDIS_URL`): the hot WAL lives in Redis and the database
    /// gets a snapshot every `OC_DB_SYNC_MS` (5 s) or `OC_DB_SYNC_UPDATES` (500) updates (ADR-021).
    pub wal_redis_url: Option<String>,
    pub rooms: RoomConfig,
}

#[derive(Debug, Clone)]
pub struct RoomConfig {
    pub autosave_debounce: Duration,
    pub autosave_max: Duration,
    pub room_ttl: Duration,
    pub max_frame_bytes: usize,
    pub max_doc_bytes: usize,
    pub compact_every: u64,
    pub compact_interval: Duration,
    pub tick: Duration,
    /// Control `{"t":"ping"}` to every connection this often, so clients can tell a silent
    /// network drop from a quiet room (docs/15 §3; `OC_HEARTBEAT_MS`, default 10 s).
    pub heartbeat: Duration,
}

impl Default for RoomConfig {
    fn default() -> Self {
        Self {
            autosave_debounce: Duration::from_millis(2000),
            autosave_max: Duration::from_millis(10_000),
            room_ttl: Duration::from_secs(600),
            max_frame_bytes: 1024 * 1024,
            max_doc_bytes: 20 * 1024 * 1024,
            compact_every: 500,
            compact_interval: Duration::from_secs(30),
            tick: Duration::from_millis(250),
            heartbeat: Duration::from_secs(10),
        }
    }
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn num(name: &str, default: u64) -> u64 {
    var(name).and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Where PDFs are rendered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PdfRenderer {
    /// Gotenberg base URL (`POST <url>/forms/chromium/convert/html`).
    Gotenberg(String),
}

impl PdfRenderer {
    pub fn parse(v: &str) -> anyhow::Result<Self> {
        match v.trim().split_once(':') {
            Some(("gotenberg", url))
                if url.starts_with("http://") || url.starts_with("https://") =>
            {
                Ok(Self::Gotenberg(url.trim_end_matches('/').to_string()))
            }
            _ => anyhow::bail!("OC_PDF_RENDERER must be gotenberg:<http(s) url>, got {v:?}"),
        }
    }
}

impl Config {
    /// Reads the environment; fails when `OC_KEK` is missing or invalid (unless `OC_DEV=1`).
    pub fn from_env() -> anyhow::Result<Self> {
        let d = RoomConfig::default();
        let dev = var("OC_DEV").is_some_and(|v| v == "1" || v == "true");
        let kek = load_kek(var("OC_KEK").as_deref(), dev)?;
        if kek.is_none() {
            tracing::warn!("OC_DEV=1 and no OC_KEK: callback tokens are stored unencrypted");
        }
        let wal_redis = var("OC_WAL_REDIS_URL").or_else(|| var("REDIS_URL"));
        Ok(Self {
            bind: var("OC_BIND").unwrap_or_else(|| "0.0.0.0:8080".into()),
            public_url: var("OC_PUBLIC_URL").map(|u| u.trim_end_matches('/').to_string()),
            database_url: var("DATABASE_URL")
                .unwrap_or_else(|| "sqlite://./data/opencanvas.db?mode=rwc".into()),
            hosts_file: var("OC_HOSTS_FILE")
                .unwrap_or_else(|| "./opencanvas.hosts.toml".into())
                .into(),
            web_dir: var("OC_WEB_DIR")
                .unwrap_or_else(|| "web/packages/editor/dist".into())
                .into(),
            callback_base_override: var("OC_CALLBACK_BASE_OVERRIDE"),
            pdf_renderer: var("OC_PDF_RENDERER")
                .map(|v| PdfRenderer::parse(&v))
                .transpose()?,
            kek,
            metrics_token: var("OC_METRICS_TOKEN"),
            wal_redis_url: wal_redis.clone(),
            rooms: RoomConfig {
                compact_interval: if wal_redis.is_some() {
                    Duration::from_millis(num("OC_DB_SYNC_MS", 5_000).max(100))
                } else {
                    d.compact_interval
                },
                compact_every: if wal_redis.is_some() {
                    num("OC_DB_SYNC_UPDATES", 500).max(1)
                } else {
                    d.compact_every
                },
                autosave_debounce: Duration::from_millis(num("OC_AUTOSAVE_DEBOUNCE_MS", 2000)),
                autosave_max: Duration::from_millis(num("OC_AUTOSAVE_MAX_MS", 10_000)),
                room_ttl: Duration::from_secs(num("OC_ROOM_TTL_SECS", 600)),
                max_frame_bytes: num("OC_MAX_FRAME_KB", 1024) as usize * 1024,
                max_doc_bytes: num("OC_MAX_DOC_MB", 20) as usize * 1024 * 1024,
                heartbeat: Duration::from_millis(num("OC_HEARTBEAT_MS", 10_000).max(1000)),
                ..d
            },
        })
    }
}
