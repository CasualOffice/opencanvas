//! `GET /v1/export/:fmt?ticket=` for md, html, json, ocanvas and docx; the renderer is shared
//! with `POST /v1/convert`.

use std::collections::HashMap;
use std::sync::Arc;

use reqwest::Url;
use yrs::Doc;

use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use super::{ApiError, session};
use crate::SharedState;
use crate::hosts::HostConfig;
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
    let (body, ctype, ext) = render(
        &state,
        &host,
        &grant.callback_token,
        &doc,
        &fmt,
        &grant.user.id,
    )
    .await?;
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

pub const FORMATS: &str = "md, html, json, ocanvas, docx";

/// Renders `doc` as `fmt`: (bytes, content type, file extension).
pub(super) async fn render(
    state: &SharedState,
    host: &Arc<HostConfig>,
    token: &str,
    doc: &Doc,
    fmt: &str,
    author: &str,
) -> Result<(Vec<u8>, &'static str, &'static str), ApiError> {
    Ok(match fmt {
        "md" => (
            oc_model::export::to_markdown(&oc_model::doc_to_json(doc)).into_bytes(),
            "text/markdown; charset=utf-8",
            "md",
        ),
        "html" => (
            oc_model::export::to_html(&oc_model::doc_to_json(doc)).into_bytes(),
            "text/html; charset=utf-8",
            "html",
        ),
        "json" => (
            serde_json::to_vec_pretty(&oc_model::doc_to_json(doc)).map_err(ApiError::internal)?,
            "application/json",
            "json",
        ),
        "ocanvas" => {
            let commit = oc_model::CommitInfo {
                id: ulid::Ulid::new().to_string(),
                authors: vec![author.to_string()],
                at: rfc3339(now_ms()),
            };
            (
                oc_model::write_ocanvas(doc, &commit).map_err(ApiError::internal)?,
                "application/vnd.opencanvas+zip",
                "ocanvas",
            )
        }
        "docx" => {
            let json = oc_model::doc_to_json(doc);
            let images = fetch_images(state, host, token, &json).await;
            let (bytes, notes) =
                oc_model::docx::to_docx(&json, &images).map_err(ApiError::internal)?;
            if !notes.is_empty() {
                tracing::debug!(notes = notes.len(), "docx export is lossy");
            }
            (bytes, oc_model::docx::MIME, "docx")
        }
        _ => {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "FORMAT_UNSUPPORTED",
                format!("supported: {FORMATS}"),
            ));
        }
    })
}

const MAX_IMAGES: usize = 50;

/// An image `src` resolved against the host's callback origin, or `None` when it points
/// anywhere else (never fetch arbitrary URLs).
pub fn host_asset_url(host: &HostConfig, src: &str) -> Option<Url> {
    let base = Url::parse(&host.callback_base).ok()?;
    let url = if src.starts_with('/') && !src.starts_with("//") {
        base.join(src).ok()?
    } else {
        Url::parse(src).ok()?
    };
    let same_origin = matches!(url.scheme(), "http" | "https")
        && url.origin() == base.origin()
        && url.username().is_empty()
        && url.password().is_none();
    same_origin.then_some(url)
}

/// Fetches the document's images that live on the host's callback origin (PNG/JPEG/GIF only).
async fn fetch_images(
    state: &SharedState,
    host: &Arc<HostConfig>,
    token: &str,
    json: &serde_json::Value,
) -> HashMap<String, Vec<u8>> {
    let wanted: Vec<(String, Url)> = oc_model::docx::image_sources(json)
        .into_iter()
        .filter_map(|src| host_asset_url(host, &src).map(|u| (src, u)))
        .take(MAX_IMAGES)
        .collect();
    let fetches = wanted.into_iter().map(|(src, url)| async move {
        match state.host.get_asset(host, token, url).await {
            Ok(bytes) if oc_model::docx::image_info(&bytes).is_some() => {
                Some((src, bytes.to_vec()))
            }
            Ok(_) => None,
            Err(e) => {
                tracing::debug!(error = %e, "image for docx not fetched");
                None
            }
        }
    });
    futures::future::join_all(fetches)
        .await
        .into_iter()
        .flatten()
        .collect()
}
