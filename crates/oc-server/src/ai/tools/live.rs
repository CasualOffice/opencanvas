// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! [`CanvasTools`] over live rooms: each call is one step on the room actor.

use std::sync::Arc;

use serde_json::{Value, json};

use super::{CanvasTools, Scope, ToolCtx, ToolError, ToolSpec, read, write};
use crate::SharedState;
use crate::grant::{Role, User};

/// Whether `role` may use a tool that needs `scope`: view reads, comment reads and comments,
/// edit does everything.
pub fn role_allows(role: Role, scope: Scope) -> bool {
    match scope {
        Scope::Read => true,
        Scope::Comment => matches!(role, Role::Comment | Role::Edit),
        Scope::Write => role == Role::Edit,
    }
}

fn obj(props: Value, required: &[&str]) -> Value {
    json!({"type": "object", "properties": props, "required": required})
}

fn file_id() -> Value {
    json!({"type": "string", "description": "The host's file id"})
}

/// Phase 1 tool specs (docs/24 §5.2).
pub fn phase1_specs() -> Vec<ToolSpec> {
    let mode = json!({"type": "string", "enum": ["direct", "suggest"]});
    vec![
        ToolSpec {
            name: "canvas_read",
            description: "Read the canvas as Markdown, JSON blocks or a heading outline. Every block carries a blockId and a rev hash to pass as ifMatch when changing it.",
            input_schema: obj(
                json!({"fileId": file_id(), "format": {"type": "string", "enum": ["markdown", "json", "outline"]},
                "blockIds": {"type": "array", "items": {"type": "string"}}, "maxChars": {"type": "integer"}}),
                &["fileId"],
            ),
            scope: Scope::Read,
            read_only: true,
        },
        ToolSpec {
            name: "canvas_find",
            description: "Find blocks whose text contains a query (case-insensitive).",
            input_schema: obj(
                json!({"fileId": file_id(), "query": {"type": "string"},
                "types": {"type": "array", "items": {"type": "string"}}, "limit": {"type": "integer"}}),
                &["fileId", "query"],
            ),
            scope: Scope::Read,
            read_only: true,
        },
        ToolSpec {
            name: "db_describe",
            description: "List the canvas databases with their fields, row counts and views.",
            input_schema: obj(
                json!({"fileId": file_id(), "dbId": {"type": "string"}}),
                &["fileId"],
            ),
            scope: Scope::Read,
            read_only: true,
        },
        ToolSpec {
            name: "db_query",
            description: "Query rows of a database with filters [{f, op: eq|ne|contains|gt|lt|ge|le|empty|notEmpty, v}] and sorts [{f, dir}]; fields by id or name; at most 200 rows per page.",
            input_schema: obj(
                json!({"fileId": file_id(), "dbId": {"type": "string"}, "filters": {"type": "array"},
                "sorts": {"type": "array"}, "fields": {"type": "array", "items": {"type": "string"}},
                "limit": {"type": "integer", "maximum": 200}, "cursor": {"type": "string"}}),
                &["fileId", "dbId"],
            ),
            scope: Scope::Read,
            read_only: true,
        },
        ToolSpec {
            name: "board_read",
            description: "Read the shapes of a board.",
            input_schema: obj(
                json!({"fileId": file_id(), "boardId": {"type": "string"}}),
                &["fileId", "boardId"],
            ),
            scope: Scope::Read,
            read_only: true,
        },
        ToolSpec {
            name: "comment_list",
            description: "List comment threads with their messages.",
            input_schema: obj(
                json!({"fileId": file_id(), "resolved": {"type": "boolean"}}),
                &["fileId"],
            ),
            scope: Scope::Read,
            read_only: true,
        },
        ToolSpec {
            name: "members_list",
            description: "List the people with access to this canvas (id, name, detail).",
            input_schema: obj(
                json!({"fileId": file_id(), "q": {"type": "string"}, "limit": {"type": "integer"}}),
                &["fileId"],
            ),
            scope: Scope::Read,
            read_only: true,
        },
        ToolSpec {
            name: "canvas_patch",
            description: "Change blocks: ops [{op: append|insertAfter|replace|delete|editText, blockId?, ifMatch?, markdown?|blocks?|textEdits?:[{find, replace}]}]. Changes to existing blocks become suggestions by default; deleting more than 5 blocks needs confirm: true.",
            input_schema: obj(
                json!({"fileId": file_id(), "ops": {"type": "array", "items": {"type": "object"}},
                "mode": mode, "confirm": {"type": "boolean"}}),
                &["fileId", "ops"],
            ),
            scope: Scope::Write,
            read_only: false,
        },
        ToolSpec {
            name: "db_upsert_rows",
            description: "Create or update database rows (at most 200). values map field ids or names to values; rows with an existing rowId are updated.",
            input_schema: obj(
                json!({"fileId": file_id(), "dbId": {"type": "string"},
                "rows": {"type": "array", "items": {"type": "object"}}}),
                &["fileId", "dbId", "rows"],
            ),
            scope: Scope::Write,
            read_only: false,
        },
        ToolSpec {
            name: "db_create",
            description: "Create a database block with fields [{name, type: title|text|status|select|tags|person|date|number|checkbox|url|progress, options?}] and optional rows.",
            input_schema: obj(
                json!({"fileId": file_id(), "afterBlockId": {"type": "string"}, "name": {"type": "string"},
                "fields": {"type": "array"}, "rows": {"type": "array"}}),
                &["fileId", "name", "fields"],
            ),
            scope: Scope::Write,
            read_only: false,
        },
        ToolSpec {
            name: "db_add_field",
            description: "Add a field to a database.",
            input_schema: obj(
                json!({"fileId": file_id(), "dbId": {"type": "string"}, "name": {"type": "string"},
                "type": {"type": "string"}, "options": {"type": "array"}, "description": {"type": "string"}}),
                &["fileId", "dbId", "name", "type"],
            ),
            scope: Scope::Write,
            read_only: false,
        },
        ToolSpec {
            name: "board_add_shapes",
            description: "Add shapes [{ref?, kind: sticky|rect|ellipse|diamond|text|arrow, text?, tone?, x?, y?, from?, to?}] to a board (or a new board block); shapes without coordinates are laid out (grid or flow).",
            input_schema: obj(
                json!({"fileId": file_id(), "boardId": {"type": "string"}, "afterBlockId": {"type": "string"},
                "shapes": {"type": "array"}, "layout": {"type": "string", "enum": ["grid", "flow", "cluster"]}}),
                &["fileId", "shapes"],
            ),
            scope: Scope::Write,
            read_only: false,
        },
        ToolSpec {
            name: "comment_add",
            description: "Start a comment thread on a block (or a quote), or reply with threadId.",
            input_schema: obj(
                json!({"fileId": file_id(), "blockId": {"type": "string"}, "quote": {"type": "string"},
                "text": {"type": "string"}, "threadId": {"type": "string"}}),
                &["fileId", "text"],
            ),
            scope: Scope::Comment,
            read_only: false,
        },
    ]
}

