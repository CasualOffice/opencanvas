// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Structural diff of two canvas versions (VH-02a, ADR-052, docs/30 §6.1).
//!
//! Works on the `document.json` projection of each version (`content`, `meta`, `databases`,
//! `boards`; comments and people are not diffed):
//!
//! - **Blocks.** The content tree is flattened to leaf blocks (textblocks and atoms; lists,
//!   toggles, columns, callouts and tables recurse) with JSON-pointer paths. Blocks are matched by
//!   `blockId` first; the rest by a Myers diff over signatures (type, container chain, normalised
//!   text), and the leftovers in each gap are paired by word similarity (≥ 0.5) as *changed*.
//!   Matched blocks outside the longest increasing run of positions are *moved*.
//! - **Inline text.** Word-level Myers with a semantic clean-up: `[[op, text], …]`, op `eq`,
//!   `del`, `ins`. Mark-only changes are `formatting`.
//! - **Databases** by `dbId`: fields, rows, cells, row notes, order and view settings.
//! - **Boards** by `boardId`: shapes added, removed, moved (> 2 px, same size), resized, text,
//!   style, connector re-bound; paint order.
//! - **Meta**: title and icon.
//!
//! At most [`MAX_ENTRIES`] entries (then `truncated`), and [`MAX_TIME`] per diff (then
//! [`DiffError::TimedOut`]). [`DiffCache`] keeps results and decoded versions in memory only.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Map as JsonMap, Value, json};

use crate::doc::doc_to_json;

/// Entries in one diff before it is cut off with `truncated: true`.
pub const MAX_ENTRIES: usize = 2000;
/// Time one diff may take (docs/30 §6.1: 5 s of CPU; measured as elapsed time on the thread
/// running it, which callers keep on a blocking worker).
pub const MAX_TIME: Duration = Duration::from_secs(5);
/// Boards: a move smaller than this (px, either axis) is not reported.
const MOVE_PX: f64 = 2.0;
/// Similarity at or above which two unmatched blocks of the same type pair as *changed*.
const SIMILAR: f64 = 0.5;
/// Myers gives up past this many edits and treats the rest as delete + insert.
const MAX_EDITS: usize = 4000;

#[derive(Debug, Clone)]
pub struct Limits {
    pub max_entries: usize,
    pub max_time: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_entries: MAX_ENTRIES,
            max_time: MAX_TIME,
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DiffError {
    #[error("the diff took longer than the time limit")]
    TimedOut,
}

/// Diffs two decoded versions.
pub fn diff_docs(old: &yrs::Doc, new: &yrs::Doc, limits: &Limits) -> Result<Value, DiffError> {
    diff_json(&doc_to_json(old), &doc_to_json(new), limits)
}

/// Diffs two `document.json` values. `old` is the base, `new` the version shown.
pub fn diff_json(old: &Value, new: &Value, limits: &Limits) -> Result<Value, DiffError> {
    let mut cx = Cx {
        deadline: Instant::now() + limits.max_time,
        zero: limits.max_time.is_zero(),
        left: limits.max_entries,
        truncated: false,
        sum: Summary::default(),
    };
    cx.check()?;
    let meta = diff_meta(&mut cx, &old["meta"], &new["meta"]);
    let blocks = diff_blocks(&mut cx, old, new)?;
    let databases = diff_databases(&mut cx, &old["databases"], &new["databases"])?;
    let boards = diff_boards(&mut cx, &old["boards"], &new["boards"])?;
    Ok(json!({
        "summary": {"added": cx.sum.added, "removed": cx.sum.removed, "changed": cx.sum.changed, "moved": cx.sum.moved},
        "meta": meta,
        "blocks": blocks,
        "databases": databases,
        "boards": boards,
        "truncated": cx.truncated,
    }))
}

// ---------- bookkeeping ----------

#[derive(Default)]
struct Summary {
    added: usize,
    removed: usize,
    changed: usize,
    moved: usize,
}

#[derive(Clone, Copy)]
enum Kind {
    Added,
    Removed,
    Changed,
    Moved,
}

struct Cx {
    deadline: Instant,
    zero: bool,
    left: usize,
    truncated: bool,
    sum: Summary,
}

impl Cx {
    fn check(&self) -> Result<(), DiffError> {
        if self.zero || Instant::now() > self.deadline {
            Err(DiffError::TimedOut)
        } else {
            Ok(())
        }
    }
    /// Adds one entry, counting it, unless the entry budget is spent.
    fn push(&mut self, out: &mut Vec<Value>, v: Value, kind: Kind) {
        if self.left == 0 {
            self.truncated = true;
            return;
        }
        self.left -= 1;
        match kind {
            Kind::Added => self.sum.added += 1,
            Kind::Removed => self.sum.removed += 1,
            Kind::Changed => self.sum.changed += 1,
            Kind::Moved => self.sum.moved += 1,
        }
        out.push(v);
    }
}

// ---------- Myers ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Op {
    Eq(usize, usize),
    Del(usize),
    Ins(usize),
}

/// Myers without the per-diff time limit (in-file history, ADR-055).
pub(crate) fn myers_unbounded<T: PartialEq>(a: &[T], b: &[T]) -> Vec<Op> {
    let cx = Cx {
        deadline: Instant::now() + Duration::from_secs(3600),
        zero: false,
        left: 0,
        truncated: false,
        sum: Summary::default(),
    };
    myers(a, b, &cx).unwrap_or_else(|_| {
        let mut out: Vec<Op> = (0..a.len()).map(Op::Del).collect();
        out.extend((0..b.len()).map(Op::Ins));
        out
    })
}

