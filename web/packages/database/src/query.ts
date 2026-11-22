// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import type { OcUser } from "@opencanvas/ui";
import { cellToText, personName } from "./model";
import type { CellValue, DbField, DbOption, DbRow, DbSnapshot, FieldType, FilterOp, FilterRule, SortRule, ViewPrefs } from "./types";

export const optOf = (f: DbField | undefined, v: unknown): DbOption | undefined => (f?.options ?? []).find((o) => o.v === v);
/** Field the board view groups by: the view's choice when it is a status/select field, else the first status, else the first select. */
export const groupField = (db: DbSnapshot, prefs?: ViewPrefs) =>
  db.fields.find((f) => f.id === prefs?.group && (f.type === "status" || f.type === "select")) ??
  db.fields.find((f) => f.type === "status") ??
  db.fields.find((f) => f.type === "select");
/** Date field the calendar uses: the view's choice, else the first date field. */
export const dateField = (db: DbSnapshot, prefs?: ViewPrefs) =>
  db.fields.find((f) => f.id === prefs?.date && f.type === "date") ?? db.fields.find((f) => f.type === "date");
export const titleField = (db: DbSnapshot) => db.fields.find((f) => f.type === "title") ?? db.fields[0];

/** The view's sort keys (`sorts`, else the single legacy `sort`), dropping unknown fields. */
export function sortsOf(db: DbSnapshot, prefs: ViewPrefs): SortRule[] {
  const list = prefs.sorts ?? (prefs.sort ? [prefs.sort] : []);
  return list.filter((s) => s && db.fields.some((f) => f.id === s.f));
}
/** Field types filtered by picking values (any of): option-like fields and checkboxes. */
export const VALUE_FILTER_TYPES: FieldType[] = ["status", "select", "tags", "person", "checkbox"];

/** Conditions offered for a field type; `null` for value-list fields (see `VALUE_FILTER_TYPES`). */
export function filterOps(t: FieldType): FilterOp[] | null {
  if (VALUE_FILTER_TYPES.includes(t)) return null;
  if (t === "number" || t === "progress") return ["eq", "ne", "lt", "le", "gt", "ge", "between", "empty"];
  if (t === "date") return ["is", "before", "after", "next", "past", "empty"];
  return ["contains", "is", "empty"];
}

export const OP_LABEL: Record<FilterOp, string> = {
  contains: "contains", is: "is", empty: "is empty", eq: "=", ne: "≠", lt: "<", le: "≤", gt: ">", ge: "≥", between: "between",
  before: "is before", after: "is after", next: "within the next", past: "within the past",
};

const numOf = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** True when the rule has everything it needs to filter (a value, a valid condition for the field type). */
export function ruleReady(f: DbField, r: FilterRule): boolean {
  const ops = filterOps(f.type);
  if (!ops) return !r.op && Array.isArray(r.vals) && r.vals.length > 0;
  if (!r.op || !ops.includes(r.op)) return false;
  if (r.op === "empty") return true;
  if (f.type === "date") return r.op === "next" || r.op === "past" ? (numOf(r.v) ?? -1) >= 0 : isDay(r.v);
  if (ops.includes("between")) return numOf(r.v) !== null && (r.op !== "between" || numOf(r.v2) !== null);
  return typeof r.v === "string" && r.v.trim() !== "";
}

/** Every rule on a field that still exists (finished or not), for the filter editor and chips. */
export function rulesOf(db: DbSnapshot, prefs: ViewPrefs): FilterRule[] {
  const list = prefs.filters ?? (prefs.filter ? [prefs.filter] : []);
  return list.filter((x) => x && typeof x === "object" && db.fields.some((f) => f.id === x.f));
}
/** The view's filters that apply: finished rules on fields that exist. */
export function filtersOf(db: DbSnapshot, prefs: ViewPrefs): FilterRule[] {
  return rulesOf(db, prefs).filter((x) => ruleReady(db.fields.find((f) => f.id === x.f)!, x));
}
/** Prefs patch that stores sort keys, mirroring the first into the legacy `sort`. */
export const sortPatch = (sorts: SortRule[]): Partial<ViewPrefs> => ({ sorts, sort: sorts[0] ?? null });
/**
 * Prefs patch that stores filters. The legacy `filter` mirrors the first value-list rule only,
 * the one kind older clients understand.
 */
export const filterPatch = (filters: FilterRule[]): Partial<ViewPrefs> => ({ filters, filter: filters.find((x) => !x.op && x.vals?.length) ?? null });

