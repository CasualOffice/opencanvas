// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Property tests for the ID-preserving split (PSYNC-02): random canvases edited by several
//! replicas (concurrent edits, deletions, garbage collection, map overwrites), then
//! split → flatten must give the same struct bytes, delete set, state vector and content; and
//! edits on the parts converge with concurrent edits on a flattened copy.

use std::collections::BTreeMap;

use serde_json::Value;
use yrs::types::xml::XmlElementPrelim;
use yrs::updates::decoder::Decode;
use yrs::{
    Array, Doc, Map, MapPrelim, MapRef, Options, Out, ReadTxn, StateVector, Text, TextPrelim,
    Transact, Update, XmlFragment, XmlTextPrelim,
};

use super::*;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn word(&mut self) -> String {
        const W: [&str; 8] = ["alpha", "beta", "γάμμα", "delta", "e", "zeta", "", "ηθ"];
        W[self.below(W.len())].to_string()
    }
}

fn doc_with(client: u64) -> Doc {
    let doc = Doc::with_options(Options {
        client_id: yrs::block::ClientID::new(client),
        offset_kind: yrs::OffsetKind::Utf16,
        ..Options::default()
    });
    crate::ensure_roots(&doc);
    doc
}

fn encode(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn apply(doc: &Doc, bytes: &[u8]) {
    let mut txn = doc.transact_mut();
    crate::sync::apply_update(&mut txn, Update::decode_v1(bytes).unwrap()).unwrap();
}

fn no_pending(doc: &Doc) -> bool {
    let txn = doc.transact();
    txn.store().pending_update().is_none() && txn.store().pending_ds().is_none()
}

fn sync(a: &Doc, b: &Doc) {
    let ua = a
        .transact()
        .encode_state_as_update_v1(&b.transact().state_vector());
    let ub = b
        .transact()
        .encode_state_as_update_v1(&a.transact().state_vector());
    apply(b, &ua);
    apply(a, &ub);
}

const BLOCKS: [&str; 4] = ["d1", "d2", "b1", "b2"];

fn root_of(block: &str) -> &'static str {
    if block.starts_with('d') {
        roots::DATABASES
    } else {
        roots::BOARDS
    }
}

/// A new heavy block: `{name, rows: {id → {f → v}}, order: [ids]}`.
fn new_block(doc: &Doc, rng: &mut Rng, key: &str) {
    let map = doc.get_or_insert_map(root_of(key));
    let mut txn = doc.transact_mut();
    let block = map.insert(&mut txn, key, MapPrelim::default());
    block.insert(&mut txn, "name", rng.word());
    let rows = block.insert(&mut txn, "rows", MapPrelim::default());
    let order = block.insert(&mut txn, "order", yrs::ArrayPrelim::default());
    for i in 0..1 + rng.below(4) {
        let id = format!("r{i}");
        let row = rows.insert(&mut txn, id.as_str(), MapPrelim::default());
        row.insert(&mut txn, "f", rng.word());
        row.insert(&mut txn, "t", TextPrelim::new(format!("🙂{}", rng.word())));
        order.push_back(&mut txn, id);
    }
}

fn block_of<T: ReadTxn>(txn: &T, doc_root: &MapRef, key: &str) -> Option<MapRef> {
    match doc_root.get(txn, key) {
        Some(Out::YMap(m)) => Some(m),
        _ => None,
    }
}