/// Myers' O(ND) diff of `a` and `b`. Past [`MAX_EDITS`] the middle is a plain delete + insert.
fn myers<T: PartialEq>(a: &[T], b: &[T], cx: &Cx) -> Result<Vec<Op>, DiffError> {
    // Common prefix and suffix first: most versions differ in a few places.
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf]
    {
        suf += 1;
    }
    let (am, bm) = (&a[pre..a.len() - suf], &b[pre..b.len() - suf]);
    let mut out: Vec<Op> = (0..pre).map(|i| Op::Eq(i, i)).collect();
    for op in myers_core(am, bm, cx)? {
        out.push(match op {
            Op::Eq(i, j) => Op::Eq(i + pre, j + pre),
            Op::Del(i) => Op::Del(i + pre),
            Op::Ins(j) => Op::Ins(j + pre),
        });
    }
    out.extend((0..suf).map(|k| Op::Eq(a.len() - suf + k, b.len() - suf + k)));
    Ok(out)
}

fn myers_core<T: PartialEq>(a: &[T], b: &[T], cx: &Cx) -> Result<Vec<Op>, DiffError> {
    let (n, m) = (a.len() as isize, b.len() as isize);
    if n == 0 || m == 0 {
        let mut out: Vec<Op> = (0..a.len()).map(Op::Del).collect();
        out.extend((0..b.len()).map(Op::Ins));
        return Ok(out);
    }
    let max = (n + m) as usize;
    let off = max as isize;
    let mut v = vec![0isize; 2 * max + 2];
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut found = None;
    for d in 0..=max.min(MAX_EDITS) as isize {
        if d % 64 == 0 {
            cx.check()?;
        }
        trace.push(v[(off - d) as usize..=(off + d) as usize].to_vec());
        let mut k = -d;
        while k <= d {
            let mut x =
                if k == -d || (k != d && v[(off + k - 1) as usize] < v[(off + k + 1) as usize]) {
                    v[(off + k + 1) as usize]
                } else {
                    v[(off + k - 1) as usize] + 1
                };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[(off + k) as usize] = x;
            if x >= n && y >= m {
                found = Some(d);
                break;
            }
            k += 2;
        }
        if found.is_some() {
            break;
        }
    }
    let Some(dmax) = found else {
        // Too different: everything in the middle is replaced.
        let mut out: Vec<Op> = (0..a.len()).map(Op::Del).collect();
        out.extend((0..b.len()).map(Op::Ins));
        return Ok(out);
    };
    // Backtrack through the saved frontiers. `trace[d]` holds v for k in -d..=d before step d.
    let mut ops = Vec::new();
    let (mut x, mut y) = (n, m);
    for d in (1..=dmax).rev() {
        let vd = &trace[d as usize];
        let get = |k: isize| vd[(k + d) as usize];
        let k = x - y;
        let prev_k = if k == -d || (k != d && get(k - 1) < get(k + 1)) {
            k + 1
        } else {
            k - 1
        };
        let prev_x = get(prev_k);
        let prev_y = prev_x - prev_k;
        while x > prev_x && y > prev_y {
            x -= 1;
            y -= 1;
            ops.push(Op::Eq(x as usize, y as usize));
        }
        if x == prev_x {
            y -= 1;
            ops.push(Op::Ins(y as usize));
        } else {
            x -= 1;
            ops.push(Op::Del(x as usize));
        }
    }
    while x > 0 && y > 0 {
        x -= 1;
        y -= 1;
        ops.push(Op::Eq(x as usize, y as usize));
    }
    ops.reverse();
    Ok(ops)
}

/// Indices (into `seq`) of a longest strictly increasing subsequence.
fn lis(seq: &[usize]) -> HashSet<usize> {
    let mut tails: Vec<usize> = Vec::new(); // index into seq
    let mut prev = vec![usize::MAX; seq.len()];
    for (i, &x) in seq.iter().enumerate() {
        let pos = tails.partition_point(|&t| seq[t] < x);
        if pos > 0 {
            prev[i] = tails[pos - 1];
        }
        if pos == tails.len() {
            tails.push(i);
        } else {
            tails[pos] = i;
        }
    }
    let mut out = HashSet::new();
    let mut cur = tails.last().copied();
    while let Some(i) = cur {
        out.insert(i);
        cur = (prev[i] != usize::MAX).then_some(prev[i]);
    }
    out
}

// ---------- inline text ----------

