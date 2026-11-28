// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! WAL durability and fencing (docs/22 §8 weaknesses 3 and 4): a writer that lost the room
//! writes nothing, and an update that is not in the WAL is never fanned out.

mod common;

use common::*;
use oc_server::grant::Role;
use oc_server::store::{OutboxRow, Store, WalRow, is_fenced};
use yrs::{Doc, ReadTxn, Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};

fn para(doc: &Doc, text: &str) {
    let content = doc.get_or_insert_xml_fragment("content");
    let mut txn = doc.transact_mut();
    let p = content.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    p.push_back(&mut txn, XmlTextPrelim::new(text));
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// SQLite always; MariaDB/MySQL too when `OC_TEST_MYSQL_URL` is set (for example
/// `mysql://root:pw@127.0.0.1:8906/oc`).
async fn stores() -> Vec<(String, Store)> {
    let mut out = vec![(
        "sqlite".to_string(),
        Store::connect(&format!("sqlite://{}?mode=rwc", temp_db().display()), None)
            .await
            .unwrap(),
    )];
    match std::env::var("OC_TEST_MYSQL_URL") {
        Ok(url) => out.push(("mysql".into(), Store::connect(&url, None).await.unwrap())),
        Err(_) => eprintln!("OC_TEST_MYSQL_URL not set: fencing checked on SQLite only"),
    }
    out
}

fn outbox_row(room: &str) -> OutboxRow {
    OutboxRow {
        id: ulid::Ulid::new().to_string(),
        room_id: room.into(),
        host_id: "sample".into(),
        file_id: FILE.into(),
        seq: 1,
        base_version: None,
        token: "t".into(),
        payload: vec![1, 2, 3],
        authors: vec![],
        attempts: 0,
        status: "pending".into(),
    }
}

/// Two owners of one room: the one with epoch 1 (a node that was frozen past its lease) and
/// the one with epoch 2 (the node that took over). Every write of the epoch-1 owner is refused
/// and leaves nothing behind; the epoch-2 owner writes normally.
#[tokio::test]
async fn epoch_1_writes_are_refused_once_epoch_2_owns_the_room() {
    for (db, s) in stores().await {
        let room = new_room();
        let e1 = s.claim_epoch(&room, 1_000).await.unwrap();
        s.append_update(&room, e1, 1, b"one", "u_a", 1_000)
            .await
            .unwrap();
        let e2 = s.claim_epoch(&room, 2_000).await.unwrap();
        assert!(e2 > e1, "{db}: epochs must grow ({e1} then {e2})");

        let err = s
            .append_update(&room, e1, 2, b"stale", "u_a", 2_000)
            .await
            .expect_err("stale append must be refused");
        assert!(is_fenced(&err), "{db}: {err}");
        let err = s.compact(&room, e1, 1, b"snap", 2_000).await.unwrap_err();
        assert!(is_fenced(&err), "{db}: {err}");
        let err = s
            .outbox_insert(&outbox_row(&room), e1, 2_000)
            .await
            .unwrap_err();
        assert!(is_fenced(&err), "{db}: {err}");
        let err = s.purge_room_fenced(&room, e1).await.unwrap_err();
        assert!(is_fenced(&err), "{db}: {err}");

        let wal = s.load_wal(&room).await.unwrap();
        assert!(wal.snapshot.is_none(), "{db}: stale snapshot written");
        assert_eq!(wal.updates, vec![(1, b"one".to_vec())], "{db}");
        assert!(s.outbox_rows(&room).await.unwrap().is_empty(), "{db}");

        // The current owner continues from the WAL.
        s.append_update(&room, e2, 2, b"two", "u_b", 2_000)
            .await
            .unwrap();
        s.compact(&room, e2, 2, b"snap", 2_000).await.unwrap();
        s.outbox_insert(&outbox_row(&room), e2, 2_000)
            .await
            .unwrap();
        assert_eq!(s.load_wal(&room).await.unwrap().last_seq(), 2, "{db}");
        s.purge_room_fenced(&room, e2).await.unwrap();
        assert!(s.load_wal(&room).await.unwrap().is_empty(), "{db}");
    }
}

/// A live room whose epoch was taken by another owner stops at its first write: nothing is
/// appended or fanned out, and every client gets 1012 so it reconnects to the new owner.
#[tokio::test]
async fn stale_owner_stops_at_its_first_write_and_clients_get_1012() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let room = grant("u_a", Role::Edit).room;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;

    // Another node's actor took the room (it claimed the next epoch).
    state.store.claim_epoch(&room, 5_000).await.unwrap();
    a.edit(|d| para(d, "written by a stale owner"));
    a.settle().await;
    b.settle().await;

    assert!(
        !json_of(&b.doc).to_string().contains("stale owner"),
        "a fenced update was fanned out"
    );
    let wal = state.store.load_wal(&room).await.unwrap();
    assert!(
        wal.updates
            .iter()
            .all(|(_, u)| !contains(u, b"written by a stale owner")),
        "a fenced update reached the WAL"
    );
    assert_eq!(a.closed, Some(1012), "sender must be told to reconnect");
    assert_eq!(b.closed, Some(1012), "peers must be told to reconnect");
    wait_until(|| !state.rooms.is_live(&room)).await;
}

