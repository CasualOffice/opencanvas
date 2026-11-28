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
        self.render_series(name, "", &mut out);
        out
    }

    /// One series (`labels` is `k="v",…` or empty) without the HELP/TYPE header.
    fn render_series(&self, name: &str, labels: &str, out: &mut String) {
        let sep = if labels.is_empty() { "" } else { "," };
        let set = if labels.is_empty() {
            String::new()
        } else {
            format!("{{{labels}}}")
        };
        let mut total = 0;
        for (i, c) in self.counts.iter().enumerate() {
            total += c.load(Ordering::Relaxed);
            let le = BUCKETS.get(i).map_or("+Inf".to_string(), |b| b.to_string());
            out.push_str(&format!(
                "{name}_bucket{{{labels}{sep}le=\"{le}\"}} {total}\n"
            ));
        }
        let sum = self.sum_micros.load(Ordering::Relaxed) as f64 / 1e6;
        out.push_str(&format!(
            "{name}_sum{set} {sum}\n{name}_count{set} {total}\n"
        ));
    }
}

/// Escapes a Prometheus label value.
fn esc(v: &str) -> String {
    v.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

/// `k="v",…` from label pairs (values escaped).
pub fn labels(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{k}=\"{}\"", esc(v)))
        .collect::<Vec<_>>()
        .join(",")
}

/// Histograms keyed by their rendered label set.
#[derive(Default)]
pub struct HistogramVec(Mutex<BTreeMap<String, Histogram>>);

impl HistogramVec {
    pub fn observe(&self, labels: String, d: Duration) {
        if let Ok(mut m) = self.0.lock() {
            m.entry(labels).or_default().observe(d);
        }
    }

    fn render(&self, name: &str, help: &str, out: &mut String) {
        out.push_str(&format!("# HELP {name} {help}\n# TYPE {name} histogram\n"));
        if let Ok(m) = self.0.lock() {
            for (labels, h) in m.iter() {
                h.render_series(name, labels, out);
            }
        }
    }
}

/// Counters keyed by their rendered label set.
#[derive(Default)]
pub struct CounterVec(Mutex<BTreeMap<String, i64>>);

impl CounterVec {
    pub fn inc(&self, labels: String) {
        if let Ok(mut m) = self.0.lock() {
            *m.entry(labels).or_default() += 1;
        }
    }

    fn render(&self, name: &str, help: &str, out: &mut String) {
        out.push_str(&format!("# HELP {name} {help}\n# TYPE {name} counter\n"));
        if let Ok(m) = self.0.lock() {
            for (labels, n) in m.iter() {
                out.push_str(&format!("{name}{{{labels}}} {n}\n"));
            }
        }
    }
}

/// Values read when `/metrics` is scraped (not kept in [`Metrics`]).
#[derive(Default)]
pub struct Scrape {
    /// `/readyz` would answer 200.
    pub ready: bool,
    pub draining: bool,
    /// Commit outbox rows still waiting for the host; `None` when the store could not say.
    pub outbox_pending: Option<usize>,
}

/// Status class of an HTTP status code: `1xx` … `5xx`.
pub fn status_class(code: u16) -> &'static str {
    match code {
        100..=199 => "1xx",
        200..=299 => "2xx",
        300..=399 => "3xx",
        400..=499 => "4xx",
        _ => "5xx",
    }
}

