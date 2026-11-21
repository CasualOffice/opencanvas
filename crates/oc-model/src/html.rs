//! A small, forgiving HTML reader for `POST /v1/convert?from=html`: builds the logical
//! Tiptap JSON (headings, paragraphs, marks, links, lists, task lists, quotes, code, rules,
//! images, tables, callouts). Scripts, styles and unknown markup are dropped; text is kept.

use serde_json::{Value, json};

#[derive(Debug)]
enum Node {
    El {
        tag: String,
        attrs: Vec<(String, String)>,
        children: Vec<Node>,
    },
    Text(String),
}

const VOID: [&str; 13] = [
    "br", "hr", "img", "input", "meta", "link", "col", "area", "base", "embed", "source", "wbr",
    "param",
];
const RAW: [&str; 4] = ["script", "style", "template", "noscript"];

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = rest.find('&') {
        out.push_str(&rest[..p]);
        rest = &rest[p..];
        let end = rest[1..].find(';').map(|e| e + 1).filter(|e| *e <= 10);
        let decoded = end.and_then(|e| {
            let name = &rest[1..e];
            let c = match name {
                "amp" => '&',
                "lt" => '<',
                "gt" => '>',
                "quot" => '"',
                "apos" => '\'',
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
                rest = &rest[e + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn parse_attrs(src: &str) -> Vec<(String, String)> {
    let mut attrs = Vec::new();
    let b = src.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        let start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' && b[i] != b'/' {
            i += 1;
        }
        if start == i {
            i += 1;
            continue;
        }
        let name = src[start..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let q = b[i];
                let vs = i + 1;
                i = vs;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
                value = decode_entities(&src[vs..i.min(b.len())]);
                i += 1;
            } else {
                let vs = i;
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1;
                }
                value = decode_entities(&src[vs..i]);
            }
        }
        attrs.push((name, value));
    }
    attrs
}

/// An open element while parsing: (tag, attributes, children so far).
type Open = (String, Vec<(String, String)>, Vec<Node>);

/// Tokenizes and builds a tree; mismatched end tags are tolerated.
fn parse(src: &str) -> Vec<Node> {
    // stack of (tag, attrs, children)
    let mut stack: Vec<Open> = vec![(String::new(), vec![], vec![])];
    let mut i = 0;
    let close_top = |stack: &mut Vec<Open>| {
        let (tag, attrs, children) = stack.pop().expect("non-root");
        stack.last_mut().expect("root").2.push(Node::El {
            tag,
            attrs,
            children,
        });
    };
    while i < src.len() {
        let rest = &src[i..];
        if let Some(r) = rest.strip_prefix("<!--") {
            i += 4 + r.find("-->").map_or(r.len(), |e| e + 3);
            continue;
        }
        if rest.starts_with("<!") || rest.starts_with("<?") {
            i += rest.find('>').map_or(rest.len(), |e| e + 1);
            continue;
        }
        let tag_start = rest.starts_with('<')
            && rest[1..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '/');
        if !tag_start {
            let end = rest[1..].find('<').map_or(rest.len(), |e| e + 1);
            stack
                .last_mut()
                .expect("root")
                .2
                .push(Node::Text(decode_entities(&rest[..end])));
            i += end;
            continue;
        }
        let Some(gt) = rest.find('>') else {
            stack
                .last_mut()
                .expect("root")
                .2
                .push(Node::Text(decode_entities(rest)));
            break;
        };
        let inner = &rest[1..gt];
        i += gt + 1;
        if let Some(name) = inner.strip_prefix('/') {
            let name = name.trim().to_ascii_lowercase();
            if let Some(pos) = stack.iter().rposition(|(t, _, _)| *t == name)
                && pos > 0
            {
                while stack.len() > pos {
                    close_top(&mut stack);
                }
            }
            continue;
        }
        let name_end = inner
            .find(|c: char| c.is_ascii_whitespace() || c == '/')
            .unwrap_or(inner.len());
        let tag = inner[..name_end].to_ascii_lowercase();
        let attrs = parse_attrs(&inner[name_end..]);
        // Implied end tags for the common cases.
        let top = stack.last().map(|s| s.0.as_str()).unwrap_or_default();
        let implied = match tag.as_str() {
            "li" => top == "li",
            "p" | "ul" | "ol" | "table" | "blockquote" | "pre" | "h1" | "h2" | "h3" | "h4"
            | "h5" | "h6" | "div" | "hr" => top == "p",
            "tr" => top == "tr" || top == "td" || top == "th",
            "td" | "th" => top == "td" || top == "th",
            _ => false,
        };
        if implied {
            if matches!(tag.as_str(), "tr") && (top == "td" || top == "th") {
                close_top(&mut stack);
            }
            close_top(&mut stack);
        }
        if RAW.contains(&tag.as_str()) {
            let close = format!("</{tag}");
            let lower = src[i..].to_ascii_lowercase();
            let end = lower.find(&close).unwrap_or(lower.len());
            i += end;
            i += src[i..].find('>').map_or(src.len() - i, |e| e + 1);
            continue;
        }
        if VOID.contains(&tag.as_str()) || inner.ends_with('/') {
            stack.last_mut().expect("root").2.push(Node::El {
                tag,
                attrs,
                children: vec![],
            });
        } else {
            stack.push((tag, attrs, vec![]));
        }
    }
    while stack.len() > 1 {
        close_top(&mut stack);
    }
    stack.pop().map(|s| s.2).unwrap_or_default()
}

fn attr<'a>(attrs: &'a [(String, String)], k: &str) -> Option<&'a str> {
    attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
}