/// A WAL append that fails is not acknowledged: peers never see the update and the room
/// closes with 1012, so clients reconnect and resend it to a room rebuilt from the WAL.
#[tokio::test]
async fn failed_wal_append_is_not_fanned_out() {
    let (base, _host) = mock_host().await;
    let db = temp_db();
    let state = app_custom(&base, room_cfg(), &db, |_| {}).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;
    a.edit(|d| para(d, "durable"));
    a.settle().await;
    b.settle().await;
    assert!(json_of(&b.doc).to_string().contains("durable"));

    // Inject the failure: the WAL table is gone, so every append errors.
    let raw = sqlx::SqlitePool::connect(&format!("sqlite://{}", db.display()))
        .await
        .unwrap();
    sqlx::query("ALTER TABLE room_updates RENAME TO room_updates_gone")
        .execute(&raw)
        .await
        .unwrap();
    // A burst: these updates share one WAL batch, so none of them may go out.
    a.edit(|d| para(d, "not in the WAL"));
    a.edit(|d| para(d, "nor this one"));
    a.edit(|d| para(d, "nor the third"));
    a.settle().await;
    b.settle().await;
    let seen = json_of(&b.doc).to_string();
    assert!(
        !seen.contains("not in the WAL")
            && !seen.contains("nor this one")
            && !seen.contains("nor the third"),
        "an update whose WAL append failed was fanned out"
    );
    assert_eq!(a.closed, Some(1012), "sender must resync");
    assert_eq!(b.closed, Some(1012));

    // The database is back: the sender reconnects and resends; the room has its edit.
    sqlx::query("ALTER TABLE room_updates_gone RENAME TO room_updates")
        .execute(&raw)
        .await
        .unwrap();
    let room = grant("u_a", Role::Edit).room;
    wait_until(|| !state.rooms.is_live(&room)).await;
    let mut a2 = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let mine = a
        .doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    a2.send(oc_server::room::protocol::update(mine));
    a2.settle().await;
    let server = server_json(&state).await.to_string();
    assert!(
        server.contains("durable") && server.contains("not in the WAL"),
        "{server}"
    );
}

/// `oc_wal_append_seconds` is a histogram on `/metrics` (docs/13).
#[tokio::test]
async fn wal_append_latency_is_a_histogram() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.edit(|d| para(d, "hello"));
    a.settle().await;
    let text = state.metrics.render();
    assert!(
        text.contains("# TYPE oc_wal_append_seconds histogram"),
        "{text}"
    );
    assert!(
        text.contains("oc_wal_append_seconds_bucket{le=\"+Inf\"}"),
        "{text}"
    );
    let count: u64 = text
        .lines()
        .find_map(|l| l.strip_prefix("oc_wal_append_seconds_count "))
        .and_then(|v| v.trim().parse().ok())
        .unwrap();
    assert!(count >= 1, "{text}");
}

fn rows(seqs: impl IntoIterator<Item = i64>, tag: &str) -> Vec<WalRow> {
    seqs.into_iter()
        .map(|seq| WalRow {
            seq,
            data: format!("{tag}-{seq}").into_bytes(),
            origin: "u_a".into(),
            at: 1_000 + seq,
            ..Default::default()
        })
        .collect()
}

/// The ULID's 80 random bits (its first 10 characters are the millisecond; RLB-04).
fn new_room() -> String {
    format!("r_{}", &ulid::Ulid::new().to_string()[10..]).to_lowercase()
}

fn seqs(wal: &oc_server::store::Wal) -> Vec<i64> {
    wal.updates.iter().map(|(s, _)| *s).collect()
}

fn metric(state: &oc_server::SharedState, name: &str) -> i64 {
    state
        .metrics
        .render()
        .lines()
        .find_map(|l| l.strip_prefix(&format!("{name} ")))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(-1)
}

