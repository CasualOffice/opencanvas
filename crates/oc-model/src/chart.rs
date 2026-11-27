// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! SHEET-06 (frame 4h): the linked chart block (`chart` node, `core.chart`) for exports. A chart
//! reads a sheet range (computed values) or a database grouped by one field with an aggregate;
//! exports write the values it draws as a table. The rules mirror the editor's
//! `web/packages/editor/src/editor/chart/data.ts`; keep them equal.

use serde_json::Value;

use crate::export::{attr_str, s};

/// The chart node's type.
pub const CHART_NODE: &str = "chart";

/// Categories and named series, as the editor draws them.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ChartData {
    pub cat_label: String,
    pub categories: Vec<String>,
    pub series: Vec<(String, Vec<Option<f64>>)>,
}

/// A display text as a number: currency signs, spaces, thousands commas and % are ignored;
/// `(n)` is negative.
pub fn parse_num(text: &str) -> Option<f64> {
    let mut t = text.trim();
    if t.is_empty() {
        return None;
    }
    let mut neg = false;
    if t.len() >= 2 && t.starts_with('(') && t.ends_with(')') {
        neg = true;
        t = &t[1..t.len() - 1];
    }
    let t: String = t
        .chars()
        .filter(|c| !matches!(c, '€' | '$' | '£' | '¥' | ',' | '%') && !c.is_whitespace())
        .collect();
    let b = t.as_bytes();
    // Digits with one optional dot, an optional sign and exponent (no "inf", "nan").
    let body = t.trim_start_matches(['+', '-']);
    let mant = body.split(['e', 'E']).next().unwrap_or_default();
    if b.is_empty()
        || mant.is_empty()
        || !mant.chars().all(|c| c.is_ascii_digit() || c == '.')
        || mant.chars().filter(|&c| c == '.').count() > 1
        || mant == "."
    {
        return None;
    }
    let n: f64 = t.parse().ok()?;
    n.is_finite().then_some(if neg { -n } else { n })
}

fn is_text(t: Option<&String>) -> bool {
    t.is_some_and(|t| !t.trim().is_empty() && parse_num(t).is_none())
}

/// A range's display texts as chart data (see `fromGrid` in the editor).
pub fn from_grid(g: &[Vec<String>]) -> ChartData {
    let rows: Vec<&Vec<String>> = g.iter().filter(|r| !r.is_empty()).collect();
    let w = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    let empty = vec![];
    let r0 = rows.first().copied().unwrap_or(&empty);
    let header = rows.len() > 1
        && r0.iter().any(|t| !t.trim().is_empty())
        && r0.iter().all(|t| t.trim().is_empty() || is_text(Some(t)));
    let body = if header { &rows[1..] } else { &rows[..] };
    let cat_col = w > 1 && body.iter().any(|r| is_text(r.first()));
    let first = usize::from(cat_col);
    let mut series: Vec<(String, Vec<Option<f64>>)> = Vec::new();
    for j in first..w {
        let name = r0
            .get(j)
            .map(|t| t.trim())
            .filter(|t| header && !t.is_empty());
        let name = name.map_or_else(|| format!("Series {}", series.len() + 1), String::from);
        series.push((name, vec![]));
    }
    let mut categories = Vec::new();
    for r in body {
        let vals: Vec<Option<f64>> = (0..series.len())
            .map(|k| r.get(first + k).and_then(|t| parse_num(t)))
            .collect();
        let cat = if cat_col {
            r.first().map(|t| t.trim().to_string()).unwrap_or_default()
        } else {
            String::new()
        };
        if cat.is_empty() && vals.iter().all(Option::is_none) {
            continue;
        }
        categories.push(if cat_col {
            cat
        } else {
            (categories.len() + 1).to_string()
        });
        for (k, v) in vals.into_iter().enumerate() {
            series[k].1.push(v);
        }
    }
    ChartData {
        cat_label: if header && cat_col {
            r0.first().map(|t| t.trim().to_string()).unwrap_or_default()
        } else {
            String::new()
        },
        categories,
        series,
    }
}

/// Records grouped by key (first-seen order, "" as "(empty)") with one aggregate per group.
pub fn from_groups(items: &[(String, Option<f64>)], agg: &str, field: &str) -> ChartData {
    let mut keys: Vec<String> = vec![];
    let mut groups: Vec<Vec<Option<f64>>> = vec![];
    for (k, v) in items {
        let k = match k.trim() {
            "" => "(empty)".to_string(),
            k => k.to_string(),
        };
        match keys.iter().position(|x| *x == k) {
            Some(i) => groups[i].push(*v),
            None => {
                keys.push(k);
                groups.push(vec![*v]);
            }
        }
    }
    let values = groups
        .iter()
        .map(|vs| {
            if agg == "count" {
                return Some(vs.len() as f64);
            }
            let ns: Vec<f64> = vs.iter().flatten().copied().collect();
            if ns.is_empty() {
                return None;
            }
            Some(match agg {
                "sum" => ns.iter().sum(),
                "avg" => ns.iter().sum::<f64>() / ns.len() as f64,
                "min" => ns.iter().copied().fold(f64::INFINITY, f64::min),
                _ => ns.iter().copied().fold(f64::NEG_INFINITY, f64::max),
            })
        })
        .collect();
    let label = match agg {
        "sum" => "Sum",
        "avg" => "Average",
        "min" => "Min",
        "max" => "Max",
        _ => "Count",
    };
    let name = if agg == "count" || !matches!(agg, "sum" | "avg" | "min" | "max") {
        "Count".to_string()
    } else {
        format!(
            "{label} of {}",
            if field.is_empty() { "value" } else { field }
        )
    };
    ChartData {
        cat_label: String::new(),
        categories: keys,
        series: vec![(name, values)],
    }
}

