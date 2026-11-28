// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The client core: credentials, `Idempotency-Key` on writes, RateLimit-aware retries, RFC
//! 9457 errors and cursor paging, over the generated operation table ([`crate::models`]).

use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use futures::stream::{self, Stream};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::error::{ApiError, Error, ProblemKind, Result};
use crate::events::{EventStream, EventsOptions};
use crate::models::{self, BodyKind, Operation};

/// How the client proves who it is.
#[derive(Clone)]
pub enum Auth {
    /// Server to server: the host key (full access to the host's files).
    HostKey {
        host_id: String,
        key: String,
        /// `X-OpenCanvas-Author`: the user changes are attributed to.
        author: Option<String>,
        /// `X-OpenCanvas-Callback-Token`: the bearer OpenCanvas passes on your callbacks.
        callback_token: Option<String>,
    },
    /// A user-scoped token your host minted (docs/05 §7b).
    Token(String),
    /// A token source called before every request, so it can refresh.
    TokenFn(Arc<dyn Fn() -> BoxFuture<'static, String> + Send + Sync>),
    None,
}

impl Auth {
    pub fn host_key(host_id: impl Into<String>, key: impl Into<String>) -> Self {
        Auth::HostKey {
            host_id: host_id.into(),
            key: key.into(),
            author: None,
            callback_token: None,
        }
    }
}

/// Waits between retries; inject one that moves a fake clock in tests.
pub type Sleeper = Arc<dyn Fn(Duration) -> BoxFuture<'static, ()> + Send + Sync>;

/// A request body.
#[derive(Debug, Clone)]
pub enum Body {
    Json(Value),
    Binary(Vec<u8>),
}

/// The arguments of one operation: path parameters, query and body.
#[derive(Debug, Clone, Default)]
pub struct Params {
    pub path: Vec<(String, String)>,
    pub query: Vec<(String, String)>,
    pub body: Option<Body>,
}

impl Params {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn file(file_id: impl Into<String>) -> Self {
        Self::new().path("fileId", file_id)
    }

    pub fn path(mut self, name: &str, value: impl Into<String>) -> Self {
        self.path.push((name.into(), value.into()));
        self
    }

    pub fn query(mut self, name: &str, value: impl ToString) -> Self {
        self.query.push((name.into(), value.to_string()));
        self
    }

    pub fn json(mut self, body: Value) -> Self {
        self.body = Some(Body::Json(body));
        self
    }

    pub fn binary(mut self, body: Vec<u8>) -> Self {
        self.body = Some(Body::Binary(body));
        self
    }

    /// From JSON `{<path params>…, "query": {…}, "body": …}` (the conformance suite's form):
    /// list query values are joined with commas, objects are sent as JSON.
    pub fn from_json(op: &Operation, v: &Value) -> Self {
        let mut p = Params::new();
        for name in op.path_params {
            if let Some(x) = v.get(*name) {
                p.path.push((
                    name.to_string(),
                    x.as_str().map_or(x.to_string(), String::from),
                ));
            }
        }
        if let Some(q) = v["query"].as_object() {
            for (k, x) in q {
                let s = match x {
                    Value::Null => continue,
                    Value::String(s) => s.clone(),
                    Value::Array(a) if a.iter().all(|e| !e.is_object() && !e.is_array()) => a
                        .iter()
                        .map(|e| e.as_str().map_or(e.to_string(), String::from))
                        .collect::<Vec<_>>()
                        .join(","),
                    other => other.to_string(),
                };
                p.query.push((k.clone(), s));
            }
        }
        if let Some(b) = v.get("body") {
            p.body = Some(Body::Json(b.clone()));
        }
        p
    }
}

/// Per-call options.
#[derive(Debug, Clone, Default)]
pub struct CallOptions {
    /// The `Idempotency-Key` of a write: `None` = a fresh random key (reused on retries),
    /// `Some("")` = send none.
    pub idempotency_key: Option<String>,
    /// `If-Match`: the document `rev` a `batchBlocks` call expects.
    pub if_match: Option<String>,
    /// Overrides the client's retry count for this call.
    pub max_retries: Option<u32>,
}

impl CallOptions {
    pub fn key(k: impl Into<String>) -> Self {
        Self {
            idempotency_key: Some(k.into()),
            ..Self::default()
        }
    }

