// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Storage conformance (ADR-030): the same contract on every backend. SQLite always;
//! MySQL/MariaDB when `OC_TEST_MYSQL_URL` is set (a new database per test; the user needs
//! CREATE DATABASE); Redis-only storage when `OC_TEST_REDIS_URL`
//! is set (for example `redis://127.0.0.1:8801/`). Every id is fresh, so a shared Redis is fine.

mod common;

use common::*;
use oc_server::crypto::Kek;
use oc_server::grant::Role;
use oc_server::store::{NotifyRow, OutboxRow, Store, WalRow, is_fenced};

fn kek() -> Option<Kek> {
    Some(Kek::from_b64(TEST_KEK).unwrap())
}

/// SEC-47: cluster nodes (or a rolling deploy) that start together on an empty database all
/// start. Two nodes running the migrations at once made one fail with a duplicate migration
/// row (seen on MariaDB 10.11), so a node stopped at start-up.
#[tokio::test]
async fn nodes_starting_together_on_an_empty_database_all_start() {
    let mut urls = vec![format!("sqlite://{}?mode=rwc", temp_db().display())];
    if let Ok(url) = std::env::var("OC_TEST_MYSQL_URL") {
        urls.push(fresh_mysql_db(&url).await);
    }
    for url in urls {
        let starts: Vec<_> = (0..8)
            .map(|_| {
                let url = url.clone();
                tokio::spawn(async move { Store::connect(&url, kek()).await.map(|_| ()) })
            })
            .collect();
        for s in starts {
            s.await
                .unwrap()
                .map_err(|e| format!("{url}: {e:#}"))
                .unwrap();
        }
    }
}

/// A new, empty database on the MySQL/MariaDB server of `url`. Each test gets its own, as
/// each gets its own SQLite file: tests run in parallel, and one that sweeps tables (for
/// example `purge_expired`, which drops week-old `room_epochs` rows, and every test's rows
/// are stamped in 1970) would otherwise delete another test's rows mid-run (RLB-05).
async fn fresh_mysql_db(url: &str) -> String {
    sqlx::any::install_default_drivers();
    let name = format!("oc_t_{}", ulid::Ulid::new().to_string().to_lowercase());
    let admin = sqlx::AnyPool::connect(url).await.unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
    let base = url.rsplit_once('/').unwrap().0;
    format!("{base}/{name}")
}

async fn backends() -> Vec<(String, Store)> {
    let mut out = vec![(
        "sqlite".to_string(),
        Store::connect(&format!("sqlite://{}?mode=rwc", temp_db().display()), kek())
            .await
            .unwrap(),
    )];
    match std::env::var("OC_TEST_MYSQL_URL") {
        Ok(url) => {
            let db = fresh_mysql_db(&url).await;
            out.push(("mysql".into(), Store::connect(&db, kek()).await.unwrap()));
        }
        Err(_) => eprintln!("OC_TEST_MYSQL_URL not set: MySQL backend skipped"),
    }
    match std::env::var("OC_TEST_REDIS_URL") {
        Ok(url) => {
            let s = Store::connect_redis(&url, kek()).await.unwrap();
            assert!(s.is_redis_only());
            out.push(("redis".into(), s));
        }
        Err(_) => eprintln!("OC_TEST_REDIS_URL not set: Redis-only backend skipped"),
    }
    out
}

fn uid(p: &str) -> String {
    format!("{p}_{}", ulid::Ulid::new().to_string().to_lowercase())
}

fn outbox_row(room: &str, payload: &[u8]) -> OutboxRow {
    OutboxRow {
        id: ulid::Ulid::new().to_string(),
        room_id: room.into(),
        host_id: "sample".into(),
        file_id: FILE.into(),
        seq: 7,
        base_version: Some("v1".into()),
        token: "callback-secret".into(),
        payload: payload.to_vec(),
        authors: vec!["u_a".into()],
        attempts: 0,
        status: "pending".into(),
    }
}

fn wal(seqs: impl IntoIterator<Item = i64>) -> Vec<WalRow> {
    seqs.into_iter()
        .map(|seq| WalRow {
            seq,
            data: vec![seq as u8],
            origin: "u_a".into(),
            at: 1_000 + seq,
        })
        .collect()
}

