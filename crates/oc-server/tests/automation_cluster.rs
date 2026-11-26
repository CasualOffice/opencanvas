// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Automation in a real cluster (AUTO-01..07, ADR-067/068): three nodes on one MySQL/MariaDB
//! database with Redis for leases, the members/events bus and the hot WAL. A schedule slot runs
//! once (also when the node that claimed it dies), a row change runs its rule once, the loop
//! guard, the daily limit and auto-pause hold across nodes, and the run log has no duplicates.
//!
//! Needs both `OC_TEST_REDIS_URL` (for example `redis://127.0.0.1:13318`) and
//! `OC_TEST_MYSQL_URL` (for example `mysql://root:root@127.0.0.1:13316/opencanvas`); skipped
//! otherwise. Each test makes its own database and uses its own Redis database index and
//! cluster secret, so the tests run in parallel against one Redis.

mod common;

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use common::*;
use oc_server::SharedState;
use oc_server::cluster::{Cluster, ClusterConfig};
use oc_server::grant::Role;
use serde_json::{Value, json};

const KEY: &str = "auto-key";
static NEXT_DB: AtomicU32 = AtomicU32::new(1);

struct Env {
    mysql: String,
    redis: String,
    secret: String,
}

/// A fresh MySQL database and Redis index for one test; `None` (skip) without both env vars.
async fn env() -> Option<Env> {
    let (Ok(my), Ok(redis)) = (
        std::env::var("OC_TEST_MYSQL_URL"),
        std::env::var("OC_TEST_REDIS_URL"),
    ) else {
        eprintln!(
            "OC_TEST_REDIS_URL and OC_TEST_MYSQL_URL not both set: automation cluster tests skipped"
        );
        return None;
    };
    sqlx::any::install_default_drivers();
    let name = format!("oc_auto_{}", ulid::Ulid::new().to_string().to_lowercase());
    let admin = sqlx::AnyPool::connect(&my).await.unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
        .execute(&admin)
        .await
        .unwrap();
    let base = my.rsplit_once('/').unwrap().0;
    // Redis indexes 1..15, one per test of this file (pub/sub is shared: the secret differs).
    let idx = NEXT_DB.fetch_add(1, Ordering::Relaxed) % 15 + 1;
    let redis = format!("{}/{idx}", redis.trim_end_matches('/'));
    let mut c = redis::Client::open(redis.as_str())
        .unwrap()
        .get_multiplexed_async_connection()
        .await
        .unwrap();
    let _: () = redis::cmd("FLUSHDB").query_async(&mut c).await.unwrap();
    Some(Env {
        mysql: format!("{base}/{name}"),
        redis,
        secret: format!("auto-cluster-secret-{}", ulid::Ulid::new()),
    })
}

fn on(h: &mut oc_server::hosts::HostConfig, extra: &str) {
    h.api_key = Some(KEY.into());
    h.flags.insert("api_v1".into(), toml::Value::Boolean(true));
    for (k, v) in [
        ("rate_per_sec", 100_000),
        ("burst", 100_000),
        ("file_writes_per_sec", 100_000),
        ("file_burst", 100_000),
    ] {
        h.api.insert(k.into(), toml::Value::Integer(v));
    }
    h.automation =
        toml::from_str(&format!("enabled = true\ntime_zone = \"UTC\"\n{extra}")).unwrap();
}

struct Node {
    id: String,
    state: SharedState,
    server: tokio::task::JoinHandle<()>,
    renewer: tokio::task::JoinHandle<()>,
    addr: String,
}

impl Node {
    /// The process dies: no answers, no lease renewals, its rooms gone without a save.
    fn kill(&self) {
        self.server.abort();
        self.renewer.abort();
        for room in self.state.rooms.cluster().unwrap().leases.owned_rooms() {
            self.state.rooms.crash(&room);
        }
    }
}

