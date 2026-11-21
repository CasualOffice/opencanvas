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
}

impl HostStats {
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
}

pub fn kind_of(file: &str) -> DocKind {
    if file.starts_with("demo_") {
        DocKind::Demo
    } else if file.starts_with("big_") {
        DocKind::Big
    } else {
        DocKind::Empty
    }
}

async fn load(State(ctx): State<Arc<Ctx>>, Path(file): Path<String>) -> Response {
    ctx.stats.loads.fetch_add(1, Ordering::Relaxed);
    let bytes = match kind_of(&file) {
        DocKind::Empty => None,
        DocKind::Demo => ctx.demo.clone(),
        DocKind::Big => ctx.big.clone(),
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
    s.saves.fetch_add(1, Ordering::Relaxed);
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
    });
    let app = Router::new()
        .route("/api/files/{id}", get(load).put(save))
        .layer(DefaultBodyLimit::disable())
        .with_state(ctx);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(())
}