pub struct LiveTools {
    state: SharedState,
}

impl LiveTools {
    pub fn new(state: SharedState) -> Arc<Self> {
        Arc::new(Self { state })
    }

    fn members(&self, ctx: &ToolCtx, doc_people: Vec<User>, input: &Value) -> Value {
        let mut list = ctx.user.members.clone();
        for p in doc_people {
            if !list.iter().any(|m| m.id == p.id) {
                list.push(p);
            }
        }
        let list = self.state.members.without_revoked(&ctx.user.room, list);
        let q = input["q"].as_str().unwrap_or_default().to_lowercase();
        let limit = input["limit"].as_u64().unwrap_or(50).clamp(1, 500) as usize;
        let out: Vec<Value> = list
            .iter()
            .filter(|u| q.is_empty() || u.name.to_lowercase().contains(&q))
            .take(limit)
            // id, name and detail only: never an e-mail (docs/21).
            .map(|u| json!({"id": u.id, "name": u.name, "detail": u.detail}))
            .collect();
        read::wrap(json!({"members": out}))
    }
}

fn role_word(scope: Scope) -> &'static str {
    match scope {
        Scope::Read => "view",
        Scope::Comment => "comment",
        Scope::Write => "edit",
    }
}

#[async_trait::async_trait]
impl CanvasTools for LiveTools {
    fn specs(&self) -> Vec<ToolSpec> {
        phase1_specs()
    }

    async fn call(&self, ctx: &ToolCtx, name: &str, input: Value) -> Result<Value, ToolError> {
        self.run(ctx, name, input, true, false).await
    }
}

