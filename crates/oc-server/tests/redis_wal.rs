//! The hot WAL in Redis (ADR-021): fencing, no fan-out without the append, replay of DB
//! snapshot + stream, trim only after a DB sync. Needs a Redis: set `OC_TEST_REDIS_URL`
//! (for example `redis://127.0.0.1:8779/`); skipped otherwise.

mod common;

use common::*;
use oc_server::grant::Role;
use oc_server::store::{Store, WalRow, is_fenced};
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact};

/// One stream entry as `XRANGE` returns it: id and field/value pairs.
type StreamEntry = (String, Vec<(String, Vec<u8>)>);

fn redis_url() -> Option<String> {
    let url = std::env::var("OC_TEST_REDIS_URL").ok();
    if url.is_none() {
        eprintln!("OC_TEST_REDIS_URL not set: Redis WAL tests skipped");
    }
    url
}

async fn store(url: &str) -> Store {
    Store::connect(&format!("sqlite://{}?mode=rwc", temp_db().display()), None)
        .await
        .unwrap()
        .with_redis_wal(url)
        .await
        .unwrap()
}

fn new_room() -> String {
    format!("r_{}", &ulid::Ulid::new().to_string()[..12]).to_lowercase()
}

fn row(seq: i64, data: Vec<u8>) -> WalRow {
    WalRow {
        seq,
        data,
        origin: "u_a".into(),
        at: 1_000 + seq,
    }
}

async fn raw(url: &str) -> redis::aio::MultiplexedConnection {
    redis::Client::open(url)
        .unwrap()
        .get_multiplexed_async_connection()
        .await
        .unwrap()
}

/// A writer whose epoch is stale is refused by the append script, whole batch, nothing added.
#[tokio::test]
async fn stale_epoch_xadd_is_refused() {
    let Some(url) = redis_url() else { return };
    let s = store(&url).await;
    let r = s.redis_wal().unwrap().clone();
    let room = new_room();
    let e1 = s.claim_epoch(&room, 1_000).await.unwrap();
    s.append_updates(
        &room,
        e1,
        vec![row(1, b"a".to_vec()), row(2, b"b".to_vec())],
    )
    .await
    .unwrap();
    let e2 = s.claim_epoch(&room, 2_000).await.unwrap();
    let err = s
        .append_updates(
            &room,
            e1,
            vec![row(3, b"stale".to_vec()), row(4, b"x".to_vec())],
        )
        .await
        .expect_err("a stale writer appended");
    assert!(is_fenced(&err), "{err:#}");
    assert_eq!(r.len(&room).await.unwrap(), 2);
    s.append_updates(&room, e2, vec![row(3, b"c".to_vec())])
        .await
        .unwrap();
    let seqs: Vec<i64> = r
        .read_after(&room, 0)
        .await
        .unwrap()
        .into_iter()
        .map(|(s, _)| s)
        .collect();
    assert_eq!(seqs, vec![1, 2, 3]);
}

/// DB snapshot + the stream entries after it rebuild exactly the document; the snapshot
/// trims the entries it covers.
#[tokio::test]
async fn snapshot_plus_stream_replay_gives_the_same_document() {
    let Some(url) = redis_url() else { return };
    let s = store(&url).await;
    let r = s.redis_wal().unwrap().clone();
    let room = new_room();
    let epoch = s.claim_epoch(&room, 1_000).await.unwrap();

    let doc = Doc::new();
    let text = doc.get_or_insert_text("t");
    let mut updates = Vec::new();
    for i in 0..10 {
        let sv = doc.transact().state_vector();
        text.insert(&mut doc.transact_mut(), (i * 2) as u32, &format!("{i},"));
        updates.push(doc.transact().encode_state_as_update_v1(&sv));
    }
    let rows = |from: usize, to: usize| {
        (from..to)
            .map(|i| row(i as i64 + 1, updates[i].clone()))
            .collect::<Vec<_>>()
    };
    s.append_updates(&room, epoch, rows(0, 5)).await.unwrap();
    // The snapshot at seq 5: the state after the first five updates.
    let snap_doc = Doc::new();
    for u in &updates[..5] {
        snap_doc
            .transact_mut()
            .apply_update(<yrs::Update as yrs::updates::decoder::Decode>::decode_v1(u).unwrap())
            .unwrap();
    }
    let snap = snap_doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    s.compact(&room, epoch, 5, &snap, 2_000).await.unwrap();
    s.append_updates(&room, epoch, rows(5, 10)).await.unwrap();
    assert_eq!(
        r.len(&room).await.unwrap(),
        5,
        "entries covered by the snapshot stay"
    );

    let wal = s.load_wal(&room).await.unwrap();
    assert_eq!(wal.snapshot.as_ref().map(|s| s.0), Some(5));
    assert_eq!(
        wal.updates.iter().map(|(s, _)| *s).collect::<Vec<_>>(),
        (6..=10).collect::<Vec<_>>()
    );
    let replayed = Doc::new();
    let t2 = replayed.get_or_insert_text("t");
    for u in std::iter::once(&wal.snapshot.unwrap().1).chain(wal.updates.iter().map(|(_, u)| u)) {
        replayed
            .transact_mut()
            .apply_update(<yrs::Update as yrs::updates::decoder::Decode>::decode_v1(u).unwrap())
            .unwrap();
    }
    assert_eq!(
        t2.get_string(&replayed.transact()),
        text.get_string(&doc.transact())
    );
}

