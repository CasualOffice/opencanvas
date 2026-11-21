//! A handful of Prometheus counters and gauges, rendered as text.

use std::sync::atomic::{AtomicI64, Ordering};

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
        rows.iter()
            .map(|(name, kind, v)| {
                format!(
                    "# TYPE {name} {kind}\n{name} {}\n",
                    v.load(Ordering::Relaxed)
                )
            })
            .collect()
    }
}
