// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The graph API (GRAPH-01, ADR-082, docs/38 §3.1), shared by `GET /api/v1/graph`, the editor
//! route `GET /v1/graph` and MCP `canvas_graph`.
//!
//! - **Local graph:** breadth-first over `link_edges` from `root`, both directions, to `depth`
//!   (1-3) or `limit` nodes. Every candidate is checked with the host **before** it becomes a
//!   node or is expanded, so a canvas the reader cannot open is neither shown nor used as a
//!   bridge: two readable canvases linked only through a hidden one are not connected.
//! - **Full graph:** the most-connected canvases of the host that the reader can open, checked
//!   in batches until `limit` (≤ 2,000) or 10,000 candidates; `truncated` when it stopped early.
//!   `total` only when every candidate was checked.
//! - Titles, paths, spaces and dates come from the host's access answers; block node titles are
//!   read from readable canvases at request time. Answers are cached 30 s per reader and
//!   parameters, and dropped when the index changes.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use oc_model::links::Kind;
use serde_json::{Value, json};

use crate::SharedState;
use crate::host_client::AccessDetail;
use crate::hosts::HostConfig;
use crate::links::{LinkError, Reader};
use crate::store::LinkRow;

/// Most nodes of a local graph, and its default.
pub const LOCAL_MAX: usize = 500;
pub const LOCAL_DEFAULT: usize = 200;
/// Most nodes of the full graph (also its default).
pub const FULL_MAX: usize = 2000;
/// Most candidates the full graph checks with the host.
pub const FULL_CANDIDATES: usize = 10_000;
/// Index rows the full graph reads.
pub const FULL_ROWS: i64 = 200_000;
/// Candidates per access batch.
pub const BATCH: usize = crate::host_client::ACCESS_BATCH;
/// How long an answer is reused for the same reader and parameters.
pub const CACHE_TTL: Duration = Duration::from_secs(30);

/// What to draw.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Params {
    pub root: Option<String>,
    pub depth: u8,
    pub kinds: Vec<Kind>,
    pub blocks: bool,
    pub limit: usize,
}

impl Params {
    /// Checks and fills the query (`kinds` comma-separated; defaults as docs/38 §3.1).
    pub fn parse(
        root: Option<String>,
        depth: Option<u8>,
        kinds: Option<&str>,
        blocks: Option<bool>,
        limit: Option<usize>,
    ) -> Result<Self, LinkError> {
        let root = root.filter(|r| !r.is_empty());
        if root
            .as_ref()
            .is_some_and(|r| r.len() > oc_model::links::MAX_ID)
        {
            return Err(LinkError::BadInput("root must be 1-1024 bytes"));
        }
        let depth = depth.unwrap_or(1);
        if !(1..=3).contains(&depth) {
            return Err(LinkError::BadInput("depth is 1, 2 or 3"));
        }
        let mut ks = vec![];
        match kinds.filter(|k| !k.is_empty()) {
            None => ks = vec![Kind::Link, Kind::Embed, Kind::Relation],
            Some(k) => {
                for part in k.split(',') {
                    let kind = Kind::parse(part.trim())
                        .ok_or(LinkError::BadInput("kinds takes link, embed, relation"))?;
                    if !ks.contains(&kind) {
                        ks.push(kind);
                    }
                }
            }
        }
        ks.sort();
        let (max, default) = if root.is_some() {
            (LOCAL_MAX, LOCAL_DEFAULT)
        } else {
            (FULL_MAX, FULL_MAX)
        };
        let limit = limit.unwrap_or(default);
        if limit == 0 || limit > max {
            return Err(LinkError::BadInput(if root.is_some() {
                "limit is 1-500 for a local graph"
            } else {
                "limit is 1-2000 for the full graph"
            }));
        }
        Ok(Self {
            root,
            depth,
            kinds: ks,
            blocks: blocks.unwrap_or(false),
            limit,
        })
    }
}

type CacheKey = (String, String, Params);

