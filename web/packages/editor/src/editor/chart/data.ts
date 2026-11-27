// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-06 (frame 4h): the linked chart block's data. A chart reads a sheet range (the computed
// values, as the grid shows them) or a database grouped by one field with an aggregate. These
// rules are mirrored in Rust for exports (crates/oc-model/src/chart.rs); keep them equal.

export type ChartKind = "bar" | "line" | "area" | "pie" | "donut" | "scatter";
export const CHART_KINDS: ChartKind[] = ["bar", "line", "area", "pie", "donut", "scatter"];
export const KIND_LABEL: Record<ChartKind, string> = { bar: "Column", line: "Line", area: "Area", pie: "Pie", donut: "Donut", scatter: "Scatter" };

export type Agg = "count" | "sum" | "avg" | "min" | "max";
export const AGGS: Agg[] = ["count", "sum", "avg", "min", "max"];
export const AGG_LABEL: Record<Agg, string> = { count: "Count", sum: "Sum", avg: "Average", min: "Min", max: "Max" };

export interface Series {
  name: string;
  values: (number | null)[];
}
export interface ChartData {
  /** The category column's header ("" when the range has none). */
  catLabel: string;
  categories: string[];
  series: Series[];
}

/** The node's attributes (all flat strings, so they sync and validate simply). */
export interface ChartAttrs {
  kind: ChartKind;
  title: string;
  /** "sheet" | "db" | "" (not set up yet). */
  src: string;
  sheetId: string;
  sheet: string;
  r0: string;
  r1: string;
  c0: string;
  c1: string;
  dbId: string;
  groupBy: string;
  agg: Agg;
  field: string;
  xLabel: string;
  yLabel: string;
  legend: boolean;
}

const NUM = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/** A display text as a number: currency signs, spaces, thousands commas and % are ignored; (n) is negative. */
export function parseNum(text: string): number | null {
  let t = (text ?? "").trim();
  if (!t) return null;
  let neg = false;
  if (t.startsWith("(") && t.endsWith(")")) {
    neg = true;
    t = t.slice(1, -1);
  }
  t = t.replace(/[€$£¥\s,%]/g, "");
  if (!NUM.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

const isText = (t: string | undefined) => !!t && t.trim() !== "" && parseNum(t) === null;

/**
 * A range's display texts as chart data. Row 0 is a header when it has text and no numbers; the
 * first column holds categories when it has text below the header (and there is another column);
 * otherwise rows are numbered and every column is a series. Rows with no category and no value
 * are left out.
 */
export function fromGrid(g: string[][]): ChartData {
  const rows = g.filter((r) => r.length);
  const w = Math.max(0, ...rows.map((r) => r.length));
  const r0 = rows[0] ?? [];
  const header = rows.length > 1 && r0.some((t) => t?.trim()) && r0.every((t) => !t?.trim() || isText(t));
  const body = header ? rows.slice(1) : rows;
  const catCol = w > 1 && body.some((r) => isText(r[0]));
  const first = catCol ? 1 : 0;
  const series: Series[] = [];
  for (let j = first; j < w; j++) series.push({ name: (header && r0[j]?.trim()) || `Series ${series.length + 1}`, values: [] });
  const categories: string[] = [];
  for (const r of body) {
    const vals = series.map((_, k) => parseNum(r[first + k] ?? ""));
    const cat = catCol ? (r[0] ?? "").trim() : "";
    if (!cat && vals.every((v) => v === null)) continue;
    categories.push(catCol ? cat : String(categories.length + 1));
    vals.forEach((v, k) => series[k].values.push(v));
  }
  return { catLabel: header && catCol ? (r0[0] ?? "").trim() : "", categories, series };
}

/** Records grouped by a key (first-seen order, "" as "(empty)") with one aggregate per group. */
export function fromGroups(items: { key: string; value: number | null }[], agg: Agg, fieldName: string): ChartData {
  const groups = new Map<string, (number | null)[]>();
  for (const it of items) {
    const k = it.key.trim() || "(empty)";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(it.value);
  }
  const values = [...groups.values()].map((vs) => {
    if (agg === "count") return vs.length;
    const ns = vs.filter((v): v is number => v !== null);
    if (!ns.length) return null;
    if (agg === "sum") return ns.reduce((a, b) => a + b, 0);
    if (agg === "avg") return ns.reduce((a, b) => a + b, 0) / ns.length;
    return agg === "min" ? Math.min(...ns) : Math.max(...ns);
  });
  const name = agg === "count" ? "Count" : `${AGG_LABEL[agg]} of ${fieldName || "value"}`;
  return { catLabel: "", categories: [...groups.keys()], series: [{ name, values }] };
}

/** A value as the data table and exports write it. */
export const fmtNum = (v: number | null) => (v === null ? "" : String(Number.isInteger(v) ? v : Math.round(v * 1e10) / 1e10));

/** Header + rows: the accessible data table and the exports' table. */
export function toTable(d: ChartData): string[][] {
  return [[d.catLabel || "Category", ...d.series.map((s) => s.name)], ...d.categories.map((c, i) => [c, ...d.series.map((s) => fmtNum(s.values[i]))])];
}

/** A1 ("B2:C10", "AA1") as 0-based indices, corners in any order. */
export function a1Range(t: string): { r0: number; c0: number; r1: number; c1: number } | null {
  const m = /^\s*\$?([A-Za-z]{1,3})\$?(\d{1,7})(?:\s*:\s*\$?([A-Za-z]{1,3})\$?(\d{1,7}))?\s*$/.exec(t);
  if (!m) return null;
  const col = (s: string) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const a = { r: Number(m[2]) - 1, c: col(m[1]) };
  const b = m[3] ? { r: Number(m[4]) - 1, c: col(m[3]) } : a;
  if (a.r < 0 || b.r < 0) return null;
  return { r0: Math.min(a.r, b.r), c0: Math.min(a.c, b.c), r1: Math.max(a.r, b.r), c1: Math.max(a.c, b.c) };
}

export function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export const rangeA1 = (r0: number, c0: number, r1: number, c1: number) => `${colName(c0)}${r0 + 1}${r0 === r1 && c0 === c1 ? "" : `:${colName(c1)}${r1 + 1}`}`;

/** About five round ticks covering [min, max], always including 0's side. */
export function niceTicks(min: number, max: number, n = 5): number[] {
  let lo = Math.min(0, min);
  let hi = Math.max(0, max);
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / n;
  const e = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / e;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e;
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/** A compact label: 6.6k, 1.3M. */
export function short(v: number): string {
  const a = Math.abs(v);
  const f = (x: number, u: string) => x.toFixed(1).replace(/\.0$/, "") + u;
  if (a >= 1e9) return f(v / 1e9, "B");
  if (a >= 1e6) return f(v / 1e6, "M");
  if (a >= 1e3) return f(v / 1e3, "k");
  return String(Math.round(v * 100) / 100);
}