fn safe_href(u: &str) -> Option<String> {
    let l = u.trim().to_ascii_lowercase();
    ["http://", "https://", "mailto:", "/", "#"]
        .iter()
        .any(|p| l.starts_with(p))
        .then(|| u.trim().to_string())
}

const BLOCK_TAGS: [&str; 30] = [
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "hr",
    "img",
    "figure",
    "table",
    "div",
    "section",
    "article",
    "main",
    "header",
    "footer",
    "aside",
    "nav",
    "body",
    "html",
    "details",
    "summary",
    "dl",
    "head",
];

fn is_block(n: &Node) -> bool {
    matches!(n, Node::El { tag, .. } if BLOCK_TAGS.contains(&tag.as_str()))
}

fn text_content(nodes: &[Node]) -> String {
    nodes
        .iter()
        .map(|n| match n {
            Node::Text(t) => t.clone(),
            Node::El { tag, .. } if tag == "br" => "\n".into(),
            Node::El { children, .. } => text_content(children),
        })
        .collect()
}

struct Ctx {
    title: Option<String>,
}

/// Inline nodes with whitespace collapsed; `marks` are the enclosing marks.
fn inline(nodes: &[Node], marks: &[Value], out: &mut Vec<Value>) {
    for n in nodes {
        match n {
            Node::Text(t) => {
                let mut s = String::with_capacity(t.len());
                let mut space = false;
                for c in t.chars() {
                    if c.is_whitespace() && c != '\u{a0}' {
                        space = true;
                    } else {
                        if space {
                            s.push(' ');
                        }
                        space = false;
                        s.push(c);
                    }
                }
                if space {
                    s.push(' ');
                }
                if s.is_empty() {
                    continue;
                }
                let mut v = json!({"type": "text", "text": s});
                if !marks.is_empty() {
                    v["marks"] = Value::Array(marks.to_vec());
                }
                out.push(v);
            }
            Node::El {
                tag,
                attrs,
                children,
            } => {
                let mark = match tag.as_str() {
                    "strong" | "b" => Some(json!({"type": "bold"})),
                    "em" | "i" => Some(json!({"type": "italic"})),
                    "u" | "ins" => Some(json!({"type": "underline"})),
                    "s" | "del" | "strike" => Some(json!({"type": "strike"})),
                    "code" | "kbd" | "samp" => Some(json!({"type": "code"})),
                    "mark" => Some(json!({"type": "highlight"})),
                    "a" => attr(attrs, "href")
                        .and_then(safe_href)
                        .map(|h| json!({"type": "link", "attrs": {"href": h}})),
                    _ => None,
                };
                match tag.as_str() {
                    "br" => out.push(json!({"type": "hardBreak"})),
                    "input" | "img" => {}
                    _ => {
                        let mut m = marks.to_vec();
                        if let Some(mark) = mark
                            && !m.iter().any(|x| x["type"] == mark["type"])
                        {
                            m.push(mark);
                        }
                        inline(children, &m, out);
                    }
                }
            }
        }
    }
}

