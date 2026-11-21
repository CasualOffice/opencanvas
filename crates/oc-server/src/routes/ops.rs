//! `/healthz`, `/readyz`, `/metrics`.

use axum::Json;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use serde_json::json;

use crate::SharedState;

pub async fn healthz() -> impl IntoResponse {
    Json(json!({"ok": true, "version": env!("CARGO_PKG_VERSION")}))
}

pub async fn readyz(State(state): State<SharedState>) -> impl IntoResponse {
    let db = state.store.ping().await;
    // A draining node (SIGTERM) must leave the load balancer before its rooms move on.
    let draining = state.rooms.draining();
    let ok = db && !draining;
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({
            "ok": ok, "db": db, "draining": draining,
            "hosts": state.hosts.len(), "rooms": state.rooms.live_rooms()
        })),
    )
}

pub async fn metrics(State(state): State<SharedState>) -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state.metrics.render(),
    )
}
