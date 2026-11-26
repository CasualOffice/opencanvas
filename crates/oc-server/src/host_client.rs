// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Calls from OpenCanvas to the host (docs/15 §5): signed with HMAC, bearer callback token.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use hmac::{Hmac, Mac};
use reqwest::{Method, StatusCode, Url, header};
use sha2::Sha256;

use crate::hosts::HostConfig;
use crate::store::Store;
use crate::wopi;

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("host unreachable: {0}")]
    Http(reqwest::Error),
    #[error("host answered {0}")]
    Status(StatusCode),
    #[error("bad callback url")]
    Url,
    #[error("unexpected host answer: {0}")]
    Body(String),
    #[error("host answer over the size limit")]
    TooLarge,
}

/// Errors never carry the URL: it names internal callback hosts and, in WOPI mode, holds the
/// access token; `HostError` messages reach browsers and logs (SEC-08).
impl From<reqwest::Error> for HostError {
    fn from(e: reqwest::Error) -> Self {
        Self::Http(e.without_url())
    }
}

pub enum Fetched {
    Missing,
    Found {
        bytes: Bytes,
        content_type: String,
        etag: Option<String>,
    },
}

pub enum PutOutcome {
    Saved { version: Option<String> },
    Conflict,
}

pub struct PutRequest<'a> {
    pub file_id: &'a str,
    pub body: Vec<u8>,
    pub if_match: Option<&'a str>,
    pub idempotency_key: &'a str,
    pub authors: &'a [String],
    pub meta: &'a SaveMeta,
}

/// What a save is, for the host (docs/30 §3.1, §4; ADR-051). Hosts that ignore it still get a
/// correct file: the same facts are in the manifest's `commit`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SaveMeta {
    pub kind: oc_model::ocanvas::CommitKind,
    /// The version's name (named and restore saves).
    pub message: Option<String>,
    /// Restore saves: the version restored.
    pub restored_from: Option<String>,
    /// A save worth keeping for hosts that prune: the last save of a room, the first after 30
    /// minutes of editing, and every named or restore save.
    pub checkpoint: bool,
}

impl SaveMeta {
    /// Reads the facts back from a saved file's manifest (an outbox row resumed after a
    /// restart). Named and restore saves are checkpoints; others are not, as the hint is not
    /// in the file.
    pub fn from_ocanvas(bytes: &[u8]) -> Self {
        let m = oc_model::ocanvas::read_manifest(bytes).unwrap_or_default();
        let c = &m["commit"];
        let kind = oc_model::ocanvas::CommitKind::parse(c["kind"].as_str());
        Self {
            kind,
            message: c["message"].as_str().map(String::from),
            restored_from: c["restoredFrom"].as_str().map(String::from),
            checkpoint: kind != oc_model::ocanvas::CommitKind::Auto,
        }
    }

    /// The JWT save headers besides the fixed ones (docs/05 §5).
    pub fn jwt_headers(&self) -> Vec<(&'static str, String)> {
        use oc_model::ocanvas::CommitKind;
        let mut h = vec![(
            "X-OpenCanvas-Autosave",
            if self.kind == CommitKind::Auto {
                "1"
            } else {
                "0"
            }
            .to_string(),
        )];
        if let Some(m) = &self.message {
            h.push(("X-OpenCanvas-Commit-Message", percent_encode(m)));
        }
        if let Some(v) = &self.restored_from {
            h.push(("X-OpenCanvas-Restored-From", percent_encode(v)));
        }
        if self.checkpoint {
            h.push(("X-OpenCanvas-Checkpoint", "1".to_string()));
        }
        h
    }
}

/// Percent-encodes UTF-8 for a header value: everything but unreserved ASCII (RFC 3986).
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Largest version the host may return (checked like a load).
pub const MAX_VERSION_BYTES: usize = 100 * 1024 * 1024;

/// Normalizes a host's version list (docs/30 §3.1): `{versions: [{version, at, authors, name?,
/// kind, size?}], next?}`, at most 100 entries, names clipped to 120 characters.
pub fn normalize_versions(v: &serde_json::Value) -> Result<serde_json::Value, HostError> {
    use serde_json::{Value, json};
    let list = v
        .get("versions")
        .and_then(Value::as_array)
        .ok_or_else(|| HostError::Body("version list without versions".into()))?;
    let text = |x: &Value| match x {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    };
    let mut out = Vec::new();
    for e in list.iter().take(100) {
        let Some(version) = e.get("version").and_then(text) else {
            continue;
        };
        if version.len() > 200 {
            continue;
        }
        let kind = oc_model::ocanvas::CommitKind::parse(e.get("kind").and_then(Value::as_str));
        let name: Option<String> = e
            .get("name")
            .and_then(Value::as_str)
            .map(|n| n.trim().chars().take(120).collect::<String>())
            .filter(|n| !n.is_empty());
        let authors: Vec<String> = e
            .get("authors")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .take(50)
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        let mut row = json!({
            "version": version,
            "at": e.get("at").and_then(Value::as_str).unwrap_or_default(),
            "authors": authors,
            "kind": kind.as_str(),
        });
        if let Some(n) = name {
            row["name"] = json!(n);
        }
        if let Some(s) = e.get("size").and_then(Value::as_u64) {
            row["size"] = json!(s);
        }
        if let Some(r) = e.get("restoredFrom").and_then(text) {
            row["restoredFrom"] = json!(r);
        }
        out.push(row);
    }
    let mut res = json!({"versions": out});
    if let Some(n) = v
        .get("next")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty() && n.len() <= 500)
    {
        res["next"] = json!(n);
    }
    Ok(res)
}

