// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Board → Mermaid `flowchart TB`. Shapes become nodes named by their text (first line),
//! containers become subgraphs (nested), connectors bound at both ends become links with their
//! labels, tones become `classDef`s. Mermaid lays out by itself, so positions are not kept.
//! Node ids come from the shape ids (`[A-Za-z0-9_]`, made unique), so they are stable.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;

use super::{Out, S, containers, parent_of, sticky_tone, tone_colours};

const RESERVED: &[&str] = &[
    "end",
    "graph",
    "flowchart",
    "subgraph",
    "style",
    "class",
    "classDef",
    "click",
    "linkStyle",
    "direction",
    "default",
];

/// A Mermaid-safe id from a shape id.
pub(crate) fn node_id(id: &str) -> String {
    let mut o: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if o.is_empty()
        || o.starts_with(|c: char| c.is_ascii_digit())
        || RESERVED.iter().any(|r| r.eq_ignore_ascii_case(&o))
    {
        o.insert_str(0, "n_");
    }
    o
}

/// Text inside `["…"]`: quotes and markup characters as entity codes, line breaks as `<br>`.
fn label(t: &str) -> String {
    let mut o = String::new();
    for (i, line) in t.lines().enumerate() {
        if i > 0 {
            o.push_str("<br>");
        }
        for c in line.chars() {
            match c {
                '"' => o.push_str("#quot;"),
                '<' => o.push_str("#lt;"),
                '>' => o.push_str("#gt;"),
                '#' => o.push_str("#35;"),
                c if c.is_control() => {}
                c => o.push(c),
            }
        }
    }
    o
}

pub(super) fn write(shapes: &[S], out: &mut Out) -> String {
    let conts = containers(shapes);
    let node = |s: &S| {
        matches!(
            s.ty.as_str(),
            "rect" | "ellipse" | "diamond" | "text" | "sticky" | "image"
        )
    };
    let nodes: Vec<&S> = shapes.iter().filter(|s| node(s)).collect();
    let mut ids: HashMap<&str, String> = HashMap::new();
    let mut used: HashSet<String> = HashSet::new();
    for s in &nodes {
        let mut id = node_id(&s.id);
        let base = id.clone();
        let mut k = 2;
        while !used.insert(id.clone()) {
            id = format!("{base}_{k}");
            k += 1;
        }
        ids.insert(s.id.as_str(), id);
    }
    out.note("positions", None);
    let mut classes: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut detail = 0;
    let mut groups = false;
    for s in shapes {
        match s.ty.as_str() {
            "pen" => out.note("pen", None),
            "swatch" => out.note("swatch", None),
            _ => {}
        }
        if s.group().is_some() {
            groups = true;
        }
    }
    // Node lines, nested in their containers' subgraphs.
    let mut children: HashMap<Option<&str>, Vec<&S>> = HashMap::new();
    for s in &nodes {
        children.entry(parent_of(s, &conts)).or_default().push(s);
    }
    let mut text = String::from("flowchart TB\n");
    let mut stack: Vec<(Option<&str>, usize, usize)> = vec![(None, 0, 1)];
    let mut seen: HashSet<&str> = HashSet::new();
    // Iterative walk (no recursion on untrusted nesting); cycles are cut by `seen`.
    while let Some((at, i, depth)) = stack.pop() {
        let list = children.get(&at).map(Vec::as_slice).unwrap_or(&[]);
        let Some(s) = list.get(i) else {
            if at.is_some() {
                let _ = writeln!(text, "{}end", "    ".repeat(depth - 1));
            }
            continue;
        };
        stack.push((at, i + 1, depth));
        if !seen.insert(s.id.as_str()) {
            continue;
        }
        let pad = "    ".repeat(depth);
        let id = &ids[s.id.as_str()];
        let name = s.name();
        let name = if name.is_empty() && s.ty == "image" {
            s.str("alt").to_string()
        } else {
            name
        };
        let full = s.str("text");
        if full.lines().count() > 1
            || s.v["props"]["stencil"].is_string()
            || s.v["kind"].is_string()
        {
            detail += 1;
        }
        if conts.contains(&s.id) {
            out.note("containers", None);
            let title = if s.str("label").is_empty() {
                name.clone()
            } else {
                s.str("label").to_string()
            };
            let _ = writeln!(text, "{pad}subgraph {id} [\"{}\"]", label(&title));
            stack.push((Some(s.id.as_str()), 0, depth + 1));
            continue;
        }
        let l = label(&name);
        let shape = match s.ty.as_str() {
            "ellipse" => format!("{id}([\"{l}\"])"),
            "diamond" => format!("{id}{{\"{l}\"}}"),
            _ => format!("{id}[\"{l}\"]"),
        };
        let _ = writeln!(text, "{pad}{shape}");
        if s.ty == "image" {
            out.note("images_named", Some(name.clone()));
        }
        let tone = match s.ty.as_str() {
            "sticky" => Some(sticky_tone(s.str("fill")).to_string()),
            "rect" | "ellipse" | "diamond" => {
                tone_colours(s.str("fill")).map(|_| s.str("fill").to_string())
            }
            _ => None,
        };
        if let Some(t) = tone {
            classes.entry(t).or_default().push(id.clone());
        }
    }
    if detail > 0 {
        out.set("detail", detail);
    }
    if groups {
        out.note("groups_lost", None);
    }
    for s in shapes.iter().filter(|s| s.ty == "arrow") {
        let (Some(a), Some(b)) = (
            s.end("start").and_then(|i| ids.get(i)),
            s.end("end").and_then(|i| ids.get(i)),
        ) else {
            out.note("unbound", Some(s.name()));
            continue;
        };
        let t = s.str("text").trim();
        if t.is_empty() {
            let _ = writeln!(text, "    {a} --> {b}");
        } else {
            out.note("labels", None);
            let _ = writeln!(text, "    {a} -->|\"{}\"| {b}", label(t));
        }
    }
    for (tone, members) in &classes {
        let (fill, stroke) = tone_colours(tone).unwrap_or(("#ffffff", "#18181b"));
        let _ = writeln!(
            text,
            "    classDef {tone} fill:{fill},stroke:{stroke},color:#18181b"
        );
        let _ = writeln!(text, "    class {} {tone}", members.join(","));
    }
    if !classes.is_empty() {
        out.set("colours", classes.len());
    }
    text
}