#[tokio::test]
async fn outbox_supersedes_older_pending_rows_and_seals_the_token() {
    for (b, s) in backends().await {
        let room = uid("r");
        let e = s.claim_epoch(&room, 1_000).await.unwrap();
        let first = outbox_row(&room, b"one");
        s.outbox_insert(&first, e, 1_000).await.unwrap();
        let second = outbox_row(&room, b"two");
        s.outbox_insert(&second, e, 2_000).await.unwrap();

        let rows = s.outbox_rows(&room).await.unwrap();
        assert_eq!(rows.len(), 2, "{b}");
        assert_eq!(rows[0].id, first.id, "{b}: oldest first");
        assert_eq!(rows[0].status, "superseded", "{b}");
        assert!(
            rows[0].payload.is_empty(),
            "{b}: superseded payload dropped"
        );
        let p = s.outbox_pending(&room).await.unwrap().unwrap();
        assert_eq!(p.id, second.id, "{b}");
        assert_eq!(p.payload, b"two", "{b}");
        assert_eq!(p.token, "callback-secret", "{b}: token opened");
        assert_eq!(p.base_version.as_deref(), Some("v1"), "{b}");
        assert_eq!(p.authors, vec!["u_a".to_string()], "{b}");
        assert_eq!(p.seq, 7, "{b}");
        let raw = s.raw_outbox_token(&room).await.unwrap();
        assert_ne!(raw, "callback-secret", "{b}: token sealed at rest");

        let pending: Vec<_> = s
            .outbox_all_pending()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.room_id == room)
            .collect();
        assert_eq!(pending.len(), 1, "{b}");
        assert_eq!(pending[0].id, second.id, "{b}");

        s.outbox_failed(&second.id, 9_000, "host 503")
            .await
            .unwrap();
        assert_eq!(
            s.outbox_pending(&room).await.unwrap().unwrap().attempts,
            1,
            "{b}"
        );

        s.outbox_finish(&second.id, "done").await.unwrap();
        assert!(s.outbox_pending(&room).await.unwrap().is_none(), "{b}");
        let done = s.outbox_rows(&room).await.unwrap().pop().unwrap();
        assert_eq!(done.status, "done", "{b}");
        assert!(done.payload.is_empty(), "{b}");
        assert!(
            !s.outbox_all_pending()
                .await
                .unwrap()
                .iter()
                .any(|r| r.room_id == room),
            "{b}"
        );
    }
}

/// The outbox row id is the commit's idempotency key: a second row with the same id is
/// refused and changes nothing. A notification id is queued once.
#[tokio::test]
async fn outbox_and_notification_ids_are_idempotency_keys() {
    for (b, s) in backends().await {
        let room = uid("r");
        let e = s.claim_epoch(&room, 1_000).await.unwrap();
        let row = outbox_row(&room, b"one");
        s.outbox_insert(&row, e, 1_000).await.unwrap();
        let mut again = row.clone();
        again.payload = b"other".to_vec();
        assert!(s.outbox_insert(&again, e, 2_000).await.is_err(), "{b}");
        let rows = s.outbox_rows(&room).await.unwrap();
        assert_eq!(rows.len(), 1, "{b}");
        assert_eq!(rows[0].status, "pending", "{b}");
        assert_eq!(rows[0].payload, b"one", "{b}");

        let n = NotifyRow {
            id: uid("n"),
            room_id: room.clone(),
            host_id: "sample".into(),
            file_id: FILE.into(),
            kind: "mention".into(),
            token: "tok".into(),
            payload: "{}".into(),
            attempts: 0,
            next_try_at: 5_000,
        };
        assert!(s.notify_insert(&n, 1_000).await.unwrap(), "{b}");
        assert!(
            !s.notify_insert(&n, 1_001).await.unwrap(),
            "{b}: queued once"
        );
    }
}

