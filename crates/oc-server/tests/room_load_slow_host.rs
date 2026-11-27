// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! RLB-01c: rooms opening against a slow host. At most `OC_ROOM_LOADS` (8) rooms load at once
//! so their database work cannot take every connection (RLB-01b); the host's `GET /files`
//! answer is network waiting, not database work, and must not hold one of those slots. With
//! a slot held for each 1.5-2.5 s host answer, 200 rooms took 50 s or more to open after a
//! restart, and 105 of 200 had no host save within 120 s in the save drill.
//! One test in this binary: the load slots are per process.

mod common;

use std::time::{Duration, Instant};

use common::*;
use oc_server::grant::{Role, room_id};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slow_host_does_not_serialise_room_loads() {
    let (base, host_state) = mock_host().await;
    host_state.lock().unwrap().get_delay_ms = 1000;
    let state = app(&base, room_cfg()).await;
    let host = state.hosts.get("sample").unwrap();
    // 32 rooms at once, each waiting 1 s for the host: 4 s or more at 8 slots, about 1 s
    // without holding a slot while the host answers.
    let t = Instant::now();
    let loads = (0..32).map(|i| {
        let (state, host) = (state.clone(), host.clone());
        async move {
            let mut g = grant("u_1", Role::View);
            g.file.id = format!("slow_{i}");
            g.room = room_id("sample", &g.file.id);
            state.rooms.state(&host, &g).await
        }
    });
    for r in futures::future::join_all(loads).await {
        r.unwrap();
    }
    let took = t.elapsed();
    assert!(
        took < Duration::from_millis(3000),
        "32 rooms took {took:?} to open against a 1 s host"
    );
    assert!(host_state.lock().unwrap().gets >= 32);
}
