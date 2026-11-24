// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Declarative export templates for SDK blocks (BSDK-02, docs/15 §4.2).
//!
//! A logic-less Mustache subset with a fixed set of filters. Templates are data: there are no
//! partials, no lambdas, no delimiter changes and no unescaped output (`{{{x}}}`, `{{&x}}`),
//! so rendering one can never run code. The web editor has the same engine
//! (`web/packages/editor/src/ext/template.ts`); `tests/fixtures/ext-templates.json` holds
//! cases both must render identically.
//!
//! Syntax: `{{name}}`, `{{a.b}}`, `{{.}}` (the current item), `{{name|filter|filter:arg}}`,
//! sections `{{#name}}…{{/name}}` (shown when truthy; repeated for each item of a non-empty
//! array) and inverted sections `{{^name}}…{{/name}}`, comments `{{! … }}`.
//!
//! Filters: `percent[:digits]`, `number[:digits]`, `date`, `upper`, `lower`, `trim`,
//! `truncate:n`, `default:text`, `join[:separator]`, `count`, `yesno[:yes,no]`.
//! An argument is a bare word or number, or a double-quoted string.

use serde_json::Value;

/// Longest template source accepted.
pub const MAX_SOURCE: usize = 4 * 1024;
/// Longest output; anything past it is cut.
pub const MAX_OUTPUT: usize = 64 * 1024;
const MAX_NEST: usize = 8;
/// Most section iterations in one render.
const MAX_ITERATIONS: usize = 1000;

pub const FILTERS: &[&str] = &[
    "percent", "number", "date", "upper", "lower", "trim", "truncate", "default", "join", "count",
    "yesno",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// Values are escaped so they cannot open links, images, HTML or new blocks.
    Markdown,
    /// Values as they are.
    Text,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Template {
    parts: Vec<Part>,
}

#[derive(Debug, Clone, PartialEq)]
enum Part {
    Text(String),
    Var(String, Vec<Filter>),
    Section {
        name: String,
        inverted: bool,
        body: Vec<Part>,
    },
}

#[derive(Debug, Clone, PartialEq)]
struct Filter {
    name: String,
    arg: Option<String>,
}

fn valid_name(n: &str) -> bool {
    n == "."
        || (!n.is_empty()
            && n.split('.').all(|seg| {
                !seg.is_empty()
                    && seg
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            }))
}

fn parse_filter(src: &str) -> Result<Filter, String> {
    let (name, arg) = match src.split_once(':') {
        Some((n, a)) => (n.trim(), Some(a.trim())),
        None => (src.trim(), None),
    };
    if !FILTERS.contains(&name) {
        return Err(format!(
            "unknown filter {name:?} (one of {})",
            FILTERS.join(", ")
        ));
    }
    let arg = match arg {
        None => None,
        Some(a) if a.len() >= 2 && a.starts_with('"') && a.ends_with('"') => {
            Some(a[1..a.len() - 1].to_string())
        }
        Some(a) if !a.is_empty() && !a.contains(['"', '{', '}', '|']) => Some(a.to_string()),
        Some(a) => return Err(format!("bad argument {a:?} for {name}")),
    };
    if name == "truncate" && !arg.as_deref().is_some_and(|a| a.parse::<usize>().is_ok()) {
        return Err("truncate needs a length (truncate:40)".into());
    }
    if matches!(name, "percent" | "number")
        && arg
            .as_deref()
            .is_some_and(|a| !a.parse::<u8>().is_ok_and(|d| d <= 6))
    {
        return Err(format!("{name} takes a number of digits 0-6"));
    }
    Ok(Filter {
        name: name.to_string(),
        arg,
    })
}

impl Template {
    pub fn parse(src: &str) -> Result<Self, String> {
        if src.len() > MAX_SOURCE {
            return Err(format!("a template is at most {MAX_SOURCE} bytes"));
        }
        let mut stack: Vec<(String, bool, Vec<Part>)> = Vec::new();
        let mut parts: Vec<Part> = Vec::new();
        let mut rest = src;
        while let Some(open) = rest.find("{{") {
            if open > 0 {
                parts.push(Part::Text(rest[..open].to_string()));
            }
            let after = &rest[open + 2..];
            let close = after.find("}}").ok_or("a tag is not closed with }}")?;
            let tag = after[..close].trim();
            rest = &after[close + 2..];
            let (sigil, body) = match tag.chars().next() {
                Some(c @ ('#' | '^' | '/' | '!' | '{' | '&' | '>' | '=' | '<' | '$')) => {
                    (Some(c), tag[1..].trim())
                }
                _ => (None, tag),
            };
            match sigil {
                Some('!') => {}
                Some('#' | '^') => {
                    if !valid_name(body) {
                        return Err(format!("bad section name {body:?}"));
                    }
                    if stack.len() >= MAX_NEST {
                        return Err(format!("sections nest more than {MAX_NEST} levels"));
                    }
                    stack.push((
                        body.to_string(),
                        sigil == Some('^'),
                        std::mem::take(&mut parts),
                    ));
                }
                Some('/') => {
                    let (name, inverted, outer) = stack
                        .pop()
                        .ok_or_else(|| format!("{{{{/{body}}}}} closes nothing"))?;
                    if name != body {
                        return Err(format!("{{{{/{body}}}}} closes {{{{#{name}}}}}"));
                    }
                    let inner = std::mem::replace(&mut parts, outer);
                    parts.push(Part::Section {
                        name,
                        inverted,
                        body: inner,
                    });
                }
                Some(c) => {
                    return Err(format!(
                        "{{{{{c}…}}}} is not supported: templates have no partials, raw output or delimiter changes"
                    ));
                }
                None => {
                    let mut it = body.split('|');
                    let name = it.next().unwrap_or_default().trim();
                    if !valid_name(name) {
                        return Err(format!("bad name {name:?}"));
                    }
                    let filters = it.map(parse_filter).collect::<Result<Vec<_>, _>>()?;
                    parts.push(Part::Var(name.to_string(), filters));
                }
            }
        }
        if !rest.is_empty() {
            parts.push(Part::Text(rest.to_string()));
        }
        if let Some((name, ..)) = stack.last() {
            return Err(format!("{{{{#{name}}}}} is not closed"));
        }
        Ok(Self { parts })
    }

    /// Renders over `ctx` (the block's attrs, with its data under `data`).
    pub fn render(&self, ctx: &Value, target: Target) -> String {
        let mut r = Render {
            out: String::new(),
            target,
            iterations: 0,
        };
        let mut stack = vec![ctx];
        r.parts(&self.parts, &mut stack);
        if r.out.len() > MAX_OUTPUT {
            let mut cut = MAX_OUTPUT;
            while !r.out.is_char_boundary(cut) {
                cut -= 1;
            }
            r.out.truncate(cut);
        }
        r.out
    }
}

struct Render {
    out: String,
    target: Target,
    iterations: usize,
}

fn lookup<'a>(stack: &[&'a Value], name: &str) -> Option<&'a Value> {
    if name == "." {
        return stack.last().copied();
    }
    let mut segs = name.split('.');
    let first = segs.next()?;
    let mut v = stack.iter().rev().find_map(|c| c.get(first))?;
    for s in segs {
        v = match v {
            Value::Array(a) => a.get(s.parse::<usize>().ok()?)?,
            other => other.get(s)?,
        };
    }
    Some(v)
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::Object(_)) => true,
    }
}

