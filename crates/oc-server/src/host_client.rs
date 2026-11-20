//! Calls from OpenCanvas to the host (docs/15 §5): signed with HMAC, bearer callback token.

use std::time::Duration;

use bytes::Bytes;
use hmac::{Hmac, Mac};
use reqwest::{Method, StatusCode, Url, header};
use sha2::Sha256;

use crate::hosts::HostConfig;

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("host unreachable: {0}")]
    Http(#[from] reqwest::Error),
    #[error("host answered {0}")]
    Status(StatusCode),
    #[error("bad callback url")]
    Url,
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

#[derive(Clone)]
pub struct HostClient {
    http: reqwest::Client,
}

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
        Self { http }
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
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.http
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