/// Words, whitespace runs and single other characters.
fn tokens(s: &str) -> Vec<&str> {
    #[derive(PartialEq, Clone, Copy)]
    enum C {
        W,
        S,
        P,
    }
    let class = |c: char| {
        if c.is_alphanumeric() || c == '_' || c == '\'' {
            C::W
        } else if c.is_whitespace() {
            C::S
        } else {
            C::P
        }
    };
    let mut out = Vec::new();
    let mut start = 0;
    let mut last: Option<C> = None;
    for (i, c) in s.char_indices() {
        let k = class(c);
        if let Some(l) = last
            && (l != k || k == C::P)
        {
            out.push(&s[start..i]);
            start = i;
        }
        last = Some(k);
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

/// Word-level diff of two strings, `[[op, text], …]` with `eq`, `del`, `ins`.
fn text_diff(a: &str, b: &str, cx: &Cx) -> Result<Value, DiffError> {
    let (ta, tb) = (tokens(a), tokens(b));
    let ops = myers(&ta, &tb, cx)?;
    // Runs of (op, text): 0 eq, 1 del, 2 ins.
    let mut runs: Vec<(u8, String)> = Vec::new();
    for op in ops {
        let (k, t) = match op {
            Op::Eq(i, _) => (0u8, ta[i]),
            Op::Del(i) => (1, ta[i]),
            Op::Ins(j) => (2, tb[j]),
        };
        runs.push((k, t.to_string()));
    }
    // Semantic clean-up: an equality that is only whitespace or punctuation between two changes
    // joins them ("quick brown" → "slow red" reads as one change, not two).
    let is_change = |r: Option<&(u8, String)>| r.is_some_and(|r| r.0 != 0);
    let mut i = 0;
    let mut clean: Vec<(u8, String)> = Vec::new();
    while i < runs.len() {
        let r = &runs[i];
        if r.0 == 0
            && !r.1.chars().any(char::is_alphanumeric)
            && is_change(clean.last())
            && is_change(runs.get(i + 1))
        {
            clean.push((1, r.1.clone()));
            clean.push((2, r.1.clone()));
        } else {
            clean.push(r.clone());
        }
        i += 1;
    }
    // Group: each stretch of changes becomes one del then one ins; equalities merge.
    let mut out: Vec<(u8, String)> = Vec::new();
    let (mut del, mut ins) = (String::new(), String::new());
    let flush = |out: &mut Vec<(u8, String)>, del: &mut String, ins: &mut String| {
        if !del.is_empty() {
            out.push((1, std::mem::take(del)));
        }
        if !ins.is_empty() {
            out.push((2, std::mem::take(ins)));
        }
    };
    for (k, t) in clean {
        match k {
            1 => del.push_str(&t),
            2 => ins.push_str(&t),
            _ => {
                flush(&mut out, &mut del, &mut ins);
                match out.last_mut() {
                    Some((0, s)) => s.push_str(&t),
                    _ => out.push((0, t)),
                }
            }
        }
    }
    flush(&mut out, &mut del, &mut ins);
    Ok(Value::Array(
        out.into_iter()
            .map(|(k, t)| {
                let op = ["eq", "del", "ins"][k as usize];
                json!([op, t])
            })
            .collect(),
    ))
}

fn words(s: &str) -> Vec<&str> {
    tokens(s)
        .into_iter()
        .filter(|t| t.chars().any(char::is_alphanumeric))
        .collect()
}

/// Dice coefficient over word multisets; two texts without words are alike.
fn similarity(a: &str, b: &str) -> f64 {
    let (wa, wb) = (words(a), words(b));
    if wa.is_empty() && wb.is_empty() {
        return 1.0;
    }
    let mut counts: HashMap<&str, isize> = HashMap::new();
    for w in &wa {
        *counts.entry(w).or_default() += 1;
    }
    let mut common = 0;
    for w in &wb {
        if let Some(c) = counts.get_mut(w)
            && *c > 0
        {
            *c -= 1;
            common += 1;
        }
    }
    2.0 * common as f64 / (wa.len() + wb.len()) as f64
}

// ---------- meta ----------

fn diff_meta(cx: &mut Cx, old: &Value, new: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for field in ["title", "icon"] {
        let (a, b) = (&old[field], &new[field]);
        if a != b {
            cx.push(
                &mut out,
                json!({"field": field, "old": a, "new": b}),
                Kind::Changed,
            );
        }
    }
    out
}

// ---------- blocks ----------

const INLINE: &[&str] = &["text", "mention", "dateMention", "hardBreak", "embed"];
const TEXTBLOCKS: &[&str] = &["paragraph", "heading", "codeBlock", "toggleSummary"];

struct Unit<'a> {
    path: String,
    node: &'a Value,
    ty: &'a str,
    id: Option<&'a str>,
    /// Container chain, e.g. `bulletList>listItem`.
    ctx: String,
    /// The containers around the block, outermost first (their attributes count as the
    /// block's: a task's `checked`, a callout's `tone`).
    wrap: Vec<&'a Value>,
    text: String,
}

impl Unit<'_> {
    fn sig(&self) -> (&str, &str, String) {
        (
            self.ty,
            &self.ctx,
            self.text.split_whitespace().collect::<Vec<_>>().join(" "),
        )
    }
}

fn is_leaf(n: &Value) -> bool {
    let ty = n["type"].as_str().unwrap_or("");
    if TEXTBLOCKS.contains(&ty) {
        return true;
    }
    match n["content"].as_array() {
        None => true,
        Some(c) => {
            c.is_empty()
                || c.iter()
                    .any(|x| INLINE.contains(&x["type"].as_str().unwrap_or("")))
        }
    }
}

fn inline_text(n: &Value) -> String {
    let mut s = String::new();
    for c in n["content"].as_array().into_iter().flatten() {
        match c["type"].as_str().unwrap_or("") {
            "text" => s.push_str(c["text"].as_str().unwrap_or("")),
            "mention" => {
                s.push('@');
                s.push_str(
                    c["attrs"]["label"]
                        .as_str()
                        .or(c["attrs"]["id"].as_str())
                        .unwrap_or(""),
                );
            }
            "dateMention" => s.push_str(c["attrs"]["date"].as_str().unwrap_or("")),
            "hardBreak" => s.push('\n'),
            _ => {}
        }
    }
    s
}

fn flatten<'a>(
    content: &'a Value,
    base: &str,
    ctx: &str,
    wrap: &[&'a Value],
    out: &mut Vec<Unit<'a>>,
) {
    for (i, n) in content.as_array().into_iter().flatten().enumerate() {
        let path = format!("{base}/{i}");
        let ty = n["type"].as_str().unwrap_or("");
        if is_leaf(n) {
            out.push(Unit {
                path,
                node: n,
                ty,
                id: n["attrs"]["blockId"].as_str().filter(|s| !s.is_empty()),
                ctx: ctx.to_string(),
                wrap: wrap.to_vec(),
                text: inline_text(n),
            });
        } else {
            let inner = if ctx.is_empty() {
                ty.to_string()
            } else {
                format!("{ctx}>{ty}")
            };
            let mut w = wrap.to_vec();
            w.push(n);
            flatten(&n["content"], &format!("{path}/content"), &inner, &w, out);
        }
    }
}

