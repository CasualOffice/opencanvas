// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The table for large databases (docs/36 §6.1, prototype large-tables 1a-1c, 3a-3c, 4a, 4c):
// rows and columns virtualized (what is on screen plus a screen either side), a sticky header,
// one frozen column (row number and the primary field), Go to row (Ctrl+G or the count), a
// position label while dragging the scrollbar, sorting in a worker, and bulk edit.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Y from "yjs";
import { ArrowDownToLine, ArrowUpToLine, Pencil, Trash2, X } from "lucide-react";
import type { BlockEnv, OcUser } from "@opencanvas/ui";
import { setCell } from "../model";
import { sortsOf, titleField } from "../query";
import type { CellValue, DbField, DbRow, DbSnapshot, ViewPrefs } from "../types";
import { COMPUTED_TYPES } from "../types";
import { Ic, type Anchor } from "../ui";
import { bulkDelete, bulkSet, type BulkRun } from "./bulk";
import { useSorted, type SortBusy } from "./useSorted";

/** Table and board views switch to the large components at this many rows. */
export const LARGE_AT = 1000;
const ROW_REM = 2.5, HEAD_REM = 2.375, NUM_REM = 4.5, CARD_REM = 4.75;

export interface LargeCtx {
  doc: Y.Doc;
  db: DbSnapshot;
  env: BlockEnv;
  edit: boolean;
  compact: boolean;
  rows: DbRow[];
  prefs: ViewPrefs;
  people: { resolve: (id: unknown) => OcUser | null; pickable: OcUser[] };
  open: (p: { kind: "cell"; rowId: string; fid: string; anchor: Anchor; key: string }) => void;
  setPeek: (rid: string | null) => void;
  um: Y.UndoManager | null;
  goto: { open: boolean; set: (o: boolean) => void };
}

export interface LargeProps {
  ctx: LargeCtx;
  fields: DbField[];
  widthOf: (f: DbField) => number;
  value: (f: DbField, v: CellValue | undefined) => ReactNode;
}

