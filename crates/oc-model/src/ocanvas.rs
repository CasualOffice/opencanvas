// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `.ocanvas` zip: `manifest.json`, `document.json`, `ydoc.bin` (docs/04 §2.3).

use std::io::{Cursor, Read, Write};

use serde::Serialize;
use serde_json::{Value, json};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::doc::{doc_to_json, new_doc};
use crate::import::apply_document_json;

pub const FORMAT_VERSION: u32 = 1;
pub const SCHEMA_VERSION: u32 = 1;
const MAX_ENTRIES: usize = 1000;
const MAX_TOTAL: u64 = 100 * 1024 * 1024;
const MAX_RATIO: u64 = 100;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not a valid .ocanvas zip: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("archive rejected: {0}")]
    Limit(&'static str),
    #[error("archive has neither ydoc.bin nor document.json")]
    Empty,
    #[error("ydoc.bin could not be applied")]
    BadUpdate,
    #[error("render failed: {0}")]
    Render(String),
    /// The document breaks the block schema (MOD-01): `path: message` of the first error.
    #[error("document does not match the block schema at {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub authors: Vec<String>,
    /// RFC 3339 timestamp.
    pub at: String,
    /// What this save is (docs/30 §2 c2, ADR-051): `auto`, `named` or `restore`.
    pub kind: CommitKind,
    /// The version's name (named and restore saves), at most 120 characters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Restore saves: the version that was restored.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored_from: Option<String>,
}

/// The kind of a save (manifest `commit.kind`, docs/30 §4).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommitKind {
    #[default]
    Auto,
    Named,
    Restore,
}

impl CommitKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Named => "named",
            Self::Restore => "restore",
        }
    }
    /// Unknown or missing kinds read as `auto`.
    pub fn parse(s: Option<&str>) -> Self {
        match s {
            Some("named") => Self::Named,
            Some("restore") => Self::Restore,
            _ => Self::Auto,
        }
    }
}

