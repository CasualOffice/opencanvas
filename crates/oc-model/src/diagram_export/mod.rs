// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Diagram export (DGM-14.6, docs/29 §8.7): one board → a draw.io file (`.drawio`, uncompressed
//! `mxfile`) or Mermaid flowchart text (`.mmd`), plus a report of what changes on the way out
//! (AGENTS.md rule 7). The draw.io mapping mirrors [`crate::diagram_import`], so exporting and
//! importing again keeps ids (`props.sourceId`), connectors, labels, containers and groups on the
//! supported subset (`tests/diagram_export.rs`).
//!
//! Input is the logical JSON from [`crate::doc_to_json`] (`boards/<id>/{shapes, order}`).
//! Output is deterministic: shapes in paint order, then by id.

mod drawio;
mod mermaid;

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Drawio,
    Mermaid,
}

impl Format {
    /// `drawio` or `mmd` (the file extension).
    pub fn parse(s: &str) -> Option<Format> {
        match s {
            "drawio" => Some(Format::Drawio),
            "mmd" | "mermaid" => Some(Format::Mermaid),
            _ => None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Format::Drawio => "drawio",
            Format::Mermaid => "mermaid",
        }
    }
}

/// The exported file and the report `{format, counts: {shapes, connectors, containers,
/// needLook}, items: [{level, code, title, detail?, count, examples}]}`.
#[derive(Debug)]
pub struct Exported {
    pub text: String,
    pub report: Value,
}

/// Exports board `board_id` of `doc`. With `only`, just those shapes and the connectors between
/// them (the selection). `None` when the board doesn't exist.
pub fn export(
    format: Format,
    doc: &Value,
    board_id: &str,
    only: Option<&HashSet<String>>,
) -> Option<Exported> {
    let board = doc["boards"].get(board_id)?;
    if !board.is_object() {
        return None;
    }
    let mut shapes = read(board);
    if let Some(only) = only {
        shapes.retain(|s| only.contains(&s.id));
    }
    let name = board["name"].as_str().unwrap_or("Board").to_string();
    let mut out = Out::default();
    let text = match format {
        Format::Drawio => {
            let routed = crate::board::current_routes(doc, board_id);
            drawio::write(&shapes, board_id, &name, &routed, &mut out)
        }
        Format::Mermaid => mermaid::write(&shapes, &mut out),
    };
    Some(Exported {
        report: out.report(format, &shapes),
        text,
    })
}

// ---------- shapes ----------

#[derive(Debug, Clone)]
pub(crate) struct S {
    pub id: String,
    pub ty: String,
    pub v: Value,
}

impl S {
    pub fn num(&self, k: &str) -> f64 {
        self.v[k].as_f64().filter(|n| n.is_finite()).unwrap_or(0.0)
    }
    pub fn str(&self, k: &str) -> &str {
        self.v[k].as_str().unwrap_or("")
    }
    pub fn bx(&self) -> [f64; 4] {
        let w = self.v["w"].as_f64().unwrap_or(40.0);
        let h = self.v["h"].as_f64().unwrap_or(40.0);
        [self.num("x"), self.num("y"), w, h]
    }
    pub fn parent(&self) -> Option<&str> {
        self.v["props"]["parent"].as_str()
    }
    pub fn group(&self) -> Option<&str> {
        self.v["group"].as_str().filter(|g| !g.is_empty())
    }
    pub fn end(&self, which: &str) -> Option<&str> {
        self.v[which]["shapeId"].as_str()
    }
    pub fn pts(&self, k: &str) -> Vec<[f64; 2]> {
        self.v[k]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|p| Some([p[0].as_f64()?, p[1].as_f64()?]))
                    .collect()
            })
            .unwrap_or_default()
    }
    /// The shape's name: its text (first line), else its label, else its kind.
    pub fn name(&self) -> String {
        let t = self.str("text");
        let t = if t.trim().is_empty() {
            self.str("label")
        } else {
            t
        };
        t.lines().next().unwrap_or("").trim().to_string()
    }
}

