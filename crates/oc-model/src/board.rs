// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Board rendering: a standalone SVG fitted to the content in the light palette (a port of the
//! web `exportBoardSvg`, `web/packages/board/src/export.ts`, incl. bound and elbow arrows from
//! `connectors.ts`), and a PNG rendered from it with `resvg` and an embedded font.
//!
//! Input is the logical JSON from [`crate::doc_to_json`] (`boards/<id>/{shapes, order}`).

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine;
use resvg::{tiny_skia, usvg};
use serde_json::Value;

/// Fixed light palette, as in the web export.
mod p {
    pub const BG: &str = "#ffffff";
    pub const FG: &str = "#18181b";
    pub const FG2: &str = "#55555e";
    pub const FG3: &str = "#8b8b95";
    pub const APP: &str = "#ffffff";
    pub const ACCENT: &str = "#2a5ad7";
    pub const STICKY_FG: &str = "#29251a";
    pub const PANEL: &str = "#fbfbfa";
    /// `--line-2` (rgba(24,24,32,.15)) as a colour + opacity.
    pub const LINE2: &str = "#181820";
    pub const LINE2_OPACITY: &str = "0.15";

    /// rect / ellipse / diamond fills: `(--<tone>-bg, --<tone>-fg)`; the outline follows the tone.
    pub fn tone(fill: &str) -> Option<(&'static str, &'static str)> {
        Some(match fill {
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

    pub fn sticky(fill: &str) -> &'static str {
        match fill {
            "p" => "#fbd0de",
            "b" => "#cfe3fb",
            "g" => "#d3f0dd",
            _ => "#fdeaa0",
        }
    }

    pub fn swatch(fill: &str) -> &'static str {
        match fill {
            "amber" => "#8f5300",
            "green" => "#17703f",
            "pink" => "#ad2c66",
            "purple" => "#6538c4",
            "red" => "#b12424",
            "blue" => "#2350c8",
            _ => ACCENT,
        }
    }
}

const FONT: &str = "Geist, ui-sans-serif, -apple-system, 'Segoe UI', system-ui, sans-serif";
const PAD: f64 = 32.0;

/// Largest PNG side, as in the web export.
const MAX_SIDE: f32 = 16384.0;
/// Largest PNG area (keeps a huge board from allocating gigabytes).
const MAX_PIXELS: f32 = 64.0 * 1024.0 * 1024.0;

type Pt = [f64; 2];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Anchor {
    Top,
    Right,
    Bottom,
    Left,
    Center,
}

impl Anchor {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "top" => Self::Top,
            "right" => Self::Right,
            "bottom" => Self::Bottom,
            "left" => Self::Left,
            "center" => Self::Center,
            _ => return None,
        })
    }
    fn horiz(self) -> bool {
        matches!(self, Self::Left | Self::Right)
    }
}

#[derive(Debug, Clone)]
struct Binding {
    shape_id: String,
    anchor: Anchor,
    /// Named port (ADR-045); drawn at the port when the bound shape stores it (DGM-12).
    port: Option<String>,
}

/// A custom port stored on a shape (`ports`, as the web `readPorts` reads them).
#[derive(Debug, Clone)]
struct Port {
    id: String,
    side: Option<Anchor>,
    x: Option<f64>,
    y: Option<f64>,
}

#[derive(Debug, Clone, Default)]
struct Shape {
    id: String,
    kind: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    fill: Option<String>,
    text: String,
    label: String,
    dashed: bool,
    size: Option<f64>,
    pts: Vec<Pt>,
    stroke: String,
    /// `start` / `end` set at all (truthy in the web model), even if not a valid binding.
    has_start: bool,
    has_end: bool,
    start: Option<Binding>,
    end: Option<Binding>,
    route: String,
    /// `routing` (ADR-047): `avoid` marks an obstacle-avoiding elbow whose route is stored in `pts`.
    routing: String,
    /// `via` set at all (an empty list still counts, as in the web model).
    has_via: bool,
    /// Manual waypoints the connector passes through.
    via: Vec<Pt>,
    src: String,
    /// Custom ports (`ports`), read defensively like the web `readPorts`.
    ports: Vec<Port>,
    /// Built-in icon of an `icon:node` shape (DGM-17): `props.icon`, empty otherwise.
    icon: String,
    /// `props.labelPos` of an icon shape: `below` (default), `right` or `hidden`.
    label_pos: String,
    /// A Lucide icon's own path data (`props.paths`), kept only when it is plain path data.
    icon_paths: Vec<String>,
}

fn num(v: &Value) -> f64 {
    v.as_f64().filter(|f| f.is_finite()).unwrap_or(0.0)
}

fn string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn binding(v: &Value) -> Option<Binding> {
    Some(Binding {
        shape_id: v.get("shapeId")?.as_str()?.to_string(),
        anchor: Anchor::parse(v.get("anchor")?.as_str()?)?,
        port: v.get("port").and_then(Value::as_str).map(String::from),
    })
}

/// `ports.ts` `readPorts`: entries with a fresh string id (1..=64 UTF-16 units, not a legacy
/// anchor), `side` one of the four sides, `x`/`y` finite numbers clamped to 0..1.
fn read_ports(v: &Value) -> Vec<Port> {
    let mut out: Vec<Port> = Vec::new();
    for q in v.as_array().map(Vec::as_slice).unwrap_or_default() {
        let Some(id) = q.get("id").and_then(Value::as_str) else {
            continue;
        };
        let n = id.encode_utf16().count();
        if n == 0 || n > 64 || Anchor::parse(id).is_some() || out.iter().any(|p| p.id == id) {
            continue;
        }
        let side = q
            .get("side")
            .and_then(Value::as_str)
            .and_then(Anchor::parse)
            .filter(|a| *a != Anchor::Center);
        let frac = |k: &str| {
            q.get(k)
                .and_then(Value::as_f64)
                .filter(|f| f.is_finite())
                .map(|f| f.clamp(0.0, 1.0))
        };
        out.push(Port {
            id: id.to_string(),
            side,
            x: frac("x"),
            y: frac("y"),
        });
    }
    out
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `[[x, y], …]`: entries that are arrays of at least two items, non-numbers read as 0
/// (the web `viaOf` reads `via` the same way).
fn points(v: &Value) -> Vec<Pt> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|q| {
                    let q = q.as_array()?;
                    Some([num(q.first()?), num(q.get(1)?)])
                })
                .collect()
        })
        .unwrap_or_default()
}

