//! `POST /v1/assets` and `GET /v1/users`, proxied to the host's callbacks.

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use super::{ApiError, session};
use crate::SharedState;
use crate::grant::Role;

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

pub async fn users(
    State(state): State<SharedState>,
    Query(p): Query<ProxyParams>,
) -> Result<Response, ApiError> {
    let (host, grant) = session(&state, &p.ticket).await?;
    let (status, ct, bytes) = state
        .host
        .users(&host, &grant.callback_token, &grant.file.id, &p.q)
        .await
        .map_err(ApiError::host)?;
    Ok(passthrough(status, ct, bytes))
}
