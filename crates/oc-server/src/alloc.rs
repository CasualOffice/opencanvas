//! The process allocator (docs/22 §9.6, PERF-07).
//!
//! The `opencanvas` binary uses jemalloc by default (feature `jemalloc`, dirty pages decay in
//! 1 s, a background purge thread on Linux): with the system allocator the Y.Docs of rooms
//! evicted after an S2 run stayed resident (≈ 1 GB with no room open, macOS), and mimalloc
//! (feature `mimalloc`) did not return them either. `--no-default-features` keeps the system
//! allocator.
//!
//! [`release`] hands freed memory back to the OS. It runs when a room closes (on the thread
//! that dropped the doc, at most every 500 ms per thread) and from a sweeper while rooms close.
use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Rooms closed since start; the sweeper releases memory while this moves.
pub static ROOMS_CLOSED: AtomicU64 = AtomicU64::new(0);

const MIN_GAP: Duration = Duration::from_millis(500);

thread_local! { static LAST: Cell<Option<Instant>> = const { Cell::new(None) }; }

/// Notes that a room's doc was dropped and releases freed memory (rate-limited per thread).
pub fn room_closed() {
    ROOMS_CLOSED.fetch_add(1, Ordering::Relaxed);
    let due = LAST.with(|l| {
        let now = Instant::now();
        let due = l.get().is_none_or(|t| now - t >= MIN_GAP);
        if due {
            l.set(Some(now));
        }
        due
    });
    if due {
        release();
    }
}

/// Returns freed memory to the OS where the allocator supports it (a no-op on the system
/// allocator: `malloc_zone_pressure_relief` was measured not to help on macOS, §9.5).
pub fn release() {
    #[cfg(all(feature = "mimalloc", not(feature = "jemalloc")))]
    // SAFETY: mi_collect only walks and purges the allocator's own free memory.
    unsafe {
        libmimalloc_sys::mi_collect(true);
    }
    #[cfg(feature = "jemalloc")]
    {
        // MALLCTL_ARENAS_ALL = 4096: purge the dirty pages of every arena.
        // SAFETY: "arena.<i>.purge" takes no input and returns nothing.
        let _ = unsafe { tikv_jemalloc_ctl::raw::write(b"arena.4096.purge\0", ()) };
    }
}

/// Runs [`release`] every 2 s while rooms keep closing, so memory freed on worker threads
/// that did not close a room is purged too.
pub fn spawn_sweeper() {
    tokio::spawn(async {
        let mut seen = ROOMS_CLOSED.load(Ordering::Relaxed);
        let mut every = tokio::time::interval(Duration::from_secs(2));
        loop {
            every.tick().await;
            let now = ROOMS_CLOSED.load(Ordering::Relaxed);
            if now != seen {
                seen = now;
                release();
            }
        }
    });
}

/// jemalloc options baked into the binary (`_RJEM_MALLOC_CONF` still overrides them): dirty
/// pages go back to the OS after about a second, and on Linux a background thread purges them
/// even when no thread allocates (not supported on macOS).
#[cfg(all(feature = "jemalloc", target_os = "linux"))]
#[unsafe(export_name = "_rjem_malloc_conf")]
pub static MALLOC_CONF: &[u8; 61] =
    b"background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:0\0";
#[cfg(all(feature = "jemalloc", not(target_os = "linux")))]
#[unsafe(export_name = "_rjem_malloc_conf")]
pub static MALLOC_CONF: &[u8; 37] = b"dirty_decay_ms:1000,muzzy_decay_ms:0\0";
