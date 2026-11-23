// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Convergence fuzz: N clients × random ops × random delivery order through a real room.
//!
//! Each iteration opens a fresh room with 2–5 editors. Every client buffers what it would
//! send and what it receives; the test randomly interleaves local edits, partial flushes in
//! shuffled order and partial deliveries in shuffled order, so updates reach the server and
//! the other clients out of causal order. At the end everything is delivered and every
//! client must hold exactly the server's state.
//!
//!   cargo test -p oc-server --test fuzz                        # OC_FUZZ_ITERS=200
//!   OC_FUZZ_ITERS=10000 cargo test --release -p oc-server --test fuzz -- --nocapture
//!   OC_FUZZ_SEED=1234 OC_FUZZ_ITERS=1 cargo test -p oc-server --test fuzz   # replay one seed
mod common;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use common::*;
use oc_server::SharedState;
use oc_server::grant::{Grant, Role, room_id};
use oc_server::room::{Membership, Outbound, protocol};
use tokio::sync::mpsc;
use yrs::encoding::read::Cursor;
use yrs::sync::protocol::MessageReader;
use yrs::sync::{Message, SyncMessage};
use yrs::types::ToJson;
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::{
    Array, Doc, GetString, Map, ReadTxn, StateVector, Text, Transact, Update, XmlElementPrelim,
    XmlFragment, XmlTextPrelim, XmlTextRef,
};

/// Small deterministic PRNG so failures reproduce from the seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self, n: u32) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 33) % u64::from(n.max(1))) as u32
    }
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|v| v.parse().ok())
}

/// Picks a random text node in `content`, creating a paragraph when there is none.
fn some_text(doc: &Doc, rng: &mut Rng) -> XmlTextRef {
    let content = doc.get_or_insert_xml_fragment("content");
    let mut txn = doc.transact_mut();
    let n = content.len(&txn);
    if n > 0 {
        let i = rng.next(n);
        if let Some(node) = content.get(&txn, i) {
            if let Some(t) = node.clone().into_xml_text() {
                return t;
            }
            if let Some(el) = node.into_xml_element() {
                if let Some(t) = el.get(&txn, 0).and_then(|c| c.into_xml_text()) {
                    return t;
                }
                return el.push_back(&mut txn, XmlTextPrelim::new(""));
            }
        }
    }
    content.push_back(&mut txn, XmlTextPrelim::new(""))
}

fn random_op(doc: &Doc, rng: &mut Rng, who: usize) {
    match rng.next(10) {
        0..=2 => {
            let t = some_text(doc, rng);
            let mut txn = doc.transact_mut();
            let at = rng.next(t.len(&txn) + 1);
            t.insert(&mut txn, at, &format!("{who}{}", rng.next(10)));
        }
        3 => {
            let t = some_text(doc, rng);
            let mut txn = doc.transact_mut();
            let len = t.len(&txn);
            if len > 0 {
                let at = rng.next(len);
                let n = (rng.next(4) + 1).min(len - at);
                t.remove_range(&mut txn, at, n);
            }
        }
        4 => {
            let content = doc.get_or_insert_xml_fragment("content");
            let mut txn = doc.transact_mut();
            let at = rng.next(content.len(&txn) + 1);
            let p = content.insert(&mut txn, at, XmlElementPrelim::empty("paragraph"));
            p.push_back(&mut txn, XmlTextPrelim::new(format!("p{who}")));
        }
        5 => {
            let content = doc.get_or_insert_xml_fragment("content");
            let mut txn = doc.transact_mut();
            let len = content.len(&txn);
            if len > 0 {
                content.remove_range(&mut txn, rng.next(len), 1);
            }
        }
        6 => {
            let meta = doc.get_or_insert_map("meta");
            let mut txn = doc.transact_mut();
            meta.insert(
                &mut txn,
                format!("k{}", rng.next(4)),
                i64::from(rng.next(100)),
            );
        }
        7 => {
            let meta = doc.get_or_insert_map("meta");
            let mut txn = doc.transact_mut();
            meta.remove(&mut txn, &format!("k{}", rng.next(4)));
        }
        8 => {
            let list = doc.get_or_insert_array("list");
            let mut txn = doc.transact_mut();
            let at = rng.next(list.len(&txn) + 1);
            list.insert(&mut txn, at, who as i64);
        }
        _ => {
            let list = doc.get_or_insert_array("list");
            let mut txn = doc.transact_mut();
            let len = list.len(&txn);
            if len > 0 {
                list.remove(&mut txn, rng.next(len));
            }
        }
    }
}

