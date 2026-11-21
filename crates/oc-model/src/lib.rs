//! OpenCanvas document model: Y.Doc layout helpers, `.ocanvas` files and exports.

pub mod board;
pub mod doc;
pub mod docx;
pub mod export;
pub mod fonts;
pub mod html;
pub mod import;
pub mod ocanvas;
pub mod patch;
pub mod people;

pub use doc::{doc_to_json, ensure_roots, is_empty, new_doc};
pub use ocanvas::{CommitInfo, Error, read_ocanvas, write_ocanvas};

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
    pub const MAPS: [&str; 6] = [META, DATABASES, BOARDS, COMMENTS, ASSETS, PEOPLE];
}
