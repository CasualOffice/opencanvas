// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Diagram import (DGM-15, docs/29 §7): draw.io (`.drawio`, diagrams.net `.xml`) and Excalidraw
//! (`.excalidraw`) files → board shapes in the web model (`web/packages/board/src/model.ts`), plus
//! a report of what does not convert exactly (AGENTS.md rule 7: nothing is dropped silently).
//!
//! Untrusted input: the caller caps the file at `MAX_IMPORT_BYTES` (5 MB, SEC-39). Here: inflated
//! draw.io pages are capped ([`MAX_INFLATED`]), XML is parsed by `roxmltree` with DTDs refused
//! (no entities, so no billion laughs and no external entities), a node limit and a depth limit
//! checked without recursion; JSON keeps `serde_json`'s nesting limit. Nothing is fetched: linked
//! images are reported and left as boxes. Labels are reduced to plain text (tags, scripts, styles
//! and SVG removed). Embedded images must be PNG, JPEG, GIF or WebP by their bytes, ≤
//! [`MAX_IMAGE_BYTES`] each; SVG is never imported.
//!
//! Shapes keep their source coordinates; the caller places them. Each shape has a local `id`
//! (unique in the result; bindings, `group` and `props.parent` refer to it) and
//! `props.sourceId`, the element id in the source file.

mod drawio;
mod excalidraw;

use std::collections::HashMap;

use base64::Engine;
use serde_json::{Value, json};

/// Standard base64, padding optional (draw.io and Excalidraw both pad, hand-made files may not).
pub(crate) const B64: base64::engine::GeneralPurpose = base64::engine::GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    base64::engine::GeneralPurposeConfig::new()
        .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
);

/// Largest inflated draw.io page (compressed `<diagram>` content).
pub const MAX_INFLATED: usize = 16 * 1024 * 1024;
/// Most XML nodes in one file or inflated page.
pub const MAX_XML_NODES: u32 = 200_000;
/// Deepest XML element nesting (draw.io files are about 8 deep).
pub const MAX_XML_DEPTH: usize = 64;
/// Most shapes (connectors included) one import makes.
pub const MAX_SHAPES: usize = 20_000;
/// Largest embedded image, decoded (the board's inline image limit, `images.ts`).
pub const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
/// Most points kept in one pen stroke; longer strokes are thinned.
pub const MAX_PEN_POINTS: usize = 1_000;
/// Longest label kept.
const MAX_LABEL: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Drawio,
    Excalidraw,
}

impl Format {
    pub fn parse(s: &str) -> Option<Format> {
        match s {
            "drawio" => Some(Format::Drawio),
            "excalidraw" => Some(Format::Excalidraw),
            _ => None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Format::Drawio => "drawio",
            Format::Excalidraw => "excalidraw",
        }
    }
}

/// A converted page: shapes in paint order, the file's page names, the page converted, and the
/// dry-run report `{format, pages, page, counts: {shapes, connectors, images, containers,
/// needLook}, items: [{level, code, title, detail?, count, examples}]}`.
#[derive(Debug)]
pub struct Converted {
    pub shapes: Vec<Value>,
    pub pages: Vec<String>,
    pub page: usize,
    pub report: Value,
}

/// Why a file can't be imported: `code` is `too_large`, `too_deep`, `unreadable`, `not_diagram`
/// or `no_page`; `message` says it in plain words.
#[derive(Debug)]
pub struct ImportError {
    pub code: &'static str,
    pub message: String,
}

impl ImportError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        ImportError {
            code,
            message: message.into(),
        }
    }
}

