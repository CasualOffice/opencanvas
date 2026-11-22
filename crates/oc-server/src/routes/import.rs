// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Server-side import (docs/23 FC-10): `POST /v1/import?format=md|html|csv&ticket=` from the
//! editor session and `POST /v1/files/:fileId/import?format=&author=` from the host. The body
//! is the file. Markdown and HTML become blocks (`oc-model` converters; HTML through the same
//! URL rules as the editor: scripts, styles, event attributes and unsafe links are dropped);
//! CSV becomes one database block with detected field types. Either lands after `blockId`, or
//! at the end, as one Yjs transaction through the room. Edit role only.
//!
//! Gate: `[host.flags] import_formats` (absent or empty: off) and `OC_IMPORT=off` for all.

use std::collections::HashSet;
use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::api::{Author, api_grant, authenticate, callback_token, patch_error, save_if_idle};
use super::{ApiError, session};
use crate::SharedState;
use crate::ai::tools::{LiveTools, ToolCtx, ToolError, WriteMode};
use crate::grant::{Grant, Role};
use crate::hosts::{HostConfig, IMPORT_FORMATS};

/// Largest import body.
pub const MAX_IMPORT_BYTES: usize = 5 * 1024 * 1024;
/// Most CSV columns.
pub const MAX_IMPORT_COLUMNS: usize = 200;
/// Most CSV data rows (the header row aside).
pub const MAX_IMPORT_ROWS: usize = crate::ai::tools::MAX_IMPORT_ROWS;
/// At most this many distinct values (and each used twice on average) make a `select`.
const SELECT_MAX_OPTIONS: usize = 20;

#[derive(Deserialize)]
pub struct ImportParams {
    #[serde(default)]
    ticket: String,
    #[serde(default)]
    format: String,
    #[serde(default, rename = "blockId")]
    block_id: Option<String>,
    /// Database name for CSV (default "Imported table").
    #[serde(default)]
    name: Option<String>,
    /// Host REST only: who the import is attributed to.
    #[serde(default)]
    author: Option<String>,
    #[serde(default, rename = "authorName")]
    author_name: Option<String>,
    /// CSV only: the field type per column, as chosen in the import dialog (JSON array;
    /// the first column is always `title`). Absent means detected types.
    #[serde(default)]
    types: Option<String>,
}

/// Field types a CSV column may be imported as.
const CSV_TYPES: &[&str] = &["text", "number", "date", "checkbox", "select"];

fn too_large(msg: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "IMPORT_TOO_LARGE", msg)
}

fn invalid(msg: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "IMPORT_INVALID", msg)
}

/// The formats an editor session may import: the host's list unless `OC_IMPORT=off`.
pub fn formats(state: &SharedState, host: &HostConfig, role: Role) -> Vec<String> {
    if state.cfg.import_off || role != Role::Edit {
        return vec![];
    }
    host.import_formats()
}

fn check_format(state: &SharedState, host: &HostConfig, format: &str) -> Result<(), ApiError> {
    if !IMPORT_FORMATS.contains(&format) {
        return Err(invalid(format!(
            "format must be one of {}",
            IMPORT_FORMATS.join(", ")
        )));
    }
    if state.cfg.import_off {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "IMPORT_OFF",
            "import is off on this server",
        ));
    }
    if !host.import_formats().iter().any(|f| f == format) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "IMPORT_OFF",
            format!("this host does not allow {format} import"),
        ));
    }
    Ok(())
}

/// `POST /v1/import?format=&ticket=[&blockId=][&name=]`.
pub async fn import(
    State(state): State<SharedState>,
    Query(p): Query<ImportParams>,
    body: Bytes,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &p.ticket).await?;
    check_format(&state, &host, &p.format)?;
    if grant.role != Role::Edit {
        return Err(ApiError::forbidden("import needs the edit role"));
    }
    let out = run(&state, &host, &grant, &p, &body).await?;
    Ok(Json(out).into_response())
}

/// `POST /v1/files/:fileId/import?format=&author=[&authorName=][&blockId=][&name=]` (host API).
pub async fn host_import(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    Query(p): Query<ImportParams>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let host = authenticate(&state, &headers)?;
    check_format(&state, &host, &p.format)?;
    let author = Author {
        id: p
            .author
            .clone()
            .filter(|a| !a.trim().is_empty())
            .ok_or_else(|| invalid("author is required"))?,
        name: p.author_name.clone(),
    };
    let grant = api_grant(&host, &file_id, &author, callback_token(&headers));
    let live = state.rooms.is_live(&grant.room);
    let mut out = run(&state, &host, &grant, &p, &body).await?;
    out["live"] = json!(live);
    save_if_idle(&state, &host, &grant, out, live).await
}