async fn node(base: &str, e: &Env, id: &str, extra: &str) -> Node {
    let (my, redis) = (e.mysql.clone(), e.redis.clone());
    let state = app_full(
        base,
        room_cfg(),
        &temp_db(),
        |h| on(h, extra),
        move |c| {
            c.database_url = my;
            c.wal_redis_url = Some(redis);
        },
    )
    .await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut cfg = ClusterConfig::build(
        Some(e.redis.clone()),
        &e.mysql,
        Some(id.into()),
        Some(format!("http://{addr}")),
        Some(e.secret.clone()),
        "unused",
    )
    .unwrap()
    .unwrap();
    cfg.lease_ttl = Duration::from_secs(3);
    let cluster = Cluster::connect(cfg).await.unwrap();
    state.join_cluster(cluster.clone());
    let renewer = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            cluster.leases.renew_all().await;
        }
    });
    let app = oc_server::app(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Node {
        id: id.into(),
        state,
        server,
        renewer,
        addr: addr.to_string(),
    }
}

async fn cluster(extra: &str) -> Option<(Shared, String, Vec<Node>)> {
    let e = env().await?;
    let (base, host) = mock_host().await;
    host.lock().unwrap().access = Some([("u_lea".to_string(), "edit".to_string())].into());
    let mut nodes = vec![];
    for id in ["n1", "n2", "n3"] {
        nodes.push(node(&base, &e, id, extra).await);
    }
    Some((host, base, nodes))
}

async fn api(addr: &str, m: reqwest::Method, path: &str, body: Option<Value>) -> (u16, Value) {
    let mut r = reqwest::Client::new()
        .request(m, format!("http://{addr}/api/v1/files/{FILE}{path}"))
        .header("x-opencanvas-host", "sample")
        .header("x-opencanvas-key", KEY)
        .header("x-opencanvas-author", "u_lea");
    if let Some(b) = body {
        r = r.json(&b);
    }
    let res = r.send().await.unwrap();
    let s = res.status().as_u16();
    (s, res.json().await.unwrap_or(Value::Null))
}

async fn put_rule(addr: &str, id: &str, rule: Value) {
    let (s, v) = api(
        addr,
        reqwest::Method::PUT,
        &format!("/automations/{id}"),
        Some(rule),
    )
    .await;
    assert_eq!(s, 200, "{v}");
}

/// Backlog (Task, Status, Owner) with one row owned by Noor: (db, row).
async fn backlog(addr: &str) -> (String, String) {
    let (s, v) = api(addr, reqwest::Method::POST, "/databases", Some(json!({"name": "Backlog",
        "fields": [{"name": "Task", "type": "title"}, {"name": "Status", "type": "select", "options": ["Open", "Done"]},
                   {"name": "Owner", "type": "person"}],
        "rows": [{"values": {"Task": "Ship it", "Status": "Open", "Owner": "u_noor"}}]}))).await;
    assert_eq!(s, 200, "{v}");
    (
        v["dbId"].as_str().unwrap().to_string(),
        v["rowIds"][0].as_str().unwrap().to_string(),
    )
}

async fn set_status(addr: &str, db: &str, row: &str, v: &str) {
    let (s, b) = api(
        addr,
        reqwest::Method::POST,
        &format!("/databases/{db}/rows:upsert"),
        Some(json!({"rows": [{"rowId": row, "values": {"Status": v}}]})),
    )
    .await;
    assert_eq!(s, 200, "{b}");
}

fn room() -> String {
    oc_server::grant::room_id("sample", FILE)
}

