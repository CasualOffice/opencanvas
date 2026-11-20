mod common;

use common::*;
use oc_server::grant::Role;
use yrs::{Array, Doc, GetString, Map, Text, Transact, XmlFragment, XmlTextPrelim, XmlTextRef};

/// Small deterministic PRNG so failures reproduce from the seed.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self, n: u32) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 33) % u64::from(n.max(1))) as u32
    }
}

fn text(doc: &Doc) -> XmlTextRef {
    let content = doc.get_or_insert_xml_fragment("content");
    let mut txn = doc.transact_mut();
    match content.get(&txn, 0).and_then(|n| n.into_xml_text()) {
        Some(t) => t,
        None => content.push_back(&mut txn, XmlTextPrelim::new("")),
    }
}

fn random_op(doc: &Doc, rng: &mut Lcg, who: usize) {
    match rng.next(4) {
        0 | 1 => {
            let t = text(doc);
            let mut txn = doc.transact_mut();
            let len = t.len(&txn);
            let at = rng.next(len + 1);
            t.insert(&mut txn, at, &format!("{who}{}", rng.next(10)));
        }
        2 => {
            let t = text(doc);
            let mut txn = doc.transact_mut();
            let len = t.len(&txn);
            if len > 0 {
                let at = rng.next(len);
                t.remove_range(&mut txn, at, 1.min(len - at));
            }
        }
        _ => {
            let meta = doc.get_or_insert_map("databases");
            let rows = doc.get_or_insert_array("order-probe");
            let mut txn = doc.transact_mut();
            meta.insert(&mut txn, format!("k{}", rng.next(5)), rng.next(100) as i64);
            rows.push_back(&mut txn, who as i64);
        }
    }
}

#[tokio::test]
async fn random_concurrent_edits_converge() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    for seed in 1..=3u64 {
        let mut rng = Lcg(seed);
        let mut peers = Vec::new();
        for i in 0..3 {
            let mut g = grant(&format!("u_{seed}_{i}"), Role::Edit);
            g.file.id = format!("fuzz_{seed}");
            g.room = oc_server::grant::room_id("sample", &g.file.id);
            peers.push(Peer::join(&state, g).await);
        }
        for p in &mut peers {
            p.settle().await;
        }
        for _round in 0..15 {
            // Several peers edit before anyone sees the others' changes.
            for _ in 0..rng.next(8) + 1 {
                let who = rng.next(peers.len() as u32) as usize;
                let peer = &peers[who];
                peer.edit(|d| random_op(d, &mut rng, who));
            }
            if rng.next(3) == 0 {
                let who = rng.next(peers.len() as u32) as usize;
                peers[who].settle().await;
            }
        }
        for _ in 0..2 {
            for p in &mut peers {
                p.settle().await;
            }
        }
        let first = json_of(&peers[0].doc);
        for p in &peers[1..] {
            assert_eq!(json_of(&p.doc), first, "seed {seed}: peers diverged");
        }
        let t0 = text(&peers[0].doc).get_string(&peers[0].doc.transact());
        assert!(!t0.is_empty(), "seed {seed}: edits happened");
    }
}
