//! WAL durability and fencing (docs/22 §8 weaknesses 3 and 4): a writer that lost the room
//! writes nothing, and an update that is not in the WAL is never fanned out.

mod common;

use common::*;
use oc_server::grant::Role;
use oc_server::store::{OutboxRow, Store, is_fenced};
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
        let room = format!("r_{}", &ulid::Ulid::new().to_string()[..12]).to_lowercase();
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
    a.edit(|d| para(d, "not in the WAL"));
    a.settle().await;
    b.settle().await;
    assert!(
        !json_of(&b.doc).to_string().contains("not in the WAL"),
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
