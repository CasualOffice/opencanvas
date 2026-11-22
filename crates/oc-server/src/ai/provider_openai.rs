// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `kind = "openai-compatible"`: `/v1/chat/completions` with `tools` and SSE streaming. Works
//! with OpenAI, vLLM, Ollama (`:11434`) and llama.cpp `llama-server`.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{Value, json};

use super::config::ProviderProfile;
use super::provider::{
    ChatRequest, ChatResponse, ModelProvider, OnEvent, Part, ProviderError, Role, SseParser,
    StopReason, StreamEvent, Usage, estimate_tokens, http_client, request_tokens, send_with_retry,
    trim_to_context,
};

pub struct OpenAiCompatible {
    profile: ProviderProfile,
    http: reqwest::Client,
    pub backoff: Duration,
}

impl OpenAiCompatible {
    pub fn new(profile: ProviderProfile) -> Self {
        Self {
            http: http_client(&profile),
            profile,
            backoff: Duration::from_millis(500),
        }
    }

    pub fn body(&self, req: &ChatRequest) -> Value {
        let mut messages = vec![json!({"role":"system","content":req.system})];
        for m in &req.messages {
            match m.role {
                Role::User => {
                    let mut text = String::new();
                    for p in &m.parts {
                        match p {
                            Part::Text(t) => text.push_str(t),
                            Part::ToolResult { id, content, .. } => messages
                                .push(json!({"role":"tool","tool_call_id":id,"content":content})),
                            _ => {}
                        }
                    }
                    if !text.is_empty() {
                        messages.push(json!({"role":"user","content":text}));
                    }
                }
                Role::Assistant => {
                    let text: String = m
                        .parts
                        .iter()
                        .filter_map(|p| match p {
                            Part::Text(t) => Some(t.as_str()),
                            _ => None,
                        })
                        .collect();
                    let calls: Vec<Value> = m
                        .parts
                        .iter()
                        .filter_map(|p| match p {
                            Part::ToolUse { id, name, input } => Some(json!({
                                "id": id, "type": "function",
                                "function": {"name": name, "arguments": input.to_string()}
                            })),
                            _ => None,
                        })
                        .collect();
                    let mut msg = json!({"role":"assistant","content":text});
                    if !calls.is_empty() {
                        msg["tool_calls"] = Value::Array(calls);
                    }
                    messages.push(msg);
                }
            }
        }
        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "max_tokens": req.max_tokens,
            "stream": true,
            "stream_options": {"include_usage": true},
        });
        if !req.tools.is_empty() {
            body["tools"] = req
                .tools
                .iter()
                .map(|t| json!({"type":"function","function":{"name":t.name,"description":t.description,"parameters":t.input_schema}}))
                .collect();
            body["tool_choice"] = json!("auto");
        }
        body
    }
}

#[derive(Default)]
struct Call {
    id: String,
    name: String,
    args: String,
}

#[async_trait::async_trait]
impl ModelProvider for OpenAiCompatible {
    fn profile(&self) -> &ProviderProfile {
        &self.profile
    }

    async fn chat(
        &self,
        mut req: ChatRequest,
        on: OnEvent<'_>,
    ) -> Result<ChatResponse, ProviderError> {
        trim_to_context(&mut req, self.profile.context_tokens);
        let sent_estimate = request_tokens(&req);
        let body = self.body(&req).to_string();
        let url = format!("{}/v1/chat/completions", self.profile.base_url);
        let mut res = send_with_retry(&self.profile, self.backoff, || {
            let mut b = self
                .http
                .post(&url)
                .header("content-type", "application/json")
                .header("accept", "text/event-stream")
                .body(body.clone());
            if !self.profile.api_key.is_empty() {
                b = b.bearer_auth(self.profile.api_key.expose());
            }
            b
        })
        .await?;

        let mut sse = SseParser::default();
        let mut events = Vec::new();
        let mut text = String::new();
        let mut calls: BTreeMap<u64, Call> = BTreeMap::new();
        let mut usage: Option<Usage> = None;
        let mut stop = StopReason::Other("incomplete".into());
        let mut done = false;
        while !done {
            let chunk = match res.chunk().await {
                Ok(Some(c)) => c,
                Ok(None) => {
                    sse.finish(&mut events);
                    done = true;
                    bytes::Bytes::new()
                }
                Err(e) if e.is_timeout() => return Err(ProviderError::Timeout),
                Err(_) => return Err(ProviderError::Unreachable),
            };
            sse.push(&chunk, &mut events);
            for (_, data) in events.drain(..) {
                if data.trim() == "[DONE]" {
                    done = true;
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(&data) else {
                    continue;
                };
                if v.get("error").is_some() {
                    return Err(ProviderError::Protocol("error event".into()));
                }
                if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
                    usage = Some(Usage {
                        input: u["prompt_tokens"].as_u64().unwrap_or(0),
                        output: u["completion_tokens"].as_u64().unwrap_or(0),
                    });
                }
                let Some(choice) = v["choices"].get(0) else {
                    continue;
                };
                let d = &choice["delta"];
                if let Some(s) = d["content"].as_str().filter(|s| !s.is_empty()) {
                    text.push_str(s);
                    on(StreamEvent::TextDelta(s.to_string()));
                }
                if let Some(tcs) = d["tool_calls"].as_array() {
                    for (n, tc) in tcs.iter().enumerate() {
                        let idx = tc["index"].as_u64().unwrap_or(n as u64);
                        let c = calls.entry(idx).or_default();
                        if let Some(id) = tc["id"].as_str() {
                            c.id = id.to_string();
                        }
                        if let Some(name) = tc["function"]["name"].as_str() {
                            if c.name.is_empty() {
                                on(StreamEvent::ToolCall {
                                    id: c.id.clone(),
                                    name: name.to_string(),
                                });
                            }
                            c.name.push_str(name);
                        }
                        // Ollama sends whole arguments as an object; others stream a string.
                        match &tc["function"]["arguments"] {
                            Value::String(s) => c.args.push_str(s),
                            Value::Null => {}
                            other => c.args.push_str(&other.to_string()),
                        }
                    }
                }
                if let Some(r) = choice["finish_reason"].as_str() {
                    stop = match r {
                        "stop" => StopReason::EndTurn,
                        "tool_calls" | "function_call" => StopReason::ToolUse,
                        "length" => StopReason::MaxTokens,
                        o => StopReason::Other(o.to_string()),
                    };
                }
            }
        }
        let mut parts = Vec::new();
        if !text.is_empty() {
            parts.push(Part::Text(text.clone()));
        }
        for (i, c) in calls {
            let input = if c.args.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&c.args)
                    .map_err(|_| ProviderError::Protocol("tool arguments are not JSON".into()))?
            };
            let id = if c.id.is_empty() {
                format!("call_{i}")
            } else {
                c.id
            };
            parts.push(Part::ToolUse {
                id,
                name: c.name,
                input,
            });
        }
        if parts.iter().any(|p| matches!(p, Part::ToolUse { .. })) {
            stop = StopReason::ToolUse;
        }
        // Servers without `stream_options` support send no usage: estimate it.
        let usage = usage.unwrap_or(Usage {
            input: sent_estimate,
            output: estimate_tokens(&text),
        });
        Ok(ChatResponse { parts, usage, stop })
    }
}