/// Everything a client can see, in a comparable form.
fn snapshot(doc: &Doc) -> BTreeMap<&'static str, String> {
    let content = doc.get_or_insert_xml_fragment("content");
    let meta = doc.get_or_insert_map("meta");
    let list = doc.get_or_insert_array("list");
    let txn = doc.transact();
    let sv: BTreeMap<u64, u32> = txn
        .state_vector()
        .iter()
        .map(|(c, clock)| (c.get(), *clock))
        .collect();
    BTreeMap::from([
        ("content", content.get_string(&txn)),
        // serde_json maps are sorted, so key order does not matter.
        (
            "meta",
            serde_json::to_value(meta.to_json(&txn))
                .unwrap()
                .to_string(),
        ),
        (
            "list",
            serde_json::to_value(list.to_json(&txn))
                .unwrap()
                .to_string(),
        ),
        ("sv", format!("{sv:?}")),
        (
            "pending",
            format!("{}", txn.store().pending_update().is_some()),
        ),
    ])
}

/// A client that buffers both directions so delivery order can be shuffled.
struct Client {
    doc: Doc,
    membership: Membership,
    rx: mpsc::UnboundedReceiver<Outbound>,
    outbox: Vec<Vec<u8>>,
    inbox: Vec<Vec<u8>>,
    sv: StateVector,
}

impl Client {
    async fn join(state: &SharedState, grant: Grant) -> Self {
        let host = state.hosts.get("sample").unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        let membership = state.rooms.join(&host, Arc::new(grant), tx).await.unwrap();
        let doc = Doc::new();
        let sv = doc.transact().state_vector();
        Self {
            outbox: vec![protocol::step1(sv.clone())],
            doc,
            membership,
            rx,
            inbox: vec![],
            sv,
        }
    }

    fn edit(&mut self, rng: &mut Rng, who: usize) {
        random_op(&self.doc, rng, who);
        let update = self.doc.transact().encode_state_as_update_v1(&self.sv);
        self.sv = self.doc.transact().state_vector();
        self.outbox.push(protocol::update(update));
    }

    /// Sends up to `n` buffered frames, in random order.
    fn flush(&mut self, rng: &mut Rng, n: usize) {
        for _ in 0..n.min(self.outbox.len()) {
            let i = rng.next(self.outbox.len() as u32) as usize;
            self.membership.try_send(self.outbox.swap_remove(i));
        }
    }

    fn pump(&mut self) {
        while let Ok(out) = self.rx.try_recv() {
            if let Outbound::Frame(f) = out {
                self.inbox.push(f.to_vec());
            }
        }
    }

    /// Applies up to `n` received frames, in random order.
    fn deliver(&mut self, rng: &mut Rng, n: usize) {
        for _ in 0..n.min(self.inbox.len()) {
            let i = rng.next(self.inbox.len() as u32) as usize;
            let frame = self.inbox.swap_remove(i);
            self.receive(&frame);
        }
    }