/// Process metrics under the standard Prometheus client names. Start time everywhere; CPU,
/// memory, threads and file descriptors from `/proc` on Linux (the container image).
pub fn process_metrics() -> String {
    #[allow(unused_mut)]
    let mut out = format!(
        "# HELP process_start_time_seconds Start time of the process since the Unix epoch.\n# TYPE process_start_time_seconds gauge\nprocess_start_time_seconds {}\n",
        *START_TIME
    );
    #[cfg(target_os = "linux")]
    {
        // USER_HZ is 100 and pages are 4 KiB on every Linux the image targets.
        if let Ok(stat) = std::fs::read_to_string("/proc/self/stat")
            && let Some(p) = parse_proc_stat(&stat, 100.0, 4096)
        {
            out.push_str(&format!(
                "# TYPE process_cpu_seconds_total counter\nprocess_cpu_seconds_total {}\n# TYPE process_resident_memory_bytes gauge\nprocess_resident_memory_bytes {}\n# TYPE process_virtual_memory_bytes gauge\nprocess_virtual_memory_bytes {}\n# TYPE process_threads gauge\nprocess_threads {}\n",
                p.cpu_seconds, p.rss_bytes, p.vsize_bytes, p.threads
            ));
        }
        if let Ok(dir) = std::fs::read_dir("/proc/self/fd") {
            out.push_str(&format!(
                "# TYPE process_open_fds gauge\nprocess_open_fds {}\n",
                dir.count()
            ));
        }
        if let Ok(limits) = std::fs::read_to_string("/proc/self/limits")
            && let Some(max) = parse_max_fds(&limits)
        {
            out.push_str(&format!(
                "# TYPE process_max_fds gauge\nprocess_max_fds {max}\n"
            ));
        }
    }
    // Live heap vs pages the allocator holds (docs/22 §9.6): tells a leak from retained pages.
    #[cfg(feature = "jemalloc")]
    {
        use tikv_jemalloc_ctl::{epoch, stats};
        if epoch::advance().is_ok()
            && let (Ok(a), Ok(r)) = (stats::allocated::read(), stats::resident::read())
        {
            out.push_str(&format!(
                "# TYPE oc_alloc_allocated_bytes gauge\noc_alloc_allocated_bytes {a}\n# TYPE oc_alloc_resident_bytes gauge\noc_alloc_resident_bytes {r}\n"
            ));
        }
    }
    out
}

static START_TIME: std::sync::LazyLock<u64> = std::sync::LazyLock::new(|| {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
});

/// Fixes the start time at process start, not at the first scrape.
pub fn mark_start() {
    let _ = *START_TIME;
}

#[derive(Debug, PartialEq)]
pub struct ProcStat {
    pub cpu_seconds: f64,
    pub vsize_bytes: u64,
    pub rss_bytes: u64,
    pub threads: u64,
}

/// Parses `/proc/<pid>/stat` (`man 5 proc`): utime 14, stime 15, num_threads 20, vsize 23,
/// rss 24 (pages). The command name (field 2) may hold spaces, so split after its `)`.
pub fn parse_proc_stat(stat: &str, ticks_per_sec: f64, page_size: u64) -> Option<ProcStat> {
    let rest = &stat[stat.rfind(')')? + 1..];
    let f: Vec<&str> = rest.split_whitespace().collect();
    // `f[0]` is field 3 (state), so field n is `f[n - 3]`.
    let num = |n: usize| f.get(n - 3)?.parse::<u64>().ok();
    Some(ProcStat {
        cpu_seconds: (num(14)? + num(15)?) as f64 / ticks_per_sec,
        threads: num(20)?,
        vsize_bytes: num(23)?,
        rss_bytes: num(24)? * page_size,
    })
}

/// The soft `Max open files` limit from `/proc/<pid>/limits`.
pub fn parse_max_fds(limits: &str) -> Option<u64> {
    limits
        .lines()
        .find(|l| l.starts_with("Max open files"))?
        .split_whitespace()
        .nth(3)?
        .parse()
        .ok()
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
    /// WebSocket upgrades refused by reconnect storm control (PERF-11, `OC_UPGRADE_RATE`).
    pub upgrades_refused_total: AtomicI64,
    /// AI (docs/24 §8.2): model calls by `(host, provider, model, outcome)`; no content.
    pub ai_requests: Mutex<BTreeMap<(String, String, String, String), i64>>,
    pub ai_tokens_input_total: AtomicI64,
    pub ai_tokens_output_total: AtomicI64,
    /// Agent runs by outcome (`done`, `cancelled`, `limit`, `error`, `refused`).
    pub ai_runs: Mutex<BTreeMap<String, i64>>,
    pub ai_run_seconds: Histogram,
    /// Launches refused, by error code (`oc_launches_rejected_total{code}`).
    pub launches_rejected: CounterVec,
    /// Calls to the host (callbacks or WOPI) by `(host, op)`, and by `(host, op, result)`.
    pub host_callback_seconds: HistogramVec,
    pub host_callbacks: CounterVec,
    /// Exports by `format`, and by `(format, result)`.
    pub export_seconds: HistogramVec,
    pub exports: CounterVec,
    /// HTTP responses by status class.
    pub http_responses: CounterVec,
    /// Webhook attempts by `(host, result)` and their time by `host` (WH-01).
    pub webhook_deliveries: CounterVec,
    pub webhook_seconds: HistogramVec,
    /// LINK-02: link index writes by result, their time, and edges dropped past the cap.
    pub link_index_writes: CounterVec,
    pub link_index_seconds: Histogram,
    pub link_edges_dropped_total: AtomicI64,
}

