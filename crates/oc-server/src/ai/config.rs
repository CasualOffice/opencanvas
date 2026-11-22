//! AI configuration (docs/24 §7.3, §8.2; ADR-031).
//!
//! Server side: `[ai]` and `[ai.providers.<name>]` in the file named by `OC_AI_CONFIG`. Keys come
//! from the environment (`api_key_env`), are held in memory only and never printed (`Secret`).
//! Host side: `[host.ai]` and `[host.ai.limits]` in the hosts file.

use std::collections::BTreeMap;
use std::fmt;

use anyhow::{Context, bail};
use serde::Deserialize;

/// A provider key. `Debug` and `Display` never print it.
#[derive(Clone, Default)]
pub struct Secret(String);

impl Secret {
    pub fn new(v: impl Into<String>) -> Self {
        Self(v.into())
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(if self.0.is_empty() {
            "<none>"
        } else {
            "<redacted>"
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum ProviderKind {
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAiCompatible => "openai-compatible",
        }
    }
}

/// One `[ai.providers.<name>]` profile.
#[derive(Debug, Clone)]
pub struct ProviderProfile {
    pub name: String,
    pub kind: ProviderKind,
    /// Without the `/v1/...` path. Default for `anthropic`: `https://api.anthropic.com`.
    pub base_url: String,
    pub api_key: Secret,
    pub model_agent: String,
    pub model_fast: String,
    /// Declared tool calling; `false` turns agent mode off for this profile without a probe.
    pub tools: bool,
    /// Context window used to trim what is sent.
    pub context_tokens: u32,
    pub max_output_tokens: u32,
    pub timeout_secs: u64,
    /// Retries on 429, 5xx and connection errors, with exponential backoff.
    pub max_retries: u32,
    pub inference_geo: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawProfile {
    kind: ProviderKind,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    api_key_env: Option<String>,
    model_agent: String,
    #[serde(default)]
    model_fast: Option<String>,
    #[serde(default)]
    tools: Option<bool>,
    #[serde(default)]
    context_tokens: Option<u32>,
    #[serde(default)]
    max_output_tokens: Option<u32>,
    #[serde(default)]
    timeout_secs: Option<u64>,
    #[serde(default)]
    max_retries: Option<u32>,
    #[serde(default)]
    inference_geo: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawAi {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    providers: BTreeMap<String, RawProfile>,
}

#[derive(Deserialize)]
struct RawFile {
    #[serde(default)]
    ai: RawAi,
}

/// The server's `[ai]` section.
#[derive(Debug, Clone, Default)]
pub struct AiConfig {
    pub enabled: bool,
    pub providers: BTreeMap<String, ProviderProfile>,
}

impl AiConfig {
    /// `OC_AI_CONFIG=<path>`; absent means AI is off.
    pub fn from_env() -> anyhow::Result<Self> {
        match std::env::var("OC_AI_CONFIG")
            .ok()
            .filter(|v| !v.trim().is_empty())
        {
            None => Ok(Self::default()),
            Some(path) => {
                let text =
                    std::fs::read_to_string(&path).with_context(|| format!("reading {path}"))?;
                Self::parse(&text, &|n| std::env::var(n).ok())
            }
        }
    }

    /// Parses `[ai]`; `env` resolves `api_key_env` names (injected for tests).
    pub fn parse(text: &str, env: &dyn Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let raw: RawFile = toml::from_str(text).context("parsing the [ai] config")?;
        let mut providers = BTreeMap::new();
        for (name, p) in raw.ai.providers {
            let api_key = match p.api_key_env.as_deref().map(str::trim) {
                None | Some("") => Secret::default(),
                Some(var) => match env(var) {
                    Some(v) if !v.trim().is_empty() => Secret::new(v.trim()),
                    _ => bail!("[ai.providers.{name}] api_key_env names {var}, which is not set"),
                },
            };
            if p.kind == ProviderKind::Anthropic && api_key.is_empty() {
                bail!("[ai.providers.{name}] kind = \"anthropic\" needs api_key_env");
            }
            let base_url = match (p.kind, p.base_url) {
                (_, Some(u)) => u.trim_end_matches('/').to_string(),
                (ProviderKind::Anthropic, None) => "https://api.anthropic.com".into(),
                (ProviderKind::OpenAiCompatible, None) => {
                    bail!("[ai.providers.{name}] kind = \"openai-compatible\" needs base_url")
                }
            };
            let base_url = base_url.trim_end_matches("/v1").to_string();
            if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
                bail!("[ai.providers.{name}] base_url must be http(s)");
            }
            providers.insert(
                name.clone(),
                ProviderProfile {
                    name,
                    kind: p.kind,
                    base_url,
                    api_key,
                    model_fast: p.model_fast.unwrap_or_else(|| p.model_agent.clone()),
                    model_agent: p.model_agent,
                    tools: p.tools.unwrap_or(true),
                    context_tokens: p.context_tokens.unwrap_or(match p.kind {
                        ProviderKind::Anthropic => 1_000_000,
                        ProviderKind::OpenAiCompatible => 32_768,
                    }),
                    max_output_tokens: p.max_output_tokens.unwrap_or(4096),
                    timeout_secs: p.timeout_secs.unwrap_or(120),
                    max_retries: p.max_retries.unwrap_or(2),
                    inference_geo: p.inference_geo,
                },
            );
        }
        Ok(Self {
            enabled: raw.ai.enabled,
            providers,
        })
    }
}

/// `[host.ai.limits]` (docs/24 §9.2 defaults).
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Limits {
    pub max_steps: u32,
    pub max_run_secs: u64,
    pub max_tokens_per_run: u64,
    pub max_writes_per_run: u32,
    pub runs_per_user_per_hour: u32,
    pub concurrent_runs_per_room: u32,
    /// Tokens (input + output) per calendar month (UTC) for the host; 0 = no quota.
    pub monthly_token_quota: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_steps: 25,
            max_run_secs: 300,
            max_tokens_per_run: 400_000,
            max_writes_per_run: 500,
            runs_per_user_per_hour: 60,
            concurrent_runs_per_room: 3,
            monthly_token_quota: 0,
        }
    }
}

/// `[host.ai]` in the hosts file.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct HostAi {
    pub enabled: bool,
    /// A profile name from `[ai.providers]`.
    pub provider: String,
    pub model_agent: Option<String>,
    pub model_fast: Option<String>,
    pub limits: Limits,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_and_local_profiles_without_printing_keys() {
        let text = r#"
[ai]
enabled = true
[ai.providers.claude]
kind = "anthropic"
api_key_env = "K1"
model_agent = "claude-opus-5-5"
model_fast = "claude-sonnet-5-5"
[ai.providers.vllm]
kind = "openai-compatible"
base_url = "http://vllm:8000/v1/"
model_agent = "qwen3-32b"
tools = false
context_tokens = 8192
"#;
        let env = |n: &str| (n == "K1").then(|| "sk-ant-SECRET".to_string());
        let c = AiConfig::parse(text, &env).unwrap();
        assert!(c.enabled);
        let claude = &c.providers["claude"];
        assert_eq!(claude.base_url, "https://api.anthropic.com");
        assert_eq!(claude.api_key.expose(), "sk-ant-SECRET");
        let v = &c.providers["vllm"];
        assert_eq!(v.base_url, "http://vllm:8000");
        assert!(!v.tools);
        assert_eq!(v.context_tokens, 8192);
        assert!(!format!("{c:?}").contains("SECRET"));
    }

    #[test]
    fn missing_key_env_is_an_error_that_names_the_variable_only() {
        let text =
            "[ai.providers.c]\nkind = \"anthropic\"\napi_key_env = \"NOPE\"\nmodel_agent = \"m\"\n";
        let e = AiConfig::parse(text, &|_| None).unwrap_err().to_string();
        assert!(e.contains("NOPE"));
    }
}