fn shape(id: &str, v: &Value) -> Shape {
    let pts = points(&v["pts"]);
    Shape {
        id: id.to_string(),
        kind: string(&v["type"]),
        x: num(&v["x"]),
        y: num(&v["y"]),
        w: num(&v["w"]),
        h: num(&v["h"]),
        fill: v["fill"].as_str().map(String::from),
        text: string(&v["text"]),
        label: string(&v["label"]),
        dashed: truthy(&v["dashed"]),
        size: v["size"].as_f64().filter(|f| f.is_finite()),
        pts,
        stroke: string(&v["stroke"]),
        has_start: truthy(&v["start"]),
        has_end: truthy(&v["end"]),
        start: binding(&v["start"]),
        end: binding(&v["end"]),
        route: string(&v["route"]),
        routing: string(&v["routing"]),
        has_via: truthy(&v["via"]),
        via: points(&v["via"]),
        src: string(&v["src"]),
        ports: read_ports(&v["ports"]),
        icon: if v["kind"].as_str() == Some(ICON_KIND) {
            string(&v["props"]["icon"])
        } else {
            String::new()
        },
        label_pos: string(&v["props"]["labelPos"]),
        icon_paths: embedded_paths(&v["props"]["paths"]),
    }
}

/// Most paths an embedded icon may carry (as the web `MAX_PATHS`).
const MAX_ICON_PATHS: usize = 32;

/// `props.paths` of a Lucide icon shape: every entry plain path data, 1 to 32 of them; else none.
fn embedded_paths(v: &Value) -> Vec<String> {
    let Some(a) = v.as_array() else {
        return vec![];
    };
    if a.is_empty() || a.len() > MAX_ICON_PATHS {
        return vec![];
    }
    let out: Vec<String> = a
        .iter()
        .filter_map(|d| {
            d.as_str()
                .filter(|d| crate::icons::is_path_data(d))
                .map(String::from)
        })
        .collect();
    if out.len() == a.len() { out } else { vec![] }
}

/// The registry kind of an icon shape (DGM-17, `web/packages/board/src/icons.ts`).
const ICON_KIND: &str = "icon:node";
/// Icon labels: 13 px semibold, 17 px lines, below the box or 10 px to its right.
const ICON_LABEL_SIZE: f64 = 13.0;
const ICON_LABEL_LH: f64 = 17.0;
const ICON_LABEL_GAP: f64 = 10.0;

/// The path data an icon shape draws: an `icon:node` rect whose built-in icon this build has, or
/// a Lucide icon (`lucide:<name>`) with its own checked path data.
fn icon_paths(s: &Shape) -> Option<&[String]> {
    if s.kind != "rect" || s.icon.is_empty() {
        return None;
    }
    if let Some(i) = crate::icons::get(&s.icon) {
        return Some(i.paths.as_slice());
    }
    (s.icon.starts_with("lucide:") && !s.icon_paths.is_empty()).then_some(s.icon_paths.as_slice())
}

struct IconLabel {
    lines: Vec<String>,
    x: f64,
    y: f64,
    middle: bool,
    rect: [f64; 4],
}

/// Where an icon shape's label goes, as the web `iconLabelLayout`; None when hidden or empty.
fn icon_label(s: &Shape) -> Option<IconLabel> {
    if s.label_pos == "hidden" || js_trim(&s.text).is_empty() {
        return None;
    }
    let ls: Vec<String> = s.text.split('\n').map(String::from).collect();
    let n_lines = ls.len() as f64;
    let lw = ls.iter().map(|l| len16(l)).max().unwrap_or(0) as f64 * ICON_LABEL_SIZE * 0.56;
    let (x, y, w, h) = (s.x, s.y, s.w, s.h);
    if s.label_pos == "right" {
        let y0 = y + h / 2.0 + ICON_LABEL_SIZE * 0.36 - ((n_lines - 1.0) * ICON_LABEL_LH) / 2.0;
        return Some(IconLabel {
            lines: ls,
            x: x + w + ICON_LABEL_GAP,
            y: y0,
            middle: false,
            rect: [
                x + w,
                y + h / 2.0 - (n_lines * ICON_LABEL_LH) / 2.0,
                x + w + ICON_LABEL_GAP + lw,
                y + h / 2.0 + (n_lines * ICON_LABEL_LH) / 2.0,
            ],
        });
    }
    Some(IconLabel {
        lines: ls,
        x: x + w / 2.0,
        y: y + h + ICON_LABEL_LH,
        middle: true,
        rect: [
            x + w / 2.0 - lw / 2.0,
            y + h,
            x + w / 2.0 + lw / 2.0,
            y + h + 6.0 + n_lines * ICON_LABEL_LH,
        ],
    })
}

/// An icon shape: tinted tile, the glyph as inline paths (never `<image>`), the label outside.
fn icon_svg(s: &Shape, paths: &[String], bg: &str, line: &str) -> String {
    let size = s.w.min(s.h) * 0.5;
    let (gx, gy) = (s.x + (s.w - size) / 2.0, s.y + (s.h - size) / 2.0);
    let glyph: String = paths
        .iter()
        .map(|d| format!("<path d=\"{}\"/>", esc(d)))
        .collect();
    let label = icon_label(s)
        .map(|lb| {
            lines(
                &lb.lines,
                lb.x,
                lb.y,
                ICON_LABEL_LH,
                TextOpts {
                    anchor: lb.middle,
                    size: ICON_LABEL_SIZE,
                    weight: Some(600),
                    fill: p::FG,
                },
            )
        })
        .unwrap_or_default();
    format!(
        "<g><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"12\" fill=\"{bg}\"/><g transform=\"translate({} {}) scale({})\" fill=\"none\" stroke=\"{line}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">{glyph}</g>{label}</g>",
        n(s.x),
        n(s.y),
        n(s.w),
        n(s.h),
        n(gx),
        n(gy),
        n(size / 24.0)
    )
}

/// Shapes in paint order: `order` first, then any other shape by id (as the web `readShapes`).
fn read_shapes(doc: &Value, board_id: &str) -> Vec<Shape> {
    let board = &doc["boards"][board_id];
    let Some(shapes) = board["shapes"].as_object() else {
        return vec![];
    };
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push = |sid: &str| {
        if seen.contains(sid) {
            return;
        }
        if let Some(v) = shapes.get(sid).filter(|v| v.is_object()) {
            seen.insert(sid.to_string());
            out.push(shape(sid, v));
        }
    };
    if let Some(order) = board["order"].as_array() {
        for sid in order {
            push(&string(sid));
        }
    }
    let mut rest: Vec<&String> = shapes.keys().collect();
    rest.sort();
    for sid in rest {
        push(sid);
    }
    out
}

// ---------------------------------------------------------------- geometry (model.ts)