/// Where a file is loaded from and saved to: the JWT callbacks (docs/05 §5) or the WOPI host
/// (docs/05 §6). Rooms do not care; every load / save / copy goes through [`HostClient`],
/// which picks the target from the host's `mode` and the file id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveTarget {
    Callbacks,
    /// The file id is an allowlisted `WOPISrc`.
    Wopi(Url),
}

impl SaveTarget {
    /// `mode = "wopi"`: the file id must be an allowlisted `WOPISrc` (else `HostError::Url`,
    /// nothing is called). `mode = "both"`: WOPI when it is one, callbacks otherwise.
    pub fn of(host: &HostConfig, file_id: &str) -> Result<Self, HostError> {
        if !host.accepts_wopi() {
            return Ok(Self::Callbacks);
        }
        match wopi::check_src(&host.wopi_allowlist, file_id) {
            Some(src) => Ok(Self::Wopi(src)),
            None if host.wopi_only() => Err(HostError::Url),
            None => Ok(Self::Callbacks),
        }
    }
}

#[derive(Clone)]
pub struct HostClient {
    /// `/access` answers per (host, file, user), reused for [`ACCESS_TTL`].
    access_cache: Arc<Mutex<AccessCache>>,
    http: reqwest::Client,
    /// For asset downloads and every WOPI call: never follows redirects (an allowed URL must
    /// not bounce elsewhere, and a WOPI redirect would carry the access token away).
    assets: reqwest::Client,
    /// WOPI mode: assets inlined into saved files come from here.
    store: Option<Store>,
    /// WOPI mode: `BaseFileName` per `WOPISrc` (decides `.md` vs `.ocanvas` on save).
    wopi_names: Arc<Mutex<HashMap<String, String>>>,
    /// WOPI proof keys: every WOPI call is signed (docs/05 §6.4).
    proof: Option<crate::proof::ProofKeys>,
    /// `oc_host_callback_seconds{host,op}` and `oc_host_callbacks_total{host,op,result}`.
    metrics: Arc<crate::metrics::Metrics>,
}

/// Result label of a host call that failed.
fn err_class(e: &HostError) -> &'static str {
    match e {
        HostError::Status(s) if s.is_client_error() => "4xx",
        HostError::Status(_) => "5xx",
        HostError::Http(_) => "unreachable",
        _ => "error",
    }
}

/// Result label of a host answer carried as a status code.
fn status_result(s: StatusCode) -> &'static str {
    if s.is_success() {
        "ok"
    } else if s.is_client_error() {
        "4xx"
    } else {
        "5xx"
    }
}

/// Largest image fetched for an export.
pub const MAX_ASSET_FETCH: usize = 10 * 1024 * 1024;

pub fn signature(secret: &[u8], t: i64, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("hmac accepts any key length");
    mac.update(format!("{t}.").as_bytes());
    mac.update(body);
    format!("t={t},v1={}", hex::encode(mac.finalize().into_bytes()))
}

/// The full `X-OpenCanvas-Signature` value: `t=…,v1=…,v2=…`. `v1` covers only the timestamp
/// and body, so an empty-body GET signature was valid for every GET path for 5 minutes;
/// `v2` = HMAC(secret, `<t>.<METHOD>.<path?query>.<body>`) binds the request too (SEC-18).
pub fn signature_header(
    secret: &[u8],
    t: i64,
    method: &str,
    path_query: &str,
    body: &[u8],
) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("hmac accepts any key length");
    mac.update(format!("{t}.{method}.{path_query}.").as_bytes());
    mac.update(body);
    format!(
        "{},v2={}",
        signature(secret, t, body),
        hex::encode(mac.finalize().into_bytes())
    )
}

fn unquote(etag: &str) -> String {
    etag.trim()
        .trim_start_matches("W/")
        .trim_matches('"')
        .to_string()
}

/// How long a host's `/access` answer is reused (docs/05).
pub const ACCESS_TTL: Duration = Duration::from_secs(30);

/// A `/access` answer: `None` = the host does not implement the callback, `Some(None)` = no
/// access, `Some(Some(role))`.
pub type AccessAnswer = Option<Option<crate::grant::Role>>;
type AccessCache = HashMap<(String, String, String), (std::time::Instant, Option<AccessDetail>)>;

/// A full `/access` answer (LIVE-01, docs/05 §5): the role (`None` = no access) and, for live
/// files, the optional `name` and `callbackToken` the server uses for that file's room, and
/// the optional `path` (where it lives in the host, at most 200 characters, shown as text).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AccessDetail {
    pub role: Option<crate::grant::Role>,
    pub name: Option<String>,
    pub callback_token: Option<String>,
    /// LIVE-03 (prototype 2a): "Leadership weekly › Q1", for the live block's header.
    pub path: Option<String>,
    /// LIVE-03 (prototype 5e): the host answered 410, or `{"role": "none", "gone": true}`: the
    /// file was deleted or moved.
    pub gone: bool,
}

impl Default for HostClient {
    fn default() -> Self {
        Self::new()
    }
}

