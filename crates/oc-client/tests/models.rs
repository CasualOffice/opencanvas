// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `src/models.rs` matches the OpenAPI document (HAPI-07). The models are generated from
//! `crates/oc-server/api/openapi.json` by the small generator below (the same JSON Schema
//! subset as the TypeScript generator); this test regenerates them and fails when the checked-in
//! file differs. `OC_BLESS=1 cargo test -p opencanvas-client --test models` rewrites it.

use std::fmt::Write;

use serde_json::{Map, Value};

const SPEC: &str = include_str!("../../oc-server/api/openapi.json");
const MODELS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/models.rs");

fn snake(s: &str) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    match out.as_str() {
        "type" | "ref" | "self" | "match" | "mod" | "use" => format!("{out}_"),
        _ => out,
    }
}

/// The Rust type of a schema; `None` for `null` alone.
fn rust_type(s: &Value) -> String {
    if let Some(r) = s["$ref"].as_str() {
        return r.rsplit('/').next().unwrap().to_string();
    }
    let types: Vec<&str> = match &s["type"] {
        Value::String(t) => vec![t.as_str()],
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
        _ => vec![],
    };
    let nullable = types.contains(&"null");
    let rest: Vec<&str> = types.into_iter().filter(|t| *t != "null").collect();
    let base = match rest.as_slice() {
        ["string"] => "String".to_string(),
        ["integer"] => "i64".to_string(),
        ["number"] => "f64".to_string(),
        ["boolean"] => "bool".to_string(),
        ["array"] => format!(
            "Vec<{}>",
            if s["items"].is_object() {
                rust_type(&s["items"])
            } else {
                "Value".into()
            }
        ),
        // Objects without their own name stay JSON: inline shapes change additively.
        ["object"] if s.get("properties").is_none() => "Map<String, Value>".to_string(),
        _ => "Value".to_string(),
    };
    if nullable {
        format!("Option<{base}>")
    } else {
        base
    }
}

fn doc(out: &mut String, text: Option<&str>, indent: &str) {
    if let Some(t) = text {
        let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
        writeln!(out, "{indent}/// {t}").unwrap();
    }
}

fn resolve<'a>(spec: &'a Value, p: &'a Value) -> &'a Value {
    match p["$ref"].as_str() {
        Some(r) => spec.pointer(r.trim_start_matches('#')).unwrap(),
        None => p,
    }
}

fn generate(spec: &Value) -> String {
    let mut out = String::from(
        "// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! GENERATED from `crates/oc-server/api/openapi.json` by `tests/models.rs`. Do not edit; run
//! `OC_BLESS=1 cargo test -p opencanvas-client --test models` after changing the document.

#![allow(clippy::all)]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

",
    );
    writeln!(
        out,
        "/// The OpenAPI document version these models come from.\npub const API_VERSION: &str = {:?};\n",
        spec["info"]["version"].as_str().unwrap()
    )
    .unwrap();
    for (name, s) in spec["components"]["schemas"].as_object().unwrap() {
        doc(&mut out, s["description"].as_str(), "");
        writeln!(
            out,
            "#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]\npub struct {name} {{"
        )
        .unwrap();
        let required: Vec<&str> = s["required"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let empty = Map::new();
        for (field, fs) in s["properties"].as_object().unwrap_or(&empty) {
            doc(&mut out, fs["description"].as_str(), "    ");
            let rname = snake(field);
            let mut ty = rust_type(fs);
            let mut attrs = vec![];
            if rname != *field {
                attrs.push(format!("rename = {field:?}"));
            }
            if !required.contains(&field.as_str()) {
                if ty == "Value" {
                    attrs.push("default, skip_serializing_if = \"Value::is_null\"".into());
                } else if !ty.starts_with("Option<") {
                    ty = format!("Option<{ty}>");
                    attrs.push("default, skip_serializing_if = \"Option::is_none\"".into());
                } else {
                    attrs.push("default, skip_serializing_if = \"Option::is_none\"".into());
                }
            } else if ty.starts_with("Option<") {
                attrs.push("default".into());
            }
            if !attrs.is_empty() {
                writeln!(out, "    #[serde({})]", attrs.join(", ")).unwrap();
            }
            writeln!(out, "    pub {rname}: {ty},").unwrap();
        }
        if s["additionalProperties"] == Value::Bool(true) {
            writeln!(
                out,
                "    /// Members the document does not name.\n    #[serde(flatten)]\n    pub extra: Map<String, Value>,"
            )
            .unwrap();
        }
        out.push_str("}\n\n");
    }
    out.push_str(
        "/// How an operation sends its body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyKind {
    None,
    Json,
    Binary,
}

/// What an operation answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseKind {
    Json,
    Binary,
    Stream,
}

/// One `/api/v1` operation of the document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Operation {
    pub id: &'static str,
    pub method: &'static str,
    pub path: &'static str,
    /// The least scope a user token needs (`x-opencanvas-scope`).
    pub scope: Option<&'static str>,
    pub path_params: &'static [&'static str],
    pub query: &'static [&'static str],
    pub body: BodyKind,
    pub response: ResponseKind,
    /// Paged operations: the array the items come in.
    pub paged: Option<&'static str>,
    /// Takes `Idempotency-Key` (the client sends one on every call).
    pub idempotent: bool,
}

