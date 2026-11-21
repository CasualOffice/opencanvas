import type { OcUser } from "@opencanvas/ui";
import { cellToText, personName } from "./model";
import type { DbField, DbOption, DbRow, DbSnapshot, FilterRule, SortRule, ViewPrefs } from "./types";

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
/** The view's filters (`filters`, else the single legacy `filter`), dropping empty ones and unknown fields. */
export function filtersOf(db: DbSnapshot, prefs: ViewPrefs): FilterRule[] {
  const list = prefs.filters ?? (prefs.filter ? [prefs.filter] : []);
  return list.filter((x) => x && x.vals?.length && db.fields.some((f) => f.id === x.f));
}
/** Prefs patch that stores sort keys, mirroring the first into the legacy `sort`. */
export const sortPatch = (sorts: SortRule[]): Partial<ViewPrefs> => ({ sorts, sort: sorts[0] ?? null });
/** Prefs patch that stores filters, mirroring the first into the legacy `filter`. */
export const filterPatch = (filters: FilterRule[]): Partial<ViewPrefs> => ({ filters, filter: filters[0] ?? null });

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
export function visibleRows(db: DbSnapshot, prefs: ViewPrefs, users: OcUser[]): DbRow[] {
  let rows = db.rows.slice();
  for (const flt of filtersOf(db, prefs)) {
    rows = rows.filter((r) => {
      const v = r.v[flt.f];
      if (Array.isArray(v)) return v.length ? v.some((x) => flt.vals.includes(x)) : flt.vals.includes("");
      return flt.vals.includes(v == null ? "" : String(v));
    });
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
