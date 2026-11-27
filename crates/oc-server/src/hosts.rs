// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Static host registry from `opencanvas.hosts.toml` (docs/05 §2).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, bail};
use serde::Deserialize;

/// Prefix of `template_bytes` that holds a built-in template's document JSON (not a file).
pub const TEMPLATE_JSON_TAG: &[u8] = b"\0oc-template-json\0";

/// What `POST /v1/import` reads (docs/23 FC-10).
pub const IMPORT_FORMATS: [&str; 5] = ["md", "html", "csv", "drawio", "excalidraw"];

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
    /// Extra origins that may frame **this host's** editor (CSP `frame-ancestors`), on top of
    /// every host's `allowed_origins`. Unlike `allowed_origins` they are not server-wide: the
    /// launch then redirects to `/app/?h=<host id>` and only that page carries them. For hosts
    /// whose editor is nested in pages of many origins (a Matrix widget inside any client).
    /// Empty (default): today's behaviour.
    #[serde(default)]
    pub frame_ancestors: Vec<String>,
    /// Origins exports may fetch images from (e.g. a CDN), besides the `callback_base` origin,
    /// which is always allowed. Requests to these extra origins are not signed and carry no
    /// callback token.
    #[serde(default)]
    pub asset_origins: Vec<String>,
    /// The configured `callback_base` when `OC_CALLBACK_BASE_OVERRIDE` replaced it: images on
    /// its origin are still accepted, and fetched through the override.
    #[serde(skip)]
    pub original_callback_base: Option<String>,
    /// `"host"` (default): the host loads and saves the file (ADR-001). `"ephemeral"`
    /// (ADR-043): no load, no save, the canvas is destroyed when its room closes.
    #[serde(default = "default_storage")]
    pub storage: String,
    /// Ephemeral storage: what every new canvas starts from. A built-in template id
    /// (`"meeting"`, `"standup"`, …) or the path of an `.ocanvas` or Markdown file. Unset: blank.
    #[serde(default)]
    pub template: Option<String>,
    /// The bytes of `template`, read once at startup.
    #[serde(skip)]
    pub template_bytes: Option<Arc<Vec<u8>>>,
    #[serde(default)]
    pub flags: toml::Table,
    /// `[host.versions]` (docs/05 §2, docs/30 §13, ADR-055): in-file history and which source of
    /// versions comes first.
    #[serde(default)]
    pub versions: toml::Table,
    /// `[host.ai]` (docs/24 §7.3): AI and MCP settings (agent and MCP); read through `crate::ai::HostAi`.
    #[serde(default)]
    pub ai: toml::Table,
    /// `[host.api]` (docs/27 §4, ADR-041): headless API v1 settings (token audience and
    /// issuer, default write mode, admin scope for tokens, rate limits).
    #[serde(default)]
    pub api: toml::Table,
    /// `[host.webhooks]` (WH-01, ADR-056): `url`, `events`, `secret`, `max_attempts`; read
    /// through `crate::webhooks::WebhookCfg`.
    #[serde(default)]
    pub webhooks: toml::Table,
    /// `[host.blocks]` (BSDK-01, docs/05 §2): `enabled = ["acme.okr@^1"]`, the installed SDK
    /// block packages this host's editors may load; read through `crate::blocks::HostBlocks`.
    #[serde(default)]
    pub blocks: toml::Table,
    /// `[host.editor]` (EDP-01, docs/05 §2b, ADR-061): the editor profile, its block list and
    /// feature switches; read through [`HostConfig::editor`].
    #[serde(default)]
    pub editor: toml::Table,
    /// `[host.live]` (LIVE-01, docs/05 §2c, docs/27 §2.5): the snapshot policy, the source link
    /// and the open live block limit; read through [`crate::live::LiveCfg`]. The feature itself
    /// is `[host.flags] live_blocks`.
    #[serde(default)]
    pub live: toml::Table,
    /// `[host.search]` (SRCH-02/03, ADR-065, docs/05 §2): `callback`, `comments`,
    /// `timeout_ms`; read through [`HostConfig::search`].
    #[serde(default)]
    pub search: toml::Table,
    /// `[host.automation]` (AUTO-01..05, ADR-067/068, docs/05 §2): read through
    /// `crate::automation::AutomationCfg`.
    #[serde(default)]
    pub automation: toml::Table,
    /// `[host.offline]` (OFF-01, ADR-063, docs/05 §2): offline copies on the person's device;
    /// read through [`crate::offline::OfflineCfg`].
    #[serde(default)]
    pub offline: toml::Table,
}

fn default_mode() -> String {
    "jwt".into()
}
fn default_storage() -> String {
    "host".into()
}
fn default_alg() -> String {
    "HS256".into()
}