/// The server's own CSV import step (`POST /v1/import`), never offered to models or MCP.
const IMPORT_CSV: &str = "import_csv";
/// The server's own diagram import step (DGM-15), never offered to models or MCP.
const IMPORT_BOARD: &str = "import_board";
/// The server's own spreadsheet import step (SHEET-03), never offered to models or MCP.
const IMPORT_SHEET: &str = "import_sheet";
/// "Make live" (LIVE-01): writes a new live file's first content, never offered to models
/// or MCP.
const LIVE_INIT: &str = "live_init";
/// The API's block paging step (HAPI-04), never offered to models or MCP.
pub const BLOCKS_PAGE: &str = "blocks_page";

fn import_specs() -> Vec<ToolSpec> {
    [IMPORT_CSV, IMPORT_BOARD, IMPORT_SHEET, LIVE_INIT]
        .into_iter()
        .map(|name| ToolSpec {
            name,
            description: "",
            input_schema: json!({}),
            scope: Scope::Write,
            read_only: false,
        })
        .collect()
}

fn page_spec() -> ToolSpec {
    ToolSpec {
        name: BLOCKS_PAGE,
        description: "",
        input_schema: json!({}),
        scope: Scope::Read,
        read_only: true,
    }
}

impl LiveTools {
    /// One page of top-level blocks (HAPI-04): the same checks and cluster forwarding as a
    /// tool call.
    pub async fn blocks_page(&self, ctx: &ToolCtx, input: Value) -> Result<Value, ToolError> {
        self.run(ctx, BLOCKS_PAGE, input, true, true).await
    }

    /// A call another node forwarded here (docs/24 §5.6): the same checks, never forwarded again.
    pub async fn call_owned(
        &self,
        ctx: &ToolCtx,
        name: &str,
        input: Value,
    ) -> Result<Value, ToolError> {
        self.run(ctx, name, input, false, true).await
    }

    /// A CSV import as one database block (docs/23 FC-10): the same checks and cluster
    /// forwarding as a tool call, with the import row limit.
    pub async fn import_csv(&self, ctx: &ToolCtx, input: Value) -> Result<Value, ToolError> {
        self.run(ctx, IMPORT_CSV, input, true, true).await
    }

    /// "Make live" (LIVE-01): makes the live file's document `input.doc` (a `document.json`
    /// with `meta.kind = "live"`) as one edit, with cluster forwarding.
    pub async fn live_init(&self, ctx: &ToolCtx, input: Value) -> Result<Value, ToolError> {
        self.run(ctx, LIVE_INIT, input, true, true).await
    }

    /// An `.xlsx` or `.ods` import (SHEET-03): `input.block` (a Spreadsheet block's logical
    /// JSON) as a new block after `afterBlockId` or at the end.
    pub async fn import_sheet(&self, ctx: &ToolCtx, input: Value) -> Result<Value, ToolError> {
        self.run(ctx, IMPORT_SHEET, input, true, true).await
    }

    /// A diagram import (DGM-15): converted shapes onto a new board block or an open board.
    pub async fn import_board(&self, ctx: &ToolCtx, input: Value) -> Result<Value, ToolError> {
        self.run(ctx, IMPORT_BOARD, input, true, true).await
    }