/// Attributes other than `blockId`.
fn attrs_of(n: &Value) -> JsonMap<String, Value> {
    let mut m = n["attrs"].as_object().cloned().unwrap_or_default();
    m.remove("blockId");
    m.retain(|_, v| !v.is_null());
    m
}

/// What changed between two paired blocks; None when nothing did.
fn block_changes(a: &Unit, b: &Unit, cx: &Cx) -> Result<Option<JsonMap<String, Value>>, DiffError> {
    let mut changes = Vec::new();
    let mut e = JsonMap::new();
    if a.ty != b.ty {
        changes.push("type");
        e.insert("type".into(), json!({"old": a.ty, "new": b.ty}));
    }
    if a.ctx != b.ctx {
        changes.push("context");
        e.insert("context".into(), json!({"old": a.ctx, "new": b.ctx}));
    }
    if a.text != b.text {
        changes.push("text");
        e.insert("text".into(), text_diff(&a.text, &b.text, cx)?);
    } else if a.node["content"] != b.node["content"] {
        changes.push("formatting");
    }
    let (mut aa, mut ba) = (attrs_of(a.node), attrs_of(b.node));
    if a.ctx == b.ctx {
        for (x, y) in a.wrap.iter().zip(&b.wrap) {
            let ty = x["type"].as_str().unwrap_or("");
            aa.extend(
                attrs_of(x)
                    .into_iter()
                    .map(|(k, v)| (format!("{ty}.{k}"), v)),
            );
            ba.extend(
                attrs_of(y)
                    .into_iter()
                    .map(|(k, v)| (format!("{ty}.{k}"), v)),
            );
        }
    }
    if aa != ba {
        changes.push("attrs");
        let keys: BTreeSet<&String> = aa.keys().chain(ba.keys()).collect();
        let mut d = JsonMap::new();
        for k in keys {
            let (x, y) = (
                aa.get(k).unwrap_or(&Value::Null),
                ba.get(k).unwrap_or(&Value::Null),
            );
            if x != y {
                d.insert(k.clone(), json!({"old": x, "new": y}));
            }
        }
        e.insert("attrs".into(), Value::Object(d));
    }
    if changes.is_empty() {
        return Ok(None);
    }
    e.insert("changes".into(), json!(changes));
    Ok(Some(e))
}

fn diff_blocks(cx: &mut Cx, old: &Value, new: &Value) -> Result<Vec<Value>, DiffError> {
    let (mut ua, mut ub) = (Vec::new(), Vec::new());
    flatten(&old["content"], "/content", "", &[], &mut ua);
    flatten(&new["content"], "/content", "", &[], &mut ub);
    let mut pair_a: Vec<Option<usize>> = vec![None; ua.len()];
    let mut pair_b: Vec<Option<usize>> = vec![None; ub.len()];

    // 1. By blockId, when the id is unique on both sides.
    fn index<'a>(us: &[Unit<'a>]) -> HashMap<&'a str, Option<usize>> {
        let mut m: HashMap<&'a str, Option<usize>> = HashMap::new();
        for (i, u) in us.iter().enumerate() {
            if let Some(id) = u.id {
                m.entry(id).and_modify(|e| *e = None).or_insert(Some(i));
            }
        }
        m
    }
    let (ia, ib) = (index(&ua), index(&ub));
    for (id, i) in &ia {
        if let (Some(i), Some(Some(j))) = (i, ib.get(id)) {
            pair_a[*i] = Some(*j);
            pair_b[*j] = Some(*i);
        }
    }

    // 2. The rest: Myers over signatures, then similarity pairing inside each gap.
    let ra: Vec<usize> = (0..ua.len()).filter(|&i| pair_a[i].is_none()).collect();
    let rb: Vec<usize> = (0..ub.len()).filter(|&j| pair_b[j].is_none()).collect();
    let sa: Vec<_> = ra.iter().map(|&i| ua[i].sig()).collect();
    let sb: Vec<_> = rb.iter().map(|&j| ub[j].sig()).collect();
    let ops = myers(&sa, &sb, cx)?;
    let (mut gap_a, mut gap_b) = (Vec::new(), Vec::new());
    let pair_gap = |ga: &mut Vec<usize>,
                    gb: &mut Vec<usize>,
                    pa: &mut [Option<usize>],
                    pb: &mut [Option<usize>]|
     -> Result<(), DiffError> {
        let mut from = 0;
        for &i in ga.iter() {
            cx.check()?;
            for (k, &j) in gb.iter().enumerate().skip(from) {
                if pb[j].is_none()
                    && ua[i].ty == ub[j].ty
                    && similarity(&ua[i].text, &ub[j].text) >= SIMILAR
                {
                    pa[i] = Some(j);
                    pb[j] = Some(i);
                    from = k + 1;
                    break;
                }
            }
        }
        ga.clear();
        gb.clear();
        Ok(())
    };
    for op in ops {
        match op {
            Op::Eq(x, y) => {
                pair_gap(&mut gap_a, &mut gap_b, &mut pair_a, &mut pair_b)?;
                pair_a[ra[x]] = Some(rb[y]);
                pair_b[rb[y]] = Some(ra[x]);
            }
            Op::Del(x) => gap_a.push(ra[x]),
            Op::Ins(y) => gap_b.push(rb[y]),
        }
    }
    pair_gap(&mut gap_a, &mut gap_b, &mut pair_a, &mut pair_b)?;

    // 3. Moved: pairs (in old order) outside the longest increasing run of new positions.
    let pairs: Vec<(usize, usize)> = pair_a
        .iter()
        .enumerate()
        .filter_map(|(i, j)| j.map(|j| (i, j)))
        .collect();
    let keep = lis(&pairs.iter().map(|p| p.1).collect::<Vec<_>>());
    let moved: HashSet<usize> = pairs
        .iter()
        .enumerate()
        .filter(|(k, _)| !keep.contains(k))
        .map(|(_, p)| p.1)
        .collect();

    // 4. Entries in new order; a removed block sits after the nearest earlier block that is
    // still there.
    let mut items: Vec<((isize, u8, usize), Value, Kind)> = Vec::new();
    for (j, b) in ub.iter().enumerate() {
        cx.check()?;
        let key = (j as isize, 0u8, 0usize);
        match pair_b[j] {
            None => {
                let mut e = json!({"op": "added", "path": b.path, "type": b.ty});
                if let Some(id) = b.id {
                    e["blockId"] = json!(id);
                }
                items.push((key, e, Kind::Added));
            }
            Some(i) => {
                let a = &ua[i];
                let ch = block_changes(a, b, cx)?;
                let is_moved = moved.contains(&j);
                if ch.is_none() && !is_moved {
                    continue;
                }
                let mut e = JsonMap::new();
                e.insert(
                    "op".into(),
                    json!(if is_moved { "moved" } else { "changed" }),
                );
                e.insert("path".into(), json!(b.path));
                if let Some(id) = b.id {
                    e.insert("blockId".into(), json!(id));
                }
                e.insert("type".into(), json!(b.ty));
                if is_moved {
                    e.insert("from".into(), json!(a.path));
                }
                if let Some(ch) = ch {
                    e.extend(ch);
                }
                items.push((
                    key,
                    Value::Object(e),
                    if is_moved { Kind::Moved } else { Kind::Changed },
                ));
            }
        }
    }
    let mut anchor: Option<usize> = None;
    for (i, a) in ua.iter().enumerate() {
        if let Some(j) = pair_a[i] {
            anchor = Some(j);
            continue;
        }
        let mut e = json!({"op": "removed", "path": a.path, "type": a.ty, "node": a.node, "after": Value::Null});
        if let Some(id) = a.id {
            e["blockId"] = json!(id);
        }
        if !a.ctx.is_empty() {
            e["context"] = json!(a.ctx);
        }
        if let Some(j) = anchor {
            let mut after = json!({"path": ub[j].path});
            if let Some(id) = ub[j].id {
                after["blockId"] = json!(id);
            }
            e["after"] = after;
        }
        let key = (anchor.map_or(-1, |j| j as isize), 1u8, i);
        items.push((key, e, Kind::Removed));
    }
    items.sort_by_key(|x| x.0);
    let mut out = Vec::new();
    for (_, e, k) in items {
        cx.push(&mut out, e, k);
    }
    Ok(out)
}