async fn run(
    state: &SharedState,
    host: &Arc<HostConfig>,
    grant: &Grant,
    p: &ImportParams,
    body: &[u8],
) -> Result<Value, ApiError> {
    if body.len() > MAX_IMPORT_BYTES {
        return Err(too_large(format!(
            "imports are at most {MAX_IMPORT_BYTES} bytes"
        )));
    }
    let text = std::str::from_utf8(body).map_err(|_| invalid("the file must be UTF-8 text"))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let out = match p.format.as_str() {
        "md" | "html" => {
            let doc = if p.format == "md" {
                oc_model::import::markdown_to_json(text)
            } else {
                oc_model::html::html_to_json(text)
            };
            let blocks = doc["content"].as_array().cloned().unwrap_or_default();
            if blocks.is_empty() {
                return Err(invalid("nothing to import"));
            }
            let n = blocks.len();
            let op = match &p.block_id {
                Some(id) => oc_model::patch::PatchOp::InsertAfter {
                    block_id: id.clone(),
                    markdown: None,
                    blocks: Some(blocks),
                },
                None => oc_model::patch::PatchOp::Append {
                    markdown: None,
                    blocks: Some(blocks),
                },
            };
            let patched = state
                .rooms
                .patch(host, grant, vec![op], &grant.user.id)
                .await
                .map_err(ApiError::host)?
                .map_err(patch_error)?;
            json!({"format": p.format, "blocks": n, "blockIds": patched.block_ids})
        }
        _ => {
            let chosen: Option<Vec<String>> = match p.types.as_deref() {
                None | Some("") => None,
                Some(t) => Some(
                    serde_json::from_str(t)
                        .map_err(|_| invalid("types must be a JSON array of strings"))?,
                ),
            };
            let mut input = csv_to_database(text, chosen.as_deref())?;
            input["name"] = json!(p.name.as_deref().unwrap_or("Imported table"));
            if let Some(id) = &p.block_id {
                input["afterBlockId"] = json!(id);
            }
            let rows = input["rows"].as_array().map_or(0, Vec::len);
            let ctx = ToolCtx {
                host_id: host.id.clone(),
                file_id: grant.file.id.clone(),
                user: grant.clone(),
                origin: format!("import:{}", grant.user.id),
                mode_default: WriteMode::Direct,
            };
            let v = LiveTools::new(state.clone())
                .import_csv(&ctx, input)
                .await
                .map_err(tool_error)?;
            json!({"format": "csv", "rows": rows, "dbId": v["dbId"], "blockIds": [v["blockId"]]})
        }
    };
    tracing::info!(host = %host.id, room = %grant.room, format = %p.format, "import");
    Ok(out)
}

fn tool_error(e: ToolError) -> ApiError {
    let status = match &e {
        ToolError::BadInput(_) => StatusCode::BAD_REQUEST,
        ToolError::NotFound(_) => StatusCode::NOT_FOUND,
        ToolError::Forbidden(_) => StatusCode::FORBIDDEN,
        ToolError::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    ApiError::new(status, e.code(), e.message())
}

/// RFC 4180 records: quoted fields, `""` escapes, CRLF or LF.
fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    field.push('"');
                }
                '"' => quoted = false,
                _ => field.push(c),
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => quoted = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' if chars.peek() == Some(&'\n') => {}
            '\n' | '\r' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows.retain(|r| !(r.len() == 1 && r[0].trim().is_empty()));
    rows
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
        && (1..=12).contains(&s[5..7].parse::<u32>().unwrap_or(0))
        && (1..=31).contains(&s[8..10].parse::<u32>().unwrap_or(0))
}

fn as_bool(s: &str) -> Option<bool> {
    match s.to_ascii_lowercase().as_str() {
        "true" | "yes" => Some(true),
        "false" | "no" => Some(false),
        _ => None,
    }
}

fn as_number(s: &str) -> Option<f64> {
    s.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// A column's field type: number, date, checkbox, select (few distinct values, repeated),
/// otherwise text. The first column is the title.
fn detect(values: &[&str]) -> &'static str {
    let vals: Vec<&str> = values.iter().copied().filter(|v| !v.is_empty()).collect();
    if vals.is_empty() {
        return "text";
    }
    if vals.iter().all(|v| as_number(v).is_some()) {
        return "number";
    }
    if vals.iter().all(|v| is_date(v)) {
        return "date";
    }
    if vals.iter().all(|v| as_bool(v).is_some()) {
        return "checkbox";
    }
    let distinct: HashSet<&str> = vals.iter().copied().collect();
    if distinct.len() <= SELECT_MAX_OPTIONS && distinct.len() * 2 <= vals.len() {
        return "select";
    }
    "text"
}

