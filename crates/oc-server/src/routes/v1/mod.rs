// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Headless API v1 (docs/27 §4, ADR-041): `/api/v1/…`, JSON, described by the OpenAPI 3.1
//! document at `/api/v1/openapi.json` (checked in as `crates/oc-server/api/openapi.json`).
//! Errors are RFC 9457 problem details ([`problem`]).
//!
//! Every operation is a thin adapter over the canvas tool layer shared with MCP and the agent
//! (ADR-032): the same input, the same role checks, the same room transaction. The routes are
//! registered through [`Table`], which also lists them, so a contract test can hold the
//! router and the OpenAPI document to each other.
//!
//! The 0.1 host routes (`/v1/files/{id}/patch|commit|role|import|session`, `/v1/convert`) are
//! kept as aliases with their old answers and error shape, plus `Deprecation` and a
//! `Link: rel="successor-version"` to the v1 operation (docs/27 §9, decision 8).

pub mod problem;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::handler::Handler;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::MethodFilter;
use serde::Deserialize;
use serde_json::{Value, json};

use self::problem::Problem;
use super::{api, export, import};
use crate::SharedState;
use crate::ai::tools::{CanvasTools, LiveTools};
use crate::authz::{AuthError, Principal};
use crate::grant::Role;

/// The OpenAPI 3.1 document, served as is.
pub const OPENAPI: &str = include_str!("../../../api/openapi.json");

/// `Deprecation` of the 0.1 host routes (RFC 9745): deprecated since 2026-11-24.
pub const DEPRECATED_AT: &str = "@1795478400";

/// Routes plus the list of `(method, path)` they answer, built together so they cannot drift.
pub struct Table {
    pub ops: Vec<(Method, &'static str)>,
    router: Router<SharedState>,
}

impl Table {
    fn new() -> Self {
        Self {
            ops: vec![],
            router: Router::new(),
        }
    }