    /// Applies one received frame and answers a sync step 1.
    fn receive(&mut self, frame: &[u8]) {
        let mut d = DecoderV1::new(Cursor::new(frame));
        for m in MessageReader::new(&mut d)
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
        {
            match m {
                Message::Sync(SyncMessage::SyncStep1(sv)) => {
                    let diff = self.doc.transact().encode_state_as_update_v1(&sv);
                    self.outbox.push(protocol::step2(diff));
                }
                Message::Sync(SyncMessage::SyncStep2(u) | SyncMessage::Update(u)) => {
                    // Yjs (what real clients run) retries pending structs once their causes
                    // arrive; plain yrs 0.28.2 can strand them (oc_model::sync).
                    oc_model::sync::apply_update(
                        &mut self.doc.transact_mut(),
                        Update::decode_v1(&u).unwrap(),
                    )
                    .unwrap();
                }
                Message::Auth(reason) => panic!("editor denied: {reason:?}"),
                _ => {}
            }
        }
        // Our own later edits only need to carry what we created ourselves.
        self.sv = self.doc.transact().state_vector();
    }
}

/// Waits until the room has processed every frame sent so far (its mailbox is FIFO).
async fn barrier(state: &SharedState, grant: &Grant) -> Vec<u8> {
    let host = state.hosts.get("sample").unwrap();
    state.rooms.state(&host, grant).await.unwrap()
}

