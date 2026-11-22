//! LOCAL COPY of the shared canvas tool contract (owned by the MCP / tool-layer branch, which
//! commits the real file). Kept identical in shape so the merge takes theirs.

use serde_json::Value;

#[derive(Clone)]
pub struct ToolCtx {
    pub host_id: String,
    pub file_id: String,
    pub user: crate::grant::Grant,
    pub origin: String,
    pub mode_default: WriteMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    Direct,
    Suggest,
}

#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub scope: Scope,
    pub read_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    Stale(Value),
    ConfirmationRequired(String),
    Internal(String),
}