const shiftDay = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return isoDate(new Date(y, m - 1, d + n));
};

/** Does cell value `v` pass rule `r` on field `f`? `today` is `YYYY-MM-DD`. */
export function matchRule(f: DbField, r: FilterRule, v: unknown, users: OcUser[] = [], today = isoDate(new Date())): boolean {
  if (!r.op) {
    const vals = r.vals ?? [];
    if (f.type === "checkbox") return vals.includes(v ? "true" : "false");
    if (Array.isArray(v)) return v.length ? v.some((x) => vals.includes(x)) : vals.includes("");
    return vals.includes(v == null ? "" : String(v));
  }
  const empty = v == null || v === "" || (Array.isArray(v) && !v.length);
  if (r.op === "empty") return empty;
  if (f.type === "date") {
    if (!isDay(v)) return false;
    const n = Math.round(numOf(r.v) ?? 0);
    switch (r.op) {
      case "is":
        return v === r.v;
      case "before":
        return v < String(r.v);
      case "after":
        return v > String(r.v);
      case "next":
        return v >= today && v <= shiftDay(today, n);
      case "past":
        return v <= today && v >= shiftDay(today, -n);
    }
    return false;
  }
  if (f.type === "number" || f.type === "progress") {
    const x = numOf(v), a = numOf(r.v) ?? 0;
    if (r.op === "ne") return x === null || x !== a;
    if (x === null) return false;
    switch (r.op) {
      case "eq":
        return x === a;
      case "lt":
        return x < a;
      case "le":
        return x <= a;
      case "gt":
        return x > a;
      case "ge":
        return x >= a;
      case "between": {
        const b = numOf(r.v2) ?? a;
        return x >= Math.min(a, b) && x <= Math.max(a, b);
      }
    }
    return false;
  }
  const text = cellToText(f, v as CellValue, users).toLowerCase();
  const q = String(r.v ?? "").trim().toLowerCase();
  return r.op === "contains" ? text.includes(q) : r.op === "is" ? text.trim() === q : false;
}

const dayLabel = (v: unknown) => (isDay(v) ? fmtDate(v) : String(v));
const blank = (v: unknown) => v === undefined || v === null || v === "";

/**
 * Short text for a rule's chip: "Points ≥ 3", "Due within the next 7 days", "Status: Done, Empty".
 * `name` maps a value of a value-list rule to its label (people's names).
 */
export function filterLabel(f: DbField, r: FilterRule, name: (v: string) => string = (v) => v): string {
  if (!r.op) {
    const vals = r.vals ?? [];
    const label = (v: string) => (f.type === "checkbox" ? (v === "true" ? "Checked" : "Not checked") : v ? name(v) : "Empty");
    return `${f.name}: ${vals.length ? vals.map(label).join(", ") : "…"}`;
  }
  const v = blank(r.v) ? "…" : String(r.v);
  switch (r.op) {
    case "empty":
      return `${f.name} is empty`;
    case "contains":
    case "is":
      if (f.type === "date") return `${f.name} is ${blank(r.v) ? "…" : dayLabel(r.v)}`;
      return `${f.name} ${r.op} ${blank(r.v) ? "…" : `“${v}”`}`;
    case "between":
      return `${f.name} between ${v} and ${blank(r.v2) ? "…" : String(r.v2)}`;
    case "next":
    case "past": {
      const n = numOf(r.v);
      return `${f.name} ${OP_LABEL[r.op]} ${n === null ? "…" : n === 1 ? "day" : `${n} days`}`;
    }
    case "before":
    case "after":
      return `${f.name} ${r.op} ${blank(r.v) ? "…" : dayLabel(r.v)}`;
    default:
      return `${f.name} ${OP_LABEL[r.op]} ${v}`;
  }
}

/* ------------------------------------------------------- fields per view */

/** All fields in the view's order: `prefs.fields` first (known ids), then the rest in database order. */
export function orderedFields(db: DbSnapshot, prefs: ViewPrefs): DbField[] {
  const order = Array.isArray(prefs.fields) ? prefs.fields : [];
  if (!order.length) return db.fields;
  const byId = new Map(db.fields.map((f) => [f.id, f]));
  const out: DbField[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const f = byId.get(id);
    if (f && !seen.has(id)) {
      seen.add(id);
      out.push(f);
    }
  }
  for (const f of db.fields) if (!seen.has(f.id)) out.push(f);
  return out;
}

