// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-06 (frame 4h): the linked chart block. Plain SVG, loaded on demand (not in the editor's
// initial JS). It reads a sheet range (values computed by the sheet engine) or a database grouped
// by a field, and redraws when either changes, here or from someone else. The data table under
// it is the accessible fallback (always there for screen readers; shown with the table button).
import { useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import type * as Y from "yjs";
import { ChartArea, ChartColumn, ChartLine, ChartPie, ChartScatter, Donut, Pencil, Table2, type LucideIcon } from "lucide-react";
import type { BlockEnv } from "@opencanvas/ui";
import type * as SheetMod from "@opencanvas/sheet";
import type * as DbMod from "@opencanvas/database";
import { loadDatabase, loadSheet } from "../blockdata";
import { AGGS, AGG_LABEL, CHART_KINDS, KIND_LABEL, a1Range, fmtNum, fromGrid, fromGroups, niceTicks, parseNum, rangeA1, short, toTable, type Agg, type ChartAttrs, type ChartData, type ChartKind } from "./data";
import { injectChartCss } from "./styles";
import { blockOf, type PartHeader } from "../../lib/parts";

const KIND_ICON: Record<ChartKind, LucideIcon> = { bar: ChartColumn, line: ChartLine, area: ChartArea, pie: ChartPie, donut: Donut, scatter: ChartScatter };
const COLORS = ["var(--u0)", "var(--u1)", "var(--u2)", "var(--u3)", "var(--u4)", "var(--amber-fg)", "var(--green-fg)", "var(--red-fg)"];
const color = (i: number) => COLORS[i % COLORS.length];

interface Props {
  attrs: ChartAttrs;
  set: (patch: Partial<ChartAttrs>) => void;
  /** The room's document (`sheets` root, the databases that are not parts). */
  doc: Y.Doc;
  /** The document holding the chart's database (a part under partial sync), when known. */
  dbDoc: Y.Doc | null;
  /** The document holding the chart's spreadsheet (its part under partial sync; `null` while
   *  it loads). */
  sheetDoc?: Y.Doc | null;
  /** The room's parts list (split rooms): databases and spreadsheets not in `doc`. */
  parts?: PartHeader[];
  env: BlockEnv;
}

interface Mods {
  sheet: typeof SheetMod;
  db: typeof DbMod;
  engine: SheetMod.SheetEngine | null;
}

/** Loads the sheet and database modules (and the sheet engine) once. */
function useMods(): Mods | null {
  const [m, setM] = useState<Mods | null>(null);
  useEffect(() => {
    let off = false;
    void Promise.all([loadSheet(), loadDatabase()]).then(async ([sheet, db]) => {
      const engine = await sheet.loadSheetEngine().catch(() => null);
      if (!off) setM({ sheet, db, engine });
    });
    return () => void (off = true);
  }, []);
  return m;
}

/** Redraws (once per frame) when the sheets or the databases change. */
function useLive(doc: Y.Doc, dbDoc: Y.Doc | null, sheetDoc: Y.Doc | null) {
  const [v, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let raf = 0;
    const kick = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => ((raf = 0), bump()));
    };
    const roots = [doc.getMap("sheets"), doc.getMap("databases"), ...(dbDoc && dbDoc !== doc ? [dbDoc.getMap("databases")] : []), ...(sheetDoc && sheetDoc !== doc ? [sheetDoc.getMap("sheets")] : [])];
    roots.forEach((r) => r.observeDeep(kick));
    return () => {
      roots.forEach((r) => r.unobserveDeep(kick));
      cancelAnimationFrame(raf);
    };
  }, [doc, dbDoc, sheetDoc]);
  return v;
}

interface Read {
  data: ChartData | null;
  /** Why there is nothing to draw. */
  why?: string;
  /** For the panel: the range as A1 and the database's fields. */
  a1?: string;
  fields?: DbMod.DbField[];
  dbName?: string;
}

