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
    let status = if db {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(
            json!({"ok": db, "db": db, "hosts": state.hosts.len(), "rooms": state.rooms.live_rooms()}),
        ),
    )
}

pub async fn metrics(State(state): State<SharedState>) -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state.metrics.render(),
    )
}
