// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

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
    /// Redis-only storage (ADR-030): `REDIS_URL` set and `DATABASE_URL` not. Every piece of
    /// server state lives in this Redis (the WAL Redis); `database_url` is empty and unused.
    pub storage_redis_url: Option<String>,
    pub rooms: RoomConfig,
    /// The server's `[ai]` settings; `None` reads `OC_AI_CONFIG` / `OC_AI` at start-up.
    pub ai: Option<crate::ai::config::AiConfig>,
    /// `OC_IMPORT=off`: import is off for every host, whatever `[host.flags]` says.
    pub import_off: bool,
    /// `OC_UNFURL=off` and `OC_UNFURL_ALLOW_PRIVATE` (UNF-01).
    pub unfurl: crate::unfurl::UnfurlConfig,
    /// WOPI proof keys (`OC_WOPI_PROOF_KEY`, `OC_WOPI_PROOF_KEY_OLD`; generated with
    /// `OC_DEV=1`). Required when a host speaks WOPI.
    pub wopi_proof: Option<crate::proof::ProofKeys>,
    /// `OC_BLOCKS_DIR`, `OC_BLOCKS_ORIGIN` (BSDK-01, docs/05 §2).
    pub blocks: crate::blocks::BlocksConfig,
}

/// How edits reach the database between host saves (ADR-029, `OC_DURABILITY`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Durability {
    /// The default without Redis: no per-update write. The Y.Doc lives in memory and its
    /// encoded state is dumped to the database every `OC_DB_SYNC_MS` (2 s), before each host
    /// save and on close. A crash loses at most the edits since the last dump that no open
    /// client resends on reconnect.
    Memory,
    /// Every acknowledged edit is in the WAL (`room_updates`, or the Redis stream) before it
    /// is fanned out (ADR-028).
    Wal,
}

impl Durability {
    /// `OC_DURABILITY` (`memory` | `wal`); with a Redis WAL the hot WAL is always on.
    pub fn parse(v: Option<&str>, redis_wal: bool) -> anyhow::Result<Self> {
        if redis_wal {
            return Ok(Self::Wal);
        }
        match v.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
            None | Some("") | Some("memory") => Ok(Self::Memory),
            Some("wal") => Ok(Self::Wal),
            Some(other) => anyhow::bail!("OC_DURABILITY must be memory or wal, got {other:?}"),
        }
    }
}

/// The room cap: `OC_MAX_PEERS` (default [`MAX_PEERS`](crate::room::MAX_PEERS), 550),
/// clamped to 1..=[`MAX_PEERS_LIMIT`](crate::room::MAX_PEERS_LIMIT) (1,000).
pub fn max_peers(v: Option<&str>) -> usize {
    v.and_then(|v| v.trim().parse::<usize>().ok())
        .map_or(crate::room::MAX_PEERS, |n| {
            n.clamp(1, crate::room::MAX_PEERS_LIMIT)
        })
}

/// Idle eviction: `OC_ROOM_IDLE_MS` (default 60 s); the older `OC_ROOM_TTL_SECS` still works.
pub fn room_idle(idle_ms: Option<&str>, ttl_secs: Option<&str>) -> Duration {
    if let Some(ms) = idle_ms.and_then(|v| v.trim().parse::<u64>().ok()) {
        return Duration::from_millis(ms);
    }
    if let Some(s) = ttl_secs.and_then(|v| v.trim().parse::<u64>().ok()) {
        return Duration::from_secs(s);
    }
    DEFAULT_ROOM_IDLE
}