async fn run_iteration(state: &SharedState, seed: u64) {
    let mut rng = Rng(seed);
    let file = format!("fuzz_{seed}");
    let mk = |user: String| {
        let mut g = grant(&user, Role::Edit);
        g.file.id = file.clone();
        g.room = room_id("sample", &file);
        g
    };
    let n = 2 + rng.next(4) as usize;
    let mut clients = Vec::new();
    for i in 0..n {
        clients.push(Client::join(state, mk(format!("u{i}"))).await);
    }
    let probe = mk("probe".into());
    let steps = 10 + rng.next(60);
    for _ in 0..steps {
        let who = rng.next(n as u32) as usize;
        match rng.next(4) {
            0 | 1 => clients[who].edit(&mut rng, who),
            2 => {
                let k = rng.next(4) as usize + 1;
                clients[who].flush(&mut rng, k);
            }
            _ => {
                barrier(state, &probe).await;
                clients[who].pump();
                let k = rng.next(6) as usize + 1;
                clients[who].deliver(&mut rng, k);
            }
        }
    }
    // Drain: everything sent, everything delivered, until a round moves nothing.
    for round in 0.. {
        assert!(round < 50, "seed {seed}: no quiescence");
        let mut moved = false;
        for c in &mut clients {
            moved |= !c.outbox.is_empty();
            let k = c.outbox.len();
            c.flush(&mut rng, k);
        }
        barrier(state, &probe).await;
        for c in &mut clients {
            c.pump();
            moved |= !c.inbox.is_empty();
            let k = c.inbox.len();
            c.deliver(&mut rng, k);
        }
        if !moved {
            break;
        }
    }
    let server = Doc::new();
    server
        .transact_mut()
        .apply_update(Update::decode_v1(&barrier(state, &probe).await).unwrap())
        .unwrap();
    let want = snapshot(&server);
    assert_eq!(
        want["pending"], "false",
        "seed {seed}: server has unintegrated updates"
    );
    for (i, c) in clients.iter().enumerate() {
        assert_eq!(
            snapshot(&c.doc),
            want,
            "seed {seed}: client {i} diverged from the server"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn random_concurrent_edits_converge() {
    let iters = env_u64("OC_FUZZ_ITERS").unwrap_or(200);
    let base_seed = env_u64("OC_FUZZ_SEED").unwrap_or(1);
    let (base, _host) = mock_host().await;
    let cfg = oc_server::config::RoomConfig {
        tick: Duration::from_millis(500),
        room_ttl: Duration::from_millis(500),
        ..room_cfg()
    };
    let state = app(&base, cfg).await;
    let started = std::time::Instant::now();
    for i in 0..iters {
        run_iteration(&state, base_seed + i).await;
    }
    println!(
        "fuzz: {iters} iterations from seed {base_seed} converged in {:.1?}",
        started.elapsed()
    );
}

/// An update with a cross-client dependency cycle (A#0 before B#0, B#3 before A#0) and the
/// B#0..3 it waits for, plus the text both give. yrs 0.28.2 strands the cycle in its pending
/// structs when the cause arrives second (oc_model::sync). Seed 66002356 of the nightly fuzz
/// hit this in a client once a 40 ms outbound tick split a batch differently.
fn dependency_cycle() -> (Vec<u8>, Vec<u8>, String) {
    // yrs picks the highest client id first: A must sort above B.
    let b = Doc::with_client_id(1);
    let a = Doc::with_client_id(2);
    let tb = b.get_or_insert_text("t");
    let ta = a.get_or_insert_text("t");
    tb.insert(&mut b.transact_mut(), 0, "bbb");
    let b0 = b
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    a.transact_mut()
        .apply_update(Update::decode_v1(&b0).unwrap())
        .unwrap();
    ta.insert(&mut a.transact_mut(), 0, "a");
    let from_a = a
        .transact()
        .encode_state_as_update_v1(&b.transact().state_vector());
    b.transact_mut()
        .apply_update(Update::decode_v1(&from_a).unwrap())
        .unwrap();
    let mut before_a = StateVector::default();
    before_a.set_max(yrs::block::ClientID::new(1), 3);
    tb.insert(&mut b.transact_mut(), 0, "c");
    let cycle = b.transact().encode_state_as_update_v1(&before_a);
    let text = tb.get_string(&b.transact());
    (cycle, b0, text)
}

/// Deterministic regression for the 66002356 divergence: the cycle reaches the room and a
/// peer before its cause. Both must integrate everything once the cause arrives.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pending_dependency_cycle_is_integrated_by_the_room_and_its_peers() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let mk = |user: &str| {
        let mut g = grant(user, Role::Edit);
        g.file.id = "cycle".into();
        g.room = room_id("sample", "cycle");
        g
    };
    let mut sender = Client::join(&state, mk("u0")).await;
    let mut peer = Client::join(&state, mk("u1")).await;
    let probe = mk("probe");
    // Handshakes first, so the peer gets the two updates as relayed frames.
    for c in [&mut sender, &mut peer] {
        for f in std::mem::take(&mut c.outbox) {
            c.membership.try_send(f);
        }
    }
    barrier(&state, &probe).await;
    let (cycle, cause, want) = dependency_cycle();
    sender.membership.try_send(protocol::update(cycle));
    sender.membership.try_send(protocol::update(cause));

    // Read the room's own doc: its encoded state would hide the bug, since yrs merges the
    // pending structs into `encode_state_as_update_v1`.
    barrier(&state, &probe).await;
    let host = state.hosts.get("sample").unwrap();
    let room = state
        .rooms
        .tool(
            &host,
            &probe,
            "probe",
            Box::new(|doc: &Doc| {
                let text = doc.get_or_insert_text("t");
                let txn = doc.transact();
                Ok((
                    None,
                    serde_json::json!({
                        "pending": txn.store().pending_update().is_some(),
                        "text": text.get_string(&txn),
                    }),
                ))
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        room,
        serde_json::json!({ "pending": false, "text": want }),
        "the room stranded the cycle in its pending structs"
    );

    // The relayed frames reach the peer one outbound tick later, in the order they were sent.
    let text = peer.doc.get_or_insert_text("t");
    for _ in 0..50 {
        barrier(&state, &probe).await;
        peer.pump();
        for f in std::mem::take(&mut peer.inbox) {
            peer.receive(&f);
        }
        if text.get_string(&peer.doc.transact()) == want {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let txn = peer.doc.transact();
    assert!(
        txn.store().pending_update().is_none(),
        "the peer stranded the cycle in its pending structs"
    );
    assert_eq!(text.get_string(&txn), want);
}
