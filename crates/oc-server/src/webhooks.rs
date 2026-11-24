// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Webhooks (WH-01, ADR-056): the change events of HAPI-05 POSTed to a host's
//! `[host.webhooks] url`, signed like callbacks, from a durable outbox (`webhook_outbox`).
//!
//! - The node that owns a room queues its events (the hub's sink → [`spawn_writer`]); the row
//!   id is the event id, so an event is queued once.
//! - Every node delivers ([`crate::AppState::deliver_webhooks`]): due rows are claimed one by one
//!   (a conditional update), so exactly one node sends each attempt.
//! - Retries with backoff on network errors, 408/425/429 and 5xx (a longer `Retry-After` wins);
//!   other 3xx/4xx are final; give up after `max_attempts`.
//! - SSRF: the URL must be on the origin of the host's `callback_base` (checked at startup and
//!   before every delivery); redirects are never followed.

use std::sync::Arc;
use std::time::Duration;

use reqwest::StatusCode;
use url::Url;

use crate::hosts::HostConfig;
use crate::metrics::{Metrics, labels};
use crate::store::{Store, WebhookRow};

/// Retry delays (seconds) after the 1st, 2nd, … failed attempt; the last repeats.
pub const BACKOFF_SECS: [i64; 11] = [
    10, 30, 60, 300, 900, 1800, 3600, 7200, 14_400, 28_800, 43_200,
];
/// Default attempts before giving up (about a day with [`BACKOFF_SECS`]).
pub const MAX_ATTEMPTS: u32 = 12;
/// One attempt holds a row this long before another worker may take it.
pub const CLAIM_MS: i64 = 60_000;
/// Per-attempt timeout.
pub const TIMEOUT: Duration = Duration::from_secs(10);
/// Finished rows are kept this long.
pub const KEEP_MS: i64 = 7 * 86_400_000;
/// Deliveries attempted at once by one node.
pub const PARALLEL: usize = 8;

/// `[host.webhooks]`, checked.
#[derive(Debug, Clone, PartialEq)]
pub struct WebhookCfg {
    /// As configured.
    pub url: Url,
    /// `None`: every event type.
    pub events: Option<Vec<String>>,
    pub secret: Option<String>,
    pub max_attempts: u32,
}

impl WebhookCfg {
    /// The host's webhook settings; `Ok(None)` when it has none. Errors name what is wrong.
    pub fn of(host: &HostConfig) -> anyhow::Result<Option<Self>> {
        let t = &host.webhooks;
        if t.is_empty() {
            return Ok(None);
        }
        for k in t.keys() {
            if !matches!(k.as_str(), "url" | "events" | "secret" | "max_attempts") {
                anyhow::bail!(
                    "[host.webhooks] has no setting {k:?} (url, events, secret, max_attempts)"
                );
            }
        }
        let raw = t
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("[host.webhooks] url is required"))?;
        let url = Url::parse(raw).map_err(|e| anyhow::anyhow!("[host.webhooks] url: {e}"))?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            anyhow::bail!("[host.webhooks] url must be http(s)://host/…");
        }
        if !url.username().is_empty() || url.password().is_some() {
            anyhow::bail!("[host.webhooks] url must not carry credentials");
        }
        target(host, &url)?;
        let events = match t.get("events") {
            None => anyhow::bail!(
                "[host.webhooks] events is required (a list of event types, or [\"*\"])"
            ),
            Some(v) => {
                let list = v
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("[host.webhooks] events must be a list"))?;
                let mut out = Vec::new();
                for e in list {
                    let e = e
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("[host.webhooks] events holds strings"))?;
                    if e != "*" && !crate::events::TYPES.contains(&e) {
                        anyhow::bail!(
                            "[host.webhooks] unknown event {e:?}; one of {} or \"*\"",
                            crate::events::TYPES.join(", ")
                        );
                    }
                    out.push(e.to_string());
                }
                if out.is_empty() {
                    anyhow::bail!("[host.webhooks] events is empty");
                }
                (!out.iter().any(|e| e == "*")).then_some(out)
            }
        };
        let secret = match t.get("secret") {
            None => None,
            Some(v) => Some(
                v.as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| anyhow::anyhow!("[host.webhooks] secret must be a string"))?
                    .to_string(),
            ),
        };
        let max_attempts = match t.get("max_attempts") {
            None => MAX_ATTEMPTS,
            Some(v) => v
                .as_integer()
                .filter(|n| (1..=20).contains(n))
                .ok_or_else(|| anyhow::anyhow!("[host.webhooks] max_attempts is 1-20"))?
                as u32,
        };
        Ok(Some(Self {
            url,
            events,
            secret,
            max_attempts,
        }))
    }

    pub fn wants(&self, kind: &str) -> bool {
        self.events
            .as_ref()
            .is_none_or(|e| e.iter().any(|x| x == kind))
    }

    /// The HMAC key: `[host.webhooks] secret`, else the host's callback signing secret.
    pub fn signing_secret<'a>(&'a self, host: &'a HostConfig) -> &'a [u8] {
        self.secret
            .as_deref()
            .map(str::as_bytes)
            .unwrap_or_else(|| host.signing_secret())
    }
}

