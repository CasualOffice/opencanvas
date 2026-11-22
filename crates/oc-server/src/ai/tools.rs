//! The canvas tool layer (docs/24 §5, ADR-032/033): one contract for the in-server agent and
//! the MCP endpoint. Tools go through the room actor, so every edit is a real Yjs transaction
//! with origin `ctx.origin`, broadcast and saved like any other edit.

use serde_json::Value;

/// Who is calling a tool, on which canvas, and how writes land by default.
#[derive(Clone)]
pub struct ToolCtx {
    pub host_id: String,
    pub file_id: String,
    /// The invoking user's grant (role, user, file).
    pub user: crate::grant::Grant,
    /// `"ai:<runId>"` or `"mcp:<clientId>"`.
    pub origin: String,
    pub mode_default: WriteMode,
}

/// Where a write lands: straight into the document or into the `suggestions` root (ADR-033).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    Direct,
    Suggest,
}

/// One tool as described to a model or an MCP client.
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub scope: Scope,
    pub read_only: bool,
}

/// The least scope (and role) a tool needs: `canvas:read`, `canvas:comment`, `canvas:write`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Scope {
    Read,
    Comment,
    Write,
}

#[async_trait::async_trait]
pub trait CanvasTools: Send + Sync {
    fn specs(&self) -> Vec<ToolSpec>;
    async fn call(&self, ctx: &ToolCtx, name: &str, input: Value) -> Result<Value, ToolError>;
}

#[derive(Debug, Clone)]
pub enum ToolError {
    Forbidden(String),
    BadInput(String),
    NotFound(String),
    /// The `ifMatch` revision no longer matches; carries the current state to retry against.
    Stale(Value),
    ConfirmationRequired(String),
    Internal(String),
}

impl ToolError {
    /// The machine code an agent can act on (docs/24 §5.3).
    pub fn code(&self) -> &'static str {
        match self {
            ToolError::Forbidden(_) => "ROLE_FORBIDDEN",
            ToolError::BadInput(_) => "BAD_INPUT",
            ToolError::NotFound(_) => "NOT_FOUND",
            ToolError::Stale(_) => "STALE_BLOCK",
            ToolError::ConfirmationRequired(_) => "CONFIRMATION_REQUIRED",
            ToolError::Internal(_) => "INTERNAL",
        }
    }

    pub fn message(&self) -> String {
        match self {
            ToolError::Stale(_) => "a block changed since it was read; re-read it and retry".into(),
            ToolError::Forbidden(m)
            | ToolError::BadInput(m)
            | ToolError::NotFound(m)
            | ToolError::ConfirmationRequired(m)
            | ToolError::Internal(m) => m.clone(),
        }
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

mod live;
mod read;
mod write;

pub use live::{LiveTools, phase1_specs, role_allows};
pub use read::{DATA_NOTICE, rev};
pub use write::{CONFIRM_BLOCK_DELETES, SUGGESTIONS, suggestions};