/// `[host.versions]` bounds of in-file history (ADR-055).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileHistoryLimits {
    pub max_bytes: usize,
    pub max_versions: usize,
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
    /// `[host.editor]` parsed (EDP-01). Checked by `Hosts::parse` at start-up, so this cannot
    /// fail later; a host built in code without the check falls back to `full`.
    /// `[host.search]`, checked at start-up (defaults when absent or broken).
    pub fn search(&self) -> crate::search::SearchCfg {
        crate::search::SearchCfg::parse(&self.search).unwrap_or_default()
    }

    pub fn editor(&self) -> crate::editor::EditorCfg {
        crate::editor::EditorCfg::parse(&self.editor, &crate::editor::sdk_types(&self.blocks))
            .unwrap_or_default()
    }

    /// `[host.editor.features] version_history` (default on): off hides the history menu and
    /// answers every history route `404 HISTORY_OFF`. The file's own history is kept as it is.
    pub fn version_history_on(&self) -> bool {
        self.editor().features.version_history != Some(false)
    }

    /// `[host.editor.features] comments` (default on).
    pub fn comments_on(&self) -> bool {
        self.editor().features.comments != Some(false)
    }

    /// `[host.flags] history = true`: the JWT host implements the version callbacks (docs/30 §3).
    pub fn host_history(&self) -> bool {
        !self.ephemeral() && self.flags.get("history").and_then(|v| v.as_bool()) == Some(true)
    }

    /// `[host.flags] history_url`: a link to the host's own version page, `{fileId}` replaced
    /// (percent-encoded). http(s) only.
    pub fn history_url(&self, file_id: &str) -> Option<String> {
        let t = self.flags.get("history_url")?.as_str()?;
        let u = t.replace("{fileId}", &crate::host_client::percent_encode(file_id));
        (u.starts_with("https://") || u.starts_with("http://")).then_some(u)
    }

    /// In-file bounded history (ADR-055): `[host.versions] file`, default on for JWT hosts and
    /// off for WOPI-only hosts; never for temporary canvases. `None` when off.
    pub fn file_history(&self) -> Option<FileHistoryLimits> {
        if self.ephemeral() {
            return None;
        }
        let on = self
            .versions
            .get("file")
            .and_then(|v| v.as_bool())
            .unwrap_or(!self.wopi_only());
        let int = |k: &str, d: i64, lo: i64, hi: i64| {
            self.versions
                .get(k)
                .and_then(|v| v.as_integer())
                .unwrap_or(d)
                .clamp(lo, hi)
        };
        on.then(|| FileHistoryLimits {
            max_bytes: int("file_max_kb", 1024, 16, 8192) as usize * 1024,
            max_versions: int("file_max_versions", 50, 1, 500) as usize,
        })
    }

    /// `[host.versions] prefer_host` (default true): when the host keeps versions too, its list
    /// comes first and in-file history is "recent changes".
    pub fn prefer_host_versions(&self) -> bool {
        self.versions
            .get("prefer_host")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    /// `storage = "ephemeral"` (ADR-043): canvases live only while their room is open.
    pub fn ephemeral(&self) -> bool {
        self.storage == "ephemeral"
    }

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
        // EDP-01: `[host.editor.features] import` wins over the flag (true without a list: all).
        match self.editor().features.import {
            Some(false) => return vec![],
            Some(true) if !self.flags.contains_key("import_formats") => {
                return IMPORT_FORMATS.iter().map(|f| f.to_string()).collect();
            }
            _ => {}
        }
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

    /// `[host.flags] unfurl = true | false`: link cards fetch title, description and image
    /// through the server (UNF-01). Absent means on; `OC_UNFURL=off` wins.
    pub fn unfurl_enabled(&self) -> bool {
        self.flags
            .get("unfurl")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    /// `[host.flags] team_templates = true` (TPL-01, docs/05 §5): the gallery's "From your
    /// team" section lists the host's `GET /templates`. Off by default; needs a
    /// `callback_base` and JWT callbacks (not `mode = "wopi"`).
    pub fn team_templates(&self) -> bool {
        self.flags.get("team_templates").and_then(|v| v.as_bool()) == Some(true)
            && self.editor().features.templates != Some(false)
            && !self.callback_base.is_empty()
            && !self.wopi_only()
    }

    /// `[host.flags] temporary_wording = "meeting" | "room"` (ADR-049): how the editor talks
    /// about a temporary canvas. Default "meeting" (a meeting app such as Jitsi); "room" for a
    /// chat room (the Matrix widget).
    pub fn temporary_wording(&self) -> &'static str {
        match self.flags.get("temporary_wording").and_then(|v| v.as_str()) {
            Some("room") => "room",
            _ => "meeting",
        }
    }

    /// `[host.flags] api_v1` (docs/27 §5): the headless API under `/api/v1` answers for this
    /// host. On by default from 0.2.0; `api_v1 = false` turns it off. The 0.1 host routes work
    /// either way. Every call still needs the host key or a token the host signed.
    pub fn api_v1(&self) -> bool {
        self.flags.get("api_v1").and_then(|v| v.as_bool()) != Some(false)
    }

    /// `[host.flags] live_blocks` (LIVE-01, docs/27 §5): portable live blocks. Off by default in
    /// 0.3.0-alpha.
    pub fn live_blocks(&self) -> bool {
        self.flags.get("live_blocks").and_then(|v| v.as_bool()) == Some(true)
    }

    /// `[host.flags] partial_sync` (PSYNC-02/03, ADR-076, docs/05 §2): rooms keep databases and
    /// boards as on-demand subdocuments by default. Set `partial_sync = false` for clients
    /// without `caps=subdoc`, which receive close code 4426 in split rooms.
    pub fn partial_sync(&self) -> bool {
        self.flags.get("partial_sync").and_then(|v| v.as_bool()) != Some(false)
    }

    /// `[host.flags] formulas` (DB4-03..06, ADR-078, docs/05 §2): formula, relation and rollup
    /// fields can be added in the editor. Off by default; existing ones always compute.
    pub fn formulas(&self) -> bool {
        self.flags.get("formulas").and_then(|v| v.as_bool()) == Some(true)
    }

    /// `[host.api] default_mode = "direct" | "suggest"`: where API writes to existing blocks
    /// land when the call does not say. Default `direct` (a program asked for the change).
    pub fn api_default_mode(&self) -> crate::ai::tools::WriteMode {
        match self.api.get("default_mode").and_then(|v| v.as_str()) {
            Some("suggest") => crate::ai::tools::WriteMode::Suggest,
            _ => crate::ai::tools::WriteMode::Direct,
        }
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
            if h.flags
                .get("temporary_wording")
                .is_some_and(|v| !matches!(v.as_str(), Some("meeting" | "room")))
            {
                bail!(
                    "host {}: [host.flags] temporary_wording takes \"meeting\" or \"room\"",
                    h.id
                );
            }
            if h.flags.get("api_v1").is_some_and(|v| v.as_bool().is_none()) {
                bail!("host {}: [host.flags] api_v1 takes true or false", h.id);
            }
            crate::search::SearchCfg::parse(&h.search).with_context(|| format!("host {}", h.id))?;
            crate::offline::check_host(&h).with_context(|| format!("host {}", h.id))?;
            crate::automation::AutomationCfg::parse(&h.automation)
                .with_context(|| format!("host {}", h.id))?;
            crate::blocks::HostBlocks::parse(&h.blocks)
                .with_context(|| format!("host {}", h.id))?;
            crate::editor::EditorCfg::parse(&h.editor, &crate::editor::sdk_types(&h.blocks))
                .with_context(|| format!("host {}", h.id))?;
            crate::live::check_host(&h).with_context(|| format!("host {}", h.id))?;
            if h.flags.get("unfurl").is_some_and(|v| v.as_bool().is_none()) {
                bail!("host {}: [host.flags] unfurl takes true or false", h.id);
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
            match h.storage.as_str() {
                "host" => {
                    if h.template.is_some() {
                        bail!("host {}: template needs storage = \"ephemeral\"", h.id);
                    }
                }
                "ephemeral" => {
                    if h.mode != "jwt" {
                        bail!(
                            "host {}: storage = \"ephemeral\" needs mode = \"jwt\"",
                            h.id
                        );
                    }
                    if let Some(t) = &h.template {
                        let bytes = if let Some(json) = oc_model::templates::builtin(t) {
                            let mut b = TEMPLATE_JSON_TAG.to_vec();
                            b.extend(serde_json::to_vec(json)?);
                            b
                        } else if t.contains('/') || t.contains('.') {
                            std::fs::read(t).with_context(|| {
                                format!("host {}: cannot read template {t}", h.id)
                            })?
                        } else {
                            bail!(
                                "host {}: unknown template {t:?} (a file path or one of: {})",
                                h.id,
                                oc_model::templates::ids().join(", ")
                            );
                        };
                        h.template_bytes = Some(Arc::new(bytes));
                    }
                }
                other => bail!("host {}: unknown storage {other} (host | ephemeral)", h.id),
            }
            if let Some(toml::Value::String(s)) = h.webhooks.get("secret").cloned() {
                let s = resolve(Some(s))?.unwrap_or_default();
                h.webhooks.insert("secret".into(), toml::Value::String(s));
            }
            if h.wopi_only() {
                h.callback_base = h.callback_base.trim_end_matches('/').to_string();
                crate::webhooks::WebhookCfg::of(&h).with_context(|| format!("host {}", h.id))?;
                list.push(h);
                continue;
            }
            if h.callback_base.is_empty() && !h.ephemeral() {
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
            if let Some(base) = callback_override.filter(|_| !h.callback_base.is_empty()) {
                tracing::warn!(host = %h.id, "OC_CALLBACK_BASE_OVERRIDE replaces callback_base (dev/compose only)");
                h.original_callback_base = Some(h.callback_base.trim_end_matches('/').to_string());
                h.callback_base = base.to_string();
            }
            h.callback_base = h.callback_base.trim_end_matches('/').to_string();
            crate::webhooks::WebhookCfg::of(&h).with_context(|| format!("host {}", h.id))?;
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

    pub fn iter(&self) -> impl Iterator<Item = &Arc<HostConfig>> {
        self.0.values()
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
