//! `POST /v1/assets` and `GET /v1/users`, proxied to the host's callbacks; in WOPI mode
//! served from the room instead (plus `GET /v1/assets/:id`).

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{ApiError, session};
use crate::SharedState;
use crate::grant::{Grant, Role};
use crate::host_client::SaveTarget;
use crate::hosts::HostConfig;
use crate::people;
use crate::util::now_ms;
use crate::wopi;

#[derive(Deserialize)]
pub struct ProxyParams {
    #[serde(default)]
    ticket: String,
    #[serde(default)]
    q: String,
}

fn passthrough(status: reqwest::StatusCode, ctype: String, body: Bytes) -> Response {
    let status = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    (status, [(header::CONTENT_TYPE, ctype)], body).into_response()
}

pub async fn upload_asset(
    State(state): State<SharedState>,
    Query(p): Query<ProxyParams>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &p.ticket).await?;
    if grant.role != Role::Edit {
        return Err(ApiError::forbidden("uploads need the edit role"));
    }
    let ctype = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if !ctype.starts_with("multipart/form-data") {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "MULTIPART_REQUIRED",
            "send multipart/form-data with a `file` field",
        ));
    }
    if is_wopi(&host, &grant) {
        return upload_wopi(&state, &grant, ctype, &body).await;
    }
    let (status, ct, bytes) = state
        .host
        .post_asset(
            &host,
            &grant.callback_token,
            &grant.file.id,
            ctype,
            body.to_vec(),
        )
        .await
        .map_err(ApiError::host)?;
    Ok(passthrough(status, ct, bytes))
}

/// `GET /v1/members?ticket=&q=` (docs/21 revision 2): the people with access to this canvas,
/// the same for every viewer. Merged by id: the host's members callback (cached 60 s per
/// room) beats the token's `members` beats the saved `people` map (the last only when the host
/// said nothing, read from the room). Never an e-mail.
pub async fn members(
    State(state): State<SharedState>,
    Query(p): Query<ProxyParams>,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &p.ticket).await?;
    if p.q.len() > 200 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "QUERY_TOO_LONG",
            "q is limited to 200 bytes",
        ));
    }
    let callback = state
        .members
        .callback(&state.host, &host, &grant, &p.q)
        .await;
    let saved = if callback.is_none() && grant.members.is_empty() {
        let mut saved = match state.rooms.state(&host, &grant).await {
            Ok(bytes) => {
                let doc = oc_model::new_doc();
                oc_model::ocanvas::apply_update_bytes(&doc, &bytes)
                    .map(|()| people::saved_people(&oc_model::doc_to_json(&doc)))
                    .unwrap_or_default()
            }
            Err(_) => vec![],
        };
        // Sessions cover people who opened the file since the last save.
        for u in state
            .store
            .room_users(&grant.room)
            .await
            .map_err(ApiError::internal)?
        {
            if !saved.iter().any(|s| s.id == u.id) {
                saved.push(u);
            }
        }
        saved
    } else {
        vec![]
    };
    let merged = people::merge(
        callback.as_deref(),
        &grant.members,
        &grant.user,
        &saved,
        &p.q,
    );
    let list: Vec<Value> = state
        .members
        .without_revoked(&grant.room, merged)
        .iter()
        .take(people::MAX_MEMBERS)
        .map(people::member_json)
        .collect();
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"members": list})),
    )
        .into_response())
}

// ---------------------------------------------------------------- WOPI mode (docs/05 §6)
// WOPI has no asset or user API: assets are kept with the room and inlined into the saved
// `.ocanvas` (`assets/<id>`); the member list is the people map and the users who opened the file.

pub(super) fn is_wopi(host: &HostConfig, grant: &Grant) -> bool {
    matches!(
        SaveTarget::of(host, &grant.file.id),
        Ok(SaveTarget::Wopi(_))
    )
}

