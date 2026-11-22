//! The `ModelProvider` abstraction (docs/24 §8.2, ADR-031): streaming chat with tools over two
//! wire protocols, `anthropic` (Claude Platform) and `openai-compatible` (OpenAI, vLLM, Ollama,
//! llama.cpp). The browser never reaches a provider; keys never leave this process.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use super::config::{ProviderKind, ProviderProfile};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    Text(String),
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        id: String,
        content: String,
        is_error: bool,
    },
    /// A provider block that must be sent back unchanged (Claude thinking blocks).
    Opaque(Value),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Msg {
    pub role: Role,
    pub parts: Vec<Part>,
}

impl Msg {
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            parts: vec![Part::Text(text.into())],
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub system: String,
    pub messages: Vec<Msg>,
    pub tools: Vec<ToolDef>,
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
}

impl Usage {
    pub fn total(&self) -> u64 {
        self.input + self.output
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    Other(String),
}

/// What a streaming call reports as it goes.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    TextDelta(String),
    ToolCall { id: String, name: String },
}

/// The assembled answer of one call.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatResponse {
    /// Assistant content in order (text, tool uses, opaque blocks).
    pub parts: Vec<Part>,
    pub usage: Usage,
    pub stop: StopReason,
}

impl ChatResponse {
    pub fn text(&self) -> String {
        self.parts
            .iter()
            .filter_map(|p| match p {
                Part::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect()
    }

    pub fn tool_calls(&self) -> Vec<(String, String, Value)> {
        self.parts
            .iter()
            .filter_map(|p| match p {
                Part::ToolUse { id, name, input } => {
                    Some((id.clone(), name.clone(), input.clone()))
                }
                _ => None,
            })
            .collect()
    }
}

/// Errors carry no request content and never the key.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProviderError {
    #[error("provider refused the credentials")]
    Unauthorised,
    #[error("provider rate limit")]
    RateLimited,
    #[error("provider unreachable")]
    Unreachable,
    #[error("provider timed out")]
    Timeout,
    #[error("provider answered {0}")]
    Status(u16),
    #[error("provider protocol error: {0}")]
    Protocol(String),
}

impl ProviderError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unauthorised => "unauthorised",
            Self::RateLimited => "rate_limited",
            Self::Unreachable => "unreachable",
            Self::Timeout => "timeout",
            Self::Status(_) => "status",
            Self::Protocol(_) => "protocol",
        }
    }
}

pub type OnEvent<'a> = &'a mut (dyn FnMut(StreamEvent) + Send);

#[async_trait::async_trait]
pub trait ModelProvider: Send + Sync {
    fn profile(&self) -> &ProviderProfile;
    /// One streaming call. Dropping the future aborts the HTTP request.
    async fn chat(&self, req: ChatRequest, on: OnEvent<'_>) -> Result<ChatResponse, ProviderError>;
}

pub fn build(profile: ProviderProfile) -> Arc<dyn ModelProvider> {
    match profile.kind {
        ProviderKind::Anthropic => Arc::new(super::provider_anthropic::Anthropic::new(profile)),
        ProviderKind::OpenAiCompatible => {
            Arc::new(super::provider_openai::OpenAiCompatible::new(profile))
        }
    }
}

pub(crate) fn http_client(profile: &ProviderProfile) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(profile.timeout_secs.max(1)))
        .build()
        .unwrap_or_default()
}

/// Sends `make()` with retries on 429, 5xx and connection errors (exponential backoff from
/// `base`, honouring a short `Retry-After`). Only the status is ever logged.
pub(crate) async fn send_with_retry(
    profile: &ProviderProfile,
    base: Duration,
    make: impl Fn() -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, ProviderError> {
    let mut attempt = 0u32;
    loop {
        let res = make().send().await;
        let retry_err = match res {
            Ok(r) if r.status().is_success() => return Ok(r),
            Ok(r) => {
                let s = r.status().as_u16();
                let err = match s {
                    401 | 403 => return Err(ProviderError::Unauthorised),
                    429 => ProviderError::RateLimited,
                    500..=599 => ProviderError::Status(s),
                    _ => return Err(ProviderError::Status(s)),
                };
                let after = r
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.trim().parse::<u64>().ok())
                    .map(|s| Duration::from_secs(s.min(10)));
                (err, after)
            }
            Err(e) if e.is_timeout() => (ProviderError::Timeout, None),
            Err(_) => (ProviderError::Unreachable, None),
        };
        if attempt >= profile.max_retries {
            return Err(retry_err.0);
        }
        let delay = retry_err.1.unwrap_or(base * 2u32.pow(attempt));
        tracing::info!(provider = %profile.name, attempt, error = retry_err.0.code(), "model call retried");
        tokio::time::sleep(delay).await;
        attempt += 1;
    }
}