/// The run log as every node reads it: the same rows on each, no id twice.
async fn runs(nodes: &[Node]) -> Vec<Value> {
    let mut last = vec![];
    for _ in 0..40 {
        let mut all = vec![];
        for n in nodes.iter().filter(|n| !n.server.is_finished()) {
            let (s, v) = api(&n.addr, reqwest::Method::GET, "/automations/runs", None).await;
            assert_eq!(s, 200, "{v}");
            all.push(v["runs"].as_array().cloned().unwrap_or_default());
        }
        if all.windows(2).all(|w| w[0] == w[1]) {
            let list = all.swap_remove(0);
            let mut ids: Vec<&str> = list.iter().map(|r| r["id"].as_str().unwrap()).collect();
            ids.sort();
            let n = ids.len();
            ids.dedup();
            assert_eq!(ids.len(), n, "duplicate run ids: {list:?}");
            return list;
        }
        last = all;
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the nodes read different run logs: {last:?}");
}

fn count(runs: &[Value], result: &str) -> usize {
    runs.iter().filter(|r| r["result"] == result).count()
}

async fn eventually(what: &str, mut f: impl AsyncFnMut() -> bool) {
    for _ in 0..400 {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("{what}: not met in 10 s");
}

fn owner_of(nodes: &[Node]) -> Option<usize> {
    nodes
        .iter()
        .position(|n| n.state.rooms.cluster().unwrap().leases.owns(&room()))
}

/// Saves and closes the room wherever it is, so the next request places it afresh.
async fn close_room(nodes: &[Node]) {
    if let Some(i) = owner_of(nodes) {
        assert!(nodes[i].state.rooms.close(&room()).await);
    }
    eventually("room released", async || owner_of(nodes).is_none()).await;
}

/// A date rule (due tomorrow, 09:00 UTC) on a canvas open on n1 with an editor connected:
/// the slot time and the editor.
async fn due_rule(host: &Shared, nodes: &[Node]) -> (i64, Peer) {
    // 2026-11-26 00:00 UTC; the row is due on the 27th, so the slot is the 26th at 09:00.
    let start = 1_795_651_200_000i64;
    for n in nodes {
        n.state.clock.set_ms(start);
    }
    let (s, v) = api(&nodes[0].addr, reqwest::Method::POST, "/databases", Some(json!({"name": "Backlog",
        "fields": [{"name": "Task", "type": "title"}, {"name": "Owner", "type": "person"}, {"name": "Due", "type": "date"}],
        "rows": [{"values": {"Task": "SSO settings page", "Owner": "u_noor", "Due": "2026-11-27"}}]}))).await;
    assert_eq!(s, 200, "{v}");
    let db = v["dbId"].as_str().unwrap().to_string();
    put_rule(&nodes[0].addr, "au_due", json!({"name": "Due tomorrow", "trigger": {"kind": "date.reached", "database": db, "field": "Due", "offsetDays": -1, "time": "09:00"},
        "actions": [{"kind": "notify", "people": ["field:Owner"], "text": "{row.title} is due tomorrow"}]})).await;
    let slot = start + 9 * 3_600_000;
    eventually("schedule row", async || {
        nodes[1]
            .state
            .store
            .automation_schedule_of(&room())
            .await
            .unwrap()
            == vec![("au_due".to_string(), slot)]
    })
    .await;
    // The host has the file, so a node that takes the room over can load it.
    let lea = Peer::join(&nodes[0].state, grant("u_lea", Role::Edit)).await;
    let (s, v) = api(&nodes[0].addr, reqwest::Method::POST, "/commit", None).await;
    assert_eq!(s, 200, "{v}");
    eventually("saved", async || !host.lock().unwrap().puts.is_empty()).await;
    assert_eq!(owner_of(nodes), Some(0));
    (slot, lea)
}

async fn sweep_all(nodes: &[Node]) -> usize {
    let live: Vec<&Node> = nodes.iter().filter(|n| !n.server.is_finished()).collect();
    let all = futures::future::join_all(
        live.iter()
            .map(|n| oc_server::automation::worker::sweep(&n.state, &n.id)),
    )
    .await;
    all.into_iter().map(|r| r.unwrap()).sum()
}

/// A slot due while the canvas is open on n1 runs once, whichever node's sweep claims it: a
/// node that does not own the room leaves the slot to the owner.
#[tokio::test]
async fn a_schedule_runs_once_across_three_nodes() {
    let Some((host, _base, nodes)) = cluster("").await else {
        return;
    };
    let (slot, _lea) = due_rule(&host, &nodes).await;
    for n in &nodes {
        n.state.clock.set_ms(slot + 30_000);
    }
    // The non-owners sweep first and leave the slot to the owner, which runs it; then all
    // three at once find nothing.
    for i in [2, 1, 0] {
        let n = &nodes[i];
        oc_server::automation::worker::sweep(&n.state, &n.id)
            .await
            .unwrap();
    }
    sweep_all(&nodes).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(host.lock().unwrap().mentions.len(), 1, "notified once");
    let r = runs(&nodes).await;
    assert_eq!((r.len(), count(&r, "done")), (1, 1), "{r:?}");
    assert_eq!(
        nodes[2]
            .state
            .store
            .automation_schedule_of(&room())
            .await
            .unwrap(),
        vec![("au_due".to_string(), slot + 86_400_000)]
    );
}

/// The node that owns the canvas claims the slot and dies before running it: once its claim
/// and its room lease expire, another node takes the room over and runs the slot once.
#[tokio::test]
async fn a_schedule_claimed_by_a_dead_node_runs_once_on_another() {
    let Some((host, _base, nodes)) = cluster("").await else {
        return;
    };
    let (slot, _lea) = due_rule(&host, &nodes).await;
    for n in &nodes {
        n.state.clock.set_ms(slot + 30_000);
    }
    let st = &nodes[0].state.store;
    let due = st.automation_due(slot + 30_000, 10).await.unwrap();
    assert_eq!(due.len(), 1);
    assert!(
        st.automation_claim(
            &due[0],
            "n1",
            slot + 30_000 + oc_server::automation::worker::CLAIM_MS
        )
        .await
        .unwrap()
    );
    nodes[0].kill();
    // Claimed: nobody else runs it.
    assert_eq!(sweep_all(&nodes).await, 0);
    // The claim and the room lease (3 s here) expire.
    for n in &nodes {
        n.state
            .clock
            .set_ms(slot + 30_000 + oc_server::automation::worker::CLAIM_MS + 1);
    }
    eventually("lease expired", async || {
        nodes[1]
            .state
            .rooms
            .cluster()
            .unwrap()
            .leases
            .owner(&room())
            .await
            .unwrap()
            .is_none()
    })
    .await;
    for _ in 0..5 {
        sweep_all(&nodes).await;
        if !host.lock().unwrap().mentions.is_empty() {
            break;
        }
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    sweep_all(&nodes).await;
    assert_eq!(host.lock().unwrap().mentions.len(), 1, "notified once");
    let r = runs(&nodes).await;
    assert_eq!((r.len(), count(&r, "done")), (1, 1), "{r:?}");
}

/// The node dies after it logged the run as started: the slot is not run a second time (its
/// actions may have happened), and the log row does not stay `running` forever.
#[tokio::test]
async fn a_run_interrupted_by_a_dead_node_is_not_repeated_and_is_logged_failed() {
    let Some((host, _base, nodes)) = cluster("").await else {
        return;
    };
    let (slot, _lea) = due_rule(&host, &nodes).await;
    let now = slot + 30_000;
    let st = &nodes[0].state.store;
    let due = st.automation_due(now, 10).await.unwrap();
    assert!(
        st.automation_claim(&due[0], "n1", now + oc_server::automation::worker::CLAIM_MS)
            .await
            .unwrap()
    );
    st.automation_run_insert(&oc_server::store::RunRow {
        id: format!("run_au_due_{}", slot / 1000),
        room_id: room(),
        host_id: "sample".into(),
        file_id: FILE.into(),
        rule_id: "au_due".into(),
        trigger: "date.reached".into(),
        result: "running".into(),
        error_code: String::new(),
        http_status: 0,
        changes: 0,
        notified: 0,
        depth: 0,
        duration_ms: 0,
        at: now,
    })
    .await
    .unwrap();
    nodes[0].kill();
    let later = now + oc_server::automation::worker::CLAIM_MS + 1;
    for n in &nodes {
        n.state.clock.set_ms(later);
    }
    eventually("lease expired", async || {
        nodes[1]
            .state
            .rooms
            .cluster()
            .unwrap()
            .leases
            .owner(&room())
            .await
            .unwrap()
            .is_none()
    })
    .await;
    for _ in 0..3 {
        sweep_all(&nodes).await;
    }
    assert!(host.lock().unwrap().mentions.is_empty(), "not run twice");
    assert_eq!(
        nodes[1]
            .state
            .store
            .automation_schedule_of(&room())
            .await
            .unwrap(),
        vec![("au_due".to_string(), slot + 86_400_000)],
        "the slot moved on"
    );
    // The janitor closes a run left `running` by a dead node.
    for n in &nodes {
        n.state
            .clock
            .set_ms(now + oc_server::automation::worker::STALE_RUN_MS + 1);
    }
    oc_server::automation::worker::purge(&nodes[2].state).await;
    let r = runs(&nodes).await;
    assert_eq!(r.len(), 1, "{r:?}");
    assert_eq!(
        (r[0]["result"].as_str(), r[0]["errorCode"].as_str()),
        (Some("failed"), Some("INTERRUPTED"))
    );
}

/// A row change made through any node runs its rule once, on the owner; the owner moving to
/// another node keeps that true.
#[tokio::test]
async fn row_changes_run_rules_once_from_any_node() {
    let Some((host, _base, nodes)) = cluster("").await else {
        return;
    };
    let (db, row) = backlog(&nodes[0].addr).await;
    put_rule(&nodes[0].addr, "au_1", json!({"name": "Tell the owner", "trigger": {"kind": "field.changed", "database": db, "field": "Status", "to": "Done"},
        "actions": [{"kind": "notify", "people": ["field:Owner"], "text": "{row.title} is done"}]})).await;
    let mut b = Peer::join(&nodes[1].state, grant("u_b", Role::Edit)).await;
    b.settle().await;
    for (i, via) in [1usize, 2, 0].into_iter().enumerate() {
        set_status(&nodes[via].addr, &db, &row, "Done").await;
        eventually("notified", async || host.lock().unwrap().mentions.len() > i).await;
        set_status(&nodes[via].addr, &db, &row, "Open").await;
    }
    // The owner moves (saved and closed), then a change through n3 opens it there.
    b.leave();
    close_room(&nodes).await;
    set_status(&nodes[2].addr, &db, &row, "Done").await;
    eventually("notified", async || host.lock().unwrap().mentions.len() > 3).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(host.lock().unwrap().mentions.len(), 4, "once per change");
    let r = runs(&nodes).await;
    assert_eq!((r.len(), count(&r, "done")), (4, 4), "{r:?}");
}

/// A loop of four rules (One → Two → Three → Four → One) started through different nodes stops
/// at depth 3 each time; the owner moving between starts changes nothing.
#[tokio::test]
async fn the_loop_guard_holds_across_nodes() {
    let Some((_host, _base, nodes)) = cluster("").await else {
        return;
    };
    let mut dbs = vec![];
    for name in ["One", "Two", "Three", "Four"] {
        let (s, v) = api(
            &nodes[0].addr,
            reqwest::Method::POST,
            "/databases",
            Some(json!({"name": name,
            "fields": [{"name": "Task", "type": "title"}]})),
        )
        .await;
        assert_eq!(s, 200, "{v}");
        dbs.push(v["dbId"].as_str().unwrap().to_string());
    }
    for i in 0..4 {
        put_rule(
            &nodes[1].addr,
            &format!("au_{i}"),
            json!({"name": format!("hop {i}"), "trigger": {"kind": "row.added", "database": dbs[i]},
            "actions": [{"kind": "row.move", "to": {"database": dbs[(i + 1) % 4]}}]}),
        )
        .await;
    }
    for (k, via) in [2usize, 1].into_iter().enumerate() {
        let (s, _) = api(
            &nodes[via].addr,
            reqwest::Method::POST,
            &format!("/databases/{}/rows:upsert", dbs[0]),
            Some(json!({"rows": [{"values": {"Task": format!("x{k}")}}]})),
        )
        .await;
        assert_eq!(s, 200);
        eventually("stopped", async || {
            count(&runs(&nodes).await, "stopped") > k
        })
        .await;
        close_room(&nodes).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let r = runs(&nodes).await;
    assert_eq!(
        (count(&r, "stopped"), count(&r, "done"), r.len()),
        (2, 6, 8),
        "{r:?}"
    );
    assert!(
        r.iter()
            .filter(|x| x["result"] == "stopped")
            .all(|x| x["errorCode"] == "MAX_DEPTH")
    );
    assert!(r.iter().all(|x| x["depth"].as_i64().unwrap() <= 3));
}

/// `runs_per_day = 3` counts runs on every node: two on n1, the owner moves to n2, one more
/// runs and the next (through n3) is skipped.
#[tokio::test]
async fn the_daily_limit_is_counted_cluster_wide() {
    let Some((host, _base, nodes)) = cluster("runs_per_day = 3").await else {
        return;
    };
    let (db, row) = backlog(&nodes[0].addr).await;
    put_rule(&nodes[0].addr, "au_1", json!({"name": "Tell the owner", "trigger": {"kind": "field.changed", "database": db, "field": "Status", "to": "Done"},
        "actions": [{"kind": "notify", "people": ["field:Owner"], "text": "{row.title} is done"}]})).await;
    let flip = async |via: usize, want: usize| {
        set_status(&nodes[via].addr, &db, &row, "Done").await;
        // Finished, not just logged: a run's row is written ("running") before it reads the
        // room, and closing the room under it fails it FILE_UNAVAILABLE (MariaDB on CI).
        eventually("finished", async || {
            let r = runs(&nodes).await;
            r.len() >= want && count(&r, "running") == 0
        })
        .await;
        set_status(&nodes[via].addr, &db, &row, "Open").await;
    };
    flip(0, 1).await;
    flip(0, 2).await;
    assert_eq!(owner_of(&nodes), Some(0));
    close_room(&nodes).await;
    flip(1, 3).await;
    assert_eq!(owner_of(&nodes), Some(1));
    flip(2, 4).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let r = runs(&nodes).await;
    assert_eq!(
        (count(&r, "done"), count(&r, "skipped"), r.len()),
        (3, 1, 4),
        "{r:?}"
    );
    assert_eq!(
        r.iter().find(|x| x["result"] == "skipped").unwrap()["errorCode"],
        "LIMIT_PER_DAY"
    );
    assert_eq!(host.lock().unwrap().mentions.len(), 3);
}

/// Ten failed runs in a row pause the rule even when they ran on different nodes; the owner is
/// told once and nothing runs after.
#[tokio::test]
async fn auto_pause_after_ten_failures_is_cluster_wide() {
    oc_server::automation::runner::set_url_retry_ms(1, 1);
    let Some((host, base, nodes)) = cluster("").await else {
        return;
    };
    let (db, row) = backlog(&nodes[0].addr).await;
    put_rule(&nodes[0].addr, "au_url", json!({"name": "Tell the bot", "trigger": {"kind": "field.changed", "database": db, "field": "Status"},
        "actions": [{"kind": "http.post", "url": format!("{base}/hooks"), "fields": []}]})).await;
    for i in 0..10 {
        if i == 5 {
            close_room(&nodes).await;
        }
        for _ in 0..3 {
            host.lock().unwrap().hook_answers.push_back((500, vec![]));
        }
        // Five failures with the room on n1, five with it on n2.
        let via = if i < 5 { 0 } else { 1 };
        set_status(
            &nodes[via].addr,
            &db,
            &row,
            if i % 2 == 0 { "Done" } else { "Open" },
        )
        .await;
        eventually("failed", async || count(&runs(&nodes).await, "failed") > i).await;
    }
    eventually("paused", async || {
        let (_, list) = api(&nodes[2].addr, reqwest::Method::GET, "/automations", None).await;
        list["rules"][0]["rule"]["paused"]["code"] == "FAILURES"
    })
    .await;
    assert_eq!(host.lock().unwrap().mentions.len(), 1, "told once");
    set_status(&nodes[2].addr, &db, &row, "Done").await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let r = runs(&nodes).await;
    assert_eq!((count(&r, "failed"), r.len()), (10, 10), "{r:?}");
}
