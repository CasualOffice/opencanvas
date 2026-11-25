// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! DOCX export: minimal WordprocessingML written straight into a zip (no extra crates).
//!
//! Input is the logical JSON from [`crate::doc_to_json`]. Images are embedded only when the
//! caller supplies their bytes (the server fetches them from the host's own origin); others
//! become links. Database blocks become Word tables with a caption, boards a rendered PNG.

use std::collections::HashMap;
use std::io::{Cursor, Write};

use serde_json::Value;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::export::{BoardInfo, board_info, database_table};

pub const MIME: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/// EMU per CSS pixel at 96 dpi.
const EMU_PER_PX: u64 = 9525;
/// Text width of an A4 page with 1" margins, in EMU (6.27").
const MAX_WIDTH_EMU: u64 = 5_731_510;

const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture""#;

const REL_HYPERLINK: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const REL_IMAGE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn attr<'a>(n: &'a Value, key: &str) -> &'a Value {
    n.get("attrs")
        .and_then(|a| a.get(key))
        .unwrap_or(&Value::Null)
}

fn attr_str<'a>(n: &'a Value, key: &str) -> &'a str {
    attr(n, key).as_str().unwrap_or_default()
}

fn children(n: &Value) -> &[Value] {
    n.get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// Escapes text for XML and drops characters XML 1.0 cannot carry.
pub fn xml_escape(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    for c in t.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{fffe}' || c == '\u{ffff}' => {}
            c => out.push(c),
        }
    }
    out
}

fn safe_url(u: &str) -> Option<&str> {
    let l = u.trim().to_ascii_lowercase();
    ["http://", "https://", "mailto:"]
        .iter()
        .any(|p| l.starts_with(p))
        .then_some(u.trim())
}

/// Every image `src` in the document and on its boards, for the caller to fetch.
pub fn image_sources(doc: &Value) -> Vec<String> {
    fn walk(n: &Value, out: &mut Vec<String>) {
        if s(n, "type") == "image" {
            let src = attr_str(n, "src");
            if !src.is_empty() && !out.iter().any(|x| x == src) {
                out.push(src.to_string());
            }
        }
        for c in children(n) {
            walk(c, out);
        }
    }
    let mut out = Vec::new();
    walk(doc, &mut out);
    for src in crate::board::image_sources(doc) {
        if !out.contains(&src) {
            out.push(src);
        }
    }
    out
}

/// Sniffs PNG / JPEG / GIF bytes: (extension, width px, height px).
pub fn image_info(b: &[u8]) -> Option<(&'static str, u32, u32)> {
    let be16 = |i: usize| -> Option<u32> {
        Some(u32::from(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?])))
    };
    if b.starts_with(b"\x89PNG\r\n\x1a\n") && b.len() >= 24 {
        let w = u32::from_be_bytes(b[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(b[20..24].try_into().ok()?);
        return Some(("png", w, h));
    }
    if (b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a")) && b.len() >= 10 {
        let w = u32::from(u16::from_le_bytes([b[6], b[7]]));
        let h = u32::from(u16::from_le_bytes([b[8], b[9]]));
        return Some(("gif", w, h));
    }
    if b.starts_with(&[0xFF, 0xD8]) {
        let mut i = 2;
        while i + 9 < b.len() {
            if b[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = b[i + 1];
            if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) || marker == 0xFF
            {
                i += 1;
                continue;
            }
            let len = be16(i + 2)? as usize;
            let sof = (0xC0..=0xCF).contains(&marker) && ![0xC4, 0xC8, 0xCC].contains(&marker);
            if sof {
                return Some(("jpeg", be16(i + 7)?, be16(i + 5)?));
            }
            i += 2 + len;
        }
    }
    None
}

#[derive(Clone, Copy, Default)]
struct Ctx<'a> {
    /// Paragraph style forced on every paragraph (e.g. `Quote`).
    style: Option<&'a str>,
    /// Background fill for callouts.
    fill: Option<&'a str>,
    bold: bool,
    /// List nesting level (0 = not in a list).
    level: usize,
}

