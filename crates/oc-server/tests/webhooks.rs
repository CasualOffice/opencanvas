// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Webhooks (WH-01, ADR-056): HAPI-05 events delivered to `[host.webhooks] url` from the
//! durable outbox, signed with `X-OpenCanvas-Signature` v2, retried with backoff on the server
//! clock (pinned here: no test sleeps for a retry), given up, refused off the callback origin,
//! and sent once when several nodes deliver.
mod common;

use std::collections::HashSet;
use std::time::Duration;

use common::*;
use oc_server::SharedState;
use oc_server::grant::Role;
use oc_server::store::WebhookRow;
use serde_json::Value;
use yrs::{Transact, Xml, XmlElementPrelim, XmlFragment, XmlTextPrelim};

const T0: i64 = 1_800_000_000_000;

fn hooks(h: &mut oc_server::hosts::HostConfig, events: &[&str], extra: &[(&str, toml::Value)]) {
    let mut t = toml::Table::new();
    t.insert(
        "url".into(),
        toml::Value::String(format!("{}/hooks", h.callback_base)),
    );
    t.insert(
        "events".into(),
        toml::Value::Array(
            events
                .iter()
                .map(|e| toml::Value::String(e.to_string()))
                .collect(),
        ),
    );
    for (k, v) in extra {
        t.insert(k.to_string(), v.clone());
    }
    h.webhooks = t;
}

async fn with_hooks(
    events: &'static [&'static str],
    extra: Vec<(&'static str, toml::Value)>,
) -> (SharedState, Shared) {
    let (base, host) = mock_host().await;
    let state = app_custom(&base, room_cfg(), &temp_db(), |h| hooks(h, events, &extra)).await;
    state.clock.set_ms(T0);
    (state, host)
}

