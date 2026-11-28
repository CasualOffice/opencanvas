// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Timeline (Gantt) and Workload views (DB5-01, prototype v04-approved/timeline.html): the date
// arithmetic, spans, dependencies, conflicts, the shift of dependents, the critical path and
// workload sums. No React, no Yjs: the views read a database snapshot through these.

import type { CellValue, DbField, DbRow, DbSnapshot } from "../types";

/* ---------------------------------------------------------------- days */

/** A day as a whole number (days since 1970-01-01, UTC), from `YYYY-MM-DD`. */
export function day(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : Math.round(t / 86_400_000);
}
export const iso = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);
/** 0 Sunday … 6 Saturday. */
export const weekday = (d: number) => (d + 4) % 7;
export const isWeekend = (d: number) => weekday(d) === 0 || weekday(d) === 6;
/** Monday of the week holding `d`. */
export const weekStart = (d: number) => d - ((weekday(d) + 6) % 7);
export const today = () => Math.floor(Date.now() / 86_400_000);

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Dec 14". */
export function short(d: number): string {
  const x = new Date(d * 86_400_000);
  return `${MON[x.getUTCMonth()]} ${x.getUTCDate()}`;
}
export const monthOf = (d: number) => {
  const x = new Date(d * 86_400_000);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() };
};
export const monthName = (m: number) => MON[m];
export const firstOfMonth = (y: number, m: number) => Math.round(Date.UTC(y, m, 1) / 86_400_000);

/** `n` working days from `d` (weekends skipped when `work`); negative goes back. */
export function addDays(d: number, n: number, work: boolean): number {
  if (!work) return d + n;
  let x = d;
  const s = Math.sign(n);
  for (let i = 0; i < Math.abs(n); ) {
    x += s;
    if (!isWeekend(x)) i++;
  }
  return x;
}
/** Days in `[a, b]` inclusive, counting only working days when `work`. */
export function spanDays(a: number, b: number, work: boolean): number {
  if (b < a) return 0;
  if (!work) return b - a + 1;
  let n = 0;
  for (let x = a; x <= b; x++) if (!isWeekend(x)) n++;
  return n;
}
/** Working days from a to b (b > a positive). */
export function diffDays(a: number, b: number, work: boolean): number {
  if (!work) return b - a;
  const s = b >= a ? 1 : -1;
  let n = 0;
  for (let x = a; x !== b; x += s) if (!isWeekend(x + s)) n += s;
  return n;
}

/* ---------------------------------------------------------------- settings */

export type Zoom = "day" | "week" | "month" | "quarter";
/** rem per day at each zoom. */
export const DAY_REM: Record<Zoom, number> = { day: 2.5, week: 1, month: 0.3, quarter: 0.11 };

/** The Timeline's own settings (prototype frame 3a), stored in the view's prefs as `tl`. */
export interface TimelinePrefs {
  start?: string;
  end?: string;
  /** A Number field of working days, instead of an end date. */
  dur?: string;
  /** The "Blocked by" relation (to this database). */
  dep?: string;
  /** Milestone rule: field id and the value that makes a row a milestone (checkbox: "true"). */
  ms?: { f: string; v: string };
  color?: string;
  prog?: string;
  /** Fields shown after the bar. */
  after?: string[];
  zoom?: Zoom;
  /** Skip weekends when moving, counting and shifting (Mon–Fri). Default on. */
  work?: boolean;
  shade?: boolean;
  tray?: boolean;
  crit?: boolean;
  /** Group rows by this select or status field. */
  group?: string;
  /** Workload: estimate (hours), the person field, capacity per person, weeks shown from. */
  est?: string;
  who?: string;
  cap?: Record<string, number>;
}

/** The settings with the sensible defaults of frame 3: the first two date fields (or one date
 *  plus a number called like a duration), the first self-relation, status, progress, person. */
export function resolve(db: DbSnapshot, p: TimelinePrefs = {}): Required<Pick<TimelinePrefs, "zoom" | "work" | "shade" | "tray" | "crit">> & TimelinePrefs {
  const has = (id?: string) => !!id && db.fields.some((f) => f.id === id);
  const dates = db.fields.filter((f) => f.type === "date");
  const start = has(p.start) ? p.start : dates[0]?.id;
  const dur = has(p.dur) ? p.dur : undefined;
  const end = has(p.end) ? p.end : dur ? undefined : dates.find((f) => f.id !== start)?.id;
  const durAuto = dur ?? (!end ? db.fields.find((f) => f.type === "number" && /dur|days/i.test(f.name))?.id : undefined);
  const dep = has(p.dep) ? p.dep : db.fields.find((f) => f.type === "relation" && f.rel?.db === db.id && !f.rel.file && /block/i.test(f.name) && !/^blocks$/i.test(f.name))?.id;
  return {
    ...p,
    start,
    end,
    dur: durAuto,
    dep,
    color: has(p.color) ? p.color : db.fields.find((f) => f.type === "status")?.id ?? db.fields.find((f) => f.type === "select")?.id,
    prog: has(p.prog) ? p.prog : db.fields.find((f) => f.type === "progress")?.id,
    who: has(p.who) ? p.who : db.fields.find((f) => f.type === "person")?.id,
    est: has(p.est) ? p.est : db.fields.find((f) => f.type === "number" && /estimate|hours/i.test(f.name))?.id,
    zoom: p.zoom ?? "week",
    work: p.work ?? true,
    shade: p.shade ?? true,
    tray: p.tray ?? true,
    crit: p.crit ?? false,
  };
}