/// Every `/api/v1` operation (the 0.1 aliases are not part of the client).
pub const OPERATIONS: &[Operation] = &[
",
    );
    for (path, item) in spec["paths"].as_object().unwrap() {
        if !path.starts_with("/api/v1/") {
            continue;
        }
        for (method, op) in item.as_object().unwrap() {
            let params: Vec<&Value> = op["parameters"]
                .as_array()
                .map(|a| a.iter().map(|p| resolve(spec, p)).collect())
                .unwrap_or_default();
            let names = |kind: &str| -> Vec<String> {
                params
                    .iter()
                    .filter(|p| p["in"] == kind)
                    .map(|p| p["name"].as_str().unwrap().to_string())
                    .collect()
            };
            let req = &op["requestBody"]["content"];
            let body = if req.get("application/json").is_some() {
                "Json"
            } else if req.get("application/octet-stream").is_some() {
                "Binary"
            } else {
                "None"
            };
            let ok = op["responses"]
                .as_object()
                .unwrap()
                .iter()
                .find(|(c, _)| c.len() == 3 && c.starts_with('2'))
                .map(|(_, r)| &r["content"])
                .cloned()
                .unwrap_or(Value::Null);
            let response = if ok.get("application/json").is_some() {
                "Json"
            } else if ok.get("text/event-stream").is_some() {
                "Stream"
            } else {
                "Binary"
            };
            let mut schema = ok["application/json"]["schema"].clone();
            if let Some(r) = schema["$ref"].as_str() {
                schema = spec.pointer(r.trim_start_matches('#')).unwrap().clone();
            }
            let query = names("query");
            let paged = (query.iter().any(|q| q == "cursor")
                && schema["properties"].get("next_cursor").is_some())
            .then(|| {
                schema["properties"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .find(|(_, v)| {
                        v["type"] == "array"
                            || v["type"]
                                .as_array()
                                .is_some_and(|a| a.contains(&Value::from("array")))
                    })
                    .map(|(k, _)| k.clone())
            })
            .flatten();
            let idempotent = params.iter().any(|p| p["name"] == "Idempotency-Key");
            writeln!(
                out,
                "    Operation {{ id: {:?}, method: {:?}, path: {path:?}, scope: {:?}, path_params: &{:?}, query: &{:?}, body: BodyKind::{body}, response: ResponseKind::{response}, paged: {:?}, idempotent: {idempotent} }},",
                op["operationId"].as_str().unwrap(),
                method.to_ascii_uppercase(),
                op["x-opencanvas-scope"].as_str(),
                names("path"),
                query,
                paged,
            )
            .unwrap();
        }
    }
    out.push_str(
        "];

/// The operation with this `operationId`.
pub fn operation(id: &str) -> Option<&'static Operation> {
    OPERATIONS.iter().find(|o| o.id == id)
}
",
    );
    out
}

/// The generated code as `cargo fmt` leaves it (the file is formatted with the workspace).
fn rustfmt(code: &str) -> String {
    use std::io::Write as _;
    let mut child = std::process::Command::new("rustfmt")
        .args(["--edition", "2024", "--emit", "stdout"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("rustfmt (rustup component add rustfmt)");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(code.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "rustfmt failed on the generated models"
    );
    String::from_utf8(out.stdout).unwrap()
}

#[test]
fn models_match_the_openapi_document() {
    let spec: Value = serde_json::from_str(SPEC).unwrap();
    let want = rustfmt(&generate(&spec));
    if std::env::var("OC_BLESS").is_ok_and(|v| v == "1") {
        std::fs::write(MODELS, &want).unwrap();
        return;
    }
    let have = std::fs::read_to_string(MODELS).unwrap_or_default();
    assert!(
        have == want,
        "src/models.rs does not match openapi.json; run `OC_BLESS=1 cargo test -p opencanvas-client --test models`"
    );
}

/// The checked-in models deserialize what the document says operations answer.
#[test]
fn every_document_operation_is_in_the_table() {
    let spec: Value = serde_json::from_str(SPEC).unwrap();
    let mut n = 0;
    for (path, item) in spec["paths"].as_object().unwrap() {
        for (method, op) in item.as_object().unwrap() {
            let id = op["operationId"].as_str().unwrap();
            let found = opencanvas_client::models::operation(id);
            if path.starts_with("/api/v1/") {
                let o = found.unwrap_or_else(|| panic!("{id} missing"));
                assert_eq!(o.path, path);
                assert_eq!(o.method, method.to_ascii_uppercase());
                n += 1;
            } else {
                assert!(
                    found.is_none(),
                    "{id}: 0.1 aliases are not client operations"
                );
            }
        }
    }
    assert_eq!(n, opencanvas_client::models::OPERATIONS.len());
}