/// Waits until `n` rows are queued for the host (the writer runs in the background).
async fn queued(state: &SharedState, n: usize) -> Vec<String> {
    for _ in 0..400 {
        let ids = state.store.webhook_ids("sample").await.unwrap();
        if ids.len() >= n {
            return ids;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("{n} webhook rows were not queued");
}

fn secret_para(doc: &yrs::Doc) {
    let content = doc.get_or_insert_xml_fragment("content");
    let mut txn = doc.transact_mut();
    let p = content.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    p.insert_attribute(&mut txn, "blockId", "b_secret");
    p.push_back(&mut txn, XmlTextPrelim::new("top secret plans"));
}

fn header(r: &RecordedPut, k: &str) -> String {
    r.headers[k].to_str().unwrap().to_string()
}

fn metric(state: &SharedState, result: &str) -> i64 {
    let text = state.metrics.render();
    let want = format!("oc_webhook_deliveries_total{{host=\"sample\",result=\"{result}\"}} ");
    text.lines()
        .find_map(|l| l.strip_prefix(&want))
        .map_or(0, |n| n.parse().unwrap())
}

#[tokio::test]
async fn deliveries_are_signed_and_carry_ids_only() {
    let (state, host) = with_hooks(&["member.joined", "edited"], vec![]).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    a.edit(secret_para);
    a.settle().await;
    let ids = queued(&state, 2).await;
    assert_eq!(state.deliver_webhooks(T0).await.unwrap(), 2);
    let calls = host.lock().unwrap().hooks.clone();
    assert_eq!(calls.len(), 2);
    let mut types = vec![];
    for c in &calls {
        assert!(c.signature_ok, "v2 signature with the host secret");
        let sig = header(c, "x-opencanvas-signature");
        assert!(sig.starts_with(&format!("t={},v1=", T0 / 1000)), "{sig}");
        let body: Value = serde_json::from_slice(&c.body).unwrap();
        assert_eq!(header(c, "idempotency-key"), body["id"].as_str().unwrap());
        assert_eq!(
            header(c, "x-opencanvas-event-id"),
            body["id"].as_str().unwrap()
        );
        assert_eq!(
            header(c, "x-opencanvas-event"),
            body["type"].as_str().unwrap()
        );
        assert_eq!(header(c, "x-opencanvas-delivery-attempt"), "1");
        assert_eq!(header(c, "content-type"), "application/json");
        assert_eq!(body["fileId"], FILE);
        assert!(!String::from_utf8_lossy(&c.body).contains("secret plans"));
        types.push(body["type"].as_str().unwrap().to_string());
        assert!(ids.contains(&body["id"].as_str().unwrap().to_string()));
    }
    assert_eq!(types, ["member.joined", "edited"]);
    let edited: Value = serde_json::from_slice(&calls[1].body).unwrap();
    assert_eq!(edited["data"]["blockIds"], serde_json::json!(["b_secret"]));
    for id in &ids {
        assert_eq!(
            state.store.webhook_state(id).await.unwrap().unwrap().status,
            "done"
        );
    }
    assert_eq!(metric(&state, "ok"), 2);
    assert!(
        state
            .metrics
            .render()
            .contains("oc_webhook_delivery_seconds_count{host=\"sample\"} 2")
    );
    assert_eq!(
        state.deliver_webhooks(T0 + 60_000).await.unwrap(),
        0,
        "sent once"
    );
}

#[tokio::test]
async fn a_webhook_secret_replaces_the_host_secret() {
    let (state, host) = with_hooks(
        &["member.joined"],
        vec![(
            "secret",
            toml::Value::String("whsec-0123456789abcdef".into()),
        )],
    )
    .await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    queued(&state, 1).await;
    state.deliver_webhooks(T0).await.unwrap();
    let c = host.lock().unwrap().hooks[0].clone();
    assert!(!c.signature_ok, "not signed with the host secret");
    let want = oc_server::host_client::signature_header(
        b"whsec-0123456789abcdef",
        T0 / 1000,
        "POST",
        "/api/hooks",
        &c.body,
    );
    assert_eq!(header(&c, "x-opencanvas-signature"), want);
}

#[tokio::test]
async fn retries_back_off_on_the_server_clock() {
    let (state, host) = with_hooks(&["member.joined"], vec![]).await;
    host.lock().unwrap().hook_answers = [
        (503, vec![]),
        (429, vec![("retry-after", "120".to_string())]),
        (200, vec![]),
    ]
    .into();
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    let id = queued(&state, 1).await.remove(0);
    let st = |s: &SharedState| {
        let s = s.clone();
        let id = id.clone();
        async move { s.store.webhook_state(&id).await.unwrap().unwrap() }
    };
    assert_eq!(state.deliver_webhooks(T0).await.unwrap(), 1);
    let s1 = st(&state).await;
    assert_eq!(
        (
            s1.status.as_str(),
            s1.attempts,
            s1.next_try_at,
            s1.last_status
        ),
        ("pending", 1, T0 + 10_000, 503)
    );
    assert_eq!(
        state.deliver_webhooks(T0 + 9_999).await.unwrap(),
        0,
        "not due"
    );
    assert_eq!(state.deliver_webhooks(T0 + 10_000).await.unwrap(), 1);
    let s2 = st(&state).await;
    assert_eq!(
        (s2.attempts, s2.next_try_at, s2.last_status),
        (2, T0 + 10_000 + 120_000, 429),
        "Retry-After 120 s beats the 30 s backoff"
    );
    assert_eq!(state.deliver_webhooks(T0 + 129_999).await.unwrap(), 0);
    assert_eq!(state.deliver_webhooks(T0 + 130_000).await.unwrap(), 1);
    assert_eq!(st(&state).await.status, "done");
    let calls = host.lock().unwrap().hooks.clone();
    let attempts: Vec<String> = calls
        .iter()
        .map(|c| header(c, "x-opencanvas-delivery-attempt"))
        .collect();
    assert_eq!(attempts, ["1", "2", "3"]);
    assert!(calls.iter().all(|c| header(c, "idempotency-key") == id));
    assert_eq!((metric(&state, "retry"), metric(&state, "ok")), (2, 1));
}

#[tokio::test]
async fn gives_up_after_max_attempts() {
    let (state, host) = with_hooks(
        &["member.joined"],
        vec![("max_attempts", toml::Value::Integer(3))],
    )
    .await;
    host.lock().unwrap().hook_answers = [(500, vec![]), (502, vec![]), (500, vec![])].into();
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    let id = queued(&state, 1).await.remove(0);
    let mut now = T0;
    for _ in 0..3 {
        assert_eq!(state.deliver_webhooks(now).await.unwrap(), 1);
        now += 3_600_000;
    }
    let s = state.store.webhook_state(&id).await.unwrap().unwrap();
    assert_eq!(
        (s.status.as_str(), s.attempts, s.last_status),
        ("failed", 3, 500)
    );
    assert_eq!(state.deliver_webhooks(now + 86_400_000).await.unwrap(), 0);
    assert_eq!(host.lock().unwrap().hooks.len(), 3);
    assert_eq!((metric(&state, "retry"), metric(&state, "gave_up")), (2, 1));
}

#[tokio::test]
async fn a_refusal_or_a_redirect_is_final_and_never_followed() {
    let (state, host) = with_hooks(&["member.joined", "member.left"], vec![]).await;
    let elsewhere = format!(
        "{}/elsewhere",
        state.hosts.get("sample").unwrap().callback_base
    );
    host.lock().unwrap().hook_answers =
        [(410, vec![]), (302, vec![("location", elsewhere)])].into();
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    a.leave();
    let ids = queued(&state, 2).await;
    assert_eq!(state.deliver_webhooks(T0).await.unwrap(), 2);
    for (id, code) in ids.iter().zip([410, 302]) {
        let s = state.store.webhook_state(id).await.unwrap().unwrap();
        assert_eq!(
            (s.status.as_str(), s.attempts, s.last_status),
            ("rejected", 1, code)
        );
    }
    assert_eq!(
        host.lock().unwrap().elsewhere,
        0,
        "redirects are not followed"
    );
    assert_eq!(metric(&state, "rejected"), 2);
}

#[tokio::test]
async fn urls_off_the_callback_origin_are_refused() {
    // At startup.
    for url in [
        "http://169.254.169.254/latest/meta-data",
        "http://127.0.0.1:1/hooks",
        "https://elsewhere.example/hooks",
        "file:///etc/passwd",
    ] {
        let src = format!(
            "[[host]]\nid = \"a\"\nname = \"A\"\njwt_secret = \"0123456789abcdef0123456789abcdef\"\ncallback_base = \"https://host.example/api\"\n[host.webhooks]\nurl = \"{url}\"\nevents = [\"saved\"]\n"
        );
        let err = oc_server::hosts::Hosts::parse(&src, None)
            .err()
            .unwrap_or_else(|| panic!("{url} accepted"));
        assert!(format!("{err:#}").contains("webhook"), "{err:#}");
    }
    let ok = "[[host]]\nid = \"a\"\nname = \"A\"\njwt_secret = \"0123456789abcdef0123456789abcdef\"\ncallback_base = \"https://host.example/api\"\n[host.webhooks]\nurl = \"https://host.example/hooks\"\nevents = [\"saved\"]\n";
    assert!(oc_server::hosts::Hosts::parse(ok, None).is_ok());

    // At delivery: a queued row whose host's URL is not allowed (any more) is never sent.
    let (base, host) = mock_host().await;
    let state = app_custom(&base, room_cfg(), &temp_db(), |h| {
        hooks(h, &["*"], &[]);
        h.webhooks.insert(
            "url".into(),
            toml::Value::String("http://169.254.169.254/latest/meta-data".into()),
        );
    })
    .await;
    let row = WebhookRow {
        id: "ev_refused".into(),
        host_id: "sample".into(),
        room_id: "r_1".into(),
        file_id: FILE.into(),
        event_type: "saved".into(),
        payload: "{}".into(),
        attempts: 0,
        next_try_at: T0,
    };
    assert!(state.store.webhook_insert(&row, T0).await.unwrap());
    assert_eq!(state.deliver_webhooks(T0).await.unwrap(), 1);
    let s = state
        .store
        .webhook_state("ev_refused")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s.status, "refused");
    assert!(host.lock().unwrap().hooks.is_empty());
    assert_eq!(metric(&state, "refused"), 1);
}

#[tokio::test]
async fn two_nodes_deliver_each_event_once() {
    let (base, host) = mock_host().await;
    let db = temp_db();
    let a = app_custom(&base, room_cfg(), &db, |h| hooks(h, &["*"], &[])).await;
    let b = app_custom(&base, room_cfg(), &db, |h| hooks(h, &["*"], &[])).await;
    for i in 0..40 {
        let row = WebhookRow {
            id: format!("ev_{i:03}"),
            host_id: "sample".into(),
            room_id: "r_1".into(),
            file_id: FILE.into(),
            event_type: "saved".into(),
            payload: format!("{{\"id\":\"ev_{i:03}\"}}"),
            attempts: 0,
            next_try_at: T0,
        };
        assert!(a.store.webhook_insert(&row, T0).await.unwrap());
        assert!(
            !b.store.webhook_insert(&row, T0).await.unwrap(),
            "queued once"
        );
    }
    let (x, y) = tokio::join!(a.deliver_webhooks(T0), b.deliver_webhooks(T0));
    assert_eq!(x.unwrap() + y.unwrap(), 40);
    let calls = host.lock().unwrap().hooks.clone();
    let ids: HashSet<String> = calls.iter().map(|c| header(c, "idempotency-key")).collect();
    assert_eq!((calls.len(), ids.len()), (40, 40), "each event sent once");
}
