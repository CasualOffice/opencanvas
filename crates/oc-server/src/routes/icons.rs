// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Add your own icon (DGM-17, ADR-057). `POST /v1/icons?ticket=[&dryRun=1][&name=][&keywords=]
//! [&replace=<id>]` from the editor session: the body is the file (SVG or PNG). The server
//! cleans it (`oc_model::icon_clean`) and answers with what it removed; without `dryRun` it writes
//! the cleaned icon into the document's `icons` root through the room (only the server writes that
//! root; client updates touching it are refused). `POST /v1/icons/:id?ticket=` with
//! `{"name", "keywords"}` renames, with `{"remove": true}` removes. Editors only, 20 uploads a
//! minute per person.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use oc_model::doc_icons::IconOp;
use oc_model::icon_clean::{self, Format};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{ApiError, session};
use crate::SharedState;
use crate::grant::Role;
use crate::room::PatchFailure;

/// Request body limit: a little over the 256 KB a file may have, so the cleaner answers with
/// its own message for anything between.
pub const MAX_BODY: usize = 2 * icon_clean::MAX_INPUT;
/// Uploads (dry runs included) per person per minute.
pub const PER_MINUTE: u32 = 20;

#[derive(Deserialize, Default)]
pub struct IconParams {
    #[serde(default)]
    ticket: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    keywords: Option<String>,
    #[serde(default, rename = "dryRun")]
    dry_run: Option<String>,
    #[serde(default)]
    replace: Option<String>,
}

/// Fixed one-minute window per key.
fn allow(key: &str) -> bool {
    static W: OnceLock<Mutex<HashMap<String, (Instant, u32)>>> = OnceLock::new();
    let mut m = W
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    if m.len() > 10_000 {
        m.retain(|_, (t, _)| now.duration_since(*t) < Duration::from_secs(60));
    }
    let e = m.entry(key.to_string()).or_insert((now, 0));
    if now.duration_since(e.0) >= Duration::from_secs(60) {
        *e = (now, 0);
    }
    if e.1 >= PER_MINUTE {
        return false;
    }
    e.1 += 1;
    true
}

fn refusal(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(
            json!({"code": code, "message": message, "error": {"code": code, "message": message}}),
        ),
    )
        .into_response()
}

fn room_error(e: PatchFailure) -> Response {
    match e {
        PatchFailure::Invalid(p) => {
            refusal(StatusCode::UNPROCESSABLE_ENTITY, "limit", &p.to_string())
        }
        PatchFailure::TooLarge => refusal(
            StatusCode::PAYLOAD_TOO_LARGE,
            "doc_too_large",
            "The document would be over its size limit.",
        ),
        PatchFailure::Conflict => refusal(
            StatusCode::CONFLICT,
            "conflict",
            "The file changed elsewhere; this session is read-only.",
        ),
        PatchFailure::Unavailable => refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "The change could not be stored; retry.",
        ),
    }
}

fn now_iso() -> String {
    let secs = crate::util::now_secs();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn keywords(s: Option<&str>) -> Vec<String> {
    s.unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .map(String::from)
        .collect()
}

/// `POST /v1/icons`.
pub async fn upload(
    State(state): State<SharedState>,
    Query(p): Query<IconParams>,
    body: Bytes,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &p.ticket).await?;
    if grant.role != Role::Edit {
        return Err(ApiError::forbidden("adding icons needs the edit role"));
    }
    if !allow(&format!("{}\u{0}{}", host.id, grant.user.id)) {
        return Ok(refusal(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Too many icons at once. Wait a minute and try again.",
        ));
    }
    let c = match icon_clean::clean(&body) {
        Ok(c) => c,
        Err(r) => {
            let status = if r.code == "too_large" {
                StatusCode::PAYLOAD_TOO_LARGE
            } else {
                StatusCode::UNPROCESSABLE_ENTITY
            };
            tracing::info!(host = %host.id, room = %grant.room, code = r.code, "icon refused");
            return Ok(refusal(status, r.code, &r.message));
        }
    };
    let data = base64::engine::general_purpose::STANDARD.encode(&c.data);
    let format = match c.format {
        Format::Svg => "svg",
        Format::Png => "png",
    };
    let mut out = json!({
        "format": format, "width": c.width, "height": c.height, "bytes": c.data.len(),
        "removed": c.removed,
        "dataUrl": format!("data:{};base64,{data}", c.format.mime()),
    });
    if matches!(p.dry_run.as_deref(), Some("1" | "true")) {
        return Ok(Json(out).into_response());
    }
    let (id, op) = match p.replace.as_deref() {
        Some(id) => (
            id.to_string(),
            IconOp::Replace {
                id: id.to_string(),
                format: format.into(),
                data,
                width: c.width,
                height: c.height,
            },
        ),
        None => {
            let name = oc_model::doc_icons::tidy_name(p.name.as_deref().unwrap_or(""));
            if name.is_empty() {
                return Ok(refusal(
                    StatusCode::BAD_REQUEST,
                    "name_required",
                    "Give the icon a name.",
                ));
            }
            let id = format!("i{}", ulid::Ulid::new().to_string().to_lowercase());
            (
                id.clone(),
                IconOp::Add {
                    id,
                    name,
                    keywords: keywords(p.keywords.as_deref()),
                    format: format.into(),
                    data,
                    width: c.width,
                    height: c.height,
                    by: grant.user.id.clone(),
                    by_name: grant.user.name.clone(),
                    at: now_iso(),
                },
            )
        }
    };
    match state
        .rooms
        .icons(&host, &grant, op, &grant.user.id)
        .await
        .map_err(ApiError::host)?
    {
        Ok(_) => {}
        Err(e) => return Ok(room_error(e)),
    }
    tracing::info!(host = %host.id, room = %grant.room, icon = %id, format, "icon stored");
    out["id"] = json!(id);
    Ok(Json(out).into_response())
}

/// `POST /v1/icons/:id`: rename (`{"name", "keywords"}`) or remove (`{"remove": true}`).
pub async fn change(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    Query(p): Query<IconParams>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &p.ticket).await?;
    if grant.role != Role::Edit {
        return Err(ApiError::forbidden("changing icons needs the edit role"));
    }
    let op = if body["remove"] == true {
        IconOp::Remove { id: id.clone() }
    } else {
        let name = oc_model::doc_icons::tidy_name(body["name"].as_str().unwrap_or(""));
        if name.is_empty() {
            return Ok(refusal(
                StatusCode::BAD_REQUEST,
                "name_required",
                "Give the icon a name.",
            ));
        }
        let kw: Vec<String> = body["keywords"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|k| k.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        IconOp::Rename {
            id: id.clone(),
            name,
            keywords: kw,
        }
    };
    match state
        .rooms
        .icons(&host, &grant, op, &grant.user.id)
        .await
        .map_err(ApiError::host)?
    {
        Ok(_) => Ok(Json(json!({"id": id})).into_response()),
        Err(e) => Ok(room_error(e)),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn iso_dates() {
        assert!(super::now_iso().starts_with("20"));
        assert_eq!(super::now_iso().len(), 20);
    }
}
