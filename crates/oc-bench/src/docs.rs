// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Seed documents the mock host serves (docs/22 §2).
//!
//! `demo` approximates the editor's "Sprint 42 planning" demo canvas (web/packages/editor/src/lib/demo.ts):
//! the same blocks, the 7-row `tasks` database, a small flow board, one comment thread and an
//! inline image of 40 KB (the demo rasterises its SVG art to a data URL). `big` is `demo` plus a
//! 1,000-row database and a 500-shape board. Built here, in Rust, from `document.json` because
//! the demo itself is seeded through Tiptap in the browser.

use oc_model::import::apply_document_json;
use oc_model::{CommitInfo, write_ocanvas};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocKind {
    Empty,
    Demo,
    Big,
}

impl DocKind {
    pub fn parse(s: &str) -> anyhow::Result<Self> {
        Ok(match s {
            "empty" => Self::Empty,
            "demo" => Self::Demo,
            "big" => Self::Big,
            _ => anyhow::bail!("--doc must be empty | demo | big"),
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::Demo => "demo",
            Self::Big => "big",
        }
    }
}

fn text(s: &str) -> Value {
    json!({"type": "text", "text": s})
}

fn p(s: &str) -> Value {
    if s.is_empty() {
        json!({"type": "paragraph"})
    } else {
        json!({"type": "paragraph", "content": [text(s)]})
    }
}

fn h2(s: &str) -> Value {
    json!({"type": "heading", "attrs": {"level": 2}, "content": [text(s)]})
}

fn bullets(items: &[&str]) -> Value {
    json!({"type": "bulletList", "content": items.iter().map(|i| json!({"type": "listItem", "content": [p(i)]})).collect::<Vec<_>>()})
}

const ST4: &str = r#"[{"v":"Backlog","c":"gray"},{"v":"In progress","c":"blue"},{"v":"In review","c":"amber"},{"v":"Done","c":"green"}]"#;
const AREAS: &str = r#"[{"v":"API","c":"purple"},{"v":"Editor","c":"blue"},{"v":"Board","c":"pink"},{"v":"Infra","c":"gray"},{"v":"Docs","c":"green"}]"#;

fn tasks_db(name: &str, rows: &[(String, &str, &str, String, i64, &str)]) -> Value {
    let st: Value = serde_json::from_str(ST4).expect("static json");
    let areas: Value = serde_json::from_str(AREAS).expect("static json");
    let fields = json!([
        {"id": "title", "name": "Task", "type": "title"},
        {"id": "status", "name": "Status", "type": "status", "options": st},
        {"id": "owner", "name": "Owner", "type": "person"},
        {"id": "due", "name": "Due", "type": "date"},
        {"id": "pts", "name": "Points", "type": "number"},
        {"id": "area", "name": "Area", "type": "tags", "options": areas},
    ]);
    let mut order = Vec::new();
    let mut map = serde_json::Map::new();
    for (i, (title, status, owner, due, pts, area)) in rows.iter().enumerate() {
        let id = format!("row{i:04}");
        order.push(json!(id));
        map.insert(
            id,
            json!({"title": title, "status": status, "owner": owner, "due": due, "pts": pts, "area": [area]}),
        );
    }
    json!({"name": name, "icon": "list-todo", "tone": "blue", "fields": fields,
           "order": order, "rows": map, "notes": {}, "view": "table", "views": {}})
}

fn demo_rows() -> Vec<(
    String,
    &'static str,
    &'static str,
    String,
    i64,
    &'static str,
)> {
    [
        (
            "Launch-token claims agreed with the host backend",
            "Done",
            "u_asha",
            "2026-11-17",
            2,
            "API",
        ),
        (
            "Role filter rejects writes from viewers",
            "In review",
            "u_ravi",
            "2026-11-24",
            3,
            "API",
        ),
        (
            "Room WAL compaction every 500 updates",
            "In progress",
            "u_ravi",
            "2026-11-26",
            5,
            "Infra",
        ),
        (
            "Database block: table and board views",
            "In progress",
            "u_lin",
            "2026-11-27",
            8,
            "Editor",
        ),
        (
            "Board pointer smoothing at 60 fps",
            "Backlog",
            "u_lin",
            "2026-12-02",
            3,
            "Board",
        ),
        (
            "Side-panel layout for Meet",
            "In progress",
            "u_priya",
            "2026-11-25",
            3,
            "Editor",
        ),
        (
            "Integration guide: callbacks section",
            "Backlog",
            "u_asha",
            "2026-12-04",
            2,
            "Docs",
        ),
    ]
    .into_iter()
    .map(|(t, s, o, d, n, a)| (t.to_string(), s, o, d.to_string(), n, a))
    .collect()
}

fn board(shapes: usize) -> Value {
    let mut order = Vec::new();
    let mut map = serde_json::Map::new();
    let kinds = ["sticky", "rect", "ellipse", "diamond", "text"];
    for i in 0..shapes {
        let id = format!("s{i:04}");
        let (x, y) = ((i % 25) as i64 * 180, (i / 25) as i64 * 140);
        let shape = if i > 0 && i % 6 == 0 {
            json!({"type": "arrow", "x": x, "y": y, "w": 120, "h": 0, "pts": [[x, y], [x + 120, y]],
                   "start": {"shapeId": format!("s{:04}", i - 1), "anchor": "right"},
                   "end": {"shapeId": format!("s{:04}", i + 1), "anchor": "left"}, "route": "elbow"})
        } else {
            json!({"type": kinds[i % kinds.len()], "x": x, "y": y, "w": 160, "h": 96,
                   "fill": "y", "text": format!("Step {i}: host signs a launch token")})
        };
        order.push(json!(id));
        map.insert(id, shape);
    }
    json!({"shapes": map, "order": order})
}

/// The logical `document.json` of a seed document.
pub fn document(kind: DocKind) -> Value {
    if kind == DocKind::Empty {
        return json!({"type": "doc", "content": []});
    }
    // ~40 KB inline image, like the demo's rasterised art.
    let img = format!("data:image/png;base64,{}", "iVBORw0KGgo".repeat(3700));
    let mut content = vec![
        json!({"type": "callout", "attrs": {"tone": "blue", "icon": "target"}, "content": [p("Sprint goal: ship the embed SDK beta to two internal hosts, a meeting app and a chat app, by Dec 12.")]}),
        h2("Decisions"),
        p(
            "The file stays in the host. We save on idle and when the last person leaves. Autosave runs every 60 seconds by default and hosts can change it per tenant.",
        ),
        p(""),
        h2("Backlog"),
        json!({"type": "database", "attrs": {"dbId": "tasks"}}),
        h2("How a session flows"),
        json!({"type": "board", "attrs": {"boardId": "flow"}}),
        h2("Notes"),
        json!({"type": "columns", "content": [
            {"type": "column", "content": [p("Host app owns"), bullets(&["Users and sign-in", "Who can view, comment or edit", "The file and its versions"])]},
            {"type": "column", "content": [p("OpenCanvas owns"), bullets(&["Editing and live merge", "Cursors and presence", "Preview, export and autosave"])]},
        ]}),
        json!({"type": "toggle", "attrs": {"open": false}, "content": [
            {"type": "toggleSummary", "content": [text("Open questions")]},
            {"type": "toggleContent", "content": [bullets(&["Should commenters see the board pointers of editors?", "Do we need per-channel autosave, or is per-tenant enough?"])]},
        ]}),
        json!({"type": "bookmark", "attrs": {"url": "https://docs.acme.example/opencanvas/integration", "title": "Integration guide · Acme developer docs", "description": "The WOPI host model with CheckFileInfo, GetFile and PutFile.", "site": "docs.acme.example"}}),
        json!({"type": "image", "attrs": {"src": img, "alt": "Session pipeline", "caption": "Session pipeline, pasted from the design review."}}),
        json!({"type": "fileAttachment", "attrs": {"name": "session-design-brief.pdf", "size": 1578, "mime": "application/pdf", "url": "/demo/session-brief.pdf"}}),
        json!({"type": "embed", "attrs": {"provider": "youtube", "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ", "title": "Demo: two cursors, one board"}}),
        json!({"type": "codeBlock", "attrs": {"language": "http"}, "content": [text("POST /v1/files/doc_8812/patch\n{ \"op\": \"append\", \"markdown\": \"- [ ] Follow up with design\" }")]}),
    ];
    let mut databases = json!({"tasks": tasks_db("Sprint 42 backlog", &demo_rows())});
    let mut boards = json!({"flow": board(12)});
    if kind == DocKind::Big {
        content.push(h2("All work items"));
        content.push(json!({"type": "database", "attrs": {"dbId": "items"}}));
        content.push(h2("Architecture map"));
        content.push(json!({"type": "board", "attrs": {"boardId": "map"}}));
        let statuses = ["Backlog", "In progress", "In review", "Done"];
        let owners = ["u_asha", "u_ravi", "u_lin", "u_priya"];
        let areas = ["API", "Editor", "Board", "Infra", "Docs"];
        let rows: Vec<_> = (0..1000)
            .map(|i| {
                (
                    format!("Work item {i}: tighten the room actor fan-out path"),
                    statuses[i % 4],
                    owners[i % 4],
                    format!("2026-12-{:02}", 1 + i % 28),
                    (i % 8) as i64,
                    areas[i % 5],
                )
            })
            .collect();
        databases["items"] = tasks_db("All work items", &rows);
        boards["map"] = board(500);
    }
    json!({
        "type": "doc",
        "content": content,
        "meta": {"title": "Sprint 42 planning", "icon": "rocket", "tone": "blue", "template": "demo"},
        "databases": databases,
        "boards": boards,
        "comments": {"t_demo1": {"quote": "Autosave runs every 60 seconds by default", "resolved": false,
            "messages": [
                {"user": "u_ravi", "text": "Can hosts set this per channel, or only per tenant?", "at": 1_763_700_000_000_i64},
                {"user": "u_asha", "text": "Per tenant for now. Per channel is a P2 flag.", "at": 1_763_700_100_000_i64},
            ]}},
    })
}

/// `.ocanvas` bytes for a seed document, or `None` for an empty (new) file.
pub fn ocanvas(kind: DocKind) -> anyhow::Result<Option<Vec<u8>>> {
    if kind == DocKind::Empty {
        return Ok(None);
    }
    let doc = oc_model::new_doc();
    apply_document_json(&doc, &document(kind));
    let commit = CommitInfo {
        id: "seed".into(),
        authors: vec![],
        at: "2026-11-21T00:00:00Z".into(),
    };
    Ok(Some(write_ocanvas(&doc, &commit)?))
}

/// Encoded Yjs state size (bytes) of a seed document.
pub fn ydoc_len(kind: DocKind) -> usize {
    let doc = oc_model::new_doc();
    apply_document_json(&doc, &document(kind));
    oc_model::ocanvas::encode_state(&doc).len()
}
