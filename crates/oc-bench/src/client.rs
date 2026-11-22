// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! One virtual user: launch (JWT → ticket), session lookup, WebSocket, then type / watch.
//!
//! Editors type 3–6 chars/s in bursts, move their caret (awareness), sometimes edit a database
//! cell or drag a board shape. Like the editor, they batch: at most one update frame and one
//! awareness frame per 50 ms window (≤ 20 Hz each, under the 60/s frame limit). Viewers only
//! receive. Latency: every update frame an editor sends is logged as (client, start clock, sent at);
//! probe clients decode each update they receive, read its state vector and look the frame up,
//! so the measured time is editor A's frame send → peer B's receipt (server apply, WAL append,
//! fan-out and both sockets). The ≤ 50 ms client batching window is not included.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use jsonwebtoken::{EncodingKey, Header};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message as Ws;
use yrs::encoding::read::Cursor;
use yrs::sync::awareness::AwarenessUpdateEntry;
use yrs::sync::protocol::MessageReader;
use yrs::sync::{AwarenessUpdate, Message, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::Encode;
use yrs::{
    ClientID, Doc, Map, MapPrelim, MapRef, ReadTxn, StateVector, Text, Transact, Update,
    XmlElementPrelim, XmlFragment, XmlTextPrelim, XmlTextRef,
};

use crate::mockhost::HostStats;

pub struct RunCfg {
    pub http_base: Vec<String>,
    pub ws_base: Vec<String>,
    /// `hash`: a room's sockets all go to one node (the LB's sticky hash); `rr`: round robin.
    pub sticky: bool,
    pub secret: String,
    pub host_id: String,
    pub run_id: String,
    pub doc: crate::docs::DocKind,
    /// Typing speed range, chars/s.
    pub cps: (f64, f64),
    /// Fraction of time an editor spends in a typing burst.
    pub active: f64,
}

#[derive(Default)]
pub struct Counters {
    pub started: AtomicU64,
    pub ready: AtomicU64,
    pub live: AtomicU64,
    pub launch_err: AtomicU64,
    pub ws_err: AtomicU64,
    pub dropped: AtomicU64,
    pub frames_in: AtomicU64,
    pub bytes_in: AtomicU64,
    pub frames_out: AtomicU64,
    pub bytes_out: AtomicU64,
    pub updates_out: AtomicU64,
    pub update_bytes_out: AtomicU64,
    pub awareness_out: AtomicU64,
    pub denied: AtomicU64,
}

type SentLog = Arc<Mutex<VecDeque<(u32, Instant)>>>;

pub struct Shared {
    pub http: reqwest::Client,
    pub cfg: RunCfg,
    pub host: Arc<HostStats>,
    pub sent: RwLock<HashMap<ClientID, SentLog>>,
    pub lat_us: Mutex<Vec<u32>>,
    pub connect_ms: Mutex<Vec<u32>>,
    pub c: Counters,
    pub closes: Mutex<BTreeMap<String, u64>>,
    pub errors: Mutex<BTreeMap<String, u64>>,
    pub quiet: AtomicBool,
}

impl Shared {
    fn note(map: &Mutex<BTreeMap<String, u64>>, key: String) {
        *map.lock().expect("lock").entry(key).or_default() += 1;
    }
}

/// Tiny xorshift PRNG (no extra dependency).
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    pub fn f(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.f()
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Claims<'a> {
    iss: &'a str,
    aud: &'a str,
    iat: i64,
    exp: i64,
    jti: String,
    file: Value,
    user: Value,
    role: &'a str,
    callback_token: &'a str,
}

pub fn file_id(cfg: &RunCfg, room: usize) -> String {
    format!("{}_{}_{room}", cfg.doc.name(), cfg.run_id)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

pub fn mint(cfg: &RunCfg, idx: usize, room: usize, editor: bool) -> anyhow::Result<String> {
    let now = now_secs();
    let claims = Claims {
        iss: &cfg.host_id,
        aud: "opencanvas",
        iat: now,
        exp: now + 4 * 3600,
        jti: format!("{}-{idx}", cfg.run_id),
        file: json!({"id": file_id(cfg, room), "name": format!("Bench room {room}")}),
        user: json!({"id": format!("u{idx}"), "name": format!("Bench user {idx}")}),
        role: if editor { "edit" } else { "view" },
        callback_token: "bench",
    };
    Ok(jsonwebtoken::encode(
        &Header::new(jsonwebtoken::Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(cfg.secret.as_bytes()),
    )?)
}

/// Launch + session lookup, as the SPA does. Returns (ticket, room id).
pub async fn launch(
    sh: &Shared,
    base: &str,
    idx: usize,
    room: usize,
    editor: bool,
) -> anyhow::Result<(String, String)> {
    let token = mint(&sh.cfg, idx, room, editor)?;
    let res = sh
        .http
        .post(format!("{base}/v1/launch"))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(format!("token={token}"))
        .send()
        .await?;
    let loc = res
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let Some(ticket) = loc
        .split("#t=")
        .nth(1)
        .map(|t| t.split('&').next().unwrap_or(t))
    else {
        anyhow::bail!("launch {}", res.status());
    };
    let ticket = ticket.to_string();
    let res = sh
        .http
        .get(format!("{base}/v1/sessions/{ticket}"))
        .send()
        .await?;
    if !res.status().is_success() {
        anyhow::bail!("session {}", res.status());
    }
    let v: Value = res.json().await?;
    let room = v["room"].as_str().unwrap_or_default().to_string();
    Ok((ticket, room))
}

struct Editor {
    doc: Doc,
    cid: ClientID,
    pending: Arc<Mutex<Vec<Vec<u8>>>>,
    log: SentLog,
    text: Option<XmlTextRef>,
    typed: u32,
    cps: f64,
    burst_until: Instant,
    pause_until: Instant,
    owed: f64,
    drag: Option<(MapRef, u32)>,
    aw_clock: u32,
    sent_clock: u32,
    aw_dirty: bool,
    aw_state: Value,
    rng: Rng,
}

impl Editor {
    fn new(sh: &Shared, seed: u64) -> Self {
        let doc = Doc::new();
        let cid = doc.client_id();
        let pending: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
        let p = pending.clone();
        doc.observe_update_v1("bench", move |_, e: &yrs::UpdateEvent| {
            p.lock().expect("lock").push(e.update.clone())
        })
        .expect("observe");
        let log: SentLog = Arc::default();
        sh.sent.write().expect("lock").insert(cid, log.clone());
        let mut rng = Rng::new(seed);
        let cps = rng.range(sh.cfg.cps.0, sh.cfg.cps.1);
        Self {
            doc,
            cid,
            pending,
            log,
            text: None,
            typed: 0,
            cps,
            burst_until: Instant::now(),
            pause_until: Instant::now() + Duration::from_millis(rng.next() % 4000),
            owed: 0.0,
            drag: None,
            aw_clock: 0,
            sent_clock: 0,
            aw_dirty: true,
            aw_state: json!({"user": {}}),
            rng,
        }
    }

    fn cursor(&self) -> Value {
        let pos = json!({"type": null, "tname": null, "item": {"client": self.cid.get(), "clock": self.typed}, "assoc": 0});
        json!({"anchor": pos, "head": pos})
    }

    /// One 50 ms window: maybe type, edit a cell or drag a shape.
    fn step(&mut self, active: f64, dt: f64) {
        let now = Instant::now();
        if let Some((shape, left)) = self.drag.as_mut() {
            let shape = shape.clone();
            *left -= 1;
            let done = *left == 0;
            let (x, y) = (self.rng.range(0.0, 4000.0), self.rng.range(0.0, 2000.0));
            {
                let mut txn = self.doc.transact_mut();
                shape.insert(&mut txn, "x", x);
                shape.insert(&mut txn, "y", y);
            }
            self.aw_state["board"] = json!({"x": x, "y": y, "sel": ["s"]});
            self.aw_dirty = true;
            if done {
                self.drag = None;
            }
            return;
        }
        if now >= self.burst_until && now < self.pause_until {
            return;
        }
        if now >= self.pause_until {
            // Start a burst of 3–10 s, then pause so the duty cycle is about `active`.
            let burst = self.rng.range(3.0, 10.0);
            let pause = burst * (1.0 - active) / active.max(0.01);
            self.burst_until = now + Duration::from_secs_f64(burst);
            self.pause_until = self.burst_until + Duration::from_secs_f64(pause);
        }
        self.owed += self.cps * dt;
        while self.owed >= 1.0 {
            self.owed -= 1.0;
            let r = self.rng.f();
            if r < 0.06 {
                self.cell_edit();
            } else if r < 0.08 {
                self.start_drag();
            } else {
                self.type_char();
            }
        }
    }

    fn type_char(&mut self) {
        let text = match &self.text {
            Some(t) => t.clone(),
            None => {
                let content = self.doc.get_or_insert_xml_fragment("content");
                let mut txn = self.doc.transact_mut();
                let at = content.len(&txn);
                let p = content.insert(&mut txn, at, XmlElementPrelim::empty("paragraph"));
                let t = p.push_back(&mut txn, XmlTextPrelim::new(""));
                drop(txn);
                self.text = Some(t.clone());
                t
            }
        };
        const WORDS: &[u8] = b"the room saves on idle and fans out every update to its peers ";
        let ch = WORDS[(self.typed as usize) % WORDS.len()] as char;
        let mut txn = self.doc.transact_mut();
        let at = text.len(&txn);
        text.insert(&mut txn, at, &ch.to_string());
        drop(txn);
        self.typed += 1;
        self.aw_state["cursor"] = self.cursor();
        self.aw_dirty = true;
    }

    /// A map in `root/<key>` (the seed's own, else this editor's).
    fn nested(&mut self, root: &str, seeded: &str, inner: &str, own_key: String) -> MapRef {
        let top = self.doc.get_or_insert_map(root);
        let mut txn = self.doc.transact_mut();
        if let Some(yrs::Out::YMap(m)) = top.get(&txn, seeded)
            && let Some(yrs::Out::YMap(inner_map)) = m.get(&txn, inner)
        {
            return inner_map;
        }
        let own = match top.get(&txn, &own_key) {
            Some(yrs::Out::YMap(m)) => m,
            _ => top.insert(&mut txn, own_key, MapPrelim::default()),
        };
        match own.get(&txn, inner) {
            Some(yrs::Out::YMap(m)) => m,
            _ => own.insert(&mut txn, inner, MapPrelim::default()),
        }
    }

    fn pick(&mut self, map: &MapRef, fallback: String) -> MapRef {
        let mut txn = self.doc.transact_mut();
        let keys: Vec<String> = map.keys(&txn).map(String::from).collect();
        let key = if keys.is_empty() {
            fallback
        } else {
            keys[(self.rng.next() as usize) % keys.len()].clone()
        };
        match map.get(&txn, &key) {
            Some(yrs::Out::YMap(m)) => m,
            _ => map.insert(&mut txn, key, MapPrelim::default()),
        }
    }

    fn cell_edit(&mut self) {
        let rows = self.nested(
            "databases",
            "tasks",
            "rows",
            format!("db_{}", self.cid.get()),
        );
        let row = self.pick(&rows, "r1".into());
        let st = ["Backlog", "In progress", "In review", "Done"][(self.rng.next() % 4) as usize];
        let mut txn = self.doc.transact_mut();
        row.insert(&mut txn, "status", st);
    }

    fn start_drag(&mut self) {
        let shapes = self.nested("boards", "flow", "shapes", format!("b_{}", self.cid.get()));
        let shape = self.pick(&shapes, "s1".into());
        // 10 moves at 20 Hz: a half-second drag.
        self.drag = Some((shape, 10));
    }

    /// Merged pending update since the last window, if any; logs (end clock, now).
    fn take_update(&mut self) -> Option<Vec<u8>> {
        let ups = std::mem::take(&mut *self.pending.lock().expect("lock"));
        if ups.is_empty() {
            return None;
        }
        let merged = if ups.len() == 1 {
            ups.into_iter().next().expect("one")
        } else {
            yrs::merge_updates_v1(&ups).ok()?
        };
        // Logged by start clock: a receiver reads it back with `state_vector_lower`.
        let clock = self.sent_clock;
        self.sent_clock = self.doc.transact().state_vector().get(&self.cid);
        let mut log = self.log.lock().expect("lock");
        log.push_back((clock, Instant::now()));
        while log.len() > 4000 {
            log.pop_front();
        }
        Some(merged)
    }

    fn take_awareness(&mut self) -> Option<Vec<u8>> {
        if !self.aw_dirty {
            return None;
        }
        self.aw_dirty = false;
        self.aw_clock += 1;
        Some(awareness_frame(self.cid, self.aw_clock, &self.aw_state))
    }
}

pub fn awareness_frame(cid: ClientID, clock: u32, state: &Value) -> Vec<u8> {
    let mut clients = HashMap::new();
    clients.insert(
        cid,
        AwarenessUpdateEntry {
            clock,
            json: state.to_string().into(),
        },
    );
    Message::Awareness(AwarenessUpdate { clients }).encode_v1()
}

pub fn sync_frame(m: SyncMessage) -> Vec<u8> {
    Message::Sync(m).encode_v1()
}

/// Latency of a received update: look its state vector up in the senders' logs.
fn measure(sh: &Shared, update: &[u8], at: Instant) {
    let Ok(u) = Update::decode_v1(update) else {
        return;
    };
    let sv = u.state_vector_lower();
    let sent = sh.sent.read().expect("lock");
    let mut lat = Vec::new();
    for (client, clock) in sv.iter() {
        let Some(log) = sent.get(client) else {
            continue;
        };
        let log = log.lock().expect("lock");
        let i = log.partition_point(|(c, _)| *c < *clock);
        if let Some((c, t)) = log.get(i)
            && *c == *clock
        {
            lat.push(at.saturating_duration_since(*t).as_micros() as u32);
        }
    }
    drop(sent);
    if !lat.is_empty() {
        sh.lat_us.lock().expect("lock").extend(lat);
    }
}

pub struct Spec {
    pub idx: usize,
    pub room: usize,
    pub editor: bool,
    pub probe: bool,
}

pub async fn run_user(sh: Arc<Shared>, spec: Spec) {
    sh.c.started.fetch_add(1, Ordering::Relaxed);
    let t0 = Instant::now();
    let n = sh.cfg.http_base.len();
    let http = &sh.cfg.http_base[spec.idx % n];
    let ws_base = if sh.cfg.sticky {
        &sh.cfg.ws_base[spec.room % n]
    } else {
        &sh.cfg.ws_base[spec.idx % n]
    };
    let (ticket, room) = match launch(&sh, http, spec.idx, spec.room, spec.editor).await {
        Ok(v) => v,
        Err(e) => {
            sh.c.launch_err.fetch_add(1, Ordering::Relaxed);
            Shared::note(&sh.errors, format!("launch: {e}"));
            return;
        }
    };
    let url = format!("{ws_base}/v1/collab/{room}?ticket={ticket}");
    let ws = match tokio::time::timeout(
        Duration::from_secs(30),
        tokio_tungstenite::connect_async(url),
    )
    .await
    {
        Ok(Ok((ws, _))) => ws,
        Ok(Err(e)) => {
            sh.c.ws_err.fetch_add(1, Ordering::Relaxed);
            Shared::note(&sh.errors, format!("ws: {e}"));
            return;
        }
        Err(_) => {
            sh.c.ws_err.fetch_add(1, Ordering::Relaxed);
            Shared::note(&sh.errors, "ws: connect timeout".into());
            return;
        }
    };
    sh.c.live.fetch_add(1, Ordering::Relaxed);
    let outcome = session(&sh, &spec, ws, t0).await;
    sh.c.live.fetch_sub(1, Ordering::Relaxed);
    if let Some(reason) = outcome {
        sh.c.dropped.fetch_add(1, Ordering::Relaxed);
        Shared::note(&sh.closes, reason);
    }
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Runs until the socket ends; returns why it ended.
async fn session(sh: &Shared, spec: &Spec, ws: WsStream, t0: Instant) -> Option<String> {
    let (mut sink, mut stream) = ws.split();
    // Like a browser's WebSocket (`bufferedAmount`): sending never stops the client reading.
    // A server that pushes back (bounded room inbox) delays this client's frames, not its reads.
    let (send_tx, mut send_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let writer = tokio::spawn(async move {
        while let Some(f) = send_rx.recv().await {
            if sink.send(Ws::Binary(f.into())).await.is_err() {
                return;
            }
        }
        let _ = sink.close().await;
    });
    let mut editor = spec.editor.then(|| Editor::new(sh, spec.idx as u64 + 1));
    let file = file_id(&sh.cfg, spec.room);
    let empty = Doc::new();
    let sv = editor
        .as_ref()
        .map_or_else(StateVector::default, |e| e.doc.transact().state_vector());
    let mut out: Vec<Vec<u8>> = vec![sync_frame(SyncMessage::SyncStep1(sv))];
    let mut ready = false;
    let mut tick = tokio::time::interval(Duration::from_millis(50));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_tick = Instant::now();
    loop {
        for f in out.drain(..) {
            sh.c.frames_out.fetch_add(1, Ordering::Relaxed);
            sh.c.bytes_out.fetch_add(f.len() as u64, Ordering::Relaxed);
            if send_tx.send(f).is_err() || writer.is_finished() {
                return Some("send error".into());
            }
        }
        tokio::select! {
            _ = tick.tick(), if ready && editor.is_some() => {
                let e = editor.as_mut().expect("editor");
                let dt = last_tick.elapsed().as_secs_f64();
                last_tick = Instant::now();
                if !sh.quiet.load(Ordering::Relaxed) {
                    e.step(sh.cfg.active, dt);
                }
                if let Some(u) = e.take_update() {
                    sh.c.updates_out.fetch_add(1, Ordering::Relaxed);
                    sh.c.update_bytes_out.fetch_add(u.len() as u64, Ordering::Relaxed);
                    sh.host.edited(&file);
                    out.push(sync_frame(SyncMessage::Update(u)));
                }
                if let Some(a) = e.take_awareness() {
                    sh.c.awareness_out.fetch_add(1, Ordering::Relaxed);
                    out.push(a);
                }
            }
            msg = stream.next() => {
                let data = match msg {
                    Some(Ok(Ws::Binary(b))) => b,
                    Some(Ok(Ws::Close(f))) => {
                        return Some(f.map_or("close (no code)".into(), |f| format!("close {} {}", u16::from(f.code), f.reason)));
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => return Some(format!("ws error: {e}")),
                    None => return Some("eof".into()),
                };
                let at = Instant::now();
                sh.c.frames_in.fetch_add(1, Ordering::Relaxed);
                sh.c.bytes_in.fetch_add(data.len() as u64, Ordering::Relaxed);
                match (data.first(), data.get(1)) {
                    // sync update: only probes decode it
                    (Some(0), Some(2)) => {
                        if spec.probe
                            && ready
                            && data.len() > 2
                            && let Ok(Message::Sync(SyncMessage::Update(u))) =
                                Message::decode_v1(&data)
                        {
                            measure(sh, &u, at);
                        }
                    }
                    (Some(1), _) => {}
                    _ => {
                        let mut d = DecoderV1::new(Cursor::new(&data));
                        let Ok(msgs) = MessageReader::new(&mut d).collect::<Result<Vec<_>, _>>() else {
                            continue;
                        };
                        for m in msgs {
                            match m {
                                Message::Sync(SyncMessage::SyncStep1(sv)) => {
                                    let diff = match &editor {
                                        Some(e) => e.doc.transact().encode_state_as_update_v1(&sv),
                                        None => empty.transact().encode_state_as_update_v1(&sv),
                                    };
                                    out.push(sync_frame(SyncMessage::SyncStep2(diff)));
                                }
                                Message::Sync(SyncMessage::SyncStep2(u)) => {
                                    if let Some(e) = editor.as_mut()
                                        && let Ok(u) = Update::decode_v1(&u)
                                    {
                                        let _ = e.doc.transact_mut().apply_update(u);
                                        e.pending.lock().expect("lock").clear();
                                        e.sent_clock = e.doc.transact().state_vector().get(&e.cid);
                                    }
                                }
                                Message::Custom(100, body) => {
                                    let v: Value = serde_json::from_slice(&body).unwrap_or_default();
                                    if v["t"] == "role" && !ready {
                                        ready = true;
                                        sh.c.ready.fetch_add(1, Ordering::Relaxed);
                                        sh.connect_ms.lock().expect("lock").push(t0.elapsed().as_millis() as u32);
                                        let state = json!({"user": {"name": format!("Bench user {}", spec.idx)}});
                                        let cid = editor.as_ref().map_or(ClientID::new(spec.idx as u64 + 1_000_000_000), |e| e.cid);
                                        out.push(awareness_frame(cid, 1, &state));
                                        if let Some(e) = editor.as_mut() {
                                            e.aw_clock = 1;
                                            e.aw_state = state;
                                        }
                                    }
                                }
                                Message::Auth(Some(_)) => {
                                    sh.c.denied.fetch_add(1, Ordering::Relaxed);
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
        }
    }
}
