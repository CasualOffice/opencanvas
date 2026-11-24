// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Board → draw.io (`mxfile`, one uncompressed page). The inverse of `diagram_import::drawio` on
//! its supported subset: cell ids are the board's shape ids, containers become `container=1`
//! cells holding their children (relative geometry), board groups become `group;ocGroup=1`
//! cells, connectors keep their bound ends, side anchors, waypoints and labels.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use super::{Out, S, containers, drawio_fill, parent_of, sticky_tone};

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\n' => o.push_str("&#10;"),
            c if (c as u32) < 0x20 && c != '\t' => {}
            c => o.push(c),
        }
    }
    o
}

/// A label for an `html=1` cell: HTML-escaped text with `<br>` line breaks.
fn html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\n', "<br>")
}

fn n(v: f64) -> String {
    let r = (v * 100.0).round() / 100.0;
    if r == r.trunc() {
        format!("{}", r as i64)
    } else {
        format!("{r}")
    }
}

fn anchor_xy(a: &str) -> Option<(&'static str, &'static str)> {
    Some(match a {
        "top" => ("0.5", "0"),
        "right" => ("1", "0.5"),
        "bottom" => ("0.5", "1"),
        "left" => ("0", "0.5"),
        _ => return None,
    })
}

/// `routed`: the `avoid` connectors whose stored route is current (ADR-047 point 3); any other
/// `avoid` connector is written as a plain orthogonal edge that draw.io routes itself.
pub(super) fn write(
    shapes: &[S],
    board_id: &str,
    name: &str,
    routed: &HashSet<String>,
    out: &mut Out,
) -> String {
    let conts = containers(shapes);
    let ids: HashSet<&str> = shapes.iter().map(|s| s.id.as_str()).collect();
    let by_id: HashMap<&str, &S> = shapes.iter().map(|s| (s.id.as_str(), s)).collect();
    let is_vertex = |s: &S| {
        matches!(
            s.ty.as_str(),
            "rect" | "ellipse" | "diamond" | "text" | "sticky" | "image"
        )
    };
    let vertices: Vec<&S> = shapes.iter().filter(|s| is_vertex(s)).collect();

    // Board groups: members that share a container (or none) and have at least two kept members.
    let mut members: HashMap<(&str, Option<&str>), Vec<&S>> = HashMap::new();
    for s in &vertices {
        if let Some(g) = s.group() {
            members
                .entry((g, parent_of(s, &conts)))
                .or_default()
                .push(s);
        }
    }
    members.retain(|_, m| m.len() >= 2);
    let mut group_of: HashMap<&str, String> = HashMap::new();
    let mut groups: Vec<(String, Option<&str>, [f64; 4])> = Vec::new();
    let mut keys: Vec<_> = members.keys().copied().collect();
    keys.sort();
    for k in keys {
        let m = &members[&k];
        let cell = format!("ocgroup-{}-{}", k.0, k.1.unwrap_or("top"));
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for s in m {
            let b = s.bx();
            x0 = x0.min(b[0]);
            y0 = y0.min(b[1]);
            x1 = x1.max(b[0] + b[2]);
            y1 = y1.max(b[1] + b[3]);
            group_of.insert(s.id.as_str(), cell.clone());
        }
        out.note("groups", None);
        groups.push((cell, k.1, [x0, y0, x1 - x0, y1 - y0]));
    }

    // Absolute origin of each cell that can hold others.
    let mut abs: HashMap<String, [f64; 2]> = HashMap::new();
    for s in &vertices {
        let b = s.bx();
        abs.insert(s.id.clone(), [b[0], b[1]]);
    }
    for (cell, _, b) in &groups {
        abs.insert(cell.clone(), [b[0], b[1]]);
    }
    // The draw.io parent of a shape: its group cell, else its container, else the layer.
    let cell_parent = |s: &S| -> String {
        if let Some(g) = group_of.get(s.id.as_str()) {
            return g.clone();
        }
        parent_of(s, &conts).map_or("1".to_string(), str::to_string)
    };
    let group_parent: HashMap<&str, String> = groups
        .iter()
        .map(|(c, p, _)| (c.as_str(), p.map_or("1".to_string(), str::to_string)))
        .collect();
    // Depth for parents-first order (bounded: cycles stop at 64).
    let depth = |start: &str| -> usize {
        let mut d = 0;
        let mut cur = start.to_string();
        while d < 64 {
            let next = if let Some(p) = group_parent.get(cur.as_str()) {
                p.clone()
            } else if let Some(s) = by_id.get(cur.as_str()) {
                cell_parent(s)
            } else {
                break;
            };
            if next == "1" {
                break;
            }
            d += 1;
            cur = next;
        }
        d
    };

    let mut cells: Vec<(usize, usize, String)> = Vec::new();
    let rel = |parent: &str, x: f64, y: f64| -> (f64, f64) {
        match abs.get(parent) {
            Some(o) if parent != "1" => (x - o[0], y - o[1]),
            _ => (x, y),
        }
    };
    for (i, (cell, p, b)) in groups.iter().enumerate() {
        let parent = p.map_or("1".to_string(), str::to_string);
        let (x, y) = rel(&parent, b[0], b[1]);
        cells.push((
            depth(cell),
            i,
            format!(
                "<mxCell id=\"{}\" value=\"\" style=\"group;ocGroup=1;\" vertex=\"1\" connectable=\"0\" parent=\"{}\"><mxGeometry x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" as=\"geometry\"/></mxCell>",
                esc(cell),
                esc(&parent),
                n(x),
                n(y),
                n(b[2]),
                n(b[3])
            ),
        ));
    }
    let base = groups.len();
    for (i, s) in shapes.iter().enumerate() {
        match s.ty.as_str() {
            "pen" => {
                out.note("pen", None);
                continue;
            }
            "swatch" => {
                out.note("swatch", None);
                continue;
            }
            "arrow" => continue,
            _ if !is_vertex(s) => continue,
            _ => {}
        }
        let container = conts.contains(&s.id);
        let text = s.str("text");
        let label = s.str("label");
        let mut value = if text.is_empty() { label } else { text }.to_string();
        let mut style = String::new();
        if let Some(kind) = s.v["kind"].as_str() {
            out.note("kind", Some(format!("{} ({kind})", s.name())));
        }
        if container {
            out.note("containers", None);
            value = if label.is_empty() { text } else { label }.to_string();
            style.push_str("rounded=0;whiteSpace=wrap;html=1;container=1;dashed=1;fillColor=none;verticalAlign=top;align=left;spacingLeft=8;");
        } else {
            match s.ty.as_str() {
                "text" => {
                    let size = s.v["size"].as_f64().unwrap_or(14.0);
                    let _ = write!(
                        style,
                        "text;html=1;align=left;verticalAlign=top;whiteSpace=wrap;fontSize={};",
                        n(size)
                    );
                }
                "ellipse" => style.push_str("ellipse;whiteSpace=wrap;html=1;"),
                "diamond" => style.push_str("rhombus;whiteSpace=wrap;html=1;"),
                "sticky" => {
                    out.note("sticky", Some(s.name()));
                    let f = drawio_fill(sticky_tone(s.str("fill"))).unwrap_or("#fff2cc");
                    let _ = write!(
                        style,
                        "rounded=0;whiteSpace=wrap;html=1;fillColor={f};strokeColor=none;"
                    );
                }
                "image" => {
                    let src = s.str("src");
                    if src.len() > 5 && src[..5].eq_ignore_ascii_case("data:") {
                        // draw.io's form: no `;base64` (a `;` would end the style value).
                        let src = src.replacen(";base64,", ",", 1);
                        let _ = write!(
                            style,
                            "shape=image;html=1;imageAspect=0;aspect=fixed;image={src};"
                        );
                        value = s.str("alt").to_string();
                    } else {
                        out.note("image_stored", Some(s.str("alt").to_string()));
                        style.push_str("rounded=0;whiteSpace=wrap;html=1;dashed=1;");
                        value = if s.str("alt").is_empty() {
                            "Image".into()
                        } else {
                            s.str("alt").to_string()
                        };
                    }
                }
                _ => {
                    match s.v["props"]["shape"].as_str().filter(|v| {
                        v.chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
                    }) {
                        Some(shape) => {
                            let _ = write!(style, "shape={shape};whiteSpace=wrap;html=1;");
                        }
                        None => style.push_str("rounded=0;whiteSpace=wrap;html=1;"),
                    }
                    if s.v["dashed"] == true && s.v["fill"].is_null() {
                        style.push_str("dashed=1;fillColor=none;");
                    }
                }
            }
            if matches!(s.ty.as_str(), "rect" | "ellipse" | "diamond")
                && let Some(f) = drawio_fill(s.str("fill"))
            {
                let _ = write!(style, "fillColor={f};");
            }
            if s.ty != "text"
                && let Some(sz) = s.v["size"].as_f64()
            {
                let _ = write!(style, "fontSize={};", n(sz));
            }
        }
        let parent = cell_parent(s);
        let b = s.bx();
        let (x, y) = rel(&parent, b[0], b[1]);
        cells.push((
            depth(&s.id),
            base + i,
            format!(
                "<mxCell id=\"{}\" value=\"{}\" style=\"{}\" vertex=\"1\" parent=\"{}\"><mxGeometry x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" as=\"geometry\"/></mxCell>",
                esc(&s.id),
                esc(&html(&value)),
                esc(&style),
                esc(&parent),
                n(x),
                n(y),
                n(b[2]),
                n(b[3])
            ),
        ));
    }
    // Connectors last (draw.io paints edges over vertices by default too), absolute coordinates.
    let mut kept_shapes = 0;
    for s in &vertices {
        if !conts.contains(&s.id) {
            kept_shapes += 1;
        }
    }
    let mut edges = 0;
    let base = base + shapes.len();
    for (i, s) in shapes.iter().enumerate().filter(|(_, s)| s.ty == "arrow") {
        let pts = s.pts("pts");
        let src = s
            .end("start")
            .filter(|id| ids.contains(id) && by_id.get(id).is_some_and(|t| is_vertex(t)));
        let dst = s
            .end("end")
            .filter(|id| ids.contains(id) && by_id.get(id).is_some_and(|t| is_vertex(t)));
        let mut style = String::from("html=1;rounded=0;endArrow=classic;");
        if s.str("route") == "elbow" {
            style.insert_str(0, "edgeStyle=orthogonalEdgeStyle;");
        }
        for (which, end, pre) in [("start", src, "exit"), ("end", dst, "entry")] {
            if end.is_none() {
                continue;
            }
            if s.v[which]["port"].is_string() {
                out.note(
                    "ports",
                    Some(s.v[which]["port"].as_str().unwrap_or("").to_string()),
                );
            }
            if let Some((ax, ay)) = anchor_xy(s.v[which]["anchor"].as_str().unwrap_or("center")) {
                let _ = write!(style, "{pre}X={ax};{pre}Y={ay};{pre}Dx=0;{pre}Dy=0;");
            }
        }
        let mut via = s.pts("via");
        if via.is_empty() && s.str("routing") == "avoid" && routed.contains(&s.id) {
            out.note("avoid", None);
            via = pts[1..pts.len() - 1].to_vec();
        }
        let mut geo = String::new();
        if !via.is_empty() {
            geo.push_str("<Array as=\"points\">");
            for p in &via {
                let _ = write!(geo, "<mxPoint x=\"{}\" y=\"{}\"/>", n(p[0]), n(p[1]));
            }
            geo.push_str("</Array>");
        }
        if src.is_none()
            && let Some(p) = pts.first()
        {
            let _ = write!(
                geo,
                "<mxPoint x=\"{}\" y=\"{}\" as=\"sourcePoint\"/>",
                n(p[0]),
                n(p[1])
            );
        }
        if dst.is_none()
            && let Some(p) = pts.last()
        {
            let _ = write!(
                geo,
                "<mxPoint x=\"{}\" y=\"{}\" as=\"targetPoint\"/>",
                n(p[0]),
                n(p[1])
            );
        }
        let mut attrs = String::new();
        if let Some(a) = src {
            let _ = write!(attrs, " source=\"{}\"", esc(a));
        }
        if let Some(b) = dst {
            let _ = write!(attrs, " target=\"{}\"", esc(b));
        }
        edges += 1;
        cells.push((
            usize::MAX,
            base + i,
            format!(
                "<mxCell id=\"{}\" value=\"{}\" style=\"{}\" edge=\"1\" parent=\"1\"{attrs}><mxGeometry relative=\"1\" as=\"geometry\">{geo}</mxGeometry></mxCell>",
                esc(&s.id),
                esc(&html(s.str("text"))),
                esc(&style)
            ),
        ));
    }
    if kept_shapes + edges > 0 {
        out.set("kept", kept_shapes + edges);
    }
    cells.sort_by_key(|(d, i, _)| (*d, *i));
    let mut x = String::new();
    let _ = write!(
        x,
        "<mxfile host=\"OpenCanvas\" type=\"device\"><diagram id=\"{}\" name=\"{}\"><mxGraphModel grid=\"1\" gridSize=\"10\" guides=\"1\" tooltips=\"1\" connect=\"1\" arrows=\"1\" fold=\"1\" page=\"0\" pageScale=\"1\" math=\"0\" shadow=\"0\"><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>",
        esc(board_id),
        esc(name)
    );
    for (_, _, c) in cells {
        x.push_str(&c);
    }
    x.push_str("</root></mxGraphModel></diagram></mxfile>\n");
    x
}
