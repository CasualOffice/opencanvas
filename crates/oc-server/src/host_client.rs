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
    Http(#[from] reqwest::Error),
    #[error("host answered {0}")]
    Status(StatusCode),
    #[error("bad callback url")]
    Url,
    #[error("unexpected host answer: {0}")]
    Body(String),
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
    http: reqwest::Client,
    /// For asset downloads and every WOPI call: never follows redirects (an allowed URL must
    /// not bounce elsewhere, and a WOPI redirect would carry the access token away).
    assets: reqwest::Client,
    /// WOPI mode: assets inlined into saved files come from here.
    store: Option<Store>,
    /// WOPI mode: `BaseFileName` per `WOPISrc` (decides `.md` vs `.ocanvas` on save).
    wopi_names: Arc<Mutex<HashMap<String, String>>>,
}

/// Largest image fetched for an export.
pub const MAX_ASSET_FETCH: usize = 10 * 1024 * 1024;

pub fn signature(secret: &[u8], t: i64, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("hmac accepts any key length");
    mac.update(format!("{t}.").as_bytes());
    mac.update(body);
    format!("t={t},v1={}", hex::encode(mac.finalize().into_bytes()))
}

fn unquote(etag: &str) -> String {
    etag.trim()
        .trim_start_matches("W/")
        .trim_matches('"')
        .to_string()
}

impl Default for HostClient {
    fn default() -> Self {
        Self::new()
    }
}

impl HostClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
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
        }
    }

    /// Gives the client the store WOPI-mode assets live in.
    pub fn with_store(mut self, store: Store) -> Self {
        self.store = Some(store);
        self
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
        match wopi::check_file_info(&self.assets, src, token).await {
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
        let info = wopi::check_file_info(&self.assets, src, token).await?;
        self.remember_wopi_name(src, &info.base_file_name);
        let (bytes, content_type) = wopi::get_contents(&self.assets, src, token).await?;
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
        match wopi::put_contents(&self.assets, src, token, body, req.if_match).await? {
            wopi::PutResult::Conflict => Ok(PutOutcome::Conflict),
            wopi::PutResult::Saved(Some(stamp)) => Ok(PutOutcome::Saved {
                version: Some(stamp),
            }),
            // No LastModifiedTime in the answer: ask for it, so the next save is checked.
            wopi::PutResult::Saved(None) => {
                let version = wopi::check_file_info(&self.assets, src, token)
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
        wopi::put_relative(&self.assets, src, token, body, &wopi::copy_name(&name)).await
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
        client
            .request(method, url)
            .timeout(Duration::from_secs(timeout))
            .bearer_auth(token)
            .header(
                "X-OpenCanvas-Signature",
                signature(host.signing_secret(), t, &body),
            )
            .body(body)
    }

    pub async fn get_file(
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
        if let SaveTarget::Wopi(src) = SaveTarget::of(host, req.file_id)? {
            return self.wopi_put(host, &src, token, req).await;
        }
        let url = Self::url(host, &["files", req.file_id])?;
        let mut rb = self
            .request(host, token, Method::PUT, url, req.body, 10)
            .header(header::CONTENT_TYPE, "application/vnd.opencanvas+zip")
            .header("Idempotency-Key", req.idempotency_key)
            .header("X-OpenCanvas-Autosave", "1")
            .header(
                "X-OpenCanvas-Authors",
                serde_json::to_string(req.authors).unwrap_or_else(|_| "[]".into()),
            );
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

    pub async fn users(
        &self,
        host: &HostConfig,
        token: &str,
        file_id: &str,
        q: &str,
    ) -> Result<(StatusCode, String, Bytes), HostError> {
        let mut url = Self::url(host, &["users"])?;
        url.query_pairs_mut()
            .append_pair("q", q)
            .append_pair("fileId", file_id);
        let res = self
            .request(host, token, Method::GET, url, Vec::new(), 5)
            .send()
            .await?;
        Self::passthrough(res).await
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
    fn signature_matches_reference() {
        // echo -n '1700000000.{}' | openssl dgst -sha256 -hmac secret
        let sig = super::signature(b"secret", 1_700_000_000, b"{}");
        assert_eq!(
            sig,
            "t=1700000000,v1=b8569b78799ff9e3cbff0fc2d63a33a2b57f3282abd07c37ae5e8e7d79a5f163"
        );
    }
}
