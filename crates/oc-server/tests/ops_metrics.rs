// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! OPS-01: the series the Grafana dashboard and the alert rules read (deploy/monitoring)
//! are on `/metrics`: host callbacks per host, exports per format, launch rejections by code,
//! HTTP responses by class, readiness, the commit outbox and process metrics.
mod common;

use std::time::{Duration, Instant};

use common::*;
use oc_server::grant::Role;
use oc_server::room::CommitResult;
use yrs::{Doc, Text, Transact, XmlFragment, XmlTextPrelim, XmlTextRef};

const TICKET: &str = "01TESTTICKETOPSMETRICS0000";

fn type_text(doc: &Doc, s: &str) {
    let content = doc.get_or_insert_xml_fragment("content");
    let mut txn = doc.transact_mut();
    let first: Option<XmlTextRef> = content.get(&txn, 0).and_then(|n| n.into_xml_text());
    match first {
        Some(t) => t.push(&mut txn, s),
        None => {
            content.push_back(&mut txn, XmlTextPrelim::new(s));
        }
    }
}

/// Commits until `done` holds for the answer (30 s at most).
async fn commit_until(
    state: &oc_server::SharedState,
    room: &str,
    done: impl Fn(&Option<CommitResult>) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let r = state.rooms.commit_live(room).await;
        if done(&r) {
            return;
        }
        assert!(Instant::now() < deadline, "last commit answer: {r:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn scrape(addr: &str) -> String {
    reqwest::get(format!("http://{addr}/metrics"))
        .await
        .unwrap()
        .text()
        .await
        .unwrap()
}

#[tokio::test]
async fn dashboard_series_are_exported() {
    let (base, host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let addr = serve_state(state.clone()).await;

    // A save that works, then one the host refuses with a 500.
    let g = grant("u_a", Role::Edit);
    let mut a = Peer::join(&state, g.clone()).await;
    a.edit(|d| type_text(d, "hello"));
    a.settle().await;
    // Polled, not timed: the room may not have applied the edit yet (`Clean`).
    commit_until(&state, &g.room, |r| {
        matches!(r, Some(CommitResult::Saved { .. }))
    })
    .await;
    host.lock().unwrap().fail = true;
    a.edit(|d| type_text(d, " again"));
    a.settle().await;
    commit_until(&state, &g.room, |r| {
        matches!(r, Some(CommitResult::Queued { .. }))
    })
    .await;

    // Exports: one that works, one without a PDF renderer (501).
    state
        .store
        .insert_session(TICKET, &g, i64::MAX / 2, 0)
        .await
        .unwrap();
    let md = reqwest::get(format!("http://{addr}/v1/export/md?ticket={TICKET}"))
        .await
        .unwrap();
    assert_eq!(md.status(), 200);
    let pdf = reqwest::get(format!("http://{addr}/v1/export/pdf?ticket={TICKET}"))
        .await
        .unwrap();
    assert_eq!(pdf.status(), 501);

    // A launch with a token that is not a JWT.
    let bad = reqwest::get(format!("http://{addr}/v1/launch?token=not-a-jwt"))
        .await
        .unwrap();
    assert!(bad.status().is_client_error());

    // Retries of the failing save may add more `5xx` calls, so those counts are not exact.
    let wants = [
        "# TYPE oc_host_callback_seconds histogram",
        "oc_host_callback_seconds_count{host=\"sample\",op=\"save\"} ",
        "oc_host_callbacks_total{host=\"sample\",op=\"save\",result=\"ok\"} 1\n",
        "oc_host_callbacks_total{host=\"sample\",op=\"save\",result=\"5xx\"} ",
        "oc_host_callbacks_total{host=\"sample\",op=\"load\",result=\"ok\"} 1",
        "oc_exports_total{format=\"md\",result=\"ok\"} 1",
        "oc_exports_total{format=\"pdf\",result=\"error\"} 1",
        "oc_export_seconds_count{format=\"md\"} 1",
        "# TYPE oc_launches_rejected_total counter",
        "oc_launches_rejected_total{code=\"",
        "oc_http_responses_total{code=\"2xx\"}",
        "oc_http_responses_total{code=\"5xx\"} 1",
        "# TYPE oc_ready gauge\noc_ready 1\n",
        "# TYPE oc_draining gauge\noc_draining 0\n",
        "# TYPE oc_commit_outbox_pending gauge\noc_commit_outbox_pending 1\n",
        "# TYPE process_start_time_seconds gauge",
        // WH-01: the dashboard's "Webhooks" row (series appear once a delivery is attempted).
        "# TYPE oc_webhook_deliveries_total counter",
        "# TYPE oc_webhook_delivery_seconds histogram",
    ];
    let deadline = Instant::now() + Duration::from_secs(30);
    let text = loop {
        let text = scrape(&addr).await;
        if wants.iter().all(|w| text.contains(w)) || Instant::now() > deadline {
            break text;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    for want in wants {
        assert!(text.contains(want), "missing {want:?} in\n{text}");
    }
    if cfg!(target_os = "linux") {
        for want in [
            "process_resident_memory_bytes ",
            "process_cpu_seconds_total ",
            "process_open_fds ",
            "process_max_fds ",
        ] {
            assert!(text.contains(want), "missing {want:?} in\n{text}");
        }
    }
}