/// The `file` part of a `multipart/form-data` body: (content type, bytes).
fn multipart_file(ctype: &str, body: &[u8]) -> Option<(String, Vec<u8>)> {
    let boundary = ctype
        .split(';')
        .map(str::trim)
        .find_map(|p| p.strip_prefix("boundary="))?
        .trim_matches('"');
    // RFC 2046: 1-70 characters. A longer one multiplies the cost of every search below
    // over a 25 MB body (SEC-13).
    if boundary.is_empty() || boundary.len() > 70 {
        return None;
    }
    let delim = format!("--{boundary}");
    let find = |hay: &[u8], needle: &[u8], from: usize| {
        hay.get(from..)?
            .windows(needle.len())
            .position(|w| w == needle)
            .map(|i| i + from)
    };
    let mut pos = find(body, delim.as_bytes(), 0)?;
    loop {
        let start = pos + delim.len();
        if body.get(start..start + 2) == Some(b"--") {
            return None;
        }
        let head_end = find(body, b"\r\n\r\n", start)?;
        let head = String::from_utf8_lossy(&body[start..head_end]).to_ascii_lowercase();
        let data_start = head_end + 4;
        let next = find(body, format!("\r\n{delim}").as_bytes(), data_start)?;
        let is_file = head
            .lines()
            .any(|l| l.starts_with("content-disposition:") && l.contains("name=\"file\""));
        if is_file {
            let mime = head
                .lines()
                .find_map(|l| l.strip_prefix("content-type:"))
                .map(|m| m.trim().to_string())
                .filter(|m| !m.is_empty() && m.len() <= 127)
                .unwrap_or_else(|| "application/octet-stream".into());
            return Some((mime, body[data_start..next].to_vec()));
        }
        pos = next + 2;
    }
}

async fn upload_wopi(
    state: &SharedState,
    grant: &Grant,
    ctype: &str,
    body: &[u8],
) -> Result<Response, ApiError> {
    let Some((mime, data)) = multipart_file(ctype, body) else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "MULTIPART_REQUIRED",
            "send multipart/form-data with a `file` field",
        ));
    };
    let too_large = |what: &str, mb: usize| {
        ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "ASSET_TOO_LARGE",
            format!("{what} limited to {mb} MB in WOPI mode"),
        )
    };
    if data.len() > wopi::MAX_ASSET_BYTES {
        return Err(too_large("assets are", wopi::MAX_ASSET_BYTES >> 20));
    }
    let used = state
        .store
        .room_assets_size(&grant.room)
        .await
        .map_err(ApiError::internal)?;
    if used.max(0) as usize + data.len() > wopi::MAX_ASSETS_TOTAL {
        return Err(too_large(
            "the assets of one file are",
            wopi::MAX_ASSETS_TOTAL >> 20,
        ));
    }
    let id = format!("a_{}", ulid::Ulid::new().to_string().to_ascii_lowercase());
    let size = data.len();
    let asset = oc_model::ocanvas::Asset {
        id: id.clone(),
        mime: mime.clone(),
        data,
    };
    state
        .store
        .asset_put(&grant.room, &asset, now_ms())
        .await
        .map_err(ApiError::internal)?;
    let body =
        json!({"assetId": id, "url": format!("/v1/assets/{id}"), "mime": mime, "size": size});
    Ok((StatusCode::CREATED, Json(body)).into_response())
}