fn bbox(s: &Shape) -> [f64; 4] {
    if !s.pts.is_empty() {
        let (mut a, mut b, mut c, mut d) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        for q in &s.pts {
            a = a.min(q[0]);
            b = b.min(q[1]);
            c = c.max(q[0]);
            d = d.max(q[1]);
        }
        return [a, b, c, d];
    }
    if s.kind == "text" {
        let size = s.size.filter(|v| *v != 0.0).unwrap_or(18.0);
        let lines: Vec<&str> = s.text.split('\n').collect();
        let longest = lines
            .iter()
            .map(|l| l.encode_utf16().count())
            .max()
            .unwrap_or(0)
            .max(1);
        let w = longest as f64 * size * 0.56;
        return [
            s.x,
            s.y - size,
            s.x + w,
            s.y + 5.0 + (lines.len() as f64 - 1.0) * size * 1.3,
        ];
    }
    [s.x, s.y, s.x + s.w, s.y + s.h]
}

fn content_bounds(shapes: &[Shape]) -> Option<[f64; 4]> {
    if shapes.is_empty() {
        return None;
    }
    let mut r = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for s in shapes {
        let b = bbox(s);
        r = [
            r[0].min(b[0]),
            r[1].min(b[1]),
            r[2].max(b[2]),
            r[3].max(b[3]),
        ];
    }
    Some(r)
}

/// JavaScript `Number.prototype.toFixed` (half away from zero on the binary value).
fn fixed(v: f64, digits: i32) -> String {
    let m = 10f64.powi(digits);
    let r = (v * m).round() / m;
    let r = if r == 0.0 { 0.0 } else { r };
    format!("{r:.prec$}", prec = digits as usize)
}

fn smooth(p: &[Pt]) -> String {
    let f = |v: f64| fixed(v, 1);
    match p.len() {
        0 => String::new(),
        1 | 2 => format!(
            "M{}",
            p.iter()
                .map(|q| format!("{} {}", f(q[0]), f(q[1])))
                .collect::<Vec<_>>()
                .join(" L")
        ),
        n => {
            let mut d = format!("M{} {}", f(p[0][0]), f(p[0][1]));
            for i in 1..n - 1 {
                let (mx, my) = ((p[i][0] + p[i + 1][0]) / 2.0, (p[i][1] + p[i + 1][1]) / 2.0);
                d.push_str(&format!(
                    " Q{} {} {} {}",
                    f(p[i][0]),
                    f(p[i][1]),
                    f(mx),
                    f(my)
                ));
            }
            let l = p[n - 1];
            d.push_str(&format!(" L{} {}", f(l[0]), f(l[1])));
            d
        }
    }
}

// ---------------------------------------------------------------- connectors.ts

fn anchor_point(s: &Shape, a: Anchor) -> Pt {
    let [x0, y0, x1, y1] = bbox(s);
    let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
    match a {
        Anchor::Top => [cx, y0],
        Anchor::Bottom => [cx, y1],
        Anchor::Left => [x0, cy],
        Anchor::Right => [x1, cy],
        Anchor::Center => [cx, cy],
    }
}

fn boundary_toward(s: &Shape, to: Pt) -> Pt {
    let [x0, y0, x1, y1] = bbox(s);
    let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
    let (hw, hh) = (((x1 - x0) / 2.0).max(1.0), ((y1 - y0) / 2.0).max(1.0));
    let (dx, dy) = (to[0] - cx, to[1] - cy);
    if dx == 0.0 && dy == 0.0 {
        return [cx, cy];
    }
    let t = match s.kind.as_str() {
        "ellipse" => 1.0 / ((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh)).sqrt(),
        "diamond" => 1.0 / (dx.abs() / hw + dy.abs() / hh),
        _ => {
            let tx = if dx != 0.0 {
                hw / dx.abs()
            } else {
                f64::INFINITY
            };
            let ty = if dy != 0.0 {
                hh / dy.abs()
            } else {
                f64::INFINITY
            };
            tx.min(ty)
        }
    }
    .min(1.0);
    [cx + dx * t, cy + dy * t]
}

/// `ports.ts` `portEnd`: where an end bound to a port the shape stores attaches, and the side it
/// leaves from (the port's, else the nearest edge; ties top, right, bottom, left). `None` for no
/// port, a legacy id or a port the shape doesn't store: the end is drawn at `anchor`.
fn port_end(s: &Shape, b: &Binding) -> Option<(Pt, Anchor)> {
    let id = b.port.as_deref().filter(|p| !p.is_empty())?;
    if Anchor::parse(id).is_some() {
        return None;
    }
    let port = s.ports.iter().find(|p| p.id == id)?;
    let [x0, y0, x1, y1] = bbox(s);
    let p = [
        x0 + (x1 - x0) * port.x.unwrap_or(0.5),
        y0 + (y1 - y0) * port.y.unwrap_or(0.5),
    ];
    let side = port.side.unwrap_or_else(|| {
        let dist = [
            (Anchor::Top, p[1] - y0),
            (Anchor::Right, x1 - p[0]),
            (Anchor::Bottom, y1 - p[1]),
            (Anchor::Left, p[0] - x0),
        ];
        let mut best = dist[0];
        for d in dist {
            if d.1 < best.1 {
                best = d;
            }
        }
        best.0
    });
    Some((p, side))
}

fn facing(s: &Shape, other: Pt) -> Anchor {
    let [x0, y0, x1, y1] = bbox(s);
    let (dx, dy) = (other[0] - (x0 + x1) / 2.0, other[1] - (y0 + y1) / 2.0);
    if dx.abs() >= dy.abs() {
        if dx >= 0.0 {
            Anchor::Right
        } else {
            Anchor::Left
        }
    } else if dy >= 0.0 {
        Anchor::Bottom
    } else {
        Anchor::Top
    }
}

fn elbow(a: Pt, b: Pt, sa: Option<Anchor>, sb: Option<Anchor>) -> Vec<Pt> {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let h_a = match sa {
        Some(x) if x != Anchor::Center => x.horiz(),
        _ => dx.abs() >= dy.abs(),
    };
    let h_b = match sb {
        Some(x) if x != Anchor::Center => x.horiz(),
        _ => h_a,
    };
    let out: Vec<Pt> = if h_a && h_b {
        let mx = (a[0] + b[0]) / 2.0;
        vec![a, [mx, a[1]], [mx, b[1]], b]
    } else if !h_a && !h_b {
        let my = (a[1] + b[1]) / 2.0;
        vec![a, [a[0], my], [b[0], my], b]
    } else if h_a {
        vec![a, [b[0], a[1]], b]
    } else {
        vec![a, [a[0], b[1]], b]
    };
    tidy(&out)
}

fn eq(u: f64, v: f64) -> bool {
    (u - v).abs() < 0.01
}