/// Why a URL may not be called.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct Refused(pub String);

fn origin(u: &Url) -> (String, String, Option<u16>) {
    (
        u.scheme().to_string(),
        u.host_str().unwrap_or_default().to_ascii_lowercase(),
        u.port_or_known_default(),
    )
}

/// The URL actually called for `url` (ADR-056 SSRF rule): on the origin of the host's
/// `callback_base`; a URL on the configured origin while `OC_CALLBACK_BASE_OVERRIDE` is set goes
/// through the override's origin, like callbacks. Anything else is refused.
pub fn target(host: &HostConfig, url: &Url) -> Result<Url, Refused> {
    let base = Url::parse(&host.callback_base).map_err(|_| {
        Refused("webhooks need the host's callback_base (the URL must be on its origin)".into())
    })?;
    if origin(url) == origin(&base) {
        return Ok(url.clone());
    }
    if let Some(orig) = host
        .original_callback_base
        .as_deref()
        .and_then(|b| Url::parse(b).ok())
        && origin(url) == origin(&orig)
    {
        let mut u = url.clone();
        let _ = u.set_scheme(base.scheme());
        let _ = u.set_host(base.host_str());
        let _ = u.set_port(base.port());
        return Ok(u);
    }
    Err(Refused(format!(
        "webhook URL {}://{}{} is not on the callback_base origin {}://{}{}",
        url.scheme(),
        url.host_str().unwrap_or_default(),
        url.port().map(|p| format!(":{p}")).unwrap_or_default(),
        base.scheme(),
        base.host_str().unwrap_or_default(),
        base.port().map(|p| format!(":{p}")).unwrap_or_default(),
    )))
}

/// What one attempt came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Done,
    /// Try again at this time (ms).
    Retry(i64),
    /// The receiver refused (3xx or 4xx other than 408/425/429): final.
    Rejected,
    /// Out of attempts: final.
    GaveUp,
    /// The URL is not allowed, or the host is gone: final, nothing sent.
    Refused,
}

impl Outcome {
    pub fn result(&self) -> &'static str {
        match self {
            Self::Done => "ok",
            Self::Retry(_) => "retry",
            Self::Rejected => "rejected",
            Self::GaveUp => "gave_up",
            Self::Refused => "refused",
        }
    }
}

/// When to try again after the `failed`-th failed attempt (1-based), honouring `Retry-After`.
pub fn next_try(now_ms: i64, failed: i64, retry_after_secs: Option<i64>) -> i64 {
    let i = (failed.max(1) - 1) as usize;
    let backoff = BACKOFF_SECS[i.min(BACKOFF_SECS.len() - 1)];
    let wait = retry_after_secs.map_or(backoff, |r| {
        r.clamp(0, *BACKOFF_SECS.last().unwrap()).max(backoff)
    });
    now_ms + wait * 1000
}

/// Webhook delivery: its own HTTP client (no redirects) and the worker's wake-up.
pub struct Webhooks {
    http: reqwest::Client,
    /// Rung when a row is queued, so the worker sends it without waiting for its tick.
    pub wake: tokio::sync::Notify,
}