/// `GET /v1/assets/:id?ticket=`: an asset of the session's room (WOPI mode). Images are
/// served inline, anything else (and SVG) as a download; never sniffed, never scripted.
pub async fn get_asset(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    Query(p): Query<ProxyParams>,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &p.ticket).await?;
    let not_found = || ApiError::new(StatusCode::NOT_FOUND, "ASSET_NOT_FOUND", "no such asset");
    if !is_wopi(&host, &grant) || !oc_model::ocanvas::valid_asset_id(&id) {
        return Err(not_found());
    }
    let asset = state
        .store
        .asset_get(&grant.room, &id)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(not_found)?;
    let image = asset.mime.starts_with("image/") && asset.mime != "image/svg+xml";
    let disposition = if image { "inline" } else { "attachment" };
    Ok((
        [
            (header::CONTENT_TYPE, asset.mime),
            (header::CONTENT_DISPOSITION, disposition.to_string()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; sandbox".into(),
            ),
            (header::CACHE_CONTROL, "private, max-age=3600".into()),
        ],
        asset.data,
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct FetchParams {
    #[serde(default)]
    ticket: String,
    #[serde(default)]
    url: String,
}

/// Largest attachment `GET /v1/assets/fetch` serves.
pub const MAX_PREVIEW_BYTES: u64 = 50 * 1024 * 1024;

/// `GET /v1/assets/fetch?ticket=&url=` (FILE-01): an attachment's bytes from this origin, so
/// the editor can preview it (pdf.js, text) although it lives on the host's origin. Same rules
/// as export image fetching (`assets::resolve`): the host's callback origin (signed) or an
/// `asset_origins` entry, exact origin, no userinfo, no redirects. Any role may preview;
/// `perms.download` only hides the editor's Download action (downloads use the original URL).
/// Streamed, at most [`MAX_PREVIEW_BYTES`]; served inline, never sniffed, sandboxed.
pub async fn fetch_asset(
    State(state): State<SharedState>,
    Query(p): Query<FetchParams>,
) -> Result<Response, ApiError> {
    use futures::StreamExt;
    let (host, grant) = session(&state, &p.ticket).await?;
    let Some(a) = (p.url.len() <= 2048)
        .then(|| crate::assets::resolve(&host, &p.url))
        .flatten()
    else {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "ASSET_ORIGIN_NOT_ALLOWED",
            "this file is not on an origin the host allows",
        ));
    };
    let unavailable = || {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "ASSET_UNAVAILABLE",
            "the host did not serve this file",
        )
    };
    let res = state
        .host
        .open_asset(&host, &grant.callback_token, a.url, a.signed)
        .await
        .map_err(|e| {
            tracing::debug!(error = %e, "preview fetch failed");
            unavailable()
        })?;
    match res.status() {
        s if s.is_success() => {}
        reqwest::StatusCode::NOT_FOUND => {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "ASSET_NOT_FOUND",
                "no such file",
            ));
        }
        // Redirects included: never followed (SEC-07).
        _ => return Err(unavailable()),
    }
    let too_large = || {
        ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "ASSET_TOO_LARGE",
            "files over 50 MB are not previewed",
        )
    };
    if res.content_length().is_some_and(|l| l > MAX_PREVIEW_BYTES) {
        return Err(too_large());
    }
    let ctype = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() <= 200 && v.is_ascii())
        .unwrap_or("application/octet-stream")
        .to_string();
    let mut seen = 0u64;
    let body = res.bytes_stream().map(move |chunk| {
        let chunk = chunk.map_err(std::io::Error::other)?;
        seen += chunk.len() as u64;
        if seen > MAX_PREVIEW_BYTES {
            // Without a Content-Length the cap is enforced mid-stream: the response is cut.
            return Err(std::io::Error::other("asset over the preview cap"));
        }
        Ok::<_, std::io::Error>(chunk)
    });
    Ok((
        [
            (header::CONTENT_TYPE, ctype),
            (header::CONTENT_DISPOSITION, "inline".into()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
            (
                header::CONTENT_SECURITY_POLICY,
                "sandbox; default-src 'none'".into(),
            ),
            (header::CACHE_CONTROL, "private, max-age=600".into()),
        ],
        axum::body::Body::from_stream(body),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    #[test]
    fn multipart_file_part() {
        let body = b"--XyZ\r\nContent-Disposition: form-data; name=\"other\"\r\n\r\nskip\r\n--XyZ\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\n\x89PNG\r\n\r\n--XyZ--\r\n";
        let (mime, data) =
            super::multipart_file("multipart/form-data; boundary=XyZ", body).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(data, b"\x89PNG\r\n");
        assert!(super::multipart_file("multipart/form-data; boundary=Nope", body).is_none());
    }

    /// SEC-13: the boundary length multiplies the cost of every search over a 25 MB body;
    /// RFC 2046 caps it at 70 characters.
    #[test]
    fn overlong_boundaries_are_refused() {
        let b = "x".repeat(71);
        let body = format!(
            "--{b}\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nhi\r\n--{b}--\r\n"
        );
        assert!(
            super::multipart_file(
                &format!("multipart/form-data; boundary={b}"),
                body.as_bytes()
            )
            .is_none()
        );
        let b = "x".repeat(70);
        let body = format!(
            "--{b}\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nhi\r\n--{b}--\r\n"
        );
        assert!(
            super::multipart_file(
                &format!("multipart/form-data; boundary={b}"),
                body.as_bytes()
            )
            .is_some()
        );
    }
}
