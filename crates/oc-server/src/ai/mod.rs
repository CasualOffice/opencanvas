//! Server-side AI (docs/24, ADR-031, ADR-034, ADR-035): model providers, the agent runtime and
//! the canvas tool contract.

pub mod agent;
pub mod config;
pub mod provider;
pub mod provider_anthropic;
pub mod provider_openai;
pub mod tools;