/// The stream is trimmed only after the DB snapshot was written: a fenced (failed) sync
/// leaves every entry in Redis.
#[tokio::test]
async fn trim_happens_only_after_a_successful_sync() {
    let Some(url) = redis_url() else { return };
    let s = store(&url).await;
    let r = s.redis_wal().unwrap().clone();
    let room = new_room();
    let e1 = s.claim_epoch(&room, 1_000).await.unwrap();
    s.append_updates(&room, e1, (1..=4).map(|i| row(i, vec![i as u8])).collect())
        .await
        .unwrap();
    let e2 = s.claim_epoch(&room, 2_000).await.unwrap();
    assert!(s.compact(&room, e1, 4, b"snap", 3_000).await.is_err());
    assert_eq!(
        r.len(&room).await.unwrap(),
        4,
        "trimmed although the sync failed"
    );
    s.compact(&room, e2, 3, b"snap", 3_000).await.unwrap();
    assert_eq!(
        r.len(&room).await.unwrap(),
        1,
        "entries up to the synced seq stay"
    );
}

/// A Redis append that fails is not acknowledged: the peer never sees the update, both get
/// 1012, and a reconnecting sender's resend lands in a room rebuilt from the WAL.
#[tokio::test]
async fn failed_redis_append_is_not_fanned_out() {
    let Some(url) = redis_url() else { return };
    let (base, _host) = mock_host().await;
    let u = url.clone();
    let state = app_full(
        &base,
        room_cfg(),
        &temp_db(),
        |_| {},
        move |c| c.wal_redis_url = Some(u),
    )
    .await;
    let room = grant("u_a", Role::Edit).room;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;
    a.edit(|d| {
        d.get_or_insert_text("t")
            .push(&mut d.transact_mut(), "durable")
    });
    a.settle().await;
    b.settle().await;
    let tb = b.doc.get_or_insert_text("t");
    assert_eq!(tb.get_string(&b.doc.transact()), "durable");

    // Break the stream: a key of the wrong type makes every append fail.
    let mut c = raw(&url).await;
    let key = oc_server::redis_wal::stream_key(&room);
    let saved: Vec<StreamEntry> = redis::cmd("XRANGE")
        .arg(&key)
        .arg("-")
        .arg("+")
        .query_async(&mut c)
        .await
        .unwrap();
    let _: () = redis::cmd("DEL")
        .arg(&key)
        .query_async(&mut c)
        .await
        .unwrap();
    let _: () = redis::cmd("SET")
        .arg(&key)
        .arg("x")
        .query_async(&mut c)
        .await
        .unwrap();
    a.edit(|d| {
        d.get_or_insert_text("t")
            .push(&mut d.transact_mut(), " lost?")
    });
    a.settle().await;
    b.settle().await;
    assert!(
        !tb.get_string(&b.doc.transact()).contains("lost?"),
        "an update whose Redis append failed was fanned out"
    );
    assert_eq!(a.closed, Some(1012));
    assert_eq!(b.closed, Some(1012));

    // Redis is back (the stream restored): the sender resends onto a rebuilt room.
    let _: () = redis::cmd("DEL")
        .arg(&key)
        .query_async(&mut c)
        .await
        .unwrap();
    for (id, fields) in saved {
        let mut cmd = redis::cmd("XADD");
        cmd.arg(&key).arg(id);
        for (f, v) in fields {
            cmd.arg(f).arg(v);
        }
        let _: String = cmd.query_async(&mut c).await.unwrap();
    }
    wait_until(|| !state.rooms.is_live(&room)).await;
    let mut a2 = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let mine = a
        .doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    a2.send(oc_server::room::protocol::update(mine));
    a2.settle().await;
    let mut v = Peer::join(&state, grant("u_v", Role::View)).await;
    v.settle().await;
    let tv = v.doc.get_or_insert_text("t");
    assert_eq!(tv.get_string(&v.doc.transact()), "durable lost?");
}