impl Metrics {
    pub fn inc(c: &AtomicI64) {
        c.fetch_add(1, Ordering::Relaxed);
    }

    pub fn dec(c: &AtomicI64) {
        c.fetch_sub(1, Ordering::Relaxed);
    }

    /// Records one host call: `op` is `load`, `save`, `copy`, `access`, `members` or `notify`;
    /// `result` is `ok`, `conflict`, `4xx`, `5xx`, `unreachable` or `error`.
    pub fn host_call(&self, host: &str, op: &str, result: &str, took: Duration) {
        self.host_callback_seconds
            .observe(labels(&[("host", host), ("op", op)]), took);
        self.host_callbacks
            .inc(labels(&[("host", host), ("op", op), ("result", result)]));
    }

    pub fn export(&self, format: &str, ok: bool, took: Duration) {
        self.export_seconds
            .observe(labels(&[("format", format)]), took);
        let result = if ok { "ok" } else { "error" };
        self.exports
            .inc(labels(&[("format", format), ("result", result)]));
    }

    /// One link index write after an acknowledged save (LINK-02).
    pub fn link_index(&self, ok: bool, dropped: usize, took: Duration) {
        self.link_index_seconds.observe(took);
        let result = if ok { "ok" } else { "error" };
        self.link_index_writes.inc(labels(&[("result", result)]));
        self.link_edges_dropped_total
            .fetch_add(dropped as i64, Ordering::Relaxed);
    }

    pub fn launch_rejected(&self, code: &str) {
        Self::inc(&self.launches_rejected_total);
        self.launches_rejected.inc(labels(&[("code", code)]));
    }

    /// The `/metrics` text, with the values read at scrape time.
    pub fn render_with(&self, scrape: &Scrape) -> String {
        let mut out = self.render();
        out.push_str(&format!(
            "# HELP oc_ready 1 when /readyz answers 200 (database reachable, not draining).\n# TYPE oc_ready gauge\noc_ready {}\n# HELP oc_draining 1 while the node drains after SIGTERM.\n# TYPE oc_draining gauge\noc_draining {}\n",
            u8::from(scrape.ready),
            u8::from(scrape.draining)
        ));
        if let Some(n) = scrape.outbox_pending {
            out.push_str(&format!(
                "# HELP oc_commit_outbox_pending Commits waiting for the host (whole store: every node of a cluster reports the same value).\n# TYPE oc_commit_outbox_pending gauge\noc_commit_outbox_pending {n}\n"
            ));
        }
        out.push_str(&process_metrics());
        out
    }