/// Trims leading/trailing spaces of a run and merges adjacent equal-mark text.
fn tidy(mut run: Vec<Value>) -> Vec<Value> {
    if let Some(t) = run.first_mut().and_then(|v| v.get_mut("text")) {
        *t = Value::String(t.as_str().unwrap_or_default().trim_start().to_string());
    }
    if let Some(t) = run.last_mut().and_then(|v| v.get_mut("text")) {
        *t = Value::String(t.as_str().unwrap_or_default().trim_end().to_string());
    }
    let mut out: Vec<Value> = Vec::new();
    for v in run {
        if v["type"] == "text" && v["text"].as_str().is_some_and(str::is_empty) {
            continue;
        }
        if let Some(last) = out.last_mut()
            && last["type"] == "text"
            && v["type"] == "text"
            && last.get("marks") == v.get("marks")
        {
            let joined = format!(
                "{}{}",
                last["text"].as_str().unwrap_or_default(),
                v["text"].as_str().unwrap_or_default()
            );
            last["text"] = Value::String(joined);
            continue;
        }
        out.push(v);
    }
    out
}

fn with_content(tag: &str, content: Vec<Value>) -> Value {
    if content.is_empty() {
        json!({"type": tag})
    } else {
        json!({"type": tag, "content": content})
    }
}

fn paragraph(nodes: &[Node]) -> Option<Value> {
    let mut run = Vec::new();
    inline(nodes, &[], &mut run);
    let run = tidy(run);
    (!run.is_empty()).then(|| with_content("paragraph", run))
}

/// Block children: runs of inline content become paragraphs.
fn blocks(nodes: &[Node], ctx: &mut Ctx) -> Vec<Value> {
    let mut out = Vec::new();
    let mut run: Vec<&Node> = Vec::new();
    let flush = |run: &mut Vec<&Node>, out: &mut Vec<Value>| {
        if run.is_empty() {
            return;
        }
        let owned: Vec<Node> = run.drain(..).map(clone_node).collect();
        if let Some(p) = paragraph(&owned) {
            out.push(p);
        }
    };
    for n in nodes {
        if is_block(n) {
            flush(&mut run, &mut out);
            block(n, ctx, &mut out);
        } else {
            run.push(n);
        }
    }
    flush(&mut run, &mut out);
    out
}

fn clone_node(n: &Node) -> Node {
    match n {
        Node::Text(t) => Node::Text(t.clone()),
        Node::El {
            tag,
            attrs,
            children,
        } => Node::El {
            tag: tag.clone(),
            attrs: attrs.clone(),
            children: children.iter().map(clone_node).collect(),
        },
    }
}

fn image(attrs: &[(String, String)], caption: Option<String>) -> Option<Value> {
    let src = attr(attrs, "src").and_then(safe_href).or_else(|| {
        attr(attrs, "src")
            .filter(|s| s.starts_with("data:image/"))
            .map(String::from)
    })?;
    let mut a = json!({"src": src, "alt": attr(attrs, "alt").unwrap_or_default()});
    if let Some(c) = caption.filter(|c| !c.is_empty()) {
        a["caption"] = Value::String(c);
    }
    Some(json!({"type": "image", "attrs": a}))
}

fn find_child<'a>(nodes: &'a [Node], name: &str) -> Option<&'a Node> {
    nodes
        .iter()
        .find(|n| matches!(n, Node::El { tag, .. } if tag == name))
}

fn list_item(children: &[Node], ctx: &mut Ctx) -> (Option<bool>, Vec<Value>) {
    let checked = children.iter().find_map(|n| match n {
        Node::El { tag, attrs, .. }
            if tag == "input" && attr(attrs, "type").is_some_and(|t| t == "checkbox") =>
        {
            Some(attr(attrs, "checked").is_some())
        }
        _ => None,
    });
    let mut content = blocks(children, ctx);
    if content.is_empty() {
        content.push(json!({"type": "paragraph"}));
    }
    (checked, content)
}

