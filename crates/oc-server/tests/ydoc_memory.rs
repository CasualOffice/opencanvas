//! Y.Doc memory under nonstop typing (docs/22 §9.5): consecutive single-character inserts by
//! one client must squash into a few blocks on the server, whatever way the updates arrive.
use std::sync::{Arc, Mutex};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Doc, GetString, ReadTxn, Text, Transact, Update, XmlElementPrelim, XmlFragment, XmlTextPrelim,
};

/// Items and GC blocks in the doc's block store (its debug form lists one cell per block).
fn blocks(doc: &Doc) -> usize {
    let s = format!("{}", doc.transact().store());
    s.matches("UnsafeCell").count()
}

/// A client typing `n` characters at the end of its own paragraph, one update per character
/// (the first update creates the paragraph).
fn type_updates(n: usize) -> Vec<Vec<u8>> {
    let doc = Doc::new();
    let ups: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
    let p = ups.clone();
    doc.observe_update_v1("t", move |_, e: &yrs::UpdateEvent| {
        p.lock().unwrap().push(e.update.clone())
    })
    .unwrap();
    let content = doc.get_or_insert_xml_fragment("content");
    let text = {
        let mut txn = doc.transact_mut();
        let para = content.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
        para.push_back(&mut txn, XmlTextPrelim::new(""))
    };
    for i in 0..n {
        let mut txn = doc.transact_mut();
        let at = text.len(&txn);
        text.insert(&mut txn, at, if i % 7 == 0 { " " } else { "a" });
    }
    std::mem::take(&mut *ups.lock().unwrap())
}

fn apply(doc: &Doc, u: &[u8]) {
    let mut txn = doc.transact_mut();
    txn.apply_update(Update::decode_v1(u).unwrap()).unwrap();
}

#[test]
fn one_update_per_character_squashes_on_the_server() {
    let ups = type_updates(2000);
    let doc = oc_model::new_doc();
    for u in &ups {
        apply(&doc, u);
    }
    let b = blocks(&doc);
    eprintln!("per-char updates: 2,000 chars -> {b} blocks");
    assert!(b < 20, "{b} blocks for 2,000 characters");
}

#[test]
fn merged_window_updates_squash_on_the_server() {
    // The client merges 50 ms of keystrokes per frame.
    let ups = type_updates(2000);
    let doc = oc_model::new_doc();
    for w in ups.chunks(3) {
        let m = yrs::merge_updates_v1(w.iter().map(|v| v.as_slice())).unwrap();
        apply(&doc, &m);
    }
    let b = blocks(&doc);
    eprintln!("merged updates: 2,000 chars -> {b} blocks");
    assert!(b < 20, "{b} blocks for 2,000 characters");
}

#[test]
fn five_interleaved_clients_squash_on_the_server() {
    let all: Vec<Vec<Vec<u8>>> = (0..5).map(|_| type_updates(1000)).collect();
    let doc = oc_model::new_doc();
    for i in 0..all[0].len() {
        for c in &all {
            apply(&doc, &c[i]);
        }
    }
    let b = blocks(&doc);
    eprintln!("5 interleaved clients: 5,000 chars -> {b} blocks");
    assert!(b < 60, "{b} blocks for 5,000 characters");
}

// ---- Heap cost of the S2 workload's doc (measurement, docs/22 §9.5) ----------------------------

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use yrs::{Map, MapPrelim, MapRef, StateVector};

/// Counts the live heap bytes allocated by the current thread.
struct Counting;
thread_local! { static LIVE: Cell<isize> = const { Cell::new(0) }; }
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let _ = LIVE.try_with(|c| c.set(c.get() + l.size() as isize));
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        let _ = LIVE.try_with(|c| c.set(c.get() - l.size() as isize));
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let _ = LIVE.try_with(|c| c.set(c.get() + n as isize - l.size() as isize));
        unsafe { System.realloc(p, l, n) }
    }
}
#[global_allocator]
static A: Counting = Counting;

fn live() -> isize {
    LIVE.with(|c| c.get())
}