    pub fn render(&self) -> String {
        let rows: [(&str, &str, &AtomicI64); 14] = [
            ("oc_wal_batches_total", "counter", &self.wal_batches_total),
            ("oc_wal_rows_total", "counter", &self.wal_rows_total),
            ("oc_rooms_active", "gauge", &self.rooms_active),
            ("oc_connections_active", "gauge", &self.connections_active),
            ("oc_launches_total", "counter", &self.launches_total),
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
            (
                "oc_upgrades_refused_total",
                "counter",
                &self.upgrades_refused_total,
            ),
            (
                "oc_link_edges_dropped_total",
                "counter",
                &self.link_edges_dropped_total,
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
        out.push_str(&self.link_index_seconds.render(
            "oc_link_index_seconds",
            "Time to replace one file's rows in the link index.",
        ));
        out.push_str(&self.wal_append_seconds.render(
            "oc_wal_append_seconds",
            "Time to append one batch of updates to the room WAL.",
        ));
        self.launches_rejected.render(
            "oc_launches_rejected_total",
            "Launches refused, by error code.",
            &mut out,
        );
        self.host_callback_seconds.render(
            "oc_host_callback_seconds",
            "Time of one call to the host (callbacks or WOPI), by host and operation.",
            &mut out,
        );
        self.host_callbacks.render(
            "oc_host_callbacks_total",
            "Calls to the host by host, operation and result.",
            &mut out,
        );
        self.export_seconds.render(
            "oc_export_seconds",
            "Time to render one export, by format.",
            &mut out,
        );
        self.exports.render(
            "oc_exports_total",
            "Exports by format and result (ok, error).",
            &mut out,
        );
        self.link_index_writes.render(
            "oc_link_index_writes_total",
            "Link index writes after acknowledged saves, by result (ok, error).",
            &mut out,
        );
        self.http_responses.render(
            "oc_http_responses_total",
            "HTTP responses by status class (WebSocket upgrades count as 1xx).",
            &mut out,
        );
        self.webhook_deliveries.render(
            "oc_webhook_deliveries_total",
            "Webhook attempts by host and result (ok, retry, rejected, gave_up, refused).",
            &mut out,
        );
        self.webhook_seconds.render(
            "oc_webhook_delivery_seconds",
            "Time of one webhook attempt, by host.",
            &mut out,
        );
        // MOD-01: unknown nodes, marks, attributes, field or shape types seen when reading a
        // .ocanvas or taking a patch/import/MCP write (kept, not refused).
        out.push_str(&format!(
            "# HELP oc_schema_warnings_total Block-schema warnings (unknown content kept) on file reads and writes.\n# TYPE oc_schema_warnings_total counter\noc_schema_warnings_total {}\n",
            oc_model::validate::warnings_total()
        ));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_warnings_are_exported() {
        let before = oc_model::validate::warnings_total();
        oc_model::validate::record(oc_model::validate_blocks(
            "blocks",
            &[serde_json::json!({"type": "futureBlock"})],
        ));
        assert!(oc_model::validate::warnings_total() > before);
        let text = Metrics::default().render();
        assert!(
            text.contains("# TYPE oc_schema_warnings_total counter"),
            "{text}"
        );
        assert!(text.contains("\noc_schema_warnings_total "), "{text}");
    }

    #[test]
    fn proc_stat_is_parsed_past_a_command_with_spaces() {
        let stat = "42 (oc server) S 1 42 42 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 7 0 1234 104857600 2560 18446744073709551615";
        let p = parse_proc_stat(stat, 100.0, 4096).unwrap();
        assert_eq!(
            p,
            ProcStat {
                cpu_seconds: 3.0,
                vsize_bytes: 104_857_600,
                rss_bytes: 2560 * 4096,
                threads: 7
            }
        );
        assert_eq!(parse_proc_stat("garbage", 100.0, 4096), None);
        let limits = "Limit                     Soft Limit           Hard Limit           Units\nMax open files            1048576              1048576              files\n";
        assert_eq!(parse_max_fds(limits), Some(1_048_576));
    }

    #[test]
    fn labelled_series_render_and_escape() {
        let m = Metrics::default();
        m.host_call("a\"b", "save", "ok", Duration::from_millis(3));
        let mut out = String::new();
        m.host_callback_seconds.render("h", "help", &mut out);
        assert!(
            out.contains("h_bucket{host=\"a\\\"b\",op=\"save\",le=\"0.005\"} 1\n"),
            "{out}"
        );
        assert!(
            out.contains("h_count{host=\"a\\\"b\",op=\"save\"} 1\n"),
            "{out}"
        );
    }

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