/// `manifest.json` of a `.ocanvas` alone (no document decoding); `None` when absent or broken.
pub fn read_manifest(bytes: &[u8]) -> Option<Value> {
    let mut zip = ZipArchive::new(Cursor::new(bytes)).ok()?;
    let entry = zip.by_name("manifest.json").ok()?;
    if entry.size() > 1024 * 1024 {
        return None;
    }
    let mut buf = Vec::new();
    entry.take(1024 * 1024).read_to_end(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

pub fn encode_state(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

pub fn write_ocanvas(doc: &Doc, commit: &CommitInfo) -> Result<Vec<u8>, Error> {
    write_ocanvas_with(doc, commit, None)
}

/// Like [`write_ocanvas`], with in-file history (ADR-055) as `history/` entries.
pub fn write_ocanvas_with(
    doc: &Doc,
    commit: &CommitInfo,
    history: Option<&crate::history::FileHistory>,
) -> Result<Vec<u8>, Error> {
    write_ocanvas_opts(doc, commit, history, crate::search::Options::default())
}

/// Like [`write_ocanvas_with`], with the `search.json` options (SRCH-02, ADR-065).
pub fn write_ocanvas_opts(
    doc: &Doc,
    commit: &CommitInfo,
    history: Option<&crate::history::FileHistory>,
    search: crate::search::Options,
) -> Result<Vec<u8>, Error> {
    let document = doc_to_json(doc);
    let title = document["meta"]["title"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let mut manifest = json!({
        "format": "ocanvas",
        "version": FORMAT_VERSION,
        "schemaVersion": SCHEMA_VERSION,
        "createdWith": concat!("opencanvas/", env!("CARGO_PKG_VERSION")),
        "title": title,
        "commit": commit,
    });
    // BSDK-02 (ADR-042): the SDK block types and data versions the document uses; additive,
    // format version 1 unchanged.
    let blocks = crate::ext::requires(&document);
    if !blocks.is_empty() {
        manifest["requires"] = json!({ "blocks": blocks });
    }
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let deflate = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("manifest.json", deflate)?;
    zip.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
    zip.start_file("document.json", deflate)?;
    zip.write_all(&serde_json::to_vec(&document)?)?;
    zip.start_file(
        "ydoc.bin",
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )?;
    zip.write_all(&encode_state(doc))?;
    // SRCH-02 (ADR-065): the plain-text projection the host indexes; additive to format 1
    // (older readers skip the entry). Never read back: every save writes it afresh.
    zip.start_file(crate::search::ENTRY, deflate)?;
    zip.write_all(&serde_json::to_vec(&crate::search::search_json(
        &document, search,
    ))?)?;
    if let Some(h) = history.filter(|h| !h.entries.is_empty()) {
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, bytes) in h.to_files() {
            let opts = if name == crate::history::INDEX {
                deflate
            } else {
                stored
            };
            zip.start_file(name, opts)?;
            zip.write_all(&bytes)?;
        }
    }
    Ok(zip.finish()?.into_inner())
}

pub fn is_zip(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
}

pub struct Loaded {
    pub doc: Doc,
    pub manifest: Value,
    /// In-file history (ADR-055); empty when the file has none.
    pub history: crate::history::FileHistory,
}

/// Applies a Yjs update, v1 or v2. A v2 update starts with a 0 feature byte, which a v1
/// decoder reads as "no structs" and so silently yields an empty update: those bytes are
/// tried as v2 first (a v1 update holding only deletions falls back to v1).
pub fn apply_update_bytes(doc: &Doc, bytes: &[u8]) -> Result<(), Error> {
    let update = if bytes.first() == Some(&0) && bytes.len() > 2 {
        Update::decode_v2(bytes).or_else(|_| Update::decode_v1(bytes))
    } else {
        Update::decode_v1(bytes).or_else(|_| Update::decode_v2(bytes))
    }
    .map_err(|_| Error::BadUpdate)?;
    crate::sync::apply_update(&mut doc.transact_mut(), update).map_err(|_| Error::BadUpdate)
}

/// Inflates one entry, trusting none of the sizes the archive declares (SEC-14): at most its
/// declared size (a longer stream is a lie), at most [`MAX_RATIO`] times its compressed size,
/// and `total` (the declared sizes counted so far) is re-checked against [`MAX_TOTAL`].
fn read_capped<R: Read>(
    entry: R,
    (declared, compressed): (u64, u64),
    total: &mut u64,
) -> Result<Vec<u8>, Error> {
    let cap = declared.min(compressed.max(1).saturating_mul(MAX_RATIO));
    let mut buf = Vec::with_capacity(cap.min(1 << 20) as usize);
    entry.take(cap + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > cap {
        return Err(Error::Limit("entry inflates past its declared size"));
    }
    *total = total.saturating_sub(declared) + buf.len() as u64;
    if *total > MAX_TOTAL {
        return Err(Error::Limit("too large"));
    }
    Ok(buf)
}

/// Reads a `.ocanvas` with zip-bomb and path-traversal limits (docs/07 §2).
pub fn read_ocanvas(bytes: &[u8]) -> Result<Loaded, Error> {
    let mut zip = ZipArchive::new(Cursor::new(bytes))?;
    if zip.len() > MAX_ENTRIES {
        return Err(Error::Limit("too many entries"));
    }
    let mut total = 0u64;
    let mut files = std::collections::HashMap::new();
    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        if entry.enclosed_name().is_none() {
            return Err(Error::Limit("unsafe path"));
        }
        let name = entry.name()?.to_string();
        total += entry.size();
        if total > MAX_TOTAL {
            return Err(Error::Limit("too large"));
        }
        if entry.compressed_size() > 0 && entry.size() / entry.compressed_size().max(1) > MAX_RATIO
        {
            return Err(Error::Limit("compression ratio"));
        }
        if matches!(
            name.as_str(),
            "manifest.json" | "document.json" | "ydoc.bin"
        ) || name == crate::history::INDEX
            || (name.starts_with(crate::history::PREFIX) && name.ends_with(".deflate"))
        {
            let sizes = (entry.size(), entry.compressed_size());
            let buf = read_capped(entry, sizes, &mut total)?;
            files.insert(name, buf);
        }
    }
    let manifest: Value = match files.get("manifest.json") {
        Some(b) => serde_json::from_slice(b)?,
        None => json!({}),
    };
    let schema_ok = manifest
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .is_none_or(|v| v == u64::from(SCHEMA_VERSION));
    let doc = new_doc();
    match (files.get("ydoc.bin"), files.get("document.json")) {
        (Some(bin), _) if schema_ok => apply_update_bytes(&doc, bin)?,
        (_, Some(json)) => apply_document_json(&doc, &serde_json::from_slice(json)?),
        (Some(bin), None) => apply_update_bytes(&doc, bin)?,
        (None, None) => return Err(Error::Empty),
    }
    // MOD-01: errors refuse the file; warnings (unknown content, kept) are only counted.
    let report = crate::validate::record(crate::validate::validate(&doc));
    if let Some(e) = report.first_error() {
        return Err(Error::Invalid(e));
    }
    let history = match files.get(crate::history::INDEX) {
        Some(index) => crate::history::FileHistory::from_files(index, |n| files.get(n).cloned()),
        None => Default::default(),
    };
    Ok(Loaded {
        doc,
        manifest,
        history,
    })
}

/// An image or file stored inside the `.ocanvas` zip as `assets/<id>` (WOPI mode, where the
/// host has no asset API). `assets/index.json` maps each id to its MIME type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    pub id: String,
    pub mime: String,
    pub data: Vec<u8>,
}

/// Asset ids: 1-64 chars of `[A-Za-z0-9_-]` (no paths).
pub fn valid_asset_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Reads the `assets/<id>` entries of a `.ocanvas` (same limits as [`read_ocanvas`]).
pub fn read_assets(bytes: &[u8]) -> Result<Vec<Asset>, Error> {
    let mut zip = ZipArchive::new(Cursor::new(bytes))?;
    if zip.len() > MAX_ENTRIES {
        return Err(Error::Limit("too many entries"));
    }
    let mut total = 0u64;
    let mut index = serde_json::Map::new();
    let mut blobs = Vec::new();
    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        if entry.enclosed_name().is_none() {
            return Err(Error::Limit("unsafe path"));
        }
        total += entry.size();
        if total > MAX_TOTAL {
            return Err(Error::Limit("too large"));
        }
        let name = entry.name()?.to_string();
        let Some(id) = name.strip_prefix("assets/") else {
            continue;
        };
        let sizes = (entry.size(), entry.compressed_size());
        let buf = read_capped(entry, sizes, &mut total)?;
        if id == "index.json" {
            if let Ok(Value::Object(m)) = serde_json::from_slice(&buf) {
                index = m;
            }
        } else if valid_asset_id(id) {
            blobs.push((id.to_string(), buf));
        }
    }
    Ok(blobs
        .into_iter()
        .map(|(id, data)| {
            let mime = index
                .get(&id)
                .and_then(|v| v.get("mime"))
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream")
                .to_string();
            Asset { id, mime, data }
        })
        .collect())
}

/// Returns `bytes` (a `.ocanvas`) with its `assets/` replaced by `assets`. Assets are stored
/// uncompressed (images are already compressed).
pub fn with_assets(bytes: &[u8], assets: &[Asset]) -> Result<Vec<u8>, Error> {
    let mut src = ZipArchive::new(Cursor::new(bytes))?;
    let mut out = ZipWriter::new(Cursor::new(Vec::new()));
    for i in 0..src.len() {
        let entry = src.by_index_raw(i)?;
        if entry.name()?.starts_with("assets/") {
            continue;
        }
        out.raw_copy_file(entry)?;
    }
    if !assets.is_empty() {
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let mut index = serde_json::Map::new();
        for a in assets.iter().filter(|a| valid_asset_id(&a.id)) {
            out.start_file(format!("assets/{}", a.id), stored)?;
            out.write_all(&a.data)?;
            index.insert(a.id.clone(), json!({"mime": a.mime, "size": a.data.len()}));
        }
        out.start_file(
            "assets/index.json",
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
        )?;
        out.write_all(&serde_json::to_vec(&Value::Object(index))?)?;
    }
    Ok(out.finish()?.into_inner())
}

#[cfg(test)]
mod asset_tests {

    /// Rewrites every declared uncompressed size of `name` (local header and central
    /// directory) to `size`, the way a zip bomb lies about its entries.
    fn lie_about_size(zip: &mut [u8], name: &str, size: u32) {
        let n = name.as_bytes();
        let mut i = 0;
        while i + 4 <= zip.len() {
            let sig = &zip[i..i + 4];
            let (size_at, name_len_at, name_at) = match sig {
                b"PK\x03\x04" => (i + 22, i + 26, i + 30),
                b"PK\x01\x02" => (i + 24, i + 28, i + 46),
                _ => {
                    i += 1;
                    continue;
                }
            };
            let len = u16::from_le_bytes([zip[name_len_at], zip[name_len_at + 1]]) as usize;
            if zip.get(name_at..name_at + len) == Some(n) {
                zip[size_at..size_at + 4].copy_from_slice(&size.to_le_bytes());
            }
            i += 4;
        }
    }

    /// SEC-14: the limits trusted the sizes the archive declares. An entry that claims to be
    /// 1 KB but inflates to 50 MB passed the ratio and total checks.
    #[test]
    fn entries_that_inflate_past_their_declared_size_are_refused() {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let deflate = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file("document.json", deflate).unwrap();
        zip.write_all(b"{\"type\":\"doc\",\"content\":[],\"pad\":\"")
            .unwrap();
        zip.write_all(&vec![b'a'; 50 * 1024 * 1024]).unwrap();
        zip.write_all(b"\"}").unwrap();
        let mut bytes = zip.finish().unwrap().into_inner();
        assert!(
            matches!(read_ocanvas(&bytes), Err(Error::Limit(_))),
            "honest sizes"
        );
        lie_about_size(&mut bytes, "document.json", 1024);
        assert!(
            matches!(
                read_ocanvas(&bytes),
                Err(Error::Limit(_) | Error::Zip(_) | Error::Io(_))
            ),
            "a lying entry must not be inflated"
        );
    }
    use super::*;

    #[test]
    fn assets_round_trip_through_the_zip() {
        let doc = new_doc();
        let base = write_ocanvas(&doc, &CommitInfo::default()).unwrap();
        let assets = vec![
            Asset {
                id: "a_1".into(),
                mime: "image/png".into(),
                data: vec![1, 2, 3],
            },
            Asset {
                id: "a_2".into(),
                mime: "application/pdf".into(),
                data: vec![9; 2000],
            },
        ];
        let packed = with_assets(&base, &assets).unwrap();
        assert!(read_ocanvas(&packed).is_ok(), "still a readable .ocanvas");
        let mut back = read_assets(&packed).unwrap();
        back.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(back, assets);
        // Replacing drops the old set.
        let again = with_assets(&packed, &assets[..1]).unwrap();
        assert_eq!(read_assets(&again).unwrap(), assets[..1].to_vec());
        assert!(!valid_asset_id("../x"));
        assert!(valid_asset_id("a_01JD"));
    }
}
