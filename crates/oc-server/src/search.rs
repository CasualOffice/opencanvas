// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Search across canvases (SRCH-02/03, ADR-065, docs/34 §4.3). The host indexes; OpenCanvas
//! keeps no index and caches no result. This module holds `[host.search]`, the call to the
//! host's optional `GET /search` callback and the checks on its answer, shared by the editor
//! route (`GET /v1/search`), the API (`GET /api/v1/search`) and MCP (`canvas_search`), so all
//! three return the same items.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::StatusCode;
use serde_json::{Value, json};

use crate::SharedState;
use crate::hosts::HostConfig;

/// Items per page the host may return; more are dropped.
pub const MAX_ITEMS: usize = 50;
/// Scopes the host may offer with an answer.
pub const MAX_SCOPES: usize = 4;
/// Longest query passed on.
pub const MAX_Q: usize = 200;
/// How long a host that answered 404/405/501 is treated as having no callback.
pub const PROBE_TTL: Duration = Duration::from_secs(600);
/// Searches per user and minute (API, MCP and the editor share it). The `[[` link picker
/// searches as people type, so ten a minute (the first limit) refused people mid-word; 60 a
/// minute with a burst of 20 keeps typing smooth and still bounds a script.
pub const PER_MINUTE: f64 = 60.0;
/// Searches a person may make at once before the per-minute rate applies.
pub const BURST: f64 = 20.0;

/// `[host.search]`, checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchCfg {
    /// The host implements `GET /search` (default false).
    pub callback: bool,
    /// `search.json` carries comment text (default false).
    pub comments: bool,
    /// How long to wait for the callback (default 8,000 ms, 500-30,000).
    pub timeout_ms: u64,
}

impl Default for SearchCfg {
    fn default() -> Self {
        Self {
            callback: false,
            comments: false,
            timeout_ms: 8000,
        }
    }
}

impl SearchCfg {
    pub fn parse(t: &toml::Table) -> anyhow::Result<Self> {
        let mut c = Self::default();
        for (k, v) in t {
            match k.as_str() {
                "callback" => {
                    c.callback = v.as_bool().ok_or_else(|| {
                        anyhow::anyhow!("[host.search] callback takes true or false")
                    })?
                }
                "comments" => {
                    c.comments = v.as_bool().ok_or_else(|| {
                        anyhow::anyhow!("[host.search] comments takes true or false")
                    })?
                }
                "timeout_ms" => {
                    c.timeout_ms = v
                        .as_integer()
                        .filter(|n| (500..=30_000).contains(n))
                        .ok_or_else(|| anyhow::anyhow!("[host.search] timeout_ms is 500-30000"))?
                        as u64
                }
                other => anyhow::bail!(
                    "[host.search] has no setting {other:?} (callback, comments, timeout_ms)"
                ),
            }
        }
        Ok(c)
    }

    pub fn model_options(&self) -> oc_model::search::Options {
        oc_model::search::Options {
            comments: self.comments,
        }
    }
}

/// Hosts whose callback answered "not implemented", until when.
#[derive(Default)]
pub struct Probe(Mutex<HashMap<String, Instant>>);

impl Probe {
    /// Whether the editor shows "Search all canvases" for this host.
    pub fn available(&self, host: &HostConfig) -> bool {
        host.search().callback
            && self
                .0
                .lock()
                .map(|m| m.get(&host.id).is_none_or(|until| Instant::now() >= *until))
                .unwrap_or(true)
    }

    fn missing(&self, host: &HostConfig) {
        if let Ok(mut m) = self.0.lock() {
            m.insert(host.id.clone(), Instant::now() + PROBE_TTL);
        }
    }
}

/// Why a search could not be answered.
#[derive(Debug, PartialEq)]
pub enum SearchError {
    /// The host has no search callback (404/405/501, or `[host.search] callback` off).
    Unavailable,
    /// The query is empty or too long.
    BadQuery(&'static str),
    /// Past the per-user limit; seconds to wait.
    RateLimited(u64),
    /// The host did not answer in time.
    Timeout,
    /// The host answered with an error or something that is not a search answer.
    Host(String),
}

/// Who is searching.
pub struct Searcher<'a> {
    pub user_id: &'a str,
    /// The person's callback token (editor sessions); empty for API and MCP tokens.
    pub token: &'a str,
}

/// The query of a search.
#[derive(Debug, Default, Clone)]
pub struct Query {
    pub q: String,
    pub scope: Option<String>,
    pub cursor: Option<String>,
    pub limit: usize,
}

fn clip(v: &Value, max: usize) -> Option<String> {
    let s = v.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    let mut end = s.len().min(max);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    Some(s[..end].to_string())
}

