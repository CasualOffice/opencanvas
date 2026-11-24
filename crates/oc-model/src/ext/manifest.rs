// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `block.json`: a block package's manifest (BSDK-01, docs/27 §3.2, docs/15 §4.2).

use serde::Serialize;
use serde_json::{Value, json};

use super::migrate::Migrations;
use super::schema::Schema;
use super::template::Template;

/// Largest `block.json` read.
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;

const KEYS: &[&str] = &[
    "type",
    "version",
    "title",
    "icon",
    "content",
    "attrs",
    "data",
    "export",
    "permissions",
    "migrations",
    "entry",
    "integrity",
    "description",
];

/// What an `extBlock` holds as children.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContentKind {
    None,
    /// Inline content, stored in one paragraph child (one ProseMirror node type serves every
    /// block, so its content expression is `block*`).
    Inline,
    Blocks,
}

#[derive(Debug, Clone)]
pub struct Manifest {
    pub ty: String,
    pub version: semver::Version,
    pub title: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub content: ContentKind,
    pub attrs: Schema,
    pub attrs_json: Value,
    pub data: Option<Schema>,
    pub data_json: Option<Value>,
    pub markdown: Option<Template>,
    pub text: Option<Template>,
    /// Requested origins for the sandbox's `connect-src` (`https://host[:port]`).
    pub network: Vec<String>,
    /// `members: "read"` requested.
    pub members_read: bool,
    pub migrations: Migrations,
    /// `export` and `migrations` as written (the editor runs the same declarative engines).
    pub export_json: Value,
    pub migrations_json: Value,
    /// Path of the browser bundle inside the package.
    pub entry: String,
    /// `sha384-<base64>` of the bundle (SRI).
    pub integrity: String,
    /// Keys this server does not know (kept, reported once at install).
    pub unknown_keys: Vec<String>,
}

/// Type names: reverse-DNS-like, lowercase, at least two dot-separated labels of
/// `[a-z][a-z0-9-]*`, at most 100 characters (`acme.okr`, `com.example.ticket-card`).
pub fn check_type_name(t: &str) -> Result<(), String> {
    let ok = t.len() <= 100
        && t.split('.').count() >= 2
        && t.split('.').all(|l| {
            l.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                && l.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && !l.ends_with('-')
        });
    if ok {
        Ok(())
    } else {
        Err(format!(
            "type {t:?} must be lowercase reverse-DNS labels like \"acme.okr\" ([a-z][a-z0-9-]*, joined by dots, ≤ 100 characters)"
        ))
    }
}

/// `oc.` types are OpenCanvas's own (first-party blocks on the contract, BSDK-04).
pub fn is_reserved(t: &str) -> bool {
    t == "oc" || t.starts_with("oc.")
}

/// A relative path inside the package: no `..`, no absolute path, no backslash.
pub fn safe_rel_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 200
        && !p.starts_with('/')
        && !p.contains('\\')
        && p.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
        && p.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'))
}

fn origin_ok(o: &str) -> bool {
    let Some(rest) = o.strip_prefix("https://") else {
        return false;
    };
    !rest.is_empty()
        && !rest.contains(['/', '?', '#', '@', '*', ' '])
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'))
}

fn str_of<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> {
    v.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{k} must be a string"))
}

fn object_schema(v: &Value, what: &str) -> Result<Schema, String> {
    if !Schema::is_object_schema(v) {
        return Err(format!(
            "{what} must be a JSON Schema with \"type\": \"object\""
        ));
    }
    Schema::compile(v).map_err(|e| format!("{what}: {e}"))
}