/// WH-01 (ADR-056): `webhook_outbox` on SQLite and MySQL/MariaDB (migration 0009): queued once
/// per event id, due by time, claimed by exactly one worker, retried, finished, purged.
/// Redis-only storage has no outbox and says so.
#[tokio::test]
async fn webhook_outbox_contract() {
    use oc_server::store::WebhookRow;
    for (b, store) in backends().await {
        let id = uid("ev");
        let row = WebhookRow {
            id: id.clone(),
            host_id: "sample".into(),
            room_id: "r_1".into(),
            file_id: "f".repeat(600),
            event_type: "saved".into(),
            payload: format!("{{\"id\":\"{id}\",\"data\":{{\"version\":\"7\"}}}}"),
            attempts: 0,
            next_try_at: 1_000,
        };
        if b == "redis" {
            let err = store.webhook_insert(&row, 1_000).await.unwrap_err();
            assert!(err.to_string().contains("need a database"), "{err}");
            continue;
        }
        assert!(store.webhook_insert(&row, 1_000).await.unwrap(), "{b}");
        assert!(
            !store.webhook_insert(&row, 1_000).await.unwrap(),
            "{b}: once per id"
        );
        assert!(
            !store
                .webhook_due(999, 1_000)
                .await
                .unwrap()
                .iter()
                .any(|r| r.id == id),
            "{b}: not due yet"
        );
        let due = store.webhook_due(1_000, 1_000).await.unwrap();
        let got = due.iter().find(|r| r.id == id).expect("due");
        assert_eq!(got, &row, "{b}: read back as written (long file id too)");
        assert!(
            store.webhook_claim(&id, 1_000, 61_000).await.unwrap(),
            "{b}"
        );
        assert!(
            !store.webhook_claim(&id, 1_000, 61_000).await.unwrap(),
            "{b}: a second claimant loses"
        );
        store.webhook_retry(&id, 11_000, 503).await.unwrap();
        let s = store.webhook_state(&id).await.unwrap().unwrap();
        assert_eq!(
            (s.status.as_str(), s.attempts, s.next_try_at, s.last_status),
            ("pending", 1, 11_000, 503),
            "{b}"
        );
        assert!(store.webhook_pending().await.unwrap() >= 1, "{b}");
        store
            .webhook_finish(&id, "done", 204, 12_000)
            .await
            .unwrap();
        let s = store.webhook_state(&id).await.unwrap().unwrap();
        assert_eq!(
            (s.status.as_str(), s.attempts, s.last_status),
            ("done", 2, 204),
            "{b}"
        );
        assert!(
            !store
                .webhook_due(i64::MAX, 1_000)
                .await
                .unwrap()
                .iter()
                .any(|r| r.id == id),
            "{b}: finished rows are never due"
        );
        store.webhook_purge(1_001).await.unwrap();
        assert!(
            store.webhook_state(&id).await.unwrap().is_none(),
            "{b}: purged"
        );
    }
}

#[tokio::test]
async fn outbox_claim_is_a_lease_held_by_one_node() {
    for (b, s) in backends().await {
        let room = uid("r");
        let e = s.claim_epoch(&room, 1_000).await.unwrap();
        let row = outbox_row(&room, b"x");
        s.outbox_insert(&row, e, 1_000).await.unwrap();
        assert!(
            s.outbox_claim(&row.id, "n1", 1_000, 61_000).await.unwrap(),
            "{b}"
        );
        assert!(
            !s.outbox_claim(&row.id, "n2", 2_000, 62_000).await.unwrap(),
            "{b}"
        );
        assert!(
            s.outbox_claim(&row.id, "n1", 3_000, 63_000).await.unwrap(),
            "{b}: renewal"
        );
        assert!(
            s.outbox_claim(&row.id, "n2", 64_000, 124_000)
                .await
                .unwrap(),
            "{b}: expired claim is taken over"
        );
        assert!(
            !s.outbox_claim(&row.id, "n1", 65_000, 125_000)
                .await
                .unwrap(),
            "{b}"
        );
        s.outbox_finish(&row.id, "done").await.unwrap();
        assert!(
            !s.outbox_claim(&row.id, "n1", 200_000, 260_000)
                .await
                .unwrap(),
            "{b}: finished rows are not claimed"
        );
        assert!(!s.outbox_claim("nope", "n1", 1, 2).await.unwrap(), "{b}");
    }
}

#[tokio::test]
async fn launch_jti_is_single_use() {
    for (b, s) in backends().await {
        let jti = uid("j");
        let exp = oc_server::util::now_secs() + 120;
        assert!(s.use_jti("sample", &jti, exp).await.unwrap(), "{b}");
        assert!(
            !s.use_jti("sample", &jti, exp).await.unwrap(),
            "{b}: replay refused"
        );
        assert!(
            s.use_jti("other", &jti, exp).await.unwrap(),
            "{b}: per host"
        );
    }
}