/// Memory-only answers, per (host, reader, parameters).
#[derive(Default)]
pub struct Cache(Mutex<HashMap<CacheKey, (Instant, u64, Value)>>);

/// The per-person limits: 10 graphs a minute, of which 2 full.
async fn admit(
    state: &SharedState,
    host: &HostConfig,
    user: &str,
    full: bool,
) -> Result<(), LinkError> {
    if !crate::links::LinksCfg::of(host).on || !state.store.links_supported() {
        return Err(LinkError::Off);
    }
    let mut checks = vec![(
        format!("graph:{}:{user}", host.id),
        crate::ratelimit::Policy {
            name: "graph",
            rate: 10.0 / 60.0,
            burst: 10.0,
        },
    )];
    if full {
        checks.push((
            format!("graph-full:{}:{user}", host.id),
            crate::ratelimit::Policy {
                name: "graph-full",
                rate: 2.0 / 60.0,
                burst: 2.0,
            },
        ));
    }
    for (key, policy) in checks {
        let d = state.limiter.check(&key, policy).await;
        if !d.ok {
            return Err(LinkError::RateLimited(d.retry_after));
        }
    }
    Ok(())
}

fn space_of(a: &AccessDetail) -> Option<String> {
    a.space.clone().or_else(|| {
        a.path.as_deref().and_then(|p| {
            p.split(['/', '›'])
                .map(str::trim)
                .find(|s| !s.is_empty())
                .map(String::from)
        })
    })
}

struct Builder<'a> {
    kinds: &'a [Kind],
    nodes: Vec<String>,
    access: HashMap<String, AccessDetail>,
    /// Edges between readable canvases: (from file, to file, kind) and the target blocks.
    edges: BTreeMap<(String, String, Kind), HashSet<String>>,
}

impl Builder<'_> {
    fn keep(&self, r: &LinkRow) -> bool {
        self.kinds.contains(&r.kind) && r.src_file != r.dst_file
    }

    fn add_edge(&mut self, r: &LinkRow) {
        let e = self
            .edges
            .entry((r.src_file.clone(), r.dst_file.clone(), r.kind))
            .or_default();
        if !r.dst_block.is_empty() {
            e.insert(r.dst_block.clone());
        }
    }
}

async fn finish(
    state: &SharedState,
    host: &std::sync::Arc<HostConfig>,
    reader: Reader<'_>,
    b: Builder<'_>,
    blocks: bool,
    truncated: bool,
    total: Option<usize>,
) -> Value {
    let mut deg_in: HashMap<&str, usize> = HashMap::new();
    let mut deg_out: HashMap<&str, usize> = HashMap::new();
    for (from, to, _) in b.edges.keys() {
        *deg_out.entry(from.as_str()).or_default() += 1;
        *deg_in.entry(to.as_str()).or_default() += 1;
    }
    let mut nodes = vec![];
    for f in &b.nodes {
        let a = &b.access[f];
        nodes.push(json!({
            "id": f,
            "kind": "canvas",
            "fileId": f,
            "title": a.name.clone().unwrap_or_else(|| f.clone()),
            "path": a.path,
            "space": space_of(a),
            "updatedAt": a.updated_at,
            "in": deg_in.get(f.as_str()).copied().unwrap_or(0),
            "out": deg_out.get(f.as_str()).copied().unwrap_or(0),
        }));
    }
    let mut edges = vec![];
    // Block nodes: link targets inside readable canvases, titled from the canvas at read time.
    let mut block_nodes: BTreeMap<(String, String), usize> = BTreeMap::new();
    for ((from, to, kind), targets) in &b.edges {
        if blocks && !targets.is_empty() {
            for t in targets {
                *block_nodes.entry((to.clone(), t.clone())).or_default() += 1;
                edges.push(json!({"from": from, "to": format!("{to}#{t}"), "kind": kind.as_str()}));
            }
        } else {
            edges.push(json!({"from": from, "to": to, "kind": kind.as_str()}));
        }
    }
    if blocks && !block_nodes.is_empty() {
        let patterns = crate::links::LinksCfg::of(host).patterns;
        let files: Vec<String> = block_nodes
            .keys()
            .map(|(f, _)| f.clone())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .take(50)
            .collect();
        let mut titles: HashMap<String, crate::links::SourceText> = HashMap::new();
        for f in &files {
            if let Some(doc) = crate::links::source_doc(state, host, reader, f, &b.access[f]).await
            {
                titles.insert(f.clone(), crate::links::source_text(&doc, &patterns));
            }
        }
        for ((f, blk), n) in &block_nodes {
            let title = titles.get(f).and_then(|t| t.block_text(blk, 120));
            nodes.push(json!({
                "id": format!("{f}#{blk}"),
                "kind": "block",
                "fileId": f,
                "blockId": blk,
                "title": title,
                "path": b.access[f].path,
                "space": space_of(&b.access[f]),
                "updatedAt": b.access[f].updated_at,
                "in": n,
                "out": 0,
            }));
            edges.push(json!({"from": format!("{f}#{blk}"), "to": f, "kind": "in"}));
        }
    }
    let mut out = json!({"nodes": nodes, "edges": edges, "truncated": truncated});
    if let Some(t) = total {
        out["total"] = json!(t);
    }
    out
}