/// Server-sent events: yields each event's `(event, data)` as lines complete.
#[derive(Default)]
pub(crate) struct SseParser {
    buf: Vec<u8>,
    event: String,
    data: String,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8], out: &mut Vec<(String, String)>) {
        self.buf.extend_from_slice(chunk);
        while let Some(nl) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() || !self.event.is_empty() {
                    out.push((
                        std::mem::take(&mut self.event),
                        std::mem::take(&mut self.data),
                    ));
                }
            } else if let Some(v) = line.strip_prefix("data:") {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(v.strip_prefix(' ').unwrap_or(v));
            } else if let Some(v) = line.strip_prefix("event:") {
                self.event = v.trim().to_string();
            }
        }
    }

    pub fn finish(&mut self, out: &mut Vec<(String, String)>) {
        self.push(b"\n\n", out);
    }
}

/// Rough token estimate (4 characters a token) used to trim and to stand in for missing usage.
pub fn estimate_tokens(s: &str) -> u64 {
    (s.chars().count() as u64).div_ceil(4)
}

fn part_tokens(p: &Part) -> u64 {
    match p {
        Part::Text(t) => estimate_tokens(t),
        Part::ToolUse { input, .. } => estimate_tokens(&input.to_string()) + 8,
        Part::ToolResult { content, .. } => estimate_tokens(content) + 8,
        Part::Opaque(v) => estimate_tokens(&v.to_string()),
    }
}

pub fn request_tokens(req: &ChatRequest) -> u64 {
    let tools: u64 = req
        .tools
        .iter()
        .map(|t| estimate_tokens(&t.description) + estimate_tokens(&t.input_schema.to_string()))
        .sum();
    estimate_tokens(&req.system)
        + tools
        + req
            .messages
            .iter()
            .flat_map(|m| m.parts.iter())
            .map(part_tokens)
            .sum::<u64>()
}

/// Trims `req` to fit `context_tokens` minus the output budget: drops the oldest whole
/// assistant/tool exchanges after the first user message, then shortens long texts.
pub fn trim_to_context(req: &mut ChatRequest, context_tokens: u32) {
    let budget = (context_tokens as u64).saturating_sub(req.max_tokens as u64);
    // Drop exchanges (pairs after the first message) while too large, keeping the last 2.
    while request_tokens(req) > budget && req.messages.len() > 3 {
        req.messages.drain(1..3);
    }
    if request_tokens(req) <= budget {
        return;
    }
    // Still too large: cut the longest texts down.
    let over = request_tokens(req) - budget;
    let mut longest: Option<&mut String> = None;
    let mut best = 0;
    for m in req.messages.iter_mut() {
        for p in m.parts.iter_mut() {
            let s = match p {
                Part::Text(t) => t,
                Part::ToolResult { content, .. } => content,
                _ => continue,
            };
            if s.len() > best {
                best = s.len();
                longest = Some(s);
            }
        }
    }
    if let Some(s) = longest {
        let keep_chars = s.chars().count().saturating_sub((over as usize + 16) * 4);
        let cut: String = s.chars().take(keep_chars).collect();
        *s = format!("{cut}\n[truncated to fit the model's context]");
    }
}

/// The start-up capability probe: one request with one tool; `true` when the model called it.
pub async fn probe_tools(p: &dyn ModelProvider) -> bool {
    if !p.profile().tools {
        return false;
    }
    let req = ChatRequest {
        model: p.profile().model_agent.clone(),
        system: "You are a capability probe. Call the tool you are given.".into(),
        messages: vec![Msg::user("Call the `probe` tool with ok set to true.")],
        tools: vec![ToolDef {
            name: "probe".into(),
            description: "Reports that tool calling works.".into(),
            input_schema: json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}),
        }],
        max_tokens: 1024,
    };
    match p.chat(req, &mut |_| {}).await {
        Ok(r) => r.tool_calls().iter().any(|(_, n, _)| n == "probe"),
        Err(e) => {
            tracing::warn!(provider = %p.profile().name, error = e.code(), "AI provider probe failed");
            false
        }
    }
}
