// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Timeline (Gantt) and Workload views of a database (DB5-01, prototype
// docs/prototypes/v04-approved/timeline.html, frames 1-7). Both are views of the same rows, so
// filters, sorts and live editing work as in Table and Board. Dates live in the row's own date
// fields; dependencies are a "Blocked by" relation from the database to itself.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Y from "yjs";
import { CalendarDays, Diamond, Link2, Plus, Route, TriangleAlert, Users } from "lucide-react";
import type { BlockEnv, OcUser } from "@opencanvas/ui";
import { addField, deleteRow, getDbMap, readDb, setCell, setPrefs, tx } from "../model";
import { addRelation, setRelation } from "../formula/model";
import type { CellValue, DbField, DbRow, DbSnapshot, ViewKind, ViewPrefs } from "../types";
import { Avatar, Ic, Pop, type Anchor } from "../ui";
import {
  addDays,
  band,
  barLabel,
  byWeek,
  conflicts,
  criticalPath,
  DAY_REM,
  day,
  diffDays,
  edges,
  firstOfMonth,
  isWeekend,
  iso,
  monthName,
  monthOf,
  resolve,
  shiftPlan,
  short,
  spanDays,
  spanOf,
  titleOf,
  today,
  weekStart,
  workload,
  type Span,
  type TimelinePrefs,
  type Zoom,
} from "./logic";
import { ensureTimelineStyles } from "./styles";

/** What the views need from the database block (a subset of its context). */
export interface TlCtx {
  doc: Y.Doc;
  db: DbSnapshot;
  env: BlockEnv;
  edit: boolean;
  compact: boolean;
  rows: DbRow[];
  prefs: ViewPrefs;
  view: ViewKind;
  people: { resolve: (id: unknown) => OcUser | null; pickable: OcUser[] };
  setPeek: (rid: string | null) => void;
  um?: Y.UndoManager | null;
}

const ZOOMS: [Zoom, string][] = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["quarter", "Quarter"]];
const ROW_H = 2.25;
const GRP_H = 2;
const HEAD_H = 3;

function tlPrefs(ctx: TlCtx): TimelinePrefs {
  // The Workload reads the Timeline's date settings, and keeps its own capacity and estimate.
  const t = (ctx.db.views["timeline"]?.tl ?? {}) as TimelinePrefs;
  const own = (ctx.prefs.tl ?? {}) as TimelinePrefs;
  return ctx.view === "workload" ? { ...t, ...own } : own;
}
const patchTl = (ctx: TlCtx, patch: Partial<TimelinePrefs>) => setPrefs(ctx.doc, ctx.db.id, ctx.view, { tl: { ...((ctx.prefs.tl ?? {}) as TimelinePrefs), ...patch } });

const optTone = (f: DbField | undefined, v: CellValue | undefined) => (f && typeof v === "string" ? f.options?.find((o) => o.v === v)?.c : undefined) ?? "blue";
const relIds = (v: CellValue | undefined) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Writes a span's dates (end, or duration in working days) in one transaction. */
function writeSpan(ctx: TlCtx, p: TimelinePrefs, id: string, s: number, e: number) {
  const { doc, db } = ctx;
  tx(doc, db.id, () => {
    if (p.start) setCell(doc, db.id, id, p.start, iso(s));
    if (p.end) setCell(doc, db.id, id, p.end, iso(e));
    else if (p.dur) setCell(doc, db.id, id, p.dur, spanDays(s, e, p.work ?? true));
  });
}

/** Creates "Blocked by" (and its reverse, "Blocks") on demand (frame 3a). */
export function addDependencyField(ctx: TlCtx): string {
  const fid = addField(ctx.doc, ctx.db.id, "text", "Blocked by");
  addRelation(ctx.doc, ctx.db.id, fid, ctx.db.id, { two: true, backName: "Blocks" });
  setPrefs(ctx.doc, ctx.db.id, "timeline", { tl: { ...((ctx.db.views["timeline"]?.tl ?? {}) as TimelinePrefs), dep: fid } });
  return fid;
}

/* ================================================================ Timeline */