/// Numbers print without a trailing `.0`, up to 6 decimals with trailing zeros dropped.
pub fn number_text(x: f64) -> String {
    if !x.is_finite() {
        return String::new();
    }
    if x.fract() == 0.0 && x.abs() < 1e15 {
        return format!("{}", x as i64);
    }
    let s = format!("{x:.6}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" { "0".into() } else { s.to_string() }
}

fn fixed(x: f64, digits: usize) -> String {
    let s = format!("{x:.digits$}");
    if s.starts_with('-') && s[1..].bytes().all(|b| b == b'0' || b == b'.') {
        s[1..].to_string()
    } else {
        s
    }
}

/// A scalar as text; arrays join their scalars with `, `; objects and null are empty.
pub fn value_text(v: &Value) -> String {
    match v {
        Value::Null | Value::Object(_) => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_text(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .filter(|x| !x.is_object() && !x.is_array() && !x.is_null())
            .map(value_text)
            .collect::<Vec<_>>()
            .join(", "),
    }
}

fn apply(v: Value, f: &Filter) -> Value {
    let arg = f.arg.as_deref();
    match f.name.as_str() {
        "percent" => match v.as_f64() {
            Some(x) => Value::String(format!(
                "{}%",
                match arg {
                    Some(d) => fixed(x * 100.0, d.parse().unwrap_or(0)),
                    None => fixed(x * 100.0, 0),
                }
            )),
            None => Value::String(String::new()),
        },
        "number" => match v.as_f64() {
            Some(x) => Value::String(match arg {
                Some(d) => fixed(x, d.parse().unwrap_or(0)),
                None => number_text(x),
            }),
            None => Value::String(String::new()),
        },
        "date" => Value::String(crate::export::date_text(v.as_str().unwrap_or_default())),
        "upper" => Value::String(value_text(&v).to_uppercase()),
        "lower" => Value::String(value_text(&v).to_lowercase()),
        "trim" => Value::String(value_text(&v).trim().to_string()),
        "truncate" => {
            let n: usize = arg.and_then(|a| a.parse().ok()).unwrap_or(0);
            let t = value_text(&v);
            if t.chars().count() > n {
                Value::String(t.chars().take(n).collect::<String>() + "…")
            } else {
                Value::String(t)
            }
        }
        "default" => {
            if value_text(&v).is_empty() {
                Value::String(arg.unwrap_or_default().to_string())
            } else {
                v
            }
        }
        "join" => match &v {
            Value::Array(a) => Value::String(
                a.iter()
                    .filter(|x| !x.is_object() && !x.is_array() && !x.is_null())
                    .map(value_text)
                    .collect::<Vec<_>>()
                    .join(arg.unwrap_or(", ")),
            ),
            other => Value::String(value_text(other)),
        },
        "count" => Value::from(match &v {
            Value::Array(a) => a.len(),
            Value::Object(o) => o.len(),
            Value::String(s) => s.chars().count(),
            _ => 0,
        }),
        "yesno" => {
            let (yes, no) = arg.and_then(|a| a.split_once(',')).unwrap_or(("yes", "no"));
            Value::String(if truthy(Some(&v)) { yes } else { no }.to_string())
        }
        _ => v,
    }
}

/// Escapes text for Markdown: no link, image, HTML, emphasis, table or block can start
/// inside a value, and a value stays on one line.
pub fn md_escape(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    for c in t.chars() {
        match c {
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '|' | '~' | '!' | '#' => {
                out.push('\\');
                out.push(c);
            }
            '\n' | '\r' | '\t' => out.push(' '),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

impl Render {
    fn push(&mut self, s: &str) {
        if self.out.len() <= MAX_OUTPUT {
            self.out.push_str(s);
        }
    }

    fn parts(&mut self, parts: &[Part], stack: &mut Vec<&Value>) {
        for p in parts {
            if self.out.len() > MAX_OUTPUT {
                return;
            }
            match p {
                Part::Text(t) => self.push(t),
                Part::Var(name, filters) => {
                    let mut v = lookup(stack, name).cloned().unwrap_or(Value::Null);
                    for f in filters {
                        v = apply(v, f);
                    }
                    let t = value_text(&v);
                    match self.target {
                        Target::Markdown => self.push(&md_escape(&t)),
                        Target::Text => self.push(&t),
                    }
                }
                Part::Section {
                    name,
                    inverted,
                    body,
                } => {
                    let v = lookup(stack, name);
                    if *inverted {
                        if !truthy(v) {
                            self.parts(body, stack);
                        }
                        continue;
                    }
                    if !truthy(v) {
                        continue;
                    }
                    match v {
                        Some(Value::Array(items)) => {
                            for item in items {
                                self.iterations += 1;
                                if self.iterations > MAX_ITERATIONS {
                                    return;
                                }
                                stack.push(item);
                                self.parts(body, stack);
                                stack.pop();
                            }
                        }
                        Some(obj @ Value::Object(_)) => {
                            stack.push(obj);
                            self.parts(body, stack);
                            stack.pop();
                        }
                        _ => self.parts(body, stack),
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn md(t: &str, ctx: Value) -> String {
        Template::parse(t).unwrap().render(&ctx, Target::Markdown)
    }

    #[test]
    fn the_manifest_example_renders() {
        assert_eq!(
            md(
                "**{{objective}}** ({{progress|percent}})",
                json!({"objective": "Ship v0.2", "progress": 0.42})
            ),
            "**Ship v0.2** (42%)"
        );
    }

    #[test]
    fn values_cannot_inject_markdown_or_html() {
        let out = md(
            "{{x}}",
            json!({"x": "[a](javascript:alert(1)) <script>\n# h ![i](x)"}),
        );
        assert_eq!(
            out,
            "\\[a\\](javascript:alert(1)) \\<script\\> \\# h \\!\\[i\\](x)"
        );
        assert!(!out.contains('\n'));
    }

    #[test]
    fn code_like_tags_are_refused() {
        for t in [
            "{{{x}}}",
            "{{&x}}",
            "{{>partial}}",
            "{{=<% %>=}}",
            "{{x|eval}}",
            "{{#a}}",
            "{{/a}}",
            "{{a b}}",
            "{{x",
        ] {
            assert!(Template::parse(t).is_err(), "{t}");
        }
    }

    #[test]
    fn sections_iterate_and_invert() {
        let t = "{{#krs}}- {{title}} {{done|yesno:\"done,open\"}}\n{{/krs}}{{^krs}}none{{/krs}}";
        assert_eq!(
            md(
                t,
                json!({"krs": [{"title": "A", "done": true}, {"title": "B", "done": false}]})
            ),
            "- A done\n- B open\n"
        );
        assert_eq!(md(t, json!({"krs": []})), "none");
    }
}
