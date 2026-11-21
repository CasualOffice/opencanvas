//! Board rendering: a standalone SVG fitted to the content in the light palette (a port of the
//! web `exportBoardSvg`, `web/packages/board/src/export.ts`, incl. bound and elbow arrows from
//! `connectors.ts`), and a PNG rendered from it with `resvg` and an embedded font.
//!
//! Input is the logical JSON from [`crate::doc_to_json`] (`boards/<id>/{shapes, order}`).

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

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
    size: f64,
    pts: Vec<Pt>,
    stroke: String,
    /// `start` / `end` set at all (truthy in the web model), even if not a valid binding.
    has_start: bool,
    has_end: bool,
    start: Option<Binding>,
    end: Option<Binding>,
    route: String,
    src: String,
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
    })
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

fn shape(id: &str, v: &Value) -> Shape {
    let pts = v["pts"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|q| {
                    let q = q.as_array()?;
                    Some([num(q.first()?), num(q.get(1)?)])
                })
                .collect()
        })
        .unwrap_or_default();
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
        size: num(&v["size"]),
        pts,
        stroke: string(&v["stroke"]),
        has_start: truthy(&v["start"]),
        has_end: truthy(&v["end"]),
        start: binding(&v["start"]),
        end: binding(&v["end"]),
        route: string(&v["route"]),
        src: string(&v["src"]),
    }
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
        let size = if s.size != 0.0 { s.size } else { 18.0 };
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
    let eq = |u: f64, v: f64| (u - v).abs() < 0.01;
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
    if bs.is_none() && be.is_none() && s.route.is_empty() {
        return pts.clone();
    }
    let mut a: Pt = pts.first().copied().unwrap_or([0.0, 0.0]);
    let mut b: Pt = pts.last().copied().unwrap_or(a);
    let mut aa = bs.and(s.start.as_ref().map(|x| x.anchor));
    let mut ab = be.and(s.end.as_ref().map(|x| x.anchor));
    if let (Some(sh), Some(an)) = (bs, aa)
        && an != Anchor::Center
    {
        a = anchor_point(sh, an);
    }
    if let (Some(sh), Some(an)) = (be, ab)
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
        return elbow(r1(a), r1(b), aa, ab);
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
            if s.kind == "arrow" && (s.has_start || s.has_end || !s.route.is_empty()) {
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

// ---------------------------------------------------------------- export.ts

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

fn lines(text: &str, x: f64, y: f64, lh: f64, o: TextOpts) -> String {
    text.split('\n')
        .enumerate()
        .map(|(i, l)| {
            format!(
                "<text x=\"{}\" y=\"{}\" font-size=\"{}\"{}{} fill=\"{}\">{}</text>",
                n(x),
                n(y + i as f64 * lh),
                if o.size == 0.0 {
                    "0".into()
                } else {
                    format!("{}", o.size)
                },
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

fn centered(s: &Shape, lh: f64) -> f64 {
    s.y + s.h / 2.0 + 5.0 - ((s.text.split('\n').count() as f64 - 1.0) * lh) / 2.0
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
    let txt = |fill| TextOpts {
        anchor: false,
        size: 14.0,
        weight: None,
        fill,
    };
    match s.kind.as_str() {
        "sticky" => format!(
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
            lines(text, x + 14.0, y + 30.0, 20.0, txt(p::STICKY_FG))
        ),
        "rect" => {
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
                lines(
                    text,
                    x + w / 2.0,
                    centered(s, 18.0),
                    18.0,
                    TextOpts {
                        anchor: true,
                        ..txt(p::FG)
                    },
                )
            };
            format!(
                "<g><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"12\" fill=\"{}\" stroke=\"{}\" stroke-width=\"1.5\"{}/>{label}{body}</g>",
                n(x),
                n(y),
                n(w),
                n(h),
                if s.dashed { "none" } else { p::APP },
                if s.dashed { p::FG3 } else { stroke },
                if s.dashed {
                    " stroke-dasharray=\"6 5\""
                } else {
                    ""
                },
            )
        }
        "ellipse" => format!(
            "<g><ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\" fill=\"{}\" stroke=\"{stroke}\" stroke-width=\"1.5\"/>{}</g>",
            n(x + w / 2.0),
            n(y + h / 2.0),
            n(w / 2.0),
            n(h / 2.0),
            p::APP,
            if text.is_empty() {
                String::new()
            } else {
                lines(
                    text,
                    x + w / 2.0,
                    centered(s, 19.0),
                    19.0,
                    TextOpts {
                        anchor: true,
                        size: 15.0,
                        weight: Some(600),
                        fill: p::FG,
                    },
                )
            }
        ),
        "diamond" => {
            let (cx, cy) = (x + w / 2.0, y + h / 2.0);
            format!(
                "<g><path d=\"M{} {} L{} {} L{} {} L{} {} Z\" fill=\"{}\" stroke=\"{stroke}\" stroke-width=\"1.5\" stroke-linejoin=\"round\"/>{}</g>",
                n(cx),
                n(y),
                n(x + w),
                n(cy),
                n(cx),
                n(y + h),
                n(x),
                n(cy),
                p::APP,
                if text.is_empty() {
                    String::new()
                } else {
                    lines(
                        text,
                        cx,
                        centered(s, 18.0),
                        18.0,
                        TextOpts {
                            anchor: true,
                            ..txt(p::FG)
                        },
                    )
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
            let size = if s.size != 0.0 { s.size } else { 18.0 };
            lines(
                text,
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
            format!(
                "<path d=\"M{}\" stroke=\"{}\" stroke-width=\"1.6\" fill=\"none\" stroke-linejoin=\"round\" stroke-linecap=\"round\" marker-end=\"url(#{}ah)\"/>",
                s.pts
                    .iter()
                    .map(|q| format!("{} {}", n(q[0]), n(q[1])))
                    .collect::<Vec<_>>()
                    .join(" L"),
                p::FG2,
                ids.prefix
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

/// Picture size in board units: `[x0, y0, x1, y1]` (content bounds + padding, or 320×200).
fn export_bounds(resolved: &[Shape]) -> [f64; 4] {
    match content_bounds(resolved) {
        Some(b) => [b[0] - PAD, b[1] - PAD, b[2] + PAD, b[3] + PAD],
        None => [0.0, 0.0, 320.0, 200.0],
    }
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
    let list = with_resolved_arrows(&read_shapes(doc, board_id));
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

static FONTS: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();

/// The embedded fonts (Geist Regular + SemiBold, OFL), so text renders the same on any
/// machine, without system fonts.
fn fontdb() -> Arc<usvg::fontdb::Database> {
    FONTS
        .get_or_init(|| {
            let mut db = usvg::fontdb::Database::new();
            db.load_font_data(include_bytes!("../fonts/Geist-Regular.ttf").to_vec());
            db.load_font_data(include_bytes!("../fonts/Geist-SemiBold.ttf").to_vec());
            // Every generic family falls back to the embedded font.
            db.set_sans_serif_family("Geist");
            db.set_serif_family("Geist");
            db.set_monospace_family("Geist");
            db.set_cursive_family("Geist");
            db.set_fantasy_family("Geist");
            Arc::new(db)
        })
        .clone()
}

/// Renders an SVG (normally from [`to_svg_with_images`]) to PNG at `scale` (capped at 16384 px
/// per side and 64 Mpx) on a white background. Only inline `data:` raster images are drawn:
/// remote URLs and file paths are never read.
pub fn to_png(svg: &str, scale: f32) -> Result<Vec<u8>, crate::Error> {
    let mut opt = usvg::Options {
        font_family: "Geist".into(),
        fontdb: fontdb(),
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
    fn elbow_drops_collinear_points() {
        assert_eq!(
            elbow([0.0, 0.0], [10.0, 0.0], None, None),
            vec![[0.0, 0.0], [10.0, 0.0]]
        );
    }
}
