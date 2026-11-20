//! Markdown and HTML export from the logical JSON produced by [`crate::doc_to_json`].

use serde_json::Value;

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

fn plain_text(n: &Value) -> String {
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
fn database_table(doc: &Value, id: &str) -> (String, Vec<String>, Vec<Vec<String>>) {
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
    let rows = order
        .iter()
        .map(|rid| {
            fields
                .iter()
                .map(|f| cell_value(&db["rows"][rid][s(f, "id")]))
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

pub fn to_markdown(doc: &Value) -> String {
    let mut out = String::new();
    if !title(doc).is_empty() && !starts_with_h1(doc) {
        out.push_str(&format!("# {}\n\n", title(doc)));
    }
    let blocks: Vec<String> = children(doc)
        .iter()
        .map(|n| md_block(doc, n))
        .filter(|b| !b.is_empty())
        .collect();
    out.push_str(&blocks.join("\n\n"));
    out.push('\n');
    out
}

fn md_inline(nodes: &[Value]) -> String {
    nodes
        .iter()
        .map(|n| match s(n, "type") {
            "text" => {
                let mut t = s(n, "text").to_string();
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
                match link {
                    Some(href) => format!("[{t}]({href})"),
                    None => t,
                }
            }
            "mention" => format!("@{}", attr_str(n, "label")),
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

fn md_children(doc: &Value, n: &Value, sep: &str) -> String {
    children(n)
        .iter()
        .map(|c| md_block(doc, c))
        .filter(|b| !b.is_empty())
        .collect::<Vec<_>>()
        .join(sep)
}

fn md_table(header: &[String], rows: &[Vec<String>]) -> String {
    if header.is_empty() {
        return String::new();
    }
    let esc = |c: &String| c.replace('|', "\\|").replace('\n', " ");
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

fn md_block(doc: &Value, n: &Value) -> String {
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
                let body = md_children(doc, item, "\n");
                format!("{marker}{}", indent(&body, &" ".repeat(marker.len())))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        "blockquote" | "callout" => md_children(doc, n, "\n\n")
            .lines()
            .map(|l| format!("> {l}").trim_end().to_string())
            .collect::<Vec<_>>()
            .join("\n"),
        "codeBlock" => format!("```{}\n{}\n```", attr_str(n, "language"), plain_text(n)),
        "horizontalRule" => "---".into(),
        "image" => {
            let img = format!("![{}]({})", attr_str(n, "alt"), attr_str(n, "src"));
            match attr_str(n, "caption") {
                "" => img,
                c => format!("{img}\n*{c}*"),
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
                .map(|c| md_children(doc, c, "\n\n"))
                .unwrap_or_default();
            format!("**{summary}**\n\n{body}").trim_end().to_string()
        }
        "database" => {
            let (name, header, rows) = database_table(doc, attr_str(n, "dbId"));
            format!("### {name}\n\n{}", md_table(&header, &rows))
                .trim_end()
                .to_string()
        }
        "board" => format!("### Board\n\n*{}*", board_note(doc, attr_str(n, "boardId"))),
        "bookmark" => format!(
            "[{}]({})",
            fallback(attr_str(n, "title"), attr_str(n, "url")),
            attr_str(n, "url")
        ),
        "embed" => format!(
            "[{}]({})",
            fallback(attr_str(n, "title"), attr_str(n, "provider")),
            attr_str(n, "url")
        ),
        "fileAttachment" => format!("[{}]({})", attr_str(n, "name"), attr_str(n, "url")),
        _ => md_children(doc, n, "\n\n"),
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

fn safe_url(u: &str) -> String {
    let lower = u.trim().to_ascii_lowercase();
    let ok = ["http://", "https://", "mailto:", "/", "#"]
        .iter()
        .any(|p| lower.starts_with(p));
    if ok { escape(u) } else { String::new() }
}

pub fn to_html(doc: &Value) -> String {
    let t = title(doc);
    let mut body = String::new();
    if !t.is_empty() && !starts_with_h1(doc) {
        body.push_str(&format!("<h1>{}</h1>\n", escape(t)));
    }
    for n in children(doc) {
        body.push_str(&html_block(doc, n));
        body.push('\n');
    }
    format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>{}</title>\
         <style>body{{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px}}\
         table{{border-collapse:collapse}}td,th{{border:1px solid #ddd;padding:4px 8px}}\
         blockquote{{border-left:3px solid #ddd;margin:0;padding-left:12px}}</style></head>\n<body>\n{body}</body></html>\n",
        escape(if t.is_empty() { "Canvas" } else { t })
    )
}

fn html_inline(nodes: &[Value]) -> String {
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
            "hardBreak" => "<br>".into(),
            _ => html_inline(children(n)),
        })
        .collect()
}

fn html_children(doc: &Value, n: &Value) -> String {
    children(n).iter().map(|c| html_block(doc, c)).collect()
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

fn html_block(doc: &Value, n: &Value) -> String {
    match s(n, "type") {
        "paragraph" => format!("<p>{}</p>", html_inline(children(n))),
        "heading" => {
            let l = attr(n, "level").as_u64().unwrap_or(1).clamp(1, 6);
            format!("<h{l}>{}</h{l}>", html_inline(children(n)))
        }
        "bulletList" => format!("<ul>{}</ul>", html_children(doc, n)),
        "orderedList" => format!("<ol>{}</ol>", html_children(doc, n)),
        "taskList" => format!("<ul class=\"tasks\">{}</ul>", html_children(doc, n)),
        "listItem" => format!("<li>{}</li>", html_children(doc, n)),
        "taskItem" => {
            let checked = if attr(n, "checked").as_bool() == Some(true) {
                " checked"
            } else {
                ""
            };
            format!(
                "<li><input type=\"checkbox\" disabled{checked}> {}</li>",
                html_children(doc, n)
            )
        }
        "blockquote" => format!("<blockquote>{}</blockquote>", html_children(doc, n)),
        "callout" => format!("<aside class=\"callout\">{}</aside>", html_children(doc, n)),
        "codeBlock" => format!("<pre><code>{}</code></pre>", escape(&plain_text(n))),
        "horizontalRule" => "<hr>".into(),
        "image" => {
            let img = format!(
                "<img src=\"{}\" alt=\"{}\">",
                safe_url(attr_str(n, "src")),
                escape(attr_str(n, "alt"))
            );
            match attr_str(n, "caption") {
                "" => format!("<figure>{img}</figure>"),
                c => format!(
                    "<figure>{img}<figcaption>{}</figcaption></figure>",
                    escape(c)
                ),
            }
        }
        "table" => format!("<table>{}</table>", html_children(doc, n)),
        "tableRow" => format!("<tr>{}</tr>", html_children(doc, n)),
        "tableHeader" => format!("<th>{}</th>", html_children(doc, n)),
        "tableCell" => format!("<td>{}</td>", html_children(doc, n)),
        "toggle" => format!("<details>{}</details>", html_children(doc, n)),
        "toggleSummary" => format!("<summary>{}</summary>", html_inline(children(n))),
        "database" => {
            let (name, header, rows) = database_table(doc, attr_str(n, "dbId"));
            format!("<h3>{}</h3>{}", escape(&name), html_table(&header, &rows))
        }
        "board" => format!(
            "<h3>Board</h3><p><em>{}</em></p>",
            escape(&board_note(doc, attr_str(n, "boardId")))
        ),
        "bookmark" | "embed" => {
            let label = fallback(attr_str(n, "title"), attr_str(n, "url"));
            format!(
                "<p><a href=\"{}\">{}</a></p>",
                safe_url(attr_str(n, "url")),
                escape(label)
            )
        }
        "fileAttachment" => format!(
            "<p><a href=\"{}\">{}</a></p>",
            safe_url(attr_str(n, "url")),
            escape(attr_str(n, "name"))
        ),
        "columns" => format!("<div class=\"columns\">{}</div>", html_children(doc, n)),
        "column" => format!("<div class=\"column\">{}</div>", html_children(doc, n)),
        _ => html_children(doc, n),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn html_blocks_javascript_urls() {
        let doc =
            json!({"content":[{"type":"image","attrs":{"src":"javascript:alert(1)","alt":"<x>"}}]});
        let html = to_html(&doc);
        assert!(!html.contains("javascript:"));
        assert!(html.contains("&lt;x&gt;"));
    }
}
