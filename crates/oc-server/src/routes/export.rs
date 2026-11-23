// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `GET /v1/export/:fmt?ticket=` for md, html, json, ocanvas, docx and pdf, and
//! `GET /v1/export/board/:boardId.{svg,png}?ticket=`. The renderer is shared with
//! `POST /v1/convert`.

use std::sync::Arc;

use yrs::Doc;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use super::{ApiError, session};
use crate::SharedState;
use crate::assets::fetch_images;
use crate::config::PdfRenderer;
use crate::grant::Grant;
use crate::hosts::HostConfig;
use crate::util::{now_ms, rfc3339};

/// Exported files are user content: if a browser ever renders one from this origin (opened
/// directly, `nosniff` aside), it runs sandboxed, with no scripts and no network.
pub(super) const EXPORT_CSP: &str =
    "sandbox; default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'";

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

/// The session's live document (or the host's file when no room is open).
pub(super) async fn load(
    state: &SharedState,
    host: &Arc<HostConfig>,
    grant: &Grant,
) -> Result<Doc, ApiError> {
    let bytes = state
        .rooms
        .state(host, grant)
        .await
        .map_err(ApiError::host)?;
    let doc = oc_model::new_doc();
    oc_model::ocanvas::apply_update_bytes(&doc, &bytes).map_err(ApiError::internal)?;
    Ok(doc)
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
    if !allowed || (fmt == "pdf" && !grant.perms.print) || !host.export_allowed(&fmt) {
        return Err(ApiError::forbidden("export not permitted for this session"));
    }
    let doc = load(&state, &host, &grant).await?;
    let wopi = super::proxy::room_assets(&host, &grant);
    // The `.ocanvas` download is the file itself; every rendered format uses members' current
    // names (docs/21 revision 2).
    let names = if fmt == "ocanvas" {
        None
    } else {
        Some(member_names(&state, &host, &grant, &doc).await)
    };
    let req = RenderReq {
        token: &grant.callback_token,
        author: &grant.user.id,
        wopi_room: wopi.then_some(grant.room.as_str()),
        people: names.as_ref(),
    };
    let (body, ctype, ext) = render(&state, &host, &doc, &fmt, req).await?;
    let disposition = format!(
        "attachment; filename=\"{}\"",
        filename(&grant.file.name, ext)
    );
    Ok((
        [
            (header::CONTENT_TYPE, ctype.to_string()),
            (header::CONTENT_DISPOSITION, disposition),
            (header::CACHE_CONTROL, "no-store".into()),
            (header::CONTENT_SECURITY_POLICY, EXPORT_CSP.into()),
        ],
        body,
    )
        .into_response())
}

/// `GET /v1/export/board/:boardId.svg|png?ticket=`: one board, fitted to its content.
pub async fn export_board(
    State(state): State<SharedState>,
    Path(file): Path<String>,
    Query(p): Query<ExportParams>,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &p.ticket).await?;
    if !grant.perms.export {
        return Err(ApiError::forbidden("export not permitted for this session"));
    }
    let unsupported = || {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "FORMAT_UNSUPPORTED",
            "supported: <boardId>.svg, <boardId>.png",
        )
    };
    let (board_id, ext) = file.rsplit_once('.').ok_or_else(unsupported)?;
    if !matches!(ext, "svg" | "png") {
        return Err(unsupported());
    }
    if !host.export_allowed(ext) {
        return Err(ApiError::forbidden("export not permitted for this session"));
    }
    let doc = load(&state, &host, &grant).await?;
    let json = oc_model::doc_to_json(&doc);
    if !json["boards"][board_id].is_object() {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "BOARD_NOT_FOUND",
            "no such board in this canvas",
        ));
    }
    let (body, ctype) = if ext == "svg" {
        (
            oc_model::board::to_svg(&json, board_id).into_bytes(),
            "image/svg+xml; charset=utf-8",
        )
    } else {
        let images = fetch_images(
            &state,
            &host,
            &grant.callback_token,
            oc_model::board::image_sources(&json),
        )
        .await;
        let svg = oc_model::board::to_svg_with_images(&json, board_id, &images);
        let png = tokio::task::spawn_blocking(move || oc_model::board::to_png(&svg, 2.0))
            .await
            .map_err(ApiError::internal)?
            .map_err(ApiError::internal)?;
        (png, "image/png")
    };
    Ok((
        [
            (header::CONTENT_TYPE, ctype.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("inline; filename=\"board.{ext}\""),
            ),
            (header::CACHE_CONTROL, "no-store".into()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
            (header::CONTENT_SECURITY_POLICY, EXPORT_CSP.into()),
        ],
        body,
    )
        .into_response())
}

/// Current names of the canvas's members (docs/21 revision 2): the members callback, then the
/// token's `members`, then the saved `people` map. Anyone else keeps the snapshot label.
pub(super) async fn member_names(
    state: &SharedState,
    host: &HostConfig,
    grant: &Grant,
    doc: &Doc,
) -> std::collections::HashMap<String, String> {
    let json = oc_model::doc_to_json(doc);
    let callback = state.members.callback(&state.host, host, grant, "").await;
    let saved = crate::people::saved_people(&json);
    let merged = crate::people::merge(callback.as_deref(), &grant.members, &grant.user, &saved, "");
    state
        .members
        .without_revoked(&grant.room, merged)
        .into_iter()
        .map(|u| (u.id, u.name))
        .collect()
}

