// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `[host.editor]` (EDP-01, ADR-061, docs/05 §2b): editor profiles. One engine, many
//! experiences: a profile picks which block types the insertion surfaces offer (the / menu, the
//! "+" and phone insert sheets, markdown shortcuts) and `features` turn whole surfaces off.
//!
//! **Hide, never delete.** A profile only hides blocks from insertion. Content of any type always
//! loads, renders, stays editable and round-trips; nothing here reads or changes a document.

use anyhow::{Context, bail};
use serde_json::{Value, json};

/// Stable ids of every block an editor can insert (docs/15 §2 `editor.blocks`). `kanban` and
/// `calendar` are database views (they insert through the Database entry); `diagram` and
/// `shapes` are whiteboard modes (through the Whiteboard entry). `import` and `assistant` are
/// actions, also behind the `import` and `ai` features.
pub const CORE_BLOCKS: &[&str] = &[
    "core.text",
    "core.heading",
    "core.checklist",
    "core.bulleted_list",
    "core.numbered_list",
    "core.toggle",
    "core.quote",
    "core.callout",
    "core.divider",
    "core.code",
    "core.database",
    "core.kanban",
    "core.calendar",
    "core.table",
    "core.image",
    "core.file",
    "core.date",
    "core.link_preview",
    "core.embed",
    "core.whiteboard",
    "core.diagram",
    "core.shapes",
    "core.columns",
    "core.import",
    "core.assistant",
];

/// The profile names, default `full` (every block: today's behaviour).
pub const PROFILES: &[&str] = &[
    "notebook",
    "meeting",
    "project",
    "diagramming",
    "document",
    "full",
];

/// `[host.editor.features]` keys.
pub const FEATURES: &[&str] = &[
    "comments",
    "version_history",
    "ai",
    "diagramming",
    "templates",
    "import",
];

/// Always offered: an editor without plain text is not usable.
pub const ALWAYS: &str = "core.text";

/// Actions every profile keeps; their features (`import`, `ai`) decide whether they show.
const ACTIONS: &[&str] = &["core.import", "core.assistant"];

/// A profile's default block set (the owner's proposal, 2026-11-25), before [`ALWAYS`] and
/// [`ACTIONS`]. Additions to the proposal, so each profile is usable, are marked `+`.
pub fn profile_blocks(profile: &str) -> Vec<&'static str> {
    let own: &[&str] = match profile {
        // text, lists, images, links, callouts (+ heading)
        "notebook" => &[
            "core.text",
            "core.heading",
            "core.bulleted_list",
            "core.numbered_list",
            "core.checklist",
            "core.image",
            "core.link_preview",
            "core.callout",
        ],
        // agenda / notes / decisions / tasks (+ date, for due dates)
        "meeting" => &[
            "core.text",
            "core.heading",
            "core.checklist",
            "core.bulleted_list",
            "core.numbered_list",
            "core.callout",
            "core.divider",
            "core.table",
            "core.date",
        ],
        // database, kanban, calendar, checklist (+ text, heading, date)
        "project" => &[
            "core.text",
            "core.heading",
            "core.database",
            "core.kanban",
            "core.calendar",
            "core.checklist",
            "core.date",
        ],
        // whiteboard, diagram, shapes (+ text, heading)
        "diagramming" => &[
            "core.text",
            "core.heading",
            "core.whiteboard",
            "core.diagram",
            "core.shapes",
        ],
        // text, headings, tables, images (+ bulleted and numbered lists, divider)
        "document" => &[
            "core.text",
            "core.heading",
            "core.table",
            "core.image",
            "core.bulleted_list",
            "core.numbered_list",
            "core.divider",
        ],
        _ => CORE_BLOCKS,
    };
    let mut v: Vec<&'static str> = own.to_vec();
    for a in ACTIONS {
        if !v.contains(a) {
            v.push(a);
        }
    }
    v
}

/// `[host.editor.features]`: `None` = not set (the `[host.flags]` / `[host.ai]` aliases decide).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Features {
    pub comments: Option<bool>,
    pub version_history: Option<bool>,
    pub ai: Option<bool>,
    pub diagramming: Option<bool>,
    pub templates: Option<bool>,
    pub import: Option<bool>,
}

/// A host's parsed `[host.editor]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorCfg {
    pub profile: String,
    pub allow_profile_switch: bool,
    /// The block ids insertion surfaces offer: the profile's set, or `[host.editor.blocks]
    /// enabled`; always with `core.text`.
    pub blocks: Vec<String>,
    pub quick_insert: Vec<String>,
    pub features: Features,
}

impl Default for EditorCfg {
    fn default() -> Self {
        Self {
            profile: "full".into(),
            allow_profile_switch: false,
            blocks: profile_blocks("full")
                .into_iter()
                .map(String::from)
                .collect(),
            quick_insert: vec![],
            features: Features::default(),
        }
    }
}

