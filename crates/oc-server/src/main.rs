// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

use tracing_subscriber::EnvFilter;

#[cfg(all(feature = "mimalloc", not(feature = "jemalloc")))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
#[cfg(feature = "jemalloc")]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // `opencanvas seal-proof-key < key.pem`: prints the WOPI proof key sealed with OC_KEK, for
    // a file OC_WOPI_PROOF_KEY / OC_WOPI_PROOF_KEY_OLD can point at (docs/05 §6.4).
    if std::env::args().nth(1).as_deref() == Some("seal-proof-key") {
        let mut pem = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut pem)?;
        oc_server::proof::ProofKeys::from_pem(&pem, None)?;
        let kek = oc_server::crypto::Kek::from_b64(
            &std::env::var("OC_KEK").map_err(|_| anyhow::anyhow!("OC_KEK is required"))?,
        )?;
        println!("{}", kek.seal(pem.trim(), oc_server::proof::SEAL_AAD));
        return Ok(());
    }
    let level = std::env::var("OC_LOG").unwrap_or_else(|_| "info".into());
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_new(&level).unwrap_or_else(|_| EnvFilter::new("info")))
        .json()
        .init();
    // One fd per WebSocket (PERF-11): use the hard limit, not a 256/1,024 soft default.
    match oc_server::fdlimit::raise_nofile() {
        Some((before, after)) if after < 16_384 => {
            tracing::warn!(
                before,
                after,
                "open-file limit is low; raise the hard limit (nofile) above the connection count"
            )
        }
        Some((before, after)) => tracing::info!(before, after, "open-file limit"),
        None => {}
    }

    oc_server::serve_from_env().await
}
