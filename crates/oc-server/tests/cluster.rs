// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Cluster mode in-process (ADR-006): two nodes on one database share a fake lease store;
//! the relay, forwarded room calls, failover and drain run over real sockets.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use oc_server::SharedState;
use oc_server::cluster::bus::{Bus, FakeBus, RedisBus};
use oc_server::cluster::lease::{FakeLeases, key};
use oc_server::cluster::{Cluster, ClusterConfig};
use oc_server::grant::{Role, User};
use oc_server::room::CommitResult;
use oc_server::store::OutboxRow;
use serde_json::{Value, json};
use yrs::{Doc, Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};

const CLUSTER_SECRET: &str = "test-cluster-secret-0123456789abcdef";

struct Node {
    state: SharedState,
    server: tokio::task::JoinHandle<()>,
    addr: String,
}

async fn node(
    base: &str,
    db: &std::path::Path,
    fake: &Arc<FakeLeases>,
    id: &str,
    bus: Arc<dyn Bus>,
) -> Node {
    let state = app_ai(base, room_cfg(), db, |h| {
        h.api_key = Some("test-api-key".into());
        h.ai.insert("mcp".into(), toml::Value::Boolean(true));
        h.ai.insert(
            "mcp_audience".into(),
            toml::Value::String("https://oc.example".into()),
        );
        h.ai.insert("default_mode".into(), toml::Value::String("direct".into()));
    })
    .await;
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
    state.join_cluster(Cluster::with_backends(cfg, fake.clone(), bus));
    let app = oc_server::app(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Node {
        state,
        server,
        addr: addr.to_string(),
    }
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
    let bus: Arc<dyn Bus> = Arc::new(FakeBus::default());
    let n1 = node(&base, &db, &fake, "n1", bus.clone()).await;
    let n2 = node(&base, &db, &fake, "n2", bus).await;
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
    let epoch = s.claim_epoch(&row.room_id, 1_000).await.unwrap();
    s.outbox_insert(&row, epoch, 1_000).await.unwrap();
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

fn http() -> reqwest::Client {
    reqwest::Client::new()
}

async fn ticket_for(state: &SharedState, g: &oc_server::grant::Grant) -> String {
    let t = ulid::Ulid::new().to_string();
    let exp = oc_server::util::now_secs() + 600;
    state.store.insert_session(&t, g, exp, 0).await.unwrap();
    t
}

async fn member_ids(addr: &str, t: &str) -> Vec<String> {
    let v: Value = http()
        .get(format!("http://{addr}/v1/members?ticket={t}&q="))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    v["members"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["id"].as_str().map(String::from))
        .collect()
}

async fn host_post(addr: &str, path: &str, body: Value) -> u16 {
    http()
        .post(format!("http://{addr}{path}"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", "test-api-key")
        .json(&body)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

/// Waits up to `limit` for `f` to hold on node `addr`'s member list.
async fn members_until(
    addr: &str,
    t: &str,
    limit: Duration,
    f: impl Fn(&[String]) -> bool,
) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < limit {
        if f(&member_ids(addr, t).await) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

/// docs/21 revision 2 in a cluster: a revoke (or invalidate) on one node reaches every node's
/// members cache and revoke set within a second, and the person's sockets close on every node.
async fn revoke_reaches_every_node(n1: &Node, n2: &Node, host: &Shared) {
    host.lock().unwrap().members = Some(json!([
        {"id": "u_priya", "name": "Priya"}, {"id": "u_sam", "name": "Sam"}
    ]));
    let mut g = grant("u_priya", Role::Edit);
    g.members = vec![User {
        id: "u_sam".into(),
        name: "Sam".into(),
        color: "#123456".into(),
        ..Default::default()
    }];
    // n1 owns the room; Sam is relayed through n2.
    let mut priya = Peer::join(&n1.state, g.clone()).await;
    let mut sam = Peer::join(&n2.state, grant("u_sam", Role::Edit)).await;
    priya.settle().await;
    sam.settle().await;
    assert!(!n2.state.rooms.is_live(&g.room));
    let t = ticket_for(&n2.state, &g).await;
    // Warm both nodes' caches.
    assert!(member_ids(&n1.addr, &t).await.contains(&"u_sam".into()));
    assert!(member_ids(&n2.addr, &t).await.contains(&"u_sam".into()));

    host.lock().unwrap().members = Some(json!([{"id": "u_priya", "name": "Priya"}]));
    let path = format!("/v1/files/{FILE}/role");
    let status = host_post(&n1.addr, &path, json!({"userId": "u_sam", "role": "none"})).await;
    assert_eq!(status, 200);
    let gone = members_until(&n2.addr, &t, Duration::from_secs(1), |l| {
        !l.iter().any(|i| i == "u_sam")
    })
    .await;
    assert!(gone, "n2 still lists the revoked person after 1 s");
    sam.settle().await;
    assert_eq!(sam.closed, Some(1008), "n2's socket for Sam must close");

    // An invalidate on n1 drops n2's cached answer too.
    host.lock().unwrap().members = Some(json!([
        {"id": "u_priya", "name": "Priya"}, {"id": "u_new", "name": "New"}
    ]));
    let path = format!("/v1/files/{FILE}/members/invalidate");
    assert_eq!(host_post(&n1.addr, &path, json!({})).await, 200);
    let seen = members_until(&n2.addr, &t, Duration::from_secs(1), |l| {
        l.iter().any(|i| i == "u_new")
    })
    .await;
    assert!(seen, "n2 kept its cached members after an invalidate on n1");
}

#[tokio::test]
async fn revoke_on_one_node_reaches_every_node() {
    let (host, _fake, n1, n2) = two_nodes().await;
    revoke_reaches_every_node(&n1, &n2, &host).await;
}

/// The same over real Redis pub/sub. Runs when `OC_TEST_REDIS_URL` is set (for example
/// `docker run -d -p 127.0.0.1:8936:6379 redis:7-alpine` and `redis://127.0.0.1:8936`);
/// leases stay on the fake so only the members bus touches Redis.
#[tokio::test]
async fn revoke_on_one_node_reaches_every_node_over_redis() {
    let Ok(url) = std::env::var("OC_TEST_REDIS_URL") else {
        eprintln!("OC_TEST_REDIS_URL not set: skipping the Redis members-bus test");
        return;
    };
    let (base, host) = mock_host().await;
    let db = temp_db();
    let fake = Arc::new(FakeLeases::default());
    let n1 = node(
        &base,
        &db,
        &fake,
        "n1",
        RedisBus::connect(&url).await.unwrap(),
    )
    .await;
    let n2 = node(
        &base,
        &db,
        &fake,
        "n2",
        RedisBus::connect(&url).await.unwrap(),
    )
    .await;
    // Let both subscriptions come up before anything is published.
    tokio::time::sleep(Duration::from_millis(300)).await;
    revoke_reaches_every_node(&n1, &n2, &host).await;
}

fn mcp_token() -> String {
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
    let c = json!({"iss": "sample", "aud": "https://oc.example/mcp/sample", "sub": "u_mcp",
        "name": "Asha", "exp": oc_server::util::now_secs() + 600,
        "scope": "canvas:read canvas:write", "role": "edit", "client_id": "claude",
        "files": [FILE]});
    encode(
        &Header::new(Algorithm::HS256),
        &c,
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}

async fn mcp_call(addr: &str, name: &str, args: Value) -> (u16, Value) {
    let res = http()
        .post(format!("http://{addr}/mcp/sample"))
        .bearer_auth(mcp_token())
        .json(&json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": {"name": name, "arguments": args}}))
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

#[tokio::test]
async fn mcp_tool_call_on_a_non_owner_is_forwarded_to_the_owner() {
    let (_host, fake, n1, n2) = two_nodes().await;
    let mut a = Peer::join(&n1.state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    let room = grant("u_a", Role::Edit).room;
    assert!(fake.value(&key(&room)).unwrap().starts_with("n1@"));

    let (status, v) = mcp_call(
        &n2.addr,
        "canvas_patch",
        json!({"fileId": FILE, "ops": [{"op": "append", "markdown": "From MCP on n2"}]}),
    )
    .await;
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["result"]["isError"], false, "{v}");
    assert!(!n2.state.rooms.is_live(&room), "n2 must forward, not open");
    a.settle().await;
    assert!(
        has(&json_of(&a.doc), "From MCP on n2"),
        "{}",
        json_of(&a.doc)
    );

    // Reads are forwarded too.
    let (_, v) = mcp_call(&n2.addr, "canvas_read", json!({"fileId": FILE})).await;
    assert!(v.to_string().contains("From MCP on n2"), "{v}");
}

#[tokio::test]
async fn forged_tool_forward_is_refused() {
    let (_host, _fake, n1, _n2) = two_nodes().await;
    let mut a = Peer::join(&n1.state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    let room = grant("u_a", Role::Edit).room;
    let body = json!({"requestId": "r1", "hostId": "sample", "fileId": FILE,
        "grant": grant("u_evil", Role::Edit), "origin": "mcp:evil", "mode": "direct",
        "name": "canvas_patch",
        "args": {"fileId": FILE, "ops": [{"op": "append", "markdown": "forged"}]}});
    let res = http()
        .post(format!("http://{}/v1/internal/tools/{room}", n1.addr))
        .header("x-oc-cluster-ts", oc_server::util::now_secs().to_string())
        .header("x-oc-cluster-sig", "00".repeat(32))
        .header("x-oc-cluster-node", "n2")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 401);
    a.settle().await;
    assert!(!has(&json_of(&a.doc), "forged"));
}

#[tokio::test]
async fn a_repeated_forward_request_id_runs_once() {
    let (_host, _fake, n1, n2) = two_nodes().await;
    let mut a = Peer::join(&n1.state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    let room = grant("u_a", Role::Edit).room;
    let body = serde_json::to_vec(&json!({"requestId": "req-once", "hostId": "sample",
        "fileId": FILE, "grant": grant("u_b", Role::Edit), "origin": "mcp:test",
        "mode": "direct", "name": "canvas_patch",
        "args": {"fileId": FILE, "ops": [{"op": "append", "markdown": "only once"}]}}))
    .unwrap();
    let cluster = n2.state.rooms.cluster().unwrap().clone();
    for _ in 0..2 {
        let mut req = http()
            .post(format!("http://{}/v1/internal/tools/{room}", n1.addr))
            .header("content-type", "application/json");
        for (k, v) in cluster.sign(&room, &body) {
            req = req.header(k, v);
        }
        let res = req.body(body.clone()).send().await.unwrap();
        assert_eq!(res.status().as_u16(), 200);
        let v: Value = res.json().await.unwrap();
        assert!(v.get("ok").is_some(), "{v}");
    }
    a.settle().await;
    let text = json_of(&a.doc).to_string();
    assert_eq!(text.matches("only once").count(), 1, "{text}");
}

#[tokio::test]
async fn an_unreachable_owner_answers_503_with_retry_after() {
    let (_host, _fake, n1, n2) = two_nodes().await;
    let mut a = Peer::join(&n1.state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    n1.server.abort();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let res = http()
        .post(format!("http://{}/mcp/sample", n2.addr))
        .bearer_auth(mcp_token())
        .json(&json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": {"name": "canvas_read", "arguments": {"fileId": FILE}}}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 503);
    assert_eq!(res.headers()["retry-after"], "2");
}

/// HAPI-05: a stream on a node that does not own the room gets the owner's events over the
/// bus, in order, and can resume from that node's own ring.
#[tokio::test]
async fn change_events_reach_streams_on_every_node() {
    let (_host, _fake, n1, n2) = two_nodes().await;
    let room = grant("u_a", Role::Edit).room;
    let mut on_n2 = n2
        .state
        .events()
        .subscribe(&room, FILE, "sample", None)
        .unwrap();
    let mut a = Peer::join(&n1.state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    let mut b = Peer::join(&n2.state, grant("u_b", Role::Edit)).await;
    b.settle().await;
    assert!(!n2.state.rooms.is_live(&room), "n2 relays");
    b.edit(|d| para(d, "from B"));
    b.settle().await;
    let mut got = vec![];
    while got.len() < 3 {
        let e = tokio::time::timeout(Duration::from_secs(10), on_n2.rx.recv())
            .await
            .unwrap_or_else(|_| panic!("got {got:?}"))
            .unwrap();
        got.push(e);
    }
    let kinds: Vec<&str> = got.iter().map(|e| e.kind.as_str()).collect();
    assert_eq!(kinds, ["member.joined", "member.joined", "edited"]);
    assert_eq!(got[2].data["by"], json!(["u_b"]));
    assert_eq!(
        got[2].data["untracked"], true,
        "a paragraph without a blockId"
    );
    // n2 kept them: a resume there answers the events after the first.
    let again = n2
        .state
        .events()
        .subscribe(&room, FILE, "sample", Some(&got[0].id))
        .unwrap();
    let ids: Vec<&str> = again.backlog.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, [got[1].id.as_str(), got[2].id.as_str()]);
}