impl HostClient {
    pub fn new() -> Self {
        // Signed callbacks never follow redirects: the request (with its signature and bearer)
        // must not be replayed to wherever a `Location` points (SEC-07).
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("opencanvas/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        let assets = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("opencanvas/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        Self {
            http,
            assets,
            store: None,
            wopi_names: Arc::default(),
            access_cache: Arc::default(),
            proof: None,
            metrics: Arc::default(),
        }
    }

    /// Records host calls in these metrics.
    pub fn with_metrics(mut self, metrics: Arc<crate::metrics::Metrics>) -> Self {
        self.metrics = metrics;
        self
    }

    fn record(&self, host: &HostConfig, op: &str, result: &str, started: std::time::Instant) {
        self.metrics
            .host_call(&host.id, op, result, started.elapsed());
    }

    /// Gives the client the store WOPI-mode assets live in.
    pub fn with_store(mut self, store: Store) -> Self {
        self.store = Some(store);
        self
    }

    /// Gives the client the WOPI proof keys it signs every WOPI call with.
    pub fn with_proof(mut self, proof: Option<crate::proof::ProofKeys>) -> Self {
        self.proof = proof;
        self
    }

    /// The WOPI proof keys, when configured.
    pub fn wopi_proof(&self) -> Option<&crate::proof::ProofKeys> {
        self.proof.as_ref()
    }

    /// The HTTP client for WOPI calls (no redirects).
    pub fn wopi_http(&self) -> &reqwest::Client {
        &self.assets
    }

    /// Remembers a WOPI file's `BaseFileName` (from the launch's CheckFileInfo).
    pub fn remember_wopi_name(&self, src: &Url, name: &str) {
        self.wopi_names
            .lock()
            .expect("wopi names lock")
            .insert(src.to_string(), name.to_string());
    }

    async fn wopi_name(&self, src: &Url, token: &str) -> String {
        let cached = self
            .wopi_names
            .lock()
            .expect("wopi names lock")
            .get(src.as_str())
            .cloned();
        if let Some(n) = cached {
            return n;
        }
        match wopi::check_file_info(&self.assets, self.proof.as_ref(), src, token).await {
            Ok(info) => {
                self.remember_wopi_name(src, &info.base_file_name);
                info.base_file_name
            }
            Err(e) => {
                tracing::warn!(error = %e, "WOPI CheckFileInfo before save failed");
                String::new()
            }
        }
    }

    /// The `.ocanvas` with the room's referenced assets inlined as `assets/<id>`.
    pub async fn inline_assets(&self, room: &str, body: Vec<u8>) -> Result<Vec<u8>, HostError> {
        let Some(store) = &self.store else {
            return Ok(body);
        };
        let assets = store
            .room_assets(room)
            .await
            .map_err(|e| HostError::Body(format!("reading assets: {e}")))?;
        if assets.is_empty() {
            return Ok(body);
        }
        // Only assets the document still references are kept.
        let text = oc_model::read_ocanvas(&body)
            .map(|l| oc_model::doc_to_json(&l.doc).to_string())
            .map_err(|e| HostError::Body(e.to_string()))?;
        let used: Vec<_> = assets
            .into_iter()
            .filter(|a| text.contains(&format!("/v1/assets/{}", a.id)))
            .collect();
        oc_model::ocanvas::with_assets(&body, &used).map_err(|e| HostError::Body(e.to_string()))
    }

    async fn wopi_get(
        &self,
        host: &HostConfig,
        src: &Url,
        token: &str,
    ) -> Result<Fetched, HostError> {
        let info = wopi::check_file_info(&self.assets, self.proof.as_ref(), src, token).await?;
        self.remember_wopi_name(src, &info.base_file_name);
        let (bytes, content_type) =
            wopi::get_contents(&self.assets, self.proof.as_ref(), src, token).await?;
        if bytes.is_empty() {
            return Ok(Fetched::Missing);
        }
        if oc_model::ocanvas::is_zip(&bytes)
            && let Some(store) = &self.store
        {
            let room = crate::grant::room_id(&host.id, src.as_str());
            for asset in oc_model::ocanvas::read_assets(&bytes).unwrap_or_default() {
                if let Err(e) = store.asset_put(&room, &asset, crate::util::now_ms()).await {
                    tracing::warn!(room = %room, error = %e, "storing an inlined asset failed");
                }
            }
        }
        let content_type = if wopi::is_markdown(&info.base_file_name) {
            "text/markdown".into()
        } else {
            content_type
        };
        Ok(Fetched::Found {
            bytes,
            content_type,
            etag: info.stamp(),
        })
    }

    async fn wopi_put(
        &self,
        host: &HostConfig,
        src: &Url,
        token: &str,
        req: PutRequest<'_>,
    ) -> Result<PutOutcome, HostError> {
        let name = self.wopi_name(src, token).await;
        let body = if wopi::is_markdown(&name) {
            // Markdown files stay Markdown (lossy for boards / databases, docs/05 §6).
            let doc = oc_model::read_ocanvas(&req.body)
                .map_err(|e| HostError::Body(e.to_string()))?
                .doc;
            oc_model::export::to_markdown_with(
                &oc_model::doc_to_json(&doc),
                &oc_model::export::Options::default(),
            )
            .into_bytes()
        } else {
            let room = crate::grant::room_id(&host.id, src.as_str());
            self.inline_assets(&room, req.body).await?
        };
        match wopi::put_contents(
            &self.assets,
            self.proof.as_ref(),
            src,
            token,
            body,
            req.if_match,
            req.meta,
        )
        .await?
        {
            wopi::PutResult::Conflict => Ok(PutOutcome::Conflict),
            wopi::PutResult::Saved(Some(stamp)) => Ok(PutOutcome::Saved {
                version: Some(stamp),
            }),
            // No LastModifiedTime in the answer: ask for it, so the next save is checked.
            wopi::PutResult::Saved(None) => {
                let version = wopi::check_file_info(&self.assets, self.proof.as_ref(), src, token)
                    .await
                    .ok()
                    .and_then(|i| i.stamp());
                Ok(PutOutcome::Saved { version })
            }
        }
    }

    async fn wopi_copy(
        &self,
        host: &HostConfig,
        src: &Url,
        token: &str,
        body: Vec<u8>,
    ) -> Result<(String, String), HostError> {
        let name = self.wopi_name(src, token).await;
        let room = crate::grant::room_id(&host.id, src.as_str());
        let body = self.inline_assets(&room, body).await?;
        wopi::put_relative(
            &self.assets,
            self.proof.as_ref(),
            src,
            token,
            body,
            &wopi::copy_name(&name),
        )
        .await
    }

    fn url(host: &HostConfig, segments: &[&str]) -> Result<Url, HostError> {
        let mut url = Url::parse(&host.callback_base).map_err(|_| HostError::Url)?;
        url.path_segments_mut()
            .map_err(|_| HostError::Url)?
            .pop_if_empty()
            .extend(segments);
        Ok(url)
    }

    fn request(
        &self,
        host: &HostConfig,
        token: &str,
        method: Method,
        url: Url,
        body: Vec<u8>,
        timeout: u64,
    ) -> reqwest::RequestBuilder {
        Self::signed(&self.http, host, token, method, url, body, timeout)
    }

    fn signed(
        client: &reqwest::Client,
        host: &HostConfig,
        token: &str,
        method: Method,
        url: Url,
        body: Vec<u8>,
        timeout: u64,
    ) -> reqwest::RequestBuilder {
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let path_query = match url.query() {
            Some(q) => format!("{}?{q}", url.path()),
            None => url.path().to_string(),
        };
        let sig = signature_header(
            host.signing_secret(),
            t,
            method.as_str(),
            &path_query,
            &body,
        );
        let req = client
            .request(method, url)
            .timeout(Duration::from_secs(timeout))
            .bearer_auth(token)
            .header("X-OpenCanvas-Signature", sig);
        // Also in a header of its own: some hosts never see `Authorization` (Mattermost strips
        // it before a plugin's ServeHTTP). Not signed, like the bearer (docs/05 §5).
        let req = if token.is_empty() {
            req
        } else {
            req.header("X-OpenCanvas-Callback-Token", token)
        };
        req.body(body)
    }

    pub async fn get_file(
        &self,
        host: &HostConfig,
        token: &str,
        file_id: &str,
    ) -> Result<Fetched, HostError> {
        let started = std::time::Instant::now();
        let r = self.get_file_once(host, token, file_id).await;
        let result = r.as_ref().map_or_else(err_class, |_| "ok");
        self.record(host, "load", result, started);
        r
    }

    async fn get_file_once(
        &self,
        host: &HostConfig,
        token: &str,
        file_id: &str,
    ) -> Result<Fetched, HostError> {
        if let SaveTarget::Wopi(src) = SaveTarget::of(host, file_id)? {
            return self.wopi_get(host, &src, token).await;
        }
        let url = Self::url(host, &["files", file_id])?;
        let res = self
            .request(host, token, Method::GET, url, Vec::new(), 10)
            .send()
            .await?;
        match res.status() {
            StatusCode::NOT_FOUND => Ok(Fetched::Missing),
            s if s.is_success() => {
                let etag = res
                    .headers()
                    .get(header::ETAG)
                    .and_then(|v| v.to_str().ok())
                    .map(unquote);
                let content_type = res
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .to_string();
                let bytes = res.bytes().await?;
                if bytes.is_empty() {
                    Ok(Fetched::Missing)
                } else {
                    Ok(Fetched::Found {
                        bytes,
                        content_type,
                        etag,
                    })
                }
            }
            s => Err(HostError::Status(s)),
        }
    }

    pub async fn put_file(
        &self,
        host: &HostConfig,
        token: &str,
        req: PutRequest<'_>,
    ) -> Result<PutOutcome, HostError> {
        let started = std::time::Instant::now();
        let r = self.put_file_once(host, token, req).await;
        let result = match &r {
            Ok(PutOutcome::Saved { .. }) => "ok",
            Ok(PutOutcome::Conflict) => "conflict",
            Err(e) => err_class(e),
        };
        self.record(host, "save", result, started);
        r
    }

    async fn put_file_once(
        &self,
        host: &HostConfig,
        token: &str,
        req: PutRequest<'_>,
    ) -> Result<PutOutcome, HostError> {
        if let SaveTarget::Wopi(src) = SaveTarget::of(host, req.file_id)? {
            return self.wopi_put(host, &src, token, req).await;
        }
        let url = Self::url(host, &["files", req.file_id])?;
        let mut rb = self
            .request(host, token, Method::PUT, url, req.body, 10)
            .header(header::CONTENT_TYPE, "application/vnd.opencanvas+zip")
            .header("Idempotency-Key", req.idempotency_key)
            .header(
                "X-OpenCanvas-Authors",
                serde_json::to_string(req.authors).unwrap_or_else(|_| "[]".into()),
            );
        for (k, v) in req.meta.jwt_headers() {
            rb = rb.header(k, v);
        }
        if let Some(v) = req.if_match {
            rb = rb.header(header::IF_MATCH, format!("\"{v}\""));
        }
        let res = rb.send().await?;
        match res.status() {
            StatusCode::CONFLICT | StatusCode::PRECONDITION_FAILED => Ok(PutOutcome::Conflict),
            s if s.is_success() => {
                let etag = res
                    .headers()
                    .get(header::ETAG)
                    .and_then(|v| v.to_str().ok())
                    .map(unquote);
                let body: serde_json::Value = res.json().await.unwrap_or_default();
                let version = body
                    .get("version")
                    .and_then(|v| {
                        v.as_str()
                            .map(String::from)
                            .or_else(|| v.as_i64().map(|n| n.to_string()))
                    })
                    .or(etag);
                Ok(PutOutcome::Saved { version })
            }
            s => Err(HostError::Status(s)),
        }
    }

    /// Version list (docs/30 §3.1, ADR-051): JWT `GET /files/{id}/versions?cursor=&limit=`,
    /// WOPI extension `GET {WOPISrc}/versions`. Normalized; `404`/`405`/`501` come back as
    /// `HostError::Status` (not implemented).
    pub async fn list_versions(
        &self,
        host: &HostConfig,
        token: &str,
        file_id: &str,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<serde_json::Value, HostError> {
        let raw = if let SaveTarget::Wopi(src) = SaveTarget::of(host, file_id)? {
            wopi::list_versions(&self.assets, self.proof.as_ref(), &src, token, cursor).await?
        } else {
            let mut url = Self::url(host, &["files", file_id, "versions"])?;
            {
                let mut q = url.query_pairs_mut();
                if let Some(c) = cursor {
                    q.append_pair("cursor", c);
                }
                q.append_pair("limit", &limit.clamp(1, 100).to_string());
            }
            let res = self
                .request(host, token, Method::GET, url, Vec::new(), 10)
                .send()
                .await?;
            if !res.status().is_success() {
                return Err(HostError::Status(res.status()));
            }
            let bytes = Self::capped(res, 1024 * 1024).await?;
            serde_json::from_slice(&bytes)
                .map_err(|_| HostError::Body("version list is not JSON".into()))?
        };
        normalize_versions(&raw)
    }

    /// One version's `.ocanvas` bytes: JWT `GET /files/{id}/versions/{v}`, WOPI extension
    /// `GET {WOPISrc}/versions/{v}/contents`. At most [`MAX_VERSION_BYTES`]; `404`/`410` = gone.
    pub async fn get_version(
        &self,
        host: &HostConfig,
        token: &str,
        file_id: &str,
        version: &str,
    ) -> Result<Bytes, HostError> {
        if let SaveTarget::Wopi(src) = SaveTarget::of(host, file_id)? {
            return wopi::get_version(&self.assets, self.proof.as_ref(), &src, token, version)
                .await;
        }
        let url = Self::url(host, &["files", file_id, "versions", version])?;
        let res = self
            .request(host, token, Method::GET, url, Vec::new(), 30)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(HostError::Status(res.status()));
        }
        Self::capped(res, MAX_VERSION_BYTES).await
    }

    /// Conflict policy `copy`: `POST /files/{id}/copies` with the session's `.ocanvas`.
    /// Returns the new file's id and URL.
    pub async fn post_copy(
        &self,
        host: &HostConfig,
        token: &str,
        file_id: &str,
        body: Vec<u8>,
        idempotency_key: &str,
    ) -> Result<(String, String), HostError> {
        let started = std::time::Instant::now();
        let r = self
            .post_copy_once(host, token, file_id, body, idempotency_key)
            .await;
        let result = r.as_ref().map_or_else(err_class, |_| "ok");
        self.record(host, "copy", result, started);
        r
    }

    async fn post_copy_once(
        &self,
        host: &HostConfig,
        token: &str,
        file_id: &str,
        body: Vec<u8>,
        idempotency_key: &str,
    ) -> Result<(String, String), HostError> {
        if let SaveTarget::Wopi(src) = SaveTarget::of(host, file_id)? {
            return self.wopi_copy(host, &src, token, body).await;
        }
        let url = Self::url(host, &["files", file_id, "copies"])?;
        let res = self
            .request(host, token, Method::POST, url, body, 10)
            .header(header::CONTENT_TYPE, "application/vnd.opencanvas+zip")
            .header("Idempotency-Key", idempotency_key)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(HostError::Status(res.status()));
        }
        let v: serde_json::Value = res.json().await?;
        let field = |k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
        match (field("fileId"), field("url")) {
            (Some(id), url) => Ok((id, url.unwrap_or_default())),
            _ => Err(HostError::Body("copy response without fileId".into())),
        }
    }

