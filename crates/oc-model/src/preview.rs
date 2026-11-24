// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! RND-01: the read-only preview of a canvas, rendered on the server from the logical JSON
//! ([`crate::doc_to_json`]) with the same escaping and URL rules as the HTML export, but in
//! the editor's own markup (`.ProseMirror` content, `.callout`, `.toggle`, `.cols`,
//! `.figure`, `.wideblock`, …) so the editor's stylesheet makes it look like the read-only
//! editor. The editor shell shows it until the live editor has mounted (docs/03 §3.5).
//!
//! Never rendered: the `comments` root (threads) and comment anchors (`commentMark` is
//! dropped, so neither thread ids nor highlights reach any role), the `people` root, and
//! e-mail addresses. Databases render as a static table of the first [`MAX_DB_ROWS`] rows;
//! boards as their SVG export, fitted into the block's box; a board whose SVG is larger than
//! [`MAX_BOARD_SVG`] keeps the editor's loading skeleton instead.

use serde_json::Value;

use crate::export::{
    attr, attr_str, children, database_table, escape, file_display, file_meta, html_inline,
    plain_text, s, safe_url,
};

/// The body stops at a top-level block boundary once it passes this many bytes.
pub const MAX_PREVIEW_BYTES: usize = 2 * 1024 * 1024;
/// A board whose SVG is larger shows the loading skeleton instead.
pub const MAX_BOARD_SVG: usize = 512 * 1024;
/// Rows of a database shown in the preview.
pub const MAX_DB_ROWS: usize = 100;
/// Nesting depth past which blocks are left out (the editor caps nesting far lower).
const MAX_DEPTH: usize = 48;

/// The preview body: the document header (icon tile and title) and the `.ProseMirror`
/// content, without the surrounding shell. `truncated` is true when [`MAX_PREVIEW_BYTES`]
/// cut it short.
pub struct Preview {
    /// The top bar's breadcrumb (`.crumbs`: icon tile and title), as the editor shows it.
    pub crumbs: String,
    pub html: String,
    pub truncated: bool,
}

const TONES: [&str; 7] = ["gray", "blue", "green", "amber", "red", "purple", "pink"];

fn tone(t: &str) -> &'static str {
    TONES.iter().copied().find(|x| *x == t).unwrap_or("gray")
}

/// Renders the preview body of `doc` (the logical JSON, e-mails already stripped).
pub fn render(doc: &Value) -> Preview {
    // BSDK-02: SDK blocks as their template (or fallback) rendering.
    let expanded = crate::ext::expand(doc, &crate::ext::installed());
    let doc = expanded.as_ref();
    let meta = &doc["meta"];
    let title = s(meta, "title");
    let mut html = format!(
        "<div class=\"dhead\"><div class=\"dicon tone-{}\"></div><h1 class=\"dtitle\">{}</h1><div class=\"dmeta\"></div></div>",
        tone(s(meta, "tone")),
        escape(title)
    );
    html.push_str(
        "<div class=\"ProseMirror oc-pv-content\" contenteditable=\"false\" translate=\"no\">",
    );
    let mut truncated = false;
    for n in children(doc) {
        if html.len() > MAX_PREVIEW_BYTES {
            truncated = true;
            break;
        }
        html.push_str(&block(doc, n, 0, true));
    }
    html.push_str("</div>");
    let crumbs = format!(
        "<div class=\"crumbs\"><span class=\"ctile tone-{}\"></span><span class=\"cname\">{}</span></div>",
        tone(s(meta, "tone")),
        escape(fallback(title, "Untitled"))
    );
    Preview {
        crumbs,
        html,
        truncated,
    }
}

fn kids(doc: &Value, n: &Value, depth: usize) -> String {
    children(n)
        .iter()
        .map(|c| block(doc, c, depth + 1, false))
        .collect()
}

fn inline(n: &Value) -> String {
    html_inline(children(n))
}

/// Host of a URL for captions (`https://a.example/x` → `a.example`).
fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    rest.split(['/', '?', '#']).next().unwrap_or_default()
}

fn wide(kind: &str, id: &str, inner: String) -> String {
    format!(
        "<div class=\"react-renderer\"><div class=\"stubhost wideblock\" data-{kind}=\"{}\">{inner}</div></div>",
        escape(id)
    )
}

