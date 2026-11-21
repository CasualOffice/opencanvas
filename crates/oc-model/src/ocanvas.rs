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
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CommitInfo {
    pub id: String,
    pub authors: Vec<String>,
    /// RFC 3339 timestamp.
    pub at: String,
}

pub fn encode_state(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

pub fn write_ocanvas(doc: &Doc, commit: &CommitInfo) -> Result<Vec<u8>, Error> {
    let document = doc_to_json(doc);
    let title = document["meta"]["title"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let manifest = json!({
        "format": "ocanvas",
        "version": FORMAT_VERSION,
        "schemaVersion": SCHEMA_VERSION,
        "createdWith": concat!("opencanvas/", env!("CARGO_PKG_VERSION")),
        "title": title,
        "commit": commit,
    });
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
    Ok(zip.finish()?.into_inner())
}

pub fn is_zip(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
}

pub struct Loaded {
    pub doc: Doc,
    pub manifest: Value,
}

pub fn apply_update_bytes(doc: &Doc, bytes: &[u8]) -> Result<(), Error> {
    let update = Update::decode_v1(bytes)
        .or_else(|_| Update::decode_v2(bytes))
        .map_err(|_| Error::BadUpdate)?;
    doc.transact_mut()
        .apply_update(update)
        .map_err(|_| Error::BadUpdate)
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
        let name = entry.name().to_string();
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
        ) {
            let mut buf = Vec::with_capacity(entry.size() as usize);
            entry.take(MAX_TOTAL).read_to_end(&mut buf)?;
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
    Ok(Loaded { doc, manifest })
}