/// A writer with an older epoch changes nothing: outbox, snapshot, WAL and purge are refused.
#[tokio::test]
async fn stale_epoch_is_refused_on_every_guarded_write() {
    for (b, s) in backends().await {
        let room = uid("r");
        let e1 = s.claim_epoch(&room, 1_000).await.unwrap();
        s.append_updates(&room, e1, wal(1..=2)).await.unwrap();
        let e2 = s.claim_epoch(&room, 2_000).await.unwrap();
        assert!(e2 > e1, "{b}");
        assert_eq!(s.room_epoch(&room).await.unwrap(), Some(e2), "{b}");

        let err = s.append_updates(&room, e1, wal(3..=4)).await.unwrap_err();
        assert!(is_fenced(&err), "{b}: {err}");
        let err = s
            .outbox_insert(&outbox_row(&room, b"x"), e1, 3_000)
            .await
            .unwrap_err();
        assert!(is_fenced(&err), "{b}: {err}");
        let err = s.compact(&room, e1, 2, b"stale", 3_000).await.unwrap_err();
        assert!(is_fenced(&err), "{b}: {err}");
        let err = s.purge_room_fenced(&room, e1).await.unwrap_err();
        assert!(is_fenced(&err), "{b}: {err}");
        assert!(s.outbox_rows(&room).await.unwrap().is_empty(), "{b}");
        let w = s.load_wal(&room).await.unwrap();
        assert!(w.snapshot.is_none(), "{b}");
        assert_eq!(
            w.updates.len(),
            2,
            "{b}: nothing of the stale writer landed"
        );

        s.append_updates(&room, e2, wal(3..=4)).await.unwrap();
        s.outbox_insert(&outbox_row(&room, b"ok"), e2, 3_000)
            .await
            .unwrap();
        s.purge_room_fenced(&room, e2).await.unwrap();
        assert!(s.load_wal(&room).await.unwrap().is_empty(), "{b}");
    }
}

#[tokio::test]
async fn snapshot_replaces_the_covered_wal_and_never_goes_back() {
    for (b, s) in backends().await {
        let room = uid("r");
        let e = s.claim_epoch(&room, 1_000).await.unwrap();
        s.append_updates(&room, e, wal(1..=5)).await.unwrap();
        s.compact(&room, e, 3, b"state-3", 2_000).await.unwrap();
        let w = s.load_wal(&room).await.unwrap();
        assert_eq!(w.snapshot, Some((3, b"state-3".to_vec())), "{b}");
        assert_eq!(
            w.updates.iter().map(|u| u.0).collect::<Vec<_>>(),
            vec![4, 5],
            "{b}"
        );
        assert_eq!(w.last_seq(), 5, "{b}");
        // A late, older dump is ignored.
        s.compact(&room, e, 2, b"state-2", 3_000).await.unwrap();
        assert_eq!(
            s.load_wal(&room).await.unwrap().snapshot,
            Some((3, b"state-3".to_vec())),
            "{b}"
        );
        s.purge_room(&room).await.unwrap();
        assert!(s.load_wal(&room).await.unwrap().is_empty(), "{b}");
    }
}