/* ---------------------------------------------------------------- spans */

export interface Span {
  id: string;
  s: number;
  e: number;
  ms: boolean;
}

/** A row's span from the settings; null without a start date (the No dates tray). */
export function spanOf(r: DbRow, p: TimelinePrefs): Span | null {
  const s = day(p.start ? r.v[p.start] : null);
  if (s == null) return null;
  let e = s;
  if (p.end) e = day(r.v[p.end]) ?? s;
  else if (p.dur) {
    const n = Number(r.v[p.dur]);
    e = Number.isFinite(n) && n > 1 ? addDays(s, Math.round(n) - 1, p.work ?? true) : s;
  }
  if (e < s) e = s;
  const ms = !!p.ms && String(r.v[p.ms.f] ?? "") === p.ms.v;
  return { id: r.id, s, e, ms };
}

const ids = (v: CellValue | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Dependency edges `[blocker, blocked]` from the "Blocked by" field. */
export function edges(rows: DbRow[], dep?: string): [string, string][] {
  if (!dep) return [];
  const have = new Set(rows.map((r) => r.id));
  const out: [string, string][] = [];
  for (const r of rows) for (const b of ids(r.v[dep])) if (have.has(b) && b !== r.id) out.push([b, r.id]);
  return out;
}

/** Edges whose blocked task starts on or before its blocker ends (drawn red and dashed). */
export function conflicts(spans: Map<string, Span>, es: [string, string][]): [string, string][] {
  return es.filter(([a, b]) => {
    const x = spans.get(a);
    const y = spans.get(b);
    return !!x && !!y && y.s <= x.e;
  });
}

/**
 * After `moved` changed, what "Shift dependents" does (frame 2b): every task that depends on it,
 * directly or not, moves by the same working days, the fewest that clear every conflict along the
 * way. Returns the days and the ids moved (empty when nothing conflicts).
 */
export function shiftPlan(spans: Map<string, Span>, es: [string, string][], moved: string, work: boolean): { days: number; ids: string[] } {
  const next = new Map<string, string[]>();
  for (const [a, b] of es) next.set(a, [...(next.get(a) ?? []), b]);
  const down: string[] = [];
  const seen = new Set<string>([moved]);
  const q = [moved];
  while (q.length) for (const n of next.get(q.shift()!) ?? []) if (!seen.has(n)) (seen.add(n), down.push(n), q.push(n));
  if (!down.length) return { days: 0, ids: [] };
  // The least shift such that, with every dependent moved by it, no edge from a fixed blocker
  // (the moved task, or one outside the set) conflicts.
  const inSet = new Set(down);
  let days = 0;
  for (const [a, b] of es) {
    if (!inSet.has(b) || inSet.has(a)) continue;
    const x = spans.get(a);
    const y = spans.get(b);
    if (!x || !y || y.s > x.e) continue;
    days = Math.max(days, diffDays(y.s, addDays(x.e, 1, work), work));
  }
  return days > 0 ? { days, ids: down.filter((id) => spans.has(id)) } : { days: 0, ids: [] };
}

/**
 * The critical path (frame 1, "Critical path"): tasks with no slack before the project's end,
 * by the usual backward pass over the dependency graph in working days.
 */
export function criticalPath(spans: Map<string, Span>, es: [string, string][], work: boolean): Set<string> {
  const crit = new Set<string>();
  if (!spans.size || !es.length) return crit;
  const succ = new Map<string, string[]>();
  for (const [a, b] of es) if (spans.has(a) && spans.has(b)) succ.set(a, [...(succ.get(a) ?? []), b]);
  const end = Math.max(...[...spans.values()].map((s) => s.e));
  // Latest finish: before every successor's latest start; tasks are visited from the latest.
  const lf = new Map<string, number>();
  const order = [...spans.values()].sort((x, y) => y.e - x.e);
  const latestStart = (id: string): number => {
    const sp = spans.get(id)!;
    return addDays(latestFinish(id), -(spanDays(sp.s, sp.e, work) - 1), work);
  };
  const latestFinish = (id: string, guard = 0): number => {
    if (lf.has(id)) return lf.get(id)!;
    let v = end;
    if (guard < 500) for (const s of succ.get(id) ?? []) v = Math.min(v, addDays(latestStart(s), -1, work));
    lf.set(id, v);
    return v;
  };
  const involved = new Set(es.flat());
  for (const sp of order) {
    if (!involved.has(sp.id)) continue;
    if (latestFinish(sp.id) <= sp.e) crit.add(sp.id);
  }
  return crit;
}

/* ---------------------------------------------------------------- workload */

export interface LoadCell {
  hours: number;
  cap: number;
  rows: string[];
}

/**
 * Hours per person per week (frame 4a): each task's estimate spread over its working days, the
 * share falling in the week. Unassigned tasks are under the person id "".
 */
export function workload(rows: DbRow[], p: TimelinePrefs, weeks: number[], capDefault = 40): Map<string, LoadCell[]> {
  const out = new Map<string, LoadCell[]>();
  const work = p.work ?? true;
  const cell = (who: string) => {
    if (!out.has(who)) out.set(who, weeks.map(() => ({ hours: 0, cap: p.cap?.[who] ?? capDefault, rows: [] })));
    return out.get(who)!;
  };
  for (const r of rows) {
    const sp = spanOf(r, p);
    if (!sp) continue;
    const who = p.who && typeof r.v[p.who] === "string" ? (r.v[p.who] as string) : "";
    const est = p.est ? Number(r.v[p.est]) : NaN;
    const total = Math.max(1, spanDays(sp.s, sp.e, work));
    weeks.forEach((w, i) => {
      const a = Math.max(w, sp.s);
      const b = Math.min(w + 6, sp.e);
      if (b < a) return;
      const c = cell(who)[i];
      c.rows.push(r.id);
      if (Number.isFinite(est)) c.hours += (est * spanDays(a, b, work)) / total;
    });
  }
  for (const v of out.values()) for (const c of v) c.hours = Math.round(c.hours * 10) / 10;
  return out;
}

/** Load band for a cell: under 80%, 80–100%, over. */
export const band = (c: LoadCell) => (c.hours > c.cap ? "over" : c.hours >= 0.8 * c.cap ? "near" : "ok");

/* ---------------------------------------------------------------- phone and access */

/** Rows by the week they start in (frame 5a), weeks in order. */
export function byWeek(rows: DbRow[], p: TimelinePrefs): { week: number; items: Span[] }[] {
  const m = new Map<number, Span[]>();
  for (const r of rows) {
    const sp = spanOf(r, p);
    if (!sp) continue;
    const w = weekStart(sp.s);
    m.set(w, [...(m.get(w) ?? []), sp]);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([week, items]) => ({ week, items: items.sort((a, b) => a.s - b.s) }));
}

/** Rows by the month they start in (frame 5a, Months), months (their first day) in order. */
export function byMonth(rows: DbRow[], p: TimelinePrefs): { month: number; items: Span[] }[] {
  const m = new Map<number, Span[]>();
  for (const r of rows) {
    const sp = spanOf(r, p);
    if (!sp) continue;
    const { y, m: mo } = monthOf(sp.s);
    const k = firstOfMonth(y, mo);
    m.set(k, [...(m.get(k) ?? []), sp]);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([month, items]) => ({ month, items: items.sort((a, b) => a.s - b.s) }));
}

/**
 * Frame 6b: when no task overlaps the days `a`..`b` shown, the nearest start after them and the
 * nearest end before them (for "Jump to"); null when something is in range or nothing has dates.
 */
export function emptyRange(spans: Iterable<Span>, a: number, b: number): { next: number | null; prev: number | null } | null {
  let next: number | null = null;
  let prev: number | null = null;
  let any = false;
  for (const sp of spans) {
    any = true;
    if (sp.e >= a && sp.s <= b) return null;
    if (sp.s > b && (next == null || sp.s < next)) next = sp.s;
    if (sp.e < a && (prev == null || sp.e > prev)) prev = sp.e;
  }
  return any ? { next, prev } : null;
}

/** The bar's accessible name (frame 7): "API freeze, Dec 14 to Dec 18, blocks SDK docs and Partner beta". */
export function barLabel(title: string, sp: Span, blocks: string[], blockedBy: string[]): string {
  const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  let s = sp.ms ? `${title}, milestone on ${short(sp.s)}` : `${title}, ${short(sp.s)} to ${short(sp.e)}`;
  if (blockedBy.length) s += `, blocked by ${list(blockedBy)}`;
  if (blocks.length) s += `, blocks ${list(blocks)}`;
  return s;
}

/** The title field's text for a row. */
export const titleOf = (db: DbSnapshot, r: DbRow) => {
  const t: DbField | undefined = db.fields.find((f) => f.type === "title");
  return (t && typeof r.v[t.id] === "string" && (r.v[t.id] as string)) || "Untitled";
};
