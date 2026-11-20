//! Environment configuration (docs/04 §7, docs/15 §7-8).

use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: String,
    pub public_url: Option<String>,
    pub database_url: String,
    pub hosts_file: PathBuf,
    pub web_dir: PathBuf,
    pub callback_base_override: Option<String>,
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
        }
    }
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn num(name: &str, default: u64) -> u64 {
    var(name).and_then(|v| v.parse().ok()).unwrap_or(default)
}

impl Config {
    pub fn from_env() -> Self {
        let d = RoomConfig::default();
        Self {
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
            rooms: RoomConfig {
                autosave_debounce: Duration::from_millis(num("OC_AUTOSAVE_DEBOUNCE_MS", 2000)),
                autosave_max: Duration::from_millis(num("OC_AUTOSAVE_MAX_MS", 10_000)),
                room_ttl: Duration::from_secs(num("OC_ROOM_TTL_SECS", 600)),
                max_frame_bytes: num("OC_MAX_FRAME_KB", 1024) as usize * 1024,
                max_doc_bytes: num("OC_MAX_DOC_MB", 20) as usize * 1024 * 1024,
                ..d
            },
        }
    }
}
