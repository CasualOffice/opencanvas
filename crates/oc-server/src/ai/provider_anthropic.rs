// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `kind = "anthropic"`: the Claude Platform Messages API with tool use, streamed over SSE.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{Value, json};

use super::config::ProviderProfile;
use super::provider::{
    ChatRequest, ChatResponse, ModelProvider, OnEvent, Part, ProviderError, Role, SseParser,
    StopReason, StreamEvent, Usage, http_client, send_with_retry, trim_to_context,
};

pub struct Anthropic {
    profile: ProviderProfile,
    http: reqwest::Client,
    /// First retry delay (shortened in tests).
    pub backoff: Duration,
}

impl Anthropic {
    pub fn new(profile: ProviderProfile) -> Self {
        Self {
            http: http_client(&profile),
            profile,
            backoff: Duration::from_millis(500),
        }
    }

    pub fn body(&self, req: &ChatRequest) -> Value {
        let messages: Vec<Value> = req
            .messages
            .iter()
            .map(|m| {
                let content: Vec<Value> = m
                    .parts
                    .iter()
                    .map(|p| match p {
                        Part::Text(t) => json!({"type":"text","text":t}),
                        Part::ToolUse { id, name, input } => {
                            json!({"type":"tool_use","id":id,"name":name,"input":input})
                        }
                        Part::ToolResult {
                            id,
                            content,
                            is_error,
                        } => json!({"type":"tool_result","tool_use_id":id,"content":content,"is_error":is_error}),
                        Part::Opaque(v) => v.clone(),
                    })
                    .collect();
                json!({"role": if m.role == Role::User {"user"} else {"assistant"}, "content": content})
            })
            .collect();
        let mut body = json!({
            "model": req.model,
            "max_tokens": req.max_tokens,
            "system": req.system,
            "messages": messages,
            "stream": true,
        });
        if !req.tools.is_empty() {
            body["tools"] = req
                .tools
                .iter()
                .map(|t| json!({"name":t.name,"description":t.description,"input_schema":t.input_schema}))
                .collect();
            body["tool_choice"] = json!({"type":"auto"});
        }
        if let Some(geo) = &self.profile.inference_geo {
            body["inference_geo"] = json!(geo);
        }
        body
    }
}

/// A content block being assembled from the stream.
enum Block {
    Text(String),
    Tool {
        id: String,
        name: String,
        json: String,
    },
    Opaque(Value),
}

#[async_trait::async_trait]
impl ModelProvider for Anthropic {
    fn profile(&self) -> &ProviderProfile {
        &self.profile
    }

    async fn chat(
        &self,
        mut req: ChatRequest,
        on: OnEvent<'_>,
    ) -> Result<ChatResponse, ProviderError> {
        trim_to_context(&mut req, self.profile.context_tokens);
        let body = self.body(&req).to_string();
        let url = format!("{}/v1/messages", self.profile.base_url);
        let mut res = send_with_retry(&self.profile, self.backoff, || {
            self.http
                .post(&url)
                .header("x-api-key", self.profile.api_key.expose())
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .header("accept", "text/event-stream")
                .body(body.clone())
        })
        .await?;

        let mut sse = SseParser::default();
        let mut events = Vec::new();
        let mut blocks: BTreeMap<u64, Block> = BTreeMap::new();
        let mut usage = Usage::default();
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
                let Ok(v) = serde_json::from_str::<Value>(&data) else {
                    continue;
                };
                let idx = v["index"].as_u64().unwrap_or(0);
                match v["type"].as_str().unwrap_or_default() {
                    "message_start" => {
                        let u = &v["message"]["usage"];
                        usage.input = u["input_tokens"].as_u64().unwrap_or(0)
                            + u["cache_read_input_tokens"].as_u64().unwrap_or(0)
                            + u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                        usage.output = u["output_tokens"].as_u64().unwrap_or(0);
                    }
                    "content_block_start" => {
                        let b = &v["content_block"];
                        let block = match b["type"].as_str().unwrap_or_default() {
                            "text" => Block::Text(b["text"].as_str().unwrap_or("").to_string()),
                            "tool_use" => {
                                let id = b["id"].as_str().unwrap_or_default().to_string();
                                let name = b["name"].as_str().unwrap_or_default().to_string();
                                on(StreamEvent::ToolCall {
                                    id: id.clone(),
                                    name: name.clone(),
                                });
                                Block::Tool {
                                    id,
                                    name,
                                    json: String::new(),
                                }
                            }
                            _ => Block::Opaque(b.clone()),
                        };
                        blocks.insert(idx, block);
                    }
                    "content_block_delta" => {
                        let d = &v["delta"];
                        match (blocks.get_mut(&idx), d["type"].as_str().unwrap_or_default()) {
                            (Some(Block::Text(t)), "text_delta") => {
                                let s = d["text"].as_str().unwrap_or_default();
                                t.push_str(s);
                                on(StreamEvent::TextDelta(s.to_string()));
                            }
                            (Some(Block::Tool { json, .. }), "input_json_delta") => {
                                json.push_str(d["partial_json"].as_str().unwrap_or_default());
                            }
                            (Some(Block::Opaque(b)), "thinking_delta") => {
                                let s = b["thinking"].as_str().unwrap_or_default().to_string()
                                    + d["thinking"].as_str().unwrap_or_default();
                                b["thinking"] = json!(s);
                            }
                            (Some(Block::Opaque(b)), "signature_delta") => {
                                let s = b["signature"].as_str().unwrap_or_default().to_string()
                                    + d["signature"].as_str().unwrap_or_default();
                                b["signature"] = json!(s);
                            }
                            _ => {}
                        }
                    }
                    "message_delta" => {
                        if let Some(o) = v["usage"]["output_tokens"].as_u64() {
                            usage.output = o;
                        }
                        stop = match v["delta"]["stop_reason"].as_str() {
                            Some("end_turn") | Some("stop_sequence") => StopReason::EndTurn,
                            Some("tool_use") => StopReason::ToolUse,
                            Some("max_tokens") => StopReason::MaxTokens,
                            Some(o) => StopReason::Other(o.to_string()),
                            None => stop,
                        };
                    }
                    "message_stop" => done = true,
                    "error" => {
                        let kind = v["error"]["type"].as_str().unwrap_or("error");
                        return Err(match kind {
                            "overloaded_error" | "api_error" => ProviderError::Status(529),
                            "rate_limit_error" => ProviderError::RateLimited,
                            "authentication_error" => ProviderError::Unauthorised,
                            k => ProviderError::Protocol(k.to_string()),
                        });
                    }
                    _ => {}
                }
            }
        }
        let parts = blocks
            .into_values()
            .map(|b| match b {
                Block::Text(t) => Ok(Part::Text(t)),
                Block::Tool { id, name, json } => {
                    let input = if json.trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str(&json)
                            .map_err(|_| ProviderError::Protocol("tool input is not JSON".into()))?
                    };
                    Ok(Part::ToolUse { id, name, input })
                }
                Block::Opaque(v) => Ok(Part::Opaque(v)),
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ChatResponse { parts, usage, stop })
    }
}
