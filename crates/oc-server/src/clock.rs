// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The server's wall clock for API bookkeeping (idempotency expiry, rate-limit buckets,
//! cursor expiry). Real time by default; tests pin or advance it instead of sleeping, so
//! nothing that depends on it is timing-sensitive.

use std::sync::atomic::{AtomicI64, Ordering};

#[derive(Debug, Default)]
pub struct Clock {
    /// Non-zero: the clock is pinned to this many milliseconds since the epoch.
    fixed_ms: AtomicI64,
    /// Added to real time when not pinned.
    offset_ms: AtomicI64,
}

impl Clock {
    pub fn now_ms(&self) -> i64 {
        match self.fixed_ms.load(Ordering::Relaxed) {
            0 => crate::util::now_ms() + self.offset_ms.load(Ordering::Relaxed),
            f => f,
        }
    }

    pub fn now_secs(&self) -> i64 {
        self.now_ms().div_euclid(1000)
    }

    /// Pins the clock (tests).
    pub fn set_ms(&self, ms: i64) {
        self.fixed_ms.store(ms.max(1), Ordering::Relaxed);
    }

    /// Moves the clock forward (tests): the pinned time, or the offset from real time.
    pub fn advance_ms(&self, ms: i64) {
        if self.fixed_ms.load(Ordering::Relaxed) != 0 {
            self.fixed_ms.fetch_add(ms, Ordering::Relaxed);
        } else {
            self.offset_ms.fetch_add(ms, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_and_advanced() {
        let c = Clock::default();
        assert!(c.now_ms() > 1_700_000_000_000);
        c.set_ms(5_000);
        assert_eq!(c.now_ms(), 5_000);
        c.advance_ms(1_500);
        assert_eq!((c.now_ms(), c.now_secs()), (6_500, 6));
    }
}
