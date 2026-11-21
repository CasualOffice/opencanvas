//! OpenCanvas document model: Y.Doc layout helpers, `.ocanvas` files and exports.

pub mod doc;
pub mod docx;
pub mod export;
pub mod html;
pub mod import;
pub mod ocanvas;
pub mod patch;

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
    pub const MAPS: [&str; 5] = [META, DATABASES, BOARDS, COMMENTS, ASSETS];
}