/// Shapes in paint order: `order` first, then the rest by id (as the web `readShapes`).
fn read(board: &Value) -> Vec<S> {
    let Some(map) = board["shapes"].as_object() else {
        return vec![];
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |id: &str| {
        if let Some(v) = map.get(id).filter(|v| v.is_object())
            && seen.insert(id.to_string())
        {
            out.push(S {
                id: id.to_string(),
                ty: v["type"].as_str().unwrap_or("").to_string(),
                v: v.clone(),
            });
        }
    };
    for id in board["order"].as_array().into_iter().flatten() {
        if let Some(id) = id.as_str() {
            push(id);
        }
    }
    let mut rest: Vec<&String> = map.keys().collect();
    rest.sort();
    for id in rest {
        push(id);
    }
    out
}

/// Shapes another kept shape names as its `props.parent`.
pub(crate) fn containers(shapes: &[S]) -> HashSet<String> {
    let ids: HashSet<&str> = shapes.iter().map(|s| s.id.as_str()).collect();
    shapes
        .iter()
        .filter_map(|s| s.parent())
        .filter(|p| ids.contains(p))
        .map(str::to_string)
        .collect()
}

/// A shape's container, if it is kept and is a container (cycles cut).
pub(crate) fn parent_of<'a>(s: &'a S, containers: &HashSet<String>) -> Option<&'a str> {
    s.parent().filter(|p| *p != s.id && containers.contains(*p))
}

/// Board tones as draw.io fills that import back to the same tone (`diagram_import::tone_of`).
pub(crate) fn drawio_fill(tone: &str) -> Option<&'static str> {
    Some(match tone {
        "gray" => "#f5f5f5",
        "blue" => "#dae8fc",
        "green" => "#d5e8d4",
        "amber" => "#fff2cc",
        "red" => "#f8cecc",
        "purple" => "#e1d5e7",
        "pink" => "#fcc2d7",
        _ => return None,
    })
}

/// Board tones as `(fill, stroke)` in the light palette (`board.rs`), for Mermaid classDefs.
pub(crate) fn tone_colours(tone: &str) -> Option<(&'static str, &'static str)> {
    Some(match tone {
        "gray" => ("#efefed", "#55555c"),
        "blue" => ("#e6eefd", "#2350c8"),
        "green" => ("#e2f3e8", "#17703f"),
        "amber" => ("#fcf0d9", "#8f5300"),
        "red" => ("#fde6e6", "#b12424"),
        "purple" => ("#efe8fd", "#6538c4"),
        "pink" => ("#fce6f0", "#ad2c66"),
        _ => return None,
    })
}

pub(crate) fn sticky_tone(fill: &str) -> &'static str {
    match fill {
        "p" => "pink",
        "b" => "blue",
        "g" => "green",
        _ => "amber",
    }
}

// ---------- the report ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Level {
    Warn,
    Gray,
    Ok,
}

impl Level {
    fn name(self) -> &'static str {
        match self {
            Level::Warn => "warn",
            Level::Gray => "gray",
            Level::Ok => "ok",
        }
    }
}

/// Report codes in display order within a level.
const CODES: &[(&str, Level)] = &[
    ("kind", Level::Warn),
    ("image_stored", Level::Warn),
    ("pen", Level::Warn),
    ("unbound", Level::Warn),
    ("positions", Level::Gray),
    ("detail", Level::Gray),
    ("avoid", Level::Gray),
    ("ports", Level::Gray),
    ("sticky", Level::Gray),
    ("swatch", Level::Gray),
    ("groups_lost", Level::Gray),
    ("images_named", Level::Gray),
    ("kept", Level::Ok),
    ("containers", Level::Ok),
    ("groups", Level::Ok),
    ("labels", Level::Ok),
    ("colours", Level::Ok),
];

#[derive(Default)]
struct Note {
    count: usize,
    examples: Vec<String>,
}

#[derive(Default)]
pub(crate) struct Out {
    notes: HashMap<&'static str, Note>,
}

impl Out {
    pub fn note(&mut self, code: &'static str, example: Option<String>) {
        debug_assert!(CODES.iter().any(|(c, _)| *c == code), "{code}");
        let n = self.notes.entry(code).or_default();
        n.count += 1;
        if let Some(e) = example.filter(|e| !e.is_empty())
            && n.examples.len() < 3
            && !n.examples.contains(&e)
        {
            n.examples.push(e);
        }
    }
    /// Sets a count without examples (summary rows).
    pub fn set(&mut self, code: &'static str, count: usize) {
        if count > 0 {
            self.notes.entry(code).or_default().count = count;
        }
    }
    pub fn count(&self, code: &str) -> usize {
        self.notes.get(code).map_or(0, |n| n.count)
    }

