// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! A tiny in-process host (docs/15 §5) so the host never bottlenecks a run: `GET /files/{id}`
//! answers a pre-built seed document (or 404 = new file) and `PUT /files/{id}` answers 200 at
//! once. Signatures are not checked; the bench host entry is local only.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;

use crate::docs::{DocKind, ocanvas};

#[derive(Default)]
pub struct HostStats {
    pub loads: AtomicU64,
    pub saves: AtomicU64,
    pub save_bytes: AtomicU64,
    /// fileId → when the oldest edit not yet seen in a save was sent.
    pub unsaved_since: Mutex<HashMap<String, Instant>>,
    /// Per save: ms from the oldest unsaved edit to the PUT arriving (autosave lag).
    pub save_lag_ms: Mutex<Vec<u32>>,
    version: AtomicU64,
    /// Added delay per callback, ms range (0,0 = answer at once): a host with realistic latency.
    pub latency_ms: Mutex<(u64, u64)>,
    /// Keep every file's latest save and serve it on load (crash/cluster verification).
    pub store: std::sync::atomic::AtomicBool,
    pub stored: Mutex<HashMap<String, Vec<u8>>>,
    /// Saves received after `mark` was set: fileId -> (when, bytes) of the first one.
    pub mark: Mutex<Option<Instant>>,
    pub first_after_mark: Mutex<HashMap<String, (Instant, Vec<u8>)>>,
}

impl HostStats {
    async fn delay(&self) {
        let (lo, hi) = *self.latency_ms.lock().expect("lock");
        if hi > 0 {
            let span = hi.saturating_sub(lo) + 1;
            let r = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.subsec_nanos() as u64);
            tokio::time::sleep(std::time::Duration::from_millis(lo + r % span)).await;
        }
    }

    /// Called by editors when they send an update for `file`.
    pub fn edited(&self, file: &str) {
        let mut m = self.unsaved_since.lock().expect("lock");
        if !m.contains_key(file) {
            m.insert(file.to_string(), Instant::now());
        }
    }
}

struct Ctx {
    stats: Arc<HostStats>,
    demo: Option<Vec<u8>>,
    big: Option<Vec<u8>>,
    /// Benchmark fixtures, read from `OC_BENCH_FIXTURES` (`canvas-<kind>.ocanvas`, written by
    /// `oc-bench fixture`) or generated on first use.
    fixtures: Mutex<HashMap<&'static str, Arc<Vec<u8>>>>,
}

/// The seed a file id asks for: its prefix before the first `_` (`demo_…`, `m_…`, `50mb_…`).
pub fn kind_of(file: &str) -> DocKind {
    file.split('_')
        .next()
        .and_then(|k| DocKind::parse(k).ok())
        .unwrap_or(DocKind::Empty)
}

fn fixture_bytes(ctx: &Ctx, kind: DocKind) -> Option<Arc<Vec<u8>>> {
    let mut m = ctx.fixtures.lock().expect("lock");
    if let Some(b) = m.get(kind.name()) {
        return Some(b.clone());
    }
    let dir = std::env::var("OC_BENCH_FIXTURES").unwrap_or_else(|_| "bench/fixtures".into());
    let path = std::path::Path::new(&dir).join(format!("canvas-{}.ocanvas", kind.name()));
    let b = Arc::new(match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => ocanvas(kind).ok()??,
    });
    m.insert(kind.name(), b.clone());
    Some(b)
}

async fn load(State(ctx): State<Arc<Ctx>>, Path(file): Path<String>) -> Response {
    ctx.stats.loads.fetch_add(1, Ordering::Relaxed);
    ctx.stats.delay().await;
    let kept = ctx.stats.stored.lock().expect("lock").get(&file).cloned();
    if let Some(b) = kept {
        return (
            [
                (header::CONTENT_TYPE, "application/vnd.opencanvas+zip"),
                (header::ETAG, "\"1\""),
            ],
            b,
        )
            .into_response();
    }
    let bytes = match kind_of(&file) {
        DocKind::Empty => None,
        DocKind::Demo => ctx.demo.clone(),
        DocKind::Big => ctx.big.clone(),
        // The fixture task is blocking (a 50 MB read or generation), off the async workers.
        k => {
            let c = ctx.clone();
            tokio::task::spawn_blocking(move || fixture_bytes(&c, k))
                .await
                .ok()
                .flatten()
                .map(|b| b.to_vec())
        }
    };
    match bytes {
        None => StatusCode::NOT_FOUND.into_response(),
        Some(b) => (
            [
                (header::CONTENT_TYPE, "application/vnd.opencanvas+zip"),
                (header::ETAG, "\"1\""),
            ],
            b,
        )
            .into_response(),
    }
}

async fn save(State(ctx): State<Arc<Ctx>>, Path(file): Path<String>, body: Bytes) -> Response {
    let s = &ctx.stats;
    s.delay().await;
    s.saves.fetch_add(1, Ordering::Relaxed);
    if s.store.load(Ordering::Relaxed) {
        if s.mark.lock().expect("lock").is_some() {
            s.first_after_mark
                .lock()
                .expect("lock")
                .entry(file.clone())
                .or_insert_with(|| (Instant::now(), body.to_vec()));
        }
        s.stored
            .lock()
            .expect("lock")
            .insert(file.clone(), body.to_vec());
    }
    s.save_bytes.fetch_add(body.len() as u64, Ordering::Relaxed);
    if let Some(t) = s.unsaved_since.lock().expect("lock").remove(&file) {
        s.save_lag_ms
            .lock()
            .expect("lock")
            .push(t.elapsed().as_millis() as u32);
    }
    let v = s.version.fetch_add(1, Ordering::Relaxed) + 2;
    (
        [(header::CONTENT_TYPE, "application/json")],
        format!("{{\"version\":\"{v}\"}}"),
    )
        .into_response()
}

pub async fn serve(port: u16, stats: Arc<HostStats>) -> anyhow::Result<()> {
    let ctx = Arc::new(Ctx {
        stats,
        demo: ocanvas(DocKind::Demo)?,
        big: ocanvas(DocKind::Big)?,
        fixtures: Mutex::default(),
    });
    let app = Router::new()
        .route("/api/files/{id}", get(load).put(save))
        .layer(DefaultBodyLimit::disable())
        .with_state(ctx);
    // `OC_BENCH_HOST_BIND=0.0.0.0` when the servers run on other machines (docs/22 §12.1).
    let ip = std::env::var("OC_BENCH_HOST_BIND").unwrap_or_else(|_| "127.0.0.1".into());
    let listener = tokio::net::TcpListener::bind((ip.as_str(), port)).await?;
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(())
}
