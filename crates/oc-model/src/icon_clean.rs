// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Cleaning an uploaded icon (DGM-17 Add your own icon, ADR-057). Server only: the editor never
//! trusts a file a person dropped in.
//!
//! - PNG: checked by its magic bytes, at most 256 KB and 1024 px a side, then decoded and encoded
//!   again (which drops every ancillary chunk: text, EXIF, colour profiles).
//! - SVG: at most 256 KB of UTF-8. A `roxmltree` pre-scan refuses any DTD (so no entity expansion:
//!   billion laughs), more than 2,000 elements or nesting deeper than 16, and counts what will be
//!   removed, by name, for the report. `usvg` then normalises the file into plain shapes (paths,
//!   groups, gradients, clip paths, masks, filters, inline PNG/JPEG only; text becomes outlines);
//!   it never runs or fetches anything: external references resolve to nothing. The result must
//!   pass [`allowed`] and be at most 64 KB.

use std::sync::Arc;

use resvg::{tiny_skia, usvg};

/// Largest upload.
pub const MAX_INPUT: usize = 256 * 1024;
/// Largest cleaned SVG.
pub const MAX_CLEANED_SVG: usize = 64 * 1024;
/// Most elements in an uploaded SVG.
pub const MAX_ELEMENTS: usize = 2000;
/// Deepest element nesting in an uploaded SVG.
pub const MAX_DEPTH: usize = 16;
/// Largest PNG side.
pub const MAX_PNG_SIDE: u32 = 1024;

const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Svg,
    Png,
}

impl Format {
    pub fn mime(self) -> &'static str {
        match self {
            Format::Svg => "image/svg+xml",
            Format::Png => "image/png",
        }
    }
}

/// One kind of thing the cleaner took out, for the report ("Scripts", 2).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Removed {
    pub what: String,
    pub count: usize,
}

#[derive(Debug, Clone)]
pub struct Cleaned {
    pub format: Format,
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub removed: Vec<Removed>,
}

/// Why a file was refused: a stable `code` and a sentence for the person.
#[derive(Debug, Clone)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

fn refuse(code: &'static str, message: impl Into<String>) -> Refusal {
    Refusal {
        code,
        message: message.into(),
    }
}

/// Cleans an uploaded icon (SVG or PNG, told apart by content, never by name or type).
pub fn clean(input: &[u8]) -> Result<Cleaned, Refusal> {
    if input.len() > MAX_INPUT {
        return Err(refuse(
            "too_large",
            "This file is over 256 KB. Icons must be 256 KB or smaller.",
        ));
    }
    if input.starts_with(PNG_MAGIC) {
        return clean_png(input);
    }
    let text = std::str::from_utf8(input)
        .map_err(|_| refuse("unsupported", "Only SVG and PNG files can be icons."))?;
    let t = text.trim_start_matches('\u{feff}').trim_start();
    if !t.starts_with('<') {
        return Err(refuse(
            "unsupported",
            "Only SVG and PNG files can be icons.",
        ));
    }
    clean_svg(t)
}

fn clean_png(input: &[u8]) -> Result<Cleaned, Refusal> {
    // IHDR first: refuse big images before decoding them.
    if input.len() < 24 || &input[12..16] != b"IHDR" {
        return Err(refuse(
            "invalid_png",
            "This PNG file is damaged or not a PNG.",
        ));
    }
    let w = u32::from_be_bytes([input[16], input[17], input[18], input[19]]);
    let h = u32::from_be_bytes([input[20], input[21], input[22], input[23]]);
    if w == 0 || h == 0 {
        return Err(refuse(
            "invalid_png",
            "This PNG file is damaged or not a PNG.",
        ));
    }
    if w > MAX_PNG_SIDE || h > MAX_PNG_SIDE {
        return Err(refuse(
            "png_too_large",
            format!("This PNG is {w} × {h} px. Icons can be at most 1024 px on each side."),
        ));
    }
    let px = tiny_skia::Pixmap::decode_png(input)
        .map_err(|_| refuse("invalid_png", "This PNG file is damaged or not a PNG."))?;
    let data = px
        .encode_png()
        .map_err(|_| refuse("invalid_png", "This PNG file could not be re-encoded."))?;
    if data.len() > MAX_INPUT {
        return Err(refuse("too_large", "This PNG is over 256 KB once cleaned."));
    }
    Ok(Cleaned {
        format: Format::Png,
        data,
        width: px.width(),
        height: px.height(),
        removed: vec![],
    })
}