    pub fn if_match(rev: impl Into<String>) -> Self {
        Self {
            if_match: Some(rev.into()),
            ..Self::default()
        }
    }
}

/// The tightest bucket of the `RateLimit` header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateLimit {
    pub policy: String,
    pub remaining: u64,
    pub reset_secs: u64,
}

/// Parses `RateLimit: "subject";r=29;t=1`.
pub fn parse_rate_limit(v: &str) -> Option<RateLimit> {
    let (policy, rest) = v.trim().split_once(';')?;
    let mut r = None;
    let mut t = None;
    for p in rest.split(';') {
        match p.trim().split_once('=') {
            Some(("r", x)) => r = x.trim().parse().ok(),
            Some(("t", x)) => t = x.trim().parse().ok(),
            _ => {}
        }
    }
    Some(RateLimit {
        policy: policy.trim().trim_matches('"').to_string(),
        remaining: r?,
        reset_secs: t?,
    })
}

/// An answer with what its headers say.
#[derive(Debug, Clone)]
pub struct ApiResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
    /// The `ETag` without quotes: the document (or block) `rev`.
    pub etag: Option<String>,
    /// `Idempotency-Replayed: true`.
    pub replayed: bool,
    pub rate_limit: Option<RateLimit>,
    /// The `Idempotency-Key` the request carried.
    pub idempotency_key: Option<String>,
}

impl ApiResponse {
    /// The body as JSON (`null` when empty).
    pub fn value(&self) -> Result<Value> {
        if self.body.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&self.body).map_err(|e| Error::Decode(e.to_string()))
    }

    /// The body as a model.
    pub fn json<T: DeserializeOwned>(&self) -> Result<T> {
        serde_json::from_slice(&self.body).map_err(|e| Error::Decode(e.to_string()))
    }
}

struct Inner {
    http: reqwest::Client,
    base: String,
    auth: Auth,
    sleep: Sleeper,
    max_retries: u32,
    retry_base: Duration,
    retry_max: Duration,
    keygen: Arc<dyn Fn() -> String + Send + Sync>,
}

/// The OpenCanvas headless API client. Cheap to clone.
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

/// Builds a [`Client`].
pub struct ClientBuilder {
    base: String,
    auth: Auth,
    http: Option<reqwest::Client>,
    sleep: Option<Sleeper>,
    max_retries: u32,
    retry_base: Duration,
    retry_max: Duration,
    keygen: Option<Arc<dyn Fn() -> String + Send + Sync>>,
}

impl ClientBuilder {
    pub fn auth(mut self, auth: Auth) -> Self {
        self.auth = auth;
        self
    }

    pub fn http(mut self, http: reqwest::Client) -> Self {
        self.http = Some(http);
        self
    }

    /// How the client waits between retries (default `tokio::time::sleep`).
    pub fn sleeper(mut self, s: Sleeper) -> Self {
        self.sleep = Some(s);
        self
    }

    /// Retries of a 429, a 503, a 409 `IDEMPOTENCY_IN_PROGRESS` or a network error (default 3).
    pub fn max_retries(mut self, n: u32) -> Self {
        self.max_retries = n;
        self
    }

    /// Backoff without `Retry-After`: `base` doubled per attempt, at most `max`.
    pub fn backoff(mut self, base: Duration, max: Duration) -> Self {
        self.retry_base = base;
        self.retry_max = max;
        self
    }

    /// Makes `Idempotency-Key` values (default a random ULID).
    pub fn idempotency_keys(mut self, f: impl Fn() -> String + Send + Sync + 'static) -> Self {
        self.keygen = Some(Arc::new(f));
        self
    }