/// Converts `page` (0-based; Excalidraw has one) of a diagram file.
pub fn convert(format: Format, bytes: &[u8], page: usize) -> Result<Converted, ImportError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| ImportError::new("unreadable", "The file isn't text, so it isn't a diagram file."))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = Out::default();
    let (pages, page) = match format {
        Format::Drawio => drawio::convert(text, page, &mut out)?,
        Format::Excalidraw => {
            if page != 0 {
                return Err(ImportError::new("no_page", "Excalidraw files have one page."));
            }
            excalidraw::convert(text, &mut out)?;
            (vec![], 0)
        }
    };
    if out.shapes.len() > MAX_SHAPES {
        return Err(ImportError::new(
            "too_large",
            format!("It has {} shapes, and an import can add up to {MAX_SHAPES}.", out.shapes.len()),
        ));
    }
    let report = out.report(format, &pages, page);
    Ok(Converted {
        shapes: out.shapes,
        pages,
        page,
        report,
    })
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

/// Report codes, most important first within a level.
const CODES: &[(&str, Level)] = &[
    ("stencil", Level::Warn),
    ("shape_box", Level::Warn),
    ("image_large", Level::Warn),
    ("image_svg", Level::Warn),
    ("image_type", Level::Warn),
    ("image_link", Level::Warn),
    ("link", Level::Warn),
    ("embed", Level::Warn),
    ("page_other", Level::Gray),
    ("curved", Level::Gray),
    ("colour", Level::Gray),
    ("dashed", Level::Gray),
    ("stroke_width", Level::Gray),
    ("font", Level::Gray),
    ("text_style", Level::Gray),
    ("rough", Level::Gray),
    ("fill_style", Level::Gray),
    ("opacity", Level::Gray),
    ("effects", Level::Gray),
    ("rotation", Level::Gray),
    ("arrowheads", Level::Gray),
    ("nested_groups", Level::Gray),
    ("layers", Level::Gray),
    ("pen_thinned", Level::Gray),
    ("unbound", Level::Gray),
    ("data", Level::Gray),
    ("containers", Level::Ok),
    ("groups", Level::Ok),
    ("elbow", Level::Ok),
    ("lines", Level::Ok),
    ("images", Level::Ok),
];

#[derive(Default)]
struct Note {
    count: usize,
    examples: Vec<String>,
}

/// What a converter produces: shapes and notes for the report.
#[derive(Default)]
pub(crate) struct Out {
    shapes: Vec<Value>,
    notes: HashMap<&'static str, Note>,
    vendors: Vec<String>,
    other_pages: Vec<(usize, String)>,
}

impl Out {
    fn push(&mut self, shape: Value) {
        self.shapes.push(shape);
    }

