// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! OpenCanvas document model: Y.Doc layout helpers, `.ocanvas` files and exports.

pub mod board;
pub mod diagram_export;
pub mod diagram_import;
pub mod diff;
pub mod doc;
pub mod doc_icons;
pub mod docx;
pub mod export;
pub mod ext;
pub mod fonts;
pub mod history;
pub mod html;
pub mod icon_clean;
pub mod icons;
pub mod import;
pub mod live;
pub mod ocanvas;
pub mod patch;
pub mod people;
pub mod preview;
pub mod restore;
pub mod sync;
pub mod templates;
pub mod validate;

pub use doc::{doc_to_json, ensure_roots, is_empty, new_doc};
pub use ocanvas::{CommitInfo, Error, read_ocanvas, write_ocanvas};
pub use validate::{
    Issue, Report, validate, validate_blocks, validate_blocks_with, validate_json,
    validate_json_with,
};

/// Root names of the shared Y.Doc (docs/15 §4).
pub mod roots {
    pub const CONTENT: &str = "content";
    pub const META: &str = "meta";
    pub const DATABASES: &str = "databases";
    pub const BOARDS: &str = "boards";
    pub const COMMENTS: &str = "comments";
    pub const ASSETS: &str = "assets";
    /// docs/21 tier 0: who opened the file, `{id → {id, name, detail?, avatar?, lastSeen}}`.
    pub const PEOPLE: &str = "people";
    /// DGM-17 (ADR-057): icons people added, written by the server only (`doc_icons`).
    pub const ICONS: &str = "icons";
    /// BSDK-02 (ADR-040): SDK block data, `{dataId → Y.Map}` with one key per field.
    pub const EXT: &str = "ext";
    pub const MAPS: [&str; 7] = [META, DATABASES, BOARDS, COMMENTS, ASSETS, PEOPLE, EXT];
}
