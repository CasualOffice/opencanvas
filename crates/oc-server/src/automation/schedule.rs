// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! When date and schedule rules run next (AUTO-03), in the canvas time zone. A date rule runs
//! once a day at its time and acts on the rows whose date is `offsetDays` away; a schedule runs
//! every day, week, month or N minutes (never more often than the operator's minimum).

use oc_model::automation::{Trigger, parse_hhmm};

use super::tz::{Tz, civil, days_from_civil, days_in_month};

/// The first run strictly after `after` (UTC seconds), or `None` for event triggers.
pub fn next_run(trigger: &Trigger, after: i64, tz: &Tz, min_interval_min: u32) -> Option<i64> {
    match trigger {
        Trigger::DateReached { time, .. } => daily(after, tz, parse_hhmm(time)?),
        Trigger::Schedule {
            every,
            time,
            weekday,
            monthday,
            minutes,
        } => {
            let at = parse_hhmm(time)?;
            match every.as_str() {
                "day" => daily(after, tz, at),
                "week" => {
                    let wd = (*weekday)? as i64;
                    let mut t = daily(after, tz, at)?;
                    for _ in 0..8 {
                        let days = tz.to_local(t).div_euclid(86_400);
                        if (days + 4).rem_euclid(7) == wd {
                            return Some(t);
                        }
                        t = daily(t, tz, at)?;
                    }
                    None
                }
                "month" => {
                    let md = (*monthday)? as u32;
                    let (mut y, mut m, ..) = civil(tz.to_local(after));
                    for _ in 0..3 {
                        let day = md.min(days_in_month(y, m));
                        let local = days_from_civil(y, m, day) * 86_400 + at as i64 * 60;
                        let t = tz.to_utc(local);
                        if t > after {
                            return Some(t);
                        }
                        (y, m) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
                    }
                    None
                }
                "minutes" => {
                    let every = (*minutes)?.max(min_interval_min) as i64 * 60;
                    // Aligned to the interval from the local midnight-based grid, so every node
                    // computes the same slots.
                    let local = tz.to_local(after);
                    let next_local = (local.div_euclid(every) + 1) * every;
                    Some(after + (next_local - local))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// The next `at` (minutes after local midnight) strictly after `after`.
fn daily(after: i64, tz: &Tz, at: u32) -> Option<i64> {
    let local = tz.to_local(after);
    let day = local.div_euclid(86_400);
    for d in [day, day + 1, day + 2] {
        let t = tz.to_utc(d * 86_400 + at as i64 * 60);
        if t > after {
            return Some(t);
        }
    }
    None
}

/// The local date (`YYYY-MM-DD`) a date rule looks for when it runs at `utc`: today minus the
/// offset (`offsetDays = -1`: the day before the date, so rows dated tomorrow).
pub fn target_date(utc: i64, tz: &Tz, offset_days: i64) -> String {
    let (y, m, d, _) = civil(tz.to_local(utc) - offset_days * 86_400);
    format!("{y:04}-{m:02}-{d:02}")
}

/// The local date of an instant, `YYYY-MM-DD` (`field.set` to "today").
pub fn local_date(utc: i64, tz: &Tz) -> String {
    target_date(utc, tz, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn trig(v: serde_json::Value) -> Trigger {
        serde_json::from_value(v).unwrap()
    }
    fn at(y: i64, m: u32, d: u32, h: i64, min: i64) -> i64 {
        days_from_civil(y, m, d) * 86_400 + h * 3600 + min * 60
    }

    #[test]
    fn daily_weekly_monthly_and_minutes_in_a_time_zone() {
        let berlin = Tz::load("UTC+01:00").unwrap();
        // Nov 26 2026 10:00 UTC (11:00 Berlin): the next 09:00 Berlin is Nov 27, 08:00 UTC.
        let now = at(2026, 11, 26, 10, 0);
        let d = trig(
            json!({"kind": "date.reached", "database": "d", "field": "due", "offsetDays": -1, "time": "09:00"}),
        );
        assert_eq!(next_run(&d, now, &berlin, 15), Some(at(2026, 11, 27, 8, 0)));
        // Every Monday at 09:00: Dec 1 2026 is a Tuesday, so Nov 30.
        let w = trig(json!({"kind": "schedule", "every": "week", "weekday": 1, "time": "09:00"}));
        assert_eq!(next_run(&w, now, &berlin, 15), Some(at(2026, 11, 30, 8, 0)));
        let mo =
            trig(json!({"kind": "schedule", "every": "month", "monthday": 1, "time": "09:00"}));
        assert_eq!(next_run(&mo, now, &berlin, 15), Some(at(2026, 12, 1, 8, 0)));
        // Every 5 minutes is raised to the 15-minute minimum.
        let mi = trig(json!({"kind": "schedule", "every": "minutes", "minutes": 5}));
        let n = next_run(&mi, now, &berlin, 15).unwrap();
        assert_eq!(n - now, 15 * 60);
        assert_eq!(
            next_run(
                &trig(json!({"kind": "row.added", "database": "d"})),
                now,
                &berlin,
                15
            ),
            None
        );
        // The date the rule looks for: tomorrow, in Berlin.
        assert_eq!(
            target_date(at(2026, 11, 26, 23, 30), &berlin, -1),
            "2026-11-28"
        );
        assert_eq!(
            target_date(at(2026, 11, 26, 8, 0), &berlin, -1),
            "2026-11-27"
        );
    }
}
