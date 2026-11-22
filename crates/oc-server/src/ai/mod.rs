// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! AI and MCP (docs/24, ADR-031, ADR-034, ADR-035): the canvas tool layer shared by the
//! in-server agent and the MCP endpoint ([`tools`]), the model providers and the agent runtime.

pub mod agent;
pub mod agent_room;
pub mod config;
pub mod inject;
pub mod provider;
pub mod provider_anthropic;
pub mod provider_openai;
pub mod tools;

use crate::hosts::HostConfig;
use tools::WriteMode;

/// A host's `[host.ai]` settings that the tool layer and MCP endpoint read (docs/24 §7.3).
pub struct HostAi<'a>(pub &'a HostConfig);

impl HostAi<'_> {
    fn str(&self, key: &str) -> Option<&str> {
        self.0.ai.get(key).and_then(|v| v.as_str())
    }

    /// `mcp = true` turns the MCP endpoint on for this host. Off by default.
    pub fn mcp(&self) -> bool {
        self.0
            .ai
            .get("mcp")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    /// `mcp_all_files = true`: when the host has no `/access` callback, an MCP token without
    /// a `files` claim covers every file of the host with its `role` claim. Broad; off by
    /// default, so such a token is refused (SEC-34, docs/24 §7.1).
    pub fn mcp_all_files(&self) -> bool {
        self.0
            .ai
            .get("mcp_all_files")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    /// `default_mode = "direct" | "suggest"`: how changes to existing content land. New
    /// content is always direct unless a call asks for a suggestion. Default `suggest`.
    pub fn default_mode(&self) -> WriteMode {
        match self.str("default_mode") {
            Some("direct") => WriteMode::Direct,
            _ => WriteMode::Suggest,
        }
    }

    /// `mcp_issuer`: the `iss` of MCP tokens (the host's authorization server). Defaults to the
    /// host id, like launch tokens.
    pub fn mcp_issuer(&self) -> String {
        self.str("mcp_issuer")
            .map(str::to_string)
            .unwrap_or_else(|| self.0.id.clone())
    }

    /// The agent settings (`enabled`, `provider`, models, `[host.ai.limits]`), or `None` when
    /// the host has no `[host.ai]` table or it does not parse.
    pub fn agent(&self) -> Option<config::HostAi> {
        if self.0.ai.is_empty() {
            return None;
        }
        toml::Value::Table(self.0.ai.clone()).try_into().ok()
    }

    /// `mcp_rate_per_min` (default 120) and burst (2×) per token (docs/24 §9.2).
    pub fn mcp_rate_per_min(&self) -> u32 {
        self.0
            .ai
            .get("mcp_rate_per_min")
            .and_then(|v| v.as_integer())
            .map_or(120, |n| n.clamp(1, 100_000) as u32)
    }
}

/// The live tool layer over a weak handle on the app state, for the agent runtime (which the
/// app state owns through its rooms).
pub struct StateTools(pub std::sync::Weak<crate::AppState>);

#[async_trait::async_trait]
impl tools::CanvasTools for StateTools {
    fn specs(&self) -> Vec<tools::ToolSpec> {
        tools::phase1_specs()
    }

    async fn call(
        &self,
        ctx: &tools::ToolCtx,
        name: &str,
        input: serde_json::Value,
    ) -> Result<serde_json::Value, tools::ToolError> {
        let state = self
            .0
            .upgrade()
            .ok_or_else(|| tools::ToolError::Internal("server is shutting down".into()))?;
        tools::LiveTools::new(state).call(ctx, name, input).await
    }
}