struct Writer<'a> {
    doc: &'a Value,
    images: &'a HashMap<String, Vec<u8>>,
    body: String,
    rels: Vec<(String, &'static str, String, bool)>,
    media: Vec<(String, Vec<u8>)>,
    /// numIds of ordered lists (each restarts at 1).
    ordered: Vec<u32>,
    next_rel: u32,
    next_pic: u32,
    /// Lossy conversions, reported in `docProps/custom` is overkill: kept for the caller.
    notes: Vec<String>,
}

impl<'a> Writer<'a> {
    fn rel(&mut self, kind: &'static str, target: String, external: bool) -> String {
        if let Some(r) = self
            .rels
            .iter()
            .find(|r| r.1 == kind && r.2 == target && r.3 == external)
        {
            return r.0.clone();
        }
        let id = format!("rId{}", self.next_rel);
        self.next_rel += 1;
        self.rels.push((id.clone(), kind, target, external));
        id
    }

    fn para(&mut self, ctx: Ctx, style: Option<&str>, extra_ppr: &str, runs: &str) {
        let mut ppr = String::new();
        if let Some(st) = ctx.style.or(style) {
            ppr.push_str(&format!("<w:pStyle w:val=\"{st}\"/>"));
        }
        ppr.push_str(extra_ppr);
        if let Some(fill) = ctx.fill {
            ppr.push_str(&format!(
                "<w:pBdr><w:left w:val=\"single\" w:sz=\"24\" w:space=\"8\" w:color=\"{fill}\"/></w:pBdr>\
                 <w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{fill}\"/><w:ind w:left=\"240\" w:right=\"240\"/>"
            ));
        }
        self.body.push_str("<w:p>");
        if !ppr.is_empty() {
            self.body.push_str(&format!("<w:pPr>{ppr}</w:pPr>"));
        }
        self.body.push_str(runs);
        self.body.push_str("</w:p>");
    }

    fn run(text: &str, rpr: &str) -> String {
        let mut out = String::new();
        for (i, line) in text.split('\n').enumerate() {
            if i > 0 {
                out.push_str(&format!("<w:r>{rpr}<w:br/></w:r>"));
            }
            if !line.is_empty() {
                out.push_str(&format!(
                    "<w:r>{rpr}<w:t xml:space=\"preserve\">{}</w:t></w:r>",
                    xml_escape(line)
                ));
            }
        }
        out
    }

    /// `<w:rPr>` in schema order.
    fn rpr(marks: &[Value], ctx: Ctx, link: bool) -> String {
        let has = |t: &str| marks.iter().any(|m| s(m, "type") == t);
        let mut p = String::new();
        if link {
            p.push_str("<w:rStyle w:val=\"Hyperlink\"/>");
        }
        if has("code") {
            p.push_str("<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\" w:cs=\"Consolas\"/>");
        }
        if has("bold") || ctx.bold {
            p.push_str("<w:b/>");
        }
        if has("italic") {
            p.push_str("<w:i/>");
        }
        if has("strike") {
            p.push_str("<w:strike/>");
        }
        if has("highlight") {
            p.push_str("<w:highlight w:val=\"yellow\"/>");
        }
        if has("underline") {
            p.push_str("<w:u w:val=\"single\"/>");
        }
        if let Some(hex) = marks
            .iter()
            .find(|m| s(m, "type") == "textColor")
            .and_then(|m| crate::export::text_color_hex(attr_str(m, "color")))
        {
            p.push_str(&format!(
                "<w:color w:val=\"{}\"/>",
                hex[1..].to_ascii_uppercase()
            ));
        }
        if has("code") {
            p.push_str("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F1F1F1\"/>");
        }
        if p.is_empty() {
            p
        } else {
            format!("<w:rPr>{p}</w:rPr>")
        }
    }