pub const FORMATS: &str = "md, html, json, ocanvas, docx, pdf";

/// Who an export is made for.
#[derive(Clone, Copy)]
pub(super) struct RenderReq<'a> {
    /// Callback bearer for image fetches.
    pub token: &'a str,
    /// Author recorded in an `.ocanvas` commit.
    pub author: &'a str,
    /// WOPI mode: the room whose assets (`/v1/assets/<id>`) are inlined into the export.
    pub wopi_room: Option<&'a str>,
    /// Members' current names; `None` renders the document's snapshot labels.
    pub people: Option<&'a std::collections::HashMap<String, String>>,
}

/// `document.json` as this export's viewer sees it.
fn doc_json(doc: &Doc, req: &RenderReq<'_>) -> serde_json::Value {
    let mut json = oc_model::doc_to_json(doc);
    if let Some(names) = req.people {
        oc_model::people::relabel(&mut json, names);
    } else {
        oc_model::people::strip_emails(&mut json);
    }
    json
}

/// Images for an export: allowed host origins, plus the room's assets in WOPI mode.
async fn images(
    state: &SharedState,
    host: &HostConfig,
    req: &RenderReq<'_>,
    json: &serde_json::Value,
) -> std::collections::HashMap<String, Vec<u8>> {
    let srcs = oc_model::docx::image_sources(json);
    let mut images = fetch_images(state, host, req.token, srcs.iter().cloned()).await;
    if let Some(room) = req.wopi_room {
        for src in srcs {
            let Some(id) = src.strip_prefix("/v1/assets/") else {
                continue;
            };
            if let Ok(Some(a)) = state.store.asset_get(room, id).await
                && a.mime.starts_with("image/")
            {
                images.insert(src, a.data);
            }
        }
    }
    images
}

/// Renders `doc` as `fmt`: (body, content type, file extension). Counted in
/// `oc_exports_total{format,result}` and timed in `oc_export_seconds{format}`.
pub(super) async fn render(
    state: &SharedState,
    host: &Arc<HostConfig>,
    doc: &Doc,
    fmt: &str,
    req: RenderReq<'_>,
) -> Result<(Body, &'static str, &'static str), ApiError> {
    let started = std::time::Instant::now();
    let out = render_once(state, host, doc, fmt, req).await;
    // Unknown formats are not labels (a client could make up any number of them).
    if let Some(format) = FORMATS.split(", ").find(|f| *f == fmt) {
        state.metrics.export(format, out.is_ok(), started.elapsed());
    }
    out
}

async fn render_once(
    state: &SharedState,
    host: &Arc<HostConfig>,
    doc: &Doc,
    fmt: &str,
    req: RenderReq<'_>,
) -> Result<(Body, &'static str, &'static str), ApiError> {
    Ok(match fmt {
        "md" => {
            // Boards are embedded as data: SVGs. Never link back with the session ticket:
            // exported files get shared, and the ticket would let anyone open the canvas.
            let opts = oc_model::export::Options::default();
            (
                oc_model::export::to_markdown_with(&doc_json(doc, &req), &opts).into(),
                "text/markdown; charset=utf-8",
                "md",
            )
        }
        "html" => (
            oc_model::export::to_html(&doc_json(doc, &req)).into(),
            "text/html; charset=utf-8",
            "html",
        ),
        "json" => (
            serde_json::to_vec_pretty(&doc_json(doc, &req))
                .map_err(ApiError::internal)?
                .into(),
            "application/json",
            "json",
        ),
        "ocanvas" => {
            let commit = oc_model::CommitInfo {
                id: ulid::Ulid::new().to_string(),
                authors: vec![req.author.to_string()],
                at: rfc3339(now_ms()),
            };
            let mut bytes = oc_model::write_ocanvas(doc, &commit).map_err(ApiError::internal)?;
            if let Some(room) = req.wopi_room {
                bytes = state
                    .host
                    .inline_assets(room, bytes)
                    .await
                    .map_err(ApiError::internal)?;
            }
            (bytes.into(), "application/vnd.opencanvas+zip", "ocanvas")
        }
        "docx" => {
            let json = doc_json(doc, &req);
            let images = images(state, host, &req, &json).await;
            let (bytes, notes) =
                tokio::task::spawn_blocking(move || oc_model::docx::to_docx(&json, &images))
                    .await
                    .map_err(ApiError::internal)?
                    .map_err(ApiError::internal)?;
            if !notes.is_empty() {
                tracing::debug!(notes = notes.len(), "docx export is lossy");
            }
            (bytes.into(), oc_model::docx::MIME, "docx")
        }
        "pdf" => {
            let Some(renderer) = state.cfg.pdf_renderer.clone() else {
                return Err(ApiError::new(
                    StatusCode::NOT_IMPLEMENTED,
                    "PDF_RENDERER_NOT_CONFIGURED",
                    "PDF export needs OC_PDF_RENDERER=gotenberg:<url>; use the print view instead",
                ));
            };
            let json = doc_json(doc, &req);
            let images = images(state, host, &req, &json).await;
            let html = oc_model::export::to_html_with(
                &json,
                &oc_model::export::Options {
                    images: Some(&images),
                    ..Default::default()
                },
            );
            let body = match renderer {
                PdfRenderer::Gotenberg(url) => crate::pdf::gotenberg(&url, html).await?,
            };
            (body, "application/pdf", "pdf")
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