export function TimelineView({ ctx }: { ctx: TlCtx }) {
  ensureTimelineStyles();
  const { db, doc, edit, env } = ctx;
  const p = useMemo(() => resolve(db, tlPrefs(ctx)), [db, ctx.prefs]); // eslint-disable-line react-hooks/exhaustive-deps
  const [say, setSay] = useState("");
  const [warn, setWarn] = useState<{ moved: string; text: string; days: number; ids: string[] } | null>(null);
  const [menu, setMenu] = useState<{ anchor: Anchor; id: string } | null>(null);
  const [pick, setPick] = useState<{ anchor: Anchor; id: string } | null>(null);
  const [live, setLive] = useState<Span | null>(null);
  const [link, setLink] = useState<{ from: string; x: number; y: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const work = p.work;
  const zoom = p.zoom;
  const dr = DAY_REM[zoom];
  const depF = db.fields.find((f) => f.id === p.dep);
  const colorF = db.fields.find((f) => f.id === p.color);
  const whoF = db.fields.find((f) => f.id === p.who);
  const groupF = db.fields.find((f) => f.id === p.group);

  const spans = useMemo(() => {
    const m = new Map<string, Span>();
    for (const r of ctx.rows) {
      const sp = spanOf(r, p);
      if (sp) m.set(r.id, sp);
    }
    if (live) m.set(live.id, live);
    return m;
  }, [ctx.rows, p, live]);
  const es = useMemo(() => edges(ctx.rows, p.dep), [ctx.rows, p.dep]);
  const bad = useMemo(() => new Set(conflicts(spans, es).map(([a, b]) => `${a}>${b}`)), [spans, es]);
  const crit = useMemo(() => (p.crit ? criticalPath(spans, es, work) : new Set<string>()), [p.crit, spans, es, work]);
  const byId = useMemo(() => new Map(ctx.rows.map((r) => [r.id, r])), [ctx.rows]);
  const title = (id: string) => (byId.has(id) ? titleOf(db, byId.get(id)!) : "Untitled");

  // The visible range: a week before the first task to three after the last (or around today).
  const t0 = today();
  const all = [...spans.values()];
  const lo = weekStart(Math.min(t0, ...all.map((s) => s.s)) - 7);
  const hi = Math.max(t0 + 28, ...all.map((s) => s.e)) + 21;
  const x = (d: number) => (d - lo) * dr;
  const width = (hi - lo + 1) * dr;

  // Rows in order, grouped by the group field when set (frame 1a: grouped by Phase).
  const scheduled = ctx.rows.filter((r) => spans.has(r.id));
  const tray = ctx.rows.filter((r) => !spans.has(r.id));
  const groups: { key: string; label: string; rows: DbRow[] }[] = [];
  if (groupF) {
    const opts = groupF.options?.map((o) => o.v) ?? [];
    for (const v of [...opts, ""]) {
      const rs = scheduled.filter((r) => (r.v[groupF.id] ?? "") === v);
      if (rs.length) groups.push({ key: v, label: v || `No ${groupF.name}`, rows: rs });
    }
  } else groups.push({ key: "", label: "", rows: scheduled });
  const flat = groups.flatMap((g) => g.rows);
  const yOf = new Map<string, number>();
  {
    let y = 0;
    for (const g of groups) {
      if (groupF) y += GRP_H;
      for (const r of g.rows) (yOf.set(r.id, y), (y += ROW_H));
    }
  }
  const bodyH = (groupF ? groups.length * GRP_H : 0) + flat.length * ROW_H;

  const announce = (id: string, sp: Span) => setSay(`${title(id)} moved to ${short(sp.s)} to ${short(sp.e)}`);
  /** After a change: if dependents now start too early, offer to shift them (frame 2b). */
  const afterMove = (id: string, sp: Span) => {
    const m = new Map(spans);
    m.set(id, sp);
    const plan = shiftPlan(m, es, id, work);
    if (plan.days > 0) {
      const n = plan.ids.length;
      setWarn({ moved: id, days: plan.days, ids: plan.ids, text: `${n} ${n === 1 ? "task now starts" : "tasks now start"} before ${title(id)} ends` });
    } else setWarn(null);
  };
  const commit = (id: string, s: number, e: number) => {
    if (!edit) return;
    ctx.um?.stopCapturing();
    writeSpan(ctx, p, id, s, e);
    const sp = { id, s, e, ms: spans.get(id)?.ms ?? false };
    announce(id, sp);
    afterMove(id, sp);
  };
  const shiftDependents = (w: NonNullable<typeof warn>) => {
    ctx.um?.stopCapturing();
    tx(doc, db.id, () => {
      for (const id of w.ids) {
        const sp = spans.get(id);
        if (sp) writeSpan(ctx, p, id, addDays(sp.s, w.days, work), addDays(sp.e, w.days, work));
      }
    });
    setSay(`Shifted ${w.ids.length} ${w.ids.length === 1 ? "task" : "tasks"} by ${w.days} ${w.days === 1 ? "day" : "days"}`);
    setWarn(null);
  };
  const shiftFor = (id: string) => {
    const plan = shiftPlan(spans, es, id, work);
    if (plan.days > 0) shiftDependents({ moved: id, days: plan.days, ids: plan.ids, text: "" });
    else env.toast("No dependent task needs to move.");
  };
  const addDep = (blocked: string, blocker: string) => {
    if (!edit || blocked === blocker) return;
    const fid = depF?.id ?? addDependencyField(ctx);
    // Read the field as stored now (with its reverse id) so "Blocks" follows in one transaction.
    const m = getDbMap(doc, db.id);
    const real = m ? readDb(db.id, m).fields.find((x) => x.id === fid) : undefined;
    if (!real) return;
    const cur = relIds(m ? (readDb(db.id, m).rows.find((r) => r.id === blocked)?.v[fid] as CellValue) : undefined);
    if (cur.includes(blocker)) return;
    setRelation(doc, db.id, blocked, real, [...cur, blocker]);
    setSay(`${title(blocked)} is blocked by ${title(blocker)}`);
  };
  const toggleMilestone = (id: string) => {
    if (!edit) return;
    let ms = p.ms;
    if (!ms) {
      const fid = addField(doc, db.id, "checkbox", "Milestone");
      ms = { f: fid, v: "true" };
      patchTl(ctx, { ms });
    }
    const f = db.fields.find((x) => x.id === ms!.f);
    const on = String(byId.get(id)?.v[ms.f] ?? "") === ms.v;
    setCell(doc, db.id, id, ms.f, on ? (f?.type === "checkbox" || !f ? false : "") : f?.type === "checkbox" || !f ? true : ms.v);
  };

  /* ---- pointer: move, resize, link ---- */
  const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const onBarDown = (e: React.PointerEvent, id: string, mode: "move" | "s" | "e") => {
    if (!edit || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const sp0 = spans.get(id)!;
    const x0 = e.clientX;
    const per = dr * remPx();
    let cur = sp0;
    const len = spanDays(sp0.s, sp0.e, work);
    const snap = (d: number, dir: number) => {
      let v = d;
      while (work && isWeekend(v)) v += dir || 1;
      return v;
    };
    const move = (ev: PointerEvent) => {
      const dd = Math.round((ev.clientX - x0) / per);
      if (mode === "move") {
        const s = snap(sp0.s + dd, Math.sign(dd));
        cur = { ...sp0, s, e: addDays(s, len - 1, work) };
      } else if (mode === "e") cur = { ...sp0, e: Math.max(sp0.s, snap(sp0.e + dd, -1)) };
      else cur = { ...sp0, s: Math.min(sp0.e, snap(sp0.s + dd, 1)) };
      setLive(cur);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLive(null);
      if (cur.s !== sp0.s || cur.e !== sp0.e) commit(id, cur.s, cur.e);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onLinkDown = (e: React.PointerEvent, id: string) => {
    if (!edit) return;
    e.preventDefault();
    e.stopPropagation();
    const box = scroller.current!.getBoundingClientRect();
    const rev = e.altKey;
    const move = (ev: PointerEvent) => setLink({ from: id, x: ev.clientX - box.left + scroller.current!.scrollLeft, y: ev.clientY - box.top });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLink(null);
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-bar]");
      const other = el?.dataset.bar;
      // From a task's end to another: the other is blocked by it. Alt-drag links the other way.
      if (other && other !== id) rev ? addDep(id, other) : addDep(other, id);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /** A row from the No dates tray dropped on the chart: scheduled where it lands. */
  const onChipDown = (e: React.PointerEvent, id: string) => {
    if (!edit || e.button !== 0) return;
    const x0 = e.clientX;
    const chip = e.currentTarget as HTMLElement;
    let moved = false;
    delete chip.dataset.dragged;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) > 6) (moved = true), (chip.dataset.dragged = "1");
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) return;
      const box = scroller.current?.getBoundingClientRect();
      if (!box || ev.clientY < box.top || ev.clientY > box.bottom) return;
      const d = lo + Math.floor((ev.clientX - box.left + scroller.current!.scrollLeft) / (dr * remPx()));
      let s = d;
      while (work && isWeekend(s)) s++;
      commit(id, s, s);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /* ---- keyboard on a bar (frame 7) ---- */
  const focusBar = (id: string) => requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-tl="${db.id}"] [data-bar="${id}"]`)?.focus());
  const toToday = () => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, x(t0) * remPx() - el.clientWidth / 3);
  };
  const setZoom = (z: Zoom) => patchTl(ctx, { zoom: z });
  const onBarKey = (e: React.KeyboardEvent, id: string) => {
    const sp = spans.get(id);
    if (!sp) return;
    const i = flat.findIndex((r) => r.id === id);
    const k = e.key;
    if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      const n = flat[i + (k === "ArrowDown" ? 1 : -1)];
      if (n) focusBar(n.id);
    } else if ((k === "ArrowLeft" || k === "ArrowRight") && edit) {
      e.preventDefault();
      const d = k === "ArrowRight" ? 1 : -1;
      if (e.shiftKey) commit(id, sp.s, Math.max(sp.s, addDays(sp.e, d, work)));
      else if (e.altKey) commit(id, Math.min(sp.e, addDays(sp.s, d, work)), sp.e);
      else commit(id, addDays(sp.s, d, work), addDays(sp.e, d, work));
      focusBar(id);
    } else if (k === "Enter") {
      e.preventDefault();
      ctx.setPeek(id);
    } else if ((k === "l" || k === "L") && edit) {
      e.preventDefault();
      setPick({ anchor: e.currentTarget as HTMLElement, id });
    } else if ((k === "m" || k === "M") && edit) {
      e.preventDefault();
      toggleMilestone(id);
    } else if (k === "t" || k === "T") {
      e.preventDefault();
      toToday();
    } else if (k === "-" || k === "=" || k === "+") {
      e.preventDefault();
      const zi = ZOOMS.findIndex(([z]) => z === zoom);
      const n = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, zi + (k === "-" ? 1 : -1)))][0];
      setZoom(n);
    } else if (k === "ContextMenu" || (e.shiftKey && k === "F10")) {
      e.preventDefault();
      setMenu({ anchor: e.currentTarget as HTMLElement, id });
    } else if ((k === "Delete" || k === "Backspace") && edit) {
      e.preventDefault();
      removeRow(id);
    }
  };
  const removeRow = (id: string) => {
    const name = title(id);
    deleteRow(doc, db.id, id);
    env.toast(`Deleted “${name}”`, ctx.um ? { label: "Undo", run: () => ctx.um!.undo() } : undefined);
  };
  useEffect(() => {
    if (!say) return;
    const t = setTimeout(() => setSay(""), 4000);
    return () => clearTimeout(t);
  }, [say]);
  useLayoutEffect(() => {
    toToday();
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- empty state (frame 6a) ---- */
  if (!p.start) {
    return (
      <div className="ocdb-tl-empty" data-tl={db.id}>
        <Ic i={CalendarDays} s={28} />
        <h4>A timeline needs dates</h4>
        <p>Add Start and Due fields to this database to place rows on a timeline.</p>
        {edit ? (
          <button
            className="ocdb-btn"
            onClick={() => {
              const s = addField(doc, db.id, "date", "Start");
              const e = addField(doc, db.id, "date", "Due");
              patchTl(ctx, { start: s, end: e });
            }}
          >
            <Ic i={Plus} />
            Add Start and Due
          </button>
        ) : null}
      </div>
    );
  }

  /* ---- header ticks ---- */
  const ticks: ReactNode[] = [];
  const months: ReactNode[] = [];
  for (let d = lo; d <= hi; d++) {
    const { y, m } = monthOf(d);
    if (d === lo || firstOfMonth(y, m) === d)
      months.push(
        <span key={"m" + d} className="m" style={{ left: `${x(d)}rem` }}>
          {monthName(m)} {y}
        </span>,
      );
    const tick = zoom === "day" ? true : zoom === "week" ? weekStart(d) === d : zoom === "month" ? weekStart(d) === d : firstOfMonth(y, m) === d;
    if (tick && zoom !== "quarter")
      ticks.push(
        <span key={"w" + d} className={"w" + (d <= t0 && t0 < d + (zoom === "day" ? 1 : 7) ? " today" : "")} style={{ left: `${x(d)}rem`, width: `${(zoom === "day" ? 1 : 7) * dr}rem` }}>
          {zoom === "day" ? new Date(d * 86_400_000).getUTCDate() : short(d).split(" ")[1]}
        </span>,
      );
  }
  const shade: ReactNode[] = [];
  if (p.shade && (zoom === "day" || zoom === "week")) for (let d = lo; d <= hi; d++) if (weekday6(d)) shade.push(<i key={d} className="we" style={{ left: `${x(d)}rem`, width: `${2 * dr}rem` }} />);

  /* ---- dependency arrows ---- */
  const arrows = es.map(([a, b]) => {
    const A = spans.get(a);
    const B = spans.get(b);
    const ya = yOf.get(a);
    const yb = yOf.get(b);
    if (!A || !B || ya == null || yb == null) return null;
    const x1 = x(A.e + 1);
    const y1 = ya + ROW_H / 2;
    const x2 = x(B.s);
    const y2 = yb + ROW_H / 2;
    const mid = Math.max(x1 + 0.5, Math.min(x2 - 0.5, x1 + 0.75));
    const cls = bad.has(`${a}>${b}`) ? "bad" : crit.has(a) && crit.has(b) ? "crit" : "";
    return <path key={`${a}>${b}`} className={cls} d={`M${x1} ${y1} H${mid} V${y2} H${x2}`} markerEnd="url(#ocdb-tl-arrow)" />;
  });

  const bars = flat.map((r) => {
    const sp = spans.get(r.id)!;
    const y = yOf.get(r.id)!;
    const t = titleOf(db, r);
    const blocks = es.filter(([a]) => a === r.id).map(([, b]) => title(b));
    const blockedBy = es.filter(([, b]) => b === r.id).map(([a]) => title(a));
    const label = barLabel(t, sp, blocks, blockedBy);
    const late = es.some(([a, b]) => b === r.id && bad.has(`${a}>${b}`));
    const who = whoF ? ctx.people.resolve(r.v[whoF.id]) : null;
    const prog = p.prog ? Number(r.v[p.prog]) : NaN;
    const common = {
      "data-bar": r.id,
      role: "button",
      tabIndex: 0,
      "aria-label": label,
      onKeyDown: (e: React.KeyboardEvent) => onBarKey(e, r.id),
      onDoubleClick: () => ctx.setPeek(r.id),
      onContextMenu: (e: React.MouseEvent) => (e.preventDefault(), setMenu({ anchor: new DOMRect(e.clientX, e.clientY, 0, 0), id: r.id })),
    } as const;
    if (sp.ms)
      return (
        <div key={r.id}>
          <div {...common} className="ocdb-tl-ms" style={{ left: `calc(${x(sp.s) + dr / 2}rem - .45rem)`, top: `${y + ROW_H / 2 - 0.45}rem` }} onPointerDown={(e) => onBarDown(e, r.id, "move")} />
          <span className="ocdb-tl-msl" style={{ left: `${x(sp.s) + dr / 2 + 0.8}rem`, top: `${y + 0.55}rem` }} aria-hidden="true">
            {t}
          </span>
        </div>
      );
    return (
      <div
        key={r.id}
        {...common}
        className={`ocdb-tl-bar ocdb-c-${optTone(colorF, colorF ? r.v[colorF.id] : undefined)}` + (crit.has(r.id) ? " crit" : "") + (late ? " late" : "") + (live?.id === r.id ? " drag" : "")}
        style={{ left: `${x(sp.s)}rem`, width: `${Math.max(dr, x(sp.e + 1) - x(sp.s))}rem`, top: `${y + (ROW_H - 1.375) / 2}rem` }}
        onPointerDown={(e) => onBarDown(e, r.id, "move")}
      >
        {Number.isFinite(prog) && prog > 0 ? <i className="fill" style={{ width: `${Math.min(100, prog)}%` }} /> : null}
        <span className="lbl">{t}</span>
        {edit ? <i className="hdl l" aria-hidden="true" onPointerDown={(e) => onBarDown(e, r.id, "s")} /> : null}
        {edit ? <i className="hdl r" aria-hidden="true" onPointerDown={(e) => onBarDown(e, r.id, "e")} /> : null}
        {edit ? <i className="dot" aria-hidden="true" onPointerDown={(e) => onLinkDown(e, r.id)} /> : null}
        <span className="after" aria-hidden="true">
          {who ? <Avatar u={who} size="xs" /> : null}
          {short(sp.e)}
        </span>
      </div>
    );
  });

  const toolbar = (
    <div className="ocdb-tl-tb">
      <button className="ocdb-btn ghost sm" onClick={toToday}>Today</button>
      <div className="ocdb-tl-seg" role="group" aria-label="Zoom">
        {ZOOMS.map(([z, n]) => (
          <button key={z} aria-pressed={zoom === z} onClick={() => setZoom(z)}>
            {n}
          </button>
        ))}
      </div>
      <button className={"ocdb-btn ghost sm" + (p.crit ? " on" : "")} aria-pressed={p.crit} onClick={() => patchTl(ctx, { crit: !p.crit })}>
        <Ic i={Route} s={14} />
        Critical path
      </button>
      <span style={{ flex: 1 }} />
      {edit && !depF ? (
        <button className="ocdb-btn ghost sm" onClick={() => addDependencyField(ctx)}>
          <Ic i={Link2} s={14} />
          Add dependency field
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="ocdb-tl" data-tl={db.id}>
      {toolbar}
      <div className="ocdb-tl-gt">
        <div className="ocdb-tl-l" role="grid" aria-label="Rows" aria-rowcount={flat.length}>
          <div className="ocdb-tl-lh" role="row">
            <span role="columnheader">{db.fields.find((f) => f.type === "title")?.name ?? "Name"}</span>
          </div>
          {groups.map((g) => (
            <div key={g.key} role="rowgroup">
              {groupF ? <div className="ocdb-tl-grp" role="row"><span role="rowheader">{g.label}</span></div> : null}
              {g.rows.map((r) => (
                <div key={r.id} className="ocdb-tl-row" role="row">
                  <span role="gridcell" className="nm" tabIndex={-1} onClick={() => focusBar(r.id)}>
                    {spans.get(r.id)?.ms ? <Ic i={Diamond} s={12} /> : null}
                    {titleOf(db, r)}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="ocdb-tl-r" ref={scroller}>
          <div className="ocdb-tl-cv" style={{ width: `${width}rem` }}>
            <div className="ocdb-tl-hd" aria-hidden="true">
              {months}
              {ticks}
            </div>
            <div className="ocdb-tl-body" style={{ height: `${bodyH}rem` }}>
              {shade}
              {groupF ? groups.map((g) => <i key={"g" + g.key} className="g" style={{ top: `${yOf.get(g.rows[0].id)! - GRP_H}rem` }} />) : null}
              {t0 >= lo && t0 <= hi ? <i className="now" style={{ left: `${x(t0) + dr / 2}rem` }} aria-hidden="true" /> : null}
              <svg className="deps" aria-hidden="true" viewBox={`0 0 ${width} ${bodyH}`} preserveAspectRatio="none" style={{ width: `${width}rem`, height: `${bodyH}rem` }}>
                <defs>
                  <marker id="ocdb-tl-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth=".4" markerHeight=".4" markerUnits="userSpaceOnUse" orient="auto">
                    <path d="M0 0 L6 3 L0 6z" />
                  </marker>
                </defs>
                {arrows}
                {link ? <path d={`M${x(spans.get(link.from)!.e + 1)} ${yOf.get(link.from)! + ROW_H / 2} L${link.x / remPx()} ${link.y / remPx() - HEAD_H}`} className="crit" /> : null}
              </svg>
              {bars}
            </div>
          </div>
        </div>
      </div>
      {!scheduled.length ? (
        <div className="ocdb-tl-none">
          <b>Nothing scheduled</b>
          <span>Give a row a start date, or drag one from No dates.</span>
        </div>
      ) : null}
      {p.tray && tray.length ? (
        <div className="ocdb-tl-tray" aria-label="No dates">
          <span>No dates ({tray.length}){edit ? " — drag onto the timeline to schedule:" : ":"}</span>
          {tray.map((r) => (
            <button
              key={r.id}
              className="ocdb-tl-chip"
              title={edit ? "Drag onto the timeline, or click to schedule today" : undefined}
              onPointerDown={(e) => onChipDown(e, r.id)}
              onClick={(e) => {
                if (e.detail > 1 || e.currentTarget.dataset.dragged) return;
                if (edit) {
                  let s = t0;
                  while (work && isWeekend(s)) s++;
                  commit(r.id, s, s);
                } else ctx.setPeek(r.id);
              }}
            >
              {titleOf(db, r)}
            </button>
          ))}
        </div>
      ) : null}
      {warn ? (
        <div className="ocdb-tl-toast" role="alert">
          <Ic i={TriangleAlert} s={15} className="ic" />
          <span>{warn.text}</span>
          <button className="ocdb-btn sm" onClick={() => shiftDependents(warn)}>
            Shift {warn.ids.length} {warn.ids.length === 1 ? "task" : "tasks"} by {warn.days} {warn.days === 1 ? "day" : "days"}
          </button>
          <button className="ocdb-btn ghost sm" onClick={() => setWarn(null)}>Keep</button>
          {ctx.um ? <button className="ocdb-btn ghost sm" onClick={() => (ctx.um!.undo(), setWarn(null))}>Undo</button> : null}
        </div>
      ) : null}
      <div className="ocdb-sr" aria-live="polite">{say}</div>
      {menu ? (
        <Pop anchor={menu.anchor} compact={ctx.compact} title={title(menu.id)} onClose={() => setMenu(null)}>
          <BarMenu
            ctx={ctx}
            id={menu.id}
            close={() => setMenu(null)}
            onPick={(a) => setPick({ anchor: a, id: menu.id })}
            onMilestone={() => toggleMilestone(menu.id)}
            onShift={() => shiftFor(menu.id)}
            onClear={() => tx(doc, db.id, () => [p.start, p.end].forEach((f) => f && setCell(doc, db.id, menu.id, f, null)))}
            onDelete={() => removeRow(menu.id)}
          />
        </Pop>
      ) : null}
      {pick ? (
        <Pop anchor={pick.anchor} compact={ctx.compact} title="Blocked by" onClose={() => setPick(null)}>
          <DepPicker rows={ctx.rows.filter((r) => r.id !== pick.id)} db={db} onPick={(other) => (addDep(pick.id, other), setPick(null), focusBar(pick.id))} />
        </Pop>
      ) : null}
    </div>
  );
}

const weekday6 = (d: number) => new Date(d * 86_400_000).getUTCDay() === 6;

function BarMenu(props: { ctx: TlCtx; id: string; close: () => void; onPick: (a: Anchor) => void; onMilestone: () => void; onShift: () => void; onClear: () => void; onDelete: () => void }) {
  const { ctx, id, close } = props;
  const item = (label: string, run: () => void, kbd?: string, dan = false) => (
    <button className={"ocdb-mi" + (dan ? " dan" : "")} role="menuitem" onClick={() => (close(), run())}>
      {label}
      {kbd ? <kbd>{kbd}</kbd> : null}
    </button>
  );
  return (
    <div role="menu" aria-label="Bar">
      {item("Open row", () => ctx.setPeek(id), "Enter")}
      {ctx.edit ? (
        <>
          <button className="ocdb-mi" role="menuitem" onClick={(e) => props.onPick(e.currentTarget.getBoundingClientRect())}>
            Add dependency…<kbd>L</kbd>
          </button>
          {item("Make milestone", props.onMilestone, "M")}
          {item("Shift dependents…", props.onShift)}
          {item("Remove dates", props.onClear)}
          {item("Delete row", props.onDelete, "⌫", true)}
        </>
      ) : null}
    </div>
  );
}

/** "Add a dependency: type to pick the task" (frame 7, L). */
function DepPicker({ rows, db, onPick }: { rows: DbRow[]; db: DbSnapshot; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const list = rows.filter((r) => titleOf(db, r).toLowerCase().includes(q.toLowerCase())).slice(0, 30);
  return (
    <div className="ocdb-tl-pick">
      <input autoFocus aria-label="Find a task" placeholder="Type to pick the task" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && list[0] && onPick(list[0].id)} />
      <div role="listbox" aria-label="Tasks">
        {list.map((r) => (
          <button key={r.id} role="option" aria-selected={false} className="ocdb-mi" onClick={() => onPick(r.id)}>
            {titleOf(db, r)}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ================================================================ phone (frame 5) */

export function TimelinePhone({ ctx }: { ctx: TlCtx }) {
  ensureTimelineStyles();
  const { db, edit } = ctx;
  const p = resolve(db, tlPrefs(ctx));
  const [sheet, setSheet] = useState<string | null>(null);
  const weeks = byWeek(ctx.rows, p);
  const es = edges(ctx.rows, p.dep);
  const byId = new Map(ctx.rows.map((r) => [r.id, r]));
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (!p.start) return <TimelineView ctx={ctx} />;
  const sp = sheet ? spanOf(byId.get(sheet)!, p) : null;
  const nudge = (d: number) => {
    if (!sp || !sheet) return;
    writeSpan(ctx, p, sheet, addDays(sp.s, d, p.work), addDays(sp.e, d, p.work));
  };
  return (
    <div className="ocdb-tl-ph" data-tl={db.id}>
      {weeks.map((w) => (
        <section key={w.week} aria-label={`Week of ${short(w.week)}`}>
          <div className="ocdb-tl-wk">
            <span>Week of {short(w.week)}</span>
            <span>{w.items.length}</span>
          </div>
          {w.items.map((s) => {
            const r = byId.get(s.id)!;
            const blocks = es.filter(([a]) => a === s.id).length;
            const a = Math.max(0, s.s - w.week);
            const b = Math.min(6, s.e - w.week);
            return (
              <button
                key={s.id}
                className="ocdb-tl-it"
                onClick={() => ctx.setPeek(s.id)}
                onContextMenu={(e) => (e.preventDefault(), setSheet(s.id))}
                onPointerDown={() => (press.current = setTimeout(() => setSheet(s.id), 500))}
                onPointerUp={() => press.current && clearTimeout(press.current)}
                onPointerLeave={() => press.current && clearTimeout(press.current)}
              >
                <span className="t">{titleOf(db, r)}</span>
                <span className="s">
                  {s.ms ? short(s.s) : `${short(s.s)} – ${short(s.e)}`}
                  {blocks ? ` · blocks ${blocks}` : ""}
                </span>
                <span className="mini" aria-hidden="true">
                  <i style={{ left: `${(a / 7) * 100}%`, width: `${((b - a + 1) / 7) * 100}%` }} />
                </span>
              </button>
            );
          })}
        </section>
      ))}
      {!weeks.length ? <p className="ocdb-tl-none">Nothing scheduled yet.</p> : null}
      {sheet && sp ? (
        <Pop anchor={new DOMRect(0, 0, 0, 0)} compact title={titleOf(db, byId.get(sheet)!)} onClose={() => setSheet(null)}>
          <p className="ocdb-hint" style={{ padding: "0 .625rem" }}>
            {short(sp.s)} – {short(sp.e)} · {spanDays(sp.s, sp.e, p.work)} working days · blocks {es.filter(([a]) => a === sheet).length}
          </p>
          {edit ? (
            <div className="ocdb-tl-nudge">
              <button className="ocdb-btn" onClick={() => nudge(-1)}>− 1 day</button>
              <button className="ocdb-btn" onClick={() => nudge(1)}>+ 1 day</button>
            </div>
          ) : null}
          <button className="ocdb-mi" onClick={() => (setSheet(null), ctx.setPeek(sheet))}>Open row</button>
          {edit ? <button className="ocdb-mi" onClick={() => (setSheet(null), ctx.setPeek(sheet))}>Change dates…</button> : null}
        </Pop>
      ) : null}
    </div>
  );
}

/* ================================================================ Workload (frame 4) */

export function WorkloadView({ ctx }: { ctx: TlCtx }) {
  ensureTimelineStyles();
  const { db, doc, edit } = ctx;
  const p = resolve(db, tlPrefs(ctx));
  const [mode, setMode] = useState<"hours" | "tasks">("hours");
  const [open, setOpen] = useState<{ anchor: Anchor; who: string; w: number } | null>(null);
  const w0 = weekStart(today());
  const weeks = Array.from({ length: 6 }, (_, i) => w0 + i * 7);
  const load = workload(ctx.rows, p, weeks);
  const whoF = db.fields.find((f) => f.id === p.who);
  if (!p.start || !whoF) {
    return (
      <div className="ocdb-tl-empty">
        <Ic i={Users} s={28} />
        <h4>Workload needs dates and a person</h4>
        <p>Add a Start date and a Person field, then each person's tasks show against the weeks.</p>
      </div>
    );
  }
  const people = [...load.keys()].filter((k) => k).sort((a, b) => (ctx.people.resolve(a)?.name ?? a).localeCompare(ctx.people.resolve(b)?.name ?? b));
  const rowsOrder = [...people, ...(load.has("") ? [""] : [])];
  const byId = new Map(ctx.rows.map((r) => [r.id, r]));
  const cellOf = open ? load.get(open.who)?.[open.w] : null;
  return (
    <div className="ocdb-wl" data-tl={db.id}>
      <div className="ocdb-tl-tb">
        <div className="ocdb-tl-seg" role="group" aria-label="Show">
          <button aria-pressed={mode === "hours"} onClick={() => setMode("hours")}>Hours</button>
          <button aria-pressed={mode === "tasks"} onClick={() => setMode("tasks")}>Tasks</button>
        </div>
        <span className="ocdb-wl-key">
          <i className="lv1" />under 80% <i className="lv3" />80–100% <i className="lv4" />over
        </span>
      </div>
      <table className="ocdb-wl-t">
        <caption className="ocdb-sr">Workload by person and week{p.est ? "" : " (no Estimate field: counting tasks)"}</caption>
        <thead>
          <tr>
            <th scope="col">Person</th>
            {weeks.map((w) => (
              <th key={w} scope="col">{short(w)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowsOrder.map((who) => {
            const u = who ? ctx.people.resolve(who) : null;
            return (
              <tr key={who || "none"}>
                <th scope="row">
                  {u ? <Avatar u={u} size="xs" /> : null}
                  {u?.name ?? (who ? "Someone" : "Unassigned")}
                </th>
                {load.get(who)!.map((c, i) => {
                  const lv = !c.rows.length ? "lv0" : band(c) === "over" ? "lv4" : band(c) === "near" ? "lv3" : "lv1";
                  const text = mode === "tasks" || !p.est ? String(c.rows.length) : `${c.hours}h`;
                  return (
                    <td key={i} className={lv}>
                      <button
                        aria-label={`${u?.name ?? "Unassigned"}, week of ${short(weeks[i])}: ${c.rows.length} tasks, ${c.hours} of ${c.cap} hours${band(c) === "over" ? ", over capacity" : ""}`}
                        disabled={!c.rows.length}
                        onClick={(e) => setOpen({ anchor: e.currentTarget, who, w: i })}
                      >
                        {c.rows.length ? text : "–"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {open && cellOf ? (
        <Pop anchor={open.anchor} compact={ctx.compact} title={`Week of ${short(weeks[open.w])}`} onClose={() => setOpen(null)}>
          <ul className="ocdb-wl-list">
            {cellOf.rows.map((id) => (
              <li key={id}>
                <button className="ocdb-mi" onClick={() => (setOpen(null), ctx.setPeek(id))}>{titleOf(db, byId.get(id)!)}</button>
                {edit ? (
                  <select
                    aria-label={`Assign ${titleOf(db, byId.get(id)!)} to`}
                    value={(byId.get(id)!.v[whoF.id] as string) ?? ""}
                    onChange={(e) => setCell(doc, db.id, id, whoF.id, e.target.value || null)}
                  >
                    <option value="">Unassigned</option>
                    {ctx.people.pickable.map((u) => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                  </select>
                ) : null}
              </li>
            ))}
          </ul>
        </Pop>
      ) : null}
    </div>
  );
}

/* ================================================================ settings (frame 3a) */

export function TimelineSettings({ ctx }: { ctx: TlCtx }) {
  const { db, edit } = ctx;
  const p = resolve(db, tlPrefs(ctx));
  const set = (patch: Partial<TimelinePrefs>) => patchTl(ctx, patch);
  const sel = (label: string, value: string | undefined, types: DbField["type"][], onChange: (v: string | undefined) => void, none = "None") => (
    <label className="ocdb-tl-fld">
      <span>{label}</span>
      <select value={value ?? ""} disabled={!edit} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{none}</option>
        {db.fields
          .filter((f) => types.includes(f.type) && (f.type !== "relation" || f.rel?.db === db.id))
          .map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
      </select>
    </label>
  );
  const sw = (label: string, on: boolean, k: "work" | "shade" | "tray") => (
    <label className="ocdb-tl-fld">
      <span>{label}</span>
      <input type="checkbox" checked={on} disabled={!edit} onChange={(e) => set({ [k]: e.target.checked })} />
    </label>
  );
  if (ctx.view === "workload")
    return (
      <div className="ocdb-tl-set">
        {sel("Person", p.who, ["person"], (v) => set({ who: v }))}
        {sel("Estimate (hours)", p.est, ["number"], (v) => set({ est: v }))}
        <div className="ocdb-mh">Weekly capacity</div>
        {ctx.people.pickable.map((u) => (
          <label key={u.id} className="ocdb-tl-fld">
            <span>{u.name}</span>
            <input type="number" min={0} max={168} value={p.cap?.[u.id] ?? 40} disabled={!edit} onChange={(e) => set({ cap: { ...(p.cap ?? {}), [u.id]: Number(e.target.value) || 0 } })} />
          </label>
        ))}
      </div>
    );
  return (
    <div className="ocdb-tl-set">
      {sel("Starts", p.start, ["date"], (v) => set({ start: v }))}
      {sel("Ends", p.end, ["date"], (v) => set({ end: v, dur: v ? undefined : p.dur }))}
      {sel("Or duration (days)", p.dur, ["number"], (v) => set({ dur: v, end: v ? undefined : p.end }))}
      {edit && !p.end && !p.dur ? (
        <button className="ocdb-mi" onClick={() => set({ end: addField(ctx.doc, db.id, "date", "Due") })}>
          <Ic i={Plus} />
          Add Due field
        </button>
      ) : null}
      {sel("Dependencies", p.dep, ["relation"], (v) => set({ dep: v }))}
      {edit && !p.dep ? (
        <button className="ocdb-mi" onClick={() => addDependencyField(ctx)}>
          <Ic i={Plus} />
          Add dependency field
        </button>
      ) : null}
      {sel("Milestone", p.ms?.f, ["checkbox", "select", "status"], (v) => {
        const f = db.fields.find((x) => x.id === v);
        set({ ms: v ? { f: v, v: f?.type === "checkbox" ? "true" : (f?.options?.find((o) => /milestone/i.test(o.v))?.v ?? f?.options?.[0]?.v ?? "") } : undefined });
      })}
      {sel("Colour by", p.color, ["status", "select"], (v) => set({ color: v }))}
      {sel("Progress", p.prog, ["progress", "number"], (v) => set({ prog: v }))}
      {sel("Group by", p.group, ["status", "select"], (v) => set({ group: v }))}
      {sw("Working days Mon–Fri", p.work, "work")}
      {sw("Shade weekends", p.shade, "shade")}
      {sw("Show No dates tray", p.tray, "tray")}
    </div>
  );
}

/** Rows' dates as the exports and the API read them: Start, End and Blocked by (frame 7). */
export function timelineTable(db: DbSnapshot, rows: DbRow[], prefs: TimelinePrefs): string[][] {
  const p = resolve(db, prefs);
  const t = (id: string) => titleOf(db, rows.find((r) => r.id === id) ?? { id, v: {} });
  const es = edges(rows, p.dep);
  return [
    ["Task", "Start", "End", "Blocked by"],
    ...rows.map((r) => {
      const sp = spanOf(r, p);
      return [titleOf(db, r), sp ? iso(sp.s) : "", sp ? iso(sp.e) : "", es.filter(([, b]) => b === r.id).map(([a]) => t(a)).join(", ")];
    }),
  ];
}

export { day, diffDays };