/// Orthogonal route through ends and waypoints (`connectors.ts` `elbowVia`): each leg is an L,
/// leaving at a right angle to how the previous leg arrived; the last enters along the end
/// side's axis, with two corners at the midpoint when an L can't.
fn elbow_via(pts: &[Pt], sa: Option<Anchor>, sb: Option<Anchor>) -> Vec<Pt> {
    if pts.len() < 2 {
        return pts.to_vec();
    }
    let n = pts.len();
    let mut h = match sa {
        Some(x) if x != Anchor::Center => x.horiz(),
        _ => (pts[1][0] - pts[0][0]).abs() >= (pts[1][1] - pts[0][1]).abs(),
    };
    let mut out: Vec<Pt> = vec![pts[0]];
    for i in 0..n - 1 {
        let (p, q) = (pts[i], pts[i + 1]);
        if let Some(side) = sb
            && i == n - 2
            && side != Anchor::Center
            && h == side.horiz()
        {
            if h {
                let mx = (p[0] + q[0]) / 2.0;
                out.extend([[mx, p[1]], [mx, q[1]], q]);
            } else {
                let my = (p[1] + q[1]) / 2.0;
                out.extend([[p[0], my], [q[0], my], q]);
            }
            break;
        }
        out.push(if h { [q[0], p[1]] } else { [p[0], q[1]] });
        out.push(q);
        h = if h { !eq(q[1], p[1]) } else { eq(q[0], p[0]) };
    }
    tidy(&out)
}

/// Drop repeated points, then middle points on a straight run.
fn tidy(out: &[Pt]) -> Vec<Pt> {
    let dedup: Vec<Pt> = out
        .iter()
        .enumerate()
        .filter(|(i, p)| *i == 0 || !eq(p[0], out[i - 1][0]) || !eq(p[1], out[i - 1][1]))
        .map(|(_, p)| *p)
        .collect();
    dedup
        .iter()
        .enumerate()
        .filter(|(i, p)| {
            if *i == 0 || *i == dedup.len() - 1 {
                return true;
            }
            let (u, w) = (dedup[i - 1], dedup[i + 1]);
            !((eq(u[0], p[0]) && eq(p[0], w[0])) || (eq(u[1], p[1]) && eq(p[1], w[1])))
        })
        .map(|(_, p)| *p)
        .collect()
}

/// `Math.round(v * 10) / 10`.
fn r1(p: Pt) -> Pt {
    [js_round(p[0] * 10.0) / 10.0, js_round(p[1] * 10.0) / 10.0]
}

/// JavaScript `Math.round` (halves round up).
fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// ADR-047 point 3 (web `storedRoute`): an `avoid` connector (`route: "elbow"` +
/// `routing: "avoid"`) draws its stored route while `pts` still starts at `a`, ends at `b` (where
/// its plain elbow would) and every leg is axis-aligned; otherwise `None`, the plain elbow.
fn stored_route(s: &Shape, a: Pt, b: Pt) -> Option<Vec<Pt>> {
    if s.route != "elbow" || s.routing != "avoid" || s.pts.len() < 2 {
        return None;
    }
    let p = &s.pts;
    if p[0] != a || p[p.len() - 1] != b {
        return None;
    }
    if p.windows(2)
        .any(|w| w[0][0] != w[1][0] && w[0][1] != w[1][1])
    {
        return None;
    }
    Some(p.clone())
}

/// Resolved connector points as the exporters draw them (web `exportResolvedArrows`).
fn resolve_arrow(s: &Shape, by_id: &HashMap<&str, &Shape>) -> Vec<Pt> {
    let pts = &s.pts;
    if pts.len() < 2 && !(s.has_start && s.has_end) {
        return pts.clone();
    }
    let bs = s
        .start
        .as_ref()
        .and_then(|b| by_id.get(b.shape_id.as_str()).copied());
    let be = s
        .end
        .as_ref()
        .and_then(|b| by_id.get(b.shape_id.as_str()).copied());
    let via = &s.via;
    if bs.is_none() && be.is_none() && s.route.is_empty() && via.is_empty() {
        return pts.clone();
    }
    let mut a: Pt = pts.first().copied().unwrap_or([0.0, 0.0]);
    let mut b: Pt = pts.last().copied().unwrap_or(a);
    let mut aa = bs.and(s.start.as_ref().map(|x| x.anchor));
    let mut ab = be.and(s.end.as_ref().map(|x| x.anchor));
    // A stored custom port (DGM-12): its point, leaving from its side, like a side anchor.
    let pa = bs.zip(s.start.as_ref()).and_then(|(sh, x)| port_end(sh, x));
    let pb = be.zip(s.end.as_ref()).and_then(|(sh, x)| port_end(sh, x));
    if let Some((p, side)) = pa {
        a = p;
        aa = Some(side);
    } else if let (Some(sh), Some(an)) = (bs, aa)
        && an != Anchor::Center
    {
        a = anchor_point(sh, an);
    }
    if let Some((p, side)) = pb {
        b = p;
        ab = Some(side);
    } else if let (Some(sh), Some(an)) = (be, ab)
        && an != Anchor::Center
    {
        b = anchor_point(sh, an);
    }
    let raw_a = match (bs, aa) {
        (Some(sh), Some(Anchor::Center)) => anchor_point(sh, Anchor::Center),
        _ => a,
    };
    let raw_b = match (be, ab) {
        (Some(sh), Some(Anchor::Center)) => anchor_point(sh, Anchor::Center),
        _ => b,
    };
    if let (Some(&fa), Some(&fb)) = (via.first(), via.last()) {
        // Centre-bound ends aim at the nearest waypoint instead of the other end.
        if s.route == "elbow" {
            if let (Some(sh), Some(Anchor::Center)) = (bs, aa) {
                let f = facing(sh, fa);
                aa = Some(f);
                a = anchor_point(sh, f);
            }
            if let (Some(sh), Some(Anchor::Center)) = (be, ab) {
                let f = facing(sh, fb);
                ab = Some(f);
                b = anchor_point(sh, f);
            }
            let mut ctl = vec![r1(a)];
            ctl.extend(via.iter().map(|&p| r1(p)));
            ctl.push(r1(b));
            return elbow_via(&ctl, aa, ab);
        }
        if let (Some(sh), Some(Anchor::Center)) = (bs, aa) {
            a = boundary_toward(sh, fa);
        }
        if let (Some(sh), Some(Anchor::Center)) = (be, ab) {
            b = boundary_toward(sh, fb);
        }
        let mut out = vec![r1(a)];
        out.extend(via.iter().map(|&p| r1(p)));
        out.push(r1(b));
        return out;
    }
    if s.route == "elbow" {
        if let (Some(sh), Some(Anchor::Center)) = (bs, aa) {
            let f = facing(sh, raw_b);
            aa = Some(f);
            a = anchor_point(sh, f);
        }
        if let (Some(sh), Some(Anchor::Center)) = (be, ab) {
            let f = facing(sh, a);
            ab = Some(f);
            b = anchor_point(sh, f);
        }
        let (ra, rb) = (r1(a), r1(b));
        if let Some(p) = stored_route(s, ra, rb) {
            return p;
        }
        return elbow(ra, rb, aa, ab);
    }
    if let (Some(sh), Some(Anchor::Center)) = (bs, aa) {
        a = boundary_toward(sh, raw_b);
    }
    if let (Some(sh), Some(Anchor::Center)) = (be, ab) {
        b = boundary_toward(sh, raw_a);
    }
    vec![r1(a), r1(b)]
}