impl Manifest {
    /// Parses and checks a manifest. `first_party` allows the reserved `oc.` prefix.
    pub fn parse(bytes: &[u8], first_party: bool) -> Result<Self, String> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(format!(
                "block.json is larger than {MAX_MANIFEST_BYTES} bytes"
            ));
        }
        let v: Value = serde_json::from_slice(bytes).map_err(|e| format!("block.json: {e}"))?;
        Self::from_json(&v, first_party)
    }

    pub fn from_json(v: &Value, first_party: bool) -> Result<Self, String> {
        let m = v.as_object().ok_or("block.json must be a JSON object")?;
        let ty = str_of(v, "type")?.to_string();
        check_type_name(&ty)?;
        if is_reserved(&ty) && !first_party {
            return Err(format!(
                "type {ty:?}: the \"oc.\" prefix is reserved for OpenCanvas"
            ));
        }
        let version = semver::Version::parse(str_of(v, "version")?)
            .map_err(|e| format!("version must be SemVer (\"1.2.0\"): {e}"))?;
        if version.major == 0 {
            return Err("version: the data contract starts at major 1".into());
        }
        let title = str_of(v, "title")?.trim().to_string();
        if title.is_empty() || title.chars().count() > 80 {
            return Err("title must be 1-80 characters".into());
        }
        let icon = match v.get("icon") {
            None | Some(Value::Null) => None,
            Some(Value::String(i))
                if !i.is_empty()
                    && i.len() <= 64
                    && i.bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') =>
            {
                Some(i.clone())
            }
            Some(_) => return Err("icon must be a Lucide icon name (\"target\")".into()),
        };
        let description = match v.get("description") {
            None | Some(Value::Null) => None,
            Some(Value::String(d)) if d.chars().count() <= 500 => Some(d.clone()),
            Some(_) => return Err("description must be at most 500 characters".into()),
        };
        let content = match v.get("content").and_then(Value::as_str) {
            None if v.get("content").is_none() => ContentKind::None,
            Some("none") => ContentKind::None,
            Some("inline") => ContentKind::Inline,
            Some("blocks") => ContentKind::Blocks,
            _ => return Err("content must be \"none\", \"inline\" or \"blocks\"".into()),
        };
        let attrs_json = v
            .get("attrs")
            .cloned()
            .unwrap_or_else(|| json!({"type": "object"}));
        let attrs = object_schema(&attrs_json, "attrs")?;
        // Templates see the block's data under `data`, so attrs cannot use that name.
        if attrs_json
            .get("properties")
            .and_then(Value::as_object)
            .is_some_and(|p| p.contains_key("data"))
        {
            return Err("attrs: the property name \"data\" is reserved (templates read the block's data under it)".into());
        }
        let (data, data_json) = match v.get("data") {
            None | Some(Value::Null) => (None, None),
            Some(d) => {
                if d.get("kind").and_then(Value::as_str) != Some("map") {
                    return Err("data.kind must be \"map\"".into());
                }
                let s = d
                    .get("schema")
                    .cloned()
                    .unwrap_or_else(|| json!({"type": "object"}));
                (Some(object_schema(&s, "data.schema")?), Some(s))
            }
        };
        let (mut markdown, mut text) = (None, None);
        if let Some(e) = v.get("export") {
            let e = e.as_object().ok_or("export must be an object")?;
            for (k, t) in e {
                let src = t
                    .as_str()
                    .ok_or_else(|| format!("export.{k} must be a template string"))?;
                let parsed = Template::parse(src).map_err(|err| format!("export.{k}: {err}"))?;
                match k.as_str() {
                    "markdown" => markdown = Some(parsed),
                    "text" => text = Some(parsed),
                    other => {
                        return Err(format!(
                            "export.{other}: only markdown and text templates exist (HTML, DOCX and PDF use the markdown one)"
                        ));
                    }
                }
            }
        }
        let mut network = Vec::new();
        let mut members_read = false;
        if let Some(p) = v.get("permissions") {
            let p = p.as_object().ok_or("permissions must be an object")?;
            for (k, val) in p {
                match k.as_str() {
                    "network" => {
                        for o in val.as_array().ok_or("permissions.network must be a list")? {
                            let o = o.as_str().unwrap_or_default();
                            if !origin_ok(o) {
                                return Err(format!(
                                    "permissions.network: {o:?} must be an https origin (https://host[:port], no path or wildcard)"
                                ));
                            }
                            network.push(o.to_string());
                        }
                    }
                    "members" => match val {
                        Value::String(s) if s == "read" => members_read = true,
                        Value::Null => {}
                        Value::String(s) if s == "none" => {}
                        _ => return Err("permissions.members must be \"read\" or \"none\"".into()),
                    },
                    other => return Err(format!("permissions.{other} is not a known permission")),
                }
            }
        }
        let migrations = Migrations::parse(v.get("migrations"))?;
        if let Migrations::Script(p) = &migrations
            && !safe_rel_path(p)
        {
            return Err(format!(
                "migrations: {p:?} must be a relative path inside the package"
            ));
        }
        if let Migrations::Declarative(steps) = &migrations
            && let Some(k) = steps.keys().find(|k| **k >= version.major)
        {
            return Err(format!(
                "migrations.{k}: this package's data version is {}, so steps go from 1 to {}",
                version.major,
                version.major - 1
            ));
        }
        // A new major is a breaking change: older data must have a way forward.
        if !migrations.covers(1, version.major) {
            return Err(format!(
                "version {} is a major above 1 without a migration for every step from 1 to {}",
                version, version.major
            ));
        }
        let entry = str_of(v, "entry")?.to_string();
        if !safe_rel_path(&entry) || !entry.ends_with(".js") {
            return Err("entry must be a relative path to a .js file inside the package".into());
        }
        let integrity = str_of(v, "integrity")?.to_string();
        if !integrity_ok(&integrity) {
            return Err(
                "integrity must be \"sha384-<base64 of 48 bytes>\" (Subresource Integrity)".into(),
            );
        }
        let unknown_keys = m
            .keys()
            .filter(|k| !KEYS.contains(&k.as_str()))
            .cloned()
            .collect();
        Ok(Self {
            ty,
            version,
            title,
            icon,
            description,
            content,
            attrs,
            attrs_json,
            data,
            data_json,
            markdown,
            text,
            network,
            members_read,
            migrations,
            export_json: v.get("export").cloned().unwrap_or(Value::Null),
            migrations_json: v.get("migrations").cloned().unwrap_or(Value::Null),
            entry,
            integrity,
            unknown_keys,
        })
    }

    /// The data version (`extBlock.v`) this package writes: its major.
    pub fn major(&self) -> u64 {
        self.version.major
    }

    /// What the editor and agents see about the type (`blocks` in the session,
    /// `blocks_describe`): never the package path.
    pub fn describe(&self) -> Value {
        json!({
            "type": self.ty,
            "version": self.version.to_string(),
            "v": self.major(),
            "title": self.title,
            "icon": self.icon,
            "description": self.description,
            "content": self.content,
            "attrs": self.attrs_json,
            "data": self.data_json,
            "export": self.export_json,
            "migrations": self.migrations_json,
        })
    }
}