    pub fn build(self) -> Client {
        Client {
            inner: Arc::new(Inner {
                http: self.http.unwrap_or_default(),
                base: self.base.trim_end_matches('/').to_string(),
                auth: self.auth,
                sleep: self
                    .sleep
                    .unwrap_or_else(|| Arc::new(|d| Box::pin(tokio::time::sleep(d)))),
                max_retries: self.max_retries,
                retry_base: self.retry_base,
                retry_max: self.retry_max,
                keygen: self
                    .keygen
                    .unwrap_or_else(|| Arc::new(|| format!("oc-{}", ulid::Ulid::new()))),
            }),
        }
    }
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn retriable(e: &ApiError) -> bool {
    matches!(e.status, 429 | 503) || e.kind == ProblemKind::IdempotencyInProgress
}

impl Client {
    pub fn builder(base_url: impl Into<String>) -> ClientBuilder {
        ClientBuilder {
            base: base_url.into(),
            auth: Auth::None,
            http: None,
            sleep: None,
            max_retries: 3,
            retry_base: Duration::from_millis(500),
            retry_max: Duration::from_secs(30),
            keygen: None,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.inner.base
    }

    /// The URL of an operation with its path parameters and query.
    pub fn url(&self, op: &Operation, params: &Params) -> Result<String> {
        let mut path = op.path.to_string();
        for name in op.path_params {
            let v = params
                .path
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.as_str())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| Error::Invalid(format!("{}: {name} is required", op.id)))?;
            path = path.replace(&format!("{{{name}}}"), &encode(v));
        }
        let q: Vec<String> = params
            .query
            .iter()
            .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
            .collect();
        Ok(if q.is_empty() {
            format!("{}{path}", self.inner.base)
        } else {
            format!("{}{path}?{}", self.inner.base, q.join("&"))
        })
    }

