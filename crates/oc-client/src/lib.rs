// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Rust client of the OpenCanvas headless API (`/api/v1`, docs/05 §7b and §7d).
//!
//! ```no_run
//! # async fn demo() -> opencanvas_client::Result<()> {
//! use opencanvas_client::{Auth, CallOptions, Client, models::{BatchOp, BatchRequest}};
//!
//! let oc = Client::builder("https://canvas.example.com")
//!     .auth(Auth::host_key("acme", "secret-key"))
//!     .build();
//! let doc = oc.read_file("doc_1", None).await?;
//! let req = BatchRequest {
//!     ops: vec![BatchOp { op: "append".into(), markdown: Some("Shipped.".into()), ..Default::default() }],
//!     ..Default::default()
//! };
//! oc.batch_blocks("doc_1", &req, &CallOptions::if_match(doc.rev.unwrap_or_default())).await?;
//! # Ok(()) }
//! ```
//!
//! Writes carry an `Idempotency-Key` (the same one on every retry); `429`, `503` and `409
//! IDEMPOTENCY_IN_PROGRESS` are retried after `Retry-After` through an injectable wait; error
//! answers are typed RFC 9457 problems ([`ApiError`], [`ProblemKind`]). The models and the
//! operation table are generated from `crates/oc-server/api/openapi.json` (`tests/models.rs`
//! fails when they drift).

mod client;
mod error;
mod events;
pub mod models;
mod webhooks;

pub use client::{
    ApiResponse, Auth, Body, CallOptions, Client, ClientBuilder, Params, RateLimit, Sleeper,
    parse_rate_limit,
};
pub use error::{ApiError, Error, ProblemKind, Result};
pub use events::{EventStream, EventsOptions, Frame, parse_frames};
pub use webhooks::{TOLERANCE_SECS, WebhookRequest, verify_webhook, verify_webhook_within};