fn bool_of(v: &toml::Value, what: &str) -> anyhow::Result<bool> {
    v.as_bool()
        .with_context(|| format!("[host.editor] {what} takes true or false"))
}

fn ids_of(v: &toml::Value, what: &str) -> anyhow::Result<Vec<String>> {
    let list = v
        .as_array()
        .with_context(|| format!("[host.editor.blocks] {what} takes a list of block ids"))?;
    list.iter()
        .map(|e| {
            e.as_str()
                .map(String::from)
                .with_context(|| format!("[host.editor.blocks] {what} takes a list of block ids"))
        })
        .collect()
}

impl EditorCfg {
    /// Parses and checks `[host.editor]`; `sdk_types` are the types this host enables in
    /// `[host.blocks]` (the only non-`core.` ids a block list may name). Any unknown profile,
    /// key, block id or feature is an error, so the server refuses to start.
    pub fn parse(t: &toml::Table, sdk_types: &[String]) -> anyhow::Result<Self> {
        let mut cfg = Self::default();
        for k in t.keys() {
            if !matches!(
                k.as_str(),
                "profile" | "allow_profile_switch" | "blocks" | "features"
            ) {
                bail!(
                    "[host.editor] {k} is not a setting (profile, allow_profile_switch, blocks, features)"
                );
            }
        }
        if let Some(p) = t.get("profile") {
            let p = p.as_str().context("[host.editor] profile takes a string")?;
            if !PROFILES.contains(&p) {
                bail!(
                    "[host.editor] unknown profile {p:?} (one of: {})",
                    PROFILES.join(", ")
                );
            }
            cfg.profile = p.into();
        }
        if let Some(v) = t.get("allow_profile_switch") {
            cfg.allow_profile_switch = bool_of(v, "allow_profile_switch")?;
        }
        cfg.blocks = profile_blocks(&cfg.profile)
            .into_iter()
            .map(String::from)
            .collect();
        let check = |id: &str, what: &str| -> anyhow::Result<()> {
            let known = if id.starts_with("core.") {
                CORE_BLOCKS.contains(&id)
            } else {
                sdk_types.iter().any(|t| t == id)
            };
            if !known {
                bail!(
                    "[host.editor.blocks] {what}: unknown block id {id:?} (core ids: {}; or an SDK block type enabled in [host.blocks])",
                    CORE_BLOCKS.join(", ")
                );
            }
            Ok(())
        };
        if let Some(b) = t.get("blocks") {
            let b = b
                .as_table()
                .context("[host.editor.blocks] must be a table")?;
            for k in b.keys() {
                if !matches!(k.as_str(), "enabled" | "quick_insert") {
                    bail!("[host.editor.blocks] {k} is not a setting (enabled, quick_insert)");
                }
            }
            if let Some(v) = b.get("enabled") {
                let mut ids = ids_of(v, "enabled")?;
                for id in &ids {
                    check(id, "enabled")?;
                }
                if !ids.iter().any(|i| i == ALWAYS) {
                    ids.insert(0, ALWAYS.into());
                }
                ids.dedup();
                cfg.blocks = ids;
            }
            if let Some(v) = b.get("quick_insert") {
                let ids = ids_of(v, "quick_insert")?;
                for id in &ids {
                    check(id, "quick_insert")?;
                    if !cfg.blocks.contains(id) && !sdk_types.iter().any(|t| t == id) {
                        bail!(
                            "[host.editor.blocks] quick_insert: {id:?} is not enabled in profile {:?}",
                            cfg.profile
                        );
                    }
                }
                cfg.quick_insert = ids;
            }
        }
        if let Some(f) = t.get("features") {
            let f = f
                .as_table()
                .context("[host.editor.features] must be a table")?;
            for (k, v) in f {
                let on = Some(bool_of(v, &format!("features.{k}"))?);
                match k.as_str() {
                    "comments" => cfg.features.comments = on,
                    "version_history" => cfg.features.version_history = on,
                    "ai" => cfg.features.ai = on,
                    "diagramming" => cfg.features.diagramming = on,
                    "templates" => cfg.features.templates = on,
                    "import" => cfg.features.import = on,
                    _ => bail!(
                        "[host.editor.features] unknown feature {k:?} (one of: {})",
                        FEATURES.join(", ")
                    ),
                }
            }
        }
        Ok(cfg)
    }