/// One random edit on `doc`, limited to `only` (a block key) when given, or to the text.
fn edit(doc: &Doc, rng: &mut Rng, only: Option<Option<&str>>) {
    let choice = match only {
        Some(None) => 0,
        Some(Some(_)) => 1 + rng.below(5),
        None => rng.below(7),
    };
    let key = match only {
        Some(Some(k)) => k.to_string(),
        _ => BLOCKS[rng.below(BLOCKS.len())].to_string(),
    };
    let root = doc.get_or_insert_map(root_of(&key));
    let content = doc.get_or_insert_xml_fragment(roots::CONTENT);
    let mut txn = doc.transact_mut();
    match choice {
        0 => {
            // Text: insert a paragraph, type into one, or delete one.
            let n = content.len(&txn);
            match rng.below(3) {
                0 | 1 if n > 0 && rng.below(2) == 0 => {
                    if let Some(yrs::XmlOut::Element(p)) =
                        content.get(&txn, rng.below(n as usize) as u32)
                        && let Some(yrs::XmlOut::Text(t)) = p.get(&txn, 0)
                    {
                        let len = t.len(&txn);
                        if len > 0 && rng.below(3) == 0 {
                            let at = rng.below(len as usize) as u32;
                            t.remove_range(&mut txn, at, 1.min(len - at));
                        } else {
                            t.insert(&mut txn, rng.below(len as usize + 1) as u32, &rng.word());
                        }
                    }
                }
                2 if n > 1 => {
                    content.remove_range(&mut txn, rng.below(n as usize) as u32, 1);
                }
                _ => {
                    let p = content.insert(
                        &mut txn,
                        rng.below(n as usize + 1) as u32,
                        XmlElementPrelim::empty("paragraph"),
                    );
                    p.insert(&mut txn, 0, XmlTextPrelim::new(rng.word()));
                }
            }
        }
        1 => {
            // Replace the whole block (a map overwrite) or create it.
            drop(txn);
            new_block(doc, rng, &key);
        }
        2 if only.is_none() => {
            root.remove(&mut txn, &key);
        }
        _ => {
            let Some(block) = block_of(&txn, &root, &key) else {
                drop(txn);
                new_block(doc, rng, &key);
                return;
            };
            let Some(Out::YMap(rows)) = block.get(&txn, "rows") else {
                return;
            };
            let Some(Out::YArray(order)) = block.get(&txn, "order") else {
                return;
            };
            let ids: Vec<String> = rows.keys(&txn).map(str::to_string).collect();
            match rng.below(4) {
                0 => {
                    let id = format!("r{}", rng.next() % 1000);
                    let row = rows.insert(&mut txn, id.as_str(), MapPrelim::default());
                    row.insert(&mut txn, "f", rng.word());
                    order.push_back(&mut txn, id);
                }
                1 if !ids.is_empty() => {
                    rows.remove(&mut txn, &ids[rng.below(ids.len())]);
                    if order.len(&txn) > 0 {
                        order.remove(&mut txn, 0);
                    }
                }
                2 if !ids.is_empty() => {
                    if let Some(Out::YMap(row)) = rows.get(&txn, &ids[rng.below(ids.len())]) {
                        if let Some(Out::YText(t)) = row.get(&txn, "t") {
                            let len = t.len(&txn);
                            t.insert(&mut txn, rng.below(len as usize + 1) as u32, &rng.word());
                        } else {
                            row.insert(&mut txn, "f", rng.word());
                        }
                    }
                }
                _ => {
                    block.insert(&mut txn, "name", rng.word());
                }
            }
        }
    }
}

/// A canvas written by three replicas with random syncs in between.
fn random_canvas(seed: u64) -> Doc {
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let replicas: Vec<Doc> = (0..3).map(|i| doc_with(100 + i)).collect();
    for key in BLOCKS {
        if rng.below(4) > 0 {
            new_block(&replicas[0], &mut rng, key);
        }
    }
    for _ in 0..3 {
        edit(&replicas[0], &mut rng, Some(None));
    }
    for _ in 0..40 {
        let r = rng.below(3);
        edit(&replicas[r], &mut rng, None);
        if rng.below(3) == 0 {
            let (a, b) = (rng.below(3), rng.below(3));
            if a != b {
                sync(&replicas[a], &replicas[b]);
            }
        }
    }
    sync(&replicas[0], &replicas[1]);
    sync(&replicas[1], &replicas[2]);
    sync(&replicas[0], &replicas[1]);
    replicas.into_iter().next().unwrap()
}

fn load(bytes: &[u8], client: u64) -> Doc {
    let doc = doc_with(client);
    apply(&doc, bytes);
    doc
}

fn json(doc: &Doc) -> Value {
    crate::doc_to_json(doc)
}

/// Main JSON with every part's block put back.
fn joined(parts: &BTreeMap<String, Doc>) -> Value {
    let mut out = json(&parts[MAIN]);
    for (key, doc) in parts {
        let Some((root, id)) = part_root(key) else {
            continue;
        };
        let j = json(doc);
        if let Some(v) = j[root].get(id) {
            out[root][id] = v.clone();
        }
    }
    out
}