fn integrity_ok(s: &str) -> bool {
    use base64::Engine;
    s.strip_prefix("sha384-").is_some_and(|b| {
        base64::engine::general_purpose::STANDARD
            .decode(b)
            .is_ok_and(|d| d.len() == 48)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn okr() -> Value {
        json!({
            "type": "acme.okr", "version": "1.2.0", "title": "OKR", "icon": "target",
            "content": "none",
            "attrs": {"$schema": "https://json-schema.org/draft/2020-12/schema",
                      "type": "object", "additionalProperties": false,
                      "properties": {"objective": {"type": "string", "maxLength": 500},
                                     "progress": {"type": "number", "minimum": 0, "maximum": 1}},
                      "required": ["objective"]},
            "data": {"kind": "map", "schema": {"type": "object"}},
            "export": {"markdown": "**{{objective}}** ({{progress|percent}})", "text": "{{objective}}"},
            "permissions": {"network": ["https://okr.acme.example"], "members": "read"},
            "entry": "block.js",
            "integrity": format!("sha384-{}", "A".repeat(64))
        })
    }

    #[test]
    fn the_design_example_parses() {
        let m = Manifest::from_json(&okr(), false).unwrap();
        assert_eq!(m.ty, "acme.okr");
        assert_eq!(m.major(), 1);
        assert!(m.members_read);
        assert_eq!(m.network, ["https://okr.acme.example"]);
        assert!(m.markdown.is_some() && m.text.is_some());
    }

    #[test]
    fn type_names_follow_the_rules() {
        for ok in ["acme.okr", "com.example.ticket-card", "a1.b2"] {
            assert!(check_type_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "okr",
            "Acme.okr",
            "acme..okr",
            "acme.okr-",
            "acme._x",
            ".acme",
            "acme.1x",
            "acme.ok r",
        ] {
            assert!(check_type_name(bad).is_err(), "{bad}");
        }
        let mut v = okr();
        v["type"] = json!("oc.progress");
        assert!(
            Manifest::from_json(&v, false)
                .unwrap_err()
                .contains("reserved")
        );
        assert!(Manifest::from_json(&v, true).is_ok());
    }

    #[test]
    fn unsafe_or_incomplete_manifests_are_refused() {
        let cases: Vec<(&str, Value)> = vec![
            ("entry", json!("../evil.js")),
            ("entry", json!("/abs.js")),
            ("integrity", json!("sha256-abc")),
            ("version", json!("2.0.0")), // a new major without a migration
            ("version", json!("0.3.0")),
            ("permissions", json!({"network": ["http://plain.example"]})),
            ("permissions", json!({"network": ["https://*.example"]})),
            ("permissions", json!({"cookies": true})),
            ("export", json!({"html": "<b>{{objective}}</b>"})),
            ("export", json!({"markdown": "{{{objective}}}"})),
            (
                "attrs",
                json!({"type": "object", "properties": {"data": {}}}),
            ),
            ("attrs", json!({"type": "string"})),
            ("migrations", json!({"1": []})), // version 1 has nothing to migrate to
        ];
        for (k, val) in cases {
            let mut v = okr();
            v[k] = val.clone();
            assert!(Manifest::from_json(&v, false).is_err(), "{k} = {val}");
        }
        let mut v = okr();
        v["version"] = json!("2.0.0");
        v["migrations"] = json!({"1": [{"op": "default", "path": "/attrs/progress", "value": 0}]});
        assert_eq!(Manifest::from_json(&v, false).unwrap().major(), 2);
    }
}
