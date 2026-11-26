// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

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

impl WriteMode {
    pub fn as_str(self) -> &'static str {
        match self {
            WriteMode::Direct => "direct",
            WriteMode::Suggest => "suggest",
        }
    }

    pub fn parse(s: &str) -> Self {
        if s == "direct" {
            WriteMode::Direct
        } else {
            WriteMode::Suggest
        }
    }
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
    /// Cluster: the room's owner could not be reached; the caller retries after a moment.
    Unavailable(String),
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
            ToolError::Unavailable(_) => "UNAVAILABLE",
        }
    }

    pub fn message(&self) -> String {
        match self {
            ToolError::Stale(_) => "a block changed since it was read; re-read it and retry".into(),
            ToolError::Forbidden(m)
            | ToolError::BadInput(m)
            | ToolError::NotFound(m)
            | ToolError::ConfirmationRequired(m)
            | ToolError::Internal(m)
            | ToolError::Unavailable(m) => m.clone(),
        }
    }

    /// The error as JSON, for a call forwarded between nodes.
    pub fn to_json(&self) -> Value {
        let mut v = serde_json::json!({"code": self.code(), "message": self.message()});
        if let ToolError::Stale(f) = self {
            v["fresh"] = f.clone();
        }
        v
    }

    /// The inverse of [`ToolError::to_json`].
    pub fn from_json(v: &Value) -> Self {
        let m = v["message"].as_str().unwrap_or_default().to_string();
        match v["code"].as_str().unwrap_or_default() {
            "ROLE_FORBIDDEN" => ToolError::Forbidden(m),
            "BAD_INPUT" => ToolError::BadInput(m),
            "NOT_FOUND" => ToolError::NotFound(m),
            "STALE_BLOCK" => ToolError::Stale(v["fresh"].clone()),
            "CONFIRMATION_REQUIRED" => ToolError::ConfirmationRequired(m),
            "UNAVAILABLE" => ToolError::Unavailable(m),
            _ => ToolError::Internal(m),
        }
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

mod forward;
mod live;
mod read;
pub mod write;

pub use forward::{ToolForward, serve_forward};
pub use live::{LiveTools, phase1_specs, role_allows};
pub use read::{DATA_NOTICE, rev};
pub use write::{CONFIRM_BLOCK_DELETES, MAX_IMPORT_ROWS, SUGGESTIONS, suggestions};