function readSheet(m: Mods, doc: Y.Doc, a: ChartAttrs): Read {
  const sheets = m.sheet.readSheets(doc, a.sheetId);
  const s = sheets.find((x) => x.id === a.sheet);
  if (!s) return { data: null, why: "The spreadsheet this chart reads was deleted." };
  const ri = [s.rows.indexOf(a.r0), s.rows.indexOf(a.r1)];
  const ci = [s.cols.indexOf(a.c0), s.cols.indexOf(a.c1)];
  if (ri.includes(-1) || ci.includes(-1)) return { data: null, why: "The range this chart reads was deleted. Pick a new one." };
  const [r0, r1] = [Math.min(...ri), Math.max(...ri)];
  const [c0, c1] = [Math.min(...ci), Math.max(...ci)];
  const shown = new Map<string, string>();
  try {
    if (m.engine) for (const [sid, r, c, t] of m.engine.compute(sheets)) if (sid === s.id) shown.set(`${r}:${c}`, t);
  } catch {
    /* a broken workbook shows its inputs */
  }
  const text = (r: string, c: string) => shown.get(`${r}:${c}`) ?? (s.cells[`${r}:${c}`]?.startsWith("=") ? "" : (s.cells[`${r}:${c}`] ?? ""));
  const grid: string[][] = [];
  for (let r = r0; r <= r1; r++) grid.push(Array.from({ length: c1 - c0 + 1 }, (_, j) => text(s.rows[r], s.cols[c0 + j])));
  return { data: fromGrid(grid), a1: rangeA1(r0, c0, r1, c1) };
}

function readDbData(m: Mods, dbDoc: Y.Doc, a: ChartAttrs, users: BlockEnv["users"]): Read {
  const map = m.db.getDbMap(dbDoc, a.dbId);
  if (!map) return { data: null, why: "The database this chart reads was deleted." };
  const db = m.db.readDb(a.dbId, map);
  const g = db.fields.find((f) => f.id === a.groupBy);
  const vf = db.fields.find((f) => f.id === a.field);
  const agg: Agg = AGGS.includes(a.agg) ? a.agg : "count";
  if (!g) return { data: null, why: "Pick a field to group by.", fields: db.fields, dbName: db.name };
  const items = db.rows.map((r) => {
    const v = vf ? r.v[vf.id] : null;
    return { key: m.db.cellToText(g, r.v[g.id], users), value: typeof v === "number" ? v : parseNum(String(v ?? "")) };
  });
  const data = fromGroups(items, agg === "count" || vf ? agg : "count", vf?.name ?? "");
  return { data: { ...data, catLabel: g.name }, fields: db.fields, dbName: db.name };
}

/** The title shown (and exported): the chart's own, else "Total by Category", else the database. */
export function autoTitle(a: ChartAttrs, r: Read): string {
  if (a.title.trim()) return a.title.trim();
  const d = r.data;
  if (d?.catLabel && d.series.length === 1) return `${d.series[0].name} by ${d.catLabel}`;
  return r.dbName || "Chart";
}