fn with_resolved_arrows(shapes: &[Shape]) -> Vec<Shape> {
    let by_id: HashMap<&str, &Shape> = shapes.iter().map(|s| (s.id.as_str(), s)).collect();
    shapes
        .iter()
        .map(|s| {
            if s.kind == "arrow" && (s.has_start || s.has_end || !s.route.is_empty() || s.has_via) {
                Shape {
                    pts: resolve_arrow(s, &by_id),
                    ..s.clone()
                }
            } else {
                s.clone()
            }
        })
        .collect()
}

/// Ids of the `avoid` connectors the exporters draw with their stored route (ADR-047 point 3,
/// [`stored_route`]); the draw.io export writes bends only for these.
pub(crate) fn current_routes(doc: &Value, board_id: &str) -> std::collections::HashSet<String> {
    let raw = read_shapes(doc, board_id);
    let drawn = prepared(raw.clone());
    raw.into_iter()
        .zip(drawn)
        .filter(|(s, _)| s.kind == "arrow" && s.routing == "avoid" && s.route == "elbow")
        .filter(|(s, d)| s.via.is_empty() && s.pts.len() > 2 && s.pts == d.pts)
        .map(|(s, _)| s.id)
        .collect()
}

/// Every connector's resolved points, in paint order (the web `exportResolvedArrows` for
/// arrows): the parity check between the two resolvers (`tests/fixtures/board-ports.resolved.json`,
/// `board-avoid.resolved.json`).
pub fn resolved_points(doc: &Value, board_id: &str) -> Vec<(String, Vec<[f64; 2]>)> {
    with_resolved_arrows(&read_shapes(doc, board_id))
        .into_iter()
        .filter(|s| s.kind == "arrow")
        .map(|s| (s.id, s.pts))
        .collect()
}

// ---------------------------------------------------------------- ops.ts (wrapping)

/// JavaScript `\s` / `String.prototype.trim` whitespace (all in the BMP).
fn js_space(u: u16) -> bool {
    matches!(
        u,
        0x09..=0x0D
            | 0x20
            | 0xA0
            | 0x1680
            | 0x2000..=0x200A
            | 0x2028
            | 0x2029
            | 0x202F
            | 0x205F
            | 0x3000
            | 0xFEFF
    )
}

fn trim_start16(s: &[u16]) -> &[u16] {
    let i = s.iter().position(|u| !js_space(*u)).unwrap_or(s.len());
    &s[i..]
}

fn trim_end16(s: &[u16]) -> &[u16] {
    let i = s.iter().rposition(|u| !js_space(*u)).map_or(0, |i| i + 1);
    &s[..i]
}

/// JavaScript `String.prototype.trim`.
fn js_trim(s: &str) -> String {
    let u: Vec<u16> = s.encode_utf16().collect();
    String::from_utf16_lossy(trim_end16(trim_start16(&u)))
}

/// Length in UTF-16 code units (JavaScript `length`).
fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Port of `ops.wrapText`: greedy word wrap to `max` px, every UTF-16 unit `size * 0.56` wide,
/// long words broken, explicit line breaks kept. Works on UTF-16 like the web code; a surrogate
/// pair split by a long-word break becomes U+FFFD on both sides.
fn wrap_text(text: &str, max: f64, size: f64) -> Vec<String> {
    let q = (max / (size * 0.56)).floor();
    // `Math.max(1, NaN)` is NaN in JavaScript.
    let per = if q.is_nan() { q } else { q.max(1.0) };
    let fits = |len: usize| len as f64 <= per;
    let mut out = Vec::new();
    for para in text.split('\n') {
        let u: Vec<u16> = para.encode_utf16().collect();
        if fits(u.len()) {
            out.push(para.to_string());
            continue;
        }
        // `para.split(/(\s+)/)` without the empty strings: alternating runs.
        let mut words: Vec<&[u16]> = Vec::new();
        let mut i = 0;
        while i < u.len() {
            let sp = js_space(u[i]);
            let mut j = i + 1;
            while j < u.len() && js_space(u[j]) == sp {
                j += 1;
            }
            words.push(&u[i..j]);
            i = j;
        }
        let mut line: Vec<u16> = Vec::new();
        for word in words {
            if fits(line.len() + word.len()) {
                line.extend_from_slice(word);
                continue;
            }
            if !trim_start16(&line).is_empty() {
                out.push(String::from_utf16_lossy(trim_end16(&line)));
            }
            line = trim_start16(word).to_vec();
            while line.len() as f64 > per {
                let k = per as usize;
                out.push(String::from_utf16_lossy(&line[..k]));
                line.drain(..k);
            }
        }
        out.push(String::from_utf16_lossy(&line));
    }
    out
}

/// Sticky geometry (`ops.STICKY_TEXT`): 14 px text, 20 px lines, first baseline 30 px down,
/// 14 px side padding, 22 px below the last line.
mod sticky_text {
    pub const SIZE: f64 = 14.0;
    pub const LH: f64 = 20.0;
    pub const TOP: f64 = 30.0;
    pub const PAD: f64 = 14.0;
    pub const BOTTOM: f64 = 22.0;
}

/// `ops.stickyHeight`: height a sticky of width `w` needs for `text` (never less than `min`).
fn sticky_height(text: &str, w: f64, min: f64) -> f64 {
    use sticky_text::*;
    let lines = wrap_text(text, w - PAD * 2.0, SIZE).len() as f64;
    min.max((TOP + (lines - 1.0) * LH + BOTTOM).ceil())
}

// ---------------------------------------------------------------- export.ts

/// Connector labels: 12.5 px text wrapped to 180 px, 16 px lines, in a pill.
const LABEL_SIZE: f64 = 12.5;
const LABEL_WRAP: f64 = 180.0;
const LABEL_LH: f64 = 16.0;

fn esc(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    for c in t.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // Not allowed in XML 1.0; a stray one would make the whole SVG unreadable.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            '\u{fffe}' | '\u{ffff}' => {}
            c => out.push(c),
        }
    }
    out
}

