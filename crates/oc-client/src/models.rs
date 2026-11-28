// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! GENERATED from `crates/oc-server/api/openapi.json` by `tests/models.rs`. Do not edit; run
//! `OC_BLESS=1 cargo test -p opencanvas-client --test models` after changing the document.

#![allow(clippy::all)]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The OpenAPI document version these models come from.
pub const API_VERSION: &str = "1.0.0";

/// A rule (docs/34 §5.3): trigger, conditions (all, or any with match = any), 1-5 actions. ownerId, ownerName, updatedAt and paused are set by the server.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AutomationRule {
    pub actions: Vec<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conditions: Option<Vec<Map<String, Value>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(rename = "match", default, skip_serializing_if = "Option::is_none")]
    pub match_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "ownerId", default, skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    #[serde(rename = "ownerName", default, skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<Map<String, Value>>,
    #[serde(rename = "timeZone", default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    pub trigger: Map<String, Value>,
    #[serde(rename = "updatedAt", default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v: Option<i64>,
    /// Members the document does not name.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One run: ids, times, counts and codes only, never canvas text. Kept 30 days.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AutomationRun {
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth: Option<i64>,
    #[serde(
        rename = "durationMs",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub duration_ms: Option<i64>,
    #[serde(rename = "errorCode", default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(rename = "fileId", default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    #[serde(
        rename = "httpStatus",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub http_status: Option<i64>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notified: Option<i64>,
    pub result: String,
    #[serde(rename = "ruleId")]
    pub rule_id: String,
    pub trigger: String,
}