pub const DEFAULT_ROOM_IDLE: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct RoomConfig {
    /// PSYNC-02: a part nobody holds is evicted after this (30 s).
    pub part_evict: Duration,
    /// PSYNC-02: a whole view goes back to parts after this without server work (20 s).
    pub whole_release: Duration,
    /// PSYNC-BUG-2: a split room this large (its stored state, bytes) keeps its split when it
    /// closes clean, for a fast reopen (`OC_KEEP_SPLIT_MIN_BYTES`, default 4 MiB; smaller
    /// canvases cut in milliseconds and are purged as before).
    pub keep_split_min_bytes: usize,
    pub autosave_debounce: Duration,
    pub autosave_max: Duration,
    /// A room with no peers (and nothing unsaved) for this long is dropped from memory.
    pub room_ttl: Duration,
    pub durability: Durability,
    pub max_frame_bytes: usize,
    pub max_doc_bytes: usize,
    pub compact_every: u64,
    pub compact_interval: Duration,
    pub tick: Duration,
    /// Control `{"t":"ping"}` to every connection this often, so clients can tell a silent
    /// network drop from a quiet room (docs/15 §3; `OC_HEARTBEAT_MS`, default 10 s).
    pub heartbeat: Duration,
    /// Connections per room (`OC_MAX_PEERS`, default 550, at most 1,000; docs/22 §4).
    pub max_peers: usize,
    /// docs/30 §4: after this much editing since the last checkpoint, the next save is one again
    /// (`X-OpenCanvas-Checkpoint`; `OC_CHECKPOINT_MINUTES`, default 30).
    pub checkpoint_every: Duration,
    /// docs/30 §5: how long the person who restored a version may undo it (30 s).
    pub restore_undo_window: Duration,
}

