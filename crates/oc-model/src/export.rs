// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Markdown and HTML export from the logical JSON produced by [`crate::doc_to_json`].

use std::collections::HashMap;

use serde_json::Value;

pub(crate) fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

pub(crate) fn attr<'a>(n: &'a Value, key: &str) -> &'a Value {
    n.get("attrs")
        .and_then(|a| a.get(key))
        .unwrap_or(&Value::Null)
}

pub(crate) fn attr_str<'a>(n: &'a Value, key: &str) -> &'a str {
    attr(n, key).as_str().unwrap_or_default()
}

pub(crate) fn children(n: &Value) -> &[Value] {
    n.get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

pub(crate) fn plain_text(n: &Value) -> String {
    if s(n, "type") == "text" {
        return s(n, "text").to_string();
    }
    children(n).iter().map(plain_text).collect()
}

fn cell_value(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(x) => x.clone(),
        Value::Bool(b) => if *b { "yes" } else { "no" }.into(),
        Value::Array(a) => a.iter().map(cell_value).collect::<Vec<_>>().join(", "),
        Value::Object(o) => o.get("v").map(cell_value).unwrap_or_default(),
        other => other.to_string(),
    }
}

/// A database as (title, header, rows) for table rendering.
pub(crate) fn database_table(doc: &Value, id: &str) -> (String, Vec<String>, Vec<Vec<String>>) {
    let db = &doc["databases"][id];
    let name = s(db, "name");
    let fields: Vec<&Value> = db["fields"]
        .as_array()
        .map(|f| f.iter().collect())
        .unwrap_or_default();
    let header = fields.iter().map(|f| s(f, "name").to_string()).collect();
    let order: Vec<String> = match db["order"].as_array() {
        Some(o) => o
            .iter()
            .filter_map(|r| r.as_str().map(String::from))
            .collect(),
        None => db["rows"]
            .as_object()
            .map(|r| r.keys().cloned().collect())
            .unwrap_or_default(),
    };
    // Formula, rollup and relation cells show computed values (ADR-078, DB-A6).
    let computed = crate::formula::rows_with_values(doc, id);
    let rows = order
        .iter()
        .map(|rid| {
            fields
                .iter()
                .map(|f| {
                    let v = &computed.get(rid).unwrap_or(&Value::Null)[s(f, "id")];
                    crate::formula::cell_text(doc, f, v).unwrap_or_else(|| cell_value(v))
                })
                .collect()
        })
        .collect();
    (
        if name.is_empty() {
            "Database".into()
        } else {
            name.into()
        },
        header,
        rows,
    )
}