/// Canvases that link here, as the reader may see them (ADR-081)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Backlinks {
    /// Per block id of this canvas: linking canvases the reader can open
    pub blocks: Map<String, Value>,
    #[serde(rename = "fileId")]
    pub file_id: String,
    pub items: Vec<Value>,
    #[serde(default)]
    pub next: Option<String>,
    /// Linking canvases the reader can open (matching the filter)
    pub total: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BatchOp {
    #[serde(rename = "blockId", default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<Map<String, Value>>>,
    /// The block rev this op expects
    #[serde(rename = "ifMatch", default, skip_serializing_if = "Option::is_none")]
    pub if_match: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    pub op: String,
    #[serde(rename = "textEdits", default, skip_serializing_if = "Option::is_none")]
    pub text_edits: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BatchRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    pub ops: Vec<BatchOp>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BatchResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied: Option<i64>,
    #[serde(rename = "blockIds", default, skip_serializing_if = "Option::is_none")]
    pub block_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,
    #[serde(
        rename = "suggestionId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub suggestion_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Block {
    #[serde(rename = "blockId", default)]
    pub block_id: Option<String>,
    pub node: Map<String, Value>,
    pub rev: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BlockPage {
    pub blocks: Vec<Block>,
    pub has_more: bool,
    #[serde(default)]
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CanvasRead {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counts: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outline: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub title: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CreateDatabase {
    #[serde(
        rename = "afterBlockId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub after_block_id: Option<String>,
    pub fields: Vec<Map<String, Value>>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<Value>>,
}

/// One change event. Ids, user ids, versions and counts only, never document content. The same shape is POSTed to webhooks (docs/05 §7c).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Event {
    /// Unix milliseconds
    pub at: i64,
    /// edited {blockIds, removedBlockIds, databaseIds?, boardIds?, by, truncated?, untracked?}; commented {threadId, blockId?, added, by}; mentioned {mentioned, by, blockId?, threadId?}; member.joined {userId, role}; member.left {userId}; session.closed {reason: host|idle}; restored {restoreId, from, by}; saved {version}; live.embedded / live.removed {blockId, type: liveBlock|blockRef, liveFileId, by}; automation.ran {ruleId, runId, trigger, result: done|skipped|stopped, changes, by: "automation:<ruleId>"}; automation.failed {ruleId, runId, trigger, code, httpStatus?}; resync {reason}
    pub data: Map<String, Value>,
    #[serde(rename = "fileId")]
    pub file_id: String,
    /// ev_<ulid>; pass the last one back as Last-Event-ID to resume (also the webhook Idempotency-Key)
    pub id: String,
    #[serde(rename = "type")]
    pub type_: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LegacyError {
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub error: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LinkDeleteResult {
    #[serde(rename = "fileId")]
    pub file_id: String,
    pub removed: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LinkIndexResult {
    pub failed: Vec<Value>,
    pub indexed: Vec<Value>,
}

/// RFC 9457 problem details
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Problem {
    /// Machine code (BLOCK_NOT_FOUND, STALE_BLOCK, ROLE_FORBIDDEN, …)
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// STALE_BLOCK: the current state to retry against
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub fresh: Value,
    pub status: i64,
    pub title: String,
    #[serde(rename = "type")]
    pub type_: String,
    /// Members the document does not name.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// search.json: the plain-text projection of a canvas (in every saved .ocanvas, and the answer of extract)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SearchJson {
    pub blocks: Vec<Value>,
    pub boards: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comments: Option<Vec<Value>>,
    pub databases: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    pub live: Vec<Map<String, Value>>,
    pub title: String,
    pub truncated: bool,
    pub v: i64,
    /// Members the document does not name.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SearchResults {
    pub items: Vec<Value>,
    #[serde(default)]
    pub next: Option<String>,
    pub partial: bool,
    pub scopes: Vec<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SyncTicket {
    #[serde(rename = "connectWithinSecs")]
    pub connect_within_secs: i64,
    /// Unix seconds; the socket closes then (15 min at most, never after the token's exp)
    #[serde(rename = "expiresAt")]
    pub expires_at: i64,
    pub role: String,
    pub room: String,
    pub ticket: String,
    /// WebSocket path to connect to (y-websocket protocol): /v1/collab/{room}?ticket=…
    pub url: String,
}

/// How an operation sends its body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyKind {
    None,
    Json,
    Binary,
}

/// What an operation answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseKind {
    Json,
    Binary,
    Stream,
}

/// One `/api/v1` operation of the document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Operation {
    pub id: &'static str,
    pub method: &'static str,
    pub path: &'static str,
    /// The least scope a user token needs (`x-opencanvas-scope`).
    pub scope: Option<&'static str>,
    pub path_params: &'static [&'static str],
    pub query: &'static [&'static str],
    pub body: BodyKind,
    pub response: ResponseKind,
    /// Paged operations: the array the items come in.
    pub paged: Option<&'static str>,
    /// Takes `Idempotency-Key` (the client sends one on every call).
    pub idempotent: bool,
}

/// Every `/api/v1` operation (the 0.1 aliases are not part of the client).
pub const OPERATIONS: &[Operation] = &[
    Operation {
        id: "convert",
        method: "POST",
        path: "/api/v1/convert",
        scope: Some("canvas:read"),
        path_params: &[],
        query: &["from", "to"],
        body: BodyKind::Binary,
        response: ResponseKind::Binary,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "extract",
        method: "POST",
        path: "/api/v1/extract",
        scope: Some("canvas:read"),
        path_params: &[],
        query: &[],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "readFile",
        method: "GET",
        path: "/api/v1/files/{fileId}",
        scope: Some("canvas:read"),
        path_params: &["fileId"],
        query: &["format"],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "listAutomations",
        method: "GET",
        path: "/api/v1/files/{fileId}/automations",
        scope: Some("canvas:read"),
        path_params: &["fileId"],
        query: &[],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "listAutomationRuns",
        method: "GET",
        path: "/api/v1/files/{fileId}/automations/runs",
        scope: Some("canvas:read"),
        path_params: &["fileId"],
        query: &["rule", "result", "before", "limit"],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "deleteAutomation",
        method: "DELETE",
        path: "/api/v1/files/{fileId}/automations/{ruleId}",
        scope: Some("canvas:write"),
        path_params: &["fileId", "ruleId"],
        query: &[],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: true,
    },
    Operation {
        id: "saveAutomation",
        method: "PUT",
        path: "/api/v1/files/{fileId}/automations/{ruleId}",
        scope: Some("canvas:write"),
        path_params: &["fileId", "ruleId"],
        query: &[],
        body: BodyKind::Json,
        response: ResponseKind::Json,
        paged: None,
        idempotent: true,
    },
    Operation {
        id: "enableAutomation",
        method: "POST",
        path: "/api/v1/files/{fileId}/automations/{ruleId}/enable",
        scope: Some("canvas:write"),
        path_params: &["fileId", "ruleId"],
        query: &[],
        body: BodyKind::Json,
        response: ResponseKind::Json,
        paged: None,
        idempotent: true,
    },
    Operation {
        id: "testAutomation",
        method: "POST",
        path: "/api/v1/files/{fileId}/automations:test",
        scope: Some("canvas:write"),
        path_params: &["fileId"],
        query: &[],
        body: BodyKind::Json,
        response: ResponseKind::Json,
        paged: None,
        idempotent: true,
    },
    Operation {
        id: "listBacklinks",
        method: "GET",
        path: "/api/v1/files/{fileId}/backlinks",
        scope: Some("canvas:read"),
        path_params: &["fileId"],
        query: &["block", "kind", "cursor", "limit"],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "listBlocks",
        method: "GET",
        path: "/api/v1/files/{fileId}/blocks",
        scope: Some("canvas:read"),
        path_params: &["fileId"],
        query: &["limit", "cursor"],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: Some("blocks"),
        idempotent: false,
    },
    Operation {
        id: "getBlock",
        method: "GET",
        path: "/api/v1/files/{fileId}/blocks/{blockId}",
        scope: Some("canvas:read"),
        path_params: &["fileId", "blockId"],
        query: &[],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "batchBlocks",
        method: "POST",
        path: "/api/v1/files/{fileId}/blocks:batch",
        scope: Some("canvas:write"),
        path_params: &["fileId"],
        query: &[],
        body: BodyKind::Json,
        response: ResponseKind::Json,
        paged: None,
        idempotent: true,
    },
    Operation {
        id: "findBlocks",
        method: "GET",
        path: "/api/v1/files/{fileId}/blocks:find",
        scope: Some("canvas:read"),
        path_params: &["fileId"],
        query: &["q", "types", "limit"],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "createBoard",
        method: "POST",
        path: "/api/v1/files/{fileId}/boards",
        scope: Some("canvas:write"),
        path_params: &["fileId"],
        query: &[],
        body: BodyKind::Json,
        response: ResponseKind::Json,
        paged: None,
        idempotent: true,
    },
    Operation {
        id: "readBoard",
        method: "GET",
        path: "/api/v1/files/{fileId}/boards/{boardId}/shapes",
        scope: Some("canvas:read"),
        path_params: &["fileId", "boardId"],
        query: &[],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "addShapes",
        method: "POST",
        path: "/api/v1/files/{fileId}/boards/{boardId}/shapes",
        scope: Some("canvas:write"),
        path_params: &["fileId", "boardId"],
        query: &[],
        body: BodyKind::Json,
        response: ResponseKind::Json,
        paged: None,
        idempotent: true,
    },
    Operation {
        id: "listComments",
        method: "GET",
        path: "/api/v1/files/{fileId}/comments",
        scope: Some("canvas:read"),
        path_params: &["fileId"],
        query: &["resolved"],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "addComment",
        method: "POST",
        path: "/api/v1/files/{fileId}/comments",
        scope: Some("canvas:comment"),
        path_params: &["fileId"],
        query: &[],
        body: BodyKind::Json,
        response: ResponseKind::Json,
        paged: None,
        idempotent: true,
    },
    Operation {
        id: "commitFile",
        method: "POST",
        path: "/api/v1/files/{fileId}/commit",
        scope: Some("canvas:admin"),
        path_params: &["fileId"],
        query: &[],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: true,
    },
    Operation {
        id: "listDatabases",
        method: "GET",
        path: "/api/v1/files/{fileId}/databases",
        scope: Some("canvas:read"),
        path_params: &["fileId"],
        query: &[],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "createDatabase",
        method: "POST",
        path: "/api/v1/files/{fileId}/databases",
        scope: Some("canvas:write"),
        path_params: &["fileId"],
        query: &[],
        body: BodyKind::Json,
        response: ResponseKind::Json,
        paged: None,
        idempotent: true,
    },
    Operation {
        id: "getDatabase",
        method: "GET",
        path: "/api/v1/files/{fileId}/databases/{dbId}",
        scope: Some("canvas:read"),
        path_params: &["fileId", "dbId"],
        query: &[],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "addField",
        method: "POST",
        path: "/api/v1/files/{fileId}/databases/{dbId}/fields",
        scope: Some("canvas:write"),
        path_params: &["fileId", "dbId"],
        query: &[],
        body: BodyKind::Json,
        response: ResponseKind::Json,
        paged: None,
        idempotent: true,
    },
    Operation {
        id: "queryRows",
        method: "GET",
        path: "/api/v1/files/{fileId}/databases/{dbId}/rows",
        scope: Some("canvas:read"),
        path_params: &["fileId", "dbId"],
        query: &["filter", "sort", "fields", "limit", "cursor"],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: Some("rows"),
        idempotent: false,
    },
    Operation {
        id: "upsertRows",
        method: "POST",
        path: "/api/v1/files/{fileId}/databases/{dbId}/rows:upsert",
        scope: Some("canvas:write"),
        path_params: &["fileId", "dbId"],
        query: &[],
        body: BodyKind::Json,
        response: ResponseKind::Json,
        paged: None,
        idempotent: true,
    },
    Operation {
        id: "streamEvents",
        method: "GET",
        path: "/api/v1/files/{fileId}/events",
        scope: Some("canvas:read"),
        path_params: &["fileId"],
        query: &["since", "types"],
        body: BodyKind::None,
        response: ResponseKind::Stream,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "exportFile",
        method: "GET",
        path: "/api/v1/files/{fileId}/export/{format}",
        scope: Some("canvas:read"),
        path_params: &["fileId", "format"],
        query: &[],
        body: BodyKind::None,
        response: ResponseKind::Binary,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "importFile",
        method: "POST",
        path: "/api/v1/files/{fileId}/import",
        scope: Some("canvas:write"),
        path_params: &["fileId"],
        query: &["format", "blockId", "name", "types"],
        body: BodyKind::Binary,
        response: ResponseKind::Json,
        paged: None,
        idempotent: true,
    },
    Operation {
        id: "makeLive",
        method: "POST",
        path: "/api/v1/files/{fileId}/live",
        scope: Some("canvas:write"),
        path_params: &["fileId"],
        query: &[],
        body: BodyKind::Json,
        response: ResponseKind::Json,
        paged: None,
        idempotent: true,
    },
    Operation {
        id: "listMembers",
        method: "GET",
        path: "/api/v1/files/{fileId}/members",
        scope: Some("canvas:read"),
        path_params: &["fileId"],
        query: &["q", "limit"],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "invalidateMembers",
        method: "POST",
        path: "/api/v1/files/{fileId}/members:invalidate",
        scope: Some("canvas:admin"),
        path_params: &["fileId"],
        query: &[],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: true,
    },
    Operation {
        id: "listReferences",
        method: "GET",
        path: "/api/v1/files/{fileId}/references",
        scope: Some("canvas:read"),
        path_params: &["fileId"],
        query: &[],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "renderFile",
        method: "GET",
        path: "/api/v1/files/{fileId}/render",
        scope: Some("canvas:read"),
        path_params: &["fileId"],
        query: &["format"],
        body: BodyKind::None,
        response: ResponseKind::Binary,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "setRole",
        method: "POST",
        path: "/api/v1/files/{fileId}/role",
        scope: Some("canvas:admin"),
        path_params: &["fileId"],
        query: &[],
        body: BodyKind::Json,
        response: ResponseKind::Json,
        paged: None,
        idempotent: true,
    },
    Operation {
        id: "closeSession",
        method: "DELETE",
        path: "/api/v1/files/{fileId}/session",
        scope: Some("canvas:admin"),
        path_params: &["fileId"],
        query: &[],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "createSyncToken",
        method: "POST",
        path: "/api/v1/files/{fileId}/sync-token",
        scope: Some("canvas:read"),
        path_params: &["fileId"],
        query: &[],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "deleteFileLinks",
        method: "DELETE",
        path: "/api/v1/links/files/{fileId}",
        scope: None,
        path_params: &["fileId"],
        query: &[],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "indexLinks",
        method: "POST",
        path: "/api/v1/links/index",
        scope: None,
        path_params: &[],
        query: &[],
        body: BodyKind::Json,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "offlineRevoke",
        method: "POST",
        path: "/api/v1/offline/revoke",
        scope: Some("canvas:admin"),
        path_params: &[],
        query: &[],
        body: BodyKind::Json,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "getOpenApi",
        method: "GET",
        path: "/api/v1/openapi.json",
        scope: None,
        path_params: &[],
        query: &[],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
    Operation {
        id: "search",
        method: "GET",
        path: "/api/v1/search",
        scope: Some("canvas:read"),
        path_params: &[],
        query: &["q", "scope", "cursor", "limit"],
        body: BodyKind::None,
        response: ResponseKind::Json,
        paged: None,
        idempotent: false,
    },
];

/// The operation with this `operationId`.
pub fn operation(id: &str) -> Option<&'static Operation> {
    OPERATIONS.iter().find(|o| o.id == id)
}
