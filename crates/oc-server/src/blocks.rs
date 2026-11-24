// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Installed SDK block packages (BSDK-01, docs/27 §3.3, docs/05 §2).
//!
//! The operator installs packages in `OC_BLOCKS_DIR` (one directory per package with a
//! `block.json`); hosts enable them with `[host.blocks] enabled = ["acme.okr@^1"]`. At start
//! every manifest is parsed and checked (`oc_model::ext::Manifest`) and its bundle's SRI hash
//! (`integrity`, sha384) is verified. A package that fails is refused, logged and listed on
//! `/healthz`; the server still starts, and documents using its type keep it as an unknown
//! block (shown as its fallback). Bundles are served from the separate block origin
//! `OC_BLOCKS_ORIGIN` (BSDK-03); this module only computes their URLs.

use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use oc_model::ext::{Manifest, Registry, manifest::safe_rel_path};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha384};

/// Most packages read from `OC_BLOCKS_DIR`.
const MAX_PACKAGES: usize = 200;
/// Largest bundle hashed.
const MAX_BUNDLE_BYTES: u64 = 8 * 1024 * 1024;

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
            .with_context(|| format!("OC_BLOCKS_ORIGIN {o:?} must start with https:// (http:// for local development)"))?;
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

fn origin_of(url: &str) -> &str {
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

/// The packages this server installed.
#[derive(Debug, Default)]
pub struct Installed {
    pub registry: Registry,
    pub refused: Vec<Refused>,
    origin: Option<String>,
}

/// `sha384-<base64>` of `bytes` (Subresource Integrity).
pub fn sri_sha384(bytes: &[u8]) -> String {
    use base64::Engine;
    format!(
        "sha384-{}",
        base64::engine::general_purpose::STANDARD.encode(Sha384::digest(bytes))
    )
}

fn load_one(dir: &Path) -> Result<Manifest, String> {
    let path = dir.join("block.json");
    let meta = std::fs::metadata(&path).map_err(|_| "no block.json".to_string())?;
    if meta.len() > oc_model::ext::manifest::MAX_MANIFEST_BYTES as u64 {
        return Err("block.json is too large".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("reading block.json: {e}"))?;
    let m = Manifest::parse(&bytes, false)?;
    if !safe_rel_path(&m.entry) {
        return Err("entry must be a path inside the package".into());
    }
    let entry = dir.join(&m.entry);
    // The bundle must be a regular file inside the package (no symlink out of it).
    let canon_dir = dir
        .canonicalize()
        .map_err(|e| format!("package directory: {e}"))?;
    let canon = entry
        .canonicalize()
        .map_err(|_| format!("entry {:?} is missing", m.entry))?;
    if !canon.starts_with(&canon_dir) || !canon.is_file() {
        return Err(format!(
            "entry {:?} is not a file inside the package",
            m.entry
        ));
    }
    if std::fs::metadata(&canon).map_or(0, |x| x.len()) > MAX_BUNDLE_BYTES {
        return Err(format!(
            "entry {:?} is larger than {MAX_BUNDLE_BYTES} bytes",
            m.entry
        ));
    }
    let bundle = std::fs::read(&canon).map_err(|e| format!("reading the entry: {e}"))?;
    let got = sri_sha384(&bundle);
    if got != m.integrity {
        return Err(format!(
            "integrity mismatch: block.json says {}, the bundle is {got}",
            m.integrity
        ));
    }
    if let oc_model::ext::migrate::Migrations::Script(p) = &m.migrations
        && !dir.join(p).is_file()
    {
        return Err(format!("migrations script {p:?} is missing"));
    }
    Ok(m)
}

impl Installed {
    /// Reads `cfg.dir`: every subdirectory with a `block.json` is a package.
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
            let res = load_one(&d).and_then(|m| {
                for k in &m.unknown_keys {
                    tracing::warn!(package = %name, key = %k, "block.json: unknown key (ignored)");
                }
                let (ty, v) = (m.ty.clone(), m.version.to_string());
                out.registry.insert(m).map(|()| (ty, v))
            });
            match res {
                Ok((ty, v)) => {
                    tracing::info!(package = %name, r#type = %ty, version = %v, "block package installed")
                }
                Err(reason) => {
                    tracing::error!(package = %name, %reason, "block package refused");
                    out.refused.push(Refused {
                        package: name,
                        reason,
                    });
                }
            }
        }
        Ok(out)
    }

    /// URL of a package's bundle on the block origin, if one is configured.
    pub fn entry_url(&self, m: &Manifest) -> Option<String> {
        self.origin
            .as_ref()
            .map(|o| format!("{o}/{}/{}/{}", m.ty, m.version, m.entry))
    }

    /// The installed packages `host` enables, as the editor's session lists them.
    pub fn for_host(&self, host: &crate::hosts::HostConfig) -> Vec<Value> {
        let specs = HostBlocks::of(host);
        self.registry
            .iter()
            .filter(|m| specs.allows(&m.ty, &m.version))
            .map(|m| {
                let mut d = m.describe();
                d["entry"] = json!(self.entry_url(m));
                d["integrity"] = json!(m.integrity);
                d
            })
            .collect()
    }
}

/// `[host.blocks] enabled = ["acme.okr@^1", "acme.ticket"]`: types with an optional SemVer
/// requirement (default: any version).
#[derive(Debug, Clone, Default)]
pub struct HostBlocks(Vec<(String, semver::VersionReq)>);

impl HostBlocks {
    pub fn parse(t: &toml::Table) -> anyhow::Result<Self> {
        let mut out = Vec::new();
        for (k, v) in t {
            if k != "enabled" {
                bail!("[host.blocks] {k} is not a setting (enabled)");
            }
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
                out.push((ty.to_string(), req));
            }
        }
        Ok(Self(out))
    }

    /// Parsed at start-up by `Hosts::parse`, so this cannot fail later.
    pub fn of(host: &crate::hosts::HostConfig) -> Self {
        Self::parse(&host.blocks).unwrap_or_default()
    }

    pub fn allows(&self, ty: &str, v: &semver::Version) -> bool {
        self.0.iter().any(|(t, r)| t == ty && r.matches(v))
    }

    pub fn entries(&self) -> impl Iterator<Item = &(String, semver::VersionReq)> {
        self.0.iter()
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
            Some("https://blocks.example/acme.okr/1.2.0/block.js")
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
    fn host_specs_parse_and_match() {
        let t: toml::Table =
            toml::from_str("enabled = [\"acme.okr@^1\", \"acme.ticket\"]").unwrap();
        let h = HostBlocks::parse(&t).unwrap();
        assert!(h.allows("acme.okr", &semver::Version::new(1, 4, 0)));
        assert!(!h.allows("acme.okr", &semver::Version::new(2, 0, 0)));
        assert!(h.allows("acme.ticket", &semver::Version::new(9, 0, 0)));
        assert!(!h.allows("acme.other", &semver::Version::new(1, 0, 0)));
        for bad in [
            "enabled = [\"Acme.okr\"]",
            "enabled = [\"acme.okr@^x\"]",
            "enabled = \"acme.okr\"",
            "origin = \"x\"",
        ] {
            let t: toml::Table = toml::from_str(bad).unwrap();
            assert!(HostBlocks::parse(&t).is_err(), "{bad}");
        }
    }
}