/** The fields this view shows, in its order. The title field is never hidden. */
export function viewFields(db: DbSnapshot, prefs: ViewPrefs): DbField[] {
  const hidden = Array.isArray(prefs.hidden) ? prefs.hidden : [];
  const list = orderedFields(db, prefs);
  return hidden.length ? list.filter((f) => f.type === "title" || !hidden.includes(f.id)) : list;
}

/** Split `text` into plain and matching parts for search highlighting (case-insensitive). */
export function highlightParts(text: string, q: string): { t: string; hit: boolean }[] {
  const n = q.trim().toLowerCase();
  if (!n || !text) return [{ t: text, hit: false }];
  const out: { t: string; hit: boolean }[] = [];
  const low = text.toLowerCase();
  let i = 0;
  for (let j = low.indexOf(n); j >= 0; j = low.indexOf(n, i)) {
    if (j > i) out.push({ t: text.slice(i, j), hit: false });
    out.push({ t: text.slice(j, j + n.length), hit: true });
    i = j + n.length;
  }
  if (i < text.length) out.push({ t: text.slice(i), hit: false });
  return out;
}

/** Apply a view's filters (all must match), search and sort keys. Returns a new array. */
export function visibleRows(db: DbSnapshot, prefs: ViewPrefs, users: OcUser[], now = new Date()): DbRow[] {
  let rows = db.rows.slice();
  const today = isoDate(now);
  for (const flt of filtersOf(db, prefs)) {
    const f = db.fields.find((x) => x.id === flt.f)!;
    rows = rows.filter((r) => matchRule(f, flt, r.v[flt.f], users, today));
  }
  const q = (prefs.q ?? "").trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) => db.fields.some((f) => cellToText(f, r.v[f.id], users).toLowerCase().includes(q)) || (db.notes[r.id] ?? "").toLowerCase().includes(q));
  }
  const keys = sortsOf(db, prefs).map((s) => ({ s, f: db.fields.find((x) => x.id === s.f)! }));
  if (keys.length) {
    const key = (f: DbField, r: DbRow): string | number | null => {
      const v = r.v[f.id];
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) return null;
      if (f.type === "status" || f.type === "select") {
        const i = (f.options ?? []).findIndex((o) => o.v === v);
        return i < 0 ? null : i;
      }
      if (f.type === "person") return personName(v, users).toLowerCase();
      if (f.type === "number" || f.type === "progress") return Number(v);
      if (f.type === "checkbox") return v ? 1 : 0;
      if (Array.isArray(v)) return v.join(", ").toLowerCase();
      return String(v).toLowerCase();
    };
    const keyed = rows.map((r, i) => ({ r, k: keys.map(({ f }) => key(f, r)), i }));
    keyed.sort((a, b) => {
      for (let j = 0; j < keys.length; j++) {
        const x = a.k[j], y = b.k[j];
        if (x === null && y === null) continue;
        if (x === null) return 1;
        if (y === null) return -1;
        const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
        if (c !== 0) return c * keys[j].s.dir;
      }
      return a.i - b.i;
    });
    rows = keyed.map((x) => x.r);
  }
  return rows;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function fmtDate(s: unknown, now = new Date()): string {
  if (typeof s !== "string" || !s) return "";
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return s;
  return MON[m - 1] + " " + d + (y !== now.getFullYear() ? ", " + y : "");
}

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const isoMonth = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export function addDays(n: number, from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + n);
  return isoDate(d);
}
export function shiftMonth(ym: string, delta: number): string {
  let [y, m] = ym.split("-").map(Number);
  m += delta;
  while (m < 1) {
    m += 12;
    y--;
  }
  while (m > 12) {
    m -= 12;
    y++;
  }
  return `${y}-${pad(m)}`;
}

/** The month a calendar view opens on: saved pref, else the month of the nearest dated row, else today. */
export function defaultMonth(db: DbSnapshot, now = new Date(), prefs?: ViewPrefs): string {
  const df = dateField(db, prefs);
  const cur = isoMonth(now);
  if (!df) return cur;
  const dates = db.rows.map((r) => r.v[df.id]).filter((v): v is string => typeof v === "string" && /^\d{4}-\d{2}/.test(v));
  if (!dates.length || dates.some((d) => d.startsWith(cur))) return cur;
  const today = isoDate(now);
  dates.sort((a, b) => Math.abs(Date.parse(a) - Date.parse(today)) - Math.abs(Date.parse(b) - Date.parse(today)));
  return dates[0].slice(0, 7);
}
