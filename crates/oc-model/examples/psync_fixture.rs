// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! PSYNC-02 check on a real fixture (docs/36 §2.3):
//!
//! `psync_fixture split <file.ocanvas> <dir>`: cuts the file's state with `oc_model::parts`
//! (item ids kept), checks that the flatten is the original struct section byte for byte with
//! the same delete set, and writes `whole.bin`, `main.bin` and `part-<n>.bin`.
//! `psync_fixture hold <dir> whole|main`: loads that into yrs as the room does and waits a
//! moment; run under `/usr/bin/time -l` for the resident memory.

use std::time::Instant;

use oc_model::parts;
use yrs::updates::decoder::Decode;
use yrs::{Doc, Transact, Update};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("split") => split(&args[2], &args[3]),
        Some("hold") => hold(&args[2], &args[3]),
        _ => eprintln!("usage: psync_fixture split <file> <dir> | hold <dir> whole|main"),
    }
}

fn split(file: &str, dir: &str) {
    let bytes = std::fs::read(file).expect("fixture");
    let loaded = oc_model::read_ocanvas(&bytes).expect(".ocanvas");
    let whole = oc_model::ocanvas::encode_state(&loaded.doc);
    drop(loaded);
    let t = Instant::now();
    let s = parts::split(&whole).expect("split");
    let split_ms = t.elapsed().as_millis();
    let t = Instant::now();
    let flat = parts::flatten(&s.parts.values().collect::<Vec<_>>()).expect("flatten");
    let flatten_ms = t.elapsed().as_millis();
    assert_eq!(
        parts::struct_section(&flat).unwrap(),
        parts::struct_section(&whole).unwrap(),
        "flatten is not the original struct section"
    );
    assert_eq!(
        parts::delete_set(&flat).unwrap(),
        parts::delete_set(&whole).unwrap()
    );
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(format!("{dir}/whole.bin"), &whole).unwrap();
    let mut largest = 0;
    for (i, (k, b)) in s.parts.iter().enumerate() {
        if k.is_empty() {
            std::fs::write(format!("{dir}/main.bin"), b).unwrap();
        } else {
            std::fs::write(format!("{dir}/part-{i}.bin"), b).unwrap();
            largest = largest.max(b.len());
        }
    }
    println!(
        "whole {} B; main {} B; {} parts, largest {} B, all {} B; split {split_ms} ms, flatten {flatten_ms} ms; flatten == original struct bytes and delete set",
        whole.len(),
        s.parts[parts::MAIN].len(),
        s.parts.len() - 1,
        largest,
        s.parts.values().map(Vec::len).sum::<usize>() - s.parts[parts::MAIN].len(),
    );
}

fn hold(dir: &str, what: &str) {
    let bytes = std::fs::read(format!("{dir}/{what}.bin")).expect("split first");
    let t = Instant::now();
    let doc = Doc::new();
    oc_model::ensure_roots(&doc);
    doc.transact_mut()
        .apply_update(Update::decode_v1(&bytes).unwrap())
        .unwrap();
    drop(bytes);
    println!("{what}: decoded in {} ms", t.elapsed().as_millis());
    std::thread::sleep(std::time::Duration::from_millis(300));
    drop(doc);
}