    fn inline(&mut self, nodes: &[Value], ctx: Ctx) -> String {
        let mut out = String::new();
        for n in nodes {
            match s(n, "type") {
                "text" => {
                    let marks = n
                        .get("marks")
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or_default();
                    let href = marks
                        .iter()
                        .find(|m| s(m, "type") == "link")
                        .and_then(|m| safe_url(attr_str(m, "href")));
                    let runs = Self::run(s(n, "text"), &Self::rpr(marks, ctx, href.is_some()));
                    match href {
                        Some(h) => {
                            let id = self.rel(REL_HYPERLINK, h.to_string(), true);
                            out.push_str(&format!(
                                "<w:hyperlink r:id=\"{id}\">{runs}</w:hyperlink>"
                            ));
                        }
                        None => out.push_str(&runs),
                    }
                }
                "mention" => out.push_str(&Self::run(
                    &format!("@{}", attr_str(n, "label")),
                    &Self::rpr(&[], Ctx { bold: true, ..ctx }, false),
                )),
                "dateMention" => out.push_str(&Self::run(
                    &crate::export::date_text(attr_str(n, "date")),
                    &Self::rpr(&[], ctx, false),
                )),
                "hardBreak" => out.push_str("<w:r><w:br/></w:r>"),
                _ => {
                    let inner = self.inline(children(n), ctx);
                    out.push_str(&inner);
                }
            }
        }
        out
    }

    fn link_para(&mut self, ctx: Ctx, label: &str, url: &str) {
        let runs = match safe_url(url) {
            Some(u) => {
                let id = self.rel(REL_HYPERLINK, u.to_string(), true);
                format!(
                    "<w:hyperlink r:id=\"{id}\">{}</w:hyperlink>",
                    Self::run(label, &Self::rpr(&[], ctx, true))
                )
            }
            None => Self::run(label, &Self::rpr(&[], ctx, false)),
        };
        self.para(ctx, None, "", &runs);
    }

    fn blocks(&mut self, nodes: &[Value], ctx: Ctx) {
        for n in nodes {
            self.block(n, ctx);
        }
    }

    fn list(&mut self, n: &Value, ctx: Ctx) {
        let kind = s(n, "type");
        let num = match kind {
            "orderedList" => {
                let id = 2 + self.ordered.len() as u32;
                self.ordered.push(id);
                Some(id)
            }
            "bulletList" => Some(1),
            _ => None,
        };
        let level = ctx.level;
        for item in children(n) {
            let mut first = true;
            for c in children(item) {
                let inner = Ctx {
                    level: level + 1,
                    ..ctx
                };
                if first && s(c, "type") == "paragraph" {
                    first = false;
                    let mut runs = String::new();
                    let ppr = match num {
                        Some(id) => format!(
                            "<w:numPr><w:ilvl w:val=\"{}\"/><w:numId w:val=\"{id}\"/></w:numPr>",
                            level.min(8)
                        ),
                        None => {
                            let glyph = if attr(item, "checked").as_bool() == Some(true) {
                                "\u{2612} "
                            } else {
                                "\u{2610} "
                            };
                            runs.push_str(&Self::run(glyph, ""));
                            format!("<w:ind w:left=\"{}\"/>", 360 * (level + 1))
                        }
                    };
                    runs.push_str(&self.inline(children(c), ctx));
                    self.para(ctx, Some("ListParagraph"), &ppr, &runs);
                } else if s(c, "type") == "paragraph" {
                    let runs = self.inline(children(c), ctx);
                    let ppr = format!("<w:ind w:left=\"{}\"/>", 720 * (level + 1));
                    self.para(ctx, Some("ListParagraph"), &ppr, &runs);
                } else {
                    self.block(c, inner);
                }
            }
        }
    }