#[test]
fn split_then_flatten_is_the_original_byte_for_byte() {
    for seed in 1..=300 {
        let whole = random_canvas(seed);
        let u = encode(&whole);
        let s = split(&u).unwrap();
        assert!(s.parts.contains_key(MAIN));
        let f = flatten(&s.parts.values().collect::<Vec<_>>()).unwrap();
        assert_eq!(
            struct_section(&f).unwrap(),
            struct_section(&u).unwrap(),
            "seed {seed}: struct bytes"
        );
        assert_eq!(
            delete_set(&f).unwrap(),
            delete_set(&u).unwrap(),
            "seed {seed}: deletes"
        );
        let back = load(&f, 9);
        assert_eq!(
            back.transact().state_vector(),
            whole.transact().state_vector(),
            "seed {seed}: state vector"
        );
        assert_eq!(json(&back), json(&whole), "seed {seed}: content");

        // Every part is a document on its own: it integrates fully, starts at the original
        // state vector, and the parts' blocks put together are the whole canvas.
        let docs: BTreeMap<String, Doc> = s
            .parts
            .iter()
            .map(|(k, b)| (k.clone(), load(b, 7)))
            .collect();
        for (k, d) in &docs {
            assert!(
                no_pending(d),
                "seed {seed}: part {k:?} left pending structs"
            );
            assert_eq!(
                d.transact().state_vector(),
                whole.transact().state_vector(),
                "seed {seed}: part {k:?} state vector"
            );
            if let Some((root, id)) = part_root(k) {
                let j = json(d);
                let keys: Vec<&String> = j[root].as_object().unwrap().keys().collect();
                assert!(
                    keys.is_empty() || keys == [id],
                    "seed {seed}: part {k:?} holds {keys:?}"
                );
            }
        }
        let main = json(&docs[MAIN]);
        for root in SPLIT_ROOTS {
            assert_eq!(
                main[root],
                serde_json::json!({}),
                "seed {seed}: main keeps {root}"
            );
        }
        assert_eq!(joined(&docs), json(&whole), "seed {seed}: parts joined");
    }
}

#[test]
fn flatten_of_reencoded_parts_matches_the_whole() {
    // Parts that went through a live document (as in the room) re-encode with merged fillers
    // and a delete set that counts them: the flatten must still be the whole document.
    for seed in 1..=200 {
        let whole = random_canvas(seed);
        let s = split(&encode(&whole)).unwrap();
        let again: Vec<Vec<u8>> = s.parts.values().map(|b| encode(&load(b, 5))).collect();
        let f = flatten(&again).unwrap();
        assert_eq!(
            delete_set(&f).unwrap(),
            delete_set(&encode(&whole)).unwrap(),
            "seed {seed}"
        );
        let back = load(&f, 9);
        assert_eq!(
            back.transact().state_vector(),
            whole.transact().state_vector()
        );
        assert_eq!(json(&back), json(&whole), "seed {seed}");
    }
}

#[test]
fn edits_on_parts_converge_with_edits_on_a_flattened_copy() {
    for seed in 1..=200 {
        let mut rng = Rng(seed * 7919 + 3);
        let whole = random_canvas(seed);
        let s = split(&encode(&whole)).unwrap();
        let mut owners = s.owners.clone();
        let mut parts: BTreeMap<String, Doc> = s
            .parts
            .iter()
            .enumerate()
            .map(|(i, (k, b))| (k.clone(), load(b, 1000 + i as u64)))
            .collect();
        // The flattened copy: an offline device, the API, or a 0.3 save of the same canvas.
        let copy = load(
            &flatten(&s.parts.values().collect::<Vec<_>>()).unwrap(),
            2000,
        );
        let copy_sv = copy.transact().state_vector();
        let part_svs: BTreeMap<String, StateVector> = parts
            .iter()
            .map(|(k, d)| (k.clone(), d.transact().state_vector()))
            .collect();
        // Concurrent edits: each part in its own block (main: text), the copy anywhere.
        for _ in 0..12 {
            let keys: Vec<String> = parts.keys().cloned().collect();
            let k = &keys[rng.below(keys.len())];
            let only = part_root(k).map(|(_, id)| id);
            edit(&parts[k], &mut rng, Some(only));
            edit(&copy, &mut rng, None);
        }
        // Part edits reach the copy as they are (same ids)...
        for (k, d) in &parts {
            let u = d.transact().encode_state_as_update_v1(&part_svs[k]);
            owners.record_update(k, &u).unwrap();
            apply(&copy, &own_share(&u, k, &owners).unwrap());
        }
        // ...and the copy's edits reach the parts routed by owner.
        let u = copy.transact().encode_state_as_update_v1(&copy_sv);
        let routed = route(&u, &owners, &|part, client| {
            parts.get(part).map_or(0, |d| {
                d.transact()
                    .state_vector()
                    .get(&yrs::block::ClientID::new(client))
            })
        })
        .unwrap();
        for (client, a, b, part) in &routed.owned {
            owners.record(*client, *a, *b, part);
        }
        for (k, share) in &routed.parts {
            let d = parts
                .entry(k.clone())
                .or_insert_with(|| doc_with(3000 + k.len() as u64));
            apply(d, share);
            assert!(
                no_pending(d),
                "seed {seed}: part {k:?} left pending structs"
            );
        }
        let encoded: Vec<Vec<u8>> = parts.values().map(encode).collect();
        let back = load(&flatten(&encoded).unwrap(), 9);
        assert!(
            no_pending(&back),
            "seed {seed}: flatten left pending structs"
        );
        assert_eq!(json(&back), json(&copy), "seed {seed}: content");
        assert_eq!(
            back.transact().state_vector(),
            copy.transact().state_vector(),
            "seed {seed}: state vector"
        );
        assert_eq!(joined(&parts), json(&copy), "seed {seed}: parts joined");
    }
}