fn block(doc: &Value, n: &Value, depth: usize, top: bool) -> String {
    if depth > MAX_DEPTH {
        return String::new();
    }
    match s(n, "type") {
        "paragraph" => format!("<p>{}</p>", inline(n)),
        "heading" => {
            let l = attr(n, "level").as_u64().unwrap_or(1).clamp(1, 3);
            format!("<h{l}>{}</h{l}>", inline(n))
        }
        "bulletList" => format!("<ul>{}</ul>", kids(doc, n, depth)),
        "orderedList" => {
            let start = attr(n, "start").as_u64().filter(|s| *s != 1);
            match start {
                Some(st) => format!("<ol start=\"{st}\">{}</ol>", kids(doc, n, depth)),
                None => format!("<ol>{}</ol>", kids(doc, n, depth)),
            }
        }
        "listItem" => format!("<li>{}</li>", kids(doc, n, depth)),
        "taskList" => format!("<ul data-type=\"taskList\">{}</ul>", kids(doc, n, depth)),
        "taskItem" => {
            let on = attr(n, "checked").as_bool() == Some(true);
            format!(
                "<li data-checked=\"{on}\"><label><input type=\"checkbox\" disabled{}><span></span></label><div>{}</div></li>",
                if on { " checked" } else { "" },
                kids(doc, n, depth)
            )
        }
        "blockquote" => format!("<blockquote>{}</blockquote>", kids(doc, n, depth)),
        "callout" => {
            let t = tone(attr_str(n, "tone"));
            format!(
                "<div class=\"callout\" data-tone=\"{t}\"><span class=\"cic tone-{t}\"></span><div class=\"callout-body\">{}</div></div>",
                kids(doc, n, depth)
            )
        }
        "codeBlock" => {
            let lang = attr_str(n, "language");
            let label = if lang.is_empty() { "Auto-detect" } else { lang };
            format!(
                "<div class=\"code\"><div class=\"chead\"><span class=\"clang\">{}</span><span class=\"oc-pv-ib\"></span></div><pre><code>{}</code></pre></div>",
                escape(label),
                escape(&plain_text(n))
            )
        }
        "horizontalRule" => "<hr>".into(),
        "image" => {
            let src = safe_url(attr_str(n, "src"));
            let alt = escape(fallback(attr_str(n, "alt"), attr_str(n, "caption")));
            let width = attr(n, "width")
                .as_f64()
                .filter(|w| (5.0..=100.0).contains(w))
                .map(|w| format!(" style=\"width:{w:.0}%\""))
                .unwrap_or_default();
            let align = match attr_str(n, "align") {
                a @ ("left" | "right") => format!(" data-align=\"{a}\""),
                _ => String::new(),
            };
            let cap = match attr_str(n, "caption") {
                "" => String::new(),
                c => format!("<div class=\"fcap\">{}</div>", escape(c)),
            };
            let img = if src.is_empty() {
                "<div class=\"fblocked\"></div>".to_string()
            } else {
                format!("<img src=\"{src}\" alt=\"{alt}\" loading=\"lazy\">")
            };
            format!(
                "<div class=\"react-renderer\"><figure class=\"figure\"{align}{width}><div class=\"fwrap\">{img}</div>{cap}</figure></div>"
            )
        }
        "table" => format!(
            "<div class=\"tableWrapper\"><table><tbody>{}</tbody></table></div>",
            kids(doc, n, depth)
        ),
        "tableRow" => format!("<tr>{}</tr>", kids(doc, n, depth)),
        "tableHeader" | "tableCell" => {
            let tag = if s(n, "type") == "tableHeader" {
                "th"
            } else {
                "td"
            };
            let span = |k: &str| {
                attr(n, k)
                    .as_u64()
                    .filter(|v| *v > 1 && *v <= 1000)
                    .map(|v| format!(" {k}=\"{v}\""))
                    .unwrap_or_default()
            };
            format!(
                "<{tag}{}{}>{}</{tag}>",
                span("colspan"),
                span("rowspan"),
                kids(doc, n, depth)
            )
        }
        "toggle" => {
            let open = attr(n, "open").as_bool() != Some(false);
            format!(
                "<div class=\"toggle{}\"><span class=\"tchev\"></span>{}</div>",
                if open { " open" } else { "" },
                kids(doc, n, depth)
            )
        }
        "toggleSummary" => format!("<div class=\"toggle-summary\">{}</div>", inline(n)),
        "toggleContent" => format!(
            "<div class=\"toggle-content\">{}</div>",
            kids(doc, n, depth)
        ),
        "columns" => {
            let w: Vec<u32> = attr_str(n, "widths")
                .split(',')
                .filter_map(|x| x.trim().parse().ok())
                .filter(|x| (1..=100).contains(x))
                .collect();
            let style = if w.len() >= 2 && w.len() == children(n).len() {
                let t: Vec<String> = w.iter().map(|x| format!("minmax(0,{x}fr)")).collect();
                format!(" style=\"grid-template-columns:{}\"", t.join(" "))
            } else {
                String::new()
            };
            format!("<div class=\"cols\"{style}>{}</div>", kids(doc, n, depth))
        }
        "column" => format!("<div class=\"column\">{}</div>", kids(doc, n, depth)),
        "database" => {
            let id = attr_str(n, "dbId");
            let inner = database(doc, id);
            if top {
                wide("db", id, inner)
            } else {
                format!("<div class=\"stubhost\">{inner}</div>")
            }
        }
        "board" => {
            let id = attr_str(n, "boardId");
            let svg = crate::board::to_svg(doc, id);
            let inner = if svg.len() > MAX_BOARD_SVG {
                "<div class=\"bskel board\" aria-label=\"Whiteboard\"></div>".to_string()
            } else {
                format!(
                    "<div class=\"oc-pv-board\" role=\"img\" aria-label=\"Whiteboard\">{svg}</div>"
                )
            };
            if top {
                wide("board", id, inner)
            } else {
                format!("<div class=\"stubhost\">{inner}</div>")
            }
        }
        "bookmark" => {
            let url = attr_str(n, "url");
            let title = fallback(attr_str(n, "title"), host_of(url));
            let desc = match attr_str(n, "description") {
                "" => String::new(),
                d => format!("<div class=\"bd\">{}</div>", escape(d)),
            };
            format!(
                "<div class=\"react-renderer\"><a class=\"bookmark\" href=\"{}\" rel=\"noopener noreferrer\" target=\"_blank\"><div class=\"bk\"><div class=\"bt\">{}</div>{desc}<div class=\"bs\">{}</div></div><div class=\"bthumb\"></div></a></div>",
                safe_url(url),
                escape(title),
                escape(host_of(url))
            )
        }
        "embed" => {
            let url = attr_str(n, "url");
            let title = fallback(attr_str(n, "title"), host_of(url));
            let provider = attr_str(n, "provider");
            format!(
                "<div class=\"react-renderer\"><div class=\"embed\"><div class=\"ehead\"><span class=\"pv\">{}</span><span class=\"et\">{}</span></div><div class=\"ev\"></div></div></div>",
                escape(&capitalize(provider)),
                escape(title)
            )
        }
        "fileAttachment" => {
            let name = fallback(attr_str(n, "name"), "Untitled file");
            let card = format!(
                "<div class=\"attach\"><div class=\"ftile tone-gray\"></div><div style=\"min-width:0\"><div class=\"fname\"><a href=\"{}\" rel=\"noopener noreferrer\" target=\"_blank\">{}</a></div><div class=\"fmeta\">{}</div></div></div>",
                safe_url(attr_str(n, "url")),
                escape(name),
                escape(&file_meta(n).join(" · "))
            );
            format!(
                "<div class=\"react-renderer\"><div class=\"filev\" data-display=\"{}\">{card}</div></div>",
                file_display(n)
            )
        }
        // Unknown blocks: their children, so text is never lost.
        _ => kids(doc, n, depth),
    }
}

