// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Links and backlinks (LINK-02/03/05, ADR-081, docs/38 §2): `[host.flags] links`,
//! `[host.links]`, the index writes after acknowledged saves, and the read path shared by the
//! editor route (`GET /v1/backlinks`), the API (`GET /api/v1/files/{id}/backlinks`) and MCP
//! (`canvas_backlinks`), so all three answer the same for the same person.
//!
//! The index holds ids only. Every answer is filtered through the host's ACL at read time:
//! `POST /access/batch` when the host has it, else `POST /access` per file (8 at a time, both
//! cached 30 s). A source the reader cannot open is left out with no placeholder and no count.
//! Titles and paths come from the host's answers; excerpts are made from the source document
//! at read time and kept in memory for 5 minutes, never written anywhere.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use oc_model::links::{Kind, UrlPatterns};
use serde_json::{Value, json};

use crate::SharedState;
use crate::grant::{FileRef, Grant, Perms, Role, User, room_id};
use crate::host_client::{AccessDetail, Fetched};
use crate::hosts::HostConfig;
use crate::store::LinkRow;

/// Sources per page of "Linked from" (and how many get excerpts at once).
pub const PAGE: usize = 20;
/// Longest excerpt, in characters.
pub const EXCERPT_MAX: usize = 240;
/// How long an excerpt is kept in memory.
pub const EXCERPT_TTL: Duration = Duration::from_secs(300);
/// Most distinct sources checked for one answer (the rest are not shown).
pub const MAX_SOURCES: usize = 2000;
/// Per-file `/access` calls in flight when the host has no batch callback.
pub const FALLBACK_CONCURRENCY: usize = 8;
/// How long a host whose `/access/batch` answered "not implemented" is asked per file instead.
pub const PROBE_TTL: Duration = Duration::from_secs(600);

/// `[host.flags] links` and `[host.links]`, checked.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LinksCfg {
    pub on: bool,
    /// `url_patterns`: host URLs that are canvas links (pasted, or `link` marks).
    pub patterns: UrlPatterns,
    /// `url_template`: the host URL of a canvas, `{fileId}` and optional `{blockId}`.
    pub template: Option<String>,
}

impl LinksCfg {
    pub fn parse(flags: &toml::Table, t: &toml::Table) -> anyhow::Result<Self> {
        let on = match flags.get("links") {
            None => false,
            Some(v) => v
                .as_bool()
                .ok_or_else(|| anyhow::anyhow!("[host.flags] links takes true or false"))?,
        };
        let mut c = Self {
            on,
            ..Default::default()
        };
        for (k, v) in t {
            match k.as_str() {
                "url_patterns" => {
                    let list = v
                        .as_array()
                        .ok_or_else(|| anyhow::anyhow!("[host.links] url_patterns takes a list"))?;
                    let mut pats = vec![];
                    for p in list {
                        pats.push(
                            p.as_str()
                                .ok_or_else(|| {
                                    anyhow::anyhow!("[host.links] url_patterns takes strings")
                                })?
                                .to_string(),
                        );
                    }
                    if pats.len() > 8 {
                        anyhow::bail!("[host.links] url_patterns takes at most 8 patterns");
                    }
                    c.patterns = UrlPatterns::parse(&pats)
                        .map_err(|e| anyhow::anyhow!("[host.links] {e}"))?;
                }
                "url_template" => {
                    let s = v.as_str().ok_or_else(|| {
                        anyhow::anyhow!("[host.links] url_template takes a string")
                    })?;
                    UrlPatterns::parse(&[s.to_string()])
                        .map_err(|e| anyhow::anyhow!("[host.links] url_template: {e}"))?;
                    c.template = Some(s.to_string());
                }
                other => anyhow::bail!("[host.links] has no setting {other:?}"),
            }
        }
        Ok(c)
    }

    pub fn of(host: &HostConfig) -> Self {
        Self::parse(&host.flags, &host.links).unwrap_or_default()
    }
}