impl Default for Webhooks {
    fn default() -> Self {
        Self {
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent(concat!("opencanvas-webhooks/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("http client"),
            wake: tokio::sync::Notify::new(),
        }
    }
}

impl Webhooks {
    /// Sends one claimed row (attempt `row.attempts + 1`) and records the outcome.
    pub async fn attempt(
        &self,
        store: &Store,
        metrics: &Metrics,
        host: Option<&HostConfig>,
        row: &WebhookRow,
        now_ms: i64,
    ) -> Outcome {
        let host_id = row.host_id.as_str();
        let plan = host
            .ok_or_else(|| Refused(format!("unknown host {host_id}")))
            .and_then(|h| {
                let cfg = WebhookCfg::of(h)
                    .map_err(|e| Refused(e.to_string()))?
                    .ok_or_else(|| Refused("the host has no [host.webhooks] any more".into()))?;
                let url = target(h, &cfg.url)?;
                Ok((h, cfg, url))
            });
        let (host, cfg, url) = match plan {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(host = host_id, event = %row.id, error = %e, "webhook refused");
                return self
                    .record(store, metrics, row, Outcome::Refused, 0, now_ms)
                    .await;
            }
        };
        let body = row.payload.clone().into_bytes();
        let path_query = match url.query() {
            Some(q) => format!("{}?{q}", url.path()),
            None => url.path().to_string(),
        };
        let sig = crate::host_client::signature_header(
            cfg.signing_secret(host),
            now_ms.div_euclid(1000),
            "POST",
            &path_query,
            &body,
        );
        let attempt = row.attempts + 1;
        let started = std::time::Instant::now();
        let sent = self
            .http
            .post(url)
            .timeout(TIMEOUT)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header("X-OpenCanvas-Event", &row.event_type)
            .header("X-OpenCanvas-Event-Id", &row.id)
            .header("Idempotency-Key", &row.id)
            .header("X-OpenCanvas-Delivery-Attempt", attempt.to_string())
            .header("X-OpenCanvas-Signature", sig)
            .body(body)
            .send()
            .await;
        metrics
            .webhook_seconds
            .observe(labels(&[("host", host_id)]), started.elapsed());
        let (status, retry_after) = match &sent {
            Ok(r) => (
                Some(r.status()),
                r.headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.trim().parse::<i64>().ok()),
            ),
            Err(_) => (None, None),
        };
        let retryable =
            |s: StatusCode| s.is_server_error() || matches!(s.as_u16(), 408 | 425 | 429);
        let outcome = match status {
            Some(s) if s.is_success() => Outcome::Done,
            Some(s) if !retryable(s) => Outcome::Rejected,
            _ if attempt >= i64::from(cfg.max_attempts) => Outcome::GaveUp,
            _ => Outcome::Retry(next_try(now_ms, attempt, retry_after)),
        };
        match (&outcome, &sent) {
            (Outcome::Done, _) => {}
            (_, Ok(r)) => {
                tracing::info!(host = host_id, event = %row.id, attempt, status = r.status().as_u16(), ?outcome, "webhook not accepted")
            }
            (_, Err(e)) => {
                tracing::warn!(host = host_id, event = %row.id, attempt, error = %e, ?outcome, "webhook failed")
            }
        }
        let code = status.map_or(0, |s| i64::from(s.as_u16()));
        self.record(store, metrics, row, outcome, code, now_ms)
            .await
    }

    async fn record(
        &self,
        store: &Store,
        metrics: &Metrics,
        row: &WebhookRow,
        outcome: Outcome,
        code: i64,
        now_ms: i64,
    ) -> Outcome {
        let done = match &outcome {
            Outcome::Retry(at) => store.webhook_retry(&row.id, *at, code).await,
            Outcome::Done => store.webhook_finish(&row.id, "done", code, now_ms).await,
            Outcome::Rejected => {
                store
                    .webhook_finish(&row.id, "rejected", code, now_ms)
                    .await
            }
            Outcome::GaveUp => store.webhook_finish(&row.id, "failed", code, now_ms).await,
            Outcome::Refused => store.webhook_finish(&row.id, "refused", code, now_ms).await,
        };
        if let Err(e) = done {
            tracing::error!(error = %e, event = %row.id, "recording a webhook attempt failed");
        }
        metrics.webhook_deliveries.inc(labels(&[
            ("host", row.host_id.as_str()),
            ("result", outcome.result()),
        ]));
        outcome
    }
}