/// CSV text → the `db_create` input `{fields, rows}` (names deduplicated, types detected, or
/// `chosen` per column when the import dialog sent them).
fn csv_to_database(text: &str, chosen: Option<&[String]>) -> Result<Value, ApiError> {
    let records = parse_csv(text);
    let Some((header, data)) = records.split_first() else {
        return Err(invalid("the CSV is empty"));
    };
    if header.len() > MAX_IMPORT_COLUMNS {
        return Err(too_large(format!("at most {MAX_IMPORT_COLUMNS} columns")));
    }
    if data.len() > MAX_IMPORT_ROWS {
        return Err(too_large(format!("at most {MAX_IMPORT_ROWS} rows")));
    }
    let mut seen = HashSet::new();
    let names: Vec<String> = header
        .iter()
        .enumerate()
        .map(|(i, h)| {
            let base = match h.trim() {
                "" => format!("Column {}", i + 1),
                t => t.chars().take(100).collect(),
            };
            let mut name = base.clone();
            let mut n = 2;
            while !seen.insert(name.to_lowercase()) {
                name = format!("{base} {n}");
                n += 1;
            }
            name
        })
        .collect();
    fn cell(r: &[String], c: usize) -> &str {
        r.get(c).map_or("", |v| v.trim())
    }
    if let Some(ch) = chosen {
        if ch.len() != names.len() {
            return Err(invalid(format!(
                "types has {} entries for {} columns",
                ch.len(),
                names.len()
            )));
        }
        if ch[0] != "title" || ch[1..].iter().any(|t| !CSV_TYPES.contains(&t.as_str())) {
            return Err(invalid(format!(
                "types: the first column is title, the others one of {CSV_TYPES:?}"
            )));
        }
    }
    let mut fields = Vec::new();
    let mut types = Vec::new();
    for (c, name) in names.iter().enumerate() {
        let col: Vec<&str> = data.iter().map(|r| cell(r, c)).collect();
        let ty = match chosen {
            Some(ch) => CSV_TYPES
                .iter()
                .copied()
                .find(|t| *t == ch[c])
                .unwrap_or("title"),
            None if c == 0 => "title",
            None => detect(&col),
        };
        let mut f = json!({"name": name, "type": ty});
        if ty == "select" {
            let mut opts: Vec<&str> = Vec::new();
            for v in col.iter().filter(|v| !v.is_empty()) {
                if !opts.contains(v) {
                    opts.push(v);
                }
            }
            f["options"] = json!(opts);
        }
        fields.push(f);
        types.push(ty);
    }
    let rows: Vec<Value> = data
        .iter()
        .map(|r| {
            let mut values = Map::new();
            for (c, name) in names.iter().enumerate() {
                let v = cell(r, c);
                if v.is_empty() {
                    continue;
                }
                let v = match types[c] {
                    "number" => as_number(v).map_or(json!(v), |n| json!(n)),
                    "checkbox" => json!(as_bool(v).unwrap_or(false)),
                    _ => json!(v),
                };
                values.insert(name.clone(), v);
            }
            json!({"values": values})
        })
        .collect();
    Ok(json!({"fields": fields, "rows": rows}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_parsing_handles_quotes_and_line_endings() {
        let r = parse_csv("a,\"b,c\"\r\n\"say \"\"hi\"\"\",\"two\nlines\"\n\n");
        assert_eq!(r, vec![vec!["a", "b,c"], vec!["say \"hi\"", "two\nlines"]]);
    }

    #[test]
    fn types_are_detected() {
        assert_eq!(detect(&["1", "2.5", ""]), "number");
        assert_eq!(detect(&["2026-01-01", "2026-12-31"]), "date");
        assert_eq!(detect(&["2026-13-01"]), "text");
        assert_eq!(detect(&["yes", "No", "TRUE"]), "checkbox");
        assert_eq!(detect(&["a", "b", "a", "a"]), "select");
        assert_eq!(detect(&["a", "b", "c"]), "text");
        assert_eq!(detect(&["", ""]), "text");
    }

    #[test]
    fn chosen_types_override_detection_and_bad_ones_are_refused() {
        // The import dialog lets people change a detected type; the server must honour it.
        let csv = "Task,Count,Due\nA,1,2026-01-01\nB,2,2026-02-01\n";
        let ty = |v: &Value| -> Vec<String> {
            v["fields"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f["type"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(
            ty(&csv_to_database(csv, None).unwrap()),
            ["title", "number", "date"]
        );
        let chosen = vec!["title".to_string(), "text".to_string(), "text".to_string()];
        let v = csv_to_database(csv, Some(&chosen)).unwrap();
        assert_eq!(ty(&v), ["title", "text", "text"]);
        assert_eq!(v["rows"][0]["values"]["Count"], json!("1"));
        // The first column stays the title; unknown types and the wrong count are refused.
        assert!(
            csv_to_database(csv, Some(&["text".into(), "text".into(), "text".into()])).is_err()
        );
        assert!(
            csv_to_database(csv, Some(&["title".into(), "script".into(), "text".into()])).is_err()
        );
        assert!(csv_to_database(csv, Some(&["title".into()])).is_err());
    }

    #[test]
    fn duplicate_headers_are_renamed() {
        let v = csv_to_database("Name,name,\nx,y,z\n", None).unwrap();
        let names: Vec<&str> = v["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["Name", "name 2", "Column 3"]);
    }
}