fn table(children: &[Node]) -> Value {
    let mut rows = Vec::new();
    fn collect<'a>(nodes: &'a [Node], rows: &mut Vec<&'a [Node]>) {
        for n in nodes {
            if let Node::El { tag, children, .. } = n {
                match tag.as_str() {
                    "tr" => rows.push(children),
                    "thead" | "tbody" | "tfoot" => collect(children, rows),
                    _ => {}
                }
            }
        }
    }
    collect(children, &mut rows);
    let width = rows
        .iter()
        .map(|r| {
            r.iter()
                .filter(|c| matches!(c, Node::El { tag, .. } if tag == "td" || tag == "th"))
                .count()
        })
        .max()
        .unwrap_or(0);
    let mut out = Vec::new();
    for r in rows {
        let mut cells: Vec<Value> = r
            .iter()
            .filter_map(|c| match c {
                Node::El { tag, children, .. } if tag == "td" || tag == "th" => {
                    let kind = if tag == "th" {
                        "tableHeader"
                    } else {
                        "tableCell"
                    };
                    let p = paragraph(children).unwrap_or_else(|| json!({"type": "paragraph"}));
                    Some(json!({"type": kind, "content": [p]}))
                }
                _ => None,
            })
            .collect();
        cells.resize(
            width,
            json!({"type": "tableCell", "content": [{"type": "paragraph"}]}),
        );
        if width > 0 {
            out.push(json!({"type": "tableRow", "content": cells}));
        }
    }
    with_content("table", out)
}

fn block(n: &Node, ctx: &mut Ctx, out: &mut Vec<Value>) {
    let Node::El {
        tag,
        attrs,
        children,
    } = n
    else {
        return;
    };
    match tag.as_str() {
        "head" => {
            if let Some(Node::El { children, .. }) = find_child(children, "title") {
                ctx.title = Some(text_content(children).trim().to_string());
            }
        }
        "p" | "summary" => {
            out.extend(paragraph(children));
            // Images inside a paragraph become image blocks after it.
            fn imgs(nodes: &[Node], out: &mut Vec<Value>) {
                for n in nodes {
                    if let Node::El {
                        tag,
                        attrs,
                        children,
                    } = n
                    {
                        if tag == "img" {
                            out.extend(image(attrs, None));
                        } else {
                            imgs(children, out);
                        }
                    }
                }
            }
            imgs(children, out);
        }
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            let level = tag[1..].parse::<u8>().unwrap_or(1).min(3);
            let mut run = Vec::new();
            inline(children, &[], &mut run);
            let mut h = with_content("heading", tidy(run));
            h["attrs"] = json!({"level": level});
            out.push(h);
        }
        "ul" | "ol" => {
            let items: Vec<(Option<bool>, Vec<Value>)> = children
                .iter()
                .filter_map(|c| match c {
                    Node::El { tag, children, .. } if tag == "li" => Some(list_item(children, ctx)),
                    _ => None,
                })
                .collect();
            if items.is_empty() {
                return;
            }
            let task = items.iter().all(|(c, _)| c.is_some());
            let (list, item) = match (task, tag.as_str()) {
                (true, _) => ("taskList", "taskItem"),
                (_, "ol") => ("orderedList", "listItem"),
                _ => ("bulletList", "listItem"),
            };
            let content: Vec<Value> = items
                .into_iter()
                .map(|(checked, content)| {
                    let mut v = json!({"type": item, "content": content});
                    if task {
                        v["attrs"] = json!({"checked": checked.unwrap_or(false)});
                    }
                    v
                })
                .collect();
            out.push(json!({"type": list, "content": content}));
        }
        "li" => out.extend(blocks(children, ctx)),
        "blockquote" => {
            let inner = blocks(children, ctx);
            if !inner.is_empty() {
                out.push(json!({"type": "blockquote", "content": inner}));
            }
        }
        "aside" if attr(attrs, "class").is_some_and(|c| c.contains("callout")) => {
            let inner = blocks(children, ctx);
            out.push(with_content("callout", inner));
        }
        "pre" => {
            let code = find_child(children, "code");
            let language = code
                .and_then(|c| match c {
                    Node::El { attrs, .. } => attr(attrs, "class"),
                    _ => None,
                })
                .and_then(|c| {
                    c.split_whitespace()
                        .find_map(|x| x.strip_prefix("language-"))
                })
                .map(|l| Value::String(l.to_string()))
                .unwrap_or(Value::Null);
            let text = text_content(children);
            let text = text.strip_suffix('\n').unwrap_or(&text);
            let mut v = if text.is_empty() {
                json!({"type": "codeBlock"})
            } else {
                json!({"type": "codeBlock", "content": [{"type": "text", "text": text}]})
            };
            v["attrs"] = json!({"language": language});
            out.push(v);
        }
        "hr" => out.push(json!({"type": "horizontalRule"})),
        "img" => out.extend(image(attrs, None)),
        "figure" => {
            let caption = find_child(children, "figcaption").map(|c| match c {
                Node::El { children, .. } => text_content(children).trim().to_string(),
                Node::Text(_) => String::new(),
            });
            let img = children.iter().find_map(|c| match c {
                Node::El { tag, attrs, .. } if tag == "img" => image(attrs, caption.clone()),
                _ => None,
            });
            match img {
                Some(i) => out.push(i),
                None => out.extend(blocks(children, ctx)),
            }
        }
        "table" => out.push(table(children)),
        _ => out.extend(blocks(children, ctx)),
    }
}

