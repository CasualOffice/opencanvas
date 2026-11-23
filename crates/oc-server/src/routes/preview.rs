// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! RND-01: `GET /v1/preview?ticket=` — the canvas as static HTML in the editor's markup,
//! rendered here from the room's current Yjs state (docs/03 §3.5, docs/15 §2). The editor
//! shell (`/app/preview.js`) shows it while the editor bundle loads and connects; the live
//! editor then takes over. Any role may read it (view, comment, edit); an unknown, expired
//! or revoked ticket gets 401 and no content. Comment threads and anchors are never
//! rendered. Bodies are cached per room and room version (a hash of the Yjs state), so
//! repeated opens of an unchanged canvas skip the render; `ETag` / `If-None-Match` give 304.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::export::EXPORT_CSP;
use super::{ApiError, session};
use crate::SharedState;
use crate::grant::Role;

/// Rooms whose rendered preview is kept; past this the cache starts over.
const MAX_CACHED_ROOMS: usize = 256;
/// Bytes of cached bodies kept in total; past this the cache starts over.
const MAX_CACHED_BYTES: usize = 64 * 1024 * 1024;

struct Entry {
    version: [u8; 16],
    crumbs: Arc<str>,
    body: Arc<str>,
    truncated: bool,
}

/// Rendered previews per room, keyed by the room's version. The body is the same for every
/// role (nothing role-specific is rendered into it); the shell around it is per request.
#[derive(Default)]
pub struct PreviewCache {
    rooms: Mutex<HashMap<String, Entry>>,
    renders: AtomicU64,
}

impl PreviewCache {
    /// How many previews were rendered (cache misses) since start.
    pub fn renders(&self) -> u64 {
        self.renders.load(Ordering::Relaxed)
    }

    fn get(&self, room: &str, version: &[u8; 16]) -> Option<(Arc<str>, Arc<str>, bool)> {
        let map = self.rooms.lock().expect("preview cache");
        map.get(room)
            .filter(|e| &e.version == version)
            .map(|e| (e.crumbs.clone(), e.body.clone(), e.truncated))
    }

    fn put(&self, room: &str, e: Entry) {
        let mut map = self.rooms.lock().expect("preview cache");
        let bytes: usize = map.values().map(|e| e.body.len()).sum();
        if map.len() >= MAX_CACHED_ROOMS || bytes + e.body.len() > MAX_CACHED_BYTES {
            map.clear();
        }
        map.insert(room.to_string(), e);
    }
}

#[derive(Deserialize)]
pub struct PreviewParams {
    #[serde(default)]
    ticket: String,
}

/// The banner the editor shows for this role, word for word (App.tsx), so the takeover does
/// not move the content.
fn banner(role: Role, host_name: &str) -> String {
    let text = match role {
        Role::View => format!(
            "You can view this canvas. Ask in {} for edit access.",
            oc_model::export::escape(host_name)
        ),
        Role::Comment => "You can comment. Select text to start a thread.".into(),
        Role::Edit => return String::new(),
    };
    format!("<div class=\"banner info\"><span class=\"oc-pv-bic\"></span><span>{text}</span></div>")
}

pub async fn preview(
    State(state): State<SharedState>,
    Query(p): Query<PreviewParams>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &p.ticket).await?;
    let bytes = state
        .rooms
        .state(&host, &grant)
        .await
        .map_err(ApiError::host)?;
    let mut version = [0u8; 16];
    version.copy_from_slice(&Sha256::digest(&bytes)[..16]);
    let cache = &state.previews;
    let (crumbs, body, truncated) = match cache.get(&grant.room, &version) {
        Some(hit) => hit,
        None => {
            let rendered = tokio::task::spawn_blocking(move || {
                let doc = oc_model::new_doc();
                oc_model::ocanvas::apply_update_bytes(&doc, &bytes)?;
                let mut json = oc_model::doc_to_json(&doc);
                oc_model::people::strip_emails(&mut json);
                Ok::<_, oc_model::Error>(oc_model::preview::render(&json))
            })
            .await
            .map_err(ApiError::internal)?
            .map_err(ApiError::internal)?;
            cache.renders.fetch_add(1, Ordering::Relaxed);
            let e = Entry {
                version,
                crumbs: rendered.crumbs.into(),
                body: rendered.html.into(),
                truncated: rendered.truncated,
            };
            let out = (e.crumbs.clone(), e.body.clone(), e.truncated);
            cache.put(&grant.room, e);
            out
        }
    };
    // The response varies with the version and with what the shell shows for this session.
    let etag = {
        let mut h = Sha256::new();
        h.update(version);
        h.update(grant.role.as_str());
        h.update(&host.name);
        let d = h.finalize();
        format!("\"{}\"", hex(&d[..12]))
    };
    let common = [
        (header::CACHE_CONTROL, "private, no-cache".to_string()),
        (header::ETAG, etag.clone()),
    ];
    let matches = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag));
    if matches {
        return Ok((StatusCode::NOT_MODIFIED, common).into_response());
    }
    let role = grant.role;
    let html = format!(
        "<div class=\"app oc-root{}\" data-oc-preview data-role=\"{}\"{}><div class=\"wsp\"><div class=\"top\">{crumbs}</div>{}<div class=\"body\"><div class=\"scroll\"><div class=\"doc\">{body}</div></div></div></div></div>",
        if role == Role::Edit { "" } else { " ro" },
        role.as_str(),
        if truncated { " data-truncated" } else { "" },
        banner(role, &host.name),
    );
    Ok((
        common,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CONTENT_SECURITY_POLICY, EXPORT_CSP),
        ],
        html,
    )
        .into_response())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
