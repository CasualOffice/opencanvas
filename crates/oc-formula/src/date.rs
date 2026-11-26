// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Calendar dates as days since 1970-01-01 (proleptic Gregorian; H. Hinnant's algorithms).

pub fn from_civil(y: i64, m: i64, d: i64) -> i64 {
    // Normalise the month first so DATE(2026, 14, 1) is 2027-02-01.
    let (y, m) = (y + (m - 1).div_euclid(12), (m - 1).rem_euclid(12) + 1);
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468 + (d - 1)
}

pub fn to_civil(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    from_civil(y, m + 1, 1) - from_civil(y, m, 1)
}

/// `YYYY-MM-DD` (anything after the day, such as a time, is ignored).
pub fn parse(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' || (b.len() > 10 && b[10].is_ascii_digit()) {
        return None;
    }
    let y: i64 = s.get(0..4)?.parse().ok()?;
    let m: i64 = s.get(5..7)?.parse().ok()?;
    let d: i64 = s.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
        return None;
    }
    Some(from_civil(y, m, d))
}

pub fn format(z: i64) -> String {
    let (y, m, d) = to_civil(z);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Adds whole months, clamping the day to the target month's length.
pub fn add_months(z: i64, n: i64) -> i64 {
    let (y, m, d) = to_civil(z);
    let t = y * 12 + (m - 1) + n;
    let (ty, tm) = (t.div_euclid(12), t.rem_euclid(12) + 1);
    from_civil(ty, tm, d.min(days_in_month(ty, tm)))
}

/// Whole months from `a` to `b` (counting only completed months).
pub fn months_between(a: i64, b: i64) -> i64 {
    let ((ya, ma, da), (yb, mb, db)) = (to_civil(a), to_civil(b));
    let mut n = (yb - ya) * 12 + (mb - ma);
    if n > 0 && db < da {
        n -= 1;
    } else if n < 0 && db > da {
        n += 1;
    }
    n
}