/// A batch lands whole or not at all: one bad row (a `seq` already taken) leaves none of the
/// batch's rows behind, and a room sharing the SQLite group commit is not affected.
#[tokio::test]
async fn wal_batch_is_all_or_nothing() {
    for (db, s) in stores().await {
        let (bad, good) = (new_room(), new_room());
        let eb = s.claim_epoch(&bad, 1_000).await.unwrap();
        let eg = s.claim_epoch(&good, 1_000).await.unwrap();
        s.append_updates(&bad, eb, rows(1..=3, "ok")).await.unwrap();

        // Seq 3 again in the middle of the batch, written concurrently with another room's
        // batch so that both can share one group transaction.
        let (r_bad, r_good) = tokio::join!(
            s.append_updates(&bad, eb, rows([4, 5, 3, 6], "dup")),
            s.append_updates(&good, eg, rows(1..=4, "good")),
        );
        let err = r_bad.expect_err("a batch with a duplicate seq was accepted");
        assert!(!is_fenced(&err), "{db}: {err:#}");
        r_good.unwrap_or_else(|e| panic!("{db}: the other room's batch failed: {e:#}"));

        let wal = s.load_wal(&bad).await.unwrap();
        assert_eq!(
            seqs(&wal),
            vec![1, 2, 3],
            "{db}: part of a failed batch was kept"
        );
        assert!(
            wal.updates.iter().all(|(_, u)| u.starts_with(b"ok")),
            "{db}"
        );
        assert_eq!(
            seqs(&s.load_wal(&good).await.unwrap()),
            vec![1, 2, 3, 4],
            "{db}"
        );
    }
}

/// Fencing holds per batch: a batch written with a stale epoch is refused whole (nothing of it
/// lands), while the new owner's batch, and another room's in the same group, go through.
#[tokio::test]
async fn stale_epoch_refuses_the_whole_batch() {
    for (db, s) in stores().await {
        let (room, other) = (new_room(), new_room());
        let e1 = s.claim_epoch(&room, 1_000).await.unwrap();
        let eo = s.claim_epoch(&other, 1_000).await.unwrap();
        s.append_updates(&room, e1, rows(1..=2, "e1"))
            .await
            .unwrap();
        let e2 = s.claim_epoch(&room, 2_000).await.unwrap();

        let (stale, fine) = tokio::join!(
            s.append_updates(&room, e1, rows(3..=10, "stale")),
            s.append_updates(&other, eo, rows(1..=8, "other")),
        );
        let err = stale.expect_err("a stale batch was accepted");
        assert!(is_fenced(&err), "{db}: {err:#}");
        fine.unwrap_or_else(|e| panic!("{db}: {e:#}"));
        let wal = s.load_wal(&room).await.unwrap();
        assert_eq!(
            seqs(&wal),
            vec![1, 2],
            "{db}: a fenced batch left rows behind"
        );

        s.append_updates(&room, e2, rows(3..=5, "e2"))
            .await
            .unwrap();
        assert_eq!(
            seqs(&s.load_wal(&room).await.unwrap()),
            vec![1, 2, 3, 4, 5],
            "{db}"
        );
        assert_eq!(
            seqs(&s.load_wal(&other).await.unwrap()),
            (1..=8).collect::<Vec<_>>(),
            "{db}"
        );
    }
}

/// A burst of updates is written in batches (fewer WAL writes than updates), every update
/// keeps its own `seq` in order, the peer gets all of them, and replaying the WAL rebuilds
/// exactly the server's document.
#[tokio::test]
async fn batched_wal_replays_in_order() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let room = grant("u_a", Role::Edit).room;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;
    let batches_before = metric(&state, "oc_wal_batches_total");
    let rows_before = metric(&state, "oc_wal_rows_total");

    // 300 edits sent back to back, each depending on the one before (one text, appended to).
    a.edit(|d| para(d, ""));
    let text = {
        let content = a.doc.get_or_insert_xml_fragment("content");
        let txn = a.doc.transact();
        let p = content.get(&txn, content.len(&txn) - 1).unwrap();
        let p = p.into_xml_element().unwrap();
        p.get(&txn, 0).unwrap().into_xml_text().unwrap()
    };
    for i in 0..300 {
        a.edit(|d| {
            let mut txn = d.transact_mut();
            let len = yrs::Text::len(&text, &txn);
            yrs::Text::insert(&text, &mut txn, len, &format!("{} ", i % 10));
        });
    }
    a.settle().await;
    b.settle().await;
    assert_eq!(
        json_of(&b.doc),
        json_of(&a.doc),
        "a peer missed or reordered updates"
    );

    let batches = metric(&state, "oc_wal_batches_total") - batches_before;
    let written = metric(&state, "oc_wal_rows_total") - rows_before;
    assert!(written >= 301, "rows written: {written}");
    assert!(
        batches > 0 && batches < written,
        "no batching: {batches} batches for {written} rows"
    );

    let wal = state.store.load_wal(&room).await.unwrap();
    let s = seqs(&wal);
    assert!(
        s.windows(2).all(|w| w[1] == w[0] + 1),
        "seqs not contiguous: {s:?}"
    );
    let replayed = oc_model::new_doc();
    if let Some((_, snap)) = &wal.snapshot {
        oc_model::ocanvas::apply_update_bytes(&replayed, snap).unwrap();
    }
    for (_, u) in &wal.updates {
        oc_model::ocanvas::apply_update_bytes(&replayed, u).unwrap();
    }
    let server = server_json(&state).await;
    assert_eq!(
        oc_model::doc_to_json(&replayed),
        server,
        "WAL replay differs"
    );
    assert_eq!(json_of(&a.doc), server);
}