/// `Math.round(v * 100) / 100` printed like JavaScript.
fn n(v: f64) -> String {
    let r = js_round(v * 100.0) / 100.0;
    if r == 0.0 { "0".into() } else { format!("{r}") }
}

struct TextOpts<'a> {
    anchor: bool,
    size: f64,
    weight: Option<u32>,
    fill: &'a str,
}

fn lines(ls: &[String], x: f64, y: f64, lh: f64, o: TextOpts) -> String {
    ls.iter()
        .enumerate()
        .map(|(i, l)| {
            format!(
                "<text x=\"{}\" y=\"{}\" font-size=\"{}\"{}{} fill=\"{}\">{}</text>",
                n(x),
                n(y + i as f64 * lh),
                n(o.size),
                o.weight
                    .map(|w| format!(" font-weight=\"{w}\""))
                    .unwrap_or_default(),
                if o.anchor {
                    " text-anchor=\"middle\""
                } else {
                    ""
                },
                o.fill,
                esc(l)
            )
        })
        .collect()
}

/// Text of a rect / ellipse / diamond, wrapped and centred as on screen.
fn box_text(s: &Shape, cx: f64, size: f64, lh: f64, wrap: f64, weight: Option<u32>) -> String {
    let ls = wrap_text(&s.text, wrap, size);
    let y = s.y + s.h / 2.0 + size * 0.36 - ((ls.len() as f64 - 1.0) * lh) / 2.0;
    lines(
        &ls,
        cx,
        y,
        lh,
        TextOpts {
            anchor: true,
            size,
            weight,
            fill: p::FG,
        },
    )
}

/// Point halfway along a polyline (as `midPoint` in export.ts).
fn mid_point(pts: &[Pt]) -> Pt {
    let seg: Vec<f64> = pts
        .windows(2)
        .map(|w| {
            let (dx, dy) = (w[1][0] - w[0][0], w[1][1] - w[0][1]);
            (dx * dx + dy * dy).sqrt()
        })
        .collect();
    let mut half = seg.iter().fold(0.0, |a, b| a + b) / 2.0;
    for (i, &len) in seg.iter().enumerate() {
        if half <= len || i == seg.len() - 1 {
            let t = if len != 0.0 {
                (half / len).min(1.0)
            } else {
                0.0
            };
            return [
                pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
                pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t,
            ];
        }
        half -= len;
    }
    pts[0]
}

struct Label {
    lines: Vec<String>,
    mx: f64,
    rect: [f64; 4],
}

/// A connector's label: wrapped lines, midpoint and pill box, or `None` without a label.
fn label_box(s: &Shape) -> Option<Label> {
    if s.kind != "arrow" || s.pts.len() < 2 {
        return None;
    }
    let label = js_trim(&s.text);
    if label.is_empty() {
        return None;
    }
    let [mx, my] = mid_point(&s.pts);
    let ls = wrap_text(&label, LABEL_WRAP, LABEL_SIZE);
    let longest = ls.iter().map(|l| len16(l)).max().unwrap_or(0);
    let lw = longest as f64 * LABEL_SIZE * 0.56 + 14.0;
    let bh = ls.len() as f64 * LABEL_LH + 6.0;
    Some(Label {
        lines: ls,
        mx,
        rect: [mx - lw / 2.0, my - bh / 2.0, mx + lw / 2.0, my + bh / 2.0],
    })
}

/// `src` values an exported `<image href>` may carry: web URLs, host-relative paths and
/// inline raster images. Anything else (e.g. `javascript:`) is left out.
fn safe_href(src: &str) -> bool {
    let l = src.trim_start().to_ascii_lowercase();
    l.starts_with("http://")
        || l.starts_with("https://")
        || (l.starts_with('/') && !l.starts_with("//"))
        || ["png", "jpeg", "jpg", "gif", "webp"]
            .iter()
            .any(|t| l.starts_with(&format!("data:image/{t};base64,")))
}

struct Ids {
    prefix: String,
    clip: u32,
}