    fn report(&self, format: Format, shapes: &[S]) -> Value {
        let connectors = shapes.iter().filter(|s| s.ty == "arrow").count();
        let mut items = Vec::new();
        for (code, level) in CODES {
            let Some(n) = self.notes.get(code) else {
                continue;
            };
            let (title, detail) = describe(code, n, format);
            let ex = n.examples.clone();
            let mut v = json!({"level": level.name(), "code": code, "title": title,
                "count": n.count, "examples": ex});
            if let Some(d) = detail {
                v["detail"] = json!(d);
            }
            items.push(v);
        }
        let need_look: usize = CODES
            .iter()
            .filter(|(_, l)| *l == Level::Warn)
            .map(|(c, _)| self.count(c))
            .sum();
        json!({
            "format": format.name(),
            "counts": {"shapes": shapes.len() - connectors, "connectors": connectors,
                "containers": self.count("containers"), "needLook": need_look},
            "items": items,
        })
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn describe(code: &str, n: &Note, format: Format) -> (String, Option<String>) {
    let c = n.count;
    let ex = {
        let list = n.examples.join(", ");
        if c > n.examples.len() && !n.examples.is_empty() {
            format!("{list} and {} more", c - n.examples.len())
        } else {
            list
        }
    };
    let ex = (!ex.is_empty()).then_some(ex);
    let tool = match format {
        Format::Drawio => "draw.io",
        Format::Mermaid => "Mermaid",
    };
    match code {
        "kind" => (
            format!(
                "{} from a library you don’t have {} as a plain box",
                plural(c, "shape", "shapes"),
                if c == 1 { "exports" } else { "export" }
            ),
            ex,
        ),
        "image_stored" => (
            format!(
                "{} stored with the canvas {} boxes",
                plural(c, "image", "images"),
                if c == 1 { "becomes" } else { "become" }
            ),
            Some("Export as PNG or SVG to keep them.".into()),
        ),
        "pen" => (
            format!("{} left out", plural(c, "pen stroke is", "pen strokes are")),
            Some(format!("{tool} has no freehand lines.")),
        ),
        "unbound" => (
            format!(
                "{} not attached at both ends left out",
                plural(c, "connector", "connectors")
            ),
            ex,
        ),
        "positions" => (
            "Positions and sizes are not kept".into(),
            Some("Mermaid lays the diagram out itself.".into()),
        ),
        "detail" => (
            "Icons and detail lines are left out".into(),
            Some("Each shape keeps its name.".into()),
        ),
        "avoid" => (
            "Routes around shapes are saved as fixed bends".into(),
            Some("draw.io won’t re-route them until you move a shape.".into()),
        ),
        "ports" => (
            "Ports become connection points on the nearest side".into(),
            ex,
        ),
        "sticky" => (
            format!(
                "{} {} boxes",
                plural(c, "sticky note", "sticky notes"),
                if c == 1 { "becomes" } else { "become" }
            ),
            None,
        ),
        "swatch" => (
            format!(
                "{} left out",
                plural(c, "colour swatch is", "colour swatches are")
            ),
            None,
        ),
        "groups_lost" => (
            "Groups are not kept".into(),
            Some(format!("{tool} has no groups; containers are kept.")),
        ),
        "images_named" => (
            format!(
                "{} {} boxes with their names",
                plural(c, "image", "images"),
                if c == 1 { "becomes" } else { "become" }
            ),
            None,
        ),
        "kept" => (
            "Shapes and connectors keep position, size, text and colour".into(),
            None,
        ),
        "containers" => (
            match format {
                Format::Drawio => "Containers become draw.io containers".into(),
                Format::Mermaid => "Containers become subgraphs".into(),
            },
            None,
        ),
        "groups" => ("Groups become draw.io groups".into(), None),
        "labels" => ("Connector labels are kept".into(), None),
        "colours" => ("Colours become classDef styles".into(), None),
        _ => (code.to_string(), None),
    }
}