    /// Forwards a multipart upload unchanged; returns the host's status, content type and body.
    pub async fn post_asset(
        &self,
        host: &HostConfig,
        token: &str,
        file_id: &str,
        content_type: &str,
        body: Vec<u8>,
    ) -> Result<(StatusCode, String, Bytes), HostError> {
        let url = Self::url(host, &["files", file_id, "assets"])?;
        let res = self
            .request(host, token, Method::POST, url, body, 30)
            .header(header::CONTENT_TYPE, content_type)
            .send()
            .await?;
        Self::passthrough(res).await
    }

    /// Downloads an image from an allowed origin (the caller checks it, see `assets`), signed
    /// like every callback when `signed`, without following redirects, at most
    /// [`MAX_ASSET_FETCH`] bytes, and only when the answer is `image/*`.
    pub async fn get_asset(
        &self,
        host: &HostConfig,
        token: &str,
        url: Url,
        signed: bool,
    ) -> Result<Bytes, HostError> {
        let req = if signed {
            Self::signed(&self.assets, host, token, Method::GET, url, Vec::new(), 10)
        } else {
            self.assets.get(url).timeout(Duration::from_secs(10))
        };
        let mut res = req.send().await?;
        if !res.status().is_success() {
            return Err(HostError::Status(res.status()));
        }
        let is_image = res
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| ct.trim().to_ascii_lowercase().starts_with("image/"));
        if !is_image {
            return Err(HostError::Body("not an image".into()));
        }
        if res
            .content_length()
            .is_some_and(|l| l > MAX_ASSET_FETCH as u64)
        {
            return Err(HostError::Body("asset too large".into()));
        }
        let mut buf = Vec::new();
        while let Some(chunk) = res.chunk().await? {
            buf.extend_from_slice(&chunk);
            if buf.len() > MAX_ASSET_FETCH {
                return Err(HostError::Body("asset too large".into()));
            }
        }
        Ok(buf.into())
    }

    /// Opens an asset for streaming (attachment previews): signed like every callback when
    /// `signed`, never following redirects. The caller checks the origin, status and size.
    pub async fn open_asset(
        &self,
        host: &HostConfig,
        token: &str,
        url: Url,
        signed: bool,
    ) -> Result<reqwest::Response, HostError> {
        let req = if signed {
            Self::signed(&self.assets, host, token, Method::GET, url, Vec::new(), 30)
        } else {
            self.assets.get(url).timeout(Duration::from_secs(30))
        };
        Ok(req.send().await?)
    }

    /// `POST {callback_base}/mentions` (UX-02, docs/05 §5): a JSON body, signed like every
    /// callback, with an `Idempotency-Key` so a host can drop a retried call it already has.
    /// Returns the host's status; the caller decides between done, retry and give up.
    pub async fn post_mentions(
        &self,
        host: &HostConfig,
        token: &str,
        body: Vec<u8>,
        idempotency_key: &str,
    ) -> Result<StatusCode, HostError> {
        self.post_notification(host, &["mentions"], token, body, idempotency_key)
            .await
    }

    /// `POST {callback_base}/<path>` for outbox notifications (`mentions`, `ai/events`),
    /// signed like every callback.
    pub async fn post_notification(
        &self,
        host: &HostConfig,
        path: &[&str],
        token: &str,
        body: Vec<u8>,
        idempotency_key: &str,
    ) -> Result<StatusCode, HostError> {
        let started = std::time::Instant::now();
        let r = self
            .post_notification_once(host, path, token, body, idempotency_key)
            .await;
        let result = r.as_ref().map_or_else(err_class, |s| status_result(*s));
        self.record(host, "notify", result, started);
        r
    }

    async fn post_notification_once(
        &self,
        host: &HostConfig,
        path: &[&str],
        token: &str,
        body: Vec<u8>,
        idempotency_key: &str,
    ) -> Result<StatusCode, HostError> {
        let url = Self::url(host, path)?;
        let res = self
            .request(host, token, Method::POST, url, body, 5)
            .header(header::CONTENT_TYPE, "application/json")
            .header("Idempotency-Key", idempotency_key)
            .send()
            .await?;
        Ok(res.status())
    }

    /// `POST {callback_base}/access {fileId, userId}` (docs/05, docs/24 §7.3): the user's role
    /// on the file, for MCP calls that have no launch session. Signed like every callback; no
    /// bearer token (the client's MCP token is never passed through). `Ok(None)` when the host
    /// does not implement it (404, 405, 501); `Ok(Some(None))` for `role: "none"`.
    pub async fn access(
        &self,
        host: &HostConfig,
        file_id: &str,
        user_id: &str,
    ) -> Result<AccessAnswer, HostError> {
        Ok(self
            .access_detail(host, file_id, user_id)
            .await?
            .map(|d| d.role))
    }

    /// [`HostClient::access`] with the whole answer (LIVE-01): `Ok(None)` when the host does
    /// not implement `/access`. Cached [`ACCESS_TTL`] per (host, file, user).
    pub async fn access_detail(
        &self,
        host: &HostConfig,
        file_id: &str,
        user_id: &str,
    ) -> Result<Option<AccessDetail>, HostError> {
        let key = (host.id.clone(), file_id.to_string(), user_id.to_string());
        let cached = self.access_cache.lock().ok().and_then(|m| {
            m.get(&key)
                .filter(|(at, _)| at.elapsed() < ACCESS_TTL)
                .map(|(_, a)| a.clone())
        });
        if let Some(a) = cached {
            return Ok(a);
        }
        let started = std::time::Instant::now();
        let r = self.access_uncached(host, file_id, user_id).await;
        let result = r.as_ref().map_or_else(err_class, |_| "ok");
        self.record(host, "access", result, started);
        let a = r?;
        if let Ok(mut m) = self.access_cache.lock() {
            if m.len() > 50_000 {
                m.retain(|_, (at, _)| at.elapsed() < ACCESS_TTL);
            }
            m.insert(key, (std::time::Instant::now(), a.clone()));
        }
        Ok(a)
    }

    /// Drops cached `/access` answers for a file (one user, or everyone).
    pub fn forget_access(&self, host_id: &str, file_id: &str, user_id: Option<&str>) {
        if let Ok(mut m) = self.access_cache.lock() {
            m.retain(|(h, f, u), _| {
                !(h == host_id && f == file_id && user_id.is_none_or(|x| x == u))
            });
        }
    }

    async fn access_uncached(
        &self,
        host: &HostConfig,
        file_id: &str,
        user_id: &str,
    ) -> Result<Option<AccessDetail>, HostError> {
        let url = Self::url(host, &["access"])?;
        let body = serde_json::to_vec(&serde_json::json!({"fileId": file_id, "userId": user_id}))
            .map_err(|e| HostError::Body(e.to_string()))?;
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let sig = signature_header(host.signing_secret(), t, "POST", url.path(), &body);
        let res = self
            .http
            .post(url)
            .timeout(Duration::from_secs(5))
            .header("X-OpenCanvas-Signature", sig)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await?;
        let status = res.status();
        if matches!(
            status,
            StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED | StatusCode::NOT_IMPLEMENTED
        ) {
            return Ok(None);
        }
        if status == StatusCode::GONE {
            return Ok(Some(AccessDetail {
                gone: true,
                ..Default::default()
            }));
        }
        if !status.is_success() {
            return Err(HostError::Status(status));
        }
        let bytes = res.bytes().await?;
        if bytes.len() > 64 * 1024 {
            return Err(HostError::Body("access answer too large".into()));
        }
        let v: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|e| HostError::Body(e.to_string()))?;
        let role = match v["role"].as_str() {
            Some("none") => None,
            Some(r) => Some(
                crate::grant::Role::parse(r)
                    .ok_or_else(|| HostError::Body(format!("unknown role {r:?}")))?,
            ),
            None => return Err(HostError::Body("no role in the access answer".into())),
        };
        let text = |k: &str, max: usize| {
            v[k].as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty() && s.len() <= max)
                .map(String::from)
        };
        Ok(Some(AccessDetail {
            // Nothing of a file the person cannot open is kept (docs/27 §2.5).
            name: role.and(text("name", 512)),
            callback_token: role.and(text("callbackToken", 4096)),
            // Characters, not bytes (a path is shown, not parsed); no control characters.
            path: role.and(
                v["path"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| {
                        !s.is_empty()
                            && s.chars().count() <= 200
                            && !s.chars().any(char::is_control)
                    })
                    .map(String::from),
            ),
            gone: role.is_none() && v["gone"].as_bool() == Some(true),
            role,
        }))
    }

    /// `POST {callback_base}/files` (LIVE-01, docs/05 §5): asks the host to create the backing
    /// file of a new live block, `{name, parentFileId, kind: "ocanvas"}`, with the bearer of
    /// the person making it and an `Idempotency-Key`. The host picks the folder and ACL (by
    /// default the parent's). `Ok(None)` when the host does not implement it (404, 405, 501).
    pub async fn create_file(
        &self,
        host: &HostConfig,
        token: &str,
        name: &str,
        parent_file_id: &str,
        idempotency_key: &str,
    ) -> Result<Option<String>, HostError> {
        let started = std::time::Instant::now();
        let r = self
            .create_file_once(host, token, name, parent_file_id, idempotency_key)
            .await;
        let result = r.as_ref().map_or_else(err_class, |_| "ok");
        self.record(host, "create", result, started);
        r
    }

    async fn create_file_once(
        &self,
        host: &HostConfig,
        token: &str,
        name: &str,
        parent_file_id: &str,
        idempotency_key: &str,
    ) -> Result<Option<String>, HostError> {
        let url = Self::url(host, &["files"])?;
        let body = serde_json::to_vec(&serde_json::json!({
            "name": name, "parentFileId": parent_file_id, "kind": "ocanvas",
        }))
        .map_err(|e| HostError::Body(e.to_string()))?;
        let res = self
            .request(host, token, Method::POST, url, body, 10)
            .header(header::CONTENT_TYPE, "application/json")
            .header("Idempotency-Key", idempotency_key)
            .send()
            .await?;
        let status = res.status();
        if matches!(
            status,
            StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED | StatusCode::NOT_IMPLEMENTED
        ) {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(HostError::Status(status));
        }
        let bytes = res.bytes().await?;
        if bytes.len() > 64 * 1024 {
            return Err(HostError::Body("create answer too large".into()));
        }
        let v: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|e| HostError::Body(e.to_string()))?;
        match v["fileId"].as_str() {
            Some(id) if !id.is_empty() && id.len() <= 1024 => Ok(Some(id.to_string())),
            _ => Err(HostError::Body("create answer without fileId".into())),
        }
    }

    /// `GET {callback_base}/search?q=&scope=&cursor=&limit=&userId=` (SRCH-03, ADR-065): the
    /// host's own search, as the person searching (their callback token as bearer; `userId`
    /// is in the signed query, so a host can trust it without a token). Returns status and
    /// body (at most 1 MB); the caller interprets them. Waits at most `timeout_ms`.
    #[allow(clippy::too_many_arguments)]
    pub async fn search(
        &self,
        host: &HostConfig,
        token: &str,
        user_id: &str,
        q: &str,
        scope: Option<&str>,
        cursor: Option<&str>,
        limit: usize,
        timeout_ms: u64,
    ) -> Result<(StatusCode, Bytes), HostError> {
        let started = std::time::Instant::now();
        let r = async {
            let mut url = Self::url(host, &["search"])?;
            {
                let mut qp = url.query_pairs_mut();
                qp.append_pair("q", q);
                if let Some(s) = scope {
                    qp.append_pair("scope", s);
                }
                if let Some(c) = cursor {
                    qp.append_pair("cursor", c);
                }
                qp.append_pair("limit", &limit.to_string());
                qp.append_pair("userId", user_id);
            }
            let res = self
                .request(host, token, Method::GET, url, vec![], 30)
                .timeout(Duration::from_millis(timeout_ms))
                .header(header::ACCEPT, "application/json")
                .send()
                .await?;
            let status = res.status();
            let body = Self::capped(res, 1024 * 1024).await?;
            Ok((status, body))
        }
        .await;
        let result = r
            .as_ref()
            .map_or_else(err_class, |(s, _)| status_result(*s));
        self.record(host, "search", result, started);
        r
    }

    /// `GET {callback_base}/files/{fileId}/members?q=&limit=` (docs/21 revision 2): the people
    /// with access to this file, signed like every callback. Returns status and body.
    pub async fn members(
        &self,
        host: &HostConfig,
        token: &str,
        file_id: &str,
        q: &str,
        limit: usize,
    ) -> Result<(StatusCode, Bytes), HostError> {
        let started = std::time::Instant::now();
        let r = self.members_once(host, token, file_id, q, limit).await;
        let result = r
            .as_ref()
            .map_or_else(err_class, |(s, _)| status_result(*s));
        self.record(host, "members", result, started);
        r
    }

    async fn members_once(
        &self,
        host: &HostConfig,
        token: &str,
        file_id: &str,
        q: &str,
        limit: usize,
    ) -> Result<(StatusCode, Bytes), HostError> {
        let mut url = Self::url(host, &["files", file_id, "members"])?;
        url.query_pairs_mut()
            .append_pair("q", q)
            .append_pair("limit", &limit.to_string());
        let mut res = self
            .request(host, token, Method::GET, url, Vec::new(), 5)
            .send()
            .await?;
        let status = res.status();
        let mut buf = Vec::new();
        while let Some(chunk) = res.chunk().await? {
            buf.extend_from_slice(&chunk);
            if buf.len() > 4 * 1024 * 1024 {
                return Err(HostError::Body("members answer too large".into()));
            }
        }
        Ok((status, buf.into()))
    }

    /// `GET {callback_base}/templates` (TPL-01): the host's team templates, signed like every
    /// callback with the asking user's `callbackToken`. `Ok(None)` when the host does not
    /// implement it (404, 405, 410, 501).
    pub async fn templates(
        &self,
        host: &HostConfig,
        token: &str,
    ) -> Result<Option<serde_json::Value>, HostError> {
        let url = Self::url(host, &["templates"])?;
        let res = self
            .request(host, token, Method::GET, url, Vec::new(), 5)
            .send()
            .await?;
        let status = res.status();
        if matches!(
            status,
            StatusCode::NOT_FOUND
                | StatusCode::METHOD_NOT_ALLOWED
                | StatusCode::GONE
                | StatusCode::NOT_IMPLEMENTED
        ) {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(HostError::Status(status));
        }
        let buf = Self::capped(res, crate::team_templates::MAX_LIST_BYTES).await?;
        serde_json::from_slice(&buf)
            .map(Some)
            .map_err(|e| HostError::Body(e.to_string()))
    }

    /// `GET {callback_base}/templates/{id}` (TPL-01): the template file (`.ocanvas` or
    /// Markdown). `Ok(None)` on 404; `TooLarge` past the template limit.
    pub async fn template_file(
        &self,
        host: &HostConfig,
        token: &str,
        id: &str,
    ) -> Result<Option<Bytes>, HostError> {
        let url = Self::url(host, &["templates", id])?;
        let res = self
            .request(host, token, Method::GET, url, Vec::new(), 10)
            .send()
            .await?;
        match res.status() {
            StatusCode::NOT_FOUND | StatusCode::GONE => Ok(None),
            s if s.is_success() => Self::capped(res, crate::team_templates::MAX_TEMPLATE_BYTES)
                .await
                .map(Some),
            s => Err(HostError::Status(s)),
        }
    }

    /// Reads a body, refusing it once it is over `max` bytes.
    async fn capped(mut res: reqwest::Response, max: usize) -> Result<Bytes, HostError> {
        if res.content_length().is_some_and(|n| n as usize > max) {
            return Err(HostError::TooLarge);
        }
        let mut buf = Vec::new();
        while let Some(chunk) = res.chunk().await? {
            buf.extend_from_slice(&chunk);
            if buf.len() > max {
                return Err(HostError::TooLarge);
            }
        }
        Ok(buf.into())
    }

    async fn passthrough(res: reqwest::Response) -> Result<(StatusCode, String, Bytes), HostError> {
        let status = res.status();
        let ct = res
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/json")
            .to_string();
        Ok((status, ct, res.bytes().await?))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn signature_v2_binds_method_and_path() {
        // printf '%s' '1700000000.PUT./api/files/f1?x=1.{}' | openssl dgst -sha256 -hmac secret
        let h =
            super::signature_header(b"secret", 1_700_000_000, "PUT", "/api/files/f1?x=1", b"{}");
        assert!(h.starts_with(&super::signature(b"secret", 1_700_000_000, b"{}")));
        assert!(
            h.ends_with(",v2=d421c3606ac13be99a16e3c716001ec87107a3ce89c81946403e02371e9c52a7"),
            "{h}"
        );
        let other =
            super::signature_header(b"secret", 1_700_000_000, "GET", "/api/files/f2", b"{}");
        assert_ne!(
            h.rsplit_once("v2=").unwrap().1,
            other.rsplit_once("v2=").unwrap().1
        );
    }

    /// Some hosts never see `Authorization` (Mattermost strips it before a plugin's
    /// `ServeHTTP`), so the callback token also travels in `X-OpenCanvas-Callback-Token`.
    #[test]
    fn callback_token_also_sent_in_its_own_header() {
        let host: crate::hosts::HostConfig = toml::from_str(
            "id = \"h\"\nname = \"H\"\njwt_secret = \"s\"\ncallback_base = \"https://h.example/cb\"",
        )
        .unwrap();
        let req = super::HostClient::signed(
            &reqwest::Client::new(),
            &host,
            "tok-1",
            reqwest::Method::PUT,
            "https://h.example/cb/files/f1".parse().unwrap(),
            b"{}".to_vec(),
            5,
        )
        .build()
        .unwrap();
        assert_eq!(req.headers()["authorization"], "Bearer tok-1");
        assert_eq!(req.headers()["x-opencanvas-callback-token"], "tok-1");
        // Signature unchanged: the header is not part of what v1/v2 sign.
        assert!(req.headers().contains_key("x-opencanvas-signature"));
    }

    #[test]
    fn signature_matches_reference() {
        // echo -n '1700000000.{}' | openssl dgst -sha256 -hmac secret
        let sig = super::signature(b"secret", 1_700_000_000, b"{}");
        assert_eq!(
            sig,
            "t=1700000000,v1=b8569b78799ff9e3cbff0fc2d63a33a2b57f3282abd07c37ae5e8e7d79a5f163"
        );
    }
}