    async fn run(
        &self,
        ctx: &ToolCtx,
        name: &str,
        input: Value,
        forward: bool,
        internal: bool,
    ) -> Result<Value, ToolError> {
        let spec = phase1_specs()
            .into_iter()
            .chain(internal.then(import_specs).into_iter().flatten())
            .chain(internal.then(page_spec))
            .find(|s| s.name == name)
            .ok_or_else(|| ToolError::NotFound(format!("unknown tool {name:?}")))?;
        if !input.is_object() && !input.is_null() {
            return Err(ToolError::BadInput("arguments must be an object".into()));
        }
        if input["fileId"].as_str().is_some_and(|f| f != ctx.file_id) {
            return Err(ToolError::Forbidden(
                "fileId does not match the file this call is for".into(),
            ));
        }
        let host = self
            .state
            .hosts
            .get(&ctx.host_id)
            .filter(|_| ctx.user.host_id == ctx.host_id && ctx.user.file.id == ctx.file_id)
            .ok_or_else(|| ToolError::Forbidden("unknown host or file".into()))?;
        if !role_allows(ctx.user.role, spec.scope) {
            return Err(ToolError::Forbidden(format!(
                "{name} needs the {} role; this user has {}",
                role_word(spec.scope),
                ctx.user.role.as_str()
            )));
        }
        if spec.scope == Scope::Comment && !host.comments_on() {
            return Err(ToolError::Forbidden(
                "comments are off for this host".into(),
            ));
        }
        if spec.scope == Scope::Comment && !ctx.user.perms.comment {
            return Err(ToolError::Forbidden(
                "comments are off for this user".into(),
            ));
        }
        // Re-check the grant before every write: a revoked user loses write access at once.
        if !spec.read_only
            && self
                .state
                .members
                .without_revoked(&ctx.user.room, vec![ctx.user.user.clone()])
                .is_empty()
        {
            return Err(ToolError::Forbidden("access was revoked".into()));
        }
        // Cluster: a room owned by another node runs there (docs/24 §5.6).
        if forward && self.state.rooms.cluster().is_some() {
            match self.state.rooms.tool_owner(&host, &ctx.user).await {
                Ok(Some(owner)) => {
                    if let Some(out) =
                        super::forward::forward(&self.state, &host, ctx, owner, name, &input).await
                    {
                        tracing::info!(host = %ctx.host_id, room = %ctx.user.room, tool = name,
                            origin = %ctx.origin, ok = out.is_ok(), "canvas tool (forwarded)");
                        return out;
                    }
                }
                Ok(None) => {}
                Err(e) => return Err(ToolError::Unavailable(e.to_string())),
            }
        }
        let w = write::Writer {
            user_id: ctx.user.user.id.clone(),
            name: ctx.user.user.name.clone(),
            color: ctx.user.user.color.clone(),
            origin: ctx.origin.clone(),
            mode_default: ctx.mode_default,
        };
        let i = input.clone();
        let run: crate::room::ToolFn = match name {
            "canvas_read" => Box::new(move |d| Ok((None, read::canvas_read(d, &i)?))),
            "canvas_find" => Box::new(move |d| Ok((None, read::canvas_find(d, &i)?))),
            "db_describe" => Box::new(move |d| Ok((None, read::db_describe(d, &i)?))),
            "db_query" => Box::new(move |d| Ok((None, read::db_query(d, &i)?))),
            "board_read" => Box::new(move |d| Ok((None, read::board_read(d, &i)?))),
            "comment_list" => Box::new(move |d| Ok((None, read::comment_list(d, &i)?))),
            "members_list" => Box::new(move |d| {
                let people = crate::people::saved_people(&oc_model::doc_to_json(d));
                Ok((None, serde_json::to_value(people).unwrap_or_default()))
            }),
            "canvas_patch" => Box::new(move |d| write::canvas_patch(d, &i, &w)),
            "db_upsert_rows" => Box::new(move |d| write::db_upsert_rows(d, &i)),
            "db_create" => Box::new(move |d| write::db_create(d, &i)),
            IMPORT_CSV => Box::new(move |d| write::import_csv(d, &i)),
            IMPORT_BOARD => Box::new(move |d| write::import_board(d, &i)),
            IMPORT_SHEET => Box::new(move |d| write::import_sheet(d, &i)),
            LIVE_INIT => Box::new(move |d| {
                let u =
                    oc_model::restore::restore_update(d, &i["doc"]).map_err(ToolError::BadInput)?;
                Ok((Some(u).filter(|u| !u.is_empty()), json!({"ok": true})))
            }),
            BLOCKS_PAGE => Box::new(move |d| Ok((None, read::blocks_page(d, &i)?))),
            "db_add_field" => Box::new(move |d| write::db_add_field(d, &i)),
            "board_add_shapes" => Box::new(move |d| write::board_add_shapes(d, &i)),
            "comment_add" => Box::new(move |d| write::comment_add(d, &i, &w)),
            other => return Err(ToolError::NotFound(format!("unknown tool {other:?}"))),
        };
        let out = self
            .state
            .rooms
            .tool(&host, &ctx.user, &ctx.origin, run)
            .await;
        tracing::info!(host = %ctx.host_id, room = %ctx.user.room, tool = name,
            origin = %ctx.origin, ok = out.is_ok(), "canvas tool");
        let out = out?;
        if name == "members_list" {
            let people: Vec<User> = serde_json::from_value(out).unwrap_or_default();
            return Ok(self.members(ctx, people, &input));
        }
        Ok(out)
    }
}
