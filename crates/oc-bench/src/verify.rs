//! `oc-bench verify`: correctness under failure (docs/22 §8): crash recovery and cluster chaos.
//!
//!   oc-bench verify --server URL[,URL…] --rooms 200 --per-room 2 --secs 40 --host-port 8722 \
//!       [--crash-at 20 --kill-pid PID --restart "cmd"] [--spread 1] --out verify.json
//!
//! Every client types a paragraph with a unique token (`T<room>_<client>_<n>`) every
//! `--interval-ms` (250) while connected, and reconnects with the same ticket whenever its socket
//! drops (to the next server in the list if its own refuses). A token is **acknowledged** once a
//! different client of the same room holds it: the owner appends to the WAL before it fans out,
//! so an acknowledged edit is durable by design.
//!
//! Crash mode (`--crash-at`): at that second it records the acknowledged set, `kill -9`s
//! `--kill-pid`, holds every client offline, runs `--restart` (a shell command that starts the
//! server again), times `/readyz`, then opens one fresh viewer per room and checks that the
//! recovered server state holds every token acknowledged before the kill (no client resend has
//! happened yet). Then clients reconnect and type for the rest of `--secs`.
//!
//! At the end (both modes): typing stops; every room must converge (all clients hold the same
//! content, with every token any client sent); a fresh viewer per room must see exactly that
//! content (the server's state); and, after autosave, the host's latest saved file per room
//! must hold every token. Cluster events (kill, restart, pause) are run by the calling script.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message as Ws;
use yrs::encoding::read::Cursor;
use yrs::sync::protocol::MessageReader;
use yrs::sync::{Message, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::{Doc, ReadTxn, Transact, Update, XmlElementPrelim, XmlFragment, XmlTextPrelim};

use crate::client::{Counters, RunCfg, Shared, launch, sync_frame};
use crate::docs::DocKind;
use crate::mockhost::{self, HostStats};
use crate::{Args, host_latency, pct};

/// Tokens in a document's text, in order.
fn tokens(doc: &Doc) -> (String, BTreeSet<String>) {
    let content = oc_model::doc_to_json(doc)["content"].to_string();
    (content.clone(), scan(&content))
}

fn scan(s: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b'"' && b[i + 1] == b'T' {
            let mut j = i + 2;
            while j < b.len() && (b[j].is_ascii_digit() || b[j] == b'_') {
                j += 1;
            }
            if j < b.len() && b[j] == b'"' && j > i + 2 {
                out.insert(s[i + 1..j].to_string());
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// (sent tokens, tokens held, content) of one client.
type RoomView = (Vec<String>, BTreeSet<String>, String);

#[derive(Default)]
struct Cl {
    room: usize,
    sent: Vec<String>,
    content: String,
    seen: BTreeSet<String>,
    /// Seconds from losing the socket to being synced again.
    gaps: Vec<f64>,
    connects: usize,
    closes: Vec<String>,
    node: usize,
}

struct Ctl {
    typing: AtomicBool,
    hold: AtomicBool,
    stop: AtomicBool,
    t0: Instant,
    /// token → seconds after start when first held by another client of its room.
    acked: Mutex<HashMap<String, f64>>,
    reconnects: AtomicU64,
}

#[allow(clippy::too_many_arguments)]
async fn client(
    sh: Arc<Shared>,
    ctl: Arc<Ctl>,
    me: Arc<Mutex<Cl>>,
    room: usize,
    k: usize,
    first_node: usize,
    interval: Duration,
) {
    let n_nodes = sh.cfg.http_base.len();
    let idx = room * 100 + k;
    // Launch (any node shares the session store in cluster mode).
    let mut node = first_node;
    let (ticket, room_id) = loop {
        match launch(&sh, &sh.cfg.http_base[node], idx, room, true).await {
            Ok(v) => break v,
            Err(e) => {
                me.lock().unwrap().closes.push(format!("launch: {e}"));
                node = (node + 1) % n_nodes;
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }
    };
    let doc = Doc::new();
    let mut n = 0usize;
    let mut down_since: Option<Instant> = None;
    let mut fails = 0usize;
    let mut node = first_node;
    while !ctl.stop.load(Ordering::SeqCst) {
        if ctl.hold.load(Ordering::SeqCst) {
            down_since.get_or_insert_with(Instant::now);
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        }
        let url = format!(
            "{}/v1/collab/{room_id}?ticket={ticket}",
            sh.cfg.ws_base[node]
        );
        let mut ws = match tokio::time::timeout(
            Duration::from_secs(5),
            tokio_tungstenite::connect_async(&url),
        )
        .await
        {
            Ok(Ok((ws, _))) => ws,
            _ => {
                down_since.get_or_insert_with(Instant::now);
                fails += 1;
                // Like a load balancer: after two failures on a node, try the next one.
                if fails.is_multiple_of(2) {
                    node = (node + 1) % n_nodes;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };
        {
            let mut m = me.lock().unwrap();
            m.connects += 1;
            m.node = node;
        }
        if m_connects(&me) > 1 {
            ctl.reconnects.fetch_add(1, Ordering::Relaxed);
        }
        let sv = doc.transact().state_vector();
        if ws
            .send(Ws::Binary(sync_frame(SyncMessage::SyncStep1(sv)).into()))
            .await
            .is_err()
        {
            continue;
        }
        let mut synced = false;
        let mut dirty = false;
        let mut tick = tokio::time::interval(interval);
        let mut refresh = tokio::time::interval(Duration::from_millis(100));
        // A paused (SIGSTOP) node keeps the socket open but says nothing: the server's own
        // heartbeat is 10 s, so give up on a silent socket after 15 s like a browser would.
        let mut last_rx = Instant::now();
        loop {
            if ctl.stop.load(Ordering::SeqCst) {
                let _ = ws.close(None).await;
                return;
            }
            if ctl.hold.load(Ordering::SeqCst) {
                me.lock().unwrap().closes.push("held offline".into());
                break;
            }
            tokio::select! {
                msg = ws.next() => {
                    let data = match msg {
                        Some(Ok(Ws::Binary(b))) => b,
                        Some(Ok(Ws::Close(cf))) => { me.lock().unwrap().closes.push(format!("close {cf:?}")); break; }
                        Some(Ok(_)) => { last_rx = Instant::now(); continue }
                        Some(Err(e)) => { me.lock().unwrap().closes.push(format!("error: {e}")); break; }
                        None => { me.lock().unwrap().closes.push("eof".into()); break; }
                    };
                    last_rx = Instant::now();
                    let mut d = DecoderV1::new(Cursor::new(&data));
                    let Ok(msgs) = MessageReader::new(&mut d).collect::<Result<Vec<_>, _>>() else { continue };
                    for m in msgs {
                        match m {
                            Message::Sync(SyncMessage::SyncStep1(sv)) => {
                                // Also resends anything the server lost (Yjs sync is idempotent).
                                let diff = doc.transact().encode_state_as_update_v1(&sv);
                                let _ = ws.send(Ws::Binary(sync_frame(SyncMessage::SyncStep2(diff)).into())).await;
                            }
                            Message::Sync(SyncMessage::SyncStep2(u) | SyncMessage::Update(u)) => {
                                if let Ok(u) = Update::decode_v1(&u) {
                                    let _ = doc.transact_mut().apply_update(u);
                                    dirty = true;
                                }
                            }
                            Message::Custom(100, body) => {
                                let c: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                                if c["t"] == "role" && !synced {
                                    synced = true;
                                    if let Some(t) = down_since.take() {
                                        me.lock().unwrap().gaps.push(t.elapsed().as_secs_f64());
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ = refresh.tick() => {
                    if last_rx.elapsed() > Duration::from_secs(15) {
                        me.lock().unwrap().closes.push("silent 15 s".into());
                        node = (node + 1) % n_nodes;
                        break;
                    }
                    if dirty {
                        dirty = false;
                        let (content, seen) = tokens(&doc);
                        let mine = format!("T{room}_{k}_");
                        let now = ctl.t0.elapsed().as_secs_f64();
                        {
                            let mut acked = ctl.acked.lock().unwrap();
                            for t in &seen {
                                if !t.starts_with(&mine) {
                                    acked.entry(t.clone()).or_insert(now);
                                }
                            }
                        }
                        let mut m = me.lock().unwrap();
                        m.content = content;
                        m.seen = seen;
                    }
                }
                _ = tick.tick() => {
                    if !synced || !ctl.typing.load(Ordering::SeqCst) {
                        continue;
                    }
                    n += 1;
                    let token = format!("T{room}_{k}_{n}");
                    let sv = doc.transact().state_vector();
                    {
                        let content = doc.get_or_insert_xml_fragment("content");
                        let mut txn = doc.transact_mut();
                        let p = content.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
                        p.push_back(&mut txn, XmlTextPrelim::new(token.as_str()));
                    }
                    let update = doc.transact().encode_state_as_update_v1(&sv);
                    me.lock().unwrap().sent.push(token);
                    dirty = true;
                    if ws.send(Ws::Binary(sync_frame(SyncMessage::Update(update)).into())).await.is_err() {
                        break;
                    }
                }
            }
        }
        down_since.get_or_insert_with(Instant::now);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn m_connects(me: &Arc<Mutex<Cl>>) -> usize {
    me.lock().unwrap().connects
}

/// A fresh viewer reads the room's state from the server: (content, tokens, ms to sync).
async fn viewer(
    sh: &Shared,
    node: usize,
    room: usize,
    idx: usize,
) -> anyhow::Result<(String, BTreeSet<String>, u64)> {
    let t = Instant::now();
    let (ticket, room_id) = launch(sh, &sh.cfg.http_base[node], idx, room, false).await?;
    let url = format!(
        "{}/v1/collab/{room_id}?ticket={ticket}",
        sh.cfg.ws_base[node]
    );
    let (mut ws, _) = tokio::time::timeout(
        Duration::from_secs(30),
        tokio_tungstenite::connect_async(&url),
    )
    .await??;
    ws.send(Ws::Binary(
        sync_frame(SyncMessage::SyncStep1(Default::default())).into(),
    ))
    .await?;
    let doc = Doc::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut got_state = false;
    while Instant::now() < deadline {
        let Ok(Some(Ok(msg))) = tokio::time::timeout(Duration::from_secs(10), ws.next()).await
        else {
            anyhow::bail!("viewer socket ended");
        };
        let Ws::Binary(data) = msg else { continue };
        let mut d = DecoderV1::new(Cursor::new(&data));
        let Ok(msgs) = MessageReader::new(&mut d).collect::<Result<Vec<_>, _>>() else {
            continue;
        };
        for m in msgs {
            if let Message::Sync(SyncMessage::SyncStep2(u)) = m {
                if let Ok(u) = Update::decode_v1(&u) {
                    let _ = doc.transact_mut().apply_update(u);
                }
                got_state = true;
            }
        }
        if got_state {
            break;
        }
    }
    let _ = ws.close(None).await;
    if !got_state {
        anyhow::bail!("viewer got no state");
    }
    let (c, s) = tokens(&doc);
    Ok((c, s, t.elapsed().as_millis() as u64))
}

fn saved_tokens(bytes: &[u8]) -> Option<BTreeSet<String>> {
    let doc = oc_model::read_ocanvas(bytes).ok()?.doc;
    Some(tokens(&doc).1)
}

pub async fn run(a: Args) -> anyhow::Result<()> {
    let http_base: Vec<String> = a
        .s("server", "http://127.0.0.1:8701")
        .split(',')
        .map(|s| s.trim_end_matches('/').to_string())
        .collect();
    let ws_base: Vec<String> = http_base
        .iter()
        .map(|b| b.replacen("http://", "ws://", 1))
        .collect();
    let rooms: usize = a.n("rooms", 200);
    let per_room: usize = a.n("per-room", 2);
    let secs: f64 = a.n("secs", 40.0);
    let interval = Duration::from_millis(a.n("interval-ms", 250));
    let spread = a.s("spread", "0") == "1";
    let crash_at: f64 = a.n("crash-at", 0.0);
    let save_wait: u64 = a.n("save-wait-secs", 15);
    let label = a.s("label", "verify");
    let stats = Arc::new(HostStats::default());
    stats.store.store(true, Ordering::Relaxed);
    *stats.latency_ms.lock().unwrap() = host_latency(&a);
    let host_port: u16 = a.n("host-port", 8722);
    mockhost::serve(host_port, stats.clone()).await?;
    let run_id = format!(
        "v{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs()
            % 100_000
    );
    let sh = Arc::new(Shared {
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()?,
        cfg: RunCfg {
            http_base: http_base.clone(),
            ws_base,
            sticky: true,
            secret: a.s("secret", "bench-secret-0123456789abcdef0123456789"),
            host_id: a.s("host-id", "bench"),
            run_id,
            doc: DocKind::Empty,
            cps: (1.0, 1.0),
            active: 1.0,
        },
        host: stats.clone(),
        sent: Default::default(),
        lat_us: Default::default(),
        connect_ms: Default::default(),
        c: Counters::default(),
        closes: Default::default(),
        errors: Default::default(),
        quiet: false.into(),
    });
    let ctl = Arc::new(Ctl {
        typing: true.into(),
        hold: false.into(),
        stop: false.into(),
        t0: Instant::now(),
        acked: Mutex::default(),
        reconnects: AtomicU64::new(0),
    });
    let n = http_base.len();
    let mut cls = Vec::new();
    let mut tasks = Vec::new();
    for room in 0..rooms {
        for k in 0..per_room {
            let me = Arc::new(Mutex::new(Cl {
                room,
                ..Cl::default()
            }));
            cls.push(me.clone());
            // --spread: a room's clients land on different nodes (relay path); else by room.
            let node = if spread { (room + k) % n } else { room % n };
            tasks.push(tokio::spawn(client(
                sh.clone(),
                ctl.clone(),
                me,
                room,
                k,
                node,
                interval,
            )));
            tokio::time::sleep(Duration::from_millis(3)).await;
        }
    }
    println!(
        "# {label}: {rooms} rooms x {per_room} typing clients, {n} server(s), {secs}s, spread {spread}"
    );
    let mut report = json!({"label": label, "rooms": rooms, "perRoom": per_room, "servers": http_base,
                            "secs": secs, "spread": spread});
    let mut ok = true;
    let mut acked_before_kill: BTreeSet<String> = BTreeSet::new();

    if crash_at > 0.0 {
        while ctl.t0.elapsed().as_secs_f64() < crash_at {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let pid = a.s("kill-pid", "");
        let sent_before: usize = cls.iter().map(|c| c.lock().unwrap().sent.len()).sum();
        ctl.hold.store(true, Ordering::SeqCst);
        let st = std::process::Command::new("kill")
            .args(["-9", &pid])
            .status()?;
        let killed_at = Instant::now();
        // Edits acknowledged before the kill (the kill is instant, so this is the set).
        tokio::time::sleep(Duration::from_millis(300)).await;
        let acked_before: HashMap<String, f64> = ctl.acked.lock().unwrap().clone();
        acked_before_kill = acked_before.keys().cloned().collect();
        ctl.typing.store(false, Ordering::SeqCst);
        println!(
            "kill -9 {pid} ({st}) at {crash_at}s: {} edits sent, {} acknowledged",
            sent_before,
            acked_before.len()
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
        *stats.mark.lock().unwrap() = Some(Instant::now());
        let restart = a.s("restart", "");
        let t_restart = Instant::now();
        std::process::Command::new("sh")
            .args(["-c", &restart])
            .status()?;
        let mut ready_ms = None;
        while t_restart.elapsed() < Duration::from_secs(120) {
            if let Ok(r) = sh.http.get(format!("{}/readyz", http_base[0])).send().await
                && r.status().is_success()
            {
                ready_ms = Some(t_restart.elapsed().as_millis() as u64);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        println!("restart → /readyz: {ready_ms:?} ms");
        // Recovered state, before any client resends: one fresh viewer per room.
        let t_open = Instant::now();
        let mut opens = Vec::new();
        let mut handles = Vec::new();
        let gate = Arc::new(tokio::sync::Semaphore::new(32));
        for room in 0..rooms {
            let (sh2, g) = (sh.clone(), gate.clone());
            handles.push(tokio::spawn(async move {
                let _p = g.acquire().await;
                (room, viewer(&sh2, room % n, room, 900_000 + room).await)
            }));
        }
        let mut lost = Vec::new();
        let mut recovered_unacked = 0usize;
        let mut viewer_err = 0usize;
        let mut by_room: HashMap<usize, BTreeSet<String>> = HashMap::new();
        for h in handles {
            let (room, r) = h.await?;
            match r {
                Ok((_, toks, ms)) => {
                    opens.push(ms as u32);
                    by_room.insert(room, toks);
                }
                Err(e) => {
                    viewer_err += 1;
                    println!("viewer room {room}: {e}");
                }
            }
        }
        let open_all_ms = t_open.elapsed().as_millis() as u64;
        for t in acked_before.keys() {
            let room: usize = t[1..].split('_').next().unwrap_or("0").parse().unwrap_or(0);
            if let Some(toks) = by_room.get(&room)
                && !toks.contains(t)
            {
                lost.push(t.clone());
            }
        }
        for c in &cls {
            let c = c.lock().unwrap();
            if let Some(toks) = by_room.get(&c.room) {
                recovered_unacked += c
                    .sent
                    .iter()
                    .filter(|t| toks.contains(*t) && !acked_before.contains_key(*t))
                    .count();
            }
        }
        opens.sort_unstable();
        println!(
            "recovered state: {} rooms read in {open_all_ms} ms (room open p50 {} p95 {} max {} ms); acked-before-kill lost: {}; sent-but-unacked also recovered: {recovered_unacked}; viewer errors {viewer_err}",
            opens.len(),
            pct(&opens, 0.5),
            pct(&opens, 0.95),
            opens.last().copied().unwrap_or(0),
            lost.len()
        );
        ok &= lost.is_empty() && viewer_err == 0 && ready_ms.is_some();
        report["crash"] = json!({"atSecs": crash_at, "sentBeforeKill": sent_before,
            "ackedBeforeKill": acked_before.len(), "readyMs": ready_ms,
            "killToReadyMs": killed_at.elapsed().as_millis() as u64 - open_all_ms,
            "roomsRead": opens.len(), "readAllMs": open_all_ms,
            "roomOpenMs": {"p50": pct(&opens, 0.5), "p95": pct(&opens, 0.95), "max": opens.last()},
            "lostAcked": lost.len(), "lostSample": lost.iter().take(20).collect::<Vec<_>>(),
            "recoveredUnacked": recovered_unacked, "viewerErrors": viewer_err});
        // Clients come back and type again.
        ctl.typing.store(true, Ordering::SeqCst);
        ctl.hold.store(false, Ordering::SeqCst);
    }

    while ctl.t0.elapsed().as_secs_f64() < secs {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    ctl.typing.store(false, Ordering::SeqCst);
    let typed_until = Instant::now();
    println!("typing stopped; waiting for convergence");
    // Convergence: per room, every client holds every token any client of the room sent, and
    // all clients' content is identical.
    let deadline = Instant::now() + Duration::from_secs(90);
    let (converged, bad_rooms) = loop {
        let mut bad = BTreeSet::new();
        let mut per: BTreeMap<usize, Vec<RoomView>> = BTreeMap::new();
        for c in &cls {
            let c = c.lock().unwrap();
            per.entry(c.room).or_default().push((
                c.sent.clone(),
                c.seen.clone(),
                c.content.clone(),
            ));
        }
        for (room, v) in &per {
            let all: BTreeSet<&String> = v.iter().flat_map(|x| &x.0).collect();
            let every = v.iter().all(|x| all.iter().all(|t| x.1.contains(*t)));
            let same = v.windows(2).all(|w| w[0].2 == w[1].2);
            if !(every && same) {
                bad.insert(*room);
            }
        }
        if bad.is_empty() {
            break (true, bad);
        }
        if Instant::now() > deadline {
            break (false, bad);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    let converge_ms = typed_until.elapsed().as_millis() as u64;
    println!(
        "converged: {converged} in {converge_ms} ms (rooms not converged: {})",
        bad_rooms.len()
    );
    ok &= converged;
    // Server state = a fresh viewer's state, compared with the clients' (from another node
    // than the room's first client when there are several).
    let mut mismatch = 0usize;
    let mut viewer_err = 0usize;
    let mut handles = Vec::new();
    let gate = Arc::new(tokio::sync::Semaphore::new(32));
    for room in 0..rooms {
        let (sh2, g) = (sh.clone(), gate.clone());
        handles.push(tokio::spawn(async move {
            let _p = g.acquire().await;
            (
                room,
                viewer(&sh2, (room + 2) % n, room, 950_000 + room).await,
            )
        }));
    }
    let mut server_content: HashMap<usize, BTreeSet<String>> = HashMap::new();
    for h in handles {
        let (room, r) = h.await?;
        match r {
            Ok((content, toks, _)) => {
                let differs = cls.iter().any(|c| {
                    let c = c.lock().unwrap();
                    c.room == room && c.content != content
                });
                if differs {
                    mismatch += 1;
                }
                server_content.insert(room, toks);
            }
            Err(e) => {
                viewer_err += 1;
                println!("final viewer room {room}: {e}");
            }
        }
    }
    println!("server state vs clients: {mismatch} rooms differ, {viewer_err} viewer errors");
    ok &= mismatch == 0 && viewer_err == 0;
    // Every acknowledged edit (whenever) in the server state.
    let acked = ctl.acked.lock().unwrap().clone();
    let lost_final: Vec<&String> = acked
        .keys()
        .filter(|t| {
            let room: usize = t[1..].split('_').next().unwrap_or("0").parse().unwrap_or(0);
            server_content.get(&room).is_some_and(|s| !s.contains(*t))
        })
        .collect();
    let sent_total: usize = cls.iter().map(|c| c.lock().unwrap().sent.len()).sum();
    println!(
        "edits: {sent_total} sent, {} acknowledged, {} acknowledged but missing from the server",
        acked.len(),
        lost_final.len()
    );
    ok &= lost_final.is_empty();
    // Close the clients (last client leaving saves), then wait for autosave and read the host.
    ctl.stop.store(true, Ordering::SeqCst);
    for t in tasks {
        let _ = tokio::time::timeout(Duration::from_secs(3), t).await;
    }
    tokio::time::sleep(Duration::from_secs(save_wait)).await;
    let mut save_missing = 0usize;
    let mut save_absent = 0usize;
    {
        let stored = stats.stored.lock().unwrap();
        let mut per_room: HashMap<usize, BTreeSet<String>> = HashMap::new();
        for c in &cls {
            let c = c.lock().unwrap();
            per_room
                .entry(c.room)
                .or_default()
                .extend(c.sent.iter().cloned());
        }
        for (room, want) in &per_room {
            let file = crate::client::file_id(&sh.cfg, *room);
            match stored.get(&file).and_then(|b| saved_tokens(b)) {
                Some(have) => save_missing += want.difference(&have).count(),
                None => save_absent += 1,
            }
        }
    }
    // The first save after the restart (crash mode): did it hold the pre-kill acked edits?
    let mut first_after = json!(null);
    if let Some(mark) = *stats.mark.lock().unwrap() {
        let firsts = stats.first_after_mark.lock().unwrap();
        // Every edit acknowledged before the kill must be in the room's first save after it.
        let mut first_missing = 0usize;
        for t in &acked_before_kill {
            let room: usize = t[1..].split('_').next().unwrap_or("0").parse().unwrap_or(0);
            let file = crate::client::file_id(&sh.cfg, room);
            match firsts.get(&file).and_then(|(_, b)| saved_tokens(b)) {
                Some(have) if have.contains(t) => {}
                _ => first_missing += 1,
            }
        }
        let mut delays: Vec<u32> = firsts
            .values()
            .map(|(t, _)| t.duration_since(mark).as_millis() as u32)
            .collect();
        delays.sort_unstable();
        first_after = json!({"rooms": firsts.len(),
            "msAfterRestart": {"p50": pct(&delays, 0.5), "max": delays.last()},
            "missingPreKillAcked": first_missing,
            "note": "first host save per room after the restart"});
        ok &= first_missing == 0;
    }
    println!(
        "host: {} saves; latest saved file per room: {save_absent} rooms without a save, {save_missing} sent edits missing; first saves after restart: {first_after}",
        stats.saves.load(Ordering::Relaxed)
    );
    ok &= save_absent == 0 && save_missing == 0;
    let mut gaps: Vec<u32> = cls
        .iter()
        .flat_map(|c| {
            c.lock()
                .unwrap()
                .gaps
                .iter()
                .map(|g| (g * 1000.0) as u32)
                .collect::<Vec<_>>()
        })
        .collect();
    gaps.sort_unstable();
    let mut closes: BTreeMap<String, usize> = BTreeMap::new();
    for c in &cls {
        for r in &c.lock().unwrap().closes {
            let key: String = r.chars().take(60).collect();
            *closes.entry(key).or_default() += 1;
        }
    }
    println!(
        "reconnects {}: resync gap p50 {} p95 {} max {} ms; closes {closes:?}",
        gaps.len(),
        pct(&gaps, 0.5),
        pct(&gaps, 0.95),
        gaps.last().copied().unwrap_or(0)
    );
    report["final"] = json!({"converged": converged, "notConverged": bad_rooms.len(), "convergeMs": converge_ms,
        "serverMismatchRooms": mismatch, "viewerErrors": viewer_err, "sent": sent_total, "acked": acked.len(),
        "lostAcked": lost_final.len(), "hostSaves": stats.saves.load(Ordering::Relaxed),
        "roomsWithoutSave": save_absent, "sentMissingFromSave": save_missing, "firstSaveAfterRestart": first_after,
        "resyncGapMs": {"n": gaps.len(), "p50": pct(&gaps, 0.5), "p95": pct(&gaps, 0.95), "max": gaps.last()},
        "closes": closes, "pass": ok});
    println!("{}", if ok { "PASS" } else { "FAIL" });
    if let Some(out) = a.0.get("out") {
        std::fs::write(out, serde_json::to_vec_pretty(&report)?)?;
    }
    std::process::exit(if ok { 0 } else { 1 });
}
