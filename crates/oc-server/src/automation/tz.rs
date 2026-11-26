// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Time zones for date and schedule rules (AUTO-03): the system's IANA zoneinfo files (TZif
//! v2+, `OC_ZONEINFO` or `/usr/share/zoneinfo`), transitions plus the POSIX TZ footer for times
//! past the last transition. Also `UTC` and fixed offsets (`UTC+05:30`). No new dependency.

use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq)]
pub struct Tz {
    /// (transition time in UTC seconds, offset after it in seconds).
    trans: Vec<(i64, i32)>,
    /// Offset before the first transition.
    initial: i32,
    rule: Option<Posix>,
}

#[derive(Debug, Clone, PartialEq)]
struct Posix {
    std: i32,
    dst: Option<(i32, Rule, Rule)>,
}

/// `Mm.w.d/time`: day `d` (0 = Sunday) of week `w` (5 = last) of month `m`, at local `time`.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Rule {
    m: u32,
    w: u32,
    d: u32,
    secs: i32,
}

fn dir() -> PathBuf {
    std::env::var_os("OC_ZONEINFO")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/usr/share/zoneinfo"))
}

fn be32(b: &[u8], i: usize) -> i64 {
    i32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as i64
}
fn be64(b: &[u8], i: usize) -> i64 {
    i64::from_be_bytes(b[i..i + 8].try_into().unwrap_or([0; 8]))
}

impl Tz {
    pub fn utc() -> Self {
        Self {
            trans: vec![],
            initial: 0,
            rule: None,
        }
    }

    /// `UTC`, `UTC+05:30` / `UTC-03`, or an IANA name such as `Europe/Berlin`.
    pub fn load(name: &str) -> Result<Self, String> {
        if name == "UTC" || name == "Etc/UTC" || name == "GMT" {
            return Ok(Self::utc());
        }
        if let Some(off) = name
            .strip_prefix("UTC")
            .filter(|r| r.starts_with(['+', '-']))
        {
            let sign = if off.starts_with('-') { -1 } else { 1 };
            let (h, m) = off[1..].split_once(':').unwrap_or((&off[1..], "0"));
            let (h, m): (i32, i32) = (
                h.parse().map_err(|_| "bad offset")?,
                m.parse().map_err(|_| "bad offset")?,
            );
            if h > 14 || m > 59 {
                return Err("bad offset".into());
            }
            return Ok(Self {
                initial: sign * (h * 3600 + m * 60),
                ..Self::utc()
            });
        }
        let ok = !name.is_empty()
            && name.len() <= 64
            && !name.contains("..")
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-' | b'+'));
        if !ok {
            return Err("not a time zone name".into());
        }
        let bytes = std::fs::read(dir().join(name)).map_err(|_| "unknown time zone".to_string())?;
        Self::parse(&bytes).ok_or_else(|| "unreadable zoneinfo file".into())
    }