/// HTML → logical doc JSON (`{type:"doc", content, meta}`).
pub fn html_to_json(src: &str) -> Value {
    let tree = parse(src);
    let mut ctx = Ctx { title: None };
    let content = blocks(&tree, &mut ctx);
    let mut doc = json!({"type": "doc", "content": content});
    if let Some(t) = ctx.title.filter(|t| !t.is_empty()) {
        doc["meta"] = json!({"title": t});
    }
    doc
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::{to_html, to_markdown};

    #[test]
    fn reads_common_markup() {
        let v = html_to_json(
            r#"<!doctype html><html><head><title>T &amp; U</title><style>p{}</style></head><body>
            <h2>Plan</h2><p>Hello <b>bold <i>both</i></b> &lt;x&gt; <a href="https://x.dev">link</a>
            <a href="javascript:alert(1)">bad</a><br>next</p>
            <ul><li>one<li>two</ul>
            <ul class="tasks"><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>
            <ol><li><p>first</p><ul><li>nested</li></ul></li></ol>
            <blockquote><p>quote</p></blockquote>
            <pre><code class="language-rust">fn x() {}
</code></pre><hr><figure><img src="https://h/a.png" alt="A"><figcaption>Cap</figcaption></figure>
            <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>
            <script>alert(1)</script>loose text</body></html>"#,
        );
        let c = v["content"].as_array().unwrap();
        let types: Vec<&str> = c.iter().map(|n| n["type"].as_str().unwrap()).collect();
        assert_eq!(
            types,
            [
                "heading",
                "paragraph",
                "bulletList",
                "taskList",
                "orderedList",
                "blockquote",
                "codeBlock",
                "horizontalRule",
                "image",
                "table",
                "paragraph"
            ],
            "{v:#}"
        );
        assert_eq!(v["meta"]["title"], "T & U");
        let md = to_markdown(&v);
        assert!(md.contains("## Plan"), "{md}");
        assert!(md.contains("Hello **bold **"), "{md}");
        assert!(
            md.contains(" \\<x> [link](https://x.dev) bad  \nnext"),
            "{md}"
        );
        let both = &c[1]["content"][2];
        assert_eq!(both["text"], "both");
        assert_eq!(both["marks"], json!([{"type": "bold"}, {"type": "italic"}]));
        assert!(md.contains("- one\n- two"), "{md}");
        assert!(md.contains("- [x] done\n- [ ] todo"), "{md}");
        assert!(md.contains("1. first\n   - nested"), "{md}");
        assert!(md.contains("```rust\nfn x() {}\n```"), "{md}");
        assert!(md.contains("![A](https://h/a.png)\n*Cap*"), "{md}");
        assert!(md.contains("| A | B |\n| --- | --- |\n| 1 |  |"), "{md}");
        assert!(md.trim_end().ends_with("loose text"), "{md}");
        assert!(!md.contains("alert"));
    }

    #[test]
    fn html_export_reads_back() {
        let doc = json!({"content":[
            {"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Title"}]},
            {"type":"paragraph","content":[{"type":"text","text":"a "},{"type":"text","text":"b","marks":[{"type":"italic"}]}]},
            {"type":"callout","content":[{"type":"paragraph","content":[{"type":"text","text":"note"}]}]}
        ]});
        let back = html_to_json(&to_html(&doc));
        assert_eq!(back["content"], doc["content"]);
    }
}
