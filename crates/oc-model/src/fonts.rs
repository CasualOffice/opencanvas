// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Fonts for in-process rendering (board PNG, and through it DOCX board images).
//!
//! The database holds, in this order:
//! 1. embedded Geist Regular + SemiBold (Latin, the board's design font);
//! 2. embedded subsets of Noto Sans Symbols 2 (check marks, dingbats, geometric shapes, misc
//!    symbols) and Noto Sans Math (arrows, math operators), so `✓ ✗ → ⇒ ★ ☐ ⚠` draw on any
//!    machine;
//! 3. system fonts (`fontdb::Database::load_system_fonts`) unless `OC_SYSTEM_FONTS=0`;
//! 4. every directory in `OC_FONT_DIRS` (colon-separated).
//!
//! Characters the chosen font lacks fall back first to the embedded symbol fonts, then to the
//! Noto families in [`FALLBACK_FAMILIES`] (CJK, Noto Sans, ...), then to any face that has the
//! glyph. A character no font has is drawn as `.notdef` and logged once per script.
//! All fonts are OFL; see `crates/oc-model/fonts/THIRD-PARTY.md`.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use resvg::usvg::fontdb::{Database, ID, Stretch, Style, Weight};
use resvg::usvg::{FallbackSelectionFn, FontResolver};
use unicode_script::{Script, UnicodeScript};

/// The family the board SVG asks for first; also every generic family.
pub const PRIMARY_FAMILY: &str = "Geist";

/// Preferred fallbacks, in order, before any other face that has the glyph.
pub const FALLBACK_FAMILIES: &[&str] = &[
    "Noto Sans Symbols 2",
    "Noto Sans Math",
    "Noto Sans",
    "Noto Sans CJK SC",
    "Noto Sans CJK JP",
    "Noto Sans CJK KR",
    "Noto Sans CJK TC",
    "Noto Sans CJK HK",
    "Noto Sans SC",
    "Noto Sans JP",
    "Noto Sans KR",
    "Noto Sans TC",
    "Noto Sans Arabic",
    "Noto Sans Hebrew",
    "Noto Sans Devanagari",
    "Noto Sans Thai",
    "Noto Sans Symbols",
    "DejaVu Sans",
];

/// Where fonts come from. [`FontConfig::from_env`] reads `OC_SYSTEM_FONTS` and `OC_FONT_DIRS`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontConfig {
    /// Load the platform's fonts (`/usr/share/fonts`, `/System/Library/Fonts`, ...).
    pub system: bool,
    /// Extra directories, searched recursively.
    pub dirs: Vec<PathBuf>,
}

impl Default for FontConfig {
    fn default() -> Self {
        Self {
            system: true,
            dirs: Vec::new(),
        }
    }
}

impl FontConfig {
    pub fn from_env() -> Self {
        let system = !matches!(
            std::env::var("OC_SYSTEM_FONTS").as_deref(),
            Ok("0" | "false" | "no" | "off")
        );
        let dirs = std::env::var("OC_FONT_DIRS")
            .map(|v| {
                v.split(':')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from)
                    .collect()
            })
            .unwrap_or_default();
        Self { system, dirs }
    }
}

/// Builds a database from `config` (embedded fonts are always present).
pub fn build(config: &FontConfig) -> Database {
    let mut db = Database::new();
    db.load_font_data(include_bytes!("../fonts/Geist-Regular.ttf").to_vec());
    db.load_font_data(include_bytes!("../fonts/Geist-SemiBold.ttf").to_vec());
    db.load_font_data(include_bytes!("../fonts/NotoSansSymbols2-Subset.ttf").to_vec());
    db.load_font_data(include_bytes!("../fonts/NotoSansMath-Subset.ttf").to_vec());
    if config.system {
        db.load_system_fonts();
    }
    for dir in &config.dirs {
        if dir.is_dir() {
            db.load_fonts_dir(dir);
        } else {
            tracing::warn!(dir = %dir.display(), "OC_FONT_DIRS entry is not a directory");
        }
    }
    db.set_sans_serif_family(PRIMARY_FAMILY);
    db.set_serif_family(PRIMARY_FAMILY);
    db.set_monospace_family(PRIMARY_FAMILY);
    db.set_cursive_family(PRIMARY_FAMILY);
    db.set_fantasy_family(PRIMARY_FAMILY);
    db
}