    fn parse(b: &[u8]) -> Option<Self> {
        if b.len() < 44 || &b[..4] != b"TZif" {
            return None;
        }
        let counts = |o: usize| -> Option<[usize; 6]> {
            let mut c = [0usize; 6];
            for (i, x) in c.iter_mut().enumerate() {
                *x = usize::try_from(be32(b, o + 20 + i * 4)).ok()?;
            }
            Some(c)
        };
        let [isut, isstd, leap, timecnt, typecnt, charcnt] = counts(0)?;
        let v1_len = timecnt * 5 + typecnt * 6 + charcnt + leap * 8 + isstd + isut;
        let (o, wide) = if b[4] >= b'2' {
            (44 + v1_len, true)
        } else {
            (0, false)
        };
        if wide && (b.len() < o + 44 || &b[o..o + 4] != b"TZif") {
            return None;
        }
        let [isut, isstd, leap, timecnt, typecnt, charcnt] = counts(o)?;
        let tsz = if wide { 8 } else { 4 };
        let mut p = o + 44;
        let need =
            timecnt * tsz + timecnt + typecnt * 6 + charcnt + leap * (tsz + 4) + isstd + isut;
        if b.len() < p + need {
            return None;
        }
        let times: Vec<i64> = (0..timecnt)
            .map(|i| {
                if wide {
                    be64(b, p + i * 8)
                } else {
                    be32(b, p + i * 4)
                }
            })
            .collect();
        p += timecnt * tsz;
        let idx: Vec<usize> = b[p..p + timecnt].iter().map(|x| *x as usize).collect();
        p += timecnt;
        let types: Vec<i32> = (0..typecnt).map(|i| be32(b, p + i * 6) as i32).collect();
        p += typecnt * 6 + charcnt + leap * (tsz + 4) + isstd + isut;
        let trans = times
            .iter()
            .zip(idx)
            .filter_map(|(t, i)| types.get(i).map(|o| (*t, *o)))
            .collect();
        let initial = *types.first()?;
        let rule = if wide {
            std::str::from_utf8(&b[p..])
                .ok()
                .and_then(|s| s.trim_matches('\n').lines().next())
                .and_then(parse_posix)
        } else {
            None
        };
        Some(Self {
            trans,
            initial,
            rule,
        })
    }

    /// The UTC offset (seconds east) at a UTC instant.
    pub fn offset_at(&self, utc: i64) -> i32 {
        if let Some(r) = &self.rule
            && self.trans.last().is_none_or(|(t, _)| utc >= *t)
        {
            return r.offset_at(utc);
        }
        match self.trans.partition_point(|(t, _)| *t <= utc) {
            0 => self.initial,
            i => self.trans[i - 1].1,
        }
    }

    /// The UTC instant of a local wall time (the later offset wins in a gap or overlap).
    pub fn to_utc(&self, local: i64) -> i64 {
        let first = local - self.offset_at(local) as i64;
        let second = local - self.offset_at(first) as i64;
        if self.offset_at(second) as i64 == local - second {
            second
        } else {
            first
        }
    }

    pub fn to_local(&self, utc: i64) -> i64 {
        utc + self.offset_at(utc) as i64
    }
}

impl Posix {
    fn offset_at(&self, utc: i64) -> i32 {
        let Some((dst, start, end)) = &self.dst else {
            return self.std;
        };
        let (y, ..) = civil(utc + self.std as i64);
        let s = rule_time(y, start) - self.std as i64;
        let e = rule_time(y, end) - *dst as i64;
        let inside = if s < e {
            utc >= s && utc < e
        } else {
            utc >= s || utc < e
        };
        if inside { *dst } else { self.std }
    }
}

/// Local seconds of a rule in year `y`.
fn rule_time(y: i64, r: &Rule) -> i64 {
    let first = days_from_civil(y, r.m, 1);
    let wd = (first + 4).rem_euclid(7) as u32; // 1970-01-01 was a Thursday
    let mut day = 1 + (r.d + 7 - wd) % 7 + (r.w.saturating_sub(1)) * 7;
    let dim = days_in_month(y, r.m);
    while day > dim {
        day -= 7;
    }
    (days_from_civil(y, r.m, day)) * 86_400 + r.secs as i64
}