    pub(crate) async fn auth_headers(&self) -> HeaderMap {
        let mut h = HeaderMap::new();
        let mut put = |k: &'static str, v: &str| {
            if let Ok(v) = HeaderValue::from_str(v) {
                h.insert(HeaderName::from_static(k), v);
            }
        };
        match &self.inner.auth {
            Auth::HostKey {
                host_id,
                key,
                author,
                callback_token,
            } => {
                put("x-opencanvas-host", host_id);
                put("x-opencanvas-key", key);
                if let Some(a) = author {
                    put("x-opencanvas-author", a);
                }
                if let Some(t) = callback_token {
                    put("x-opencanvas-callback-token", t);
                }
            }
            Auth::Token(t) => put("authorization", &format!("Bearer {t}")),
            Auth::TokenFn(f) => put("authorization", &format!("Bearer {}", f().await)),
            Auth::None => {}
        }
        h
    }

    fn backoff(&self, attempt: u32) -> Duration {
        let d = self
            .inner
            .retry_base
            .saturating_mul(2u32.saturating_pow(attempt));
        d.min(self.inner.retry_max)
    }

    pub(crate) async fn wait(&self, d: Duration) {
        (self.inner.sleep)(d).await
    }

    pub(crate) fn http(&self) -> &reqwest::Client {
        &self.inner.http
    }

    pub(crate) fn wait_for(&self, e: &ApiError, attempt: u32) -> Duration {
        e.retry_after_secs
            .map(Duration::from_secs)
            .unwrap_or_else(|| self.backoff(attempt))
    }

    pub(crate) fn default_retries(&self) -> u32 {
        self.inner.max_retries
    }

    /// Sends one operation by `operationId`. Error answers become [`Error::Api`] after the
    /// retriable ones are retried.
    pub async fn call(
        &self,
        op_id: &str,
        params: &Params,
        opts: &CallOptions,
    ) -> Result<ApiResponse> {
        let op = models::operation(op_id)
            .ok_or_else(|| Error::Invalid(format!("unknown operation {op_id}")))?;
        self.call_op(op, params, opts).await
    }

    async fn call_op(
        &self,
        op: &Operation,
        params: &Params,
        opts: &CallOptions,
    ) -> Result<ApiResponse> {
        let url = self.url(op, params)?;
        let method = reqwest::Method::from_bytes(op.method.as_bytes())
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let mut headers = HeaderMap::new();
        headers.insert(
            reqwest::header::ACCEPT,
            HeaderValue::from_static("application/json, application/problem+json"),
        );
        let body: Option<Vec<u8>> = match (op.body, &params.body) {
            (BodyKind::Json, b) => {
                headers.insert(
                    reqwest::header::CONTENT_TYPE,
                    HeaderValue::from_static("application/json"),
                );
                let v = match b {
                    Some(Body::Json(v)) => v.clone(),
                    _ => json!({}),
                };
                Some(serde_json::to_vec(&v).map_err(|e| Error::Invalid(e.to_string()))?)
            }
            (BodyKind::Binary, Some(Body::Binary(b))) => {
                headers.insert(
                    reqwest::header::CONTENT_TYPE,
                    HeaderValue::from_static("application/octet-stream"),
                );
                Some(b.clone())
            }
            _ => None,
        };
        let key = match &opts.idempotency_key {
            _ if !op.idempotent => None,
            Some(k) if k.is_empty() => None,
            Some(k) => Some(k.clone()),
            None => Some((self.inner.keygen)()),
        };
        if let Some(k) = &key {
            headers.insert(
                "idempotency-key",
                HeaderValue::from_str(k).map_err(|e| Error::Invalid(e.to_string()))?,
            );
        }
        if let Some(rev) = &opts.if_match {
            headers.insert(
                reqwest::header::IF_MATCH,
                HeaderValue::from_str(&format!("\"{}\"", rev.trim_matches('"')))
                    .map_err(|e| Error::Invalid(e.to_string()))?,
            );
        }
        // A write without a key may have run when its answer is lost: never resend it.
        let safe = op.method == "GET" || key.is_some();
        let max = opts.max_retries.unwrap_or(self.inner.max_retries);
        let mut attempt = 0;
        loop {
            let mut rb = self
                .inner
                .http
                .request(method.clone(), &url)
                .headers(headers.clone())
                .headers(self.auth_headers().await);
            if let Some(b) = &body {
                rb = rb.body(b.clone());
            }
            let res = match rb.send().await {
                Ok(r) => r,
                Err(e) if safe && attempt < max => {
                    let _ = e;
                    self.wait(self.backoff(attempt)).await;
                    attempt += 1;
                    continue;
                }
                Err(e) => return Err(Error::Network(e)),
            };
            let status = res.status().as_u16();
            let rheaders = res.headers().clone();
            let bytes = res.bytes().await.map_err(Error::Network)?.to_vec();
            if (200..300).contains(&status) {
                let h = |k: &str| rheaders.get(k).and_then(|v| v.to_str().ok());
                return Ok(ApiResponse {
                    status,
                    etag: h("etag")
                        .map(|e| e.trim_start_matches("W/").trim_matches('"').to_string()),
                    replayed: h("idempotency-replayed") == Some("true"),
                    rate_limit: h("ratelimit").and_then(parse_rate_limit),
                    idempotency_key: key,
                    headers: rheaders,
                    body: bytes,
                });
            }
            let err = ApiError::new(status, &bytes, rheaders);
            if retriable(&err) && (safe || status == 429) && attempt < max {
                self.wait(self.wait_for(&err, attempt)).await;
                attempt += 1;
                continue;
            }
            return Err(Error::Api(Box::new(err)));
        }
    }

    /// Every page of a paged operation (`listBlocks`, `queryRows`), following `next_cursor`.
    pub fn pages(
        &self,
        op_id: &str,
        params: Params,
        opts: CallOptions,
    ) -> impl Stream<Item = Result<Value>> + Send + 'static {
        let client = self.clone();
        let op_id = op_id.to_string();
        stream::unfold(Some((params, false)), move |state| {
            let client = client.clone();
            let op_id = op_id.clone();
            let opts = opts.clone();
            async move {
                let (mut params, _) = state?;
                let page = match client
                    .call(&op_id, &params, &opts)
                    .await
                    .and_then(|r| r.value())
                {
                    Ok(p) => p,
                    Err(e) => return Some((Err(e), None)),
                };
                let next = page["next_cursor"].as_str().map(str::to_string);
                let state = next.map(|c| {
                    params.query.retain(|(k, _)| k != "cursor");
                    params.query.push(("cursor".into(), c));
                    (params, true)
                });
                Some((Ok(page), state))
            }
        })
    }

    /// Every item of a paged operation, page after page.
    pub fn paginate(
        &self,
        op_id: &str,
        params: Params,
        opts: CallOptions,
    ) -> impl Stream<Item = Result<Value>> + Send + 'static {
        use futures::StreamExt;
        let items = models::operation(op_id)
            .and_then(|o| o.paged)
            .unwrap_or("items");
        self.pages(op_id, params, opts).flat_map(move |page| {
            let list: Vec<Result<Value>> = match page {
                Ok(p) => p[items]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(Ok)
                    .collect(),
                Err(e) => vec![Err(e)],
            };
            stream::iter(list)
        })
    }

    /// The change events of one file (SSE), resuming with `Last-Event-ID` on reconnects.
    pub fn events(&self, opts: EventsOptions) -> EventStream {
        EventStream::new(self.clone(), opts)
    }

    async fn typed<T: DeserializeOwned>(&self, op: &str, p: Params, o: &CallOptions) -> Result<T> {
        self.call(op, &p, o).await?.json()
    }

    async fn bytes(&self, op: &str, p: Params) -> Result<Vec<u8>> {
        Ok(self.call(op, &p, &CallOptions::default()).await?.body)
    }

    // ---------- one method per operation ----------

    /// `GET /api/v1/files/{fileId}?format=json|markdown|outline`
    pub async fn read_file(
        &self,
        file_id: &str,
        format: Option<&str>,
    ) -> Result<models::CanvasRead> {
        let mut p = Params::file(file_id);
        if let Some(f) = format {
            p = p.query("format", f);
        }
        self.typed("readFile", p, &CallOptions::default()).await
    }

    /// `GET …/blocks?limit=&cursor=`: one page; see [`Client::paginate`] for all.
    pub async fn list_blocks(
        &self,
        file_id: &str,
        limit: Option<u32>,
        cursor: Option<&str>,
    ) -> Result<models::BlockPage> {
        let mut p = Params::file(file_id);
        if let Some(l) = limit {
            p = p.query("limit", l);
        }
        if let Some(c) = cursor {
            p = p.query("cursor", c);
        }
        self.typed("listBlocks", p, &CallOptions::default()).await
    }

    /// `GET …/blocks/{blockId}`
    pub async fn get_block(&self, file_id: &str, block_id: &str) -> Result<models::Block> {
        self.typed(
            "getBlock",
            Params::file(file_id).path("blockId", block_id),
            &CallOptions::default(),
        )
        .await
    }

    /// `GET …/blocks:find?q=&types=&limit=`
    pub async fn find_blocks(&self, file_id: &str, q: &str, types: &[&str]) -> Result<Value> {
        let mut p = Params::file(file_id).query("q", q);
        if !types.is_empty() {
            p = p.query("types", types.join(","));
        }
        self.typed("findBlocks", p, &CallOptions::default()).await
    }

    /// `POST …/blocks:batch` (pass [`CallOptions::if_match`] for the document precondition).
    pub async fn batch_blocks(
        &self,
        file_id: &str,
        req: &models::BatchRequest,
        opts: &CallOptions,
    ) -> Result<models::BatchResult> {
        let body = serde_json::to_value(req).map_err(|e| Error::Invalid(e.to_string()))?;
        self.typed("batchBlocks", Params::file(file_id).json(body), opts)
            .await
    }

    /// `GET …/databases`
    pub async fn list_databases(&self, file_id: &str) -> Result<Value> {
        self.typed(
            "listDatabases",
            Params::file(file_id),
            &CallOptions::default(),
        )
        .await
    }

    /// `POST …/databases`
    pub async fn create_database(
        &self,
        file_id: &str,
        req: &models::CreateDatabase,
        opts: &CallOptions,
    ) -> Result<Value> {
        let body = serde_json::to_value(req).map_err(|e| Error::Invalid(e.to_string()))?;
        self.typed("createDatabase", Params::file(file_id).json(body), opts)
            .await
    }

    /// `GET …/databases/{dbId}`
    pub async fn get_database(&self, file_id: &str, db_id: &str) -> Result<Value> {
        self.typed(
            "getDatabase",
            Params::file(file_id).path("dbId", db_id),
            &CallOptions::default(),
        )
        .await
    }

    /// `GET …/databases/{dbId}/rows`: one page; `query` holds `filter`, `sort`, `fields`,
    /// `limit`, `cursor` (see [`Client::paginate`] for all rows).
    pub async fn query_rows(
        &self,
        file_id: &str,
        db_id: &str,
        query: &[(&str, &str)],
    ) -> Result<Value> {
        let mut p = Params::file(file_id).path("dbId", db_id);
        for (k, v) in query {
            p = p.query(k, v);
        }
        self.typed("queryRows", p, &CallOptions::default()).await
    }

    /// `POST …/databases/{dbId}/rows:upsert` with `{rows: [{rowId?, values}]}`
    pub async fn upsert_rows(
        &self,
        file_id: &str,
        db_id: &str,
        body: Value,
        opts: &CallOptions,
    ) -> Result<Value> {
        self.typed(
            "upsertRows",
            Params::file(file_id).path("dbId", db_id).json(body),
            opts,
        )
        .await
    }

    /// `POST …/databases/{dbId}/fields`
    pub async fn add_field(
        &self,
        file_id: &str,
        db_id: &str,
        body: Value,
        opts: &CallOptions,
    ) -> Result<Value> {
        self.typed(
            "addField",
            Params::file(file_id).path("dbId", db_id).json(body),
            opts,
        )
        .await
    }

    /// `GET …/boards/{boardId}/shapes`
    pub async fn read_board(&self, file_id: &str, board_id: &str) -> Result<Value> {
        self.typed(
            "readBoard",
            Params::file(file_id).path("boardId", board_id),
            &CallOptions::default(),
        )
        .await
    }

    /// `POST …/boards` with `{shapes, afterBlockId?, layout?}`: a new board block.
    pub async fn create_board(
        &self,
        file_id: &str,
        body: Value,
        opts: &CallOptions,
    ) -> Result<Value> {
        self.typed("createBoard", Params::file(file_id).json(body), opts)
            .await
    }

    /// `POST …/boards/{boardId}/shapes`
    pub async fn add_shapes(
        &self,
        file_id: &str,
        board_id: &str,
        body: Value,
        opts: &CallOptions,
    ) -> Result<Value> {
        self.typed(
            "addShapes",
            Params::file(file_id).path("boardId", board_id).json(body),
            opts,
        )
        .await
    }

    /// `GET …/comments?resolved=`
    pub async fn list_comments(&self, file_id: &str, resolved: Option<bool>) -> Result<Value> {
        let mut p = Params::file(file_id);
        if let Some(r) = resolved {
            p = p.query("resolved", r);
        }
        self.typed("listComments", p, &CallOptions::default()).await
    }

    /// `POST …/comments` with `{text, blockId | quote, threadId?}`
    pub async fn add_comment(
        &self,
        file_id: &str,
        body: Value,
        opts: &CallOptions,
    ) -> Result<Value> {
        self.typed("addComment", Params::file(file_id).json(body), opts)
            .await
    }

    /// `GET …/members?q=&limit=`
    pub async fn list_members(&self, file_id: &str, q: Option<&str>) -> Result<Value> {
        let mut p = Params::file(file_id);
        if let Some(q) = q {
            p = p.query("q", q);
        }
        self.typed("listMembers", p, &CallOptions::default()).await
    }

    /// `GET …/export/{md|html|json|ocanvas|docx|pdf}`: the file's bytes.
    pub async fn export_file(&self, file_id: &str, format: &str) -> Result<Vec<u8>> {
        self.bytes("exportFile", Params::file(file_id).path("format", format))
            .await
    }

    /// `GET …/render?format=html` (LIVE-06): the canvas as one read-only, sanitised HTML page.
    pub async fn render_file(&self, file_id: &str) -> Result<Vec<u8>> {
        self.bytes("renderFile", Params::file(file_id).query("format", "html"))
            .await
    }

    /// `POST …/live` (LIVE-01): moves top-level blocks into a new live file the host creates
    /// and puts one `liveBlock` in their place: `{liveFileId, blockId, kind}`.
    pub async fn make_live(
        &self,
        file_id: &str,
        block_ids: &[&str],
        name: &str,
        opts: &CallOptions,
    ) -> Result<Value> {
        self.typed(
            "makeLive",
            Params::file(file_id).json(json!({"blockIds": block_ids, "name": name})),
            opts,
        )
        .await
    }

    /// `GET …/references` (LIVE-01): the canvas's live blocks and block references with the
    /// caller's access to each source.
    pub async fn list_references(&self, file_id: &str) -> Result<Value> {
        self.typed(
            "listReferences",
            Params::file(file_id),
            &CallOptions::default(),
        )
        .await
    }

    /// `GET …/backlinks?block=&kind=&cursor=` (LINK-03): the canvases that link here, as the
    /// token's user may see them.
    pub async fn list_backlinks(
        &self,
        file_id: &str,
        block: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<models::Backlinks> {
        let mut p = Params::file(file_id);
        if let Some(b) = block {
            p = p.query("block", b);
        }
        if let Some(c) = cursor {
            p = p.query("cursor", c);
        }
        self.typed("listBacklinks", p, &CallOptions::default())
            .await
    }

    /// `POST /api/v1/links/index {fileIds}` (host key): backfill the link index.
    pub async fn index_links(&self, file_ids: &[&str]) -> Result<models::LinkIndexResult> {
        let p = Params::new().json(json!({ "fileIds": file_ids }));
        self.typed("indexLinks", p, &CallOptions::default()).await
    }

    /// `DELETE /api/v1/links/files/{fileId}` (host key): drop a deleted file's links.
    pub async fn delete_file_links(&self, file_id: &str) -> Result<models::LinkDeleteResult> {
        self.typed(
            "deleteFileLinks",
            Params::file(file_id),
            &CallOptions::default(),
        )
        .await
    }

    /// `POST …/import?format=`
    pub async fn import_file(
        &self,
        file_id: &str,
        format: &str,
        bytes: Vec<u8>,
        opts: &CallOptions,
    ) -> Result<Value> {
        self.typed(
            "importFile",
            Params::file(file_id).query("format", format).binary(bytes),
            opts,
        )
        .await
    }

    /// `POST …/commit` (admin)
    pub async fn commit_file(&self, file_id: &str) -> Result<Value> {
        self.typed("commitFile", Params::file(file_id), &CallOptions::default())
            .await
    }

    /// `POST …/role {userId, role}` (admin)
    pub async fn set_role(&self, file_id: &str, user_id: &str, role: &str) -> Result<Value> {
        let p = Params::file(file_id).json(json!({"userId": user_id, "role": role}));
        self.typed("setRole", p, &CallOptions::default()).await
    }

    /// `DELETE …/session` (admin)
    pub async fn close_session(&self, file_id: &str) -> Result<Value> {
        self.typed(
            "closeSession",
            Params::file(file_id),
            &CallOptions::default(),
        )
        .await
    }

    /// `POST …/members:invalidate` (admin)
    pub async fn invalidate_members(&self, file_id: &str) -> Result<Value> {
        self.typed(
            "invalidateMembers",
            Params::file(file_id),
            &CallOptions::default(),
        )
        .await
    }

    /// `POST …/sync-token`: a ticket for the room WebSocket (headless CRDT sync).
    pub async fn create_sync_token(&self, file_id: &str) -> Result<models::SyncTicket> {
        self.typed(
            "createSyncToken",
            Params::file(file_id),
            &CallOptions::default(),
        )
        .await
    }

    /// `POST /api/v1/convert?from=&to=`: converted bytes.
    pub async fn convert(&self, from: &str, to: &str, bytes: Vec<u8>) -> Result<Vec<u8>> {
        self.bytes(
            "convert",
            Params::new()
                .query("from", from)
                .query("to", to)
                .binary(bytes),
        )
        .await
    }

    /// `GET /api/v1/openapi.json`
    pub async fn openapi(&self) -> Result<Value> {
        self.typed("getOpenApi", Params::new(), &CallOptions::default())
            .await
    }
}
