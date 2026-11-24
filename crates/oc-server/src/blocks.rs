// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! SDK block packages (BSDK-01, BSDK-03; docs/27 §3.3-3.4, docs/05 §2a).
//!
//! The operator installs packages in `OC_BLOCKS_DIR` (one directory per package with a
//! `block.json`); hosts enable them with `[host.blocks] enabled = ["acme.okr@^1"]` and may
//! narrow their permissions with `[host.blocks.permissions."acme.okr"]`. At start every
//! manifest is parsed and checked (`oc_model::ext::Manifest`), its bundle's SRI hash
//! (`integrity`, sha384) is verified, and the package's files (bundle, `preview.png`,
//! migrations script) are read into memory. A package that fails is refused, logged and listed
//! on `/healthz`; the server still starts, and documents using its type keep it as an unknown
//! block (shown as its fallback).
//!
//! Bundles run in a sandboxed iframe served from the separate block origin
//! `OC_BLOCKS_ORIGIN` ([`frame`], [`file`]): the frame document inlines the runtime
//! (`assets/block-frame.js`) and loads the bundle with SRI, under a CSP built from the block's
//! effective permissions (manifest ∩ host). Without a block origin no block code runs; editors
//! show every SDK block as its read-only fallback.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use anyhow::{Context, bail};
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use oc_model::ext::{Manifest, Registry, manifest::safe_rel_path, migrate::Migrations};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha384};

use crate::SharedState;

/// Most packages read from `OC_BLOCKS_DIR`.
const MAX_PACKAGES: usize = 200;
/// Largest bundle or migrations script.
const MAX_BUNDLE_BYTES: u64 = 8 * 1024 * 1024;
/// Largest `preview.png`.
const MAX_PREVIEW_BYTES: u64 = 512 * 1024;

/// The frame runtime, inlined into every block frame.
pub const FRAME_RUNTIME: &str = include_str!("../assets/block-frame.js");
static RUNTIME_HASH: LazyLock<String> = LazyLock::new(|| sri_sha384(FRAME_RUNTIME.as_bytes()));

/// `OC_BLOCKS_DIR` and `OC_BLOCKS_ORIGIN`.
#[derive(Debug, Clone, Default)]
pub struct BlocksConfig {
    pub dir: Option<PathBuf>,
    /// `https://blocks.canvas.example` (no path); must not be the editor's origin.
    pub origin: Option<String>,
}

impl BlocksConfig {
    pub fn from_env(public_url: Option<&str>) -> anyhow::Result<Self> {
        let var = |n: &str| std::env::var(n).ok().filter(|v| !v.trim().is_empty());
        let cfg = Self {
            dir: var("OC_BLOCKS_DIR").map(PathBuf::from),
            origin: var("OC_BLOCKS_ORIGIN").map(|o| o.trim().trim_end_matches('/').to_string()),
        };
        cfg.check(public_url)?;
        Ok(cfg)
    }

    /// The block origin is an origin (scheme and host, no path) and a different one from the
    /// editor's, so a bundle can reach neither the editor's DOM nor its storage (§3.4).
    pub fn check(&self, public_url: Option<&str>) -> anyhow::Result<()> {
        let Some(o) = &self.origin else { return Ok(()) };
        let rest = o
            .strip_prefix("https://")
            .or_else(|| o.strip_prefix("http://"))
            .with_context(|| {
                format!("OC_BLOCKS_ORIGIN {o:?} must start with https:// (http:// for local development)")
            })?;
        if rest.is_empty() || rest.contains(['/', '?', '#', '@']) {
            bail!("OC_BLOCKS_ORIGIN {o:?} must be an origin: scheme and host, no path");
        }
        if let Some(p) = public_url
            && origin_of(p).eq_ignore_ascii_case(o)
        {
            bail!(
                "OC_BLOCKS_ORIGIN must be a different origin from OC_PUBLIC_URL ({o}): block code must not run on the editor's origin"
            );
        }
        Ok(())
    }
}

/// `scheme://host[:port]` of a URL.
pub fn origin_of(url: &str) -> &str {
    let after = url.find("://").map_or(0, |i| i + 3);
    match url[after..].find('/') {
        Some(i) => &url[..after + i],
        None => url,
    }
}