/// A part (or an edit of one) applied to the whole document as it is changes nothing it does
/// not own: an offline copy's part, or a part edit while the room holds a whole view.
#[test]
fn a_part_applied_to_the_whole_document_changes_nothing_else() {
    for seed in 1..=50 {
        let whole = random_canvas(seed);
        let want = json(&whole);
        let s = split(&encode(&whole)).unwrap();
        for (k, b) in &s.parts {
            let part = load(b, 77);
            let copy = load(&encode(&whole), 78);
            apply(&copy, &own_share(&encode(&part), k, &s.owners).unwrap());
            // Unfiltered, the fillers in its delete set would delete other parts' items.
            let raw = load(&encode(&whole), 79);
            apply(&raw, &encode(&part));
            if k == MAIN && seed == 1 {
                assert_ne!(
                    json(&raw),
                    want,
                    "seed 1: the raw part should break the whole"
                );
            }
            assert_eq!(
                json(&copy),
                want,
                "seed {seed}: part {k:?} applied to the whole"
            );
        }
    }
}

#[test]
fn a_clock_range_claimed_by_two_parts_is_refused() {
    let a = doc_with(1);
    a.get_or_insert_text("t")
        .insert(&mut a.transact_mut(), 0, "x");
    let b = doc_with(1);
    b.get_or_insert_text("t")
        .insert(&mut b.transact_mut(), 0, "yy");
    assert!(matches!(
        flatten(&[encode(&a), encode(&b)]),
        Err(Error::Clash { client: 1, .. })
    ));
}

#[test]
fn owner_index_merges_and_trims() {
    let mut o = OwnerIndex::default();
    o.record(1, 0, 5, "databases/a");
    o.record(1, 5, 9, "databases/a");
    o.record(1, 3, 6, MAIN);
    let at = |c| {
        o.owner(Id {
            client: 1,
            clock: c,
        })
        .map(|(k, e)| (k.to_string(), e))
    };
    assert_eq!(at(0), Some(("databases/a".into(), 3)));
    assert_eq!(at(4), Some((MAIN.into(), 6)));
    assert_eq!(at(7), Some(("databases/a".into(), 9)));
    assert_eq!(at(9), None);
}

#[test]
fn garbage_is_refused_not_panicked_on() {
    for bad in [&[][..], &[1, 1], &[1, 1, 5, 0, 0x87], &[0xff; 12]] {
        assert!(split(bad).is_err() || flatten(&[bad]).is_ok());
    }
}

#[test]
fn main_share_keeps_a_delete_without_new_structs() {
    let doc = doc_with(1);
    let content = doc.get_or_insert_xml_fragment("content");
    content.push_back(&mut doc.transact_mut(), XmlTextPrelim::new("delete me"));
    let cut = split(&encode(&doc)).unwrap();

    let before = doc.transact().state_vector();
    content.remove_range(&mut doc.transact_mut(), 0, 1);
    let update = doc.transact().encode_state_as_update_v1(&before);
    assert!(!delete_set(&update).unwrap().is_empty());

    let share = main_share(&update, &cut.owners).unwrap();
    assert_eq!(
        struct_section(&share).unwrap(),
        struct_section(&update).unwrap()
    );
    assert_eq!(delete_set(&share).unwrap(), delete_set(&update).unwrap());
}

#[test]
fn routing_leaves_new_databases_in_main_until_the_next_split() {
    let doc = doc_with(1);
    let databases = doc.get_or_insert_map(roots::DATABASES);
    let mut txn = doc.transact_mut();
    let database = databases.insert(&mut txn, "new", MapPrelim::default());
    database.insert(&mut txn, "name", "New database");
    let update = txn.encode_update_v1();

    let routed = route(&update, &OwnerIndex::default(), &|_, _| 0).unwrap();
    assert_eq!(
        routed.parts.keys().map(String::as_str).collect::<Vec<_>>(),
        [MAIN]
    );
    assert_eq!(routed.parts[MAIN], update);
}