    fn table(&mut self, rows: &[Vec<(bool, Vec<Value>)>], ctx: Ctx) {
        let cols = rows.iter().map(Vec::len).max().unwrap_or(0);
        if cols == 0 {
            return;
        }
        let w = 9000 / cols;
        self.body.push_str(
            "<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/><w:tblW w:w=\"5000\" w:type=\"pct\"/>\
             <w:tblLook w:val=\"04A0\" w:firstRow=\"1\" w:lastRow=\"0\" w:firstColumn=\"0\" w:lastColumn=\"0\" w:noHBand=\"0\" w:noVBand=\"1\"/></w:tblPr><w:tblGrid>",
        );
        for _ in 0..cols {
            self.body.push_str(&format!("<w:gridCol w:w=\"{w}\"/>"));
        }
        self.body.push_str("</w:tblGrid>");
        for row in rows {
            let header = !row.is_empty() && row.iter().all(|c| c.0);
            self.body.push_str("<w:tr>");
            if header {
                self.body.push_str("<w:trPr><w:tblHeader/></w:trPr>");
            }
            for i in 0..cols {
                let (head, content) = row.get(i).cloned().unwrap_or((false, vec![]));
                self.body.push_str(&format!(
                    "<w:tc><w:tcPr><w:tcW w:w=\"{w}\" w:type=\"dxa\"/>"
                ));
                if head {
                    self.body
                        .push_str("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F4F4F5\"/>");
                }
                self.body.push_str("</w:tcPr>");
                let before = self.body.len();
                let cell_ctx = Ctx {
                    bold: head || ctx.bold,
                    level: 0,
                    style: None,
                    fill: None,
                };
                self.blocks(&content, cell_ctx);
                if self.body.len() == before {
                    self.body.push_str("<w:p/>");
                }
                self.body.push_str("</w:tc>");
            }
            self.body.push_str("</w:tr>");
        }
        self.body.push_str("</w:tbl>");
        // Word needs a paragraph between two adjacent tables and before a cell end.
        self.body.push_str("<w:p/>");
    }

    fn image(&mut self, n: &Value, ctx: Ctx) {
        let src = attr_str(n, "src");
        let alt = attr_str(n, "alt");
        let caption = attr_str(n, "caption");
        let embedded = self
            .images
            .get(src)
            .and_then(|b| image_info(b).map(|i| (b.clone(), i)));
        match embedded {
            Some((bytes, (ext, w, h))) => {
                let run = self.drawing(bytes, ext, w, h, alt);
                self.para(ctx, None, "", &run);
            }
            None => {
                self.notes.push(format!("image not embedded: {src}"));
                let label = if alt.is_empty() {
                    "Image".to_string()
                } else {
                    format!("Image: {alt}")
                };
                self.link_para(ctx, &label, src);
            }
        }
        if !caption.is_empty() {
            self.para(ctx, Some("Caption"), "", &Self::run(caption, ""));
        }
    }

    /// An inline picture run, `w`×`h` CSS px (scaled down to the text width).
    fn drawing(&mut self, bytes: Vec<u8>, ext: &str, w: u32, h: u32, alt: &str) -> String {
        self.next_pic += 1;
        let pic = self.next_pic;
        let name = format!("image{pic}.{ext}");
        let rid = self.rel(REL_IMAGE, format!("media/{name}"), false);
        self.media.push((name.clone(), bytes));
        let (mut cx, mut cy) = (
            u64::from(w.max(1)) * EMU_PER_PX,
            u64::from(h.max(1)) * EMU_PER_PX,
        );
        if cx > MAX_WIDTH_EMU {
            cy = cy * MAX_WIDTH_EMU / cx;
            cx = MAX_WIDTH_EMU;
        }
        let descr = xml_escape(alt);
        format!(
            "<w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">\
                     <wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:docPr id=\"{pic}\" name=\"Picture {pic}\" descr=\"{descr}\"/>\
                     <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>\
                     <a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\
                     <pic:pic><pic:nvPicPr><pic:cNvPr id=\"{pic}\" name=\"{name}\"/><pic:cNvPicPr/></pic:nvPicPr>\
                     <pic:blipFill><a:blip r:embed=\"{rid}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>\
                     <pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
                     <a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>\
                     </a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"
        )
    }