/// A package that was not installed, and why (listed on `/healthz`).
#[derive(Debug, Clone, Serialize)]
pub struct Refused {
    pub package: String,
    pub reason: String,
}

/// One installed package's files, in memory.
#[derive(Debug, Default)]
struct Files {
    /// Published path inside the package → bytes.
    by_path: HashMap<String, Arc<Vec<u8>>>,
    /// SRI of the migrations script, when the manifest names one.
    migrations_sri: Option<String>,
}

/// The packages this server installed.
#[derive(Debug, Default)]
pub struct Installed {
    pub registry: Registry,
    pub refused: Vec<Refused>,
    origin: Option<String>,
    files: BTreeMap<String, Files>,
    /// The editor's origin (`OC_PUBLIC_URL`), the only page that may frame a block.
    editor_origin: Option<String>,
}

/// `sha384-<base64>` of `bytes` (Subresource Integrity).
pub fn sri_sha384(bytes: &[u8]) -> String {
    use base64::Engine;
    format!(
        "sha384-{}",
        base64::engine::general_purpose::STANDARD.encode(Sha384::digest(bytes))
    )
}

fn read_inside(dir: &Path, rel: &str, max: u64, what: &str) -> Result<Vec<u8>, String> {
    if !safe_rel_path(rel) {
        return Err(format!("{what} must be a path inside the package"));
    }
    let canon_dir = dir
        .canonicalize()
        .map_err(|e| format!("package directory: {e}"))?;
    let canon = dir
        .join(rel)
        .canonicalize()
        .map_err(|_| format!("{what} {rel:?} is missing"))?;
    // A regular file inside the package (no symlink out of it).
    if !canon.starts_with(&canon_dir) || !canon.is_file() {
        return Err(format!("{what} {rel:?} is not a file inside the package"));
    }
    if std::fs::metadata(&canon).map_or(0, |x| x.len()) > max {
        return Err(format!("{what} {rel:?} is larger than {max} bytes"));
    }
    std::fs::read(&canon).map_err(|e| format!("reading {what}: {e}"))
}

/// Reads a file of a package: (path inside it, size limit, what it is for messages).
type ReadFile<'a> = &'a dyn Fn(&str, u64, &str) -> Result<Vec<u8>, String>;

/// A package from its manifest bytes and a file reader (a directory, or files compiled in).
fn check_package(
    manifest: &[u8],
    first_party: bool,
    read: ReadFile,
) -> Result<(Manifest, Files), String> {
    let m = Manifest::parse(manifest, first_party)?;
    let bundle = read(&m.entry, MAX_BUNDLE_BYTES, "entry")?;
    let got = sri_sha384(&bundle);
    if got != m.integrity {
        return Err(format!(
            "integrity mismatch: block.json says {}, the bundle is {got}",
            m.integrity
        ));
    }
    let mut files = Files::default();
    files.by_path.insert(m.entry.clone(), Arc::new(bundle));
    if let Migrations::Script(p) = &m.migrations {
        let script = read(p, MAX_BUNDLE_BYTES, "migrations script")?;
        files.migrations_sri = Some(sri_sha384(&script));
        files.by_path.insert(p.clone(), Arc::new(script));
    }
    if let Some(p) = &m.preview {
        let png = read(p, MAX_PREVIEW_BYTES, "preview")?;
        if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(format!("preview {p:?} is not a PNG image"));
        }
        files.by_path.insert(p.clone(), Arc::new(png));
    }
    Ok((m, files))
}

fn load_dir(dir: &Path) -> Result<(Manifest, Files), String> {
    let manifest = read_inside(
        dir,
        "block.json",
        oc_model::ext::manifest::MAX_MANIFEST_BYTES as u64,
        "block.json",
    )
    .map_err(|_| "no readable block.json".to_string())?;
    check_package(&manifest, false, &|rel, max, what| {
        read_inside(dir, rel, max, what)
    })
}

