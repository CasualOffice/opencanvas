//! Cluster mode in-process (ADR-006): two nodes on one database share a fake lease store;
//! the relay, forwarded room calls, failover and drain run over real sockets.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use oc_server::SharedState;
use oc_server::cluster::lease::{FakeLeases, key};
use oc_server::cluster::{Cluster, ClusterConfig};
use oc_server::grant::Role;
use oc_server::room::CommitResult;
use oc_server::store::OutboxRow;
use yrs::{Doc, Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};

const CLUSTER_SECRET: &str = "test-cluster-secret-0123456789abcdef";

struct Node {
    state: SharedState,
    server: tokio::task::JoinHandle<()>,
}

async fn node(base: &str, db: &std::path::Path, fake: &Arc<FakeLeases>, id: &str) -> Node {
    let state = app_custom(base, room_cfg(), db, |_| {}).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cfg = ClusterConfig::build(
        Some("redis://unused".into()),
        "mysql://unused",
        Some(id.into()),
        Some(format!("http://{addr}")),
        Some(CLUSTER_SECRET.into()),
        "unused",
    )
    .unwrap()
    .unwrap();
    state
        .rooms
        .set_cluster(Cluster::with_backend(cfg, fake.clone()));
    let app = oc_server::app(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Node { state, server }
}

fn para(doc: &Doc, text: &str) {
    let content = doc.get_or_insert_xml_fragment("content");
    let mut txn = doc.transact_mut();
    let p = content.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    p.push_back(&mut txn, XmlTextPrelim::new(text));
}

fn saved_json(ocanvas: &[u8]) -> serde_json::Value {
    oc_model::doc_to_json(&oc_model::read_ocanvas(ocanvas).unwrap().doc)
}

fn has(doc_json: &serde_json::Value, text: &str) -> bool {
    doc_json.to_string().contains(text)
}

async fn two_nodes() -> (Shared, Arc<FakeLeases>, Node, Node) {
    let (base, host) = mock_host().await;
    let db = temp_db();
    let fake = Arc::new(FakeLeases::default());
    let n1 = node(&base, &db, &fake, "n1").await;
    let n2 = node(&base, &db, &fake, "n2").await;
    (host, fake, n1, n2)
}

#[tokio::test]
async fn non_owner_relays_frames_and_the_owner_enforces_roles() {
    let (_host, fake, n1, n2) = two_nodes().await;
    let mut a = Peer::join(&n1.state, grant("u_a", Role::Edit)).await;
    let room = grant("u_a", Role::Edit).room;
    assert!(fake.value(&key(&room)).unwrap().starts_with("n1@"));
    let mut b = Peer::join(&n2.state, grant("u_b", Role::Edit)).await;
    let mut v = Peer::join(&n2.state, grant("u_v", Role::View)).await;
    assert!(
        !n2.state.rooms.is_live(&room),
        "n2 must relay, not open the room"
    );
    a.settle().await;
    b.settle().await;
    v.settle().await;
    assert!(
        b.controls.iter().any(|c| c["t"] == "role"),
        "{:?}",
        b.controls
    );

    a.edit(|d| para(d, "from A"));
    b.edit(|d| para(d, "from B"));
    v.edit(|d| para(d, "from viewer"));
    for p in [&mut a, &mut b, &mut v] {
        p.settle().await;
    }
    for p in [&a, &b, &v] {
        let j = json_of(&p.doc);
        assert!(has(&j, "from A") && has(&j, "from B"), "{j}");
    }
    assert!(v.denied > 0, "viewer edit must be denied on the owner");
    assert!(!has(&json_of(&a.doc), "from viewer"));
    // Room calls on the non-owner are forwarded to the owner.
    let j = server_json(&n2.state).await;
    assert!(has(&j, "from A") && has(&j, "from B") && !has(&j, "from viewer"));
    let saved = n2.state.rooms.commit_live(&room).await;
    assert!(
        matches!(saved, Some(CommitResult::Saved { .. })),
        "{saved:?}"
    );
    assert!(!n2.state.rooms.is_live(&room));
}

#[tokio::test]
async fn owner_crash_moves_the_room_without_losing_acknowledged_edits() {
    let (host, fake, n1, n2) = two_nodes().await;
    let room = grant("u_a", Role::Edit).room;
    let mut a = Peer::join(&n1.state, grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&n2.state, grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;
    b.edit(|d| para(d, "acked by A"));
    b.settle().await;
    a.settle().await;
    assert!(has(&json_of(&a.doc), "acked by A"));

    // n1 dies: its server stops answering and the room actor is gone without a save.
    n1.server.abort();
    n1.state.rooms.crash(&room);
    b.settle().await;
    assert_eq!(
        b.closed,
        Some(1012),
        "relayed client must be told to reconnect"
    );
    assert!(b.controls.iter().any(|c| c["t"] == "reconnect"));
    assert!(
        fake.value(&key(&room)).unwrap().starts_with("n1@"),
        "lease not expired yet"
    );

    // B reconnects to n2 at once: n1 is unreachable, so n2 takes the room over and rebuilds it
    // from the WAL (the host never got a save).
    let started = std::time::Instant::now();
    let mut b2 = Peer::join(&n2.state, grant("u_b", Role::Edit)).await;
    b2.settle().await;
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(n2.state.rooms.is_live(&room));
    assert!(fake.value(&key(&room)).unwrap().starts_with("n2@"));
    assert!(has(&json_of(&b2.doc), "acked by A"), "{}", json_of(&b2.doc));
    assert!(host.lock().unwrap().puts.is_empty());
    let saved = n2.state.rooms.commit_live(&room).await;
    assert!(
        matches!(saved, Some(CommitResult::Saved { .. })),
        "{saved:?}"
    );
    let put = host.lock().unwrap().puts.last().unwrap().body.clone();
    assert!(has(&saved_json(&put), "acked by A"));
}

#[tokio::test]
async fn drain_commits_tells_every_client_to_reconnect_and_releases_the_lease() {
    let (host, fake, n1, n2) = two_nodes().await;
    let room = grant("u_a", Role::Edit).room;
    let mut a = Peer::join(&n1.state, grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&n2.state, grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;
    a.edit(|d| para(d, "before drain"));
    a.settle().await;
    b.settle().await;

    n1.state.rooms.shutdown_all().await;
    a.settle().await;
    b.settle().await;
    for p in [&a, &b] {
        assert_eq!(p.closed, Some(1012));
        assert!(
            p.controls.iter().any(|c| c["t"] == "reconnect"),
            "{:?}",
            p.controls
        );
    }
    assert_eq!(fake.value(&key(&room)), None, "lease released");
    let puts = host.lock().unwrap().puts.clone();
    assert_eq!(puts.len(), 1);
    assert!(has(&saved_json(&puts[0].body), "before drain"));
    // A draining node takes no new rooms; the other node picks the room up.
    let mut b2 = Peer::join(&n2.state, grant("u_b", Role::Edit)).await;
    b2.settle().await;
    assert!(n2.state.rooms.is_live(&room));
    assert!(has(&json_of(&b2.doc), "before drain"));
}

#[tokio::test]
async fn outbox_rows_are_claimed_by_one_node_at_a_time() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let row = OutboxRow {
        id: "01OUTBOX".into(),
        room_id: "r_x".into(),
        host_id: "sample".into(),
        file_id: FILE.into(),
        seq: 1,
        base_version: None,
        token: "t".into(),
        payload: vec![1, 2, 3],
        authors: vec![],
        attempts: 0,
        status: "pending".into(),
    };
    let s = &state.store;
    s.outbox_insert(&row, 1_000).await.unwrap();
    assert!(s.outbox_claim(&row.id, "n1", 1_000, 61_000).await.unwrap());
    assert!(!s.outbox_claim(&row.id, "n2", 2_000, 62_000).await.unwrap());
    assert!(s.outbox_claim(&row.id, "n1", 3_000, 63_000).await.unwrap());
    // The claim expires (its node died): another node may take it.
    assert!(
        s.outbox_claim(&row.id, "n2", 64_000, 124_000)
            .await
            .unwrap()
    );
    s.outbox_finish(&row.id, "done").await.unwrap();
    assert!(
        !s.outbox_claim(&row.id, "n1", 200_000, 260_000)
            .await
            .unwrap()
    );
}
