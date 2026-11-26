// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

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
    if let Err(e) = purge() {
        tracing::warn!(error = %e, "jemalloc purge failed");
    }
}

/// Hands this thread's cached free blocks back to its arena, so a purge can return them.
/// Called by short-lived work on blocking threads (a save build, PERF-11): an idle blocking
/// thread otherwise keeps its cache until it exits.
pub fn flush_thread_cache() {
    #[cfg(feature = "jemalloc")]
    // SAFETY: "thread.tcache.flush" takes no input and returns nothing; all pointers are null.
    unsafe {
        tikv_jemalloc_sys::mallctl(
            c"thread.tcache.flush".as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        );
    }
}

/// Purges the dirty pages of every jemalloc arena (`MALLCTL_ARENAS_ALL` = 4096).
#[cfg(feature = "jemalloc")]
pub fn purge() -> Result<(), String> {
    // jemalloc refuses (EPERM) any input pointer, even a zero-sized one, for this command,
    // so `tikv_jemalloc_ctl::raw::write(name, ())` never purged anything.
    // SAFETY: "arena.<i>.purge" takes no input and returns nothing; all pointers are null.
    let rc = unsafe {
        tikv_jemalloc_sys::mallctl(
            c"arena.4096.purge".as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(format!("mallctl arena.4096.purge: errno {rc}"))
    }
}

#[cfg(all(test, feature = "jemalloc"))]
mod tests {
    #[test]
    fn jemalloc_purge_is_accepted() {
        // A purge jemalloc refuses frees nothing: evicted rooms stayed resident as dirty
        // pages (docs/22 §9.7).
        assert_eq!(super::purge(), Ok(()));
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

/// jemalloc options for Linux: dirty pages go back to the OS after about a second, and a
/// background thread purges them even when no thread allocates. Defined on every platform so a
/// length mistake fails the build everywhere, not only on Linux (it once reached CI that way).
#[cfg_attr(not(all(feature = "jemalloc", target_os = "linux")), allow(dead_code))]
const LINUX_CONF: &[u8; 60] = b"background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:0\0";
/// The same without the background thread, which macOS jemalloc does not support.
#[cfg_attr(
    not(all(feature = "jemalloc", not(target_os = "linux"))),
    allow(dead_code)
)]
const OTHER_CONF: &[u8; 37] = b"dirty_decay_ms:1000,muzzy_decay_ms:0\0";

/// jemalloc options baked into the binary (`_RJEM_MALLOC_CONF` still overrides them).
#[cfg(all(feature = "jemalloc", target_os = "linux"))]
#[unsafe(export_name = "_rjem_malloc_conf")]
pub static MALLOC_CONF: &[u8; 60] = LINUX_CONF;
#[cfg(all(feature = "jemalloc", not(target_os = "linux")))]
#[unsafe(export_name = "_rjem_malloc_conf")]
pub static MALLOC_CONF: &[u8; 37] = OTHER_CONF;
