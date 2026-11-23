// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! One rate limiter for the headless API and MCP (docs/27 §4.2, HAPI-04): token buckets per
//! subject (host key or token `sub`) and per file for writes. Time comes from the server
//! [`Clock`], so tests advance it instead of sleeping. With Redis (cluster, hot WAL or
//! Redis-only storage) the buckets live there and every node shares them; a Redis error falls
//! back to this node's buckets rather than refusing traffic.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use redis::aio::ConnectionManager;

use crate::clock::Clock;
use crate::hosts::HostConfig;

/// A bucket: `rate` tokens per second, at most `burst`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Policy {
    pub name: &'static str,
    pub rate: f64,
    pub burst: f64,
}

impl Policy {
    /// `RateLimit-Policy` item: quota and the window it refills in.
    pub fn header_item(&self) -> String {
        format!(
            "\"{}\";q={};w={}",
            self.name,
            self.burst as u64,
            (self.burst / self.rate).ceil().max(1.0) as u64
        )
    }
}

/// The answer for one request.
#[derive(Debug, Clone, Copy)]
pub struct Decision {
    pub ok: bool,
    pub policy: Policy,
    /// Whole tokens left.
    pub remaining: u64,
    /// Seconds until the bucket is full again.
    pub reset: u64,
    /// Seconds until one token is back (for `Retry-After`).
    pub retry_after: u64,
}

impl Decision {
    fn of(policy: Policy, ok: bool, tokens: f64) -> Self {
        Self {
            ok,
            policy,
            remaining: tokens.max(0.0).floor() as u64,
            reset: ((policy.burst - tokens).max(0.0) / policy.rate).ceil() as u64,
            retry_after: if ok {
                0
            } else {
                ((1.0 - tokens) / policy.rate).ceil().max(1.0) as u64
            },
        }
    }

    /// `RateLimit` item.
    pub fn header_item(&self) -> String {
        format!(
            "\"{}\";r={};t={}",
            self.policy.name, self.remaining, self.reset
        )
    }
}

fn num(t: &toml::Table, k: &str) -> Option<f64> {
    t.get(k)
        .and_then(|v| v.as_float().or_else(|| v.as_integer().map(|i| i as f64)))
        .filter(|v| *v > 0.0)
}

/// Requests per subject: `[host.api] rate_per_sec` (default 10; else `[host.ai]
/// mcp_rate_per_min` / 60 when only that is set) and `burst` (default 3 × rate, at least 30).
pub fn subject_policy(host: &HostConfig) -> Policy {
    let rate = num(&host.api, "rate_per_sec")
        .or_else(|| num(&host.ai, "mcp_rate_per_min").map(|m| m / 60.0))
        .unwrap_or(10.0)
        .clamp(0.01, 100_000.0);
    let burst = num(&host.api, "burst")
        .unwrap_or((rate * 3.0).max(30.0))
        .max(1.0);
    Policy {
        name: "subject",
        rate,
        burst,
    }
}

/// Writes per file: `[host.api] file_writes_per_sec` (default 5) and `file_burst` (default 10).
pub fn file_policy(host: &HostConfig) -> Policy {
    let rate = num(&host.api, "file_writes_per_sec")
        .unwrap_or(5.0)
        .clamp(0.01, 100_000.0);
    Policy {
        name: "file-writes",
        rate,
        burst: num(&host.api, "file_burst").unwrap_or(rate * 2.0).max(1.0),
    }
}

/// Token bucket in Redis: refill by elapsed time (the caller's clock), take one if there is
/// one; answers `{ok, tokens}`.
const BUCKET: &str = r"
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local v = redis.call('HMGET', KEYS[1], 't', 'at')
local t = tonumber(v[1]) or burst
local at = tonumber(v[2]) or now
if now > at then
  t = math.min(burst, t + (now - at) * rate / 1000)
  at = now
end
local ok = 0
if t >= 1 then
  t = t - 1
  ok = 1
end
redis.call('HSET', KEYS[1], 't', tostring(t), 'at', tostring(at))
redis.call('PEXPIRE', KEYS[1], math.ceil(burst / rate * 1000) + 1000)
return {ok, tostring(t)}
";

pub struct Limiter {
    local: Mutex<HashMap<String, (f64, i64)>>,
    redis: Option<ConnectionManager>,
    clock: Arc<Clock>,
}

impl Limiter {
    pub fn new(clock: Arc<Clock>, redis: Option<ConnectionManager>) -> Self {
        Self {
            local: Mutex::default(),
            redis,
            clock,
        }
    }

    /// Takes one token from bucket `key` under `policy`.
    pub async fn check(&self, key: &str, policy: Policy) -> Decision {
        let now = self.clock.now_ms();
        if let Some(conn) = &self.redis {
            let res: redis::RedisResult<(i64, String)> = redis::Script::new(BUCKET)
                .key(format!("oc:rl:{key}"))
                .arg(policy.rate)
                .arg(policy.burst)
                .arg(now)
                .invoke_async(&mut conn.clone())
                .await;
            match res {
                Ok((ok, t)) => return Decision::of(policy, ok == 1, t.parse().unwrap_or(0.0)),
                Err(e) => {
                    tracing::warn!(error = %e, "rate limiter: Redis failed, using local buckets")
                }
            }
        }
        let mut b = self.local.lock().expect("rate buckets");
        if b.len() > 100_000 {
            b.retain(|_, (_, at)| now - *at < 600_000);
        }
        let (tokens, at) = b.entry(key.to_string()).or_insert((policy.burst, now));
        if now > *at {
            *tokens = (*tokens + (now - *at) as f64 * policy.rate / 1000.0).min(policy.burst);
            *at = now;
        }
        let ok = *tokens >= 1.0;
        if ok {
            *tokens -= 1.0;
        }
        Decision::of(policy, ok, *tokens)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn buckets_refill_by_the_clock() {
        let clock = Arc::new(Clock::default());
        clock.set_ms(1_000_000);
        let l = Limiter::new(clock.clone(), None);
        let p = Policy {
            name: "subject",
            rate: 2.0,
            burst: 3.0,
        };
        for left in [2, 1, 0] {
            let d = l.check("k", p).await;
            assert!(d.ok);
            assert_eq!(d.remaining, left);
        }
        let d = l.check("k", p).await;
        assert!(!d.ok);
        assert_eq!(d.retry_after, 1);
        assert_eq!(d.header_item(), "\"subject\";r=0;t=2");
        assert!(l.check("other", p).await.ok, "buckets are per key");
        clock.advance_ms(500);
        assert!(l.check("k", p).await.ok, "one token back after 1/rate s");
        assert!(!l.check("k", p).await.ok);
        assert_eq!(p.header_item(), "\"subject\";q=3;w=2");
    }
}