    /// A board as a PNG (rendered at 2×, shown at 1×) with a caption; a text note if rendering
    /// fails.
    fn board(&mut self, id: &str, ctx: Ctx) {
        let (shapes, texts) = crate::board::summary(self.doc, id);
        let svg = crate::board::to_svg_with_images(self.doc, id, self.images);
        let png = crate::board::to_png(&svg, 2.0)
            .ok()
            .and_then(|b| image_info(&b).map(|(_, w, h)| (b, w, h)));
        match png {
            Some((bytes, w, h)) => {
                let alt = if texts.is_empty() {
                    format!("Whiteboard with {shapes} shapes")
                } else {
                    format!("Whiteboard: {}", texts.join("; "))
                };
                let run = self.drawing(bytes, "png", w.div_ceil(2), h.div_ceil(2), &alt);
                self.para(ctx, None, "", &run);
                self.para(ctx, Some("Caption"), "", &Self::run("Whiteboard", ""));
            }
            None => {
                let BoardInfo { shapes, texts } = board_info(self.doc, id);
                self.notes.push("board exported as a note".into());
                let mut note = format!(
                    "Whiteboard with {shapes} shape{}. Open the canvas in OpenCanvas to view it.",
                    if shapes == 1 { "" } else { "s" }
                );
                if !texts.is_empty() {
                    note.push_str(&format!(" Text on the board: {}.", texts.join("; ")));
                }
                self.para(
                    Ctx {
                        fill: Some("F1F1F3"),
                        ..ctx
                    },
                    None,
                    "",
                    &Self::run(&note, "<w:rPr><w:i/></w:rPr>"),
                );
            }
        }
    }

    fn block(&mut self, n: &Value, ctx: Ctx) {
        match s(n, "type") {
            "paragraph" => {
                let runs = self.inline(children(n), ctx);
                self.para(ctx, None, "", &runs);
            }
            "heading" => {
                let level = attr(n, "level").as_u64().unwrap_or(1).clamp(1, 3);
                let runs = self.inline(children(n), ctx);
                self.para(ctx, Some(&format!("Heading{level}")), "", &runs);
            }
            "bulletList" | "orderedList" | "taskList" => self.list(n, ctx),
            "listItem" | "taskItem" => self.blocks(children(n), ctx),
            "blockquote" => self.blocks(
                children(n),
                Ctx {
                    style: Some("Quote"),
                    ..ctx
                },
            ),
            "callout" => {
                let fill = match attr_str(n, "tone") {
                    "blue" => "E8F0FE",
                    "green" => "E7F6EC",
                    "yellow" | "amber" | "orange" => "FFF6DB",
                    "red" | "pink" => "FDECEC",
                    "purple" | "violet" => "F1ECFD",
                    _ => "F1F1F3",
                };
                self.blocks(
                    children(n),
                    Ctx {
                        fill: Some(fill),
                        ..ctx
                    },
                );
            }
            "codeBlock" => {
                let text: String = children(n).iter().map(|t| s(t, "text")).collect();
                for line in text.split('\n') {
                    let runs = Self::run(line, "");
                    self.para(Ctx { style: None, ..ctx }, Some("Code"), "", &runs);
                }
            }
            "horizontalRule" => self.para(
                ctx,
                None,
                "<w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"BFBFBF\"/></w:pBdr>",
                "",
            ),
            "image" => self.image(n, ctx),
            "table" => {
                let rows: Vec<Vec<(bool, Vec<Value>)>> = children(n)
                    .iter()
                    .map(|r| {
                        children(r)
                            .iter()
                            .map(|c| (s(c, "type") == "tableHeader", children(c).to_vec()))
                            .collect()
                    })
                    .collect();
                self.table(&rows, ctx);
            }
            "toggle" => {
                for c in children(n) {
                    match s(c, "type") {
                        "toggleSummary" => {
                            let runs = self.inline(children(c), Ctx { bold: true, ..ctx });
                            self.para(ctx, None, "", &runs);
                        }
                        _ => self.blocks(children(c), ctx),
                    }
                }
            }
            "database" => {
                let (name, header, rows) = database_table(self.doc, attr_str(n, "dbId"));
                self.para(ctx, Some("Caption"), "", &Self::run(&name, ""));
                let cell = |t: &String| vec![serde_json::json!({"type": "paragraph", "content": [{"type": "text", "text": t}]})];
                let mut table: Vec<Vec<(bool, Vec<Value>)>> =
                    vec![header.iter().map(|h| (true, cell(h))).collect()];
                table.extend(rows.iter().map(|r| r.iter().map(|c| (false, cell(c))).collect()));
                self.table(&table, ctx);
            }
            "board" => self.board(attr_str(n, "boardId"), ctx),
            "bookmark" => {
                let url = attr_str(n, "url");
                let title = attr_str(n, "title");
                self.link_para(ctx, if title.is_empty() { url } else { title }, url);
            }
            "embed" => {
                let url = attr_str(n, "url");
                let title = attr_str(n, "title");
                let label = if title.is_empty() { attr_str(n, "provider") } else { title };
                self.link_para(ctx, if label.is_empty() { url } else { label }, url);
            }
            "fileAttachment" => {
                let name = attr_str(n, "name");
                self.link_para(ctx, if name.is_empty() { "Attachment" } else { name }, attr_str(n, "url"));
            }
            _ => self.blocks(children(n), ctx),
        }
    }
}