/// The graph as `reader` may see it.
pub async fn graph(
    state: &SharedState,
    host: &std::sync::Arc<HostConfig>,
    reader: Reader<'_>,
    p: Params,
) -> Result<Value, LinkError> {
    admit(state, host, reader.user_id, p.root.is_none()).await?;
    let key = (host.id.clone(), reader.user_id.to_string(), p.clone());
    let generation = crate::links::GENERATION.load(Ordering::Relaxed);
    if let Some(v) = state.graph_cache.0.lock().ok().and_then(|m| {
        m.get(&key)
            .filter(|(at, g, _)| at.elapsed() < CACHE_TTL && *g == generation)
            .map(|(_, _, v)| v.clone())
    }) {
        return Ok(v);
    }
    let v = match &p.root {
        Some(root) => local(state, host, reader, root, &p).await?,
        None => full(state, host, reader, &p).await?,
    };
    if let Ok(mut m) = state.graph_cache.0.lock() {
        if m.len() > 5_000 {
            m.retain(|_, (at, _, _)| at.elapsed() < CACHE_TTL);
        }
        m.insert(key, (Instant::now(), generation, v.clone()));
    }
    Ok(v)
}

async fn local(
    state: &SharedState,
    host: &std::sync::Arc<HostConfig>,
    reader: Reader<'_>,
    root: &str,
    p: &Params,
) -> Result<Value, LinkError> {
    let root_access = crate::links::target_access(state, host, reader, root).await?;
    let mut b = Builder {
        kinds: &p.kinds,
        nodes: vec![root.to_string()],
        access: HashMap::from([(root.to_string(), root_access)]),
        edges: BTreeMap::new(),
    };
    let mut checked: HashSet<String> = HashSet::from([root.to_string()]);
    let mut frontier = vec![root.to_string()];
    let mut truncated = false;
    let err = |e: anyhow::Error| LinkError::Internal(e.to_string());
    for _ in 0..p.depth {
        // Rows touching the frontier, both directions.
        let rows = state
            .store
            .links_touching(&host.id, &frontier)
            .await
            .map_err(err)?;
        let rows: Vec<LinkRow> = rows.into_iter().filter(|r| b.keep(r)).collect();
        // New neighbours, checked before they join or are expanded.
        let mut fresh: Vec<String> = vec![];
        for r in &rows {
            for f in [&r.src_file, &r.dst_file] {
                if !checked.contains(f) && !fresh.contains(f) {
                    fresh.push(f.clone());
                }
            }
        }
        checked.extend(fresh.iter().cloned());
        let mut next = vec![];
        // One access call for the whole level (the client splits it into batches of 200).
        let (ok_all, _gone) = crate::links::readable(state, host, reader, &fresh).await;
        for chunk in fresh.chunks(BATCH) {
            let ok = &ok_all;
            for f in chunk {
                if let Some(a) = ok.get(f) {
                    if b.nodes.len() >= p.limit {
                        truncated = true;
                        break;
                    }
                    b.nodes.push(f.clone());
                    b.access.insert(f.clone(), a.clone());
                    next.push(f.clone());
                }
            }
        }
        for r in &rows {
            if b.access.contains_key(&r.src_file) && b.access.contains_key(&r.dst_file) {
                b.add_edge(r);
            }
        }
        if next.is_empty() || truncated {
            break;
        }
        frontier = next;
    }
    Ok(finish(state, host, reader, b, p.blocks, truncated, None).await)
}