    fn op<H, T>(mut self, method: Method, path: &'static str, h: H) -> Self
    where
        H: Handler<T, SharedState>,
        T: 'static,
    {
        let filter = MethodFilter::try_from(method.clone()).expect("a routable method");
        self.router = self.router.route(path, axum::routing::on(filter, h));
        self.ops.push((method, path));
        self
    }
}

/// The `/api/v1` operations.
pub fn table() -> Table {
    use Method as M;
    macro_rules! p {
        ($s:literal) => {
            concat!("/api/v1/files/{fileId}", $s)
        };
    }
    Table::new()
        .op(M::GET, "/api/v1/openapi.json", openapi)
        .op(M::GET, p!(""), read_file)
        .op(M::GET, p!("/blocks"), list_blocks)
        .op(M::GET, p!("/blocks/{blockId}"), get_block)
        .op(M::GET, p!("/blocks:find"), find_blocks)
        .op(M::POST, p!("/blocks:batch"), batch)
        .op(M::GET, p!("/databases"), list_databases)
        .op(M::POST, p!("/databases"), create_database)
        .op(M::GET, p!("/databases/{dbId}"), get_database)
        .op(M::GET, p!("/databases/{dbId}/rows"), query_rows)
        .op(M::POST, p!("/databases/{dbId}/rows:upsert"), upsert_rows)
        .op(M::POST, p!("/databases/{dbId}/fields"), add_field)
        .op(M::GET, p!("/boards/{boardId}/shapes"), board_shapes)
        .op(M::POST, p!("/boards/{boardId}/shapes"), add_shapes)
        .op(M::GET, p!("/comments"), list_comments)
        .op(M::POST, p!("/comments"), add_comment)
        .op(M::GET, p!("/members"), list_members)
        .op(M::GET, p!("/export/{format}"), export_file)
        .op(M::POST, p!("/import"), import_file)
        .op(M::POST, p!("/commit"), commit)
        .op(M::POST, p!("/role"), set_role)
        .op(M::DELETE, p!("/session"), close_session)
        .op(M::POST, p!("/members:invalidate"), invalidate_members)
        .op(M::POST, "/api/v1/convert", convert)
}

/// The 0.1 host routes, kept as aliases (old answers, `{error:{code,message}}` errors).
pub fn aliases() -> Table {
    use Method as M;
    Table::new()
        .op(M::POST, "/v1/files/{file_id}/role", api::set_role)
        .op(M::DELETE, "/v1/files/{file_id}/session", api::close_session)
        .op(
            M::POST,
            "/v1/files/{file_id}/members/invalidate",
            api::invalidate_members,
        )
        .op(M::POST, "/v1/files/{file_id}/patch", api::patch)
        .op(M::POST, "/v1/files/{file_id}/commit", api::commit)
        .op(M::POST, "/v1/files/{file_id}/import", import::host_import)
        .op(M::POST, "/v1/convert", api::convert)
}

/// Every operation as `(method, path)` with OpenAPI-style `{param}` names, for the contract
/// test: the v1 operations and the 0.1 aliases.
pub fn operations() -> Vec<(String, String)> {
    table()
        .ops
        .into_iter()
        .chain(aliases().ops)
        .map(|(m, p)| {
            (
                m.as_str().to_ascii_lowercase(),
                p.replace("{file_id}", "{fileId}"),
            )
        })
        .collect()
}

/// The v1 successor of a 0.1 path, for the `Link` header.
fn successor(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/v1/")?;
    let rest = rest
        .strip_suffix("/patch")
        .map(|f| format!("{f}/blocks:batch"))
        .or_else(|| {
            rest.strip_suffix("/members/invalidate")
                .map(|f| format!("{f}/members:invalidate"))
        })
        .unwrap_or_else(|| rest.to_string());
    Some(format!("/api/v1/{rest}"))
}

async fn deprecation(
    req: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> Response {
    let link = successor(req.uri().path());
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert("deprecation", HeaderValue::from_static(DEPRECATED_AT));
    if let Some(l) =
        link.and_then(|l| HeaderValue::from_str(&format!("<{l}>; rel=\"successor-version\"")).ok())
    {
        h.insert(header::LINK, l);
    }
    res
}

/// The `/api/v1` router and the 0.1 aliases, ready to merge into the app router.
pub fn router(body_limit: usize) -> Router<SharedState> {
    let limit = body_limit.max(import::MAX_IMPORT_BYTES);
    let v1 = table()
        .router
        .route("/api/v1/{*rest}", axum::routing::any(not_found))
        .layer(DefaultBodyLimit::max(limit))
        .layer(axum::middleware::from_fn(problem::ensure_problem));
    let old = aliases()
        .router
        .layer(DefaultBodyLimit::max(limit))
        .layer(axum::middleware::from_fn(deprecation));
    v1.merge(old)
}

async fn not_found() -> Problem {
    Problem::not_found("NOT_FOUND", "no such API operation")
}

impl From<AuthError> for Problem {
    fn from(e: AuthError) -> Self {
        match e {
            AuthError::Unauthenticated(m) => {
                Problem::new(StatusCode::UNAUTHORIZED, "UNAUTHENTICATED", m)
                    .header(header::WWW_AUTHENTICATE, "Bearer realm=\"opencanvas\"")
            }
            AuthError::TokenInvalid(m) => Problem::new(StatusCode::UNAUTHORIZED, "TOKEN_INVALID", m)
                .header(
                    header::WWW_AUTHENTICATE,
                    "Bearer realm=\"opencanvas\", error=\"invalid_token\"",
                ),
            AuthError::TokenExpired => {
                Problem::new(StatusCode::UNAUTHORIZED, "TOKEN_EXPIRED", "the token has expired")
                    .header(
                        header::WWW_AUTHENTICATE,
                        "Bearer realm=\"opencanvas\", error=\"invalid_token\", error_description=\"expired\"",
                    )
            }
            AuthError::InsufficientScope => Problem::new(
                StatusCode::FORBIDDEN,
                "SCOPE_REQUIRED",
                "the token carries no canvas:* scope",
            )
            .header(
                header::WWW_AUTHENTICATE,
                "Bearer realm=\"opencanvas\", error=\"insufficient_scope\", scope=\"canvas:read\"",
            ),
        }
    }
}

type Answer = Result<Response, Problem>;

/// The authenticated caller, when the API is on for its host.
async fn caller(state: &SharedState, headers: &HeaderMap) -> Result<Principal, Problem> {
    let p = Principal::from_headers(state, headers).await?;
    if !p.host.api_v1() {
        return Err(Problem::not_found(
            "API_OFF",
            "the API is not enabled for this host ([host.flags] api_v1)",
        ));
    }
    Ok(p)
}

fn check_file(file_id: &str) -> Result<(), Problem> {
    if file_id.is_empty() || file_id.len() > 1024 {
        return Err(Problem::bad_request(
            "BAD_INPUT",
            "fileId must be 1-1024 bytes",
        ));
    }
    Ok(())
}

/// One tool-layer operation as the caller, with canvas content unwrapped from the agent
/// notice (programs read it as data anyway).
async fn tool(
    state: &SharedState,
    p: &Principal,
    file_id: &str,
    name: &str,
    mut input: Value,
) -> Result<Value, Problem> {
    check_file(file_id)?;
    input["fileId"] = json!(file_id);
    let spec = crate::ai::tools::phase1_specs()
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| Problem::not_found("NOT_FOUND", "unknown operation"))?;
    p.scope_ok(spec.scope, name)?;
    let ctx = p.tool_ctx(state, file_id).await?;
    let out = LiveTools::new(state.clone())
        .call(&ctx, name, input)
        .await?;
    Ok(match (out.get("notice"), out.get("data")) {
        (Some(_), Some(d)) => d.clone(),
        _ => out,
    })
}

fn body_object(body: &Bytes) -> Result<Value, Problem> {
    if body.is_empty() {
        return Ok(json!({}));
    }
    let v: Value = serde_json::from_slice(body)
        .map_err(|e| Problem::bad_request("BAD_INPUT", format!("the body is not JSON: {e}")))?;
    if !v.is_object() {
        return Err(Problem::bad_request(
            "BAD_INPUT",
            "the body must be a JSON object",
        ));
    }
    Ok(v)
}

fn with_etag(v: Value, rev: Option<&str>) -> Response {
    let mut res = Json(v).into_response();
    if let Some(h) = rev.and_then(|r| HeaderValue::from_str(&format!("\"{r}\"")).ok()) {
        res.headers_mut().insert(header::ETAG, h);
    }
    res
}

fn require_admin(p: &Principal) -> Result<(), Problem> {
    if p.admin {
        Ok(())
    } else {
        Err(Problem::new(
            StatusCode::FORBIDDEN,
            "SCOPE_REQUIRED",
            "this operation needs canvas:admin",
        ))
    }
}

// ---------- handlers ----------

async fn openapi() -> Response {
    ([(header::CONTENT_TYPE, "application/json")], OPENAPI).into_response()
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReadQ {
    format: Option<String>,
    limit: Option<u64>,
    q: Option<String>,
    types: Option<String>,
    filter: Option<String>,
    sort: Option<String>,
    fields: Option<String>,
    cursor: Option<String>,
    resolved: Option<bool>,
}

fn csv_list(s: &Option<String>) -> Option<Vec<String>> {
    s.as_deref().map(|t| {
        t.split(',')
            .map(str::trim)
            .filter(|x| !x.is_empty())
            .map(String::from)
            .collect()
    })
}

fn json_param(name: &str, s: &Option<String>) -> Result<Option<Value>, Problem> {
    s.as_deref()
        .map(|t| {
            serde_json::from_str::<Value>(t).map_err(|_| {
                Problem::bad_request("BAD_INPUT", format!("{name} must be a JSON array"))
            })
        })
        .transpose()
}

async fn read_file(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    Query(q): Query<ReadQ>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    let format = q.format.unwrap_or_else(|| "json".into());
    let out = tool(
        &state,
        &p,
        &file_id,
        "canvas_read",
        json!({"format": format}),
    )
    .await?;
    let rev = out["rev"].as_str().map(str::to_string);
    Ok(with_etag(out, rev.as_deref()))
}

async fn list_blocks(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    Query(q): Query<ReadQ>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    let limit = q.limit.unwrap_or(100).clamp(1, 100) as usize;
    let out = tool(
        &state,
        &p,
        &file_id,
        "canvas_read",
        json!({"format": "json"}),
    )
    .await?;
    let all = out["blocks"].as_array().cloned().unwrap_or_default();
    let has_more = all.len() > limit;
    let blocks: Vec<Value> = all.into_iter().take(limit).collect();
    let rev = out["rev"].as_str().map(str::to_string);
    Ok(with_etag(
        json!({"blocks": blocks, "rev": rev, "has_more": has_more, "next_cursor": Value::Null}),
        rev.as_deref(),
    ))
}

async fn get_block(
    State(state): State<SharedState>,
    Path((file_id, block_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    let out = tool(
        &state,
        &p,
        &file_id,
        "canvas_read",
        json!({"format": "json", "blockIds": [block_id]}),
    )
    .await?;
    let block = out["blocks"]
        .as_array()
        .and_then(|b| b.first())
        .cloned()
        .ok_or_else(|| Problem::not_found("BLOCK_NOT_FOUND", "no block with that blockId"))?;
    let rev = block["rev"].as_str().map(str::to_string);
    Ok(with_etag(block, rev.as_deref()))
}

async fn find_blocks(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    Query(q): Query<ReadQ>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    let mut input = json!({"query": q.q.clone().unwrap_or_default()});
    if let Some(t) = csv_list(&q.types) {
        input["types"] = json!(t);
    }
    if let Some(l) = q.limit {
        input["limit"] = json!(l.clamp(1, 100));
    }
    Ok(Json(tool(&state, &p, &file_id, "canvas_find", input).await?).into_response())
}

/// `If-Match: "<rev>"` (or `W/"<rev>"`, or bare): the document revision the batch expects.
fn if_match(headers: &HeaderMap) -> Option<String> {
    let v = headers.get(header::IF_MATCH)?.to_str().ok()?.trim();
    if v == "*" {
        return None;
    }
    let v = v.strip_prefix("W/").unwrap_or(v);
    Some(v.trim_matches('"').to_string())
}

async fn batch(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let p = caller(&state, &headers).await?;
    let mut input = body_object(&body)?;
    if let Some(rev) = if_match(&headers) {
        input["ifMatchDoc"] = json!(rev);
    } else if let Some(o) = input.as_object_mut() {
        // Only the header sets the document precondition.
        o.remove("ifMatchDoc");
    }
    let out = tool(&state, &p, &file_id, "canvas_patch", input).await?;
    let rev = out["rev"].as_str().map(str::to_string);
    Ok(with_etag(out, rev.as_deref()))
}

async fn list_databases(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    Ok(Json(tool(&state, &p, &file_id, "db_describe", json!({})).await?).into_response())
}

async fn get_database(
    State(state): State<SharedState>,
    Path((file_id, db_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    let out = tool(&state, &p, &file_id, "db_describe", json!({"dbId": db_id})).await?;
    let db = out["databases"]
        .as_array()
        .and_then(|d| d.first())
        .cloned()
        .ok_or_else(|| Problem::not_found("DB_NOT_FOUND", "no database with that id"))?;
    Ok(Json(db).into_response())
}

async fn query_rows(
    State(state): State<SharedState>,
    Path((file_id, db_id)): Path<(String, String)>,
    Query(q): Query<ReadQ>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    let mut input = json!({"dbId": db_id});
    if let Some(f) = json_param("filter", &q.filter)? {
        input["filters"] = f;
    }
    if let Some(s) = json_param("sort", &q.sort)? {
        input["sorts"] = s;
    }
    if let Some(f) = csv_list(&q.fields) {
        input["fields"] = json!(f);
    }
    if let Some(l) = q.limit {
        input["limit"] = json!(l.clamp(1, 200));
    }
    if let Some(c) = q.cursor {
        input["cursor"] = json!(c);
    }
    Ok(Json(tool(&state, &p, &file_id, "db_query", input).await?).into_response())
}

async fn write_op(
    state: SharedState,
    file_id: String,
    headers: HeaderMap,
    body: Bytes,
    name: &str,
    extra: Value,
) -> Answer {
    let p = caller(&state, &headers).await?;
    let mut input = body_object(&body)?;
    if let (Some(o), Some(e)) = (input.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            o.insert(k.clone(), v.clone());
        }
    }
    Ok(Json(tool(&state, &p, &file_id, name, input).await?).into_response())
}

async fn create_database(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    write_op(state, file_id, headers, body, "db_create", json!({})).await
}

async fn upsert_rows(
    State(state): State<SharedState>,
    Path((file_id, db_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    write_op(
        state,
        file_id,
        headers,
        body,
        "db_upsert_rows",
        json!({"dbId": db_id}),
    )
    .await
}

async fn add_field(
    State(state): State<SharedState>,
    Path((file_id, db_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    write_op(
        state,
        file_id,
        headers,
        body,
        "db_add_field",
        json!({"dbId": db_id}),
    )
    .await
}

async fn board_shapes(
    State(state): State<SharedState>,
    Path((file_id, board_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    let out = tool(
        &state,
        &p,
        &file_id,
        "board_read",
        json!({"boardId": board_id}),
    )
    .await?;
    Ok(Json(out).into_response())
}

async fn add_shapes(
    State(state): State<SharedState>,
    Path((file_id, board_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    write_op(
        state,
        file_id,
        headers,
        body,
        "board_add_shapes",
        json!({"boardId": board_id}),
    )
    .await
}

async fn list_comments(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    Query(q): Query<ReadQ>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    let mut input = json!({});
    if let Some(r) = q.resolved {
        input["resolved"] = json!(r);
    }
    Ok(Json(tool(&state, &p, &file_id, "comment_list", input).await?).into_response())
}

async fn add_comment(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    write_op(state, file_id, headers, body, "comment_add", json!({})).await
}

async fn list_members(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    Query(q): Query<ReadQ>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    let mut input = json!({});
    if let Some(s) = q.q {
        input["q"] = json!(s);
    }
    if let Some(l) = q.limit {
        input["limit"] = json!(l.clamp(1, 500));
    }
    Ok(Json(tool(&state, &p, &file_id, "members_list", input).await?).into_response())
}

async fn export_file(
    State(state): State<SharedState>,
    Path((file_id, fmt)): Path<(String, String)>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    check_file(&file_id)?;
    if !matches!(
        fmt.as_str(),
        "md" | "html" | "json" | "ocanvas" | "docx" | "pdf"
    ) {
        return Err(Problem::not_found(
            "FORMAT_UNSUPPORTED",
            "formats: md, html, json, ocanvas, docx, pdf",
        ));
    }
    if !p.host.export_allowed(&fmt) {
        return Err(Problem::new(
            StatusCode::FORBIDDEN,
            "EXPORT_OFF",
            "this host does not allow that format",
        ));
    }
    let grant = p.grant(&state, &file_id).await?;
    let host = p.host.clone();
    let doc = export::load(&state, &host, &grant).await?;
    let wopi = super::proxy::room_assets(&host, &grant);
    let names = if fmt == "ocanvas" {
        None
    } else {
        Some(export::member_names(&state, &host, &grant, &doc).await)
    };
    let req = export::RenderReq {
        token: &grant.callback_token,
        author: &grant.user.id,
        wopi_room: wopi.then_some(grant.room.as_str()),
        people: names.as_ref(),
    };
    let (body, ctype, _) = export::render(&state, &host, &doc, &fmt, req).await?;
    Ok((
        [
            (header::CONTENT_TYPE, ctype.to_string()),
            (header::CACHE_CONTROL, "no-store".into()),
            (header::CONTENT_SECURITY_POLICY, export::EXPORT_CSP.into()),
        ],
        body,
    )
        .into_response())
}

async fn import_file(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    Query(q): Query<import::ImportParams>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let p = caller(&state, &headers).await?;
    check_file(&file_id)?;
    p.scope_ok(crate::ai::tools::Scope::Write, "import")?;
    import::check_format(&state, &p.host, &q.format)?;
    let grant = p.grant(&state, &file_id).await?;
    if grant.role != Role::Edit {
        return Err(Problem::new(
            StatusCode::FORBIDDEN,
            "ROLE_FORBIDDEN",
            "import needs the edit role",
        ));
    }
    let out = import::run(&state, &p.host, &grant, &q, &body).await?;
    Ok(Json(out).into_response())
}

async fn convert(
    State(state): State<SharedState>,
    Query(q): Query<api::ConvertParams>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let p = caller(&state, &headers).await?;
    Ok(api::convert_for(&state, &p.host, &q, &headers, &body).await?)
}

async fn commit(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    require_admin(&p)?;
    Ok(api::commit_for(&state, &file_id, &p.host).await?)
}

async fn set_role(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let p = caller(&state, &headers).await?;
    require_admin(&p)?;
    let body: api::RoleBody = serde_json::from_slice(&body).map_err(|e| {
        Problem::bad_request("BAD_INPUT", format!("expected {{userId, role}}: {e}"))
    })?;
    Ok(api::set_role_for(&state, &p.host, &file_id, body)
        .await?
        .into_response())
}

async fn close_session(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    require_admin(&p)?;
    Ok(api::close_session_for(&state, &p.host, &file_id)
        .await?
        .into_response())
}

async fn invalidate_members(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
) -> Answer {
    let p = caller(&state, &headers).await?;
    require_admin(&p)?;
    Ok(api::invalidate_members_for(&state, &p.host, &file_id)
        .await?
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn successor_links() {
        assert_eq!(
            successor("/v1/files/a/patch").as_deref(),
            Some("/api/v1/files/a/blocks:batch")
        );
        assert_eq!(
            successor("/v1/files/a/members/invalidate").as_deref(),
            Some("/api/v1/files/a/members:invalidate")
        );
        assert_eq!(successor("/v1/convert").as_deref(), Some("/api/v1/convert"));
    }
}