/// Queues the events this node publishes for hosts that subscribe to them (the owner's hub
/// sink; ADR-056 §2).
pub fn spawn_writer(
    hub: &Arc<crate::events::Hub>,
    hosts: crate::hosts::Hosts,
    store: Store,
    clock: Arc<crate::clock::Clock>,
    webhooks: Arc<Webhooks>,
) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<crate::events::FileEvent>();
    hub.set_sink(tx);
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let Some(host) = hosts.get(&ev.host_id) else {
                continue;
            };
            let Ok(Some(cfg)) = WebhookCfg::of(&host) else {
                continue;
            };
            if !cfg.wants(&ev.kind) {
                continue;
            }
            let now = clock.now_ms();
            let row = WebhookRow {
                id: ev.id.clone(),
                host_id: ev.host_id.clone(),
                room_id: ev.room.clone(),
                file_id: ev.file_id.clone(),
                event_type: ev.kind.clone(),
                payload: ev.public().to_string(),
                attempts: 0,
                next_try_at: now,
            };
            match store.webhook_insert(&row, now).await {
                Ok(_) => webhooks.wake.notify_one(),
                Err(e) => {
                    tracing::error!(host = %ev.host_id, event = %ev.id, error = %e, "queueing a webhook failed")
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(base: &str, hooks: &str) -> HostConfig {
        let mut h: HostConfig = toml::from_str(&format!(
            "id = \"h\"\nname = \"H\"\ncallback_base = \"{base}\"\njwt_secret = \"s\"\n{hooks}"
        ))
        .unwrap();
        h.callback_base = base.into();
        h
    }

    #[test]
    fn config_is_checked() {
        let ok = host(
            "https://host.example/api",
            "[webhooks]\nurl = \"https://host.example/hooks?x=1\"\nevents = [\"saved\", \"commented\"]\nsecret = \"w\"",
        );
        let c = WebhookCfg::of(&ok).unwrap().unwrap();
        assert!(c.wants("saved") && !c.wants("edited"));
        assert_eq!(c.signing_secret(&ok), b"w");
        assert_eq!(c.max_attempts, MAX_ATTEMPTS);
        let all = host(
            "https://host.example/api",
            "[webhooks]\nurl = \"https://host.example/h\"\nevents = [\"*\"]",
        );
        let c = WebhookCfg::of(&all).unwrap().unwrap();
        assert!(c.wants("edited"));
        assert_eq!(c.signing_secret(&all), b"s", "the host secret by default");
        assert!(
            WebhookCfg::of(&host("https://host.example/api", ""))
                .unwrap()
                .is_none()
        );
        for bad in [
            "url = \"https://host.example/h\"",
            "url = \"https://host.example/h\"\nevents = []",
            "url = \"https://host.example/h\"\nevents = [\"nope\"]",
            "url = \"ftp://host.example/h\"\nevents = [\"*\"]",
            "url = \"https://u:p@host.example/h\"\nevents = [\"*\"]",
            "url = \"https://host.example/h\"\nevents = [\"*\"]\nmax_attempts = 0",
            "url = \"https://host.example/h\"\nevents = [\"*\"]\nretries = 3",
        ] {
            let h = host("https://host.example/api", &format!("[webhooks]\n{bad}"));
            assert!(WebhookCfg::of(&h).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_the_callback_origin_is_allowed() {
        let h = host("https://host.example:8443/api", "");
        let t = |u: &str| target(&h, &Url::parse(u).unwrap());
        assert!(t("https://host.example:8443/other/path?q=1").is_ok());
        for u in [
            "https://host.example/hooks",
            "http://host.example:8443/hooks",
            "https://evil.example:8443/hooks",
            "http://169.254.169.254/latest/meta-data",
            "http://127.0.0.1:8443/hooks",
        ] {
            assert!(t(u).is_err(), "{u}");
        }
        // With OC_CALLBACK_BASE_OVERRIDE, the configured origin goes through the override.
        let mut o = host("http://host-internal:4000/api", "");
        o.original_callback_base = Some("https://host.example/api".into());
        let u = target(&o, &Url::parse("https://host.example/hooks?a=b").unwrap()).unwrap();
        assert_eq!(u.as_str(), "http://host-internal:4000/hooks?a=b");
    }

    #[test]
    fn backoff_grows_and_honours_retry_after() {
        assert_eq!(next_try(0, 1, None), 10_000);
        assert_eq!(next_try(0, 2, None), 30_000);
        assert_eq!(next_try(0, 11, None), 43_200_000);
        assert_eq!(next_try(0, 50, None), 43_200_000);
        assert_eq!(next_try(0, 1, Some(120)), 120_000);
        assert_eq!(
            next_try(0, 2, Some(5)),
            30_000,
            "never sooner than the backoff"
        );
        assert_eq!(next_try(0, 1, Some(10_000_000)), 43_200_000, "capped");
    }
}
