// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! PSYNC-01 spike (docs/36 §2): throwaway measurement code, not wired into the product.
//!
//! `split <fixture.ocanvas> <dir>` writes what each approach sends:
//!   full.bin            the whole document, update v1 (0.3 today, and the projection's full sync)
//!   main.bin            (a) subdocuments: text, outline, meta and a header per heavy block
//!   sub/<id>.bin        (a) one subdocument per database, board and diagram
//!   proj.json           (b) first-screen projection: the first screen's blocks as JSON
//!   proj-db.json        (b) the same when a database is on the first screen (its first 30 rows)
//! and checks that main + every subdocument flatten back to the original logical document.
//! `hold <dir> full|main|main+db|main+all|proj|none`: loads that into yrs, as a room would,
//! and prints decode time; run under `/usr/bin/time -l` for the resident memory.

use std::time::Instant;

use oc_model::import::apply_document_json;
use oc_model::ocanvas::{apply_update_bytes, read_ocanvas};
use serde_json::{Value, json};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

/// Top-level blocks on a first screen (a heading and the paragraphs under it at 1280×800).
const FIRST_SCREEN: usize = 8;
const PROJ_ROWS: usize = 30;

fn v1(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn v2(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v2(&StateVector::default())
}

fn doc_of(v: &Value) -> Doc {
    let doc = oc_model::new_doc();
    apply_document_json(&doc, v);
    doc
}

fn header(kind: &str, v: &Value) -> Value {
    let (count, name) = match kind {
        "database" => (
            v["order"].as_array().map_or(0, Vec::len),
            v["name"].clone(),
        ),
        _ => (v["order"].as_array().map_or(0, Vec::len), Value::Null),
    };
    // Size hint for the placeholder: a database shows up to 30 rows, a board a fixed frame.
    let height = if kind == "database" {
        40 + 33 * count.min(PROJ_ROWS)
    } else {
        480
    };
    json!({"split": true, "kind": kind, "name": name, "count": count, "height": height})
}

fn split(src: &str, dir: &str) {
    let bytes = std::fs::read(src).expect("fixture");
    let loaded = read_ocanvas(&bytes).expect("read .ocanvas");
    let full_json = oc_model::doc_to_json(&loaded.doc);
    std::fs::create_dir_all(format!("{dir}/sub")).unwrap();
    let full = v1(&loaded.doc);
    std::fs::write(format!("{dir}/full.bin"), &full).unwrap();
    println!("full.bin {} (v2 {})", full.len(), v2(&loaded.doc).len());

    // (a) Main document: heavy blocks replaced by headers, each block's content its own doc.
    let mut main = full_json.clone();
    let mut subs = Vec::new();
    for (root, kind) in [("databases", "database"), ("boards", "board")] {
        let Some(obj) = full_json[root].as_object() else {
            continue;
        };
        for (id, v) in obj {
            main[root][id] = header(kind, v);
            let sub = doc_of(&json!({"type": "doc", "content": [], root: {id.clone(): v.clone()}}));
            let b = v1(&sub);
            std::fs::write(format!("{dir}/sub/{id}.bin"), &b).unwrap();
            subs.push((root, id.clone(), b.len()));
        }
    }
    let main_doc = doc_of(&main);
    let mb = v1(&main_doc);
    std::fs::write(format!("{dir}/main.bin"), &mb).unwrap();
    let total: usize = subs.iter().map(|s| s.2).sum();
    let max = subs.iter().max_by_key(|s| s.2).unwrap();
    println!(
        "main.bin {} (v2 {}); {} subdocuments, {} bytes in all, largest {} {}",
        mb.len(),
        v2(&main_doc).len(),
        subs.len(),
        total,
        max.1,
        max.2
    );

    // Flatten: main + every subdocument gives the original logical document (save stays v1).
    let mut flat = main.clone();
    for (root, id, _) in &subs {
        flat[*root][id.as_str()] = full_json[*root][id.as_str()].clone();
    }
    let flat_doc = doc_of(&flat);
    assert_eq!(
        oc_model::doc_to_json(&flat_doc),
        full_json,
        "flatten round trip"
    );
    println!("flatten round trip: logical document equal");

    // (b) Projections, made on the server from the full document.
    let t = Instant::now();
    let content = full_json["content"].as_array().unwrap();
    let first: Vec<Value> = content.iter().take(FIRST_SCREEN).cloned().collect();
    let proj = json!({"blocks": first, "meta": full_json["meta"]});
    let pj = serde_json::to_vec(&proj).unwrap();
    std::fs::write(format!("{dir}/proj.json"), &pj).unwrap();
    // The first database moved onto the first screen: its fields and first rows.
    let db = &full_json["databases"]["db00"];
    let rows: serde_json::Map<String, Value> = db["order"]
        .as_array()
        .unwrap()
        .iter()
        .take(PROJ_ROWS)
        .map(|id| {
            let id = id.as_str().unwrap();
            (id.to_string(), db["rows"][id].clone())
        })
        .collect();
    let mut first_db: Vec<Value> = content.iter().take(2).cloned().collect();
    first_db.push(json!({"type": "database", "attrs": {"dbId": "db00"},
        "projection": {"name": db["name"], "fields": db["fields"], "rows": rows,
                       "count": db["order"].as_array().unwrap().len()}}));
    first_db.extend(content.iter().skip(2).take(FIRST_SCREEN - 3).cloned());
    let pdb = serde_json::to_vec(&json!({"blocks": first_db, "meta": full_json["meta"]})).unwrap();
    std::fs::write(format!("{dir}/proj-db.json"), &pdb).unwrap();
    println!(
        "proj.json {} proj-db.json {} (made in {} ms from the logical JSON)",
        pj.len(),
        pdb.len(),
        t.elapsed().as_millis()
    );
}

fn load(doc: &Doc, path: &str) -> usize {
    let b = std::fs::read(path).unwrap();
    // A v1 update, as the room applies one from the WAL or the host's file.
    let u = Update::decode_v1(&b).unwrap();
    doc.transact_mut().apply_update(u).unwrap();
    b.len()
}

fn hold(dir: &str, what: &str) {
    let t = Instant::now();
    let mut docs = Vec::new();
    let mut bytes = 0;
    match what {
        "none" => {}
        "full" => {
            let d = Doc::new();
            bytes += load(&d, &format!("{dir}/full.bin"));
            docs.push(d);
        }
        "proj" => {
            // The projection keeps the full room and renders the first screen from it.
            let d = Doc::new();
            bytes += load(&d, &format!("{dir}/full.bin"));
            let json = oc_model::doc_to_json(&d);
            let first: Vec<Value> = json["content"]
                .as_array()
                .unwrap()
                .iter()
                .take(FIRST_SCREEN)
                .cloned()
                .collect();
            bytes += serde_json::to_vec(&first).unwrap().len();
            docs.push(d);
        }
        _ => {
            let d = Doc::new();
            bytes += load(&d, &format!("{dir}/main.bin"));
            docs.push(d);
            let subs: Vec<String> = match what {
                "main" => vec![],
                "main+db" => vec!["db00".into()],
                "main+all" => std::fs::read_dir(format!("{dir}/sub"))
                    .unwrap()
                    .map(|e| {
                        e.unwrap()
                            .path()
                            .file_stem()
                            .unwrap()
                            .to_string_lossy()
                            .into_owned()
                    })
                    .collect(),
                other => panic!("unknown {other}"),
            };
            for s in subs {
                let d = Doc::new();
                bytes += load(&d, &format!("{dir}/sub/{s}.bin"));
                docs.push(d);
            }
        }
    }
    // Make sure every doc is integrated (not pending).
    for d in &docs {
        let _ = d.transact().state_vector();
        let _ = apply_update_bytes;
    }
    println!(
        "hold {what}: {} docs, {bytes} bytes decoded in {} ms",
        docs.len(),
        t.elapsed().as_millis()
    );
    std::hint::black_box(&docs);
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    match a.get(1).map(String::as_str) {
        Some("split") => split(&a[2], &a[3]),
        Some("hold") => hold(&a[2], &a[3]),
        _ => eprintln!("usage: psync-spike split <fixture> <dir> | hold <dir> <what>"),
    }
}