fn database(doc: &Value, id: &str) -> String {
    let (name, header, rows) = database_table(doc, id);
    let total = rows.len();
    let th: String = header
        .iter()
        .map(|h| format!("<th>{}</th>", escape(h)))
        .collect();
    let trs: String = rows
        .iter()
        .take(MAX_DB_ROWS)
        .map(|r| {
            let tds: String = r
                .iter()
                .map(|c| format!("<td>{}</td>", escape(c)))
                .collect();
            format!("<tr>{tds}</tr>")
        })
        .collect();
    let more = if total > MAX_DB_ROWS {
        format!(
            "<tr><td colspan=\"{}\" class=\"oc-pv-more\">{} more rows</td></tr>",
            header.len().max(1),
            total - MAX_DB_ROWS
        )
    } else {
        String::new()
    };
    format!(
        "<div class=\"oc-pv-db\"><div class=\"oc-pv-dbname\">{}</div><div class=\"tableWrapper\"><table><thead><tr>{th}</tr></thead><tbody>{trs}{more}</tbody></table></div></div>",
        escape(&name)
    )
}

fn fallback<'a>(a: &'a str, b: &'a str) -> &'a str {
    if a.trim().is_empty() { b } else { a }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => "Embed".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc() -> Value {
        json!({
            "meta": {"title": "Plan <Q4>", "tone": "blue"},
            "comments": {"t1": {"messages": [{"body": "secret review note"}]}},
            "databases": {"d1": {"name": "Tasks", "fields": [{"id": "f1", "name": "Name"}],
                "order": ["r1"], "rows": {"r1": {"f1": "Ship"}}}},
            "boards": {"b1": {"order": ["s1"], "shapes": {"s1": {"type": "sticky", "x": 0, "y": 0, "w": 150, "h": 110, "text": "Idea"}}}},
            "content": [
                {"type": "paragraph", "content": [
                    {"type": "text", "text": "anchored", "marks": [{"type": "commentMark", "attrs": {"threadId": "t1"}}]},
                    {"type": "text", "text": "<script>x</script>"}
                ]},
                {"type": "taskList", "content": [{"type": "taskItem", "attrs": {"checked": true},
                    "content": [{"type": "paragraph", "content": [{"type": "text", "text": "done"}]}]}]},
                {"type": "callout", "attrs": {"tone": "green\" onclick=\"x"}, "content": [{"type": "paragraph"}]},
                {"type": "database", "attrs": {"dbId": "d1"}},
                {"type": "board", "attrs": {"boardId": "b1"}},
                {"type": "image", "attrs": {"src": "javascript:alert(1)"}},
                {"type": "mystery", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "kept"}]}]}
            ]
        })
    }

    #[test]
    fn renders_editor_markup() {
        let p = render(&doc());
        let h = &p.html;
        assert!(!p.truncated);
        assert!(
            h.contains("<h1 class=\"dtitle\">Plan &lt;Q4&gt;</h1>"),
            "{h}"
        );
        assert!(h.contains("<div class=\"dicon tone-blue\">"), "{h}");
        assert!(
            h.contains("<div class=\"ProseMirror oc-pv-content\""),
            "{h}"
        );
        assert!(
            h.contains("<ul data-type=\"taskList\"><li data-checked=\"true\">"),
            "{h}"
        );
        assert!(
            h.contains("<div class=\"callout\" data-tone=\"gray\">"),
            "bad tone falls back: {h}"
        );
        assert!(h.contains("data-db=\"d1\""), "{h}");
        assert!(h.contains("<td>Ship</td>"), "{h}");
        assert!(h.contains("<div class=\"oc-pv-board\""), "{h}");
        assert!(h.contains(">Idea</text>"), "{h}");
        assert!(h.contains("<p>kept</p>"), "{h}");
    }

    #[test]
    fn never_leaks_comments_or_script() {
        let h = render(&doc()).html;
        assert!(h.contains("anchored"), "{h}");
        for bad in [
            "t1",
            "secret review note",
            "commentMark",
            "cmt",
            "<script",
            "javascript:",
            "onclick",
        ] {
            assert!(!h.contains(bad), "{bad} in {h}");
        }
    }

    #[test]
    fn stops_at_the_size_cap() {
        let para = json!({"type": "paragraph", "content": [{"type": "text", "text": "x".repeat(64 * 1024)}]});
        let content: Vec<Value> = (0..64).map(|_| para.clone()).collect();
        let p = render(&json!({"content": content}));
        assert!(p.truncated);
        assert!(
            p.html.len() < MAX_PREVIEW_BYTES + 128 * 1024,
            "{}",
            p.html.len()
        );
    }

    #[test]
    fn database_rows_are_capped() {
        let rows: serde_json::Map<String, Value> = (0..150)
            .map(|i| (format!("r{i}"), json!({"f1": format!("row {i}")})))
            .collect();
        let d = json!({"databases": {"d1": {"name": "Big", "fields": [{"id": "f1", "name": "Name"}], "rows": rows}},
            "content": [{"type": "database", "attrs": {"dbId": "d1"}}]});
        let h = render(&d).html;
        assert_eq!(h.matches("<tr><td>row").count(), MAX_DB_ROWS);
        assert!(h.contains("50 more rows"), "{h}");
    }
}