const remPx = () => (typeof document === "undefined" ? 16 : parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
const fmt = (n: number) => n.toLocaleString("en-US");
const INLINE = new Set(["title", "text", "number", "url"]);

/** Header line of a large view: the count (opens Go to row) and the worker's progress. */
export function countLabel(shown: number, total: number, word = "rows") {
  return shown === total ? `${fmt(total)} ${word}` : `${fmt(shown)} of ${fmt(total)}`;
}

function BusyChip({ busy }: { busy: SortBusy | null }) {
  if (!busy) return null;
  return (
    <span className="ocdb-lt-busy" role="status">
      {busy.label} · {busy.pct}%
      <i style={{ width: busy.pct + "%" }} />
    </span>
  );
}

interface Win {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export function LargeTable({ ctx, fields, widthOf, value }: LargeProps) {
  const { db, edit, compact } = ctx;
  const sorts = sortsOf(db, ctx.prefs);
  const { rows, busy } = useSorted(ctx.rows, db.fields, sorts, ctx.people.pickable);
  const n = rows.length;
  const tf = titleField(db);
  const cols = useMemo(() => fields.filter((f) => f.id !== tf?.id), [fields, tf]);
  const px = useMemo(remPx, []);
  const rowH = Math.round((compact ? CARD_REM : ROW_REM) * px);
  const headH = compact ? 0 : Math.round(HEAD_REM * px);
  const frozenW = compact ? 0 : Math.round(NUM_REM * px) + (tf ? widthOf(tf) : 0);
  const xs = useMemo(() => {
    const out: number[] = [];
    let x = frozenW;
    for (const f of cols) out.push(x), (x += widthOf(f));
    out.push(x);
    return out;
  }, [cols, widthOf, frozenW]);
  const totalW = xs[xs.length - 1];

  const sc = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState<Win>({ r0: 0, r1: 60, c0: 0, c1: 12 });
  const measure = useCallback(() => {
    const el = sc.current;
    if (!el) return;
    const vh = el.clientHeight || 600, vw = el.clientWidth || 1200;
    const screen = Math.max(1, Math.ceil(vh / rowH));
    // Snap to half screens so most scroll frames re-render nothing.
    const half = Math.max(1, Math.floor(screen / 2));
    const first = Math.floor(Math.max(0, el.scrollTop - headH) / rowH);
    const r0 = Math.max(0, Math.floor((first - screen) / half) * half);
    const r1 = Math.min(n, r0 + 3 * screen + 2 * half);
    let c0 = 0;
    while (c0 < cols.length && xs[c0 + 1] < el.scrollLeft + frozenW) c0++;
    let c1 = c0;
    while (c1 < cols.length && xs[c1] < el.scrollLeft + vw) c1++;
    c0 = Math.max(0, c0 - 2);
    c1 = Math.min(cols.length, c1 + 2);
    setWin((w) => (w.r0 === r0 && w.r1 === r1 && w.c0 === c0 && w.c1 === c1 ? w : { r0, r1, c0, c1 }));
  }, [n, rowH, headH, cols.length, xs, frozenW]);
  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    const el = sc.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  /* ---- position label while dragging the scrollbar (1a) or the phone handle (4a) ---- */
  const [drag, setDrag] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const raf = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(measure);
    if (compact) {
      setScrolling(true);
      clearTimeout(idle.current);
      idle.current = setTimeout(() => setScrolling(false), 1500);
    }
    if (drag) setTick((t) => t + 1);
  };
  const [, setTick] = useState(0);
  useEffect(() => () => (cancelAnimationFrame(raf.current), clearTimeout(idle.current)), []);
  useEffect(() => {
    if (!drag) return;
    const up = () => setDrag(false);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [drag]);
  const el = sc.current;
  const topRow = el ? Math.min(n, Math.floor(Math.max(0, el.scrollTop - headH) / rowH) + 1) : 1;
  const thumbY = el && el.scrollHeight > el.clientHeight ? (el.scrollTop / (el.scrollHeight - el.clientHeight)) * (el.clientHeight - 32) : 0;

  /* ---- Go to row (1b) ---- */
  const [flash, setFlash] = useState<string | null>(null);
  const goTo = (k: number) => {
    const i = Math.max(0, Math.min(n - 1, k - 1));
    if (!sc.current || !n) return;
    sc.current.scrollTop = i * rowH;
    measure();
    const id = rows[i].id;
    setFlash(id);
    setTimeout(() => setFlash((f) => (f === id ? null : f)), 1200);
    requestAnimationFrame(() => sc.current?.querySelector<HTMLElement>(`[data-row="${id}"] [data-focus]`)?.focus({ preventScroll: true }));
  };

  /* ---- selection and bulk edit (3a-3c, 4c) ---- */
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  const [selMode, setSelMode] = useState(false);
  const anchor = useRef<number | null>(null);
  const count = all ? n : sel.size;
  const clear = () => (setSel(new Set()), setAll(false), setSelMode(false));
  useEffect(clear, [ctx.rows.length === 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (i: number, e: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => {
    const id = rows[i].id;
    setAll(false);
    setSel((s) => {
      const next = new Set(all ? rows.map((r) => r.id) : s);
      if (e.shiftKey && anchor.current != null) {
        const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
        for (let k = a; k <= b; k++) next.add(rows[k].id);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchor.current = i;
  };
  const selectScreen = () => {
    setAll(false);
    setSel(new Set(rows.slice(win.r0, win.r1).map((r) => r.id)));
  };
  const selectedIds = () => (all ? rows.map((r) => r.id) : rows.filter((r) => sel.has(r.id)).map((r) => r.id));
  const [dialog, setDialog] = useState(false);
  const [run, setRun] = useState<(BulkRun & { label: string }) | null>(null);
  const cancelRef = useRef(false);
  const apply = async (fid: string, v: CellValue) => {
    const f = db.fields.find((x) => x.id === fid)!;
    const ids = selectedIds();
    cancelRef.current = false;
    setDialog(false);
    const label = `Updating ${f.name}`;
    setRun({ done: 0, total: ids.length, cancelled: false, label });
    const r = await bulkSet(ctx.doc, db.id, ids, fid, v, ctx.um, (p) => setRun({ ...p, label }), () => cancelRef.current);
    setRun(null);
    clear();
    ctx.env.toast(r.cancelled ? `Stopped: ${fmt(r.done)} of ${fmt(r.total)} rows updated` : `${f.name} set on ${fmt(r.done)} rows`, ctx.um ? { label: "Undo", run: () => ctx.um?.undo() } : undefined);
  };
  const del = async () => {
    const ids = selectedIds();
    cancelRef.current = false;
    const label = "Deleting rows";
    setRun({ done: 0, total: ids.length, cancelled: false, label });
    const r = await bulkDelete(ctx.doc, db.id, ids, ctx.um, (p) => setRun({ ...p, label }), () => cancelRef.current);
    setRun(null);
    clear();
    ctx.env.toast(`Deleted ${fmt(r.done)} rows`, ctx.um ? { label: "Undo", run: () => ctx.um?.undo() } : undefined);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
      e.preventDefault();
      ctx.goto.set(true);
    } else if (e.key === "Escape" && (count || selMode)) {
      e.stopPropagation();
      clear();
    }
  };

  /* ---- inline editing of text-like cells ---- */
  const [editing, setEditing] = useState<{ id: string; fid: string } | null>(null);
  const startEdit = (r: DbRow, f: DbField, target: HTMLElement) => {
    if (!edit || COMPUTED_TYPES.includes(f.type)) return;
    if (INLINE.has(f.type)) return setEditing({ id: r.id, fid: f.id });
    if (f.type === "checkbox") return setCell(ctx.doc, db.id, r.id, f.id, !r.v[f.id]);
    ctx.open({ kind: "cell", rowId: r.id, fid: f.id, anchor: target, key: `c${r.id}${f.id}` });
  };
  const commit = (r: DbRow, f: DbField, text: string) => {
    setEditing(null);
    const v = f.type === "number" ? (text.trim() === "" || !Number.isFinite(Number(text)) ? null : Number(text)) : text.trim() ? text : null;
    if (v !== (r.v[f.id] ?? null)) setCell(ctx.doc, db.id, r.id, f.id, v);
  };

  const rowsOut: ReactNode[] = [];
  for (let i = win.r0; i < Math.min(win.r1, n); i++) {
    const r = rows[i];
    rowsOut.push(
      <LRow
        key={r.id}
        r={r}
        i={i}
        y={headH + i * rowH}
        h={rowH}
        cols={cols}
        c0={win.c0}
        c1={win.c1}
        xs={xs}
        tf={tf}
        frozenW={frozenW}
        widthOf={widthOf}
        value={value}
        selected={all || sel.has(r.id)}
        flash={flash === r.id}
        editing={editing?.id === r.id ? editing.fid : null}
        compact={compact}
        selMode={selMode || count > 0}
        onToggle={toggle}
        onOpen={ctx.setPeek}
        onCell={startEdit}
        onCommit={commit}
        onCancel={() => setEditing(null)}
        onLong={(k) => (setSelMode(true), toggle(k, {}))}
      />,
    );
  }

  const bar = count || selMode ? (
    <div className="ocdb-lt-selbar" role="toolbar" aria-label="Selected rows">
      <span className="ocdb-lt-cnt" aria-live="polite">{fmt(count)} selected</span>
      {!all && count < n ? <button className="ocdb-btn sm ghost" onClick={() => (count ? setAll(true) : selectScreen())}>{count ? `Select all ${fmt(n)}${ctx.rows.length < db.rows.length ? " matching" : ""}` : "Select all"}</button> : null}
      {edit ? <button className="ocdb-btn sm" disabled={!count} onClick={() => setDialog(true)}><Ic i={Pencil} s={14} />{compact ? "Edit" : "Edit field"}</button> : null}
      {edit ? <button className="ocdb-btn sm danger" disabled={!count} onClick={del}><Ic i={Trash2} s={14} />Delete</button> : null}
      <button className="ocdb-btn sm ghost" aria-label="Clear selection" onClick={clear}><Ic i={X} s={14} /></button>
    </div>
  ) : null;

  return (
    <div className={"ocdb-lt" + (compact ? " phone" : "") + (busy ? " busy" : "")} onKeyDown={onKey}>
      <div className="ocdb-lt-top">
        <BusyChip busy={busy} />
      </div>
      {compact ? null : bar}
      <div
        ref={sc}
        className="ocdb-lt-sc"
        role="grid"
        aria-label={db.name || "Database"}
        aria-rowcount={n + 1}
        aria-colcount={cols.length + 2}
        aria-multiselectable={edit || undefined}
        tabIndex={0}
        onScroll={onScroll}
        onPointerDown={(e) => {
          // A press on the scrollbar itself (outside the client area) shows the position label.
          const b = e.currentTarget.getBoundingClientRect();
          if (e.clientX > b.left + e.currentTarget.clientWidth) setDrag(true);
        }}
      >
        <div className="ocdb-lt-sp" style={{ height: headH + n * rowH, width: compact ? "100%" : totalW }}>
          {compact ? null : (
            <div className="ocdb-lt-hd" role="row" aria-rowindex={1} style={{ height: headH, width: totalW }}>
              <div className="ocdb-lt-fz" style={{ width: frozenW }}>
                <span role="columnheader" className="ocdb-lt-num">
                  {edit ? (
                    <button className="ocdb-lt-ck" role="checkbox" aria-checked={all ? true : count ? "mixed" : false} aria-label="Select the rows on screen" onClick={() => (count ? clear() : selectScreen())} />
                  ) : "#"}
                </span>
                {tf ? <span role="columnheader" className="ocdb-lt-h" style={{ width: widthOf(tf) }}>{tf.name}</span> : null}
              </div>
              {cols.slice(win.c0, win.c1).map((f, j) => (
                <span key={f.id} role="columnheader" aria-colindex={win.c0 + j + 3} className="ocdb-lt-h" style={{ left: xs[win.c0 + j], width: widthOf(f) }}>{f.name}</span>
              ))}
            </div>
          )}
          {rowsOut}
        </div>
      </div>
      {drag || (compact && scrolling) ? (
        <span className="ocdb-lt-pos" aria-hidden="true" style={{ top: thumbY + (compact ? 0 : 40) }}>
          {compact ? `Row ${fmt(topRow)}` : `Row ${fmt(topRow)} of ${fmt(n)}`}
        </span>
      ) : null}
      {compact && scrolling ? (
        <span
          className="ocdb-lt-grab"
          style={{ top: thumbY }}
          aria-hidden="true"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setDrag(true);
          }}
          onPointerMove={(e) => {
            const s = sc.current;
            if (!drag || !s) return;
            const b = s.getBoundingClientRect();
            s.scrollTop = ((e.clientY - b.top) / b.height) * (s.scrollHeight - s.clientHeight);
          }}
        />
      ) : null}
      {compact ? bar : null}
      {ctx.goto.open ? <GoTo n={n} onGo={(k) => (ctx.goto.set(false), goTo(k))} onClose={() => ctx.goto.set(false)} /> : null}
      {dialog ? <BulkDialog ctx={ctx} count={count} onApply={apply} onClose={() => setDialog(false)} /> : null}
      {run ? (
        <div className="ocdb-lt-run" role="status">
          {run.label} · {fmt(run.done)} of {fmt(run.total)}
          <i style={{ width: (run.done / Math.max(1, run.total)) * 100 + "%" }} />
          <button className="ocdb-btn sm ghost" onClick={() => (cancelRef.current = true)}>Cancel</button>
        </div>
      ) : null}
    </div>
  );
}

interface LRowProps {
  r: DbRow;
  i: number;
  y: number;
  h: number;
  cols: DbField[];
  c0: number;
  c1: number;
  xs: number[];
  tf: DbField | undefined;
  frozenW: number;
  widthOf: (f: DbField) => number;
  value: LargeProps["value"];
  selected: boolean;
  flash: boolean;
  editing: string | null;
  compact: boolean;
  selMode: boolean;
  onToggle: (i: number, e: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => void;
  onOpen: (rid: string) => void;
  onCell: (r: DbRow, f: DbField, el: HTMLElement) => void;
  onCommit: (r: DbRow, f: DbField, text: string) => void;
  onCancel: () => void;
  onLong: (i: number) => void;
}

const LRow = memo(function LRow(p: LRowProps) {
  const { r, i, tf } = p;
  const title = String(r.v[tf?.id ?? ""] ?? "") || "Untitled";
  const cls = "ocdb-lt-r" + (p.selected ? " sel" : "") + (p.flash ? " flash" : "");
  const style = { transform: `translateY(${p.y}px)`, height: p.h };
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const long = useRef(false);
  if (p.compact) {
    // Phone: the card list. Long-press starts selecting; then taps toggle (4c).
    const meta = p.cols.filter((f) => f.type === "status" || f.type === "person" || f.type === "date").slice(0, 3);
    return (
      <div className={cls} style={style} role="row" aria-rowindex={i + 2} aria-selected={p.selected} data-row={r.id}>
        {/* A row needs a cell (axe: aria-required-children); the card fills it. */}
        <div role="gridcell" className="ocdb-lt-cardc">
        <button
          className="ocdb-lt-card"
          data-focus
          onPointerDown={() => {
            long.current = false;
            press.current = setTimeout(() => ((long.current = true), p.onLong(i)), 500);
          }}
          onPointerUp={() => clearTimeout(press.current)}
          onPointerLeave={() => clearTimeout(press.current)}
          onClick={(e) => {
            // The click that ends a long press is not a tap: it would toggle the row it just selected.
            if (long.current) return void (long.current = false);
            if (p.selMode) p.onToggle(i, e);
            else p.onOpen(r.id);
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span className="t"><b>#{fmt(i + 1)}</b> {title}</span>
          <span className="m">{meta.map((f) => <span key={f.id}>{p.value(f, r.v[f.id])}</span>)}</span>
        </button>
        </div>
      </div>
    );
  }
  const cell = (f: DbField, left: number | null, w: number, ci: number) => {
    const v = r.v[f.id];
    const isEdit = p.editing === f.id;
    const st = left == null ? { width: w } : { left, width: w };
    return (
      <span
        key={f.id}
        role="gridcell"
        aria-colindex={ci}
        className={"ocdb-lt-c" + (left == null ? " fz" : "") + (f.type === "number" || f.type === "formula" || f.type === "rollup" ? " num" : "")}
        style={st}
        tabIndex={-1}
        onDoubleClick={(e) => p.onCell(r, f, e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isEdit) {
            e.preventDefault();
            p.onCell(r, f, e.currentTarget);
          }
        }}
        onClick={(e) => {
          if (f.type !== "title" && f.type !== "text" && f.type !== "number" && f.type !== "url") p.onCell(r, f, e.currentTarget);
        }}
      >
        {isEdit ? (
          <input
            className="ocdb-lt-in"
            autoFocus
            defaultValue={v == null ? "" : String(v)}
            aria-label={f.name}
            inputMode={f.type === "number" ? "decimal" : undefined}
            onBlur={(e) => p.onCommit(r, f, e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") p.onCommit(r, f, e.currentTarget.value);
              if (e.key === "Escape") (e.stopPropagation(), p.onCancel());
            }}
          />
        ) : (
          p.value(f, v as CellValue | undefined)
        )}
      </span>
    );
  };
  return (
    <div className={cls} style={style} role="row" aria-rowindex={i + 2} aria-selected={p.selected} data-row={r.id}>
      <div className="ocdb-lt-fz" style={{ width: p.frozenW }}>
        {/* The row header is a cell; the toggle inside it carries the pressed state (axe: aria-allowed-attr). */}
        <span role="rowheader" className="ocdb-lt-num">
          <button
            className="ocdb-lt-nb"
            data-focus
            aria-label={`Row ${i + 1}, ${title}. ${p.selected ? "Selected" : "Select"}`}
            aria-pressed={p.selected}
            onClick={(e) => p.onToggle(i, e)}
          >
            {fmt(i + 1)}
          </button>
        </span>
        {tf ? cell(tf, null, p.widthOf(tf), 2) : null}
      </div>
      {p.cols.slice(p.c0, p.c1).map((f, j) => cell(f, p.xs[p.c0 + j], p.widthOf(f), p.c0 + j + 3))}
    </div>
  );
});

function GoTo({ n, onGo, onClose }: { n: number; onGo: (k: number) => void; onClose: () => void }) {
  const [v, setV] = useState("");
  const k = Math.round(Number(v));
  const ok = v.trim() !== "" && k >= 1 && k <= n;
  return (
    <div className="ocdb-lt-goto" role="dialog" aria-label="Go to row" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
      <label>
        Go to row
        <input
          className="ocdb-pin"
          autoFocus
          inputMode="numeric"
          value={v}
          aria-describedby="ocdb-goto-h"
          onChange={(e) => setV(e.target.value.replace(/[^\d]/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && ok && onGo(k)}
        />
      </label>
      <span id="ocdb-goto-h" className="ocdb-hintk">1 to {fmt(n)} · Enter to go</span>
      <div className="ocdb-fx-ft">
        <button className="ocdb-btn sm ghost" onClick={() => onGo(1)}><Ic i={ArrowUpToLine} s={14} />Top</button>
        <button className="ocdb-btn sm ghost" onClick={() => onGo(n)}><Ic i={ArrowDownToLine} s={14} />Bottom</button>
        <button className="ocdb-btn sm primary" disabled={!ok} onClick={() => onGo(k)}>Go</button>
      </div>
    </div>
  );
}

/** Set one field to one value on the selected rows (3b). */
function BulkDialog({ ctx, count, onApply, onClose }: { ctx: LargeCtx; count: number; onApply: (fid: string, v: CellValue) => void; onClose: () => void }) {
  const editable = ctx.db.fields.filter((f) => !COMPUTED_TYPES.includes(f.type) && f.type !== "relation");
  const [fid, setFid] = useState(editable.find((f) => f.type === "status")?.id ?? editable[0]?.id ?? "");
  const f = editable.find((x) => x.id === fid);
  const [raw, setRaw] = useState("");
  const val = (): CellValue => {
    if (!f) return null;
    if (f.type === "checkbox") return raw === "true";
    if (f.type === "number" || f.type === "progress") return raw.trim() === "" ? null : Number(raw);
    if (f.type === "tags") return raw ? [raw] : [];
    return raw.trim() ? raw : null;
  };
  const filtered = ctx.rows.length < ctx.db.rows.length;
  let control: ReactNode;
  if (f && (f.options?.length || f.type === "checkbox" || f.type === "person")) {
    const opts = f.type === "checkbox" ? [{ v: "true", l: "Checked" }, { v: "false", l: "Unchecked" }] : f.type === "person" ? ctx.people.pickable.map((u) => ({ v: u.id, l: u.name })) : (f.options ?? []).map((o) => ({ v: o.v, l: o.v }));
    control = (
      <select value={raw} onChange={(e) => setRaw(e.target.value)} aria-label="New value">
        <option value="">Empty</option>
        {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    );
  } else control = <input className="ocdb-pin" aria-label="New value" type={f?.type === "date" ? "date" : f?.type === "number" || f?.type === "progress" ? "number" : "text"} value={raw} onChange={(e) => setRaw(e.target.value)} />;
  return (
    <div className="ocdb-lt-dlg ocdb-setup" role="dialog" aria-modal="true" aria-label={`Edit ${fmt(count)} rows`} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
      <div className="ocdb-fx-h">Edit {fmt(count)} rows</div>
      {filtered ? <p className="note">All rows in the current filter.</p> : null}
      <label>Field
        <select value={fid} onChange={(e) => (setFid(e.target.value), setRaw(""))} autoFocus>{editable.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      </label>
      <label>New value{control}</label>
      {filtered ? <p className="note">Rows can leave this filter once they change.</p> : null}
      <p className="note">Undo with Ctrl Z reverts all {fmt(count)} at once.</p>
      <div className="ocdb-fx-ft">
        <button className="ocdb-btn sm" onClick={onClose}>Cancel</button>
        <button className="ocdb-btn sm primary" disabled={!f} onClick={() => f && onApply(f.id, val())}>Set {f?.name ?? "field"} on {fmt(count)} rows</button>
      </div>
    </div>
  );
}