fn shape_svg(
    s: &Shape,
    ids: &mut Ids,
    images: &HashMap<String, Vec<u8>>,
    inline_only: bool,
) -> String {
    let (x, y, w, h) = (s.x, s.y, s.w, s.h);
    let text = s.text.as_str();
    let stroke = if s.stroke == "accent" {
        p::ACCENT
    } else {
        p::FG2
    };
    let tone = s.fill.as_deref().and_then(p::tone);
    let (bg, line) = tone.unwrap_or((p::APP, stroke));
    match s.kind.as_str() {
        "sticky" => {
            use sticky_text::*;
            format!(
                "<g><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"6\" fill=\"#000\" opacity=\"0.07\"/><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"6\" fill=\"{}\"/>{}</g>",
                n(x + 1.0),
                n(y + 4.0),
                n(w),
                n(h),
                n(x),
                n(y),
                n(w),
                n(h),
                p::sticky(s.fill.as_deref().unwrap_or("y")),
                lines(
                    &wrap_text(text, w - PAD * 2.0, SIZE),
                    x + PAD,
                    y + TOP,
                    LH,
                    TextOpts {
                        anchor: false,
                        size: SIZE,
                        weight: None,
                        fill: p::STICKY_FG,
                    }
                )
            )
        }
        "rect" if icon_paths(s).is_some() => {
            icon_svg(s, icon_paths(s).unwrap_or_default(), bg, line)
        }
        "rect" => {
            let size = s.size.unwrap_or(14.0);
            let label = if s.label.is_empty() {
                String::new()
            } else {
                format!(
                    "<text x=\"{}\" y=\"{}\" font-size=\"11.5\" font-weight=\"600\" fill=\"{}\" letter-spacing=\".6\">{}</text>",
                    n(x + 14.0),
                    n(y + 24.0),
                    p::FG3,
                    esc(&s.label.to_uppercase())
                )
            };
            let body = if text.is_empty() {
                String::new()
            } else {
                box_text(
                    s,
                    x + w / 2.0,
                    size,
                    js_round(size * 1.3),
                    (w - 16.0).max(20.0),
                    None,
                )
            };
            format!(
                "<g><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"12\" fill=\"{}\" stroke=\"{}\" stroke-width=\"1.5\"{}/>{label}{body}</g>",
                n(x),
                n(y),
                n(w),
                n(h),
                if s.dashed { "none" } else { bg },
                if s.dashed { p::FG3 } else { line },
                if s.dashed {
                    " stroke-dasharray=\"6 5\""
                } else {
                    ""
                },
            )
        }
        "ellipse" => {
            let size = s.size.unwrap_or(15.0);
            format!(
                "<g><ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\" fill=\"{bg}\" stroke=\"{line}\" stroke-width=\"1.5\"/>{}</g>",
                n(x + w / 2.0),
                n(y + h / 2.0),
                n(w / 2.0),
                n(h / 2.0),
                if text.is_empty() {
                    String::new()
                } else {
                    box_text(
                        s,
                        x + w / 2.0,
                        size,
                        js_round(size * 1.27),
                        (w * 0.72).max(20.0),
                        Some(600),
                    )
                }
            )
        }
        "diamond" => {
            let (cx, cy) = (x + w / 2.0, y + h / 2.0);
            let size = s.size.unwrap_or(14.0);
            format!(
                "<g><path d=\"M{} {} L{} {} L{} {} L{} {} Z\" fill=\"{bg}\" stroke=\"{line}\" stroke-width=\"1.5\" stroke-linejoin=\"round\"/>{}</g>",
                n(cx),
                n(y),
                n(x + w),
                n(cy),
                n(cx),
                n(y + h),
                n(x),
                n(cy),
                if text.is_empty() {
                    String::new()
                } else {
                    box_text(s, cx, size, js_round(size * 1.3), (w * 0.6).max(20.0), None)
                }
            )
        }
        "swatch" => format!(
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"12\" fill=\"{}\" opacity=\"0.85\"/>",
            n(x),
            n(y),
            n(w),
            n(h),
            p::swatch(s.fill.as_deref().unwrap_or("accent"))
        ),
        "text" => {
            let size = s.size.filter(|v| *v != 0.0).unwrap_or(18.0);
            let ls: Vec<String> = text.split('\n').map(String::from).collect();
            lines(
                &ls,
                x,
                y,
                size * 1.3,
                TextOpts {
                    anchor: false,
                    size,
                    weight: Some(600),
                    fill: p::FG,
                },
            )
        }
        "image" => {
            let href = match images
                .get(&s.src)
                .and_then(|b| sniff_image(b).map(|m| (m, b)))
            {
                Some((mime, bytes)) => format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                ),
                None if safe_href(&s.src) && (!inline_only || s.src.starts_with("data:")) => {
                    s.src.clone()
                }
                None => return String::new(),
            };
            ids.clip += 1;
            let id = format!("{}clip-{}", ids.prefix, ids.clip);
            format!(
                "<g><clipPath id=\"{id}\"><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"8\"/></clipPath><image href=\"{}\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" preserveAspectRatio=\"xMidYMid slice\" clip-path=\"url(#{id})\"/></g>",
                n(x),
                n(y),
                n(w),
                n(h),
                esc(&href),
                n(x),
                n(y),
                n(w),
                n(h)
            )
        }
        "arrow" => {
            if s.pts.len() < 2 {
                return String::new();
            }
            let path = format!(
                "<path d=\"M{}\" stroke=\"{}\" stroke-width=\"1.6\" fill=\"none\" stroke-linejoin=\"round\" stroke-linecap=\"round\" marker-end=\"url(#{}ah)\"/>",
                s.pts
                    .iter()
                    .map(|q| format!("{} {}", n(q[0]), n(q[1])))
                    .collect::<Vec<_>>()
                    .join(" L"),
                p::FG2,
                ids.prefix
            );
            let Some(lb) = label_box(s) else {
                return path;
            };
            let [bx0, by0, bx1, by1] = lb.rect;
            let texts: String = lb
                .lines
                .iter()
                .enumerate()
                .map(|(i, l)| {
                    format!(
                        "<text x=\"{}\" y=\"{}\" font-size=\"{}\" font-weight=\"500\" text-anchor=\"middle\" fill=\"{}\">{}</text>",
                        n(lb.mx),
                        n(by0 + 3.0 + LABEL_LH * (i as f64 + 1.0) - 4.0),
                        n(LABEL_SIZE),
                        p::FG2,
                        esc(l)
                    )
                })
                .collect();
            format!(
                "<g>{path}<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"6\" fill=\"{}\" stroke=\"{}\" stroke-opacity=\"{}\"/>{texts}</g>",
                n(bx0),
                n(by0),
                n(bx1 - bx0),
                n(by1 - by0),
                p::PANEL,
                p::LINE2,
                p::LINE2_OPACITY
            )
        }
        "pen" => {
            if s.pts.is_empty() {
                return String::new();
            }
            format!(
                "<path d=\"{}\" stroke=\"{stroke}\" stroke-width=\"3\" fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
                smooth(&s.pts)
            )
        }
        // A type this build doesn't know (a newer client, a missing plugin; ADR-045): a shape
        // with a box and no points draws as a rect with its text and label, as the web exporter
        // does, so its content is not silently left out. Anything else draws nothing.
        _ if s.pts.is_empty() && s.w > 0.0 && s.h > 0.0 => {
            let mut r = s.clone();
            r.kind = "rect".into();
            shape_svg(&r, ids, images, inline_only)
        }
        _ => String::new(),
    }
}

/// Mime type of PNG / JPEG / GIF / WebP bytes.
pub fn sniff_image(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Id prefix for one board's `<defs>`, so several boards can sit inline in one HTML page.
fn id_prefix(board_id: &str) -> String {
    let safe: String = board_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("ocbd-{safe}-")
}

/// Shapes as drawn: stickies grown to fit their text (as the editor does on commit), then
/// connectors resolved against them.
fn prepared(shapes: Vec<Shape>) -> Vec<Shape> {
    let grown: Vec<Shape> = shapes
        .into_iter()
        .map(|mut s| {
            if s.kind == "sticky" {
                let need = sticky_height(&s.text, s.w, s.h);
                if need > s.h {
                    s.h = need;
                }
            }
            s
        })
        .collect();
    with_resolved_arrows(&grown)
}

/// Picture size in board units: `[x0, y0, x1, y1]` (content bounds incl. connector labels +
/// padding, or 320×200).
fn export_bounds(resolved: &[Shape]) -> [f64; 4] {
    let Some(mut b) = content_bounds(resolved) else {
        return [0.0, 0.0, 320.0, 200.0];
    };
    let boxes = resolved.iter().filter_map(|s| {
        label_box(s)
            .map(|lb| lb.rect)
            .or_else(|| icon_paths(s).and_then(|_| icon_label(s)).map(|lb| lb.rect))
    });
    for r in boxes {
        b = [
            b[0].min(r[0]),
            b[1].min(r[1]),
            b[2].max(r[2]),
            b[3].max(r[3]),
        ];
    }
    [b[0] - PAD, b[1] - PAD, b[2] + PAD, b[3] + PAD]
}

/// Renders a board as a standalone SVG document, fitted to its content, in the light palette.
/// Image shapes keep their `src` (web URLs, `/…` paths and inline rasters only).
pub fn to_svg(doc: &Value, board_id: &str) -> String {
    to_svg_with_images(doc, board_id, &HashMap::new())
}

/// Like [`to_svg`], but image shapes whose `src` is a key of `images` are inlined as `data:` URLs
/// (needed for PNG rendering and self-contained HTML / PDF).
pub fn to_svg_with_images(
    doc: &Value,
    board_id: &str,
    images: &HashMap<String, Vec<u8>>,
) -> String {
    render_svg(doc, board_id, images, false)
}

/// Like [`to_svg_with_images`], but image shapes that are not in `images` (and not already a
/// `data:` URL) are left out, so the SVG references nothing a renderer could fetch.
pub fn to_svg_self_contained(
    doc: &Value,
    board_id: &str,
    images: &HashMap<String, Vec<u8>>,
) -> String {
    render_svg(doc, board_id, images, true)
}

fn render_svg(
    doc: &Value,
    board_id: &str,
    images: &HashMap<String, Vec<u8>>,
    inline_only: bool,
) -> String {
    let list = prepared(read_shapes(doc, board_id));
    let [x0, y0, x1, y1] = export_bounds(&list);
    let (w, h) = ((x1 - x0).ceil().max(1.0), (y1 - y0).ceil().max(1.0));
    let mut ids = Ids {
        prefix: id_prefix(board_id),
        clip: 0,
    };
    let body: String = list
        .iter()
        .map(|s| shape_svg(s, &mut ids, images, inline_only))
        .collect();
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"{w}\" height=\"{h}\" viewBox=\"{} {} {w} {h}\" font-family=\"{FONT}\">\
         <defs><marker id=\"{}ah\" viewBox=\"0 0 10 10\" refX=\"8.5\" refY=\"5\" markerWidth=\"8\" markerHeight=\"8\" orient=\"auto-start-reverse\"><path d=\"M1 1.5 L9 5 L1 8.5\" fill=\"none\" stroke=\"{}\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></marker></defs>\
         <rect x=\"{}\" y=\"{}\" width=\"{w}\" height=\"{h}\" fill=\"{}\"/>{body}</svg>",
        n(x0),
        n(y0),
        ids.prefix,
        p::FG2,
        n(x0),
        n(y0),
        p::BG
    )
}