impl Installed {
    /// Reads `cfg.dir`: every subdirectory with a `block.json` is a package. First-party
    /// packages compiled into the server (BSDK-04) are added by [`Installed::add_builtin`].
    pub fn load(cfg: &BlocksConfig) -> anyhow::Result<Self> {
        let mut out = Self {
            origin: cfg.origin.clone(),
            ..Self::default()
        };
        let Some(dir) = &cfg.dir else {
            return Ok(out);
        };
        let mut dirs: Vec<PathBuf> = std::fs::read_dir(dir)
            .with_context(|| format!("OC_BLOCKS_DIR {}", dir.display()))?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        if dirs.len() > MAX_PACKAGES {
            bail!("OC_BLOCKS_DIR holds more than {MAX_PACKAGES} packages");
        }
        for d in dirs {
            let name = d
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            out.add(name, load_dir(&d));
        }
        Ok(out)
    }

    fn add(&mut self, name: String, res: Result<(Manifest, Files), String>) {
        let res = res.and_then(|(m, files)| {
            for k in &m.unknown_keys {
                tracing::warn!(package = %name, key = %k, "block.json: unknown key (ignored)");
            }
            let (ty, v) = (m.ty.clone(), m.version.to_string());
            self.registry.insert(m)?;
            self.files.insert(ty.clone(), files);
            Ok((ty, v))
        });
        match res {
            Ok((ty, v)) => {
                tracing::info!(package = %name, r#type = %ty, version = %v, "block package installed")
            }
            Err(reason) => {
                tracing::error!(package = %name, %reason, "block package refused");
                self.refused.push(Refused {
                    package: name,
                    reason,
                });
            }
        }
    }

    /// Installs a first-party package compiled into the server (`oc.` types allowed).
    pub fn add_builtin(&mut self, name: &str, manifest: &[u8], files: &[(&str, &[u8])]) {
        let read = |rel: &str, _max: u64, what: &str| {
            files
                .iter()
                .find(|(p, _)| *p == rel)
                .map(|(_, b)| b.to_vec())
                .ok_or_else(|| format!("{what} {rel:?} is missing"))
        };
        let res = check_package(manifest, true, &read);
        self.add(name.to_string(), res);
    }

    /// The editor origin that may frame blocks (`OC_PUBLIC_URL`'s origin).
    pub fn with_editor_origin(mut self, public_url: Option<&str>) -> Self {
        self.editor_origin = public_url.map(|u| origin_of(u).to_string());
        self
    }

    pub fn origin(&self) -> Option<&str> {
        self.origin.as_deref()
    }

    fn base(&self, m: &Manifest) -> Option<String> {
        self.origin
            .as_ref()
            .map(|o| format!("{o}/blocks/{}/{}", m.ty, m.version))
    }

    /// URL of a package's bundle on the block origin, if one is configured.
    pub fn entry_url(&self, m: &Manifest) -> Option<String> {
        self.base(m).map(|b| format!("{b}/{}", m.entry))
    }

    /// The sandboxed frame document for `ty` as `host` runs it.
    pub fn frame_url(&self, host: &str, ty: &str) -> Option<String> {
        self.origin
            .as_ref()
            .map(|o| format!("{o}/blocks/frame/{host}/{ty}"))
    }

    /// The installed packages `host` enables, as the editor's session lists them, in the
    /// order `[host.blocks] enabled` names them.
    pub fn for_host(&self, host: &crate::hosts::HostConfig) -> Vec<Value> {
        let specs = HostBlocks::of(host);
        let mut out = Vec::new();
        for (ty, req) in specs.entries() {
            let Some(m) = self.registry.get(ty).filter(|m| req.matches(&m.version)) else {
                continue;
            };
            if out.iter().any(|d: &Value| d["type"] == m.ty.as_str()) {
                continue;
            }
            let mut d = m.describe();
            d["entry"] = json!(self.entry_url(m));
            d["frame"] = json!(self.frame_url(&host.id, &m.ty));
            d["integrity"] = json!(m.integrity);
            d["preview"] = json!(
                m.preview
                    .as_ref()
                    .and_then(|p| self.base(m).map(|b| format!("{b}/{p}")))
            );
            let (network, members) = specs.effective(m);
            d["permissions"] =
                json!({"network": network, "members": if members { "read" } else { "none" }});
            out.push(d);
        }
        out
    }
}

/// `[host.blocks]`: `enabled = ["acme.okr@^1", "acme.ticket"]` (types with an optional SemVer
/// requirement) and `[host.blocks.permissions."<type>"]` narrowing what a block may do on
/// this host (`network = [origins]`, `members = "none" | "read"`; decision 9).
#[derive(Debug, Clone, Default)]
pub struct HostBlocks {
    enabled: Vec<(String, semver::VersionReq)>,
    narrow: HashMap<String, (Option<Vec<String>>, Option<bool>)>,
}

impl HostBlocks {
    pub fn parse(t: &toml::Table) -> anyhow::Result<Self> {
        let mut out = Self::default();
        for (k, v) in t {
            match k.as_str() {
                "enabled" => {
                    let list = v
                        .as_array()
                        .context("[host.blocks] enabled takes a list of \"type@version\"")?;
                    for e in list {
                        let s = e
                            .as_str()
                            .context("[host.blocks] enabled takes a list of \"type@version\"")?;
                        let (ty, req) = match s.split_once('@') {
                            Some((t, r)) => (
                                t,
                                semver::VersionReq::parse(r).with_context(|| {
                                    format!("[host.blocks] {s:?}: bad version requirement")
                                })?,
                            ),
                            None => (s, semver::VersionReq::STAR),
                        };
                        oc_model::ext::manifest::check_type_name(ty)
                            .map_err(|e| anyhow::anyhow!("[host.blocks] {e}"))?;
                        out.enabled.push((ty.to_string(), req));
                    }
                }
                "permissions" => {
                    let per = v
                        .as_table()
                        .context("[host.blocks.permissions] takes one table per block type")?;
                    for (ty, p) in per {
                        oc_model::ext::manifest::check_type_name(ty)
                            .map_err(|e| anyhow::anyhow!("[host.blocks.permissions] {e}"))?;
                        let p = p.as_table().with_context(|| {
                            format!("[host.blocks.permissions.\"{ty}\"] must be a table")
                        })?;
                        let mut network = None;
                        let mut members = None;
                        for (pk, pv) in p {
                            match pk.as_str() {
                                "network" => {
                                    let a = pv.as_array().with_context(|| {
                                        format!("[host.blocks.permissions.\"{ty}\"] network takes a list of origins")
                                    })?;
                                    network = Some(
                                        a.iter()
                                            .map(|o| o.as_str().map(|s| s.trim_end_matches('/').to_string()))
                                            .collect::<Option<Vec<_>>>()
                                            .with_context(|| {
                                                format!("[host.blocks.permissions.\"{ty}\"] network takes a list of origins")
                                            })?,
                                    );
                                }
                                "members" => {
                                    members = Some(match pv.as_str() {
                                        Some("read") => true,
                                        Some("none") => false,
                                        _ => bail!(
                                            "[host.blocks.permissions.\"{ty}\"] members takes \"read\" or \"none\""
                                        ),
                                    })
                                }
                                other => bail!(
                                    "[host.blocks.permissions.\"{ty}\"] {other} is not a permission (network, members)"
                                ),
                            }
                        }
                        out.narrow.insert(ty.clone(), (network, members));
                    }
                }
                other => bail!("[host.blocks] {other} is not a setting (enabled, permissions)"),
            }
        }
        Ok(out)
    }

