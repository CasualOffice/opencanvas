import type { OcUser } from "@opencanvas/ui";
import { cellToText, personName } from "./model";
import type { DbField, DbOption, DbRow, DbSnapshot, ViewPrefs } from "./types";

export const optOf = (f: DbField | undefined, v: unknown): DbOption | undefined => (f?.options ?? []).find((o) => o.v === v);
export const groupField = (db: DbSnapshot) => db.fields.find((f) => f.type === "status") ?? db.fields.find((f) => f.type === "select");
export const dateField = (db: DbSnapshot) => db.fields.find((f) => f.type === "date");
export const titleField = (db: DbSnapshot) => db.fields.find((f) => f.type === "title") ?? db.fields[0];

/** Apply a view's filter, search and sort. Returns a new array. */
export function visibleRows(db: DbSnapshot, prefs: ViewPrefs, users: OcUser[]): DbRow[] {
  let rows = db.rows.slice();
  const flt = prefs.filter;
  if (flt && flt.vals.length && db.fields.some((f) => f.id === flt.f)) {
    rows = rows.filter((r) => {
      const v = r.v[flt.f];
      if (Array.isArray(v)) return v.some((x) => flt.vals.includes(x));
      return flt.vals.includes(v == null ? "" : String(v));
    });
  }
  const q = (prefs.q ?? "").trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) => db.fields.some((f) => cellToText(f, r.v[f.id], users).toLowerCase().includes(q)) || (db.notes[r.id] ?? "").toLowerCase().includes(q));
  }
  const s = prefs.sort;
  const f = s && db.fields.find((x) => x.id === s.f);
  if (s && f) {
    const key = (r: DbRow): string | number | null => {
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
    const keyed = rows.map((r, i) => ({ r, k: key(r), i }));
    keyed.sort((a, b) => {
      if (a.k === null && b.k === null) return a.i - b.i;
      if (a.k === null) return 1;
      if (b.k === null) return -1;
      const c = typeof a.k === "number" && typeof b.k === "number" ? a.k - b.k : String(a.k).localeCompare(String(b.k), undefined, { numeric: true });
      return c === 0 ? a.i - b.i : c * s.dir;
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
export function defaultMonth(db: DbSnapshot, now = new Date()): string {
  const df = dateField(db);
  const cur = isoMonth(now);
  if (!df) return cur;
  const dates = db.rows.map((r) => r.v[df.id]).filter((v): v is string => typeof v === "string" && /^\d{4}-\d{2}/.test(v));
  if (!dates.length || dates.some((d) => d.startsWith(cur))) return cur;
  const today = isoDate(now);
  dates.sort((a, b) => Math.abs(Date.parse(a) - Date.parse(today)) - Math.abs(Date.parse(b) - Date.parse(today)));
  return dates[0].slice(0, 7);
}