#[tokio::test]
async fn rooms_sessions_notifications_and_assets() {
    for (b, s) in backends().await {
        let room = uid("r");
        // Room row.
        assert!(s.room(&room).await.unwrap().is_none(), "{b}");
        s.put_room(&room, "sample", FILE, Some("v1"), false, 1_000)
            .await
            .unwrap();
        s.mark_room(&room, Some("v2"), true, 2_000, false)
            .await
            .unwrap();
        let r = s.room(&room).await.unwrap().unwrap();
        assert_eq!(r.host_version.as_deref(), Some("v2"), "{b}");
        assert!(r.dirty, "{b}");
        s.mark_room(&room, None, false, 3_000, true).await.unwrap();
        let r = s.room(&room).await.unwrap().unwrap();
        assert_eq!(r.host_version, None, "{b}");
        assert!(!r.dirty, "{b}");

        // Sessions.
        let mut g = grant("u_a", Role::Edit);
        g.room = room.clone();
        let t1 = uid("t");
        let t2 = uid("t");
        let exp = oc_server::util::now_secs() + 600;
        s.insert_session(&t1, &g, exp, 1_000).await.unwrap();
        let mut g2 = grant("u_b", Role::View);
        g2.room = room.clone();
        s.insert_session(&t2, &g2, exp, 2_000).await.unwrap();
        let (back, e) = s.session(&t1).await.unwrap().unwrap();
        assert_eq!(e, exp, "{b}");
        assert_eq!(back.callback_token, g.callback_token, "{b}");
        let raw = s.raw_grant_json(&t1).await.unwrap().unwrap();
        assert!(!raw.contains(&g.callback_token), "{b}: sealed");
        let users = s.room_users(&room).await.unwrap();
        assert_eq!(
            users.iter().map(|u| u.id.as_str()).collect::<Vec<_>>(),
            vec!["u_a", "u_b"],
            "{b}"
        );
        assert_eq!(
            s.set_session_role(&room, "u_b", Some(Role::Edit))
                .await
                .unwrap(),
            1,
            "{b}"
        );
        assert_eq!(
            s.session(&t2).await.unwrap().unwrap().0.role,
            Role::Edit,
            "{b}"
        );
        assert_eq!(
            s.set_session_role(&room, "u_b", None).await.unwrap(),
            1,
            "{b}"
        );
        assert!(s.session(&t2).await.unwrap().is_none(), "{b}");
        assert_eq!(s.delete_room_sessions(&room).await.unwrap(), 1, "{b}");
        assert!(s.session(&t1).await.unwrap().is_none(), "{b}");

        // Notifications: due, claimed once, retried, finished.
        let n = NotifyRow {
            id: uid("n"),
            room_id: room.clone(),
            host_id: "sample".into(),
            file_id: FILE.into(),
            kind: "mention".into(),
            token: "tok".into(),
            payload: "{\"x\":1}".into(),
            attempts: 0,
            next_try_at: 5_000,
        };
        s.notify_insert(&n, 1_000).await.unwrap();
        let mine = |rows: Vec<NotifyRow>| rows.into_iter().find(|r| r.id == n.id);
        assert!(
            mine(s.notify_due(4_999, 1_000).await.unwrap()).is_none(),
            "{b}"
        );
        let due = mine(s.notify_due(5_000, 100_000).await.unwrap()).unwrap();
        assert_eq!(due.token, "tok", "{b}");
        assert!(s.notify_claim(&n.id, 5_000, 65_000).await.unwrap(), "{b}");
        assert!(
            !s.notify_claim(&n.id, 5_000, 65_000).await.unwrap(),
            "{b}: claimed once"
        );
        s.notify_retry(&n.id, 70_000).await.unwrap();
        let due = mine(s.notify_due(70_000, 100_000).await.unwrap()).unwrap();
        assert_eq!(due.attempts, 1, "{b}");
        s.notify_finish(&n.id, "done").await.unwrap();
        assert_eq!(
            s.notify_status(&n.id).await.unwrap(),
            Some(("done".into(), String::new())),
            "{b}"
        );
        assert!(
            mine(s.notify_due(i64::MAX / 2, 100_000).await.unwrap()).is_none(),
            "{b}"
        );

        // Assets of a room that is gone are swept; a live room keeps its own.
        let a = oc_model::ocanvas::Asset {
            id: "a1".into(),
            mime: "image/png".into(),
            data: vec![1, 2, 3, 4],
        };
        s.asset_put(&room, &a, 1_000).await.unwrap();
        assert_eq!(
            s.asset_get(&room, "a1").await.unwrap().unwrap().data,
            a.data,
            "{b}"
        );
        assert_eq!(s.room_assets_size(&room).await.unwrap(), 4, "{b}");
        assert_eq!(s.room_assets(&room).await.unwrap().len(), 1, "{b}");
        s.purge_orphan_assets(2_000).await.unwrap();
        assert!(
            s.asset_get(&room, "a1").await.unwrap().is_some(),
            "{b}: live room"
        );
        s.purge_room(&room).await.unwrap();
        assert!(s.room(&room).await.unwrap().is_none(), "{b}");
        s.purge_orphan_assets(2_000).await.unwrap();
        assert!(
            s.asset_get(&room, "a1").await.unwrap().is_none(),
            "{b}: swept"
        );
    }
}