fn styles_xml() -> String {
    let heading = |n: u8, size: u8, before: u16| {
        format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"Heading{n}\"><w:name w:val=\"heading {n}\"/><w:basedOn w:val=\"Normal\"/>\
             <w:next w:val=\"Normal\"/><w:uiPriority w:val=\"9\"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before=\"{before}\" w:after=\"80\"/>\
             <w:outlineLvl w:val=\"{}\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"{size}\"/><w:szCs w:val=\"{size}\"/></w:rPr></w:style>",
            n - 1
        )
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>{}{}{}<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D4D4D8"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="52525B"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F4F4F5"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="60"/></w:pPr><w:rPr><w:b/><w:color w:val="52525B"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="40"/><w:contextualSpacing/></w:pPr></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="2563EB"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D4D4D8"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D4D4D8"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D4D4D8"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D4D4D8"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="D4D4D8"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D4D4D8"/></w:tblBorders></w:tblPr></w:style></w:styles>"#,
        heading(1, 36, 360),
        heading(2, 30, 280),
        heading(3, 26, 240)
    )
}

fn numbering_xml(ordered: &[u32]) -> String {
    let bullets = ["\u{2022}", "\u{25E6}", "\u{25AA}"];
    let formats = [
        ("decimal", "%{}."),
        ("lowerLetter", "%{}."),
        ("lowerRoman", "%{}."),
    ];
    let mut out = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>"#,
    );
    for l in 0..9 {
        out.push_str(&format!(
            "<w:lvl w:ilvl=\"{l}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"bullet\"/><w:lvlText w:val=\"{}\"/><w:lvlJc w:val=\"left\"/>\
             <w:pPr><w:ind w:left=\"{}\" w:hanging=\"360\"/></w:pPr></w:lvl>",
            bullets[l % 3],
            720 * (l + 1)
        ));
    }
    out.push_str("</w:abstractNum><w:abstractNum w:abstractNumId=\"1\"><w:multiLevelType w:val=\"hybridMultilevel\"/>");
    for l in 0..9 {
        let (fmt, text) = formats[l % 3];
        out.push_str(&format!(
            "<w:lvl w:ilvl=\"{l}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"{fmt}\"/><w:lvlText w:val=\"{}\"/><w:lvlJc w:val=\"left\"/>\
             <w:pPr><w:ind w:left=\"{}\" w:hanging=\"360\"/></w:pPr></w:lvl>",
            text.replace("{}", &(l + 1).to_string()),
            720 * (l + 1)
        ));
    }
    out.push_str("</w:abstractNum><w:num w:numId=\"1\"><w:abstractNumId w:val=\"0\"/></w:num>");
    for id in ordered {
        out.push_str(&format!(
            "<w:num w:numId=\"{id}\"><w:abstractNumId w:val=\"1\"/>"
        ));
        for l in 0..9 {
            out.push_str(&format!(
                "<w:lvlOverride w:ilvl=\"{l}\"><w:startOverride w:val=\"1\"/></w:lvlOverride>"
            ));
        }
        out.push_str("</w:num>");
    }
    out.push_str("</w:numbering>");
    out
}

