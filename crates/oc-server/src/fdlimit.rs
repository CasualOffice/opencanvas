// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! File descriptor limit (PERF-11, docs/36 §4.1 item 5). Every WebSocket holds one fd, and
//! common defaults (a 1,024 or 256 soft limit) refuse connections long before 10,000. At start
//! the server raises its soft `RLIMIT_NOFILE` to the hard limit (as Go and nginx do), so no
//! systemd unit, container runtime or shell `ulimit` has to remember it.

/// Raises the soft fd limit as far as the system allows. Returns `(before, after)`.
#[cfg(unix)]
#[allow(clippy::unnecessary_cast)] // `rlim_t` is not u64 on every Unix.
pub fn raise_nofile() -> Option<(u64, u64)> {
    // SAFETY: getrlimit/setrlimit only read and write the struct passed by pointer.
    unsafe {
        let mut lim = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) != 0 {
            return None;
        }
        let before = lim.rlim_cur as u64;
        // macOS reports an unlimited hard limit but refuses a soft one above
        // `kern.maxfilesperproc` (EINVAL): step down until one is accepted.
        for want in [
            lim.rlim_max as u64,
            1_048_576,
            65_536,
            61_440,
            24_576,
            10_240,
        ] {
            if want <= before || want > lim.rlim_max as u64 {
                continue;
            }
            let next = libc::rlimit {
                rlim_cur: want as libc::rlim_t,
                rlim_max: lim.rlim_max,
            };
            if libc::setrlimit(libc::RLIMIT_NOFILE, &next) == 0 {
                return Some((before, want));
            }
        }
        Some((before, before))
    }
}

#[cfg(not(unix))]
pub fn raise_nofile() -> Option<(u64, u64)> {
    None
}

#[cfg(all(test, unix))]
mod tests {
    #[test]
    fn a_low_soft_limit_is_raised() {
        // SAFETY: as above; lowers this test process's soft limit to 256 first.
        unsafe {
            let mut lim = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            assert_eq!(libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim), 0);
            let low = libc::rlimit {
                rlim_cur: 256,
                rlim_max: lim.rlim_max,
            };
            assert_eq!(libc::setrlimit(libc::RLIMIT_NOFILE, &low), 0);
        }
        let (before, after) = super::raise_nofile().expect("rlimit");
        assert_eq!(before, 256);
        assert!(after >= 10_240, "soft limit only {after}");
    }
}