fn parse_posix(s: &str) -> Option<Posix> {
    let mut it = s.chars().peekable();
    let name = |it: &mut std::iter::Peekable<std::str::Chars>| -> Option<()> {
        if it.peek() == Some(&'<') {
            for c in it.by_ref() {
                if c == '>' {
                    return Some(());
                }
            }
            return None;
        }
        let mut n = 0;
        while it.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
            it.next();
            n += 1;
        }
        (n >= 3).then_some(())
    };
    let num = |it: &mut std::iter::Peekable<std::str::Chars>| -> Option<i32> {
        let mut neg = false;
        if let Some(c) = it.peek().copied()
            && (c == '+' || c == '-')
        {
            neg = c == '-';
            it.next();
        }
        let mut parts = [0i32; 3];
        let mut k = 0;
        let mut any = false;
        while let Some(c) = it.peek().copied() {
            if let Some(d) = c.to_digit(10) {
                parts[k] = parts[k] * 10 + d as i32;
                any = true;
                it.next();
            } else if c == ':' && k < 2 {
                k += 1;
                it.next();
            } else {
                break;
            }
        }
        any.then_some((parts[0] * 3600 + parts[1] * 60 + parts[2]) * if neg { -1 } else { 1 })
    };
    name(&mut it)?;
    // POSIX offsets are west of UTC.
    let std = -num(&mut it)?;
    if it.peek().is_none() {
        return Some(Posix { std, dst: None });
    }
    name(&mut it)?;
    let dst = if it.peek().is_some_and(|c| *c != ',') {
        -num(&mut it)?
    } else {
        std + 3600
    };
    let rule = |it: &mut std::iter::Peekable<std::str::Chars>| -> Option<Rule> {
        if it.next()? != ',' || it.next()? != 'M' {
            return None;
        }
        let mut f = [0u32; 3];
        for (i, x) in f.iter_mut().enumerate() {
            let mut n = 0;
            while let Some(d) = it.peek().and_then(|c| c.to_digit(10)) {
                n = n * 10 + d;
                it.next();
            }
            *x = n;
            if i < 2 && it.next()? != '.' {
                return None;
            }
        }
        let secs = if it.peek() == Some(&'/') {
            it.next();
            num(it)?
        } else {
            7200
        };
        Some(Rule {
            m: f[0],
            w: f[1],
            d: f[2],
            secs,
        })
    };
    let start = rule(&mut it)?;
    let end = rule(&mut it)?;
    Some(Posix {
        std,
        dst: Some((dst, start, end)),
    })
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// (year, month, day, seconds of the day) of seconds since the epoch.
pub fn civil(secs: i64) -> (i64, u32, u32, i64) {
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d, sod)
}

pub fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trip() {
        for d in [-1000i64, 0, 19_000, 20_418] {
            let (y, m, dd, _) = civil(d * 86_400);
            assert_eq!(days_from_civil(y, m, dd), d);
        }
        assert_eq!(civil(1_764_143_880).0, 2025);
    }

    #[test]
    fn posix_rules_follow_european_summer_time() {
        let p = parse_posix("CET-1CEST,M3.5.0,M10.5.0/3").unwrap();
        let tz = Tz {
            trans: vec![],
            initial: 3600,
            rule: Some(p),
        };
        // 2026-11-26 is winter (UTC+1), 2026-07-01 summer (UTC+2).
        let nov = days_from_civil(2026, 11, 26) * 86_400;
        let jul = days_from_civil(2026, 7, 1) * 86_400;
        assert_eq!(tz.offset_at(nov), 3600);
        assert_eq!(tz.offset_at(jul), 7200);
        // 09:00 local on Nov 26 is 08:00 UTC.
        assert_eq!(tz.to_utc(nov + 9 * 3600), nov + 8 * 3600);
        let ny = parse_posix("EST5EDT,M3.2.0,M11.1.0").unwrap();
        assert_eq!(ny.offset_at(jul), -4 * 3600);
        assert_eq!(ny.offset_at(nov), -5 * 3600);
    }

    #[test]
    fn names_and_offsets() {
        assert_eq!(Tz::load("UTC").unwrap().offset_at(0), 0);
        assert_eq!(Tz::load("UTC+05:30").unwrap().offset_at(0), 19_800);
        assert!(Tz::load("../etc/passwd").is_err());
        assert!(Tz::load("Mars/Olympus").is_err());
        // The system zoneinfo, when the machine has it.
        if let Ok(b) = Tz::load("Europe/Berlin") {
            let jul = days_from_civil(2026, 7, 1) * 86_400;
            assert_eq!(b.offset_at(jul), 7200);
            assert_eq!(b.offset_at(days_from_civil(2026, 11, 26) * 86_400), 3600);
        }
    }
}