/// Builds the `.docx`; `images` maps an image `src` to its bytes (only those get embedded).
/// Returns the file and notes about lossy conversions.
pub fn to_docx(
    doc: &Value,
    images: &HashMap<String, Vec<u8>>,
) -> Result<(Vec<u8>, Vec<String>), crate::Error> {
    // BSDK-02: SDK blocks as their template (or fallback) rendering.
    let live = crate::live::expand(doc);
    let expanded = crate::ext::expand(live.as_ref(), &crate::ext::installed());
    let doc = expanded.as_ref();
    let mut w = Writer {
        doc,
        images,
        body: String::new(),
        rels: vec![],
        media: vec![],
        ordered: vec![],
        next_rel: 3,
        next_pic: 0,
        notes: vec![],
    };
    let title = doc["meta"]["title"].as_str().unwrap_or_default();
    let starts_with_h1 = children(doc)
        .first()
        .is_some_and(|n| s(n, "type") == "heading" && attr(n, "level").as_u64() == Some(1));
    if !title.is_empty() && !starts_with_h1 {
        w.para(Ctx::default(), Some("Title"), "", &Writer::run(title, ""));
    }
    w.blocks(children(doc), Ctx::default());
    let document = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:document {NS}><w:body>{}\
         <w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/></w:sectPr>\
         </w:body></w:document>",
        w.body
    );
    let mut rels = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>\
         <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering\" Target=\"numbering.xml\"/>",
    );
    for (id, kind, target, external) in &w.rels {
        rels.push_str(&format!(
            "<Relationship Id=\"{id}\" Type=\"{kind}\" Target=\"{}\"{}/>",
            xml_escape(target),
            if *external {
                " TargetMode=\"External\""
            } else {
                ""
            }
        ));
    }
    rels.push_str("</Relationships>");
    let content_types = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
        <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
        <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
        <Default Extension=\"png\" ContentType=\"image/png\"/><Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/><Default Extension=\"gif\" ContentType=\"image/gif\"/>\
        <Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
        <Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>\
        <Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>\
        <Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/></Types>";
    let root_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
        <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>\
        <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/></Relationships>";
    let core = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" \
         xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">\
         <dc:title>{}</dc:title><dc:creator>OpenCanvas</dc:creator></cp:coreProperties>",
        xml_escape(title)
    );

    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let deflate = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let styles = styles_xml();
    let parts: [(&str, &[u8]); 6] = [
        ("[Content_Types].xml", content_types.as_bytes()),
        ("_rels/.rels", root_rels.as_bytes()),
        ("docProps/core.xml", core.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
        ("word/styles.xml", styles.as_bytes()),
    ];
    for (name, data) in parts {
        zip.start_file(name, deflate)?;
        zip.write_all(data)?;
    }
    zip.start_file("word/numbering.xml", deflate)?;
    zip.write_all(numbering_xml(&w.ordered).as_bytes())?;
    for (name, bytes) in &w.media {
        zip.start_file(
            format!("word/media/{name}"),
            SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
        )?;
        zip.write_all(bytes)?;
    }
    Ok((zip.finish()?.into_inner(), w.notes))
}
