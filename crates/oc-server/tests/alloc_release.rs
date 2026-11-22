//! Memory goes back to the OS when rooms are evicted (docs/22 §9.6, PERF-07). With the system
//! allocator the freed Y.Docs stayed resident (RSS ≈ 1 GB with no room open after S2).
mod common;

use std::time::Duration;

use common::*;
use oc_server::grant::{Role, room_id};
use oc_server::room::protocol;
use yrs::{Doc, Map, ReadTxn, StateVector, Transact};

#[cfg(all(feature = "mimalloc", not(feature = "jemalloc")))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
#[cfg(feature = "jemalloc")]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

fn rss_mb() -> f64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<f64>()
        .expect("rss")
        / 1024.0
}

/// One update of `n` drag-like x/y overwrites (each leaves a dead yrs item that cannot merge
/// with its neighbour, ≈ 210 heap bytes, §9.5).
fn overwrites(n: usize) -> Vec<u8> {
    let doc = Doc::new();
    let shape = doc.get_or_insert_map("boards");
    for i in 0..n {
        let key = if i % 2 == 0 { "x" } else { "y" };
        shape.insert(&mut doc.transact_mut(), key, i as f64);
    }
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "PERF-07 open: about 110 MB stays live after 24 rooms close and an explicit purge frees nothing (docs/22 §9.6)"]
async fn rss_falls_after_rooms_are_evicted() {
    const ROOMS: usize = 24;
    let (base, _host) = mock_host().await;
    let idle = oc_server::config::room_idle(Some("200"), None);
    let state = app(
        &base,
        oc_server::config::RoomConfig {
            room_ttl: idle,
            durability: oc_server::config::Durability::Memory,
            ..room_cfg()
        },
    )
    .await;
    let update = overwrites(20_000);
    let before = rss_mb();
    let mut peers = vec![];
    for r in 0..ROOMS {
        let mut g = grant(&format!("u_{r}"), Role::Edit);
        g.file.id = format!("mem_{r}");
        g.room = room_id("sample", &g.file.id);
        let mut p = Peer::join(&state, g).await;
        p.settle().await;
        p.send(protocol::update(update.clone()));
        peers.push(p);
    }
    for p in &mut peers {
        p.settle().await;
    }
    let peak = rss_mb();
    for mut p in peers {
        p.leave();
    }
    wait_until(|| state.rooms.live_rooms() == 0).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let after = rss_mb();
    oc_server::alloc::release();
    let forced = rss_mb();
    eprintln!(
        "RSS before {before:.0} MB, {ROOMS} rooms open {peak:.0} MB, evicted {after:.0} MB, \
         after an explicit release {forced:.0} MB"
    );
    assert!(
        peak - before > 50.0,
        "the rooms did not use memory: {peak:.0} MB"
    );
    assert!(
        after - before < (peak - before) * 0.5,
        "RSS stayed at {after:.0} MB after eviction (before {before:.0}, peak {peak:.0})"
    );
}
