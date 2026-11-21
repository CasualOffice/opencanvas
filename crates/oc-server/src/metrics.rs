//! A handful of Prometheus counters, gauges and histograms, rendered as text.

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
    /// Time of one WAL append (including retries after a deadlock), success or not.
    pub wal_append_seconds: Histogram,
    /// Awareness frames encoded and fanned out (one per batch, shared by every peer).
    pub awareness_broadcasts_total: AtomicI64,
    /// Awareness frames parked because a room's inbox was full (latest per connection kept).
    pub awareness_coalesced_total: AtomicI64,
}

impl Metrics {
    pub fn inc(c: &AtomicI64) {
        c.fetch_add(1, Ordering::Relaxed);
    }

    pub fn dec(c: &AtomicI64) {
        c.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn render(&self) -> String {
        let rows: [(&str, &str, &AtomicI64); 11] = [
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
        out.push_str(&self.wal_append_seconds.render(
            "oc_wal_append_seconds",
            "Time to append one update to the room WAL.",
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