/// A value as the table writes it (`fmtNum` in the editor).
pub fn fmt_num(v: Option<f64>) -> String {
    match v {
        None => String::new(),
        Some(v) if v.fract() == 0.0 && v.abs() < 1e15 => format!("{}", v as i64),
        Some(v) => format!("{}", (v * 1e10).round() / 1e10),
    }
}

/// Header + rows (`toTable` in the editor).
pub fn to_table(d: &ChartData) -> (Vec<String>, Vec<Vec<String>>) {
    let mut header = vec![if d.cat_label.is_empty() {
        "Category".to_string()
    } else {
        d.cat_label.clone()
    }];
    header.extend(d.series.iter().map(|(n, _)| n.clone()));
    let rows = d
        .categories
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let mut r = vec![c.clone()];
            r.extend(
                d.series
                    .iter()
                    .map(|(_, v)| fmt_num(v.get(i).copied().flatten())),
            );
            r
        })
        .collect();
    (header, rows)
}

/// What a chart node draws, read from the document (sheet range or database groups).
pub fn chart_data(doc: &Value, n: &Value) -> ChartData {
    match attr_str(n, "src") {
        "sheet" => sheet_range(doc, n)
            .map(|g| from_grid(&g))
            .unwrap_or_default(),
        "db" => db_groups(doc, n),
        _ => ChartData::default(),
    }
}

fn sheet_range(doc: &Value, n: &Value) -> Option<Vec<Vec<String>>> {
    let block = &doc["sheets"][attr_str(n, "sheetId")];
    if !block.is_object() {
        return None;
    }
    let sheet = attr_str(n, "sheet");
    let book = oc_sheet::block::book_sheets(block);
    let bs = book.iter().find(|b| b.id == sheet)?;
    let at = |ids: &[String], id: &str| ids.iter().position(|x| x == id);
    let (r0, r1) = (
        at(&bs.rows, attr_str(n, "r0"))?,
        at(&bs.rows, attr_str(n, "r1"))?,
    );
    let (c0, c1) = (
        at(&bs.cols, attr_str(n, "c0"))?,
        at(&bs.cols, attr_str(n, "c1"))?,
    );
    let (r0, r1, c0, c1) = (r0.min(r1), r0.max(r1), c0.min(c1), c0.max(c1));
    let tables = oc_sheet::block::tables(block);
    let t = tables.iter().find(|t| t.id == sheet)?;
    Some(
        (r0..=r1)
            .map(|r| {
                (c0..=c1)
                    .map(|c| {
                        t.rows
                            .get(r)
                            .and_then(|row| row.get(c))
                            .cloned()
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .collect(),
    )
}

fn db_groups(doc: &Value, n: &Value) -> ChartData {
    let id = attr_str(n, "dbId");
    let fields = doc["databases"][id]["fields"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let ix = |fid: &str| fields.iter().position(|f| s(f, "id") == fid);
    let (_, _, rows) = crate::export::database_table(doc, id);
    let g = ix(attr_str(n, "groupBy"));
    let v = ix(attr_str(n, "field"));
    let agg = match attr_str(n, "agg") {
        "" => "count",
        a => a,
    };
    let items: Vec<(String, Option<f64>)> = rows
        .iter()
        .map(|r| {
            (
                g.and_then(|g| r.get(g)).cloned().unwrap_or_default(),
                v.and_then(|v| r.get(v)).and_then(|t| parse_num(t)),
            )
        })
        .collect();
    let field = v.map(|v| s(&fields[v], "name")).unwrap_or_default();
    // Without a value field only a count makes sense (as the editor draws it).
    let agg = if v.is_none() { "count" } else { agg };
    let mut d = from_groups(&items, agg, field);
    d.cat_label = g
        .map(|g| s(&fields[g], "name").to_string())
        .unwrap_or_default();
    d
}

/// The chart's title: its own, else "Total by Category", else the database's name, else
/// "Chart" (`autoTitle` in the editor).
pub fn chart_title(doc: &Value, n: &Value, d: &ChartData) -> String {
    let t = attr_str(n, "title").trim();
    if !t.is_empty() {
        return t.to_string();
    }
    if !d.cat_label.is_empty() && d.series.len() == 1 {
        return format!("{} by {}", d.series[0].0, d.cat_label);
    }
    if attr_str(n, "src") == "db" {
        let name = s(&doc["databases"][attr_str(n, "dbId")], "name");
        if !name.is_empty() {
            return name.to_string();
        }
    }
    "Chart".into()
}

/// "Column chart", "Pie chart", … for the caption.
pub fn kind_label(n: &Value) -> &'static str {
    match attr_str(n, "kind") {
        "line" => "Line chart",
        "area" => "Area chart",
        "pie" => "Pie chart",
        "donut" => "Donut chart",
        "scatter" => "Scatter chart",
        _ => "Column chart",
    }
}
