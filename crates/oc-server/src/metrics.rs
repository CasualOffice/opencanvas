// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! A handful of Prometheus counters, gauges and histograms, rendered as text.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::Duration;

/// Upper bounds (seconds) of the latency histogram buckets.
const BUCKETS: [f64; 12] = [
    0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0,
];

/// A fixed-bucket Prometheus histogram of durations.
#[derive(Default)]
pub struct Histogram {
    /// Observations per bucket (not cumulative); the last slot is `+Inf`.
    counts: [AtomicU64; BUCKETS.len() + 1],
    sum_micros: AtomicU64,
}

impl Histogram {
    pub fn observe(&self, d: Duration) {
        let secs = d.as_secs_f64();
        let slot = BUCKETS
            .iter()
            .position(|b| secs <= *b)
            .unwrap_or(BUCKETS.len());
        self.counts[slot].fetch_add(1, Ordering::Relaxed);
        self.sum_micros
            .fetch_add(d.as_micros() as u64, Ordering::Relaxed);
    }

    fn render(&self, name: &str, help: &str) -> String {
        let mut out = format!("# HELP {name} {help}\n# TYPE {name} histogram\n");
        let mut total = 0;
        for (i, c) in self.counts.iter().enumerate() {
            total += c.load(Ordering::Relaxed);
            let le = BUCKETS.get(i).map_or("+Inf".to_string(), |b| b.to_string());
            out.push_str(&format!("{name}_bucket{{le=\"{le}\"}} {total}\n"));
        }
        let sum = self.sum_micros.load(Ordering::Relaxed) as f64 / 1e6;
        out.push_str(&format!("{name}_sum {sum}\n{name}_count {total}\n"));
        out
    }
}

#[derive(Default)]
pub struct Metrics {
    pub rooms_active: AtomicI64,
    pub connections_active: AtomicI64,
    pub launches_total: AtomicI64,
    pub launches_rejected_total: AtomicI64,
    pub updates_total: AtomicI64,
    pub updates_rejected_total: AtomicI64,
    pub saves_total: AtomicI64,
    pub save_errors_total: AtomicI64,
    pub save_conflicts_total: AtomicI64,
    /// Time of one WAL append of a room's batch (including retries after a deadlock), success
    /// or not.
    pub wal_append_seconds: Histogram,
    /// WAL batches written (one transaction per room batch; rooms may share it on SQLite).
    pub wal_batches_total: AtomicI64,
    /// Updates written in those batches (`/ wal_batches_total` = mean batch size).
    pub wal_rows_total: AtomicI64,
    /// Awareness frames encoded and fanned out (one per batch, shared by every peer).
    pub awareness_broadcasts_total: AtomicI64,
    /// Awareness frames parked because a room's inbox was full (latest per connection kept).
    pub awareness_coalesced_total: AtomicI64,
    /// AI (docs/24 §8.2): model calls by `(host, provider, model, outcome)`; no content.
    pub ai_requests: Mutex<BTreeMap<(String, String, String, String), i64>>,
    pub ai_tokens_input_total: AtomicI64,
    pub ai_tokens_output_total: AtomicI64,
    /// Agent runs by outcome (`done`, `cancelled`, `limit`, `error`, `refused`).
    pub ai_runs: Mutex<BTreeMap<String, i64>>,
    pub ai_run_seconds: Histogram,
}

impl Metrics {
    pub fn inc(c: &AtomicI64) {
        c.fetch_add(1, Ordering::Relaxed);
    }

    pub fn dec(c: &AtomicI64) {
        c.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn render(&self) -> String {
        let rows: [(&str, &str, &AtomicI64); 13] = [
            ("oc_wal_batches_total", "counter", &self.wal_batches_total),
            ("oc_wal_rows_total", "counter", &self.wal_rows_total),
            ("oc_rooms_active", "gauge", &self.rooms_active),
            ("oc_connections_active", "gauge", &self.connections_active),
            ("oc_launches_total", "counter", &self.launches_total),
            (
                "oc_launches_rejected_total",
                "counter",
                &self.launches_rejected_total,
            ),
            ("oc_updates_total", "counter", &self.updates_total),
            (
                "oc_updates_rejected_total",
                "counter",
                &self.updates_rejected_total,
            ),
            ("oc_saves_total", "counter", &self.saves_total),
            ("oc_save_errors_total", "counter", &self.save_errors_total),
            (
                "oc_save_conflicts_total",
                "counter",
                &self.save_conflicts_total,
            ),
            (
                "oc_awareness_broadcasts_total",
                "counter",
                &self.awareness_broadcasts_total,
            ),
            (
                "oc_awareness_coalesced_total",
                "counter",
                &self.awareness_coalesced_total,
            ),
        ];
        let mut out: String = rows
            .iter()
            .map(|(name, kind, v)| {
                format!(
                    "# TYPE {name} {kind}\n{name} {}\n",
                    v.load(Ordering::Relaxed)
                )
            })
            .collect();
        out.push_str("# TYPE oc_ai_requests_total counter\n");
        if let Ok(m) = self.ai_requests.lock() {
            for ((host, provider, model, outcome), n) in m.iter() {
                out.push_str(&format!(
                    "oc_ai_requests_total{{host=\"{host}\",provider=\"{provider}\",model=\"{model}\",outcome=\"{outcome}\"}} {n}\n"
                ));
            }
        }
        out.push_str(&format!(
            "# TYPE oc_ai_tokens_total counter\noc_ai_tokens_total{{direction=\"input\"}} {}\noc_ai_tokens_total{{direction=\"output\"}} {}\n",
            self.ai_tokens_input_total.load(Ordering::Relaxed),
            self.ai_tokens_output_total.load(Ordering::Relaxed)
        ));
        out.push_str("# TYPE oc_ai_runs_total counter\n");
        if let Ok(m) = self.ai_runs.lock() {
            for (outcome, n) in m.iter() {
                out.push_str(&format!("oc_ai_runs_total{{outcome=\"{outcome}\"}} {n}\n"));
            }
        }
        out.push_str(
            &self
                .ai_run_seconds
                .render("oc_ai_run_seconds", "Wall-clock time of one agent run."),
        );
        out.push_str(&self.wal_append_seconds.render(
            "oc_wal_append_seconds",
            "Time to append one batch of updates to the room WAL.",
        ));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn histogram_buckets_are_cumulative() {
        let h = Histogram::default();
        h.observe(Duration::from_micros(500));
        h.observe(Duration::from_millis(20));
        h.observe(Duration::from_secs(9));
        let t = h.render("x", "help");
        assert!(t.contains("x_bucket{le=\"0.001\"} 1\n"), "{t}");
        assert!(t.contains("x_bucket{le=\"0.025\"} 2\n"), "{t}");
        assert!(t.contains("x_bucket{le=\"5\"} 2\n"), "{t}");
        assert!(t.contains("x_bucket{le=\"+Inf\"} 3\n"), "{t}");
        assert!(t.contains("x_count 3\n"), "{t}");
    }
}