static DB: OnceLock<Arc<Database>> = OnceLock::new();

/// The process-wide database, built from the environment on first use.
pub fn database() -> Arc<Database> {
    DB.get_or_init(|| {
        let config = FontConfig::from_env();
        let db = build(&config);
        tracing::info!(
            faces = db.len(),
            system = config.system,
            dirs = config.dirs.len(),
            "font database loaded"
        );
        Arc::new(db)
    })
    .clone()
}

fn has_char(db: &Database, id: ID, c: char) -> bool {
    db.with_face_data(id, |data, index| {
        use skrifa::MetadataProvider as _;
        skrifa::FontRef::from_index(data, index)
            .ok()
            .and_then(|f| f.charmap().map(c))
            .is_some()
    })
    .unwrap_or(false)
}

/// Faces in fallback order: embedded symbol fonts and [`FALLBACK_FAMILIES`] first, then the
/// rest in load order.
fn ordered_faces(db: &Database, weight: u16) -> Vec<ID> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for family in FALLBACK_FAMILIES {
        let mut faces: Vec<_> = db
            .faces()
            .filter(|f| f.families.iter().any(|(n, _)| n == family))
            .collect();
        // Upright, normal width, then nearest weight (Noto Sans ships condensed and italic
        // faces under the same family name).
        faces.sort_by_key(|f| {
            (
                f.style != Style::Normal,
                f.stretch != Stretch::Normal,
                (f.weight.0 as i32 - weight as i32).abs(),
            )
        });
        for f in faces {
            if seen.insert(f.id) {
                out.push(f.id);
            }
        }
    }
    out.extend(db.faces().map(|f| f.id).filter(|id| seen.insert(*id)));
    out
}

fn first_with(db: &Database, c: char, weight: u16, exclude: &[ID]) -> Option<ID> {
    ordered_faces(db, weight)
        .into_iter()
        .filter(|id| !exclude.contains(id))
        .find(|&id| has_char(db, id, c))
}

/// Whether some face in the process database has `c` (cached per character).
fn covered(c: char) -> bool {
    static CACHE: OnceLock<Mutex<HashMap<char, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(&hit) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&c) {
        return hit;
    }
    let db = database();
    let hit = db.faces().any(|f| has_char(&db, f.id, c));
    cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(c, hit);
    hit
}

fn needs_glyph(c: char) -> bool {
    !c.is_whitespace()
        && !c.is_control()
        && !matches!(c, '\u{200B}'..='\u{200F}' | '\u{FE00}'..='\u{FE0F}')
}

/// The characters of `text` (in order, without repeats) that no loaded font can draw.
/// Whitespace, controls, zero-width marks and variation selectors are ignored.
pub fn coverage(text: &str) -> Vec<char> {
    let mut seen = HashSet::new();
    text.chars()
        .filter(|&c| needs_glyph(c) && seen.insert(c))
        .filter(|&c| !covered(c))
        .collect()
}

/// Logs once per script (per process) that a character could not be drawn. Never logs the
/// text itself (AGENTS.md rule 9), only the script and code point.
fn warn_missing(c: char) {
    static WARNED: OnceLock<Mutex<HashSet<Script>>> = OnceLock::new();
    let script = c.script();
    let first = WARNED
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(script);
    if first {
        tracing::warn!(
            script = script.full_name(),
            codepoint = format!("U+{:04X}", c as u32),
            "no font for this script; it renders as boxes. Install fonts (e.g. fonts-noto-core, \
             fonts-noto-cjk) or point OC_FONT_DIRS at them"
        );
    }
}

/// usvg fallback: preferred families first, then any face; warns when nothing has the glyph.
pub fn fallback_selector() -> FallbackSelectionFn<'static> {
    Box::new(|c, used, db| {
        let weight = used
            .first()
            .and_then(|id| db.face(*id))
            .map(|f| f.weight.0)
            .unwrap_or(Weight::NORMAL.0);
        let found = first_with(db, c, weight, used);
        if found.is_none() && needs_glyph(c) {
            warn_missing(c);
        }
        found
    })
}

/// The resolver `board::to_png` uses: usvg's family matching plus [`fallback_selector`].
pub fn resolver() -> FontResolver<'static> {
    FontResolver {
        select_font: FontResolver::default_font_selector(),
        select_fallback: fallback_selector(),
    }
}