// ---------- databases ----------

fn obj(v: &Value) -> JsonMap<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

fn str_list(v: &Value) -> Vec<&str> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

/// Keys of `old` and `new` maps in a stable order: those in `new` (by `order`, then the rest
/// sorted), then those only in `old` (sorted).
fn ordered_ids<'a>(
    order: &[&'a str],
    old: &'a JsonMap<String, Value>,
    new: &'a JsonMap<String, Value>,
) -> Vec<&'a str> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for id in order.iter().copied().filter(|id| new.contains_key(*id)) {
        if seen.insert(id) {
            out.push(id);
        }
    }
    let mut rest: Vec<&str> = new
        .keys()
        .map(String::as_str)
        .filter(|k| !seen.contains(k))
        .collect();
    rest.sort();
    for id in rest {
        seen.insert(id);
        out.push(id);
    }
    let mut gone: Vec<&str> = old
        .keys()
        .map(String::as_str)
        .filter(|k| !seen.contains(k))
        .collect();
    gone.sort();
    out.extend(gone);
    out
}

fn diff_databases(cx: &mut Cx, old: &Value, new: &Value) -> Result<Vec<Value>, DiffError> {
    let (oa, ob) = (obj(old), obj(new));
    let mut out = Vec::new();
    for id in ordered_ids(&[], &oa, &ob) {
        cx.check()?;
        match (oa.get(id), ob.get(id)) {
            (None, Some(b)) => cx.push(
                &mut out,
                json!({"dbId": id, "op": "added", "name": b["name"]}),
                Kind::Added,
            ),
            (Some(a), None) => cx.push(
                &mut out,
                json!({"dbId": id, "op": "removed", "name": a["name"]}),
                Kind::Removed,
            ),
            (Some(a), Some(b)) => {
                if let Some(e) = diff_database(cx, id, a, b)? {
                    // The database entry itself is a container; its parts were counted.
                    out.push(e);
                }
            }
            (None, None) => {}
        }
    }
    Ok(out)
}

fn fields_by_id(v: &Value) -> (Vec<&str>, HashMap<&str, &Value>) {
    let mut order = Vec::new();
    let mut map = HashMap::new();
    for f in v.as_array().into_iter().flatten() {
        if let Some(id) = f["id"].as_str() {
            order.push(id);
            map.insert(id, f);
        }
    }
    (order, map)
}