/// What the pre-scan found, in report order.
#[derive(Default)]
struct Scan {
    scripts: usize,
    handlers: usize,
    foreign: usize,
    external: usize,
    animation: usize,
    metadata: usize,
    unsupported: usize,
}

const DRAWABLE: &[&str] = &[
    "svg",
    "g",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "textPath",
    "defs",
    "linearGradient",
    "radialGradient",
    "stop",
    "clipPath",
    "mask",
    "pattern",
    "image",
    "use",
    "symbol",
    "switch",
    "a",
    "style",
    "filter",
    "marker",
];

fn local_ref(v: &str) -> bool {
    let v = v.trim();
    v.starts_with('#')
        || v.starts_with("data:image/png;base64,")
        || v.starts_with("data:image/jpeg;base64,")
}

/// `url(…)` references in a style or attribute value that point outside the file.
fn external_urls(v: &str) -> usize {
    let l = v.to_ascii_lowercase();
    let mut n = 0;
    for part in l.split("url(").skip(1) {
        let inner = part.trim_start_matches(['\'', '"', ' ']);
        if !inner.starts_with('#') {
            n += 1;
        }
    }
    n + l.matches("@import").count()
}

fn scan(doc: &roxmltree::Document) -> Result<Scan, Refusal> {
    let mut s = Scan::default();
    let mut elements = 0usize;
    for n in doc.descendants().filter(|n| n.is_element()) {
        elements += 1;
        if elements > MAX_ELEMENTS {
            return Err(refuse(
                "too_many_elements",
                "This SVG has more than 2,000 elements. Simplify it, or export it as PNG.",
            ));
        }
        let depth = n.ancestors().filter(|a| a.is_element()).count();
        if depth > MAX_DEPTH {
            return Err(refuse(
                "too_deep",
                "This SVG nests groups more than 16 deep. Flatten it, or export it as PNG.",
            ));
        }
        let name = n.tag_name().name();
        // Inside a removed element: counted with it.
        if n.ancestors()
            .skip(1)
            .any(|a| a.tag_name().name() == "foreignObject")
        {
            continue;
        }
        match name {
            "script" => s.scripts += 1,
            "foreignObject" => s.foreign += 1,
            "animate" | "animateMotion" | "animateTransform" | "set" | "animateColor" => {
                s.animation += 1
            }
            "metadata" | "title" | "desc" => s.metadata += 1,
            n2 if !DRAWABLE.contains(&n2) && !n2.starts_with("fe") => s.unsupported += 1,
            _ => {}
        }
        if name == "script" {
            continue;
        }
        for a in n.attributes() {
            let an = a.name();
            if an.len() > 2 && an[..2].eq_ignore_ascii_case("on") {
                s.handlers += 1;
            } else if an == "href" && !local_ref(a.value()) {
                s.external += 1;
            } else if an == "style"
                || an == "fill"
                || an == "stroke"
                || an == "filter"
                || an == "mask"
                || an == "clip-path"
            {
                s.external += external_urls(a.value());
            }
        }
        if name == "style" {
            s.external += external_urls(n.text().unwrap_or_default());
        }
    }
    Ok(s)
}

fn report(s: &Scan) -> Vec<Removed> {
    [
        ("Scripts", s.scripts),
        ("Event handlers", s.handlers),
        ("Embedded HTML", s.foreign),
        ("External links", s.external),
        ("Animations", s.animation),
        ("Metadata", s.metadata),
        ("Unsupported elements", s.unsupported),
    ]
    .into_iter()
    .filter(|(_, c)| *c > 0)
    .map(|(w, c)| Removed {
        what: w.into(),
        count: c,
    })
    .collect()
}