/// Start-up check (hosts file): `[host.links]` parses, and a host that turns links on is a
/// JWT host with callbacks (the read path needs `POST /access`), not WOPI-only or ephemeral.
pub fn check_host(h: &HostConfig) -> anyhow::Result<()> {
    let c =
        LinksCfg::parse(&h.flags, &h.links).map_err(|e| anyhow::anyhow!("host {}: {e}", h.id))?;
    if c.on && (h.mode == "wopi" || h.ephemeral()) {
        anyhow::bail!(
            "host {}: [host.flags] links needs a JWT host that stores its files (the read path checks POST /access)",
            h.id
        );
    }
    Ok(())
}

/// Who reads: the person, their callback bearer, and (API tokens) the files the token covers.
#[derive(Debug, Clone, Copy)]
pub struct Reader<'a> {
    pub user_id: &'a str,
    pub token: &'a str,
    pub files: Option<&'a [String]>,
}

/// Why a read could not be answered.
#[derive(Debug, PartialEq)]
pub enum LinkError {
    /// `[host.flags] links` is off, or the storage has no index.
    Off,
    /// The reader cannot open the target.
    Forbidden,
    /// The target was deleted at the host.
    Gone,
    BadInput(&'static str),
    RateLimited(u64),
    Host(String),
    Internal(String),
}

/// (host, reader, source file, the source's save time in the index).
type ExcerptKey = (String, String, String, i64);

/// Memory-only caches of the read path.
#[derive(Default)]
pub struct Caches {
    /// Excerpts per (host, reader, source, saved at): the source's blocks that link here.
    excerpts: Mutex<HashMap<ExcerptKey, (Instant, Arc<SourceText>)>>,
    /// Hosts whose `/access/batch` is not implemented, until when.
    no_batch: Mutex<HashMap<String, Instant>>,
}

/// What a source document says around its links: per source block, the block's text with the
/// link spans, and the heading it sits under. Memory only.
#[derive(Debug, Default)]
pub struct SourceText {
    blocks: HashMap<String, BlockText>,
}

#[derive(Debug, Default, Clone)]
struct BlockText {
    /// Plain text pieces: `(text, link target file)`.
    parts: Vec<(String, Option<String>)>,
    section: String,
}

/// The access answers of the readable files among `files` (role at least view, not revoked by
/// the role API, covered by the token). Files the host refuses, cannot find or did not answer
/// for are absent; those it reports deleted are in the second set.
pub async fn readable(
    state: &SharedState,
    host: &HostConfig,
    reader: Reader<'_>,
    files: &[String],
) -> (HashMap<String, AccessDetail>, HashSet<String>) {
    let mut out = HashMap::new();
    let mut gone = HashSet::new();
    let files: Vec<String> = files
        .iter()
        .filter(|f| reader.files.is_none_or(|l| l.iter().any(|x| x == *f)))
        .filter(|f| {
            !state
                .members
                .without_revoked(
                    &room_id(&host.id, f),
                    vec![User {
                        id: reader.user_id.to_string(),
                        ..Default::default()
                    }],
                )
                .is_empty()
        })
        .cloned()
        .collect();
    if files.is_empty() {
        return (out, gone);
    }
    let batch_ok = state
        .links
        .no_batch
        .lock()
        .map(|m| m.get(&host.id).is_none_or(|t| Instant::now() >= *t))
        .unwrap_or(true);
    let answers: Vec<(String, Option<AccessDetail>)> = if batch_ok {
        match state.host.access_batch(host, reader.user_id, &files).await {
            Ok(Some(m)) => m.into_iter().collect(),
            Ok(None) => {
                if let Ok(mut m) = state.links.no_batch.lock() {
                    m.insert(host.id.clone(), Instant::now() + PROBE_TTL);
                }
                per_file(state, host, reader.user_id, &files).await
            }
            // A failing batch is not "everything readable": nothing is shown.
            Err(e) => {
                tracing::warn!(host = %host.id, error = %e, "access batch failed; no backlinks shown");
                vec![]
            }
        }
    } else {
        per_file(state, host, reader.user_id, &files).await
    };
    for (f, a) in answers {
        match a {
            Some(d) if d.role.is_some() => {
                out.insert(f, d);
            }
            Some(d) if d.gone => {
                gone.insert(f);
            }
            _ => {}
        }
    }
    (out, gone)
}

async fn per_file(
    state: &SharedState,
    host: &HostConfig,
    user_id: &str,
    files: &[String],
) -> Vec<(String, Option<AccessDetail>)> {
    let mut out = Vec::with_capacity(files.len());
    for chunk in files.chunks(FALLBACK_CONCURRENCY) {
        // `None` (no `/access` at all) and errors both mean "not readable" (fail closed).
        let got = futures::future::join_all(
            chunk
                .iter()
                .map(|f| state.host.access_detail(host, f, user_id)),
        )
        .await;
        for (f, a) in chunk.iter().zip(got) {
            out.push((f.clone(), a.ok().flatten()));
        }
    }
    out
}

/// A read-only grant for loading a source the reader can open (excerpts).
fn view_grant(host: &HostConfig, user_id: &str, file_id: &str, token: &str) -> Grant {
    Grant {
        ext_blocks: false,
        subdoc: false,
        live: Default::default(),
        wopi_history: None,
        host_id: host.id.clone(),
        room: room_id(&host.id, file_id),
        role: Role::View,
        user: User {
            id: user_id.to_string(),
            ..Default::default()
        },
        file: FileRef {
            id: file_id.to_string(),
            name: file_id.to_string(),
            version: None,
        },
        perms: Perms::default(),
        callback_token: token.to_string(),
        members: vec![],
    }
}

/// The source's `document.json`: from its room when the room is open on this node, else
/// loaded through the host with the reader's bearer and dropped after use.
pub(crate) async fn source_doc(
    state: &SharedState,
    host: &Arc<HostConfig>,
    reader: Reader<'_>,
    file_id: &str,
    access: &AccessDetail,
) -> Option<Value> {
    let token = access.callback_token.as_deref().unwrap_or(reader.token);
    let room = room_id(&host.id, file_id);
    if state.rooms.is_live(&room) {
        let g = view_grant(host, reader.user_id, file_id, token);
        let bytes = state.rooms.state(host, &g).await.ok()?;
        return tokio::task::spawn_blocking(move || {
            let doc = oc_model::new_doc();
            oc_model::ocanvas::apply_update_bytes(&doc, &bytes).ok()?;
            Some(oc_model::doc_to_json(&doc))
        })
        .await
        .ok()
        .flatten();
    }
    let Fetched::Found { bytes, .. } = state.host.get_file(host, token, file_id).await.ok()? else {
        return None;
    };
    tokio::task::spawn_blocking(move || {
        if !oc_model::ocanvas::is_zip(&bytes) {
            return None;
        }
        let loaded = oc_model::ocanvas::read_ocanvas(&bytes).ok()?;
        Some(oc_model::doc_to_json(&loaded.doc))
    })
    .await
    .ok()
    .flatten()
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}

fn inline_text(n: &Value, patterns: &UrlPatterns, parts: &mut Vec<(String, Option<String>)>) {
    match s(n, "type") {
        "text" => {
            let target = n["marks"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|m| s(m, "type") == "link")
                .and_then(|m| patterns.parse_url(s(&m["attrs"], "href")))
                .map(|t| t.file_id);
            parts.push((s(n, "text").to_string(), target));
        }
        oc_model::links::CANVAS_LINK => parts.push((
            s(&n["attrs"], "label").to_string(),
            Some(s(&n["attrs"], "fileId").to_string()),
        )),
        "mention" => parts.push((format!("@{}", s(&n["attrs"], "label")), None)),
        "hardBreak" => parts.push((" ".into(), None)),
        _ => {
            for c in n["content"].as_array().into_iter().flatten() {
                inline_text(c, patterns, parts);
            }
        }
    }
}

/// Indexes the source's text by block id: every block that has an id, with its inline text
/// and the last heading before it. The text never leaves memory.
pub(crate) fn source_text(doc: &Value, patterns: &UrlPatterns) -> SourceText {
    fn walk(
        nodes: &[Value],
        patterns: &UrlPatterns,
        section: &mut String,
        out: &mut SourceText,
        depth: usize,
    ) {
        if depth > 64 {
            return;
        }
        for n in nodes {
            let ty = s(n, "type");
            let id = s(&n["attrs"], "blockId");
            let mut parts = vec![];
            if ty == "heading" || ty == "paragraph" {
                for c in n["content"].as_array().into_iter().flatten() {
                    inline_text(c, patterns, &mut parts);
                }
            }
            if !id.is_empty() {
                let entry = out.blocks.entry(id.to_string()).or_default();
                entry.section = section.clone();
                if !parts.is_empty() {
                    entry.parts = parts.clone();
                }
            }
            if ty == "heading" {
                *section = parts.iter().map(|(t, _)| t.as_str()).collect();
            }
            if ty != "heading"
                && ty != "paragraph"
                && let Some(c) = n["content"].as_array()
            {
                let before = out.blocks.len();
                walk(c, patterns, section, out, depth + 1);
                // A container with an id (list item, callout) shows its first paragraph.
                if !id.is_empty()
                    && out.blocks.len() >= before
                    && let Some(first) = first_parts(c, patterns)
                    && let Some(e) = out.blocks.get_mut(id)
                    && e.parts.is_empty()
                {
                    e.parts = first;
                }
            }
        }
    }
    fn first_parts(
        nodes: &[Value],
        patterns: &UrlPatterns,
    ) -> Option<Vec<(String, Option<String>)>> {
        for n in nodes {
            if matches!(s(n, "type"), "paragraph" | "heading") {
                let mut parts = vec![];
                for c in n["content"].as_array().into_iter().flatten() {
                    inline_text(c, patterns, &mut parts);
                }
                return Some(parts);
            }
            if let Some(c) = n["content"].as_array()
                && let Some(p) = first_parts(c, patterns)
            {
                return Some(p);
            }
        }
        None
    }
    let mut out = SourceText::default();
    let mut section = String::new();
    if let Some(c) = doc["content"].as_array() {
        walk(c, patterns, &mut section, &mut out, 0);
        // Links outside any block with an id: the first paragraph holding one, under "".
        let mut parts = vec![];
        if let Some(p) = first_linking(c, patterns) {
            parts = p;
        }
        out.blocks.insert(
            String::new(),
            BlockText {
                parts,
                section: String::new(),
            },
        );
    }
    fn first_linking(
        nodes: &[Value],
        patterns: &UrlPatterns,
    ) -> Option<Vec<(String, Option<String>)>> {
        for n in nodes {
            if matches!(s(n, "type"), "paragraph" | "heading")
                && s(&n["attrs"], "blockId").is_empty()
            {
                let mut parts = vec![];
                for c in n["content"].as_array().into_iter().flatten() {
                    inline_text(c, patterns, &mut parts);
                }
                if parts.iter().any(|(_, t)| t.is_some()) {
                    return Some(parts);
                }
            }
            if let Some(c) = n["content"].as_array()
                && let Some(p) = first_linking(c, patterns)
            {
                return Some(p);
            }
        }
        None
    }
    out
}

impl SourceText {
    /// The plain text of a block (its heading or first paragraph), at most `max` characters.
    pub fn block_text(&self, block: &str, max: usize) -> Option<String> {
        let b = self.blocks.get(block)?;
        let t: String = b.parts.iter().map(|(t, _)| t.as_str()).collect();
        let t = t.trim();
        (!t.is_empty()).then(|| t.chars().take(max).collect())
    }
}

/// Bumped at every index write: cached graph answers older than it are not reused.
pub static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The sentence-sized excerpt of `block` around its first link to `target`: `{before, link,
/// after}` with `link` replaced by `title` (the host's current title), at most
/// [`EXCERPT_MAX`] characters in all. `None` when the block has no text.
fn excerpt(src: &SourceText, block: &str, target: &str, title: &str) -> Option<(Value, String)> {
    let b = src.blocks.get(block)?;
    if b.parts.is_empty() {
        return None;
    }
    let at = b
        .parts
        .iter()
        .position(|(_, t)| t.as_deref() == Some(target));
    let (mut before, link, mut after) = match at {
        Some(i) => (
            b.parts[..i]
                .iter()
                .map(|(t, _)| t.as_str())
                .collect::<String>(),
            title.to_string(),
            b.parts[i + 1..]
                .iter()
                .map(|(t, _)| t.as_str())
                .collect::<String>(),
        ),
        None => (
            b.parts.iter().map(|(t, _)| t.as_str()).collect::<String>(),
            String::new(),
            String::new(),
        ),
    };
    let budget = EXCERPT_MAX.saturating_sub(link.chars().count());
    let half = budget / 2;
    let (nb, na) = (before.chars().count(), after.chars().count());
    let (keep_b, keep_a) = if nb + na <= budget {
        (nb, na)
    } else if nb <= half {
        (nb, budget - nb)
    } else if na <= half {
        (budget - na, na)
    } else {
        (half, budget - half)
    };
    if keep_b < nb {
        before = format!("…{}", before.chars().skip(nb - keep_b).collect::<String>());
    }
    if keep_a < na {
        after = format!("{}…", after.chars().take(keep_a).collect::<String>());
    }
    Some((
        json!({"before": before, "link": link, "after": after}),
        b.section.clone(),
    ))
}

/// What to read.
#[derive(Debug, Default, Clone)]
pub struct Query {
    /// Only links to this block of the target.
    pub block: Option<String>,
    pub kind: Option<Kind>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    /// Make excerpts (the editor and MCP do; a count-only call can skip them).
    pub excerpts: bool,
}

fn cursor_offset(c: Option<&str>) -> Result<usize, LinkError> {
    match c {
        None | Some("") => Ok(0),
        Some(c) => c
            .strip_prefix("o")
            .and_then(|n| n.parse().ok())
            .filter(|n| *n <= MAX_SOURCES)
            .ok_or(LinkError::BadInput("cursor is not one this server gave")),
    }
}

/// The checks every read starts with: the feature, the storage, and the rate limit.
pub async fn admit(state: &SharedState, host: &HostConfig, user: &str) -> Result<(), LinkError> {
    if !LinksCfg::of(host).on || !state.store.links_supported() {
        return Err(LinkError::Off);
    }
    let d = state
        .limiter
        .check(
            &format!("links:{}:{user}", host.id),
            crate::ratelimit::Policy {
                name: "links",
                rate: 1.0,
                burst: 60.0,
            },
        )
        .await;
    if d.ok {
        Ok(())
    } else {
        Err(LinkError::RateLimited(d.retry_after))
    }
}

/// The reader's access to the target: at least view, else no answer at all (docs/38 §2.4
/// item 5). Editor sessions pass their grant's role instead.
pub async fn target_access(
    state: &SharedState,
    host: &HostConfig,
    reader: Reader<'_>,
    file_id: &str,
) -> Result<AccessDetail, LinkError> {
    if file_id.is_empty() || file_id.len() > oc_model::links::MAX_ID {
        return Err(LinkError::BadInput("fileId must be 1-1024 bytes"));
    }
    let (mut ok, gone) = readable(state, host, reader, &[file_id.to_string()]).await;
    if gone.contains(file_id) {
        return Err(LinkError::Gone);
    }
    ok.remove(file_id).ok_or(LinkError::Forbidden)
}

/// "Linked from" for `file_id` as `reader` sees it (docs/38 §2.4): the readable sources,
/// newest save first, a page at a time, each with its references and (first page of 20)
/// excerpts; `total` and `blocks` (readable source canvases per target block) count only what
/// the reader can open. `title`: the target's current title (from the host or the session),
/// written into the excerpts in place of the saved label.
pub async fn backlinks(
    state: &SharedState,
    host: &Arc<HostConfig>,
    reader: Reader<'_>,
    file_id: &str,
    title: &str,
    q: Query,
) -> Result<Value, LinkError> {
    let offset = cursor_offset(q.cursor.as_deref())?;
    let limit = q.limit.unwrap_or(PAGE).clamp(1, 50);
    let rows = state
        .store
        .links_to(&host.id, file_id)
        .await
        .map_err(|e| LinkError::Internal(e.to_string()))?;
    // Grouped by source, newest save first; a canvas's links to itself are not backlinks.
    let mut order: Vec<String> = vec![];
    let mut by_src: HashMap<String, Vec<LinkRow>> = HashMap::new();
    for r in rows {
        if r.src_file == file_id {
            continue;
        }
        if !by_src.contains_key(&r.src_file) {
            if order.len() >= MAX_SOURCES {
                continue;
            }
            order.push(r.src_file.clone());
        }
        by_src.entry(r.src_file.clone()).or_default().push(r);
    }
    // Every source is checked, whatever the filter, so the counts are of readable ones only.
    let (access, gone) = readable(state, host, reader, &order).await;
    if !gone.is_empty() {
        let (store, host_id) = (state.store.clone(), host.id.clone());
        let gone: Vec<String> = gone.into_iter().collect();
        tokio::spawn(async move {
            for f in gone {
                if let Err(e) = store.links_delete_src(&host_id, &f).await {
                    tracing::warn!(error = %e, "dropping a deleted source's links failed");
                }
            }
        });
    }
    let order: Vec<String> = order
        .into_iter()
        .filter(|f| access.contains_key(f))
        .collect();
    let mut blocks: BTreeMap<String, usize> = BTreeMap::new();
    for f in &order {
        let mut seen = HashSet::new();
        for r in &by_src[f] {
            if !r.dst_block.is_empty() && seen.insert(r.dst_block.clone()) {
                *blocks.entry(r.dst_block.clone()).or_default() += 1;
            }
        }
    }
    let matches = |r: &LinkRow| {
        q.block.as_deref().is_none_or(|b| r.dst_block == b) && q.kind.is_none_or(|k| r.kind == k)
    };
    let listed: Vec<&String> = order
        .iter()
        .filter(|f| by_src[*f].iter().any(&matches))
        .collect();
    let total = listed.len();
    let page: Vec<&String> = listed.iter().skip(offset).take(limit).copied().collect();
    let cfg = LinksCfg::of(host);
    let mut texts: Vec<Option<Arc<SourceText>>> = Vec::with_capacity(page.len());
    for chunk in page.chunks(FALLBACK_CONCURRENCY) {
        if !q.excerpts {
            texts.extend(chunk.iter().map(|_| None));
            continue;
        }
        let got = futures::future::join_all(chunk.iter().map(|f| {
            let saved = by_src[*f].first().map_or(0, |r| r.saved_at);
            excerpt_source(state, host, reader, f, &access[*f], saved, &cfg.patterns)
        }))
        .await;
        texts.extend(got);
    }
    let mut items = vec![];
    for (f, text) in page.iter().zip(texts) {
        let a = &access[*f];
        let rows: Vec<&LinkRow> = by_src[*f].iter().filter(|r| matches(r)).collect();
        let mut refs = vec![];
        let mut seen = HashSet::new();
        for r in &rows {
            if !seen.insert((&r.src_block, &r.dst_block, &r.dst_row, r.kind)) {
                continue;
            }
            let (ex, section) = text
                .as_deref()
                .and_then(|t| excerpt(t, &r.src_block, file_id, title))
                .map_or((Value::Null, Value::Null), |(e, s)| {
                    (e, if s.is_empty() { Value::Null } else { json!(s) })
                });
            refs.push(json!({
                "block": r.src_block,
                "toBlock": if r.dst_block.is_empty() { Value::Null } else { json!(r.dst_block) },
                "toRow": if r.dst_row.is_empty() { Value::Null } else { json!(r.dst_row) },
                "kind": r.kind.as_str(),
                "section": section,
                "excerpt": ex,
            }));
        }
        items.push(json!({
            "fileId": f,
            "title": a.name.clone().unwrap_or_else(|| (*f).clone()),
            "path": a.path,
            "updatedAt": a.updated_at,
            "updatedBy": a.updated_by,
            "savedAt": rows.first().map(|r| r.saved_at),
            "role": a.role.map(|r| r.as_str()),
            "refs": refs,
        }));
    }
    let next = (offset + page.len() < total).then(|| format!("o{}", offset + page.len()));
    Ok(json!({
        "fileId": file_id,
        "items": items,
        "total": total,
        "blocks": blocks,
        "next": next,
    }))
}

async fn excerpt_source(
    state: &SharedState,
    host: &Arc<HostConfig>,
    reader: Reader<'_>,
    file_id: &str,
    access: &AccessDetail,
    saved_at: i64,
    patterns: &UrlPatterns,
) -> Option<Arc<SourceText>> {
    let key = (
        host.id.clone(),
        reader.user_id.to_string(),
        file_id.to_string(),
        saved_at,
    );
    if let Some(t) = state.links.excerpts.lock().ok().and_then(|m| {
        m.get(&key)
            .filter(|(at, _)| at.elapsed() < EXCERPT_TTL)
            .map(|(_, t)| t.clone())
    }) {
        return Some(t);
    }
    let doc = source_doc(state, host, reader, file_id, access).await?;
    let text = Arc::new(source_text(&doc, patterns));
    drop(doc);
    if let Ok(mut m) = state.links.excerpts.lock() {
        if m.len() > 10_000 {
            m.retain(|_, (at, _)| at.elapsed() < EXCERPT_TTL);
        }
        m.insert(key, (Instant::now(), text.clone()));
    }
    Some(text)
}

/// Writes a saved file's outgoing edges (LINK-02): called once the host acknowledged the save.
pub async fn index_saved(
    state_store: &crate::store::Store,
    metrics: &crate::metrics::Metrics,
    host_id: &str,
    file_id: &str,
    extracted: &oc_model::links::Extracted,
    saved_at: i64,
) {
    let started = Instant::now();
    let r = state_store
        .links_replace(host_id, file_id, &extracted.edges, saved_at)
        .await;
    metrics.link_index(r.is_ok(), extracted.dropped, started.elapsed());
    if let Err(e) = r {
        tracing::warn!(error = %e, "writing the link index failed; it catches up at the next save");
    }
}

/// Unlinked mentions (docs/38 §2.5): canvases the host's search finds for the target's exact
/// title (and aliases) that do not link here yet. Hidden when the host has no search.
pub async fn mentions(
    state: &SharedState,
    host: &Arc<HostConfig>,
    reader: Reader<'_>,
    file_id: &str,
    names: &[String],
) -> Result<Value, LinkError> {
    if !state.search_probe.available(host) {
        return Ok(json!({"available": false, "items": []}));
    }
    let linked: HashSet<String> = state
        .store
        .links_to(&host.id, file_id)
        .await
        .map_err(|e| LinkError::Internal(e.to_string()))?
        .into_iter()
        .map(|r| r.src_file)
        .collect();
    let mut items = vec![];
    let mut seen = HashSet::new();
    for name in names.iter().filter(|n| n.chars().count() >= 3).take(4) {
        let phrase = format!("\"{}\"", name.replace('"', ""));
        if phrase.len() > crate::search::MAX_Q {
            continue;
        }
        let r = crate::search::run(
            state,
            host,
            crate::search::Searcher {
                user_id: reader.user_id,
                token: reader.token,
            },
            crate::search::Query {
                q: phrase,
                scope: None,
                cursor: None,
                limit: 20,
            },
        )
        .await;
        let v = match r {
            Ok(v) => v,
            Err(crate::search::SearchError::Unavailable) => {
                return Ok(json!({"available": false, "items": []}));
            }
            Err(crate::search::SearchError::RateLimited(s)) => {
                return Err(LinkError::RateLimited(s));
            }
            Err(e) => return Err(LinkError::Host(format!("{e:?}"))),
        };
        for it in v["items"].as_array().into_iter().flatten() {
            let f = s(it, "fileId");
            if f.is_empty() || f == file_id || linked.contains(f) || !seen.insert(f.to_string()) {
                continue;
            }
            if reader.files.is_some_and(|l| !l.iter().any(|x| x == f)) {
                continue;
            }
            items.push(json!({
                "fileId": f,
                "title": it["title"],
                "path": it["path"],
                "blockId": it["blockId"],
                "snippet": it["snippet"],
                "updatedAt": it["updatedAt"],
                "name": name,
            }));
        }
    }
    Ok(json!({"available": true, "items": items}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_parses_and_refuses() {
        let flags = toml::toml! { links = true };
        let t = toml::toml! {
            url_patterns = ["https://docs.acme.test/f/{fileId}"]
            url_template = "https://docs.acme.test/f/{fileId}#{blockId}"
        };
        let c = LinksCfg::parse(&flags, &t).unwrap();
        assert!(c.on);
        assert!(!c.patterns.is_empty());
        assert!(LinksCfg::parse(&toml::toml! { links = "yes" }, &toml::Table::new()).is_err());
        assert!(LinksCfg::parse(&flags, &toml::toml! { url_template = "https://x/" }).is_err());
        assert!(LinksCfg::parse(&flags, &toml::toml! { other = 1 }).is_err());
    }

    #[test]
    fn excerpts_follow_the_link_and_stay_short() {
        let doc = json!({"content": [
            {"type": "heading", "attrs": {"blockId": "h"}, "content": [{"type": "text", "text": "Identity"}]},
            {"type": "paragraph", "attrs": {"blockId": "p"}, "content": [
                {"type": "text", "text": "Scope and dates live in "},
                {"type": "canvasLink", "attrs": {"fileId": "t", "label": "old label"}},
                {"type": "text", "text": "."},
            ]},
            {"type": "paragraph", "attrs": {"blockId": "long"}, "content": [
                {"type": "text", "text": "a".repeat(400)},
                {"type": "canvasLink", "attrs": {"fileId": "t", "label": "x"}},
                {"type": "text", "text": "b".repeat(400)},
            ]},
        ]});
        let t = source_text(&doc, &UrlPatterns::default());
        let (e, section) = excerpt(&t, "p", "t", "SSO rollout plan").unwrap();
        assert_eq!(
            e,
            json!({"before": "Scope and dates live in ", "link": "SSO rollout plan", "after": "."})
        );
        assert_eq!(section, "Identity");
        let (e, _) = excerpt(&t, "long", "t", "T").unwrap();
        let n = |k: &str| e[k].as_str().unwrap().chars().count();
        assert!(n("before") + n("link") + n("after") <= EXCERPT_MAX + 2);
        assert!(e["before"].as_str().unwrap().starts_with('…'));
    }

    #[test]
    fn cursors_are_offsets_this_server_gave() {
        assert_eq!(cursor_offset(None), Ok(0));
        assert_eq!(cursor_offset(Some("o20")), Ok(20));
        assert!(cursor_offset(Some("20")).is_err());
        assert!(cursor_offset(Some("o99999999")).is_err());
    }
}
