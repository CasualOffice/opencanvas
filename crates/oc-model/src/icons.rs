// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Built-in diagram icons (DGM-17): the generic set in `icons/generic.json` at the repo root,
//! shared with the web editor (`web/packages/board/src/icons.ts`). Generic only: Lucide (ISC) or
//! drawn by OpenCanvas. Each icon is SVG path data in a 24 × 24 box, drawn stroked; exports
//! inline those paths, so an icon never makes a renderer fetch anything.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

const RAW: &str = include_str!("../../../icons/generic.json");

/// One built-in icon.
#[derive(Debug, Clone, Deserialize)]
pub struct Icon {
    pub id: String,
    pub name: String,
    pub category: String,
    pub keywords: Vec<String>,
    pub paths: Vec<String>,
}

#[derive(Deserialize)]
struct Data {
    icons: Vec<Icon>,
}

/// Path data only: the characters of SVG path syntax, no markup, bounded length.
pub fn is_path_data(d: &str) -> bool {
    !d.is_empty()
        && d.len() <= 2000
        && d.bytes()
            .all(|b| b"MLHVCSQTAZmlhvcsqtaz0123456789 ,.-".contains(&b))
}

fn table() -> &'static HashMap<String, Icon> {
    static T: OnceLock<HashMap<String, Icon>> = OnceLock::new();
    T.get_or_init(|| {
        let d: Data = serde_json::from_str(RAW).expect("icons/generic.json is valid");
        d.icons
            .into_iter()
            // Checked here too, so a bad edit of the data file can never put markup in an export.
            .filter(|i| i.paths.iter().all(|p| is_path_data(p)))
            .map(|i| (i.id.clone(), i))
            .collect()
    })
}

/// The built-in icon with this id.
pub fn get(id: &str) -> Option<&'static Icon> {
    table().get(id)
}

/// Every built-in icon id.
pub fn ids() -> Vec<&'static str> {
    table().keys().map(String::as_str).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_the_shared_generic_set() {
        assert_eq!(ids().len(), 59);
        let s3 = get("object-storage").unwrap();
        assert!(s3.keywords.iter().any(|k| k == "s3"));
        assert!(get("jitsi").is_none());
        assert!(is_path_data("M2 6h3.5l4 6"));
        assert!(!is_path_data("M0 0\"/><script>"));
    }
}