/// Every image `src` used on any board (except inline `data:` URLs), for the caller to fetch.
pub fn image_sources(doc: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Some(boards) = doc["boards"].as_object() else {
        return out;
    };
    let mut ids: Vec<&String> = boards.keys().collect();
    ids.sort();
    for id in ids {
        for s in read_shapes(doc, id) {
            if s.kind == "image"
                && !s.src.is_empty()
                && !s.src.starts_with("data:")
                && !out.contains(&s.src)
            {
                out.push(s.src);
            }
        }
    }
    out
}

/// Number of shapes and their texts (stickies, text, labels) in paint order, for captions and
/// alt text.
pub fn summary(doc: &Value, board_id: &str) -> (usize, Vec<String>) {
    let shapes = read_shapes(doc, board_id);
    let texts = shapes
        .iter()
        .flat_map(|s| [s.text.trim().to_string(), s.label.trim().to_string()])
        .filter(|t| !t.is_empty())
        .collect();
    (shapes.len(), texts)
}

// ---------------------------------------------------------------- PNG

/// Renders an SVG (normally from [`to_svg_with_images`]) to PNG at `scale` (capped at 16384 px
/// per side and 64 Mpx) on a white background. Only inline `data:` raster images are drawn:
/// remote URLs and file paths are never read.
pub fn to_png(svg: &str, scale: f32) -> Result<Vec<u8>, crate::Error> {
    let mut opt = usvg::Options {
        font_family: crate::fonts::PRIMARY_FAMILY.into(),
        fontdb: crate::fonts::database(),
        font_resolver: crate::fonts::resolver(),
        ..usvg::Options::default()
    };
    opt.image_href_resolver = usvg::ImageHrefResolver {
        resolve_data: Box::new(|_mime: &str, data: Arc<Vec<u8>>, _: &usvg::Options| {
            match sniff_image(&data)? {
                "image/png" => Some(usvg::ImageKind::PNG(data)),
                "image/jpeg" => Some(usvg::ImageKind::JPEG(data)),
                "image/gif" => Some(usvg::ImageKind::GIF(data)),
                "image/webp" => Some(usvg::ImageKind::WEBP(data)),
                _ => None,
            }
        }),
        resolve_string: Box::new(|_: &str, _: &usvg::Options| None),
    };
    let tree = usvg::Tree::from_str(svg, &opt).map_err(|e| crate::Error::Render(e.to_string()))?;
    let size = tree.size();
    let (w, h) = (size.width().max(1.0), size.height().max(1.0));
    let mut s = if scale.is_finite() { scale } else { 1.0 };
    s = s.clamp(0.1, MAX_SIDE / w.max(h));
    s = s.min((MAX_PIXELS / (w * h)).sqrt());
    let (pw, ph) = (
        (w * s).round().max(1.0) as u32,
        (h * s).round().max(1.0) as u32,
    );
    let mut pixmap = tiny_skia::Pixmap::new(pw, ph)
        .ok_or_else(|| crate::Error::Render("image too large".into()))?;
    pixmap.fill(tiny_skia::Color::WHITE);
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(s, s),
        &mut pixmap.as_mut(),
    );
    pixmap
        .encode_png()
        .map_err(|e| crate::Error::Render(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(n(3.0), "3");
        assert_eq!(n(-0.001), "0");
        assert_eq!(n(350.165), "350.17");
        assert_eq!(n(-32.0), "-32");
        assert_eq!(fixed(310.25, 1), "310.3");
        assert_eq!(fixed(10.0, 1), "10.0");
    }

    #[test]
    fn elbow_via_routes_through_waypoints_like_the_web() {
        // Same cases as `web/packages/board/src/open.test.tsx`.
        assert_eq!(
            elbow_via(
                &[[0.0, 0.0], [100.0, 50.0], [200.0, 0.0]],
                Some(Anchor::Right),
                Some(Anchor::Left)
            ),
            vec![
                [0.0, 0.0],
                [100.0, 0.0],
                [100.0, 50.0],
                [150.0, 50.0],
                [150.0, 0.0],
                [200.0, 0.0]
            ]
        );
        assert_eq!(
            elbow_via(
                &[[0.0, 0.0], [100.0, 50.0], [200.0, 100.0]],
                Some(Anchor::Right),
                Some(Anchor::Top)
            ),
            vec![
                [0.0, 0.0],
                [100.0, 0.0],
                [100.0, 50.0],
                [200.0, 50.0],
                [200.0, 100.0]
            ]
        );
    }

    #[test]
    fn elbow_drops_collinear_points() {
        assert_eq!(
            elbow([0.0, 0.0], [10.0, 0.0], None, None),
            vec![[0.0, 0.0], [10.0, 0.0]]
        );
    }
}
