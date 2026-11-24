// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The history list (VH-01d frames 1b/1c, docs/30 §4): grouped by day, newest first; a run of
// automatic saves with no gap over 30 minutes is one editing session (decision 2).

/** One version as `GET /v1/history` lists it (docs/15 §6). */
export interface Version {
  version: string;
  at: string;
  authors?: string[];
  name?: string;
  kind?: "auto" | "named" | "restore";
  size?: number;
  source?: "host" | "file";
  latest?: boolean;
}

export type Item =
  | { k: "one"; v: Version; label: string }
  | { k: "session"; id: string; saves: Version[]; from: number; to: number; authors: string[] };

export interface Day {
  key: string;
  label: string;
  items: Item[];
}

export const SESSION_GAP_MS = 30 * 60_000;
const MONTH = { month: "short", day: "numeric" } as const;
const DAY_MS = 86_400_000;

const ms = (v: Version) => Date.parse(v.at) || 0;
const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
const midnight = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** "10:02" in local time (24-hour, as in the approved frames). */
export function clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "Today", "Yesterday, Nov 23", "Friday, Nov 20" within a week, else "Oct 2" ("Oct 2, 2025"). */
export function dayLabel(t: number, now = Date.now()): string {
  const days = Math.round((midnight(now) - midnight(t)) / DAY_MS);
  const md = new Date(t).toLocaleDateString("en-US", MONTH);
  if (days <= 0) return "Today";
  if (days === 1) return `Yesterday, ${md}`;
  if (days < 7) return `${new Date(t).toLocaleDateString("en-US", { weekday: "long" })}, ${md}`;
  return new Date(t).getFullYear() === new Date(now).getFullYear() ? md : `${md}, ${new Date(t).getFullYear()}`;
}

/** A short date and time: "today, 10:14" or "Nov 21, 10:14". */
export function stamp(t: number, now = Date.now()): string {
  const today = dayKey(t) === dayKey(now);
  return `${today ? "today" : new Date(t).toLocaleDateString("en-US", MONTH)}, ${clock(t)}`;
}

/** How a version is named in messages: “Its name”, else its date and time. */
export function versionLabel(v: Version, now = Date.now()): string {
  return v.name && v.kind === "named" ? `“${v.name}”` : stamp(ms(v), now);
}

export function groupVersions(list: Version[], now = Date.now()): Day[] {
  const days: Day[] = [];
  let session: Extract<Item, { k: "session" }> | null = null;
  list.forEach((v, i) => {
    const t = ms(v);
    const key = dayKey(t);
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      day = { key, label: dayLabel(t, now), items: [] };
      days.push(day);
      session = null;
    }
    const auto = (v.kind ?? "auto") === "auto";
    // The state just before a restore: its own row, so it is easy to go back to.
    const beforeRestore = auto && i > 0 && list[i - 1].kind === "restore";
    if (!auto || beforeRestore) {
      day.items.push({ k: "one", v, label: beforeRestore ? "Before restore" : v.name || "Untitled version" });
      session = null;
      return;
    }
    const prev = session as Extract<Item, { k: "session" }> | null;
    if (prev && prev.from - t <= SESSION_GAP_MS) {
      prev.saves.push(v);
      prev.from = t;
      for (const a of v.authors ?? []) if (!prev.authors.includes(a)) prev.authors.push(a);
      return;
    }
    session = { k: "session", id: v.version, saves: [v], from: t, to: t, authors: [...new Set(v.authors ?? [])] };
    day.items.push(session);
  });
  return days;
}

/** The version listed right after `id` (the one before it in time), for "The version before". */
export function versionBefore(list: Version[], id: string): Version | null {
  const i = list.findIndex((v) => v.version === id);
  return i >= 0 && i + 1 < list.length ? list[i + 1] : null;
}
