// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Seeded fixture canvases (docs/36 §2.3). Same seed, same bytes.
//!
//! `canvas-50mb`: 200 pages of text, 20 databases × 5,000 rows × 12 fields, 10 boards of 2,000
//! items and 5 diagrams of 1,000 shapes, spread through the pages from page 2 on, so the first
//! screen is text (as most canvases open). `l`, `m`, `s`: the same mix at 1/2, 1/10 and 1/100 of
//! the rows and items.

use oc_model::import::apply_document_json;
use oc_model::{CommitInfo, write_ocanvas};
use serde_json::{Value, json};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*: fixed seed, no dependency.
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
        xs[(self.next() % xs.len() as u64) as usize]
    }
    fn words(&mut self, n: usize) -> String {
        (0..n).map(|_| self.pick(WORDS)).collect::<Vec<_>>().join(" ")
    }
}

const WORDS: &[&str] = &[
    "room", "host", "launch", "token", "editor", "board", "row", "field", "sync", "save", "file",
    "review", "budget", "owner", "status", "plan", "ship", "draft", "client", "server", "update",
    "merge", "cursor", "page", "block", "table", "chart", "note", "task", "team", "quarter",
    "release", "metric", "latency", "memory", "socket", "offline", "export", "import", "search",
];

#[derive(Clone, Copy)]
struct Mix {
    pages: usize,
    dbs: usize,
    rows: usize,
    boards: usize,
    items: usize,
    diagrams: usize,
    shapes: usize,
}

fn mix(name: &str) -> Option<Mix> {
    let full = Mix {
        pages: 200,
        dbs: 20,
        rows: 5_000,
        boards: 10,
        items: 2_000,
        diagrams: 5,
        shapes: 1_000,
    };
    let scale = |d: usize| Mix {
        rows: full.rows / d,
        items: full.items / d,
        shapes: full.shapes / d,
        ..full
    };
    Some(match name {
        "canvas-50mb" => full,
        "l" => scale(2),
        "m" => scale(10),
        "s" => scale(100),
        _ => return None,
    })
}

fn p(s: String) -> Value {
    json!({"type": "paragraph", "content": [{"type": "text", "text": s}]})
}

fn database(r: &mut Rng, i: usize, rows: usize) -> Value {
    let st = json!([{"v":"Backlog","c":"gray"},{"v":"In progress","c":"blue"},{"v":"Done","c":"green"}]);
    let fields = json!([
        {"id": "title", "name": "Title", "type": "title"},
        {"id": "status", "name": "Status", "type": "status", "options": st},
        {"id": "owner", "name": "Owner", "type": "person"},
        {"id": "due", "name": "Due", "type": "date"},
        {"id": "pts", "name": "Points", "type": "number"},
        {"id": "area", "name": "Area", "type": "tags"},
        {"id": "notes", "name": "Notes", "type": "text"},
        {"id": "cost", "name": "Cost", "type": "number"},
        {"id": "url", "name": "Link", "type": "url"},
        {"id": "done", "name": "Done", "type": "checkbox"},
        {"id": "email", "name": "Contact", "type": "email"},
        {"id": "region", "name": "Region", "type": "select"},
    ]);
    let mut order = Vec::with_capacity(rows);
    let mut map = serde_json::Map::new();
    for n in 0..rows {
        let id = format!("r{n:05}");
        order.push(json!(id));
        map.insert(
            id,
            json!({
                "title": r.words(5), "status": r.pick(&["Backlog", "In progress", "Done"]),
                "owner": r.pick(&["u_asha", "u_ravi", "u_lin", "u_priya"]),
                "due": format!("2026-{:02}-{:02}", 1 + r.next() % 12, 1 + r.next() % 28),
                "pts": (r.next() % 13) as i64, "area": [r.pick(&["API", "Editor", "Board", "Infra"])],
                "notes": r.words(6), "cost": (r.next() % 100_000) as i64,
                "url": format!("https://example.test/{}", r.next() % 1_000_000),
                "done": r.next() % 2 == 0, "email": format!("p{}@example.test", r.next() % 5_000),
                "region": r.pick(&["EMEA", "APAC", "AMER"]),
            }),
        );
    }
    json!({"name": format!("Database {i}"), "icon": "table", "tone": "blue", "fields": fields,
           "order": order, "rows": map, "notes": {}, "view": "table", "views": {}})
}