// ---------- memory durability (ADR-029) ----------

fn memory_cfg(sync: std::time::Duration) -> oc_server::config::RoomConfig {
    oc_server::config::RoomConfig {
        durability: oc_server::config::Durability::Memory,
        compact_interval: sync,
        compact_every: u64::MAX,
        ..room_cfg()
    }
}

/// Memory durability: an edit is fanned out without a WAL row; the periodic dump puts the
/// state in `room_snapshots`, and a restart after a crash loads it.
#[tokio::test]
async fn memory_mode_fans_out_without_wal_rows_and_a_restart_loads_the_dump() {
    let (base, _host) = mock_host().await;
    let db = temp_db();
    let cfg = memory_cfg(std::time::Duration::from_millis(100));
    let state = app_custom(&base, cfg.clone(), &db, |_| {}).await;
    let room = grant("u_a", Role::Edit).room;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;
    a.edit(|d| para(d, "kept in memory"));
    a.settle().await;
    b.settle().await;
    assert!(json_of(&b.doc).to_string().contains("kept in memory"));
    assert_eq!(
        metric(&state, "oc_wal_rows_total"),
        0,
        "memory mode wrote WAL rows"
    );

    let mut dumped = false;
    for _ in 0..100 {
        let wal = state.store.load_wal(&room).await.unwrap();
        assert!(wal.updates.is_empty(), "memory mode wrote a WAL row");
        if wal
            .snapshot
            .as_ref()
            .is_some_and(|(_, s)| contains(s, b"kept in memory"))
        {
            dumped = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(dumped, "the state was not dumped within the sync interval");

    // kill -9: the actor goes away without saving; a new process opens the same database.
    state.rooms.crash(&room);
    a.leave();
    b.leave();
    drop(state);
    let restarted = app_custom(&base, cfg, &db, |_| {}).await;
    let mut v = Peer::join(&restarted, grant("u_v", Role::View)).await;
    v.settle().await;
    assert!(
        json_of(&v.doc).to_string().contains("kept in memory"),
        "the dump was not loaded after the restart"
    );
}

/// A dump that finishes after a newer one never replaces it (dumps run in the background).
#[tokio::test]
async fn an_older_dump_never_replaces_a_newer_one() {
    for (name, store) in stores().await {
        let room = new_room();
        let epoch = store.claim_epoch(&room, 1).await.unwrap();
        store.compact(&room, epoch, 20, b"newer", 1).await.unwrap();
        store.compact(&room, epoch, 10, b"older", 2).await.unwrap();
        let wal = store.load_wal(&room).await.unwrap();
        assert_eq!(
            wal.snapshot,
            Some((20, b"newer".to_vec())),
            "{name}: a late dump went back in time"
        );
    }
}

/// RLB-04: rooms made back to back are different rooms. `new_room` kept the first 12 characters
/// of a ULID: its 10-character millisecond time and only 10 random bits, so two rooms made in the
/// same millisecond were the same room about once in 1,024 pairs. `wal_batch_is_all_or_nothing`
/// then claimed epoch 2 for "good" over "bad"'s epoch 1 and its first append was fenced (the
/// reliability nightly, 1 of 5 runs).
#[test]
fn rooms_made_in_one_millisecond_are_distinct() {
    let ids: std::collections::HashSet<String> = (0..5_000).map(|_| new_room()).collect();
    assert_eq!(ids.len(), 5_000);
}