#[tokio::test]
async fn ai_token_usage_is_counted_per_host_and_month() {
    for (b, s) in backends().await {
        let (h1, h2) = (uid("host"), uid("host"));
        assert_eq!(s.ai_usage_add(&h1, "2026-11", 15).await.unwrap(), 15, "{b}");
        assert_eq!(s.ai_usage_add(&h1, "2026-11", 5).await.unwrap(), 20, "{b}");
        assert_eq!(s.ai_usage_add(&h1, "2026-12", 7).await.unwrap(), 7, "{b}");
        assert_eq!(s.ai_usage_add(&h2, "2026-11", 1).await.unwrap(), 1, "{b}");
        let month = s.ai_usage_month("2026-11").await.unwrap();
        assert_eq!(month.get(&h1), Some(&20), "{b}");
        assert_eq!(month.get(&h2), Some(&1), "{b}");
        assert_eq!(
            s.ai_usage_month("2026-12").await.unwrap().get(&h2),
            None,
            "{b}"
        );
    }
}

/// HAPI-03: the `Idempotency-Key` store. One claim per key across every caller; replay,
/// mismatch, in-progress, release, and expiry (by the caller's clock on SQL; Redis expires
/// the lease by TTL, which this test does not wait for).
#[tokio::test]
async fn idempotency_keys_claim_once_replay_and_expire() {
    use oc_server::store::IdemBegin;
    for (b, s) in backends().await {
        let (id, host) = (uid("idem"), "sample");
        let now = 1_000_000;
        assert_eq!(
            s.idem_begin(&id, host, "h1", now, 60).await.unwrap(),
            IdemBegin::Started,
            "{b}"
        );
        assert_eq!(
            s.idem_begin(&id, host, "h1", now, 60).await.unwrap(),
            IdemBegin::InProgress,
            "{b}"
        );
        assert_eq!(
            s.idem_begin(&id, host, "h2", now, 60).await.unwrap(),
            IdemBegin::Mismatch,
            "{b}"
        );
        // Concurrent claims of a fresh key: exactly one starts.
        let fresh = uid("idem");
        let claims =
            futures::future::join_all((0..8).map(|_| s.idem_begin(&fresh, host, "h", now, 60)))
                .await;
        let started = claims
            .iter()
            .filter(|c| matches!(c, Ok(IdemBegin::Started)))
            .count();
        assert_eq!(started, 1, "{b}: {claims:?}");

        s.idem_finish(&id, host, "h1", 201, r#"{"ok":1}"#, 86_400, now)
            .await
            .unwrap();
        assert_eq!(
            s.idem_begin(&id, host, "h1", now + 10, 60).await.unwrap(),
            IdemBegin::Replay {
                status: 201,
                response: r#"{"ok":1}"#.into()
            },
            "{b}"
        );
        // Release only frees a running claim of the same request.
        s.idem_release(&id, host, "h1").await.unwrap();
        assert!(
            matches!(
                s.idem_begin(&id, host, "h1", now, 60).await.unwrap(),
                IdemBegin::Replay { .. }
            ),
            "{b}"
        );
        s.idem_release(&fresh, host, "other").await.unwrap();
        assert_eq!(
            s.idem_begin(&fresh, host, "h", now, 60).await.unwrap(),
            IdemBegin::InProgress,
            "{b}"
        );
        s.idem_release(&fresh, host, "h").await.unwrap();
        assert_eq!(
            s.idem_begin(&fresh, host, "h", now, 60).await.unwrap(),
            IdemBegin::Started,
            "{b}"
        );

        if b != "redis" {
            // A dead node's claim frees after its lease; a done answer after its TTL.
            assert_eq!(
                s.idem_begin(&fresh, host, "h9", now + 61, 60)
                    .await
                    .unwrap(),
                IdemBegin::Started,
                "{b}"
            );
            assert_eq!(
                s.idem_begin(&id, host, "h2", now + 86_401, 60)
                    .await
                    .unwrap(),
                IdemBegin::Started,
                "{b}"
            );
            s.purge_expired(now + 10 * 86_400).await.unwrap();
            assert_eq!(
                s.idem_begin(&id, host, "h3", now, 60).await.unwrap(),
                IdemBegin::Started,
                "{b}: purged"
            );
        }
    }
}

/// OFF-01 (ADR-063): `offline_generation` on every backend (migration 0011; Redis
/// `oc:offgen:<host>:<user>`): 0 until the first revoke, then +1 per revoke, per host and user.
#[tokio::test]
async fn offline_generation_contract() {
    for (b, store) in backends().await {
        let user = uid("u");
        assert_eq!(store.offline_gen("sample", &user).await.unwrap(), 0, "{b}");
        assert_eq!(
            store.offline_revoke("sample", &user).await.unwrap(),
            1,
            "{b}"
        );
        assert_eq!(
            store.offline_revoke("sample", &user).await.unwrap(),
            2,
            "{b}"
        );
        assert_eq!(store.offline_gen("sample", &user).await.unwrap(), 2, "{b}");
        assert_eq!(
            store.offline_gen("other", &user).await.unwrap(),
            0,
            "{b}: per host"
        );
        let long = format!("{user}{}", "u".repeat(200));
        assert_eq!(
            store.offline_revoke("sample", &long).await.unwrap(),
            1,
            "{b}: long ids"
        );
    }
}

/// AUTO-03/05 (migration 0010) on SQLite and MySQL/MariaDB: a due schedule row is claimed by
/// exactly one of many concurrent claimants, a run id is logged once, failures count back to
/// the last success, and old runs are purged. Redis-only storage has no automation.
#[tokio::test]
async fn automation_schedule_and_runs() {
    for (name, store) in backends().await {
        if store.is_redis_only() {
            assert!(!store.automation_supported());
            continue;
        }
        let room = uid("r");
        store
            .automation_schedule_set(
                &room,
                "h",
                "f",
                &[("au_a".into(), 1_000), ("au_b".into(), 5_000)],
            )
            .await
            .unwrap();
        store
            .automation_schedule_set(&room, "h", "f", &[("au_a".into(), 1_000)])
            .await
            .unwrap();
        assert_eq!(
            store.automation_schedule_of(&room).await.unwrap(),
            vec![("au_a".to_string(), 1_000)],
            "{name}"
        );
        let due: Vec<_> = store
            .automation_due(2_000, 100)
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.room_id == room)
            .collect();
        assert_eq!(due.len(), 1, "{name}");
        let wins = futures::future::join_all((0..8).map(|i| {
            let (s, r) = (store.clone(), due[0].clone());
            async move {
                s.automation_claim(&r, &format!("n{i}"), 100_000)
                    .await
                    .unwrap()
            }
        }))
        .await;
        assert_eq!(
            wins.iter().filter(|w| **w).count(),
            1,
            "{name}: one claimant wins"
        );
        store
            .automation_advance(&room, "au_a", 1_000, 90_000)
            .await
            .unwrap();
        assert_eq!(
            store.automation_schedule_of(&room).await.unwrap(),
            vec![("au_a".to_string(), 90_000)]
        );
        let row = |id: &str, result: &str, at: i64| oc_server::store::RunRow {
            id: id.into(),
            room_id: room.clone(),
            host_id: "h".into(),
            file_id: "f".into(),
            rule_id: "au_a".into(),
            trigger: "schedule".into(),
            result: result.into(),
            error_code: String::new(),
            http_status: 0,
            changes: 0,
            notified: 0,
            depth: 0,
            duration_ms: 1,
            at,
        };
        let now = oc_server::util::now_ms();
        assert!(
            store
                .automation_run_insert(&row(&uid("run"), "done", now - 40 * 86_400_000))
                .await
                .unwrap()
        );
        assert!(
            store
                .automation_run_insert(&row(&uid("run"), "done", now - 3))
                .await
                .unwrap()
        );
        for i in 0..3 {
            assert!(
                store
                    .automation_run_insert(&row(&uid("run"), "failed", now - 2 + i))
                    .await
                    .unwrap()
            );
        }
        // 1 ms after the last failure: at the same millisecond the order of the two is undefined
        // and the failure streak counted 1 or 0 (it flaked 1 in 3).
        let once = uid("run");
        assert!(
            store
                .automation_run_insert(&row(&once, "done", now + 1))
                .await
                .unwrap()
        );
        assert!(
            !store
                .automation_run_insert(&row(&once, "done", now + 1))
                .await
                .unwrap(),
            "{name}: a run id is logged once"
        );
        assert_eq!(
            store.automation_failures(&room, "au_a", 10).await.unwrap(),
            0
        );
        assert!(store.automation_purge(now).await.unwrap() >= 1);
        assert_eq!(
            store
                .automation_runs(&room, None, None, None, 100)
                .await
                .unwrap()
                .len(),
            5,
            "{name}"
        );
        assert_eq!(
            store
                .automation_runs(&room, None, Some("failed"), None, 100)
                .await
                .unwrap()
                .len(),
            3
        );
    }
}