impl Default for RoomConfig {
    fn default() -> Self {
        Self {
            part_evict: Duration::from_secs(30),
            whole_release: Duration::from_secs(20),
            keep_split_min_bytes: 4 * 1024 * 1024,
            autosave_debounce: Duration::from_millis(2000),
            autosave_max: Duration::from_millis(10_000),
            room_ttl: DEFAULT_ROOM_IDLE,
            durability: Durability::Memory,
            max_frame_bytes: 1024 * 1024,
            max_doc_bytes: 20 * 1024 * 1024,
            compact_every: 500,
            compact_interval: Duration::from_secs(30),
            tick: Duration::from_millis(250),
            heartbeat: Duration::from_secs(10),
            max_peers: crate::room::MAX_PEERS,
            checkpoint_every: Duration::from_secs(30 * 60),
            restore_undo_window: Duration::from_secs(30),
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
        let wopi_proof = crate::proof::ProofKeys::load(
            var("OC_WOPI_PROOF_KEY").as_deref(),
            var("OC_WOPI_PROOF_KEY_OLD").as_deref(),
            kek.as_ref(),
            dev,
        )?;
        let wal_redis = var("OC_WAL_REDIS_URL").or_else(|| var("REDIS_URL"));
        let database_url = var("DATABASE_URL");
        let storage_redis_url = storage_redis(
            var("REDIS_URL").is_some(),
            database_url.is_some(),
            wal_redis.as_deref(),
        );
        let durability = Durability::parse(var("OC_DURABILITY").as_deref(), wal_redis.is_some())?;
        let memory = durability == Durability::Memory;
        let public_url = var("OC_PUBLIC_URL").map(|u| u.trim_end_matches('/').to_string());
        let blocks = crate::blocks::BlocksConfig::from_env(public_url.as_deref())?;
        Ok(Self {
            blocks,
            bind: var("OC_BIND").unwrap_or_else(|| "0.0.0.0:8080".into()),
            public_url,
            database_url: match (&database_url, &storage_redis_url) {
                (Some(u), _) => u.clone(),
                (None, Some(_)) => String::new(),
                (None, None) => "sqlite://./data/opencanvas.db?mode=rwc".into(),
            },
            storage_redis_url,
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
            ai: None,
            wopi_proof,
            unfurl: crate::unfurl::UnfurlConfig::parse(
                var("OC_UNFURL").as_deref(),
                var("OC_UNFURL_ALLOW_PRIVATE").as_deref(),
            )?,
            import_off: var("OC_IMPORT").is_some_and(|v| v.trim().eq_ignore_ascii_case("off")),
            rooms: RoomConfig {
                compact_interval: if memory {
                    Duration::from_millis(num("OC_DB_SYNC_MS", 2_000).max(100))
                } else if wal_redis.is_some() {
                    Duration::from_millis(num("OC_DB_SYNC_MS", 5_000).max(100))
                } else {
                    d.compact_interval
                },
                // Memory mode dumps on time only: a busy room would otherwise dump its whole
                // state every few hundred keystrokes.
                compact_every: if memory {
                    u64::MAX
                } else if wal_redis.is_some() {
                    num("OC_DB_SYNC_UPDATES", 500).max(1)
                } else {
                    d.compact_every
                },
                autosave_debounce: Duration::from_millis(num("OC_AUTOSAVE_DEBOUNCE_MS", 2000)),
                autosave_max: Duration::from_millis(num("OC_AUTOSAVE_MAX_MS", 10_000)),
                room_ttl: room_idle(
                    var("OC_ROOM_IDLE_MS").as_deref(),
                    var("OC_ROOM_TTL_SECS").as_deref(),
                ),
                durability,
                max_frame_bytes: num("OC_MAX_FRAME_KB", 1024) as usize * 1024,
                max_doc_bytes: num("OC_MAX_DOC_MB", 20) as usize * 1024 * 1024,
                heartbeat: Duration::from_millis(num("OC_HEARTBEAT_MS", 10_000).max(1000)),
                keep_split_min_bytes: num("OC_KEEP_SPLIT_MIN_BYTES", 4 * 1024 * 1024) as usize,
                max_peers: max_peers(var("OC_MAX_PEERS").as_deref()),
                ..d
            },
        })
    }
}

/// Where state lives (ADR-030): a cluster (`REDIS_URL`) without `DATABASE_URL` keeps all of it
/// in the WAL Redis; anything else uses the database (SQLite by default).
pub fn storage_redis(cluster: bool, database: bool, wal_redis: Option<&str>) -> Option<String> {
    if cluster && !database {
        wal_redis.map(str::to_string)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cluster_without_database_url_stores_everything_in_redis() {
        let r = Some("redis://r:6379");
        assert_eq!(storage_redis(true, false, r).as_deref(), r);
        assert_eq!(storage_redis(true, true, r), None);
        assert_eq!(storage_redis(false, false, r), None);
        assert_eq!(storage_redis(false, true, None), None);
    }

    #[test]
    fn idle_eviction_defaults_to_a_minute_and_reads_oc_room_idle_ms() {
        assert_eq!(RoomConfig::default().room_ttl, Duration::from_secs(60));
        assert_eq!(room_idle(None, None), Duration::from_secs(60));
        assert_eq!(
            room_idle(Some("1500"), Some("600")),
            Duration::from_millis(1500)
        );
        assert_eq!(room_idle(None, Some("600")), Duration::from_secs(600));
    }

    #[test]
    fn the_room_cap_defaults_to_550_and_is_configurable_up_to_1000() {
        // PERF-11/R1K: the default stays 550 (owner, 2026-11-26); 1,000 is the most a server
        // may be configured to.
        assert_eq!(max_peers(None), 550);
        assert_eq!(RoomConfig::default().max_peers, 550);
        assert_eq!(max_peers(Some("1000")), 1000);
        assert_eq!(max_peers(Some(" 800 ")), 800);
        assert_eq!(max_peers(Some("5000")), 1000);
        assert_eq!(max_peers(Some("0")), 1);
        assert_eq!(max_peers(Some("lots")), 550);
    }

    #[test]
    fn durability_defaults_to_memory_without_redis() {
        assert_eq!(Durability::parse(None, false).unwrap(), Durability::Memory);
        assert_eq!(
            Durability::parse(Some("WAL"), false).unwrap(),
            Durability::Wal
        );
        assert_eq!(
            Durability::parse(Some("memory"), true).unwrap(),
            Durability::Wal
        );
        assert!(Durability::parse(Some("disk"), false).is_err());
        assert_eq!(RoomConfig::default().durability, Durability::Memory);
    }
}
