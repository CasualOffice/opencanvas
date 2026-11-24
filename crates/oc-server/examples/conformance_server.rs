// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The client conformance server (HAPI-06/07) as a process, for clients that cannot start it
//! in their own tests (the TypeScript client): prints one JSON line (`baseUrl`, host ids and
//! keys, the webhook secret) and serves until its standard input closes.
//!
//!   cargo run -p oc-server --example conformance_server

#[path = "../tests/common/mod.rs"]
mod common;
#[path = "../tests/conformance/server.rs"]
mod server;

use tokio::io::AsyncReadExt;

#[tokio::main]
async fn main() {
    let c = server::start().await;
    println!("{}", c.info);
    // Serve until the parent closes our stdin (or kills us).
    let mut sink = Vec::new();
    let _ = tokio::io::stdin().read_to_end(&mut sink).await;
}