    /// Counts one occurrence of `code`, with an example (kept for the first few).
    fn note(&mut self, code: &'static str, example: Option<String>) {
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

    fn report(&self, format: Format, pages: &[String], page: usize) -> Value {
        let count = |t: &str| self.shapes.iter().filter(|s| s["type"] == t).count();
        let connectors = count("arrow");
        let images = count("image");
        let containers = self.notes.get("containers").map_or(0, |n| n.count);
        let mut items: Vec<(Level, usize, Value)> = Vec::new();
        for (rank, (code, level)) in CODES.iter().enumerate() {
            let Some(n) = self.notes.get(code) else {
                continue;
            };
            if *code == "page_other" {
                for (i, name) in &self.other_pages {
                    items.push((
                        *level,
                        rank,
                        json!({"level": level.name(), "code": code, "count": 1, "examples": [name],
                            "title": format!("Page {}, “{}”, is not imported", i + 1, name),
                            "detail": "Import one page at a time."}),
                    ));
                }
                continue;
            }
            let (title, detail) = describe(code, n, &self.vendors, format);
            let mut v = json!({"level": level.name(), "code": code, "title": title, "count": n.count,
                "examples": n.examples});
            if let Some(d) = detail {
                v["detail"] = json!(d);
            }
            items.push((*level, rank, v));
        }
        items.sort_by_key(|(l, r, _)| (*l, *r));
        let need_look: usize = CODES
            .iter()
            .filter(|(_, l)| *l <= Level::Warn)
            .filter_map(|(c, _)| self.notes.get(c))
            .map(|n| n.count)
            .sum();
        json!({
            "format": format.name(),
            "pages": pages,
            "page": page,
            "counts": {"shapes": self.shapes.len() - connectors, "connectors": connectors,
                "images": images, "containers": containers, "needLook": need_look},
            "items": items.into_iter().map(|(_, _, v)| v).collect::<Vec<_>>(),
        })
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// "a, b and 2 more" from up to three examples of `n`.
fn examples(n: &Note) -> String {
    let shown = n.examples.len();
    let list = n.examples.join(", ");
    if n.count > shown && shown > 0 {
        format!("{list} and {} more", n.count - shown)
    } else {
        list
    }
}

fn describe(code: &str, n: &Note, vendors: &[String], format: Format) -> (String, Option<String>) {
    let ex = examples(n);
    let with = |tail: &str| -> Option<String> {
        Some(if ex.is_empty() {
            tail.to_string()
        } else {
            format!("{ex}. {tail}")
        })
    };
    let c = n.count;
    match code {
        "stencil" => {
            let who = match vendors {
                [one] => format!("{one} "),
                _ => String::new(),
            };
            (
                format!("{} become plain boxes with their names", plural(c, &format!("{who}icon"), &format!("{who}icons"))),
                with("They keep size and connections."),
            )
        }
        "shape_box" => (
            format!("{} with no board equivalent become boxes", plural(c, "shape", "shapes")),
            with("They keep their text, size and connections."),
        ),
        "image_large" => (
            format!("{} over 2 MB left out", plural(c, "embedded image is", "embedded images are")),
            with("A box keeps the place. Add a smaller image afterwards with Insert image."),
        ),
        "image_svg" => (
            format!("{} left out", plural(c, "SVG image is", "SVG images are")),
            with("SVG can carry scripts. A box keeps the place; add a PNG afterwards."),
        ),
        "image_type" => (
            format!("{} left out", plural(c, "image that isn't PNG, JPEG, GIF or WebP is", "images that aren't PNG, JPEG, GIF or WebP are")),
            with("A box keeps the place. Add it afterwards with Insert image."),
        ),
        "image_link" => (
            format!("{} not fetched", plural(c, "linked image is", "linked images are")),
            with("Images from other sites are never downloaded. A box keeps the place."),
        ),
        "link" => (
            format!("{} not imported", plural(c, "link is", "links are")),
            with("Links in diagram files can be unsafe. Add a link to the shape after importing."),
        ),
        "embed" => (
            format!("{} become boxes", plural(c, "web embed", "web embeds")),
            with("Embedded pages are not loaded."),
        ),
        "curved" => (
            "Curved connectors become elbow connectors".into(),
            None,
        ),
        "colour" => (
            format!("{} become the nearest board colour", plural(c, "colour", "colours")),
            with("Boards use a fixed set of colours that work in light and dark."),
        ),
        "dashed" => (
            "Dashed outlines become solid".into(),
            Some("Only frames and containers are dashed on a board.".into()),
        ),
        "stroke_width" => ("Line widths become the board’s line width".into(), None),
        "font" => ("Fonts become the board font".into(), None),
        "text_style" => (
            "Text formatting becomes plain text".into(),
            Some("Bold, italic, colours and alignment inside labels are not kept.".into()),
        ),
        "rough" => ("The hand-drawn style is not kept".into(), Some("Shapes are drawn with clean lines.".into())),
        "fill_style" => ("Hatched and cross-hatched fills become solid".into(), None),
        "opacity" => ("Transparency is not kept".into(), None),
        "effects" => ("Shadows and gradients are not kept".into(), None),
        "rotation" => (
            format!("{} drawn upright", plural(c, "rotated shape is", "rotated shapes are")),
            with("Boards don’t rotate shapes."),
        ),
        "arrowheads" => (
            "Arrowheads are drawn at the end only".into(),
            Some("Start arrowheads and arrowhead styles are not kept.".into()),
        ),
        "nested_groups" => ("Groups inside groups become one group".into(), None),
        "layers" => ("Layers are flattened".into(), with("Shapes keep their stacking order.")),
        "pen_thinned" => ("Long pen strokes are simplified".into(), Some(format!("Strokes keep up to {MAX_PEN_POINTS} points."))),
        "unbound" => (
            format!("{} to a missing shape", plural(c, "connector points", "connectors point")),
            with("They are kept as free connectors."),
        ),
        "data" => (
            format!("{} not imported", plural(c, "custom property is", "custom properties are")),
            with("Tooltips and shape data stay in the original file."),
        ),
        "containers" => (
            match format {
                Format::Drawio => "Groups and containers become containers".into(),
                Format::Excalidraw => "Frames become containers".into(),
            },
            None,
        ),
        "groups" => ("Groups stay groups".into(), None),
        "elbow" => ("Orthogonal connectors become elbow connectors".into(), None),
        "lines" => ("Lines become pen strokes".into(), None),
        "images" => (format!("{} imported", plural(c, "image is", "images are")), None),
        _ => (code.to_string(), None),
    }
}

// ---------- shared conversions ----------

/// Board tones and the colours they are drawn with (`board.rs` `p::tone`).
const TONES: &[(&str, &str)] = &[
    ("gray", "Gray"),
    ("blue", "Blue"),
    ("green", "Green"),
    ("amber", "Amber"),
    ("red", "Red"),
    ("purple", "Purple"),
    ("pink", "Pink"),
];

fn parse_hex(c: &str) -> Option<(f64, f64, f64)> {
    let h = c.trim().strip_prefix('#')?;
    let h: String = match h.len() {
        3 => h.chars().flat_map(|c| [c, c]).collect(),
        6 | 8 => h[..6].to_string(),
        _ => return None,
    };
    let v = u32::from_str_radix(&h, 16).ok()?;
    Some((
        f64::from((v >> 16) & 255) / 255.0,
        f64::from((v >> 8) & 255) / 255.0,
        f64::from(v & 255) / 255.0,
    ))
}

/// The board tone nearest a CSS colour: `None` for none, white, black and unreadable colours
/// (the board's default look). Hue buckets; low saturation is gray.
pub(crate) fn tone_of(colour: &str) -> Option<&'static str> {
    let c = colour.trim().to_ascii_lowercase();
    if c.is_empty() || c == "none" || c == "transparent" || c == "default" {
        return None;
    }
    let named = match c.as_str() {
        "white" => "#ffffff",
        "black" => "#000000",
        "red" => "#ff0000",
        "green" => "#008000",
        "blue" => "#0000ff",
        "yellow" => "#ffff00",
        "orange" => "#ffa500",
        "purple" => "#800080",
        "pink" => "#ffc0cb",
        "gray" | "grey" => "#808080",
        other => other,
    };
    let (r, g, b) = parse_hex(named)?;
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if l > 0.97 || l < 0.08 {
        return None;
    }
    let d = max - min;
    let s = if d == 0.0 { 0.0 } else { d / (1.0 - (2.0 * l - 1.0).abs()) };
    if s < 0.15 || d < 0.04 {
        return Some("gray");
    }
    let h = if max == r {
        60.0 * (((g - b) / d) % 6.0)
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    let h = if h < 0.0 { h + 360.0 } else { h };
    Some(match h {
        h if !(12.0..345.0).contains(&h) => "red",
        h if h < 70.0 => "amber",
        h if h < 170.0 => "green",
        h if h < 255.0 => "blue",
        h if h < 290.0 => "purple",
        _ => "pink",
    })
}

/// Sets `fill` from a source colour, noting it unless it maps to the default look.
fn set_fill(out: &mut Out, shape: &mut Value, colour: &str) {
    if let Some(t) = tone_of(colour) {
        shape["fill"] = json!(t);
        let name = TONES.iter().find(|(k, _)| *k == t).map_or(t, |(_, n)| *n);
        out.note("colour", Some(format!("{} → {name}", colour.trim().to_ascii_lowercase())));
    }
}

/// Plain text from an HTML label: block ends and `<br>` become line breaks, `script`, `style`
/// and `svg` elements are removed with their content, other tags are dropped, entities decoded.
/// Returns the text and whether there was formatting (other tags than line breaks).
pub(crate) fn html_to_text(html: &str) -> (String, bool) {
    let mut out = String::new();
    let mut styled = false;
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let Some(end) = after.find('>') else {
            // A lone '<' is text.
            out.push('<');
            rest = after;
            continue;
        };
        let tag = after[..end].trim();
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        rest = &after[end + 1..];
        if name.is_empty() {
            // `<!-- … -->`, `<!doctype>`, `<?…?>`: drop.
            if let Some(body) = tag.strip_prefix("!--")
                && !body.ends_with("--")
                && let Some(k) = rest.find("-->")
            {
                rest = &rest[k + 3..];
            }
            continue;
        }
        let closing = tag.starts_with('/');
        if !closing && matches!(name.as_str(), "script" | "style" | "svg" | "math" | "template" | "iframe" | "object" | "noscript") {
            // Skip to the matching close tag (case-insensitive), or the end.
            let lower = rest.to_ascii_lowercase();
            let close = format!("</{name}");
            rest = match lower.find(&close) {
                Some(k) => rest[k..].find('>').map_or("", |e| &rest[k + e + 1..]),
                None => "",
            };
            if tag.ends_with('/') {
                continue;
            }
            continue;
        }
        match name.as_str() {
            "br" => out.push('\n'),
            "div" | "p" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                if closing || !out.is_empty() {
                    if !out.ends_with('\n') && !out.is_empty() {
                        out.push('\n');
                    }
                }
            }
            "span" | "font" | "b" | "strong" | "i" | "em" | "u" | "sup" | "sub" | "strike" | "s" => {
                styled = true
            }
            _ => {}
        }
    }
    out.push_str(rest);
    let text = decode_entities(&out);
    (tidy(&text), styled)
}

/// Trims each line's trailing spaces, drops leading/trailing blank lines, caps the length and
/// removes control characters except line breaks and tabs.
pub(crate) fn tidy(s: &str) -> String {
    let s: String = s
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .take(MAX_LABEL)
        .collect();
    let lines: Vec<&str> = s.lines().map(str::trim_end).collect();
    lines.join("\n").trim_matches('\n').trim().to_string()
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let end = after.find(';').filter(|e| *e <= 10);
        let decoded = end.and_then(|e| {
            let name = &after[..e];
            let c = match name {
                "amp" => '&',
                "lt" => '<',
                "gt" => '>',
                "quot" => '"',
                "apos" | "#39" => '\'',
                "nbsp" => '\u{a0}',
                n if n.starts_with("#x") || n.starts_with("#X") => {
                    char::from_u32(u32::from_str_radix(&n[2..], 16).ok()?)?
                }
                n if n.starts_with('#') => char::from_u32(n[1..].parse().ok()?)?,
                _ => return None,
            };
            Some((c, e))
        });
        match decoded {
            Some((c, e)) => {
                out.push(c);
                rest = &after[e + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Why an image can't be embedded.
pub(crate) enum ImageRefusal {
    Svg,
    Large,
    Type,
    Link,
}

/// A safe `data:` URL for an embedded image, or why not. Accepts `data:<mime>[;base64],<data>`
/// and draw.io's `data:<mime>,<base64>` (the `;` is its style separator). The bytes must be PNG,
/// JPEG, GIF or WebP (checked by their signature, not the declared type) and ≤ 2 MB.
pub(crate) fn safe_image(url: &str) -> Result<String, ImageRefusal> {
    let url = url.trim();
    let Some(rest) = url.get(..5).filter(|p| p.eq_ignore_ascii_case("data:")).map(|_| &url[5..]) else {
        return Err(ImageRefusal::Link);
    };
    let Some((meta, data)) = rest.split_once(',') else {
        return Err(ImageRefusal::Type);
    };
    let mime = meta.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if mime.contains("svg") {
        return Err(ImageRefusal::Svg);
    }
    // Base64 is 4/3 of the bytes: refuse before decoding anything huge.
    if data.len() / 4 * 3 > MAX_IMAGE_BYTES + 3 {
        return Err(ImageRefusal::Large);
    }
    let clean: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    let clean = percent_encoding::percent_decode_str(&clean).decode_utf8_lossy().into_owned();
    let bytes = B64.decode(clean.as_bytes()).map_err(|_| ImageRefusal::Type)?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(ImageRefusal::Large);
    }
    let real = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        return Err(ImageRefusal::Type);
    };
    Ok(format!(
        "data:{real};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

/// Notes an image refusal and turns the shape into a box that keeps its place.
fn refuse_image(out: &mut Out, shape: &mut Value, why: ImageRefusal, name: &str) {
    let code = match why {
        ImageRefusal::Svg => "image_svg",
        ImageRefusal::Large => "image_large",
        ImageRefusal::Type => "image_type",
        ImageRefusal::Link => "image_link",
    };
    out.note(code, Some(name.to_string()));
    shape["type"] = json!("rect");
    shape["dashed"] = json!(true);
    shape["text"] = json!(name);
    if let Some(o) = shape.as_object_mut() {
        o.remove("src");
        o.remove("alt");
    }
}

/// Every `n`-th point so a stroke keeps at most [`MAX_PEN_POINTS`] (first and last kept).
fn thin(pts: Vec<[f64; 2]>, out: &mut Out, id: &str) -> Vec<[f64; 2]> {
    if pts.len() <= MAX_PEN_POINTS {
        return pts;
    }
    out.note("pen_thinned", Some(id.to_string()));
    let step = pts.len().div_ceil(MAX_PEN_POINTS - 1);
    let last = *pts.last().unwrap_or(&[0.0, 0.0]);
    let mut v: Vec<[f64; 2]> = pts.into_iter().step_by(step).collect();
    if v.last() != Some(&last) {
        v.push(last);
    }
    v
}

fn finite(v: f64) -> f64 {
    if v.is_finite() { v } else { 0.0 }
}

/// Bounding box `(x, y, w, h)` of points.
fn bbox(pts: &[[f64; 2]]) -> (f64, f64, f64, f64) {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in pts {
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    }
    if pts.is_empty() {
        return (0.0, 0.0, 0.0, 0.0);
    }
    (x0, y0, x1 - x0, y1 - y0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_map_to_the_nearest_tone() {
        assert_eq!(tone_of("#dae8fc"), Some("blue"));
        assert_eq!(tone_of("#d5e8d4"), Some("green"));
        assert_eq!(tone_of("#fff2cc"), Some("amber"));
        assert_eq!(tone_of("#f8cecc"), Some("red"));
        assert_eq!(tone_of("#e1d5e7"), Some("purple"));
        assert_eq!(tone_of("#f5f5f5"), Some("gray"));
        assert_eq!(tone_of("#ffffff"), None);
        assert_eq!(tone_of("none"), None);
        assert_eq!(tone_of("#1e1e1e"), None);
        assert_eq!(tone_of("#a5d8ff"), Some("blue"));
        assert_eq!(tone_of("#ffc9c9"), Some("red"));
        assert_eq!(tone_of("#eebefa"), Some("pink"));
    }

    #[test]
    fn html_labels_become_text() {
        assert_eq!(html_to_text("<div>a</div><div>b<br>c</div>").0, "a\nb\nc");
        assert_eq!(html_to_text("x <SCRIPT>bad()</script>y").0, "x y");
        assert_eq!(html_to_text("1 &lt; 2 &amp;&amp; &#x41;").0, "1 < 2 && A");
        assert!(html_to_text("<b>bold</b>").1);
        assert_eq!(html_to_text("a < b").0, "a < b");
    }
}