fn board(r: &mut Rng, items: usize, diagram: bool) -> Value {
    let mut order = Vec::with_capacity(items);
    let mut map = serde_json::Map::new();
    let kinds: &[&str] = if diagram {
        &["rect", "diamond", "ellipse"]
    } else {
        &["sticky", "rect", "text"]
    };
    for n in 0..items {
        let id = format!("s{n:05}");
        let (x, y) = ((n % 40) as i64 * 180, (n / 40) as i64 * 140);
        let shape = if diagram && n > 0 && n % 3 == 0 {
            json!({"type": "arrow", "x": x, "y": y, "w": 120, "h": 0, "pts": [[x, y], [x + 120, y]],
                   "start": {"shapeId": format!("s{:05}", n - 1), "anchor": "right"},
                   "end": {"shapeId": format!("s{:05}", n + 1), "anchor": "left"}, "route": "elbow"})
        } else {
            json!({"type": r.pick(kinds), "x": x, "y": y, "w": 160, "h": 96, "fill": "y", "text": r.words(4)})
        };
        order.push(json!(id));
        map.insert(id, shape);
    }
    json!({"shapes": map, "order": order})
}

fn document(m: Mix) -> Value {
    let mut r = Rng(0x0CA1_1A55_EED0);
    let mut content = Vec::new();
    let (mut dbs, mut boards) = (serde_json::Map::new(), serde_json::Map::new());
    // Heavy blocks in a fixed cycle: database, database, board or diagram, ...
    let mut heavy: Vec<char> = Vec::new();
    let (mut d, mut b, mut g) = (m.dbs, m.boards, m.diagrams);
    while d + b + g > 0 {
        for k in ['d', 'd', 'b', 'g'] {
            let left = match k {
                'd' => &mut d,
                'b' => &mut b,
                _ => &mut g,
            };
            if *left > 0 {
                *left -= 1;
                heavy.push(k);
            }
        }
    }
    let every = (m.pages - 2) as f64 / heavy.len() as f64;
    let (mut di, mut bi, mut gi, mut next) = (0, 0, 0, 0);
    for page in 0..m.pages {
        content.push(json!({"type": "heading", "attrs": {"level": 2},
            "content": [{"type": "text", "text": format!("Page {page}: {}", r.words(3))}]}));
        for _ in 0..10 {
            let n = 40 + (r.next() % 30) as usize;
            content.push(p(r.words(n)));
        }
        while next < heavy.len() && page >= 2 + (next as f64 * every) as usize {
            match heavy[next] {
                'd' => {
                    let id = format!("db{di:02}");
                    dbs.insert(id.clone(), database(&mut r, di, m.rows));
                    content.push(json!({"type": "database", "attrs": {"dbId": id}}));
                    di += 1;
                }
                'b' => {
                    let id = format!("board{bi:02}");
                    boards.insert(id.clone(), board(&mut r, m.items, false));
                    content.push(json!({"type": "board", "attrs": {"boardId": id}}));
                    bi += 1;
                }
                _ => {
                    let id = format!("diagram{gi:02}");
                    boards.insert(id.clone(), board(&mut r, m.shapes, true));
                    content.push(json!({"type": "board", "attrs": {"boardId": id}}));
                    gi += 1;
                }
            }
            next += 1;
        }
    }
    json!({"type": "doc", "content": content,
           "meta": {"title": "Fixture canvas", "icon": "rocket", "tone": "blue"},
           "databases": dbs, "boards": boards})
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(name), Some(out)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: oc-fixtures <canvas-50mb|l|m|s> <out.ocanvas>");
        std::process::exit(2);
    };
    let m = mix(name).unwrap_or_else(|| panic!("unknown fixture {name}"));
    let doc = oc_model::new_doc();
    apply_document_json(&doc, &document(m));
    let commit = CommitInfo {
        id: "fixture".into(),
        authors: vec![],
        at: "2026-11-26T00:00:00Z".into(),
        ..Default::default()
    };
    let bytes = write_ocanvas(&doc, &commit).expect("write");
    std::fs::write(out, &bytes).expect("write file");
    let state = oc_model::ocanvas::encode_state(&doc).len();
    println!(
        "{name}: {} bytes .ocanvas, {state} bytes Yjs state",
        bytes.len()
    );
}