/// One oc-bench editor (crates/oc-bench/src/client.rs): per action 92 % a typed character,
/// 6 % a database cell overwrite, 2 % a half-second drag (10 windows of x and y overwrites).
/// Returns one update per 50 ms window, `secs` seconds at 5 actions/s.
fn bench_editor(secs: usize, seed: u64) -> Vec<Vec<u8>> {
    let doc = Doc::new();
    let ups: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
    let p = ups.clone();
    doc.observe_update_v1("t", move |_, e: &yrs::UpdateEvent| {
        p.lock().unwrap().push(e.update.clone())
    })
    .unwrap();
    let content = doc.get_or_insert_xml_fragment("content");
    let text = {
        let mut txn = doc.transact_mut();
        let para = content.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
        para.push_back(&mut txn, XmlTextPrelim::new(""))
    };
    let (rows, shape): (Vec<MapRef>, MapRef) = {
        let dbs = doc.get_or_insert_map("databases");
        let boards = doc.get_or_insert_map("boards");
        let mut txn = doc.transact_mut();
        let db = dbs.insert(&mut txn, format!("db_{seed}"), MapPrelim::default());
        let rows = (0..4)
            .map(|i| db.insert(&mut txn, format!("r{i}"), MapPrelim::default()))
            .collect();
        let b = boards.insert(&mut txn, format!("b_{seed}"), MapPrelim::default());
        (rows, b.insert(&mut txn, "s1", MapPrelim::default()))
    };
    let mut out = vec![
        Update::merge_updates(
            std::mem::take(&mut *ups.lock().unwrap())
                .iter()
                .map(|u| Update::decode_v1(u).unwrap()),
        )
        .encode_v1(),
    ];
    let mut rng = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
    let mut next = move || {
        rng = rng
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (rng >> 33) as f64 / (1u64 << 31) as f64
    };
    let mut drag = 0;
    let mut owed = 0.0;
    for _ in 0..secs * 20 {
        if drag > 0 {
            drag -= 1;
            let mut txn = doc.transact_mut();
            shape.insert(&mut txn, "x", next() * 4000.0);
            shape.insert(&mut txn, "y", next() * 2000.0);
        } else {
            owed += 0.25;
            while owed >= 1.0 {
                owed -= 1.0;
                let r = next();
                let mut txn = doc.transact_mut();
                if r < 0.06 {
                    let row = &rows[(next() * 4.0) as usize % 4];
                    row.insert(
                        &mut txn,
                        "status",
                        ["Backlog", "Done"][(next() * 2.0) as usize % 2],
                    );
                } else if r < 0.08 {
                    drag = 10;
                } else {
                    let at = text.len(&txn);
                    text.insert(&mut txn, at, "e");
                }
            }
        }
        let w = std::mem::take(&mut *ups.lock().unwrap());
        if !w.is_empty() {
            out.push(yrs::merge_updates_v1(w.iter().map(|v| v.as_slice())).unwrap());
        }
    }
    out
}

#[test]
fn heap_cost_of_the_s2_workload() {
    let editors: Vec<Vec<Vec<u8>>> = (1..=5).map(|s| bench_editor(120, s)).collect();
    let doc = oc_model::new_doc();
    let enc = |d: &Doc| {
        d.transact()
            .encode_state_as_update_v1(&StateVector::default())
            .len()
    };
    let (h0, e0, b0) = (live(), enc(&doc), blocks(&doc));
    let n = editors.iter().map(|e| e.len()).max().unwrap();
    for i in 0..n {
        for e in &editors {
            if let Some(u) = e.get(i) {
                apply(&doc, u);
            }
        }
    }
    let (h1, e1, b1) = (live(), enc(&doc), blocks(&doc));
    let chars: usize = doc
        .get_or_insert_xml_fragment("content")
        .get_string(&doc.transact())
        .matches('e')
        .count();
    eprintln!(
        "S2 mix, 5 editors x 120 s: {chars} chars, blocks {b0} -> {b1}, encoded {e0} -> {e1} B, \
         heap +{} B ({:.1}x encoded growth, {:.0} B per block)",
        h1 - h0,
        (h1 - h0) as f64 / (e1 - e0) as f64,
        (h1 - h0) as f64 / (b1 - b0) as f64
    );
}

#[test]
fn rebuilding_the_s2_doc_from_its_encoding_measurement() {
    let editors: Vec<Vec<Vec<u8>>> = (1..=5).map(|s| bench_editor(120, s)).collect();
    let h0 = live();
    let doc = oc_model::new_doc();
    let n = editors.iter().map(|e| e.len()).max().unwrap();
    for i in 0..n {
        for e in &editors {
            if let Some(u) = e.get(i) {
                apply(&doc, u);
            }
        }
    }
    let h1 = live();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let h2 = live();
    let fresh = oc_model::new_doc();
    apply(&fresh, &state);
    let h3 = live();
    eprintln!(
        "S2 doc: original heap {} B, {} blocks; encoded {} B; rebuilt heap {} B, {} blocks",
        h1 - h0,
        blocks(&doc),
        state.len(),
        h3 - h2,
        blocks(&fresh)
    );
}