/// The host's answer, normalised: `{items: [{fileId, title, path?, blockId?, snippet,
/// updatedAt?}], scopes, partial, next}`. Unknown fields are dropped; snippets stay plain text
/// (the editor escapes and highlights them). Accepts `results` (docs/34 §4.3 prototype) or
/// `items`.
pub fn normalise(v: &Value) -> Result<Value, SearchError> {
    let list = v
        .get("items")
        .or_else(|| v.get("results"))
        .and_then(Value::as_array)
        .ok_or_else(|| SearchError::Host("the answer has no items".into()))?;
    let items: Vec<Value> = list
        .iter()
        .filter_map(|it| {
            let file_id = clip(&it["fileId"], 1024)?;
            let mut o = json!({
                "fileId": file_id,
                "title": clip(&it["title"], 300).unwrap_or_else(|| "Untitled".into()),
                "snippet": clip(&it["snippet"], 600).unwrap_or_default(),
            });
            for (k, max) in [("path", 500), ("blockId", 128), ("updatedAt", 64)] {
                if let Some(x) = clip(&it[k], max) {
                    o[k] = json!(x);
                }
            }
            Some(o)
        })
        .take(MAX_ITEMS)
        .collect();
    let scopes: Vec<Value> = v["scopes"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    Some(json!({"id": clip(&s["id"], 64)?, "label": clip(&s["label"], 80)?}))
                })
                .take(MAX_SCOPES)
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({
        "items": items,
        "scopes": scopes,
        "partial": v["partial"].as_bool().unwrap_or(false),
        "next": clip(&v["next"], 512),
    }))
}

/// Runs a search through the host's callback, as `who`. Results whose file the host's
/// `/access` refuses for that person are dropped (when the host has `/access`).
pub async fn run(
    state: &SharedState,
    host: &HostConfig,
    who: Searcher<'_>,
    query: Query,
) -> Result<Value, SearchError> {
    if !state.search_probe.available(host) {
        return Err(SearchError::Unavailable);
    }
    let q = query.q.trim();
    if q.is_empty() {
        return Err(SearchError::BadQuery("q is required"));
    }
    if q.len() > MAX_Q {
        return Err(SearchError::BadQuery("q is limited to 200 bytes"));
    }
    let policy = crate::ratelimit::Policy {
        name: "search",
        rate: PER_MINUTE / 60.0,
        burst: BURST,
    };
    let d = state
        .limiter
        .check(&format!("search:{}:{}", host.id, who.user_id), policy)
        .await;
    if !d.ok {
        return Err(SearchError::RateLimited(d.retry_after));
    }
    let cfg = host.search();
    let limit = query.limit.clamp(1, MAX_ITEMS);
    let (status, body) = state
        .host
        .search(
            host,
            who.token,
            who.user_id,
            q,
            query.scope.as_deref(),
            query.cursor.as_deref(),
            limit,
            cfg.timeout_ms,
        )
        .await
        .map_err(|e| match e {
            crate::host_client::HostError::Http(e) if e.is_timeout() => SearchError::Timeout,
            other => SearchError::Host(other.to_string()),
        })?;
    if matches!(
        status,
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED | StatusCode::NOT_IMPLEMENTED
    ) {
        state.search_probe.missing(host);
        return Err(SearchError::Unavailable);
    }
    if !status.is_success() {
        return Err(SearchError::Host(format!("the host answered {status}")));
    }
    let v: Value = serde_json::from_slice(&body)
        .map_err(|_| SearchError::Host("the answer is not JSON".into()))?;
    let mut out = normalise(&v)?;
    // docs/34 §4.4: drop hits on files the person cannot open, when the host can say.
    let mut allowed: HashMap<String, bool> = HashMap::new();
    let ids: Vec<String> = out["items"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|i| i["fileId"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    for id in ids {
        if allowed.contains_key(&id) {
            continue;
        }
        let ok = match state.host.access(host, &id, who.user_id).await {
            Ok(Some(role)) => role.is_some(),
            // No `/access`: the host's filtering stands.
            Ok(None) => true,
            Err(_) => false,
        };
        allowed.insert(id, ok);
    }
    if let Some(items) = out["items"].as_array_mut() {
        items.retain(|i| {
            i["fileId"]
                .as_str()
                .is_some_and(|f| allowed.get(f) == Some(&true))
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_and_errors() {
        let c = SearchCfg::parse(&toml::Table::new()).unwrap();
        assert_eq!(c, SearchCfg::default());
        assert!(!c.callback && !c.comments && c.timeout_ms == 8000);
        let t: toml::Table =
            toml::from_str("callback = true\ncomments = true\ntimeout_ms = 2000").unwrap();
        let c = SearchCfg::parse(&t).unwrap();
        assert!(c.callback && c.comments && c.timeout_ms == 2000);
        for bad in ["callback = 1", "timeout_ms = 10", "index = true"] {
            assert!(
                SearchCfg::parse(&toml::from_str(bad).unwrap()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn normalise_caps_and_drops_unknown() {
        let many: Vec<Value> = (0..80)
            .map(|i| json!({"fileId": format!("f{i}"), "title": "T", "snippet": "<b>x</b>", "secret": 1}))
            .collect();
        let v = normalise(&json!({"results": many, "partial": true, "next": "c2",
            "scopes": [{"id":"a","label":"A"},{"id":"b","label":"B"},{"id":"c","label":"C"},{"id":"d","label":"D"},{"id":"e","label":"E"}]}))
        .unwrap();
        assert_eq!(v["items"].as_array().unwrap().len(), MAX_ITEMS);
        assert_eq!(v["items"][0]["snippet"], "<b>x</b>");
        assert!(v["items"][0].get("secret").is_none());
        assert_eq!(v["scopes"].as_array().unwrap().len(), MAX_SCOPES);
        assert_eq!(v["partial"], true);
        assert_eq!(v["next"], "c2");
        assert!(normalise(&json!({"nope": []})).is_err());
        // An item without a file id is dropped.
        let v = normalise(&json!({"items": [{"title": "x"}]})).unwrap();
        assert!(v["items"].as_array().unwrap().is_empty());
    }
}