    /// The session's `editor` (docs/15 §2); `ai` and `import` are the effective host switches
    /// (aliases and server settings included), worked out by the caller.
    pub fn session_json(&self, ai: bool, import: bool) -> Value {
        json!({
            "profile": self.profile,
            "allowProfileSwitch": self.allow_profile_switch,
            "blocks": self.blocks,
            "quickInsert": self.quick_insert,
            "features": {
                "comments": self.features.comments.unwrap_or(true),
                "versionHistory": self.features.version_history.unwrap_or(true),
                "ai": ai,
                "diagramming": self.features.diagramming.unwrap_or(true),
                "templates": self.features.templates.unwrap_or(true),
                "import": import,
            },
        })
    }
}

/// The SDK block types a host enables in `[host.blocks] enabled` (`"type@req"` → `type`).
pub fn sdk_types(blocks: &toml::Table) -> Vec<String> {
    blocks
        .get("enabled")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.split('@').next().unwrap_or(s).to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(src: &str) -> anyhow::Result<EditorCfg> {
        let t: toml::Table = toml::from_str(src).unwrap();
        EditorCfg::parse(&t, &["acme.okr".to_string()])
    }

    #[test]
    fn default_is_full_with_every_core_block() {
        let c = parse("").unwrap();
        assert_eq!(c.profile, "full");
        assert_eq!(c.blocks.len(), CORE_BLOCKS.len());
        assert_eq!(c.features, Features::default());
    }

    #[test]
    fn every_profile_has_text_and_only_known_ids() {
        for p in PROFILES {
            let b = profile_blocks(p);
            assert!(b.contains(&ALWAYS), "{p}");
            for id in &b {
                assert!(CORE_BLOCKS.contains(id), "{p}: {id}");
            }
        }
    }

    #[test]
    fn profiles_follow_the_owners_proposal() {
        let has = |p: &str, ids: &[&str]| {
            let b = profile_blocks(p);
            for id in ids {
                assert!(b.contains(id), "{p} lacks {id}");
            }
        };
        has(
            "notebook",
            &[
                "core.text",
                "core.bulleted_list",
                "core.numbered_list",
                "core.image",
                "core.link_preview",
                "core.callout",
            ],
        );
        has(
            "meeting",
            &[
                "core.text",
                "core.heading",
                "core.checklist",
                "core.bulleted_list",
                "core.numbered_list",
                "core.callout",
                "core.divider",
                "core.table",
            ],
        );
        has(
            "project",
            &[
                "core.database",
                "core.kanban",
                "core.calendar",
                "core.checklist",
            ],
        );
        has(
            "diagramming",
            &["core.whiteboard", "core.diagram", "core.shapes"],
        );
        has(
            "document",
            &["core.text", "core.heading", "core.table", "core.image"],
        );
        assert!(!profile_blocks("meeting").contains(&"core.whiteboard"));
        assert!(!profile_blocks("notebook").contains(&"core.database"));
    }

    #[test]
    fn enabled_overrides_the_profile_and_keeps_text() {
        let c = parse(
            "profile = \"meeting\"\n[blocks]\nenabled = [\"core.checklist\", \"acme.okr\"]\nquick_insert = [\"core.checklist\"]",
        )
        .unwrap();
        assert_eq!(c.blocks, ["core.text", "core.checklist", "acme.okr"]);
        assert_eq!(c.quick_insert, ["core.checklist"]);
    }

    #[test]
    fn unknown_profile_block_or_feature_is_refused_with_a_clear_error() {
        for (src, says) in [
            ("profile = \"notes\"", "unknown profile \"notes\""),
            (
                "[blocks]\nenabled = [\"core.txt\"]",
                "unknown block id \"core.txt\"",
            ),
            (
                "[blocks]\nenabled = [\"other.thing\"]",
                "unknown block id \"other.thing\"",
            ),
            (
                "[blocks]\nquick_insert = [\"core.nope\"]",
                "unknown block id",
            ),
            (
                "profile = \"meeting\"\n[blocks]\nquick_insert = [\"core.whiteboard\"]",
                "not enabled",
            ),
            ("[features]\nchat = true", "unknown feature \"chat\""),
            ("[features]\nai = \"no\"", "takes true or false"),
            ("colour = 1", "colour is not a setting"),
        ] {
            let e = format!("{:#}", parse(src).unwrap_err());
            assert!(e.contains(says), "{src:?}: {e}");
        }
    }

    #[test]
    fn session_json_carries_profile_blocks_and_features() {
        let c = parse("profile = \"notebook\"\n[features]\ncomments = false").unwrap();
        let j = c.session_json(false, true);
        assert_eq!(j["profile"], "notebook");
        assert_eq!(j["features"]["comments"], false);
        assert_eq!(j["features"]["versionHistory"], true);
        assert_eq!(j["features"]["import"], true);
        assert_eq!(j["quickInsert"], json!([]));
        assert!(
            j["blocks"]
                .as_array()
                .unwrap()
                .contains(&json!("core.image"))
        );
    }
}
