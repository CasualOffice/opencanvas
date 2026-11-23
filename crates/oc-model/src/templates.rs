// SPDX-License-Identifier: Apache-2.0
//! The editor's built-in templates as document JSON, so a host can start every canvas from
//! one by name (`template = "meeting"`). The file is the editor's own export, kept in sync by
//! `web/packages/editor/src/templates.fixture.test.ts`; `tests/templates.rs` validates it.

use serde_json::Value;
use std::sync::OnceLock;

const RAW: &str = include_str!("../tests/fixtures/templates.json");

fn all() -> &'static serde_json::Map<String, Value> {
    static ALL: OnceLock<serde_json::Map<String, Value>> = OnceLock::new();
    ALL.get_or_init(|| serde_json::from_str(RAW).expect("built-in templates are valid JSON"))
}

/// The document JSON of the built-in template `id`, if there is one.
pub fn builtin(id: &str) -> Option<&'static Value> {
    all().get(id)
}

/// The ids of every built-in template, sorted.
pub fn ids() -> Vec<&'static str> {
    let mut v: Vec<&str> = all().keys().map(String::as_str).collect();
    v.sort_unstable();
    v
}