fn options() -> usvg::Options<'static> {
    let mut opt = usvg::Options {
        font_family: crate::fonts::PRIMARY_FAMILY.into(),
        fontdb: crate::fonts::database(),
        font_resolver: crate::fonts::resolver(),
        resources_dir: None,
        ..usvg::Options::default()
    };
    // Inline PNG and JPEG only; nested SVG, files and URLs resolve to nothing.
    opt.image_href_resolver = usvg::ImageHrefResolver {
        resolve_data: Box::new(|_mime: &str, data: Arc<Vec<u8>>, _: &usvg::Options| {
            match crate::board::sniff_image(&data)? {
                "image/png" => Some(usvg::ImageKind::PNG(data)),
                "image/jpeg" => Some(usvg::ImageKind::JPEG(data)),
                _ => None,
            }
        }),
        resolve_string: Box::new(|_: &str, _: &usvg::Options| None),
    };
    opt
}

fn clean_svg(text: &str) -> Result<Cleaned, Refusal> {
    let po = roxmltree::ParsingOptions {
        allow_dtd: false,
        nodes_limit: (MAX_ELEMENTS as u32) * 8,
        ..roxmltree::ParsingOptions::default()
    };
    let doc = roxmltree::Document::parse_with_options(text, po).map_err(|e| match e {
        roxmltree::Error::DtdDetected => refuse(
            "dtd",
            "This SVG declares a DTD or entities, which icons can't use. Export it again without them.",
        ),
        roxmltree::Error::NodesLimitReached => refuse(
            "too_many_elements",
            "This SVG has more than 2,000 elements. Simplify it, or export it as PNG.",
        ),
        _ => refuse("invalid_svg", "This SVG file can't be read. Check it opens in a browser."),
    })?;
    if doc.root_element().tag_name().name() != "svg" {
        return Err(refuse("invalid_svg", "This file is not an SVG image."));
    }
    let s = scan(&doc)?;
    let tree = usvg::Tree::from_str(text, &options()).map_err(|_| {
        refuse(
            "invalid_svg",
            "This SVG file can't be read. Check it opens in a browser.",
        )
    })?;
    if !tree.root().has_children() {
        return Err(refuse(
            "empty",
            "Nothing is left to draw once this SVG is cleaned.",
        ));
    }
    let size = tree.size();
    let out = tree.to_string(&usvg::WriteOptions {
        coordinates_precision: 3,
        transforms_precision: 4,
        ..usvg::WriteOptions::default()
    });
    if out.len() > MAX_CLEANED_SVG {
        return Err(refuse(
            "cleaned_too_large",
            format!(
                "Cleaned, this SVG is {} KB; icons can be at most 64 KB. Simplify it, or export it as PNG.",
                out.len().div_ceil(1024)
            ),
        ));
    }
    if !allowed(&out) {
        return Err(refuse(
            "invalid_svg",
            "This SVG could not be cleaned safely.",
        ));
    }
    Ok(Cleaned {
        format: Format::Svg,
        data: out.into_bytes(),
        width: size.width().ceil() as u32,
        height: size.height().ceil() as u32,
        removed: report(&s),
    })
}

/// The allow-list a cleaned SVG must pass (also checked again wherever a stored icon is read):
/// drawing elements only, no event attributes, references only inside the file or to inline
/// PNG/JPEG.
pub fn allowed(svg: &str) -> bool {
    const OK: &[&str] = &[
        "svg",
        "g",
        "path",
        "defs",
        "linearGradient",
        "radialGradient",
        "stop",
        "clipPath",
        "mask",
        "pattern",
        "image",
        "use",
        "filter",
    ];
    let po = roxmltree::ParsingOptions {
        allow_dtd: false,
        nodes_limit: (MAX_ELEMENTS as u32) * 8,
        ..roxmltree::ParsingOptions::default()
    };
    let Ok(doc) = roxmltree::Document::parse_with_options(svg, po) else {
        return false;
    };
    if doc.root_element().tag_name().name() != "svg" {
        return false;
    }
    doc.descendants().filter(|n| n.is_element()).all(|n| {
        let name = n.tag_name().name();
        (OK.contains(&name) || name.starts_with("fe"))
            && n.attributes().all(|a| {
                let an = a.name();
                !(an.len() > 2 && an[..2].eq_ignore_ascii_case("on"))
                    && (an != "href" || local_ref(a.value()))
                    && an != "style"
                    && external_urls(a.value()) == 0
            })
    })
}