fn diff_database(cx: &mut Cx, id: &str, a: &Value, b: &Value) -> Result<Option<Value>, DiffError> {
    let mut e = JsonMap::new();
    let mut any = false;

    let mut meta = Vec::new();
    for field in ["name", "icon", "tone"] {
        if a[field] != b[field] {
            cx.push(
                &mut meta,
                json!({"field": field, "old": a[field], "new": b[field]}),
                Kind::Changed,
            );
        }
    }

    // Fields.
    let (fa_order, fa) = fields_by_id(&a["fields"]);
    let (fb_order, fb) = fields_by_id(&b["fields"]);
    let mut fields = Vec::new();
    for fid in &fb_order {
        let (Some(x), Some(y)) = (fa.get(fid), fb.get(fid)) else {
            continue;
        };
        let mut changes = Vec::new();
        let mut f = json!({"op": "changed", "fieldId": fid, "name": y["name"]});
        if x["name"] != y["name"] {
            changes.push("renamed");
            f["old"] = x["name"].clone();
            f["new"] = y["name"].clone();
        }
        if x["type"] != y["type"] {
            changes.push("type");
            f["oldType"] = x["type"].clone();
            f["newType"] = y["type"].clone();
        }
        if x["options"] != y["options"] {
            changes.push("options");
        }
        if x["description"] != y["description"] {
            changes.push("description");
        }
        if !changes.is_empty() {
            f["changes"] = json!(changes);
            cx.push(&mut fields, f, Kind::Changed);
        }
    }
    for fid in fa_order.iter().filter(|f| !fb.contains_key(*f)) {
        cx.push(
            &mut fields,
            json!({"op": "removed", "fieldId": fid, "name": fa[fid]["name"]}),
            Kind::Removed,
        );
    }
    for fid in fb_order.iter().filter(|f| !fa.contains_key(*f)) {
        cx.push(
            &mut fields,
            json!({"op": "added", "fieldId": fid, "name": fb[fid]["name"]}),
            Kind::Added,
        );
    }

    // Rows and cells.
    let (ra, rb) = (obj(&a["rows"]), obj(&b["rows"]));
    let title_field = fb_order
        .iter()
        .chain(fa_order.iter())
        .find(|f| {
            fb.get(*f)
                .or(fa.get(*f))
                .is_some_and(|x| x["type"] == "title")
        })
        .copied();
    let title_of = |r: &Value| title_field.map_or(Value::Null, |t| r[t].clone());
    let (oa_order, ob_order) = (str_list(&a["order"]), str_list(&b["order"]));
    let mut rows = Vec::new();
    let mut new_rows = Vec::new();
    let mut cells = Vec::new();
    for rid in ordered_ids(&ob_order, &ra, &rb) {
        cx.check()?;
        match (ra.get(rid), rb.get(rid)) {
            (Some(x), None) => rows.push((
                json!({"op": "removed", "rowId": rid, "title": title_of(x)}),
                Kind::Removed,
            )),
            (None, Some(y)) => new_rows.push((
                json!({"op": "added", "rowId": rid, "title": title_of(y)}),
                Kind::Added,
            )),
            (Some(x), Some(y)) if x != y => {
                let (xo, yo) = (obj(x), obj(y));
                let keys: BTreeSet<&String> = xo.keys().chain(yo.keys()).collect();
                // Cells in field order, then any key that is not a field.
                let mut keys: Vec<&String> = keys.into_iter().collect();
                let pos = |k: &str| fb_order.iter().position(|f| *f == k).unwrap_or(usize::MAX);
                keys.sort_by_key(|k| pos(k));
                for k in keys {
                    let (ov, nv) = (
                        xo.get(k).unwrap_or(&Value::Null),
                        yo.get(k).unwrap_or(&Value::Null),
                    );
                    if ov != nv {
                        let name = fb
                            .get(k.as_str())
                            .or(fa.get(k.as_str()))
                            .map_or(Value::Null, |f| f["name"].clone());
                        cx.push(&mut cells, json!({"rowId": rid, "fieldId": k, "field": name, "old": ov, "new": nv}), Kind::Changed);
                    }
                }
            }
            _ => {}
        }
    }
    // Removed rows in their old order, then added rows (like fields and shapes).
    let pos = |r: &str| oa_order.iter().position(|o| *o == r).unwrap_or(usize::MAX);
    rows.sort_by_key(|(v, _)| {
        (
            pos(v["rowId"].as_str().unwrap_or("")),
            v["rowId"].as_str().unwrap_or("").to_string(),
        )
    });
    let mut row_entries = Vec::new();
    for (v, k) in rows.into_iter().chain(new_rows) {
        cx.push(&mut row_entries, v, k);
    }
    let rows = row_entries;

    // Row notes.
    let (na, nb) = (obj(&a["notes"]), obj(&b["notes"]));
    let mut notes = Vec::new();
    for rid in ordered_ids(&ob_order, &na, &nb) {
        let (x, y) = (
            na.get(rid).and_then(Value::as_str).unwrap_or(""),
            nb.get(rid).and_then(Value::as_str).unwrap_or(""),
        );
        if x != y {
            let t = text_diff(x, y, cx)?;
            cx.push(&mut notes, json!({"rowId": rid, "text": t}), Kind::Changed);
        }
    }

    // Order (of the rows in both) and view settings: one line each.
    let common: HashSet<&str> = ra
        .keys()
        .filter(|k| rb.contains_key(*k))
        .map(String::as_str)
        .collect();
    let fo: Vec<&str> = str_list(&a["order"])
        .into_iter()
        .filter(|r| common.contains(r))
        .collect();
    let fn_: Vec<&str> = ob_order
        .iter()
        .copied()
        .filter(|r| common.contains(r))
        .collect();
    let order = fo != fn_;
    let views = a["view"] != b["view"] || a["views"] != b["views"];

    for (k, v) in [
        ("meta", meta),
        ("fields", fields),
        ("rows", rows),
        ("cells", cells),
        ("notes", notes),
    ] {
        if !v.is_empty() {
            any = true;
            e.insert(k.into(), Value::Array(v));
        }
    }
    if order {
        any = true;
        e.insert("order".into(), json!(true));
        cx.sum.changed += 1;
    }
    if views {
        any = true;
        e.insert("views".into(), json!(true));
        cx.sum.changed += 1;
    }
    if !any {
        return Ok(None);
    }
    let mut head = JsonMap::new();
    head.insert("dbId".into(), json!(id));
    head.insert("op".into(), json!("changed"));
    head.insert("name".into(), b["name"].clone());
    head.extend(e);
    Ok(Some(Value::Object(head)))
}

