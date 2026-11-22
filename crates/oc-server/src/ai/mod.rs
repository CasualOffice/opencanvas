//! AI and MCP (docs/24): the canvas tool layer shared by the in-server agent and the MCP
//! endpoint. The tool contract lives in [`tools`]; providers and the agent runtime are built
//! on top of it.

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

    /// `mcp_rate_per_min` (default 120) and burst (2×) per token (docs/24 §9.2).
    pub fn mcp_rate_per_min(&self) -> u32 {
        self.0
            .ai
            .get("mcp_rate_per_min")
            .and_then(|v| v.as_integer())
            .map_or(120, |n| n.clamp(1, 100_000) as u32)
    }
}