async fn full(
    state: &SharedState,
    host: &std::sync::Arc<HostConfig>,
    reader: Reader<'_>,
    p: &Params,
) -> Result<Value, LinkError> {
    let rows: Vec<LinkRow> = state
        .store
        .links_all(&host.id, FULL_ROWS)
        .await
        .map_err(|e| LinkError::Internal(e.to_string()))?;
    let rows_cut = rows.len() as i64 >= FULL_ROWS;
    let mut b = Builder {
        kinds: &p.kinds,
        nodes: vec![],
        access: HashMap::new(),
        edges: BTreeMap::new(),
    };
    let rows: Vec<LinkRow> = rows.into_iter().filter(|r| b.keep(r)).collect();
    let mut degree: HashMap<&str, usize> = HashMap::new();
    for r in &rows {
        *degree.entry(r.src_file.as_str()).or_default() += 1;
        *degree.entry(r.dst_file.as_str()).or_default() += 1;
    }
    let mut candidates: Vec<(&str, usize)> = degree.into_iter().collect();
    candidates.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    let all = candidates.len();
    let candidates: Vec<String> = candidates
        .into_iter()
        .take(FULL_CANDIDATES)
        .map(|(f, _)| f.to_string())
        .collect();
    let mut checked = 0;
    let mut truncated = rows_cut || all > FULL_CANDIDATES;
    'outer: for chunk in candidates.chunks(BATCH) {
        let (ok, _gone) = crate::links::readable(state, host, reader, chunk).await;
        checked += chunk.len();
        for f in chunk {
            if let Some(a) = ok.get(f) {
                if b.nodes.len() >= p.limit {
                    truncated = true;
                    break 'outer;
                }
                b.nodes.push(f.clone());
                b.access.insert(f.clone(), a.clone());
            }
        }
    }
    if checked < candidates.len() {
        truncated = true;
    }
    for r in &rows {
        if b.access.contains_key(&r.src_file) && b.access.contains_key(&r.dst_file) {
            b.add_edge(r);
        }
    }
    let total = (!truncated).then_some(b.nodes.len());
    Ok(finish(state, host, reader, b, p.blocks, truncated, total).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_take_the_documented_ranges() {
        let p = Params::parse(Some("f".into()), None, None, None, None).unwrap();
        assert_eq!(
            (p.depth, p.limit, p.kinds.len(), p.blocks),
            (1, 200, 3, false)
        );
        let full = Params::parse(None, None, Some("link"), Some(true), None).unwrap();
        assert_eq!((full.limit, full.kinds.clone()), (2000, vec![Kind::Link]));
        assert!(Params::parse(Some("f".into()), Some(4), None, None, None).is_err());
        assert!(Params::parse(Some("f".into()), None, None, None, Some(501)).is_err());
        assert!(Params::parse(None, None, None, None, Some(2001)).is_err());
        assert!(Params::parse(None, None, Some("link,text"), None, None).is_err());
    }

    #[test]
    fn the_space_is_the_hosts_or_the_first_path_segment() {
        let a = AccessDetail {
            path: Some("Engineering / Identity".into()),
            ..Default::default()
        };
        assert_eq!(space_of(&a).as_deref(), Some("Engineering"));
        let b = AccessDetail {
            space: Some("Ops".into()),
            ..a
        };
        assert_eq!(space_of(&b).as_deref(), Some("Ops"));
    }
}