export function ChartBlock({ attrs: a, set, doc, dbDoc, sheetDoc = doc, parts, env }: Props) {
  injectChartCss();
  const mods = useMods();
  const v = useLive(doc, dbDoc, sheetDoc);
  const canEdit = env.role === "edit";
  const [editing, setEditing] = useState(!a.src && canEdit);
  const [showTable, setShowTable] = useState(false);
  const read: Read = useMemo(() => {
    if (!mods) return { data: null, why: "Loading…" };
    if (a.src === "sheet") return sheetDoc ? readSheet(mods, sheetDoc, a) : { data: null, why: "Loading…" };
    if (a.src === "db") return readDbData(mods, dbDoc ?? doc, a, [env.me, ...env.users]);
    return { data: null, why: canEdit ? "Choose the data to chart." : "This chart has no data yet." };
  }, [mods, v, a, doc, dbDoc, sheetDoc, env.me, env.users, canEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  // A spreadsheet picked before its part was loaded: the first rows and columns once it is.
  useEffect(() => {
    if (!canEdit || a.src !== "sheet" || a.r0 || !mods || !sheetDoc) return;
    const s = mods.sheet.readSheets(sheetDoc, a.sheetId).find((x) => x.id === a.sheet);
    if (s?.rows.length && s.cols.length) set(defaultRange(s));
  }, [canEdit, a.src, a.r0, a.sheetId, a.sheet, mods, sheetDoc, v]); // eslint-disable-line react-hooks/exhaustive-deps

  // A database chart starts grouped by its first status or select field (else its title).
  useEffect(() => {
    if (!canEdit || a.src !== "db" || a.groupBy || !read.fields?.length) return;
    const f = read.fields.find((x) => x.type === "status" || x.type === "select") ?? read.fields.find((x) => x.type === "title") ?? read.fields[0];
    set({ groupBy: f.id });
  }, [canEdit, a.src, a.groupBy, read.fields]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = autoTitle(a, read);
  const d = read.data;
  const empty = !d || !d.categories.length || !d.series.length;
  const table = d ? toTable(d) : null;
  const kindLabel = KIND_LABEL[a.kind] ?? "Column";
  return (
    <div className="occh" role="figure" aria-label={`${title}, ${kindLabel.toLowerCase()} chart`} data-chart-kind={a.kind}>
      <div className="occh-hd">
        <b>{title}</b>
        <span className="occh-sub">{read.a1 ? `· ${read.a1}` : read.dbName ? `· ${read.dbName}` : ""}</span>
        <span className="occh-grow" />
        <button className="occh-ib" aria-label="Show data table" title="Data table" aria-pressed={showTable} onClick={() => setShowTable(!showTable)}>
          <Table2 size={15} />
        </button>
        {canEdit ? (
          <button className="occh-ib" aria-label="Edit chart" title="Edit chart" aria-pressed={editing} onClick={() => setEditing(!editing)}>
            <Pencil size={15} />
          </button>
        ) : null}
      </div>
      <div className="occh-body">
        <div className="occh-plot">
          {empty ? <div className="occh-empty">{read.why ?? "No numbers in this range yet."}</div> : <Plot d={d!} a={a} />}
          {!empty && (a.legend || a.kind === "pie" || a.kind === "donut") ? <Legend d={d!} a={a} /> : null}
          {table && !empty ? (
            <div className={showTable ? "occh-tbl" : "occh-sr"}>
              <table>
                <caption>{`Data for ${title}`}</caption>
                <thead>
                  <tr>{table[0].map((h, i) => <th key={i} scope="col">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {table.slice(1).map((r, i) => (
                    <tr key={i}>{r.map((c, j) => (j ? <td key={j}>{c}</td> : <th key={j} scope="row">{c}</th>))}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
        {editing && canEdit ? <Panel a={a} set={set} read={read} doc={doc} sheetDoc={sheetDoc} parts={parts} mods={mods} done={() => setEditing(false)} /> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ drawing */

const W = 560;
const H = 260;

function Plot({ d, a }: { d: ChartData; a: ChartAttrs }) {
  if (a.kind === "pie" || a.kind === "donut") return <Pie d={d} donut={a.kind === "donut"} />;
  const scatter = a.kind === "scatter";
  // Scatter: categories that are numbers are x; numbered rows with 2+ series use the first as x.
  const indexCats = d.categories.every((c, i) => c === String(i + 1));
  const xs = scatter ? (indexCats && d.series.length > 1 ? d.series[0].values : d.categories.map((c, i) => parseNum(c) ?? i + 1)) : null;
  const ys = scatter && indexCats && d.series.length > 1 ? d.series.slice(1) : d.series;
  const all = ys.flatMap((s) => s.values).filter((x): x is number => x !== null);
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const L = 48;
  const R = 12;
  const T = 18;
  const B = a.xLabel ? 50 : 34;
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const y = (v: number) => T + (H - T - B) * (1 - (v - lo) / (hi - lo || 1));
  const n = d.categories.length;
  const band = (W - L - R) / Math.max(1, n);
  const cx = (i: number) => L + band * (i + 0.5);
  let xScale: ((v: number) => number) | null = null;
  let xTicks: number[] = [];
  if (xs) {
    const xv = xs.filter((x): x is number => x !== null);
    xTicks = niceTicks(Math.min(...xv), Math.max(...xv));
    const x0 = xTicks[0];
    const x1 = xTicks[xTicks.length - 1];
    xScale = (v: number) => L + (W - L - R) * ((v - x0) / (x1 - x0 || 1));
  }
  const out: ReactNode[] = [];
  ticks.forEach((t) => {
    out.push(<line key={`g${t}`} x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--line-2)" : "var(--line)"} />);
    out.push(<text key={`t${t}`} x={L - 6} y={y(t) + 4} textAnchor="end">{short(t)}</text>);
  });
  const lab = (s: string) => (s.length > 12 ? s.slice(0, 11) + "…" : s);
  const every = Math.max(1, Math.ceil(n / 12));
  if (xScale) xTicks.forEach((t) => out.push(<text key={`x${t}`} x={xScale!(t)} y={H - B + 16} textAnchor="middle">{short(t)}</text>));
  else d.categories.forEach((c, i) => i % every === 0 && out.push(<text key={`c${i}`} x={cx(i)} y={H - B + 16} textAnchor="middle">{lab(c)}</text>));
  if (a.kind === "bar") {
    const k = ys.length;
    const bw = Math.min(42, (band * 0.72) / k);
    ys.forEach((s, si) =>
      s.values.forEach((val, i) => {
        if (val === null) return;
        const x = cx(i) - (bw * k) / 2 + bw * si;
        const top = y(Math.max(0, val));
        const h = Math.abs(y(val) - y(0));
        out.push(<rect key={`b${si}-${i}`} x={x} y={top} width={Math.max(1, bw - 2)} height={Math.max(0.5, h)} rx={3} fill={color(si)} />);
        if (k === 1 && n <= 12) out.push(<text key={`v${i}`} className="v" x={x + (bw - 2) / 2} y={val >= 0 ? top - 5 : top + h + 12} textAnchor="middle">{short(val)}</text>);
      }),
    );
  } else if (a.kind === "line" || a.kind === "area") {
    ys.forEach((s, si) => {
      const pts = s.values.map((val, i) => (val === null ? null : ([cx(i), y(val)] as const)));
      const segs: (readonly [number, number])[][] = [[]];
      pts.forEach((p) => (p ? segs[segs.length - 1].push(p) : segs.push([])));
      segs.filter((g) => g.length).forEach((g, gi) => {
        const path = g.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
        if (a.kind === "area") out.push(<path key={`a${si}-${gi}`} d={`${path}L${g[g.length - 1][0].toFixed(1)},${y(0)}L${g[0][0].toFixed(1)},${y(0)}Z`} fill={color(si)} opacity={0.18} />);
        out.push(<path key={`l${si}-${gi}`} d={path} fill="none" stroke={color(si)} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />);
      });
      pts.forEach((p, i) => p && n <= 40 && out.push(<circle key={`p${si}-${i}`} cx={p[0]} cy={p[1]} r={3} fill="var(--app)" stroke={color(si)} strokeWidth={2} />));
    });
  } else if (xScale && xs) {
    ys.forEach((s, si) => s.values.forEach((val, i) => val !== null && xs[i] !== null && out.push(<circle key={`s${si}-${i}`} cx={xScale!(xs[i]!)} cy={y(val)} r={4} fill={color(si)} opacity={0.85} />)));
  }
  if (a.xLabel) out.push(<text key="xl" className="ax" x={L + (W - L - R) / 2} y={H - 6} textAnchor="middle">{a.xLabel}</text>);
  if (a.yLabel) out.push(<text key="yl" className="ax" transform={`translate(12 ${T + (H - T - B) / 2}) rotate(-90)`} textAnchor="middle">{a.yLabel}</text>);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
      {out}
    </svg>
  );
}

function Pie({ d, donut }: { d: ChartData; donut: boolean }) {
  const vals = (d.series[0]?.values ?? []).map((x) => (x !== null && x > 0 ? x : 0));
  const total = vals.reduce((p, q) => p + q, 0);
  const cx = W / 2;
  const cy = H / 2;
  const r = H / 2 - 12;
  const ri = donut ? r * 0.6 : 0;
  let ang = -Math.PI / 2;
  const pt = (rad: number, t: number) => `${(cx + rad * Math.cos(t)).toFixed(2)},${(cy + rad * Math.sin(t)).toFixed(2)}`;
  const slices = vals.map((val, i) => {
    if (!total || !val) return null;
    const a0 = ang;
    const a1 = (ang += (val / total) * Math.PI * 2);
    const big = a1 - a0 > Math.PI ? 1 : 0;
    if (val === total) return <circle key={i} cx={cx} cy={cy} r={(r + ri) / 2} fill="none" stroke={color(i)} strokeWidth={r - ri} />;
    const dd = `M${pt(r, a0)}A${r},${r} 0 ${big} 1 ${pt(r, a1)}` + (ri ? `L${pt(ri, a1)}A${ri},${ri} 0 ${big} 0 ${pt(ri, a0)}Z` : `L${cx},${cy}Z`);
    return <path key={i} d={dd} fill={color(i)} stroke="var(--app)" strokeWidth={1.5} />;
  });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
      {total ? slices : <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--line-2)" />}
      {donut && total ? <text className="v" x={cx} y={cy + 4} textAnchor="middle">{short(total)}</text> : null}
    </svg>
  );
}

function Legend({ d, a }: { d: ChartData; a: ChartAttrs }) {
  if (a.kind === "pie" || a.kind === "donut") {
    const vals = d.series[0]?.values ?? [];
    const total = vals.reduce<number>((p, q) => p + (q && q > 0 ? q : 0), 0);
    return (
      <ul className="occh-leg" aria-hidden="true">
        {d.categories.map((c, i) => (
          <li key={i}>
            <i style={{ background: color(i) }} />
            {c} · {fmtNum(vals[i] ?? null)}
            {total && vals[i] ? ` (${Math.round(((vals[i] ?? 0) / total) * 100)}%)` : ""}
          </li>
        ))}
      </ul>
    );
  }
  const scatterX = a.kind === "scatter" && d.categories.every((c, i) => c === String(i + 1)) && d.series.length > 1;
  return (
    <ul className="occh-leg" aria-hidden="true">
      {(scatterX ? d.series.slice(1) : d.series).map((s, i) => (
        <li key={i}>
          <i style={{ background: color(i) }} />
          {s.name}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ side panel */

/** The first rows and columns of a sheet: what a chart of it starts with. */
const defaultRange = (s: { rows: string[]; cols: string[] }) => ({ r0: s.rows[0], r1: s.rows[Math.min(5, s.rows.length - 1)], c0: s.cols[0], c1: s.cols[Math.min(1, s.cols.length - 1)] });

function Panel({ a, set, read, doc, sheetDoc, parts, mods, done }: { a: ChartAttrs; set: (p: Partial<ChartAttrs>) => void; read: Read; doc: Y.Doc; sheetDoc: Y.Doc | null; parts?: PartHeader[]; mods: Mods | null; done: () => void }) {
  const [range, setRange] = useState(read.a1 ?? "");
  const [bad, setBad] = useState(false);
  useEffect(() => setRange(read.a1 ?? ""), [read.a1]);
  // Sources: each sheet of each spreadsheet, and each database in this canvas: those in the
  // room's document and, in a split room, those the parts list names (not loaded here).
  const sources = useMemo(() => {
    const out: { v: string; label: string }[] = [];
    if (mods) {
      let n = 0;
      doc.getMap("sheets").forEach((_, block) => {
        n++;
        for (const s of mods.sheet.readSheets(doc, block)) out.push({ v: `sheet:${block}:${s.id}`, label: `Spreadsheet ${n} · ${s.name}` });
      });
      for (const h of parts ?? []) {
        if (h.kind !== "sheet") continue;
        n++;
        for (const t of h.tabs ?? []) out.push({ v: `sheet:${blockOf(h.id)}:${t.id}`, label: `Spreadsheet ${n} · ${t.name ?? ""}` });
      }
      doc.getMap("databases").forEach((m, id) => out.push({ v: `db:${id}`, label: `Database · ${String((m as Y.Map<unknown>).get?.("name") ?? "") || "Untitled"}` }));
      for (const h of parts ?? []) if (h.kind === "database") out.push({ v: `db:${blockOf(h.id)}`, label: `Database · ${h.name || "Untitled"}` });
      if (a.src === "db" && !out.some((o) => o.v === `db:${a.dbId}`)) out.push({ v: `db:${a.dbId}`, label: `Database · ${read.dbName || "Untitled"}` });
    }
    return out;
  }, [mods, doc, parts, a.src, a.dbId, read.dbName]);
  const cur = a.src === "sheet" ? `sheet:${a.sheetId}:${a.sheet}` : a.src === "db" ? `db:${a.dbId}` : "";
  const pick = (val: string) => {
    const [k, x, y] = val.split(":");
    if (k === "db") return set({ src: "db", dbId: x, groupBy: "", field: "", agg: "count" });
    if (k !== "sheet" || !mods) return;
    // A spreadsheet in its own part (not loaded here): the range is set once it loads.
    const here = x === a.sheetId && sheetDoc ? sheetDoc : doc;
    const s = mods.sheet.readSheets(here, x).find((q) => q.id === y);
    if (!s) return set({ src: "sheet", sheetId: x, sheet: y, r0: "", r1: "", c0: "", c1: "" });
    set({ src: "sheet", sheetId: x, sheet: y, ...defaultRange(s) });
  };
  const commitRange = () => {
    const q = a1Range(range);
    const s = sheetDoc ? mods?.sheet.readSheets(sheetDoc, a.sheetId).find((x) => x.id === a.sheet) : undefined;
    if (!q || !s || q.r1 >= s.rows.length || q.c1 >= s.cols.length) return setBad(true);
    setBad(false);
    set({ r0: s.rows[q.r0], r1: s.rows[q.r1], c0: s.cols[q.c0], c1: s.cols[q.c1] });
  };
  const nums = (read.fields ?? []).filter((f) => f.type === "number" || f.type === "progress" || f.type === "formula" || f.type === "rollup");
  return (
    <div className="occh-panel" role="group" aria-label="Chart settings">
      <h3>Chart type</h3>
      <div className="occh-kinds">
        {CHART_KINDS.map((k) => {
          const I = KIND_ICON[k];
          return (
            <button key={k} aria-label={KIND_LABEL[k]} title={KIND_LABEL[k]} aria-pressed={a.kind === k} onClick={() => set({ kind: k })}>
              <I size={16} />
            </button>
          );
        })}
      </div>
      <label>
        Data
        <select value={cur} onChange={(e) => pick(e.target.value)}>
          {!cur ? <option value="">Choose…</option> : null}
          {sources.map((s) => (
            <option key={s.v} value={s.v}>{s.label}</option>
          ))}
        </select>
      </label>
      {a.src === "sheet" ? (
        <label>
          Range
          <input type="text" value={range} aria-invalid={bad} onChange={(e) => setRange(e.target.value)} onBlur={commitRange} onKeyDown={(e) => e.key === "Enter" && commitRange()} placeholder="A1:B6" />
          {bad ? <span className="occh-err">Use a range like A1:B6 inside the sheet.</span> : null}
        </label>
      ) : null}
      {a.src === "db" ? (
        <>
          <label>
            Group by
            <select value={a.groupBy} onChange={(e) => set({ groupBy: e.target.value })}>
              {(read.fields ?? []).map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </label>
          <div className="occh-row2">
            <label>
              Value
              <select value={a.agg} onChange={(e) => set({ agg: e.target.value as Agg })}>
                {AGGS.map((g) => (
                  <option key={g} value={g}>{AGG_LABEL[g]}</option>
                ))}
              </select>
            </label>
            {a.agg !== "count" ? (
              <label>
                Of
                <select value={a.field} onChange={(e) => set({ field: e.target.value })}>
                  <option value="">Choose…</option>
                  {nums.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </>
      ) : null}
      <label>
        Title
        <input type="text" value={a.title} placeholder={autoTitle({ ...a, title: "" }, read)} onChange={(e) => set({ title: e.target.value })} />
      </label>
      <div className="occh-row2">
        <label>
          X axis label
          <input type="text" value={a.xLabel} onChange={(e) => set({ xLabel: e.target.value })} />
        </label>
        <label>
          Y axis label
          <input type="text" value={a.yLabel} onChange={(e) => set({ yLabel: e.target.value })} />
        </label>
      </div>
      <label className="chk">
        <input type="checkbox" checked={a.legend} onChange={(e) => set({ legend: e.target.checked })} />
        Legend
      </label>
      <button className="occh-done" onClick={done}>Done</button>
    </div>
  );
}
