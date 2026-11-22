//! Static host registry from `opencanvas.hosts.toml` (docs/05 §2).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, bail};
use serde::Deserialize;

/// What `POST /v1/import` reads (docs/23 FC-10).
pub const IMPORT_FORMATS: [&str; 3] = ["md", "html", "csv"];

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
    /// JWT-mode callback base; unused (may be empty) for `mode = "wopi"`.
    #[serde(default)]
    pub callback_base: String,
    /// WOPI mode: the only places a `WOPISrc` may point to, as `scheme://host[:port][/path]`
    /// prefixes (docs/05 §6). Anything else is refused before we call it (SSRF guard).
    #[serde(default)]
    pub wopi_allowlist: Vec<String>,
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
    /// `[host.ai]` (docs/24 §7.3): AI and MCP settings (agent and MCP); read through `crate::ai::HostAi`.
    #[serde(default)]
    pub ai: toml::Table,
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
    /// `mode = "wopi"`: launches only through WOPI (CheckFileInfo), never a JWT.
    pub fn wopi_only(&self) -> bool {
        self.mode == "wopi"
    }

    /// `mode = "wopi" | "both"`.
    pub fn accepts_wopi(&self) -> bool {
        matches!(self.mode.as_str(), "wopi" | "both")
    }

    /// `[host.flags] export_formats = ["md", "html", …]`: the formats this host allows (`md`,
    /// `html`, `json`, `docx`, `pdf`, `ocanvas`, and `svg` / `png` for board images). Absent
    /// means every format; the session's perms still apply on top (docs/05 §2).
    pub fn export_allowed(&self, format: &str) -> bool {
        match self.flags.get("export_formats").and_then(|v| v.as_array()) {
            Some(list) => list.iter().any(|v| v.as_str() == Some(format)),
            None => true,
        }
    }

    /// `[host.flags] import_formats = ["md", "html", "csv"]`: the formats this host lets
    /// editors import (docs/05 §2, docs/23 FC-10). Absent or empty means import is off.
    pub fn import_formats(&self) -> Vec<String> {
        self.flags
            .get("import_formats")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .filter(|f| IMPORT_FORMATS.contains(f))
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default()
    }

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
            // Room ids hash `<hostId>:<fileId>`; a `:` (or anything odd) in a host id could
            // make two tenants share a room (SEC-10).
            if h.id.is_empty()
                || h.id.len() > 64
                || !h
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
            {
                bail!("host id {:?} must be 1-64 chars of [A-Za-z0-9._-]", h.id);
            }
            if let Some(v) = h.flags.get("import_formats") {
                let ok = v.as_array().is_some_and(|a| {
                    a.iter()
                        .all(|f| f.as_str().is_some_and(|f| IMPORT_FORMATS.contains(&f)))
                });
                if !ok {
                    bail!(
                        "host {}: [host.flags] import_formats takes a list of {:?}",
                        h.id,
                        IMPORT_FORMATS
                    );
                }
            }
            h.jwt_secret = resolve(h.jwt_secret)?;
            h.jwt_public_key = resolve(h.jwt_public_key)?;
            h.callback_secret = resolve(h.callback_secret)?;
            h.api_key = resolve(h.api_key)?;
            h.jwt_jwks_url = resolve(h.jwt_jwks_url)?;
            match h.mode.as_str() {
                "jwt" | "both" | "wopi" => {}
                other => bail!("host {}: unknown mode {other} (jwt | wopi | both)", h.id),
            }
            if h.accepts_wopi() {
                if h.wopi_allowlist.is_empty() {
                    bail!("host {}: mode {} requires wopi_allowlist", h.id, h.mode);
                }
                for entry in &h.wopi_allowlist {
                    crate::wopi::AllowEntry::parse(entry).with_context(|| {
                        format!("host {}: bad wopi_allowlist entry {entry:?}", h.id)
                    })?;
                }
            }
            if h.wopi_only() {
                h.callback_base = h.callback_base.trim_end_matches('/').to_string();
                list.push(h);
                continue;
            }
            if h.callback_base.is_empty() {
                bail!(
                    "host {}: callback_base is required for mode {}",
                    h.id,
                    h.mode
                );
            }
            for (what, secret) in [
                ("jwt_secret", &h.jwt_secret),
                ("callback_secret", &h.callback_secret),
                ("api_key", &h.api_key),
            ] {
                if secret.as_deref().is_some_and(|s| s.len() < 32) {
                    tracing::warn!(host = %h.id, "{what} is shorter than 32 characters; use a long random value");
                }
            }
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

    /// The WOPI-capable host whose `wopi_allowlist` admits `src`, with the normalized URL.
    /// Hosts are tried in id order so the choice is stable.
    pub fn wopi_host_for(&self, src: &str) -> Option<(Arc<HostConfig>, reqwest::Url)> {
        let mut hosts: Vec<_> = self.0.values().filter(|h| h.accepts_wopi()).collect();
        hosts.sort_by(|a, b| a.id.cmp(&b.id));
        hosts
            .into_iter()
            .find_map(|h| crate::wopi::check_src(&h.wopi_allowlist, src).map(|u| (h.clone(), u)))
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

    /// SEC-10: room ids hash `<hostId>:<fileId>`, so host `a:b` + file `c` and host `a` +
    /// file `b:c` shared a room. Host ids are restricted to `[A-Za-z0-9._-]`.
    #[test]
    fn host_ids_cannot_contain_separators() {
        let src = |id: &str| {
            format!(
                "[[host]]\nid = \"{id}\"\nname = \"N\"\njwt_secret = \"0123456789abcdef0123456789abcdef\"\ncallback_base = \"http://h/api\"\n"
            )
        };
        assert!(Hosts::parse(&src("acme-prod_1.eu"), None).is_ok());
        for bad in ["a:b", "a b", "", "a/b", "ä"] {
            assert!(Hosts::parse(&src(bad), None).is_err(), "{bad:?}");
        }
    }

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

    #[test]
    fn wopi_hosts_need_an_allowlist_but_no_jwt_key() {
        let ok = r#"
            [[host]]
            id = "wopi-sample"
            name = "WOPI sample"
            mode = "wopi"
            wopi_allowlist = ["http://localhost:4300"]
        "#;
        let hosts = Hosts::parse(ok, None).unwrap();
        assert!(hosts.get("wopi-sample").unwrap().wopi_only());
        assert!(
            hosts
                .wopi_host_for("http://localhost:4300/wopi/files/a")
                .is_some()
        );
        assert!(
            hosts
                .wopi_host_for("http://localhost:4301/wopi/files/a")
                .is_none()
        );
        let missing = ok.replace("wopi_allowlist = [\"http://localhost:4300\"]", "");
        assert!(Hosts::parse(&missing, None).is_err());
        let bad_mode = ok.replace("mode = \"wopi\"", "mode = \"wopy\"");
        assert!(Hosts::parse(&bad_mode, None).is_err());
    }
}
