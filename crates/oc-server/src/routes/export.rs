//! `GET /v1/export/:fmt?ticket=` for md, html, json and ocanvas.

use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use super::{ApiError, session};
use crate::SharedState;
use crate::util::{now_ms, rfc3339};

#[derive(Deserialize)]
pub struct ExportParams {
    #[serde(default)]
    ticket: String,
}

fn filename(name: &str, ext: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim();
    format!("{}.{ext}", if safe.is_empty() { "canvas" } else { safe })
}

pub async fn export(
    State(state): State<SharedState>,
    Path(fmt): Path<String>,
    Query(p): Query<ExportParams>,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &p.ticket).await?;
    let allowed = if fmt == "ocanvas" {
        grant.perms.download
    } else {
        grant.perms.export
    };
    if !allowed {
        return Err(ApiError::forbidden("export not permitted for this session"));
    }
    let bytes = state
        .rooms
        .state(&host, &grant)
        .await
        .map_err(ApiError::host)?;
    let doc = oc_model::new_doc();
    oc_model::ocanvas::apply_update_bytes(&doc, &bytes).map_err(ApiError::internal)?;
    let (body, ctype, ext): (Vec<u8>, &str, &str) = match fmt.as_str() {
        "md" => (
            oc_model::export::to_markdown(&oc_model::doc_to_json(&doc)).into_bytes(),
            "text/markdown; charset=utf-8",
            "md",
        ),
        "html" => (
            oc_model::export::to_html(&oc_model::doc_to_json(&doc)).into_bytes(),
            "text/html; charset=utf-8",
            "html",
        ),
        "json" => (
            serde_json::to_vec_pretty(&oc_model::doc_to_json(&doc)).map_err(ApiError::internal)?,
            "application/json",
            "json",
        ),
        "ocanvas" => {
            let commit = oc_model::CommitInfo {
                id: ulid::Ulid::new().to_string(),
                authors: vec![grant.user.id.clone()],
                at: rfc3339(now_ms()),
            };
            (
                oc_model::write_ocanvas(&doc, &commit).map_err(ApiError::internal)?,
                "application/vnd.opencanvas+zip",
                "ocanvas",
            )
        }
        _ => {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "FORMAT_UNSUPPORTED",
                "supported: md, html, json, ocanvas",
            ));
        }
    };
    let disposition = format!(
        "attachment; filename=\"{}\"",
        filename(&grant.file.name, ext)
    );
    Ok((
        [
            (header::CONTENT_TYPE, ctype.to_string()),
            (header::CONTENT_DISPOSITION, disposition),
            (header::CACHE_CONTROL, "no-store".into()),
        ],
        body,
    )
        .into_response())
}
