// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The events stream (docs/05 §7b) over Server-Sent Events. A dropped stream (or close code
//! 4008) reconnects with `Last-Event-ID`: the server answers what was missed, or a `resync`
//! event when it no longer has it. 4001 and 4003 end it with [`Error::StreamClosed`].

use std::collections::VecDeque;
use std::time::Duration;

use reqwest::header::HeaderValue;

use crate::client::{Client, Params};
use crate::error::{ApiError, Error, Result};
use crate::models::{self, Event};

/// What to stream.
#[derive(Debug, Clone, Default)]
pub struct EventsOptions {
    pub file_id: String,
    /// Only these event types (empty: all).
    pub types: Vec<String>,
    /// Resume after this event id.
    pub last_event_id: Option<String>,
    /// Do not reconnect when the stream drops.
    pub no_reconnect: bool,
    /// Give up after this many reconnects in a row without an event (default 10).
    pub max_reconnects: Option<u32>,
}

impl EventsOptions {
    pub fn new(file_id: impl Into<String>) -> Self {
        Self {
            file_id: file_id.into(),
            ..Self::default()
        }
    }
}

/// One SSE frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub id: Option<String>,
    pub event: String,
    pub data: String,
}

/// Parses complete SSE frames out of `buf`, leaving the unparsed rest in it.
pub fn parse_frames(buf: &mut String) -> Vec<Frame> {
    if buf.contains('\r') {
        *buf = buf.replace("\r\n", "\n").replace('\r', "\n");
    }
    let mut out = vec![];
    while let Some(end) = buf.find("\n\n") {
        let block: String = buf.drain(..end + 2).collect();
        let mut f = Frame {
            id: None,
            event: "message".into(),
            data: String::new(),
        };
        let mut data: Vec<&str> = vec![];
        for line in block.lines() {
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "id" => f.id = Some(value.to_string()),
                "event" => f.event = value.to_string(),
                "data" => data.push(value),
                _ => {}
            }
        }
        if data.is_empty() {
            continue;
        }
        f.data = data.join("\n");
        out.push(f);
    }
    out
}

/// Change events of one file. `while let Some(e) = stream.next().await { … }`; drop it to
/// close. [`EventStream::last_event_id`] is where to resume later.
pub struct EventStream {
    client: Client,
    opts: EventsOptions,
    last_event_id: Option<String>,
    res: Option<reqwest::Response>,
    buf: String,
    queue: VecDeque<Event>,
    failures: u32,
    done: bool,
    /// A final close seen after events still queued: raised once those are taken.
    ended: Option<Error>,
}

impl EventStream {
    pub(crate) fn new(client: Client, opts: EventsOptions) -> Self {
        Self {
            client,
            last_event_id: opts.last_event_id.clone(),
            opts,
            res: None,
            buf: String::new(),
            queue: VecDeque::new(),
            failures: 0,
            done: false,
            ended: None,
        }
    }

    /// The id of the last event received (or the one this stream resumed from).
    pub fn last_event_id(&self) -> Option<&str> {
        self.last_event_id.as_deref()
    }

    /// Connects now (otherwise the first `next()` does); returns once the server accepted the
    /// stream, so events of changes made after this are delivered.
    pub async fn ready(&mut self) -> Result<()> {
        if self.res.is_none() && !self.done {
            self.connect().await?;
        }
        Ok(())
    }

    /// Ends the stream.
    pub fn close(&mut self) {
        self.done = true;
        self.res = None;
    }

    async fn connect(&mut self) -> Result<()> {
        let op = models::operation("streamEvents").expect("streamEvents in the document");
        let mut p = Params::file(&self.opts.file_id);
        if !self.opts.types.is_empty() {
            p = p.query("types", self.opts.types.join(","));
        }
        let url = self.client.url(op, &p)?;
        let mut attempt = 0;
        loop {
            let mut rb = self
                .client
                .http()
                .get(&url)
                .header(reqwest::header::ACCEPT, "text/event-stream")
                .headers(self.client.auth_headers().await);
            if let Some(id) = &self.last_event_id
                && let Ok(v) = HeaderValue::from_str(id)
            {
                rb = rb.header("last-event-id", v);
            }
            let res = rb.send().await.map_err(Error::Network)?;
            if res.status().is_success() {
                self.buf.clear();
                self.res = Some(res);
                return Ok(());
            }
            let status = res.status().as_u16();
            let headers = res.headers().clone();
            let body = res.bytes().await.map_err(Error::Network)?;
            let err = ApiError::new(status, &body, headers);
            if matches!(status, 429 | 503) && attempt < self.client.default_retries() {
                self.client.wait(self.client.wait_for(&err, attempt)).await;
                attempt += 1;
                continue;
            }
            return Err(Error::Api(Box::new(err)));
        }
    }

    /// The next event; `None` once the stream ended (closed, or out of reconnects).
    pub async fn next(&mut self) -> Option<Result<Event>> {
        loop {
            if let Some(e) = self.queue.pop_front() {
                return Some(Ok(e));
            }
            if let Some(e) = self.ended.take() {
                return Some(Err(e));
            }
            if self.done {
                return None;
            }
            let Some(res) = self.res.as_mut() else {
                if let Err(e) = self.connect().await {
                    self.done = true;
                    return Some(Err(e));
                }
                continue;
            };
            match res.chunk().await {
                Ok(Some(bytes)) => {
                    self.buf.push_str(&String::from_utf8_lossy(&bytes));
                    for f in parse_frames(&mut self.buf) {
                        if let Err(e) = self.take(f) {
                            self.done = true;
                            self.res = None;
                            self.ended = Some(e);
                            break;
                        }
                    }
                }
                Ok(None) => {
                    if let Err(e) = self.dropped(None).await {
                        return Some(Err(e));
                    }
                }
                Err(e) => {
                    if let Err(e) = self.dropped(Some(Error::Network(e))).await {
                        return Some(Err(e));
                    }
                }
            }
        }
    }

    fn take(&mut self, f: Frame) -> Result<()> {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&f.data) else {
            return Ok(());
        };
        if f.event == "close" {
            let code = v["code"].as_u64().unwrap_or(0) as u16;
            if code == 4008 {
                // Fell behind: reconnecting resumes from the last id.
                self.res = None;
                return Ok(());
            }
            return Err(Error::StreamClosed {
                code,
                reason: v["reason"].as_str().unwrap_or_default().to_string(),
            });
        }
        let ev: Event = serde_json::from_value(v).map_err(|e| Error::Decode(e.to_string()))?;
        self.last_event_id = f.id.or_else(|| Some(ev.id.clone()));
        self.failures = 0;
        self.queue.push_back(ev);
        Ok(())
    }

    async fn dropped(&mut self, cause: Option<Error>) -> Result<()> {
        self.res = None;
        if self.opts.no_reconnect || self.failures >= self.opts.max_reconnects.unwrap_or(10) {
            self.done = true;
            return match cause {
                Some(e) => Err(e),
                None => Ok(()),
            };
        }
        let wait = Duration::from_secs(1u64 << self.failures.min(5)).min(Duration::from_secs(30));
        self.client.wait(wait).await;
        self.failures += 1;
        Ok(())
    }
}