// ---------- boards ----------

const STYLE_KEYS: &[&str] = &[
    "fill",
    "stroke",
    "kind",
    "kindVersion",
    "props",
    "size",
    "label",
    "dashed",
    "route",
    "src",
    "alt",
    "ports",
    "group",
    "type",
];

fn num(v: &Value, k: &str) -> f64 {
    v[k].as_f64().unwrap_or(0.0)
}

fn binding(v: &Value) -> Value {
    if v.is_object() {
        json!({"shapeId": v["shapeId"], "port": v["port"]})
    } else {
        Value::Null
    }
}

fn diff_boards(cx: &mut Cx, old: &Value, new: &Value) -> Result<Vec<Value>, DiffError> {
    let (oa, ob) = (obj(old), obj(new));
    let mut out = Vec::new();
    for id in ordered_ids(&[], &oa, &ob) {
        cx.check()?;
        let (a, b) = (oa.get(id), ob.get(id));
        let (sa, sb) = (
            a.map(|x| obj(&x["shapes"])).unwrap_or_default(),
            b.map(|x| obj(&x["shapes"])).unwrap_or_default(),
        );
        let mut e = json!({"boardId": id, "op": match (a, b) { (None, _) => "added", (_, None) => "removed", _ => "changed" }});
        let order_b = b.map(|x| str_list(&x["order"])).unwrap_or_default();
        let order_a = a.map(|x| str_list(&x["order"])).unwrap_or_default();
        let mut changed = Vec::new();
        let mut removed = Vec::new();
        let mut added = Vec::new();
        for sid in ordered_ids(&order_b, &sa, &sb) {
            cx.check()?;
            match (sa.get(sid), sb.get(sid)) {
                (Some(x), Some(y)) => {
                    if let Some((v, k)) = shape_changes(sid, x, y, cx)? {
                        changed.push((v, k));
                    }
                }
                (Some(x), None) => removed.push((sid, x)),
                (None, Some(y)) => {
                    added.push(json!({"op": "added", "shapeId": sid, "type": y["type"]}))
                }
                _ => {}
            }
        }
        // Removed shapes in their old paint order.
        let pos = |s: &str| order_a.iter().position(|o| *o == s).unwrap_or(usize::MAX);
        removed.sort_by_key(|(s, _)| (pos(s), s.to_string()));
        let mut shapes = Vec::new();
        for (v, k) in changed {
            cx.push(&mut shapes, v, k);
        }
        for (sid, x) in removed {
            cx.push(
                &mut shapes,
                json!({"op": "removed", "shapeId": sid, "type": x["type"], "shape": x}),
                Kind::Removed,
            );
        }
        for v in added {
            cx.push(&mut shapes, v, Kind::Added);
        }
        let common: HashSet<&str> = sa
            .keys()
            .filter(|k| sb.contains_key(*k))
            .map(String::as_str)
            .collect();
        let oa_c: Vec<&str> = order_a
            .iter()
            .copied()
            .filter(|s| common.contains(s))
            .collect();
        let ob_c: Vec<&str> = order_b
            .iter()
            .copied()
            .filter(|s| common.contains(s))
            .collect();
        let order = a.is_some() && b.is_some() && oa_c != ob_c;
        if shapes.is_empty() && !order && a.is_some() && b.is_some() {
            continue;
        }
        if a.is_none() {
            cx.sum.added += 1;
        } else if b.is_none() {
            cx.sum.removed += 1;
        }
        e["shapes"] = Value::Array(shapes);
        if order {
            e["order"] = json!(true);
            cx.sum.changed += 1;
        }
        out.push(e);
    }
    Ok(out)
}

fn shape_changes(
    sid: &str,
    x: &Value,
    y: &Value,
    cx: &Cx,
) -> Result<Option<(Value, Kind)>, DiffError> {
    if x == y {
        return Ok(None);
    }
    let mut changes = Vec::new();
    let mut e = json!({"op": "changed", "shapeId": sid, "type": y["type"]});
    let (bx, by) = (
        [num(x, "x"), num(x, "y"), num(x, "w"), num(x, "h")],
        [num(y, "x"), num(y, "y"), num(y, "w"), num(y, "h")],
    );
    let same_size = (bx[2] - by[2]).abs() < 0.5 && (bx[3] - by[3]).abs() < 0.5;
    if !same_size {
        changes.push("resized");
        e["from"] = json!(bx);
        e["to"] = json!(by);
    } else if (bx[0] - by[0]).abs() > MOVE_PX || (bx[1] - by[1]).abs() > MOVE_PX {
        changes.push("moved");
        e["from"] = json!([bx[0], bx[1]]);
        e["to"] = json!([by[0], by[1]]);
    }
    // Free paths (pen, unbound arrows): a changed path is a move when every point shifted alike.
    let bound = x["start"].is_object()
        && x["end"].is_object()
        && y["start"].is_object()
        && y["end"].is_object();
    if !bound
        && x["pts"] != y["pts"]
        && !changes.contains(&"resized")
        && !changes.contains(&"moved")
    {
        let pa: Vec<(f64, f64)> = x["pts"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| (p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0)))
            .collect();
        let pb: Vec<(f64, f64)> = y["pts"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| (p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0)))
            .collect();
        let shift = (pa.len() == pb.len() && !pa.is_empty())
            .then(|| (pb[0].0 - pa[0].0, pb[0].1 - pa[0].1));
        let uniform = shift.is_some_and(|(dx, dy)| {
            pa.iter()
                .zip(&pb)
                .all(|(p, q)| (q.0 - p.0 - dx).abs() < 0.5 && (q.1 - p.1 - dy).abs() < 0.5)
        });
        match shift {
            Some((dx, dy)) if uniform => {
                if dx.abs() > MOVE_PX || dy.abs() > MOVE_PX {
                    changes.push("moved");
                    e["from"] = json!([pa[0].0, pa[0].1]);
                    e["to"] = json!([pb[0].0, pb[0].1]);
                }
            }
            _ => changes.push("resized"),
        }
    }
    let (tx, ty) = (
        x["text"].as_str().unwrap_or(""),
        y["text"].as_str().unwrap_or(""),
    );
    if tx != ty {
        changes.push("text");
        e["text"] = text_diff(tx, ty, cx)?;
    }
    let style: Vec<&str> = STYLE_KEYS
        .iter()
        .copied()
        .filter(|k| x[*k] != y[*k])
        .collect();
    if !style.is_empty() {
        changes.push("style");
        e["style"] = json!(style);
    }
    let mut rebound = JsonMap::new();
    for end in ["start", "end"] {
        let (p, q) = (binding(&x[end]), binding(&y[end]));
        if p != q {
            rebound.insert(end.into(), json!({"old": p, "new": q}));
        }
    }
    if !rebound.is_empty() {
        changes.push("rebound");
        e["rebound"] = Value::Object(rebound);
    }
    if changes.is_empty() {
        return Ok(None);
    }
    let only_moved = changes == ["moved"];
    if only_moved {
        e["op"] = json!("moved");
    }
    e["changes"] = json!(changes);
    Ok(Some((
        e,
        if only_moved {
            Kind::Moved
        } else {
            Kind::Changed
        },
    )))
}