    /// Parsed at start-up by `Hosts::parse`, so this cannot fail later.
    pub fn of(host: &crate::hosts::HostConfig) -> Self {
        Self::parse(&host.blocks).unwrap_or_default()
    }

    pub fn allows(&self, ty: &str, v: &semver::Version) -> bool {
        self.enabled.iter().any(|(t, r)| t == ty && r.matches(v))
    }

    pub fn entries(&self) -> impl Iterator<Item = &(String, semver::VersionReq)> {
        self.enabled.iter()
    }

    /// Effective permissions: what the manifest asks for, narrowed by this host. A host can
    /// only take away, never add.
    pub fn effective(&self, m: &Manifest) -> (Vec<String>, bool) {
        let (net, mem) = self.narrow.get(&m.ty).cloned().unwrap_or_default();
        let network = m
            .network
            .iter()
            .filter(|o| net.as_ref().is_none_or(|n| n.contains(o)))
            .cloned()
            .collect();
        (network, m.members_read && mem.unwrap_or(true))
    }
}

/// Logs what each host enables but the server did not install.
pub fn warn_missing(installed: &Installed, hosts: &crate::hosts::Hosts) {
    for h in hosts.iter() {
        for (ty, req) in HostBlocks::of(h).entries() {
            let found = installed
                .registry
                .get(ty)
                .is_some_and(|m| req.matches(&m.version));
            if !found {
                tracing::warn!(host = %h.id, r#type = %ty, requirement = %req, "[host.blocks] enables a block package that is not installed");
            }
        }
    }
}

// ------------------------------------------------------------------ the block origin

/// Only the block origin serves block code: a request for it on any other host name (the
/// editor's) is not found, so a bundle can never run on the editor's origin.
fn on_block_origin(state: &SharedState, headers: &HeaderMap) -> bool {
    let Some(origin) = state.blocks.origin() else {
        return false;
    };
    let want = origin.split_once("://").map_or(origin, |(_, h)| h);
    headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.eq_ignore_ascii_case(want))
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The frame's CSP: only the runtime (by hash) and this package's own files (by path, with
/// SRI) run; `connect-src` is the effective network permission; nothing else is reachable.
pub fn frame_csp(base: &str, network: &[String], editor_origin: Option<&str>) -> String {
    let connect = if network.is_empty() {
        "'none'".to_string()
    } else {
        network.join(" ")
    };
    format!(
        "default-src 'none'; script-src '{}' {base}/; style-src 'unsafe-inline'; img-src data: blob:; \
         font-src data:; connect-src {connect}; base-uri 'none'; form-action 'none'; \
         frame-ancestors {}",
        RUNTIME_HASH.as_str(),
        editor_origin.unwrap_or("*"),
    )
}

/// `GET /blocks/frame/{host}/{type}` on the block origin: the sandboxed document a block runs
/// in, for the editors of `host`.
pub async fn frame(
    State(state): State<SharedState>,
    UrlPath((host_id, ty)): UrlPath<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if !on_block_origin(&state, &headers) {
        return not_found();
    }
    let Some(host) = state.hosts.get(&host_id) else {
        return not_found();
    };
    let inst = &state.blocks;
    let specs = HostBlocks::of(&host);
    let Some(m) = inst
        .registry
        .get(&ty)
        .filter(|m| specs.allows(&m.ty, &m.version))
    else {
        return not_found();
    };
    let Some(base) = inst.base(m) else {
        return not_found();
    };
    let (network, members) = specs.effective(m);
    let parent = inst.editor_origin.clone().unwrap_or_else(|| "*".into());
    let cfg = json!({"type": m.ty, "version": m.version.to_string(), "parent": parent,
        "network": network, "members": members});
    // JSON in a non-executable script element: `</` must not end it.
    let cfg = cfg.to_string().replace("</", "<\\/");
    let mut scripts = format!(
        "<script src=\"{}\" integrity=\"{}\" crossorigin=\"anonymous\"></script>",
        escape_attr(&format!("{base}/{}", m.entry)),
        escape_attr(&m.integrity)
    );
    if let (Migrations::Script(p), Some(sri)) = (
        &m.migrations,
        inst.files
            .get(&m.ty)
            .and_then(|f| f.migrations_sri.as_ref()),
    ) {
        scripts.push_str(&format!(
            "<script src=\"{}\" integrity=\"{}\" crossorigin=\"anonymous\"></script>",
            escape_attr(&format!("{base}/{p}")),
            escape_attr(sri)
        ));
    }
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <style>html,body{{margin:0;padding:0;background:var(--oc-app,transparent);color:var(--oc-fg,#18181b);\
         font:15px/1.55 var(--oc-font,system-ui,sans-serif)}}#oc-root{{outline:none}}</style>\
         <script type=\"application/json\" id=\"oc-config\">{cfg}</script>\
         </head><body><div id=\"oc-root\" tabindex=\"-1\"></div><script>{FRAME_RUNTIME}</script>{scripts}</body></html>"
    );
    // frame-ancestors is checked against every ancestor: the editor, and the host page that
    // embeds the editor (its allowed origins and own frame_ancestors).
    let ancestors = inst.editor_origin.as_ref().map(|e| {
        let mut v = vec![e.clone()];
        v.extend(
            host.allowed_origins
                .iter()
                .chain(&host.frame_ancestors)
                .filter(|o| {
                    o.bytes()
                        .all(|b| b.is_ascii_graphic() && !matches!(b, b';' | b',' | b'\'' | b'"'))
                })
                .cloned(),
        );
        v.join(" ")
    });
    let csp = frame_csp(&base, &network, ancestors.as_deref());
    let mut res = (StatusCode::OK, html).into_response();
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    if let Ok(v) = HeaderValue::from_str(&csp) {
        h.insert(header::CONTENT_SECURITY_POLICY, v);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// `GET /blocks/{type}/{version}/{*path}` on the block origin: a file of an installed package
/// (its bundle, migrations script or preview), immutable per version.
pub async fn file(
    State(state): State<SharedState>,
    UrlPath((ty, version, path)): UrlPath<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    if !on_block_origin(&state, &headers) {
        return not_found();
    }
    let inst = &state.blocks;
    let Some(m) = inst
        .registry
        .get(&ty)
        .filter(|m| m.version.to_string() == version)
    else {
        return not_found();
    };
    let Some(bytes) = inst.files.get(&m.ty).and_then(|f| f.by_path.get(&path)) else {
        return not_found();
    };
    let ctype = if path.ends_with(".png") {
        "image/png"
    } else {
        "text/javascript; charset=utf-8"
    };
    let mut res = (StatusCode::OK, bytes.as_ref().clone()).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(ctype));
    // The frame is an opaque origin: SRI on a cross-origin script needs CORS.
    h.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    h.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("cross-origin"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
    );
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn write_package(
        root: &Path,
        name: &str,
        ty: &str,
        version: &str,
        bundle: &[u8],
        integrity: Option<&str>,
    ) {
        let d = root.join(name);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("block.js"), bundle).unwrap();
        let m = json!({"type": ty, "version": version, "title": "OKR", "entry": "block.js",
            "integrity": integrity.map(str::to_string).unwrap_or_else(|| sri_sha384(bundle)),
            "attrs": {"type": "object", "properties": {"objective": {"type": "string"}}}});
        std::fs::write(d.join("block.json"), serde_json::to_vec(&m).unwrap()).unwrap();
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("oc-blocks-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn packages_with_a_bad_integrity_or_reserved_type_are_refused() {
        let root = tmp("load");
        write_package(
            &root,
            "a-okr",
            "acme.okr",
            "1.2.0",
            b"export default 1",
            None,
        );
        write_package(
            &root,
            "b-bad-hash",
            "acme.bad",
            "1.0.0",
            b"tampered",
            Some(&sri_sha384(b"original")),
        );
        write_package(&root, "c-reserved", "oc.progress", "1.0.0", b"x", None);
        write_package(&root, "d-dup", "acme.okr", "1.3.0", b"y", None);
        let got = Installed::load(&BlocksConfig {
            dir: Some(root.clone()),
            origin: Some("https://blocks.example".into()),
        })
        .unwrap();
        assert_eq!(got.registry.len(), 1);
        let m = got.registry.get("acme.okr").unwrap();
        assert_eq!(
            got.entry_url(m).as_deref(),
            Some("https://blocks.example/blocks/acme.okr/1.2.0/block.js")
        );
        assert_eq!(
            got.frame_url("acme", "acme.okr").as_deref(),
            Some("https://blocks.example/blocks/frame/acme/acme.okr")
        );
        let refused: Vec<(&str, &str)> = got
            .refused
            .iter()
            .map(|r| (r.package.as_str(), r.reason.as_str()))
            .collect();
        assert_eq!(refused.len(), 3, "{refused:?}");
        assert!(refused[0].0 == "b-bad-hash" && refused[0].1.contains("integrity mismatch"));
        assert!(refused[1].0 == "c-reserved" && refused[1].1.contains("reserved"));
        assert!(refused[2].0 == "d-dup" && refused[2].1.contains("twice"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_preview_must_be_a_png_inside_the_package() {
        let root = tmp("preview");
        write_package(&root, "a", "acme.okr", "1.0.0", b"x", None);
        let p = root.join("a/block.json");
        let mut m: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        m["preview"] = json!("preview.png");
        std::fs::write(&p, serde_json::to_vec(&m).unwrap()).unwrap();
        std::fs::write(root.join("a/preview.png"), b"GIF89a not a png").unwrap();
        let got = Installed::load(&BlocksConfig {
            dir: Some(root.clone()),
            origin: None,
        })
        .unwrap();
        assert!(
            got.refused[0].reason.contains("not a PNG"),
            "{:?}",
            got.refused
        );
        std::fs::write(root.join("a/preview.png"), b"\x89PNG\r\n\x1a\nrest").unwrap();
        let got = Installed::load(&BlocksConfig {
            dir: Some(root.clone()),
            origin: None,
        })
        .unwrap();
        assert!(got.refused.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_block_origin_is_a_separate_origin() {
        let c = |o: &str| BlocksConfig {
            dir: None,
            origin: Some(o.into()),
        };
        assert!(
            c("https://blocks.example")
                .check(Some("https://canvas.example/app"))
                .is_ok()
        );
        assert!(
            c("https://canvas.example")
                .check(Some("https://canvas.example/"))
                .is_err()
        );
        assert!(c("https://blocks.example/path").check(None).is_err());
        assert!(c("ftp://blocks.example").check(None).is_err());
    }

    #[test]
    fn host_specs_parse_match_and_narrow() {
        let t: toml::Table = toml::from_str(
            "enabled = [\"acme.okr@^1\", \"acme.ticket\"]\n[permissions.\"acme.okr\"]\nnetwork = [\"https://okr.acme.example\"]\nmembers = \"none\"\n",
        )
        .unwrap();
        let h = HostBlocks::parse(&t).unwrap();
        assert!(h.allows("acme.okr", &semver::Version::new(1, 4, 0)));
        assert!(!h.allows("acme.okr", &semver::Version::new(2, 0, 0)));
        assert!(h.allows("acme.ticket", &semver::Version::new(9, 0, 0)));
        assert!(!h.allows("acme.other", &semver::Version::new(1, 0, 0)));
        let m = Manifest::from_json(
            &json!({"type": "acme.okr", "version": "1.0.0", "title": "OKR", "entry": "b.js",
                "integrity": format!("sha384-{}", "A".repeat(64)),
                "permissions": {"network": ["https://okr.acme.example", "https://cdn.acme.example"], "members": "read"}}),
            false,
        )
        .unwrap();
        // The host keeps one origin and takes the member list away; it can never add.
        assert_eq!(
            h.effective(&m),
            (vec!["https://okr.acme.example".to_string()], false)
        );
        assert_eq!(HostBlocks::default().effective(&m).0.len(), 2);
        for bad in [
            "enabled = [\"Acme.okr\"]",
            "enabled = [\"acme.okr@^x\"]",
            "enabled = \"acme.okr\"",
            "origin = \"x\"",
            "[permissions.\"acme.okr\"]\nmembers = \"all\"",
            "[permissions.\"acme.okr\"]\nfiles = true",
        ] {
            let t: toml::Table = toml::from_str(bad).unwrap();
            assert!(HostBlocks::parse(&t).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_frame_csp_allows_only_the_runtime_the_package_and_its_network() {
        let csp = frame_csp(
            "https://blocks.example/blocks/acme.okr/1.2.0",
            &["https://okr.acme.example".into()],
            Some("https://canvas.example"),
        );
        assert!(
            csp.starts_with("default-src 'none'; script-src 'sha384-"),
            "{csp}"
        );
        assert!(
            csp.contains(" https://blocks.example/blocks/acme.okr/1.2.0/;"),
            "{csp}"
        );
        assert!(
            csp.contains("connect-src https://okr.acme.example;"),
            "{csp}"
        );
        assert!(
            csp.contains("frame-ancestors https://canvas.example"),
            "{csp}"
        );
        assert!(!csp.contains("'unsafe-eval'") && !csp.contains("script-src *"));
        let none = frame_csp("https://b/blocks/x.y/1.0.0", &[], None);
        assert!(none.contains("connect-src 'none'"), "{none}");
    }
}