/// `(field name, description)` for fields that carry a non-blank description, whitespace runs
/// (line breaks included) collapsed to one space.
pub(crate) fn database_notes(doc: &Value, id: &str) -> Vec<(String, String)> {
    doc["databases"][id]["fields"]
        .as_array()
        .map(|f| {
            f.iter()
                .filter_map(|f| {
                    let d = f["description"]
                        .as_str()?
                        .split_whitespace()
                        .collect::<Vec<_>>();
                    (!d.is_empty()).then(|| (s(f, "name").to_string(), d.join(" ")))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) struct BoardInfo {
    pub shapes: usize,
    /// Text of stickies, text shapes and frame labels, in board order.
    pub texts: Vec<String>,
}

pub(crate) fn board_info(doc: &Value, id: &str) -> BoardInfo {
    let board = &doc["boards"][id];
    let shapes = board["shapes"].as_object();
    let order: Vec<&str> = match board["order"].as_array() {
        Some(o) => o.iter().filter_map(Value::as_str).collect(),
        None => shapes
            .map(|m| m.keys().map(String::as_str).collect())
            .unwrap_or_default(),
    };
    let texts = order
        .iter()
        .filter_map(|sid| shapes?.get(*sid))
        .flat_map(|sh| [s(sh, "text"), s(sh, "label")])
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(String::from)
        .collect();
    BoardInfo {
        shapes: shapes.map_or(0, |m| m.len()),
        texts,
    }
}

fn board_note(doc: &Value, id: &str) -> String {
    let shapes = doc["boards"][id]["shapes"]
        .as_object()
        .map_or(0, |m| m.len());
    format!("Whiteboard with {shapes} shapes. Open the canvas in OpenCanvas to view it.")
}

fn title(doc: &Value) -> &str {
    doc["meta"]["title"].as_str().unwrap_or_default()
}

fn starts_with_h1(doc: &Value) -> bool {
    children(doc)
        .first()
        .is_some_and(|n| s(n, "type") == "heading" && attr(n, "level").as_u64() == Some(1))
}

// ---------------- markdown ----------------

/// Export options shared by Markdown and HTML.
#[derive(Default, Clone, Copy)]
pub struct Options<'a> {
    /// Self-contained output (print / PDF): images whose `src` is a key here are inlined as
    /// `data:` URLs, every other image becomes a link (boards drop it), and a CSP forbids
    /// any fetch.
    pub images: Option<&'a HashMap<String, Vec<u8>>>,
    /// Markdown: URL of a board's SVG export (`GET /v1/export/board/:id.svg`), linked under
    /// the board's note.
    pub board_link: Option<&'a dyn Fn(&str) -> String>,
}

struct Cx<'a> {
    doc: &'a Value,
    opts: &'a Options<'a>,
}

fn data_url(bytes: &[u8]) -> Option<String> {
    use base64::Engine;
    let mime = crate::board::sniff_image(bytes)?;
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// OFF-05 (docs/34 §3.3, ADR-064): what an export shows for an image added offline whose
/// device has not uploaded it yet (`src = "oc-pending:<uuid>"`).
pub const PENDING_TEXT: &str = "Image uploading from another device";
/// The same for a file attachment (`url = "oc-pending:<uuid>"`).
pub const PENDING_FILE_TEXT: &str = "File uploading from another device";

/// An `oc-pending:` asset reference (never fetched, linked or embedded).
pub fn is_pending(u: &str) -> bool {
    u.trim_start().starts_with("oc-pending:")
}

pub fn to_markdown(doc: &Value) -> String {
    to_markdown_with(doc, &Options::default())
}

pub fn to_markdown_with(doc: &Value, opts: &Options) -> String {
    // LIVE-05: references the server did not resolve show their caption or snapshot.
    let live = crate::live::expand(doc);
    let doc = live.as_ref();
    let cx = &Cx { doc, opts };
    let mut out = String::new();
    if !title(doc).is_empty() && !starts_with_h1(doc) {
        out.push_str(&format!("# {}\n\n", md_text(title(doc))));
    }
    let blocks: Vec<String> = children(doc)
        .iter()
        .map(|n| md_block(cx, n))
        .filter(|b| !b.is_empty())
        .collect();
    out.push_str(&blocks.join("\n\n"));
    out.push('\n');
    out
}

/// Whether `u` may be a link or image target in Markdown: web and mail URLs, fragments, and
/// relative references (no scheme before the first `/`, `?` or `#`). Everything else
/// (`javascript:`, `data:`, `vbscript:`, …) is refused (SEC-15/16).
pub(crate) fn safe_target(u: &str) -> bool {
    let t = u.trim();
    if t.is_empty() {
        return false;
    }
    let l = t.to_ascii_lowercase();
    if ["http://", "https://", "mailto:", "/", "#"]
        .iter()
        .any(|p| l.starts_with(p))
    {
        return true;
    }
    match t.find(':') {
        None => true,
        Some(colon) => t.find(['/', '?', '#']).is_some_and(|sep| sep < colon),
    }
}

/// A Markdown link destination for `u`, or `None` when the target is not [`safe_target`].
/// Characters that would end the destination or be decoded by a renderer are encoded:
/// a schemeless `&` could otherwise spell `javascript&colon;`.
fn md_url(u: &str) -> Option<String> {
    let t = u.trim();
    if !safe_target(t) {
        return None;
    }
    let schemeless = !t.to_ascii_lowercase().starts_with("http") && !t.starts_with("mailto:");
    let mut out = String::with_capacity(t.len());
    for c in t.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            '\\' => out.push_str("%5C"),
            '&' if schemeless => out.push_str("%26"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    Some(out)
}

/// Text outside code spans: `<` is backslash-escaped so it can never open raw HTML.
fn md_text(t: &str) -> String {
    t.replace('<', "\\<")
}

fn md_inline(nodes: &[Value]) -> String {
    nodes
        .iter()
        .map(|n| match s(n, "type") {
            "text" => {
                let code = n
                    .get("marks")
                    .and_then(Value::as_array)
                    .is_some_and(|m| m.iter().any(|m| s(m, "type") == "code"));
                let mut t = if code {
                    s(n, "text").to_string()
                } else {
                    md_text(s(n, "text"))
                };
                let mut link = None;
                for m in n
                    .get("marks")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    t = match s(m, "type") {
                        "bold" => format!("**{t}**"),
                        "italic" => format!("*{t}*"),
                        "strike" => format!("~~{t}~~"),
                        "code" => format!("`{t}`"),
                        "link" => {
                            link = Some(attr_str(m, "href").to_string());
                            t
                        }
                        _ => t,
                    };
                }
                match link.as_deref().and_then(md_url) {
                    Some(href) => format!("[{t}]({href})"),
                    None => t,
                }
            }
            "mention" => format!("@{}", md_text(attr_str(n, "label"))),
            "dateMention" => iso_date(attr_str(n, "date"))
                .unwrap_or_default()
                .to_string(),
            "hardBreak" => "  \n".into(),
            _ => md_inline(children(n)),
        })
        .collect()
}

fn indent(text: &str, pad: &str) -> String {
    text.lines()
        .enumerate()
        .map(|(i, l)| {
            if i == 0 || l.is_empty() {
                l.to_string()
            } else {
                format!("{pad}{l}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn md_children(cx: &Cx, n: &Value, sep: &str) -> String {
    children(n)
        .iter()
        .map(|c| md_block(cx, c))
        .filter(|b| !b.is_empty())
        .collect::<Vec<_>>()
        .join(sep)
}

fn md_table(header: &[String], rows: &[Vec<String>]) -> String {
    if header.is_empty() {
        return String::new();
    }
    let esc = |c: &String| {
        c.replace('|', "\\|")
            .replace('\n', " ")
            .replace("\\<", "<")
            .replace('<', "\\<")
    };
    let mut out = format!(
        "| {} |\n",
        header.iter().map(esc).collect::<Vec<_>>().join(" | ")
    );
    out.push_str(&format!("|{}\n", " --- |".repeat(header.len())));
    for r in rows {
        let mut cells: Vec<String> = r.iter().map(esc).collect();
        cells.resize(header.len(), String::new());
        out.push_str(&format!("| {} |\n", cells.join(" | ")));
    }
    out.trim_end().to_string()
}

fn md_block(cx: &Cx, n: &Value) -> String {
    match s(n, "type") {
        "paragraph" => md_inline(children(n)),
        "heading" => {
            let level = attr(n, "level").as_u64().unwrap_or(1).clamp(1, 6) as usize;
            format!("{} {}", "#".repeat(level), md_inline(children(n)))
        }
        "bulletList" | "orderedList" | "taskList" => children(n)
            .iter()
            .enumerate()
            .map(|(i, item)| {
                let marker = match (s(n, "type"), attr(item, "checked").as_bool()) {
                    ("orderedList", _) => format!("{}. ", i + 1),
                    (_, Some(true)) => "- [x] ".into(),
                    ("taskList", _) => "- [ ] ".into(),
                    _ => "- ".into(),
                };
                let body = md_children(cx, item, "\n");
                format!("{marker}{}", indent(&body, &" ".repeat(marker.len())))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        "blockquote" | "callout" => md_children(cx, n, "\n\n")
            .lines()
            .map(|l| format!("> {l}").trim_end().to_string())
            .collect::<Vec<_>>()
            .join("\n"),
        "codeBlock" => format!("```{}\n{}\n```", attr_str(n, "language"), plain_text(n)),
        "horizontalRule" => "---".into(),
        "image" if is_pending(attr_str(n, "src")) => {
            let alt = md_text(attr_str(n, "alt"));
            if alt.is_empty() {
                format!("*[{PENDING_TEXT}]*")
            } else {
                format!("*[{PENDING_TEXT}: {alt}]*")
            }
        }
        "image" => {
            let alt = md_text(attr_str(n, "alt"));
            let img = match md_url(attr_str(n, "src")) {
                Some(src) => format!("![{alt}]({src})"),
                None => alt,
            };
            match attr_str(n, "caption") {
                "" => img,
                c => format!("{img}\n*{}*", md_text(c)),
            }
        }
        "table" => {
            let rows: Vec<Vec<String>> = children(n)
                .iter()
                .map(|r| children(r).iter().map(md_inline_block).collect())
                .collect();
            match rows.split_first() {
                Some((h, rest)) => md_table(h, rest),
                None => String::new(),
            }
        }
        "toggle" => {
            let summary = children(n)
                .iter()
                .find(|c| s(c, "type") == "toggleSummary")
                .map(|c| md_inline(children(c)))
                .unwrap_or_default();
            let body = children(n)
                .iter()
                .find(|c| s(c, "type") == "toggleContent")
                .map(|c| md_children(cx, c, "\n\n"))
                .unwrap_or_default();
            format!("**{summary}**\n\n{body}").trim_end().to_string()
        }
        "database" => {
            let id = attr_str(n, "dbId");
            let (name, header, rows) = database_table(cx.doc, id);
            let mut out = format!("### {}\n\n{}", md_text(&name), md_table(&header, &rows))
                .trim_end()
                .to_string();
            // Field descriptions: one footnote line each under the table (as the web export).
            let notes: Vec<String> = database_notes(cx.doc, id)
                .iter()
                .map(|(f, d)| format!("*{}*: {}", md_text(f), md_text(d)))
                .collect();
            if !notes.is_empty() {
                out.push_str("\n\n");
                out.push_str(&notes.join("\n"));
            }
            out
        }
        "board" => {
            let id = attr_str(n, "boardId");
            let mut out = format!("### Board\n\n*{}*", board_note(cx.doc, id));
            if let Some(link) = cx.opts.board_link {
                out.push_str(&format!("\n\n[Whiteboard (SVG)]({})", link(id)));
            } else {
                // Self-contained: the exported file carries the drawing, never a session URL.
                let svg = crate::board::to_svg_self_contained(cx.doc, id, &Default::default());
                out.push_str(&format!(
                    "\n\n![Whiteboard](data:image/svg+xml;base64,{})",
                    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, svg)
                ));
            }
            out
        }
        "bookmark" => md_link(
            fallback(attr_str(n, "title"), attr_str(n, "url")),
            attr_str(n, "url"),
        ),
        "embed" => md_link(
            fallback(attr_str(n, "title"), attr_str(n, "provider")),
            attr_str(n, "url"),
        ),
        "fileAttachment" if is_pending(attr_str(n, "url")) => {
            format!("*[{PENDING_FILE_TEXT}: {}]*", md_text(attr_str(n, "name")))
        }
        "fileAttachment" => {
            let meta = file_meta(n).join(", ");
            let link = md_link(attr_str(n, "name"), attr_str(n, "url"));
            if meta.is_empty() {
                link
            } else {
                format!("{link} ({meta})")
            }
        }
        // BSDK-02: the package's Markdown template, else the sanitised fallback, then the
        // block's own children.
        "extBlock" => {
            let r = crate::ext::render(&crate::ext::installed(), n, &cx.doc["ext"]);
            let body = md_children(cx, n, "\n\n");
            [r.markdown, body]
                .into_iter()
                .filter(|x| !x.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n\n")
        }
        "column"
            if n["attrs"]["title"]
                .as_str()
                .is_some_and(|t| !t.trim().is_empty()) =>
        {
            let body = md_children(cx, n, "\n\n");
            format!("**{}**\n\n{body}", md_text(attr_str(n, "title").trim()))
        }
        _ => md_children(cx, n, "\n\n"),
    }
}

/// `textColor` palette (docs/15 §4) as light-theme hex, for exports. Anything else is dropped.
pub fn text_color_hex(name: &str) -> Option<&'static str> {
    Some(match name {
        "gray" => "#55555c",
        "red" => "#b12424",
        "amber" => "#8f5300",
        "green" => "#17703f",
        "blue" => "#2350c8",
        "purple" => "#6538c4",
        "pink" => "#ad2c66",
        _ => return None,
    })
}

/// A `dateMention` date when it is a valid `YYYY-MM-DD`.
pub fn iso_date(d: &str) -> Option<&str> {
    let b = d.as_bytes();
    let ok = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if !ok {
        return None;
    }
    let month: u32 = d[5..7].parse().ok()?;
    let day: u32 = d[8..10].parse().ok()?;
    ((1..=12).contains(&month) && (1..=31).contains(&day)).then_some(d)
}

/// `Dec 4, 2026` for a valid ISO date (exports are not localised).
pub fn date_text(d: &str) -> String {
    const M: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    match iso_date(d) {
        Some(d) => {
            let m: usize = d[5..7].parse().unwrap_or(1);
            let day: u32 = d[8..10].parse().unwrap_or(1);
            format!("{} {day}, {}", M[m - 1], &d[..4])
        }
        None => String::new(),
    }
}

/// `PDF`, `2 KB`: a file block's type (extension) and size, for exports.
pub fn file_meta(n: &Value) -> Vec<String> {
    let name = attr_str(n, "name");
    let mut out = Vec::new();
    if let Some((_, ext)) = name.rsplit_once('.')
        && !ext.is_empty()
        && ext.len() <= 8
        && ext.chars().all(|c| c.is_ascii_alphanumeric())
    {
        out.push(ext.to_ascii_uppercase());
    }
    let size = n["attrs"]["size"].as_f64().unwrap_or(0.0);
    if size >= 1.0 {
        out.push(if size < 1024.0 {
            format!("{size:.0} B")
        } else if size < 1024.0 * 1024.0 {
            format!("{:.0} KB", size / 1024.0)
        } else {
            format!("{:.1} MB", size / 1024.0 / 1024.0)
        });
    }
    out
}

/// `card` or `preview` (docs/15 §4): absent means preview for PDFs, card otherwise.
pub fn file_display(n: &Value) -> &'static str {
    match attr_str(n, "display") {
        "card" => "card",
        "preview" => "preview",
        _ if attr_str(n, "mime") == "application/pdf"
            || attr_str(n, "name").to_ascii_lowercase().ends_with(".pdf") =>
        {
            "preview"
        }
        _ => "card",
    }
}

/// `[label](url)`, or just the label when the URL is not a safe target.
fn md_link(label: &str, url: &str) -> String {
    let label = md_text(label);
    match md_url(url) {
        Some(u) => format!("[{label}]({u})"),
        None => label,
    }
}

fn md_inline_block(n: &Value) -> String {
    children(n)
        .iter()
        .map(|c| md_inline(children(c)))
        .collect::<Vec<_>>()
        .join(" ")
}

fn fallback<'a>(a: &'a str, b: &'a str) -> &'a str {
    if a.is_empty() { b } else { a }
}

// ---------------- html ----------------

pub fn escape(t: &str) -> String {
    t.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub(crate) fn safe_url(u: &str) -> String {
    let lower = u.trim().to_ascii_lowercase();
    let ok = ["http://", "https://", "mailto:", "/", "#"]
        .iter()
        .any(|p| lower.starts_with(p));
    if ok { escape(u) } else { String::new() }
}

pub fn to_html(doc: &Value) -> String {
    to_html_with(doc, &Options::default())
}

pub fn to_html_with(doc: &Value, opts: &Options) -> String {
    // BSDK-02: SDK blocks become their template (or fallback) rendering first.
    let live = crate::live::expand(doc);
    let expanded = crate::ext::expand(live.as_ref(), &crate::ext::installed());
    let doc = expanded.as_ref();
    let cx = &Cx { doc, opts };
    let t = title(doc);
    let mut body = String::new();
    if !t.is_empty() && !starts_with_h1(doc) {
        body.push_str(&format!("<h1>{}</h1>\n", escape(t)));
    }
    for n in children(doc) {
        body.push_str(&html_block(cx, n));
        body.push('\n');
    }
    // Self-contained (print / PDF): everything is inline, so forbid the renderer any fetch.
    let csp = if opts.images.is_some() {
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\">"
    } else {
        ""
    };
    format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\">{csp}<title>{}</title>\
         <style>body{{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px}}\
         table{{border-collapse:collapse}}td,th{{border:1px solid #ddd;padding:4px 8px}}\
         blockquote{{border-left:3px solid #ddd;margin:0;padding-left:12px}}\
         img,figure.board svg{{max-width:100%;height:auto}}figure{{margin:16px 0}}figcaption{{color:#55555e;font-size:14px}}\
         figure.board{{break-inside:avoid}}\
         @media print{{body{{margin:0;max-width:none}}@page{{margin:18mm}}}}</style></head>\n<body>\n{body}</body></html>\n",
        escape(if t.is_empty() { "Canvas" } else { t })
    )
}

pub(crate) fn html_inline(nodes: &[Value]) -> String {
    nodes
        .iter()
        .map(|n| match s(n, "type") {
            "text" => {
                let mut t = escape(s(n, "text"));
                for m in n
                    .get("marks")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    t = match s(m, "type") {
                        "bold" => format!("<strong>{t}</strong>"),
                        "italic" => format!("<em>{t}</em>"),
                        "strike" => format!("<s>{t}</s>"),
                        "underline" => format!("<u>{t}</u>"),
                        "code" => format!("<code>{t}</code>"),
                        "highlight" => format!("<mark>{t}</mark>"),
                        "textColor" => match text_color_hex(attr_str(m, "color")) {
                            Some(hex) => format!(
                                "<span style=\"color:{hex}\" data-color=\"{}\">{t}</span>",
                                attr_str(m, "color")
                            ),
                            None => t,
                        },
                        "link" => format!("<a href=\"{}\">{t}</a>", safe_url(attr_str(m, "href"))),
                        _ => t,
                    };
                }
                t
            }
            "mention" => format!(
                "<span class=\"mention\">@{}</span>",
                escape(attr_str(n, "label"))
            ),
            "dateMention" => match iso_date(attr_str(n, "date")) {
                Some(d) => format!("<time datetime=\"{d}\">{}</time>", date_text(d)),
                None => String::new(),
            },
            "hardBreak" => "<br>".into(),
            _ => html_inline(children(n)),
        })
        .collect()
}

fn html_children(cx: &Cx, n: &Value) -> String {
    children(n).iter().map(|c| html_block(cx, c)).collect()
}

fn html_table(header: &[String], rows: &[Vec<String>]) -> String {
    let th: String = header
        .iter()
        .map(|h| format!("<th>{}</th>", escape(h)))
        .collect();
    let trs: String = rows
        .iter()
        .map(|r| {
            format!(
                "<tr>{}</tr>",
                r.iter()
                    .map(|c| format!("<td>{}</td>", escape(c)))
                    .collect::<String>()
            )
        })
        .collect();
    format!("<table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>")
}

fn html_block(cx: &Cx, n: &Value) -> String {
    match s(n, "type") {
        "paragraph" => format!("<p>{}</p>", html_inline(children(n))),
        "heading" => {
            let l = attr(n, "level").as_u64().unwrap_or(1).clamp(1, 6);
            format!("<h{l}>{}</h{l}>", html_inline(children(n)))
        }
        "bulletList" => format!("<ul>{}</ul>", html_children(cx, n)),
        "orderedList" => format!("<ol>{}</ol>", html_children(cx, n)),
        "taskList" => format!("<ul class=\"tasks\">{}</ul>", html_children(cx, n)),
        "listItem" => format!("<li>{}</li>", html_children(cx, n)),
        "taskItem" => {
            let checked = if attr(n, "checked").as_bool() == Some(true) {
                " checked"
            } else {
                ""
            };
            format!(
                "<li><input type=\"checkbox\" disabled{checked}> {}</li>",
                html_children(cx, n)
            )
        }
        "blockquote" => format!("<blockquote>{}</blockquote>", html_children(cx, n)),
        "callout" => format!("<aside class=\"callout\">{}</aside>", html_children(cx, n)),
        "codeBlock" => format!("<pre><code>{}</code></pre>", escape(&plain_text(n))),
        "horizontalRule" => "<hr>".into(),
        "image" if is_pending(attr_str(n, "src")) => format!(
            "<figure class=\"oc-upload-pending\"><p>{PENDING_TEXT}{}</p></figure>",
            match attr_str(n, "alt") {
                "" => String::new(),
                a => format!(": {}", escape(a)),
            }
        ),
        "image" => {
            let src = attr_str(n, "src");
            let alt = escape(attr_str(n, "alt"));
            let img = match cx.opts.images {
                None => format!("<img src=\"{}\" alt=\"{alt}\">", safe_url(src)),
                Some(images) => match images.get(src).and_then(|b| data_url(b)) {
                    Some(data) => format!("<img src=\"{data}\" alt=\"{alt}\">"),
                    // Not fetched (not on an allowed origin): a link, never a request.
                    None => format!(
                        "<a href=\"{}\">{}</a>",
                        safe_url(src),
                        if alt.is_empty() {
                            "Image".to_string()
                        } else {
                            format!("Image: {alt}")
                        }
                    ),
                },
            };
            match attr_str(n, "caption") {
                "" => format!("<figure>{img}</figure>"),
                c => format!(
                    "<figure>{img}<figcaption>{}</figcaption></figure>",
                    escape(c)
                ),
            }
        }
        "table" => format!("<table>{}</table>", html_children(cx, n)),
        "tableRow" => format!("<tr>{}</tr>", html_children(cx, n)),
        "tableHeader" => format!("<th>{}</th>", html_children(cx, n)),
        "tableCell" => format!("<td>{}</td>", html_children(cx, n)),
        "toggle" => format!("<details>{}</details>", html_children(cx, n)),
        "toggleSummary" => format!("<summary>{}</summary>", html_inline(children(n))),
        "database" => {
            let (name, header, rows) = database_table(cx.doc, attr_str(n, "dbId"));
            format!("<h3>{}</h3>{}", escape(&name), html_table(&header, &rows))
        }
        "board" => {
            let id = attr_str(n, "boardId");
            let svg = match cx.opts.images {
                Some(images) => crate::board::to_svg_self_contained(cx.doc, id, images),
                None => crate::board::to_svg(cx.doc, id),
            };
            format!("<figure class=\"board\">{svg}<figcaption>Whiteboard</figcaption></figure>")
        }
        "bookmark" | "embed" => {
            let label = fallback(attr_str(n, "title"), attr_str(n, "url"));
            format!(
                "<p><a href=\"{}\">{}</a></p>",
                safe_url(attr_str(n, "url")),
                escape(label)
            )
        }
        // FILE-01: a card (link + type + size). `display` records how the canvas showed it; an
        // embedded viewer is never exported.
        "fileAttachment" if is_pending(attr_str(n, "url")) => format!(
            "<p class=\"oc-file oc-upload-pending\">{PENDING_FILE_TEXT}: {}</p>",
            escape(attr_str(n, "name"))
        ),
        "fileAttachment" => format!(
            "<p class=\"oc-file\" data-display=\"{}\"><a href=\"{}\">{}</a> <span class=\"oc-file-meta\">{}</span></p>",
            file_display(n),
            safe_url(attr_str(n, "url")),
            escape(attr_str(n, "name")),
            escape(&file_meta(n).join(" · "))
        ),
        "columns" => {
            // LAY-01: `widths` ("25,75") becomes the grid; only digits and commas get through.
            let w: Vec<u32> = attr_str(n, "widths")
                .split(',')
                .filter_map(|x| x.trim().parse().ok())
                .filter(|x| (1..=100).contains(x))
                .collect();
            let style = if w.len() >= 2 && w.len() == children(n).len() {
                let t: Vec<String> = w.iter().map(|x| format!("{x}fr")).collect();
                format!(
                    " style=\"display:grid;grid-template-columns:{};gap:24px\"",
                    t.join(" ")
                )
            } else {
                String::new()
            };
            format!(
                "<div class=\"columns\"{style}>{}</div>",
                html_children(cx, n)
            )
        }
        "column" => {
            let title = attr_str(n, "title").trim();
            let head = if title.is_empty() {
                String::new()
            } else {
                format!(
                    "<p class=\"column-title\"><strong>{}</strong></p>",
                    escape(title)
                )
            };
            format!("<div class=\"column\">{head}{}</div>", html_children(cx, n))
        }
        _ => html_children(cx, n),
    }
}

#[cfg(test)]
mod tests {

    /// LAY-01: column widths and titles survive in HTML; titles become bold lines in Markdown.
    #[test]
    fn column_titles_and_widths_export() {
        let doc = json!({"content": [{"type": "columns", "attrs": {"widths": "25,75"}, "content": [
            {"type": "column", "attrs": {"title": "Host <app>"}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "a"}]}]},
            {"type": "column", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "b"}]}]}
        ]}]});
        let html = to_html(&doc);
        assert!(html.contains("<div class=\"columns\" style=\"display:grid;grid-template-columns:25fr 75fr;gap:24px\">"), "{html}");
        assert!(html.contains("<div class=\"column\"><p class=\"column-title\"><strong>Host &lt;app&gt;</strong></p><p>a</p></div>"), "{html}");
        let md = to_markdown(&doc);
        assert!(md.contains("**Host \\<app>**\n\na"), "{md}");
    }

    /// UX-02: text colour (palette names only) and date chips in Markdown and HTML.
    #[test]
    fn text_colour_and_dates_export() {
        let doc = json!({"content": [
            {"type": "paragraph", "content": [
                {"type": "text", "text": "Ship "},
                {"type": "text", "text": "it", "marks": [{"type": "textColor", "attrs": {"color": "blue"}}]},
                {"type": "text", "text": " by ", "marks": [{"type": "textColor", "attrs": {"color": "url(x)"}}]},
                {"type": "dateMention", "attrs": {"date": "2026-12-04"}},
                {"type": "dateMention", "attrs": {"date": "<b>"}}
            ]}
        ]});
        let html = to_html(&doc);
        assert!(
            html.contains("Ship <span style=\"color:#2350c8\" data-color=\"blue\">it</span> by <time datetime=\"2026-12-04\">Dec 4, 2026</time>"),
            "{html}"
        );
        assert!(!html.contains("url(x)") && !html.contains("<b>"), "{html}");
        let md = to_markdown(&doc);
        assert!(md.contains("Ship it by 2026-12-04"), "{md}");
    }

    /// FILE-01: a file block exports as a card (name, type, size, how it was shown), never
    /// as an embedded viewer; Markdown keeps a plain link with the type and size.
    #[test]
    fn file_blocks_export_as_cards() {
        let doc = json!({"content": [
            {"type": "fileAttachment", "attrs": {"url": "https://files.example/a.pdf", "name": "Brief <v2>.pdf",
                "mime": "application/pdf", "size": 2048, "display": "preview", "height": 640}},
            {"type": "fileAttachment", "attrs": {"url": "https://files.example/n.txt", "name": "notes.txt", "mime": "text/plain", "size": 0}}
        ]});
        let html = to_html(&doc);
        assert!(
            html.contains("<p class=\"oc-file\" data-display=\"preview\"><a href=\"https://files.example/a.pdf\">Brief &lt;v2&gt;.pdf</a> <span class=\"oc-file-meta\">PDF · 2 KB</span></p>"),
            "{html}"
        );
        assert!(html.contains("<p class=\"oc-file\" data-display=\"card\"><a href=\"https://files.example/n.txt\">notes.txt</a> <span class=\"oc-file-meta\">TXT</span></p>"), "{html}");
        let md = to_markdown(&doc);
        assert!(
            md.contains("[Brief \\<v2>.pdf](https://files.example/a.pdf) (PDF, 2 KB)"),
            "{md}"
        );
        assert!(
            md.contains("[notes.txt](https://files.example/n.txt) (TXT)"),
            "{md}"
        );
    }

    /// SEC-15: Markdown output is rendered by hosts. Script URLs must not become links and raw
    /// HTML in text must not become markup.
    #[test]
    fn markdown_drops_script_urls_and_escapes_html() {
        let doc = json!({"content": [
            {"type": "paragraph", "content": [
                {"type": "text", "text": "<img src=x onerror=alert(1)>"},
                {"type": "text", "text": "click", "marks": [{"type": "link", "attrs": {"href": "javascript:alert(1)"}}]},
                {"type": "text", "text": "ok", "marks": [{"type": "link", "attrs": {"href": "https://x.dev/a b)c"}}]},
                {"type": "text", "text": "<b>", "marks": [{"type": "code"}]}
            ]},
            {"type": "image", "attrs": {"src": "javascript:alert(2)", "alt": "a"}},
            {"type": "bookmark", "attrs": {"url": "data:text/html,<script>alert(3)</script>", "title": "t"}},
            {"type": "embed", "attrs": {"url": "vbscript:x", "provider": "youtube"}},
            {"type": "fileAttachment", "attrs": {"url": " JavaScript:alert(4)", "name": "f"}}
        ]});
        let md = to_markdown(&doc);
        let lower = md.to_ascii_lowercase();
        for bad in ["javascript:", "data:text/html", "vbscript:"] {
            assert!(!lower.contains(bad), "{bad} in {md}");
        }
        assert!(
            !md.replace("\\<", "").replace("`<b>`", "").contains('<'),
            "raw < in {md}"
        );
        assert!(md.contains("\\<img src=x onerror=alert(1)>"), "{md}");
        assert!(
            md.contains("[ok](<https://x.dev/a%20b%29c>)")
                || md.contains("[ok](https://x.dev/a%20b%29c)"),
            "{md}"
        );
        assert!(md.contains("`<b>`"), "code spans stay literal: {md}");
    }
    use super::*;

    /// OFF-05 (ADR-064): an image or file added offline (`oc-pending:<uuid>`) is drawn as a
    /// placeholder, never fetched or linked.
    #[test]
    fn pending_uploads_export_as_placeholders() {
        let doc = json!({"type": "doc", "content": [
            {"type": "image", "attrs": {"src": "oc-pending:7d1c", "pendingBy": "u1", "alt": "chart"}},
            {"type": "fileAttachment", "attrs": {"url": "oc-pending:9f2a", "pendingBy": "u1", "name": "deck.pdf"}},
        ]});
        let md = to_markdown(&doc);
        let html = to_html(&doc);
        for out in [&md, &html] {
            assert!(out.contains(PENDING_TEXT), "{out}");
            assert!(!out.contains("oc-pending"), "{out}");
        }
        assert!(md.contains("chart") && md.contains("deck.pdf"), "{md}");
        assert!(crate::docx::image_sources(&doc).is_empty(), "never fetched");
    }
    use serde_json::json;

    #[test]
    fn markdown_covers_common_blocks() {
        let doc = json!({
            "meta": {"title": "Notes"},
            "databases": {"d1": {"name": "Tasks", "fields": [{"id":"f1","name":"Name"},{"id":"f2","name":"Status"}],
                "order": ["r1"], "rows": {"r1": {"f1": "Ship", "f2": {"v":"Done","c":"green"}}}}},
            "boards": {"b1": {"shapes": {"s1": {}, "s2": {}}}},
            "content": [
                {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Plan"}]},
                {"type":"paragraph","content":[{"type":"text","text":"bold","marks":[{"type":"bold"}]}]},
                {"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"done"}]}]}]},
                {"type":"database","attrs":{"dbId":"d1"}},
                {"type":"board","attrs":{"boardId":"b1"}}
            ]
        });
        let md = to_markdown(&doc);
        assert!(md.starts_with("# Notes\n\n## Plan"));
        assert!(md.contains("**bold**"));
        assert!(md.contains("- [x] done"));
        assert!(md.contains("### Tasks"));
        assert!(md.contains("| Ship | Done |"));
        assert!(md.contains("2 shapes"));
        let html = to_html(&doc);
        assert!(html.contains("<strong>bold</strong>"));
        assert!(html.contains("<td>Done</td>"));
    }

    #[test]
    fn markdown_lists_field_descriptions_under_the_table() {
        let doc = json!({
            "databases": {"d1": {"name": "Tasks", "fields": [
                {"id":"f1","name":"Name"},
                {"id":"f2","name":"Points","description":"Story points,\nfibonacci only"},
                {"id":"f3","name":"Due","description":"   "}],
                "order": ["r1"], "rows": {"r1": {"f1": "Ship", "f2": 3}}}},
            "content": [{"type":"database","attrs":{"dbId":"d1"}}]
        });
        let md = to_markdown(&doc);
        assert!(
            md.contains("| Ship | 3 |  |\n\n*Points*: Story points, fibonacci only"),
            "{md}"
        );
        assert!(!md.contains("*Due*"), "{md}");
    }

    #[test]
    fn html_blocks_javascript_urls() {
        let doc =
            json!({"content":[{"type":"image","attrs":{"src":"javascript:alert(1)","alt":"<x>"}}]});
        let html = to_html(&doc);
        assert!(!html.contains("javascript:"));
        assert!(html.contains("&lt;x&gt;"));
    }

    fn board_doc() -> Value {
        json!({
            "boards": {"b1": {"order": ["s1", "i1"], "shapes": {
                "s1": {"type": "sticky", "x": 0, "y": 0, "w": 150, "h": 110, "text": "Idea"},
                "i1": {"type": "image", "x": 200, "y": 0, "w": 40, "h": 40, "src": "https://cdn.example/b.png"}}}},
            "content": [
                {"type":"board","attrs":{"boardId":"b1"}},
                {"type":"image","attrs":{"src":"https://cdn.example/a.png","alt":"A"}},
                {"type":"image","attrs":{"src":"https://evil.example/x.png","alt":"X"}}
            ]
        })
    }

    #[test]
    fn html_inlines_board_svg() {
        let html = to_html(&board_doc());
        assert!(html.contains("<figure class=\"board\"><svg "), "{html}");
        assert!(html.contains(">Idea</text>"));
        assert!(html.contains("<figcaption>Whiteboard</figcaption>"));
    }

    #[test]
    fn markdown_links_the_board_svg() {
        let link = |id: &str| format!("https://oc.example/v1/export/board/{id}.svg?ticket=T");
        let md = to_markdown_with(
            &board_doc(),
            &Options {
                board_link: Some(&link),
                ..Default::default()
            },
        );
        assert!(
            md.contains("[Whiteboard (SVG)](https://oc.example/v1/export/board/b1.svg?ticket=T)"),
            "{md}"
        );
        assert!(md.contains("2 shapes"));
        assert!(!to_markdown(&board_doc()).contains("/v1/export/board/"));
    }

    #[test]
    fn markdown_embeds_the_board_without_any_url() {
        let md = to_markdown(&board_doc());
        let b64 = md
            .split("![Whiteboard](data:image/svg+xml;base64,")
            .nth(1)
            .and_then(|r| r.split(')').next())
            .expect("board embedded as a data URL");
        let svg = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64).unwrap();
        assert!(String::from_utf8(svg).unwrap().contains(">Idea</text>"));
        assert!(!md.contains("ticket="));
    }

    #[test]
    fn self_contained_html_fetches_nothing() {
        let png = b"\x89PNG\r\n\x1a\n0000000000000000".to_vec();
        let mut images = std::collections::HashMap::new();
        images.insert("https://cdn.example/a.png".to_string(), png.clone());
        images.insert("https://cdn.example/b.png".to_string(), png);
        let html = to_html_with(
            &board_doc(),
            &Options {
                images: Some(&images),
                ..Default::default()
            },
        );
        assert!(html.contains("<img src=\"data:image/png;base64,"), "{html}");
        assert!(html.contains("<image href=\"data:image/png;base64,"));
        // The unfetched image is a link, not something the renderer would load.
        assert!(!html.contains("src=\"https://evil.example"));
        assert!(html.contains("href=\"https://evil.example/x.png\""));
        assert!(html.contains("default-src 'none'"));
        assert!(!html.contains("src=\"http"));
    }
}
