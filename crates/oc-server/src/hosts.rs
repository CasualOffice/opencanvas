//! Static host registry from `opencanvas.hosts.toml` (docs/05 §2).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, bail};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct HostConfig {
    pub id: String,
    pub name: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_alg")]
    pub jwt_alg: String,
    /// HS256 secret; also the HMAC key for callback signatures unless `callback_secret` is set.
    #[serde(default)]
    pub jwt_secret: Option<String>,
    /// PEM public key for RS256 / EdDSA.
    #[serde(default)]
    pub jwt_public_key: Option<String>,
    /// JWKS endpoint for RS256 / EdDSA keys (fetched and cached 10 min, matched by `kid`).
    #[serde(default)]
    pub jwt_jwks_url: Option<String>,
    #[serde(default)]
    pub callback_secret: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    pub callback_base: String,
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    /// Origins exports may fetch images from (e.g. a CDN), besides the `callback_base` origin,
    /// which is always allowed. Requests to these extra origins are not signed and carry no
    /// callback token.
    #[serde(default)]
    pub asset_origins: Vec<String>,
    /// The configured `callback_base` when `OC_CALLBACK_BASE_OVERRIDE` replaced it: images on
    /// its origin are still accepted, and fetched through the override.
    #[serde(skip)]
    pub original_callback_base: Option<String>,
    #[serde(default)]
    pub flags: toml::Table,
}

fn default_mode() -> String {
    "jwt".into()
}
fn default_alg() -> String {
    "HS256".into()
}

/// What happens when the host answers a save with 409 (docs/05 §2, `on_conflict`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictPolicy {
    /// Save the session's version as a new file (`POST /files/{id}/copies`), go read-only.
    Copy,
    /// Drop the session's changes and reopen the host's version.
    Reload,
}

impl HostConfig {
    /// `[host.flags] on_conflict = "copy" | "reload"`; default copy.
    pub fn on_conflict(&self) -> ConflictPolicy {
        match self.flags.get("on_conflict").and_then(|v| v.as_str()) {
            Some("reload") => ConflictPolicy::Reload,
            _ => ConflictPolicy::Copy,
        }
    }

    pub fn signing_secret(&self) -> &[u8] {
        self.callback_secret
            .as_deref()
            .or(self.jwt_secret.as_deref())
            .unwrap_or_default()
            .as_bytes()
    }
}

#[derive(Deserialize)]
struct HostsFile {
    #[serde(default)]
    host: Vec<HostConfig>,
}

/// Resolves `env:NAME` and `file:/path` indirections for secrets.
fn resolve(value: Option<String>) -> anyhow::Result<Option<String>> {
    let Some(v) = value else { return Ok(None) };
    if let Some(name) = v.strip_prefix("env:") {
        return std::env::var(name)
            .map(Some)
            .with_context(|| format!("env var {name} not set"));
    }
    if let Some(path) = v.strip_prefix("file:") {
        return std::fs::read_to_string(path)
            .map(Some)
            .with_context(|| format!("cannot read {path}"));
    }
    Ok(Some(v))
}

#[derive(Debug, Clone, Default)]
pub struct Hosts(HashMap<String, Arc<HostConfig>>);

impl Hosts {
    pub fn from_list(list: Vec<HostConfig>) -> Self {
        Self(
            list.into_iter()
                .map(|h| (h.id.clone(), Arc::new(h)))
                .collect(),
        )
    }

    pub fn parse(src: &str, callback_override: Option<&str>) -> anyhow::Result<Self> {
        let file: HostsFile = toml::from_str(src).context("invalid hosts file")?;
        let mut list = Vec::new();
        for mut h in file.host {
            h.jwt_secret = resolve(h.jwt_secret)?;
            h.jwt_public_key = resolve(h.jwt_public_key)?;
            h.callback_secret = resolve(h.callback_secret)?;
            h.api_key = resolve(h.api_key)?;
            h.jwt_jwks_url = resolve(h.jwt_jwks_url)?;
            match h.jwt_alg.as_str() {
                "HS256" if h.jwt_secret.is_none() => {
                    bail!("host {}: HS256 requires jwt_secret", h.id)
                }
                "RS256" | "EdDSA" if h.jwt_public_key.is_none() && h.jwt_jwks_url.is_none() => {
                    bail!(
                        "host {}: {} requires jwt_public_key (PEM) or jwt_jwks_url",
                        h.id,
                        h.jwt_alg
                    )
                }
                "HS256" | "RS256" | "EdDSA" => {}
                other => bail!("host {}: unsupported jwt_alg {other}", h.id),
            }
            if let Some(base) = callback_override {
                tracing::warn!(host = %h.id, "OC_CALLBACK_BASE_OVERRIDE replaces callback_base (dev/compose only)");
                h.original_callback_base = Some(h.callback_base.trim_end_matches('/').to_string());
                h.callback_base = base.to_string();
            }
            h.callback_base = h.callback_base.trim_end_matches('/').to_string();
            list.push(h);
        }
        Ok(Self::from_list(list))
    }

    pub fn load(path: &Path, callback_override: Option<&str>) -> anyhow::Result<Self> {
        if !path.exists() {
            tracing::warn!(path = %path.display(), "hosts file not found; no host can launch");
            return Ok(Self::default());
        }
        let src =
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        Self::parse(&src, callback_override)
    }

    pub fn get(&self, id: &str) -> Option<Arc<HostConfig>> {
        self.0.get(id).cloned()
    }

    pub fn allowed_origins(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .0
            .values()
            .flat_map(|h| h.allowed_origins.iter().cloned())
            .collect();
        v.sort();
        v.dedup();
        v
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_overrides_callback_base() {
        let src = r#"
            [[host]]
            id = "sample"
            name = "Sample"
            jwt_secret = "s3cret"
            callback_base = "http://localhost:4000/api/opencanvas/"
            allowed_origins = ["http://localhost:4000"]
        "#;
        let hosts = Hosts::parse(src, None).unwrap();
        assert_eq!(
            hosts.get("sample").unwrap().callback_base,
            "http://localhost:4000/api/opencanvas"
        );
        assert_eq!(hosts.get("sample").unwrap().original_callback_base, None);
        let hosts = Hosts::parse(src, Some("http://sample-host:4000/api/opencanvas")).unwrap();
        let h = hosts.get("sample").unwrap();
        assert_eq!(h.callback_base, "http://sample-host:4000/api/opencanvas");
        assert_eq!(
            h.original_callback_base.as_deref(),
            Some("http://localhost:4000/api/opencanvas")
        );
    }
}
