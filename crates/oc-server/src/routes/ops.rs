// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `/healthz`, `/readyz`, `/metrics`.

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
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
            "hosts": state.hosts.len(), "rooms": state.rooms.live_rooms(),
            "ai": state.ai_status
        })),
    )
}

/// Prometheus text. With `OC_METRICS_TOKEN` set it needs `Authorization: Bearer <token>`
/// (compared in constant time); without it, keep `/metrics` off the public listener.
pub async fn metrics(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    if let Some(want) = state.cfg.metrics_token.as_deref() {
        let got = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or_default();
        if !crate::util::same_secret(want, got) {
            return (StatusCode::UNAUTHORIZED, "metrics need the bearer token").into_response();
        }
    }
    let db = state.store.ping().await;
    let draining = state.rooms.draining();
    let scrape = crate::metrics::Scrape {
        ready: db && !draining,
        draining,
        outbox_pending: state.store.outbox_pending_count().await.ok(),
    };
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state.metrics.render_with(&scrape),
    )
        .into_response()
}