// ---------- cache ----------

struct Entry<V> {
    value: Arc<V>,
    weight: usize,
    at: Instant,
}

struct Inner<V> {
    map: HashMap<String, Entry<V>>,
    /// Least recently used first.
    lru: VecDeque<String>,
    bytes: usize,
}

/// In-memory LRU bounded by bytes, with a time to live (docs/30 §6.1: 64 MB per node, 5 min).
/// Nothing in it is ever written anywhere (AGENTS.md rule 5).
pub struct DiffCache<V> {
    cap: usize,
    ttl: Duration,
    inner: Mutex<Inner<V>>,
}

impl<V> DiffCache<V> {
    pub fn new(cap_bytes: usize, ttl: Duration) -> Self {
        Self {
            cap: cap_bytes,
            ttl,
            inner: Mutex::new(Inner {
                map: HashMap::new(),
                lru: VecDeque::new(),
                bytes: 0,
            }),
        }
    }

    pub fn get(&self, key: &str) -> Option<Arc<V>> {
        self.get_at(key, Instant::now())
    }

    pub fn insert(&self, key: String, value: V, weight: usize) -> Arc<V> {
        self.insert_at(key, value, weight, Instant::now())
    }

    pub fn get_at(&self, key: &str, now: Instant) -> Option<Arc<V>> {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = g
            .map
            .get(key)
            .map(|e| now.saturating_duration_since(e.at) <= self.ttl)?;
        if !fresh {
            Self::remove(&mut g, key);
            return None;
        }
        if let Some(p) = g.lru.iter().position(|k| k == key) {
            let k = g.lru.remove(p).expect("position is in range");
            g.lru.push_back(k);
        }
        g.map.get(key).map(|e| e.value.clone())
    }

    pub fn insert_at(&self, key: String, value: V, weight: usize, now: Instant) -> Arc<V> {
        let value = Arc::new(value);
        if weight > self.cap {
            return value;
        }
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        Self::remove(&mut g, &key);
        while g.bytes + weight > self.cap {
            let Some(k) = g.lru.front().cloned() else {
                break;
            };
            Self::remove(&mut g, &k);
        }
        g.bytes += weight;
        g.lru.push_back(key.clone());
        g.map.insert(
            key,
            Entry {
                value: value.clone(),
                weight,
                at: now,
            },
        );
        value
    }

    /// Drops every entry whose key starts with `prefix` (a room's entries when it closes).
    pub fn remove_prefix(&self, prefix: &str) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let keys: Vec<String> = g
            .map
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect();
        for k in keys {
            Self::remove(&mut g, &k);
        }
    }

    fn remove(g: &mut Inner<V>, key: &str) {
        if let Some(e) = g.map.remove(key) {
            g.bytes -= e.weight;
            if let Some(p) = g.lru.iter().position(|k| k == key) {
                g.lru.remove(p);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cx() -> Cx {
        Cx {
            deadline: Instant::now() + Duration::from_secs(60),
            zero: false,
            left: 10,
            truncated: false,
            sum: Summary::default(),
        }
    }

    #[test]
    fn myers_matches_a_simple_lcs() {
        let a: Vec<char> = "ABCABBA".chars().collect();
        let b: Vec<char> = "CBABAC".chars().collect();
        let ops = myers(&a, &b, &cx()).unwrap();
        let eq = ops.iter().filter(|o| matches!(o, Op::Eq(..))).count();
        assert_eq!(eq, 4); // LCS length of the classic example
        // Replaying the script turns a into b.
        let mut out = Vec::new();
        for o in ops {
            match o {
                Op::Eq(_, j) | Op::Ins(j) => out.push(b[j]),
                Op::Del(_) => {}
            }
        }
        assert_eq!(out, b);
    }

    #[test]
    fn tokens_split_words_spaces_and_punctuation() {
        assert_eq!(
            tokens("Hi, you're  here."),
            vec!["Hi", ",", " ", "you're", "  ", "here", "."]
        );
    }

    #[test]
    fn lis_finds_the_longest_run() {
        let s = [1, 2, 3, 0];
        let k = lis(&s);
        assert_eq!(k.len(), 3);
        assert!(!k.contains(&3));
    }
}
