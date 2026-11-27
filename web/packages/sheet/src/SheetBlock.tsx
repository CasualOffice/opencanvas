// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The Spreadsheet block's grid (SHEET-04, prototype v04-approved/spreadsheet.html frames 1-5).
// A virtualized DOM grid inside one scroller: the scroller is the ARIA grid and the focus target
// (aria-activedescendant names the active cell); headers and frozen panes ride on a sticky layer
// on top of it, so the wheel, touch and keyboard scroll everything as one. Values come from the
// engine (crates/oc-sheet over WASM); what people type is stored in the Yjs model (model.ts) and
// every change, local or remote, reaches the engine through one observer.

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as Y from "yjs";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownAZ,
  ArrowUpZA,
  Baseline,
  Bold,
  ChartColumn,
  Database as DatabaseIcon,
  ChevronDown,
  ChevronUp,
  Euro,
  Funnel,
  Grid2x2,
  Italic,
  Search,
  TableCellsMerge,
  WrapText,
  Lock,
  Maximize2,
  PaintBucket,
  Percent,
  Plus,
  Redo2,
  Sheet as SheetIcon,
  Snowflake,
  Strikethrough,
  Undo2,
  X,
} from "lucide-react";
import type { BlockEnv } from "@opencanvas/ui";
import { loadSheetEngine, type SheetEngine } from "./engine/engine";
import {
  addSheet,
  blockMap,
  deleteCols,
  deleteRows,
  deleteSheet,
  insertCols,
  insertRows,
  patchStyle,
  readFilter,
  readSheets,
  readStyle,
  renameSheet,
  reorderRows,
  setFilter,
  setFreeze,
  setInput,
  setSize,
  setStyle,
  sheetOf,
  countRefs,
  moveIds,
  moveSheet,
  readHidden,
  readMerges,
  setHidden,
  setMerge,
  setSheetColor,
  sheetsRoot,
  type SheetFilter,
} from "./model";
import {
  a1,
  aggregate,
  at,
  colName,
  dateSerial,
  decimalsOf,
  fill,
  fillTarget,
  formatValue,
  inRect,
  indexAt,
  isError,
  isNumber,
  navigate,
  offsets,
  parseHtmlTable,
  parseRef,
  parseTsv,
  pastedValue,
  rectA1,
  rectOf,
  toHtml,
  toTsv,
  type CellStyle,
  type PastedCell,
  type Pos,
  type Rect,
  type Sel,
} from "./grid/logic";
import { injectCss } from "./styles";
import { borderEdges, mergeHits, Pattern, type BorderKind } from "./grid/opencalc";

/** Default sizes, rem (prototype `.ss-r`, `.ss-hr`). */
export const DEF_W = 6.25;
export const DEF_H = 1.75;
const HDR = 1.5;
const MIN_W = 1.5;
const MIN_H = 1;
/** Origin of this block's edits: the undo manager tracks it. */
export const SHEET_ORIGIN = "oc-sheet";

const TONES = ["gray", "blue", "green", "amber", "red", "purple", "pink"] as const;
const colour = (v: string | undefined, kind: "fg" | "bg") => (!v ? undefined : (TONES as readonly string[]).includes(v) ? `var(--${v}-${kind})` : v);

/** The parts of y-protocols' Awareness this block uses (peer selections, SHEET-05). */
export interface AwarenessLike {
  clientID: number;
  getStates(): Map<number, Record<string, unknown>>;
  getLocalState(): Record<string, unknown> | null;
  setLocalStateField(k: string, v: unknown): void;
  on(e: "change", f: () => void): void;
  off(e: "change", f: () => void): void;
}

interface Props {
  doc: Y.Doc;
  blockId: string;
  env: BlockEnv;
  awareness?: AwarenessLike;
}

interface Edit {
  sheet: string;
  r: number;
  c: number;
  draft: string;
  /** enter: typing replaced the cell (arrows commit); edit: F2, double click, the bar. */
  mode: "enter" | "edit";
  bar?: boolean;
}

interface MenuItem {
  label: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  run: () => void;
}
type MenuEntry = MenuItem | "sep";
interface MenuState {
  x: number;
  y: number;
  /** Built at render, so the items act on the selection as it is now. */
  items?: MenuEntry[] | "row" | "col" | "cell";
  body?: ReactNode;
  label: string;
}

/** What a copy inside OpenCanvas leaves for its own paste (formulas, styles). */
interface Clip {
  token: string;
  rect: Rect;
  cells: { in: string; st?: CellStyle }[][];
}
let clip: Clip | null = null;

let rp = 16;
const remPx = () => {
  if (typeof document === "undefined") return 16;
  rp = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return rp;
};

/** Re-renders on every change to this block (local or remote) and keeps the engine in step. */
function useBlock(doc: Y.Doc, blockId: string, toast: BlockEnv["toast"], onRefLost?: (keys: string[]) => void) {
  const lostRef = useRef(onRefLost);
  lostRef.current = onRefLost;
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const [engine, setEngine] = useState<SheetEngine | null>(null);
  const shown = useRef(new Map<string, string>());
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const reopen = useCallback(
    (e: SheetEngine) => {
      shown.current = new Map();
      try {
        for (const [s, r, c, v] of e.open(blockId, readSheets(doc, blockId))) shown.current.set(`${s}:${r}:${c}`, v);
      } catch {
        /* an empty or broken block shows its inputs */
      }
    },
    [doc, blockId],
  );
  useEffect(() => {
    let off = false;
    let got: SheetEngine | null = null;
    loadSheetEngine().then(
      (e) => {
        if (off) return;
        got = e;
        reopen(e);
        setEngine(e);
      },
      () => !off && toastRef.current("The spreadsheet engine couldn't load. Values show when you reconnect."),
    );
    return () => {
      off = true;
      try {
        got?.close(blockId);
      } catch {
        /* already closed */
      }
    };
  }, [blockId, reopen]);
  useEffect(() => {
    const root = sheetsRoot(doc);
    const h = (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction) => {
      let mine = false;
      let structural = false;
      const cells: [string, string][] = [];
      for (const ev of events) {
        const p = ev.path as (string | number)[];
        if (!p.length) {
          if ((ev as Y.YMapEvent<unknown>).keysChanged.has(blockId)) (mine = true, (structural = true));
          continue;
        }
        if (p[0] !== blockId) continue;
        mine = true;
        if (p[1] === "styles") continue;
        if (p[1] === "sheets" && p[3] === "cells") {
          if (p.length === 4) for (const k of (ev as Y.YMapEvent<unknown>).keysChanged) cells.push([String(p[2]), k]);
          else cells.push([String(p[2]), String(p[4])]);
          continue;
        }
        if (p[1] === "sheets" && (p[3] === "widths" || p[3] === "heights" || p[3] === "freeze")) continue;
        if (p[1] === "sheets" && p.length === 3 && [...(ev as Y.YMapEvent<unknown>).keysChanged].every((k) => k === "filter" || k === "color" || k.startsWith("m:") || k.startsWith("h:"))) continue;
        structural = true;
      }
      if (!mine) return;
      if (engine) {
        if (structural) {
          // A change from someone else (live, or merged on reconnect) that turns formulas into
          // #REF! is named, so it does not go unnoticed (frame 10b).
          const before = tr.local ? null : new Set([...shown.current].filter(([, v]) => v.startsWith("#REF!")).map(([k]) => k));
          reopen(engine);
          if (before) {
            const lost = [...shown.current].filter(([k, v]) => v.startsWith("#REF!") && !before.has(k)).map(([k]) => k);
            if (lost.length) lostRef.current?.(lost);
          }
        } else
          try {
            for (const [s, key] of cells) {
              const [r, c] = key.split(":");
              const cell = (sheetOf(doc, blockId, s)?.get("cells") as Y.Map<Y.Map<unknown>> | undefined)?.get(key);
              const v = cell?.get("in");
              for (const [ss, rr, cc, d] of engine.set(blockId, s, r, c, typeof v === "string" ? v : "")) {
                if (d === "") shown.current.delete(`${ss}:${rr}:${cc}`);
                else shown.current.set(`${ss}:${rr}:${cc}`, d);
              }
            }
          } catch {
            reopen(engine);
          }
      }
      bump();
    };
    root.observeDeep(h);
    return () => root.unobserveDeep(h);
  }, [doc, blockId, engine, reopen]);
  return { version, engine, shown };
}

/** One sheet as the grid reads it, rebuilt on each change. */
interface View {
  id: string;
  name: string;
  rows: string[];
  cols: string[];
  cells: Y.Map<Y.Map<unknown>>;
  widths: Y.Map<number>;
  heights: Y.Map<number>;
  fr: number;
  fc: number;
  /** id -> index */
  rIx: Map<string, number>;
  cIx: Map<string, number>;
}

function readView(doc: Y.Doc, block: string, sheet: string): View | null {
  const s = sheetOf(doc, block, sheet);
  if (!s) return null;
  const fz = s.get("freeze") as Y.Map<number>;
  const rows = (s.get("rows") as Y.Array<string>).toArray();
  const cols = (s.get("cols") as Y.Array<string>).toArray();
  return {
    id: sheet,
    name: String(s.get("name") ?? ""),
    rows,
    cols,
    cells: s.get("cells") as Y.Map<Y.Map<unknown>>,
    widths: s.get("widths") as Y.Map<number>,
    heights: s.get("heights") as Y.Map<number>,
    rIx: new Map(rows.map((id, i) => [id, i])),
    cIx: new Map(cols.map((id, i) => [id, i])),
    fr: Math.min(Number(fz?.get("rows") ?? 0) || 0, rows.length - 1),
    fc: Math.min(Number(fz?.get("cols") ?? 0) || 0, cols.length - 1),
  };
}

const quoteSheet = (n: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`);
const POINT_AFTER = /[=(,+\-*/^&<>:;]\s*$/;

export function SheetBlock({ doc, blockId, env, awareness }: Props) {
  injectCss();
  const refLost = useRef<((keys: string[]) => void) | null>(null);
  const { version, engine, shown } = useBlock(doc, blockId, env.toast, (k) => refLost.current?.(k));
  /** Phone layout (frames 9a-9b): taller rows, the bar edits, insert keys, an action bar. */
  const phone = env.compact;
  const defH = phone ? 2.75 : DEF_H;
  const fxRef = useRef<HTMLInputElement | null>(null);
  const canEdit = env.role === "edit";
  const order = useMemo(() => ((blockMap(doc, blockId)?.get("order") as Y.Array<string> | undefined)?.toArray() ?? []), [doc, blockId, version]);
  const [sheetSel, setSheetSel] = useState<string | null>(null);
  const sheet = sheetSel && order.includes(sheetSel) ? sheetSel : order[0];
  const view = useMemo(() => (sheet ? readView(doc, blockId, sheet) : null), [doc, blockId, sheet, version]);
  const [sel, setSel] = useState<Sel>(at(0, 0));
  const [edit, setEdit] = useState<Edit | null>(null);
  const [full, setFull] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [note, setNote] = useState<{ text: string; values?: () => void } | null>(null);
  const [fillTo, setFillTo] = useState<Rect | null>(null);
  const [live, setLive] = useState<{ kind: "w" | "h"; i: number; v: number } | null>(null);
  const [localFilter, setLocalFilter] = useState<SheetFilter | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [moveTo, setMoveTo] = useState<{ kind: "r" | "c"; at: number } | null>(null);
  const [tabDrop, setTabDrop] = useState<number | null>(null);
  /** Find and replace (4f): the bar's state. Matching is OpenCalc's Pattern. */
  const [find, setFind] = useState<{ q: string; by: string; replace: boolean; mc: boolean; whole: boolean; formulas: boolean; all: boolean } | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const valuesOnly = useRef(false);

  /* ---- undo: this person's own steps (env.undoManager joins the canvas stack) ---- */
  const shared = env.undoManager;
  const um = useMemo(() => {
    const m = blockMap(doc, blockId);
    if (!m) return null;
    if (shared) {
      shared.addToScope(m);
      shared.trackedOrigins.add(SHEET_ORIGIN);
      return shared;
    }
    return new Y.UndoManager(m, { trackedOrigins: new Set([SHEET_ORIGIN]), captureTimeout: 400 });
  }, [doc, blockId, shared, version === 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => void (um && um !== shared && um.destroy()), [um, shared]);
  const act = useCallback(
    (f: () => void) => {
      um?.stopCapturing();
      doc.transact(f, SHEET_ORIGIN);
    },
    [doc, um],
  );

  /* ---- geometry (rem) ---- */
  const filter = canEdit ? (sheet ? readFilter(doc, blockId, sheet) : null) : localFilter ?? (sheet ? readFilter(doc, blockId, sheet) : null);
  const display = useCallback(
    (r: number, c: number, v: View | null = view): string => {
      if (!v) return "";
      const rid = v.rows[r];
      const cid = v.cols[c];
      const got = shown.current.get(`${v.id}:${rid}:${cid}`);
      if (got != null) return got;
      const raw = v.cells.get(`${rid}:${cid}`)?.get("in");
      return typeof raw === "string" && !raw.startsWith("=") ? raw : "";
    },
    [view, shown, version], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const hidden = useMemo(() => {
    const out = new Set<number>();
    if (!view || !filter) return out;
    const hr = view.rows.indexOf(filter.row);
    if (hr < 0) return out;
    const cols = Object.entries(filter.hide)
      .map(([cid, vals]) => [view.cols.indexOf(cid), new Set(vals)] as const)
      .filter(([c, v]) => c >= 0 && v.size);
    if (!cols.length) return out;
    let last = hr;
    view.cells.forEach((_, k) => {
      const r = view.rIx.get(k.split(":")[0]) ?? -1;
      if (r > last) last = r;
    });
    for (let r = hr + 1; r <= last; r++) if (cols.some(([c, vals]) => vals.has(display(r, c)))) out.add(r);
    return out;
  }, [view, filter, display]);
  /** Rows and columns hidden by hand (4d), by id. */
  const handHidden = useMemo(() => (sheet ? readHidden(doc, blockId, sheet) : new Set<string>()), [doc, blockId, sheet, version]);
  const hiddenRows = useMemo(() => {
    const out = new Set(hidden);
    if (view) for (const id of handHidden) if (view.rIx.has(id)) out.add(view.rIx.get(id)!);
    return out;
  }, [hidden, handHidden, view]);
  const hiddenCols = useMemo(() => {
    const out = new Set<number>();
    if (view) for (const id of handHidden) if (view.cIx.has(id)) out.add(view.cIx.get(id)!);
    return out;
  }, [handHidden, view]);
  /** Merged ranges (3b) by index: anchors and the cells they cover. */
  const merges = useMemo(() => {
    const list: Rect[] = [];
    const anchor = new Map<string, Rect>();
    const covered = new Map<string, Rect>();
    if (!view || !sheet) return { list, anchor, covered };
    for (const [ra, ca, rb, cb] of readMerges(doc, blockId, sheet)) {
      const r0m: number | undefined = view.rIx.get(ra);
      const c0m: number | undefined = view.cIx.get(ca);
      const r1m: number | undefined = view.rIx.get(rb);
      const c1m: number | undefined = view.cIx.get(cb);
      if (r0m == null || c0m == null || r1m == null || c1m == null || r1m < r0m || c1m < c0m) continue;
      const m = { r0: r0m, c0: c0m, r1: r1m, c1: c1m };
      list.push(m);
      anchor.set(`${r0m}:${c0m}`, m);
      for (let rr: number = r0m; rr <= r1m; rr++) for (let cc: number = c0m; cc <= c1m; cc++) if (rr !== r0m || cc !== c0m) covered.set(`${rr}:${cc}`, m);
    }
    return { list, anchor, covered };
  }, [doc, blockId, sheet, view, version]);
  const colW = useMemo(
    () => (view ? view.cols.map((id, i) => (hiddenCols.has(i) ? 0 : live?.kind === "w" && live.i === i ? live.v : view.widths.get(id) ?? DEF_W)) : []),
    [view, live, hiddenCols],
  );
  const rowH = useMemo(
    () => (view ? view.rows.map((id, i) => (hiddenRows.has(i) ? 0 : live?.kind === "h" && live.i === i ? live.v : view.heights.get(id) ?? defH)) : []),
    [view, live, hiddenRows, defH],
  );
  const colOff = useMemo(() => offsets(colW), [colW]);
  const rowOff = useMemo(() => offsets(rowH), [rowH]);
  const nR = view?.rows.length ?? 0;
  const nC = view?.cols.length ?? 0;
  const RHW = Math.max(2.75, 1 + String(nR).length * 0.5);
  const fr = view?.fr ?? 0;
  const fc = view?.fc ?? 0;
  const frozenW = colOff[fc] ?? 0;
  const frozenH = rowOff[fr] ?? 0;

  /* ---- scroll and viewport (px) ---- */
  const [vp, setVp] = useState({ w: 600, h: 320, sx: 0, sy: 0 });
  const raf = useRef(0);
  const panesX = useRef<HTMLDivElement[]>([]);
  const panesY = useRef<HTMLDivElement[]>([]);
  const onScroll = () => {
    const el = gridRef.current;
    if (!el) return;
    const sx = el.scrollLeft;
    const sy = el.scrollTop;
    for (const p of panesX.current) if (p) p.style.transform = `translateX(${-sx}px)`;
    for (const p of panesY.current) if (p) p.style.transform = `translateY(${-sy}px)`;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setVp((v) => ({ ...v, sx, sy })));
  };
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    remPx();
    const ro = new ResizeObserver(() => {
      remPx();
      setVp((v) => ({ ...v, w: el.clientWidth, h: el.clientHeight }));
    });
    ro.observe(el);
    setVp((v) => ({ ...v, w: el.clientWidth, h: el.clientHeight, sx: el.scrollLeft, sy: el.scrollTop }));
    return () => ro.disconnect();
  }, [full, !!view]); // eslint-disable-line react-hooks/exhaustive-deps

  const gridApi = useMemo(
    () => ({
      rows: nR,
      cols: nC,
      filled: (r: number, c: number) => display(r, c) !== "",
      hidden: (r: number) => hiddenRows.has(r),
      hiddenCol: (c: number) => hiddenCols.has(c),
      page: Math.max(1, Math.floor(vp.h / rp / DEF_H) - 2),
    }),
    [nR, nC, display, hiddenRows, hiddenCols, vp.h],
  );

  /** Scrolls the body so cell (r, c) is visible (frozen cells always are). */
  const reveal = useCallback(
    (p: Pos) => {
      const el = gridRef.current;
      if (!el || !view) return;
      const px = (rem: number) => rem * rp;
      if (p.c >= fc) {
        const x0 = px(RHW + colOff[p.c]);
        const x1 = px(RHW + colOff[p.c + 1]);
        const left = el.scrollLeft + px(RHW + frozenW);
        const right = el.scrollLeft + el.clientWidth;
        if (x0 < left) el.scrollLeft = x0 - px(RHW + frozenW);
        else if (x1 > right) el.scrollLeft = x1 - el.clientWidth + 2;
      }
      if (p.r >= fr) {
        const y0 = px(HDR + rowOff[p.r]);
        const y1 = px(HDR + rowOff[p.r + 1]);
        const top = el.scrollTop + px(HDR + frozenH);
        const bottom = el.scrollTop + el.clientHeight;
        if (y0 < top) el.scrollTop = y0 - px(HDR + frozenH);
        else if (y1 > bottom) el.scrollTop = y1 - el.clientHeight + 2;
      }
    },
    [view, fc, fr, RHW, colOff, rowOff, frozenW, frozenH],
  );

  const clampSel = (s: Sel): Sel => {
    const k = (p: Pos) => ({ r: Math.max(0, Math.min(nR - 1, p.r)), c: Math.max(0, Math.min(nC - 1, p.c)) });
    return { anchor: k(s.anchor), focus: k(s.focus), range: s.range };
  };
  const select = (s: Sel, show = true) => {
    const n = clampSel(s);
    const m = merges.covered.get(`${n.anchor.r}:${n.anchor.c}`);
    if (m && !s.range && n.anchor.r === n.focus.r && n.anchor.c === n.focus.c) (n.anchor = { r: m.r0, c: m.c0 }), (n.focus = n.anchor);
    setSel(n);
    if (show) requestAnimationFrame(() => reveal(n.focus));
  };
  refLost.current = (keys) => {
    const n = keys.length;
    env.toast(`${n} ${n === 1 ? "formula now shows" : "formulas now show"} #REF!: a row, column or sheet ${n === 1 ? "it" : "they"} used was deleted.`, {
      label: "Show",
      run: () => {
        const [s0, r, c] = keys[0].split(":");
        const v = readView(doc, blockId, s0);
        if (!v) return;
        setSheetSel(s0);
        select(at(v.rIx.get(r) ?? 0, v.cIx.get(c) ?? 0));
        gridRef.current?.focus({ preventScroll: true });
      },
    });
  };
  useEffect(() => {
    if (sel.anchor.r >= nR || sel.anchor.c >= nC || sel.focus.r >= nR || sel.focus.c >= nC) setSel((s) => clampSel(s));
  }, [nR, nC]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- reading cells ---- */
  const styleCache = useMemo(() => new Map<string, CellStyle | undefined>(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const styleAt = useCallback(
    (r: number, c: number, v: View | null = view): CellStyle | undefined => {
      if (!v) return undefined;
      const k = v.cells.get(`${v.rows[r]}:${v.cols[c]}`)?.get("s");
      if (typeof k !== "string") return undefined;
      if (!styleCache.has(k)) styleCache.set(k, readStyle<CellStyle>(doc, blockId, k));
      return styleCache.get(k);
    },
    [view, styleCache, doc, blockId],
  );
  /** A cell's input as typed: formulas in A1 against the current order. */
  const inputAt = useCallback(
    (r: number, c: number, v: View | null = view): string => {
      if (!v) return "";
      const raw = v.cells.get(`${v.rows[r]}:${v.cols[c]}`)?.get("in");
      if (typeof raw !== "string") return "";
      if (!raw.startsWith("=") || !engine) return raw;
      try {
        return engine.toA1(raw, v.id, readSheets(doc, blockId));
      } catch {
        return raw;
      }
    },
    [view, engine, doc, blockId],
  );

  /* ---- writing cells ---- */
  /** Typed text to stored form: formulas to ids, 15% / €4,200 / 2026-03-14 to numbers with a format. */
  const toStored = (typed: string, sheetId: string, sheets = readSheets(doc, blockId)): { stored: string; nf?: CellStyle["nf"] } => {
    const t = typed.trim() === "" ? "" : typed;
    if (t.startsWith("=")) {
      if (!engine) return { stored: t };
      try {
        return { stored: engine.toIds(t, sheetId, sheets) };
      } catch {
        return { stored: t };
      }
    }
    const d = dateSerial(t);
    if (d != null) return { stored: String(d), nf: "date" };
    const p = pastedValue(t);
    return { stored: p.v === t.trim() && !p.nf ? t : p.v, nf: p.nf };
  };
  const writeCell = (v: View, r: number, c: number, typed: string, sheets?: ReturnType<typeof readSheets>) => {
    const { stored, nf } = toStored(typed, v.id, sheets);
    setInput(doc, blockId, v.id, v.rows[r], v.cols[c], stored);
    if (nf && !styleAt(r, c, v)?.nf) patchStyle(doc, blockId, v.id, [[v.rows[r], v.cols[c]]], { nf });
  };

  const commit = (move?: [number, number]) => {
    if (!edit) return;
    const v = readView(doc, blockId, edit.sheet);
    if (v && canEdit && edit.draft !== inputAt(edit.r, edit.c, v)) act(() => writeCell(v, edit.r, edit.c, edit.draft));
    setEdit(null);
    if (edit.sheet !== sheet) setSheetSel(edit.sheet);
    const base = edit.sheet !== sheet ? at(edit.r, edit.c) : sel;
    if (move) {
      const k = move[0] ? (move[0] > 0 ? "Enter" : "Enter") : "Tab";
      const n = navigate(gridApi, base, { key: k, shift: move[0] < 0 || move[1] < 0 });
      if (n) select(n);
    }
    gridRef.current?.focus({ preventScroll: true });
  };
  const cancel = () => {
    if (edit && edit.sheet !== sheet) setSheetSel(edit.sheet);
    setEdit(null);
    gridRef.current?.focus({ preventScroll: true });
  };
  const startEdit = (draft: string | null, mode: Edit["mode"], bar = false) => {
    if (!canEdit || !view) return;
    const p = sel.anchor;
    setEdit({ sheet: view.id, r: p.r, c: p.c, draft: draft ?? inputAt(p.r, p.c), mode, bar });
    reveal(p);
  };

  const selIds = (q: Rect, v: View = view!): [string, string][] => {
    const out: [string, string][] = [];
    for (let r = q.r0; r <= q.r1; r++) for (let c = q.c0; c <= q.c1; c++) out.push([v.rows[r], v.cols[c]]);
    return out;
  };
  /** Clears inputs in `q` inside the caller's transaction (merge keeps the top-left). */
  const clearRectRaw = (q: Rect, keepFirst = false) => {
    if (!view) return;
    view.cells.forEach((cell, k) => {
      const [rid, cid] = k.split(":");
      const r = view.rIx.get(rid) ?? -1;
      const c = view.cIx.get(cid) ?? -1;
      if (keepFirst && r === q.r0 && c === q.c0) return;
      if (r >= 0 && c >= 0 && inRect(q, r, c) && cell.get("in")) setInput(doc, blockId, view.id, rid, cid, "");
    });
  };
  const clearRect = (q: Rect) => {
    if (!view || !canEdit) return;
    act(() => {
      view.cells.forEach((cell, k) => {
        const [rid, cid] = k.split(":");
        const r = view.rIx.get(rid) ?? -1;
        const c = view.cIx.get(cid) ?? -1;
        if (r >= 0 && c >= 0 && inRect(q, r, c) && cell.get("in")) setInput(doc, blockId, view.id, rid, cid, "");
      });
    });
  };
  const style = (patch: Partial<Record<keyof CellStyle, unknown>>) => {
    if (!view || !canEdit) return;
    act(() => patchStyle(doc, blockId, view.id, selIds(rectOf(sel)), patch));
  };
  const borders = (kind: BorderKind) => {
    if (!view || !canEdit) return;
    const q0 = rectOf(sel);
    const w = kind === "bottomthick" ? 2 : 1;
    act(() => {
      for (let r = q0.r0; r <= q0.r1; r++)
        for (let c = q0.c0; c <= q0.c1; c++) {
          const cell: [string, string][] = [[view.rows[r], view.cols[c]]];
          if (kind === "none") {
            patchStyle(doc, blockId, view.id, cell, { bt: null, bb: null, bl: null, br: null });
            continue;
          }
          const [t, b, l, rt] = borderEdges(kind, r, c, q0);
          const patch: Record<string, unknown> = {};
          if (t) patch.bt = w;
          if (b) patch.bb = w;
          if (l) patch.bl = w;
          if (rt) patch.br = w;
          if (Object.keys(patch).length) patchStyle(doc, blockId, view.id, cell, patch);
        }
    });
  };
  const toggle = (k: "b" | "i" | "st" | "wr") => style({ [k]: !styleAt(sel.anchor.r, sel.anchor.c)?.[k] });
  const decimals = (d: number) => {
    const p = sel.anchor;
    const cur = decimalsOf(display(p.r, p.c), styleAt(p.r, p.c));
    style({ dp: Math.max(0, Math.min(10, cur + d)), nf: styleAt(p.r, p.c)?.nf ?? "num" });
  };

  /* ---- clipboard ---- */
  const copy = (e: ClipboardEvent, cut: boolean) => {
    if (!view) return;
    const q = rectOf(sel);
    const cells: Clip["cells"] = [];
    const out: PastedCell[][] = [];
    for (let r = q.r0; r <= q.r1; r++) {
      if (hiddenRows.has(r)) continue;
      const row: Clip["cells"][number] = [];
      const o: PastedCell[] = [];
      for (let c = q.c0; c <= q.c1; c++) {
        const st = styleAt(r, c);
        row.push({ in: inputAt(r, c), st });
        o.push({ v: formatValue(display(r, c), st), st });
      }
      cells.push(row);
      out.push(o);
    }
    const token = Math.random().toString(36).slice(2);
    clip = { token, rect: q, cells };
    e.clipboardData?.setData("text/plain", toTsv(out.map((r) => r.map((c) => c.v))));
    e.clipboardData?.setData("text/html", toHtml(out, token));
    e.preventDefault();
    if (cut && canEdit) clearRect(q);
  };

  const pasteGrid = (cells: { v: string; st?: CellStyle; formula?: boolean }[][], from: string, withFormats: boolean, shiftFrom: Pos | null) => {
    if (!view || !canEdit || !cells.length) return;
    let q = rectOf(sel);
    const h = cells.length;
    const w = Math.max(...cells.map((r) => r.length));
    // One copied cell fills the whole selection; a block pastes from the active cell.
    const tile = h === 1 && w === 1 && (q.r1 > q.r0 || q.c1 > q.c0);
    if (!tile) q = { r0: q.r0, c0: q.c0, r1: q.r0 + h - 1, c1: q.c0 + w - 1 };
    act(() => {
      if (q.r1 >= view.rows.length) insertRows(doc, blockId, view.id, view.rows.length, q.r1 - view.rows.length + 1);
      if (q.c1 >= view.cols.length) insertCols(doc, blockId, view.id, view.cols.length, q.c1 - view.cols.length + 1);
      const v = readView(doc, blockId, view.id)!;
      const sheets = readSheets(doc, blockId);
      for (let r = q.r0; r <= q.r1; r++)
        for (let c = q.c0; c <= q.c1; c++) {
          const src = tile ? cells[0][0] : cells[r - q.r0][c - q.c0];
          if (!src) continue;
          let typed = src.v;
          if (src.formula && typed.startsWith("=") && shiftFrom && engine) typed = engine.shift(typed, r - shiftFrom.r - (tile ? 0 : r - q.r0), c - shiftFrom.c - (tile ? 0 : c - q.c0));
          const { stored, nf } = toStored(typed, v.id, sheets);
          setInput(doc, blockId, v.id, v.rows[r], v.cols[c], stored);
          if (withFormats) setStyle(doc, blockId, v.id, v.rows[r], v.cols[c], src.st || nf ? ({ ...(nf ? { nf } : {}), ...(src.st ?? {}) } as Record<string, unknown>) : undefined);
        }
    });
    select({ anchor: { r: q.r0, c: q.c0 }, focus: { r: q.r1, c: q.c1 } });
    return { h: tile ? q.r1 - q.r0 + 1 : h, w: tile ? q.c1 - q.c0 + 1 : w };
  };

  const paste = (e: ClipboardEvent) => {
    if (!view || !canEdit) return;
    e.preventDefault();
    const html = e.clipboardData?.getData("text/html") ?? "";
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const only = valuesOnly.current;
    valuesOnly.current = false;
    const table = html ? parseHtmlTable(html) : null;
    const mine = !!table?.source && table.source === clip?.token;
    let cells: { v: string; st?: CellStyle; formula?: boolean }[][];
    let from: string;
    let shiftFrom: Pos | null = null;
    let valuesGrid: { v: string }[][];
    if (mine && clip) {
      from = "OpenCanvas";
      cells = clip.cells.map((r) => r.map((c) => ({ v: c.in, st: c.st, formula: true })));
      shiftFrom = { r: clip.rect.r0, c: clip.rect.c0 };
      valuesGrid = table!.cells.map((r) => r.map((c) => ({ v: c.v })));
    } else if (table) {
      from = /urn:schemas-microsoft-com:office|ProgId content=Excel|xmlns:x=/i.test(html) ? "Excel" : /google-sheets-html-origin|data-sheets-/i.test(html) ? "Google Sheets" : "the clipboard";
      cells = table.cells.map((r) => r.map((c) => ({ v: c.v, st: c.st })));
      valuesGrid = cells.map((r) => r.map((c) => ({ v: c.v })));
    } else {
      from = "the clipboard";
      cells = parseTsv(text).map((r) => r.map((v) => ({ v })));
      valuesGrid = cells;
    }
    if (only) cells = valuesGrid;
    const keep = sel;
    const withFormats = !only && cells.some((r) => r.some((c) => c.st));
    const got = pasteGrid(cells, from, !only, shiftFrom);
    if (!got) return;
    const what = `Pasted ${got.h} ${got.h === 1 ? "row" : "rows"} × ${got.w} ${got.w === 1 ? "column" : "columns"} from ${from}${withFormats ? ", with formats" : ""}.`;
    setNote({
      text: what,
      values: only
        ? undefined
        : () => {
            um?.undo();
            setSel(keep);
            requestAnimationFrame(() => {
              pasteGridAt(keep, valuesGrid, from);
            });
          },
    });
  };
  const pasteGridAt = (s: Sel, cells: { v: string }[][], from: string) => {
    setSel(s);
    // Runs after the selection settles (next frame), as a fresh paste of values.
    requestAnimationFrame(() => {
      const got = pasteGridRef.current?.(cells, from, false, null);
      if (got) setNote({ text: `Pasted values only from ${from}.` });
    });
  };
  const pasteGridRef = useRef(pasteGrid);
  pasteGridRef.current = pasteGrid;

  useEffect(() => {
    const inGrid = () => !!gridRef.current && gridRef.current === document.activeElement;
    const onCopy = (e: ClipboardEvent) => inGrid() && copy(e, false);
    const onCut = (e: ClipboardEvent) => inGrid() && copy(e, true);
    const onPaste = (e: ClipboardEvent) => inGrid() && paste(e);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  });
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 10_000);
    return () => clearTimeout(t);
  }, [note]);

  /* ---- fill ---- */
  const applyFill = (from: Rect, to: Rect, copy = false) => {
    if (!view || !engine || !canEdit) return;
    const out = fill(from, to, (r, c) => inputAt(r, c), (s, dr, dc) => engine.shift(s, dr, dc), copy);
    act(() => {
      const sheets = readSheets(doc, blockId);
      const h = from.r1 - from.r0 + 1;
      const w = from.c1 - from.c0 + 1;
      for (const [r, c, typed] of out) {
        const { stored } = toStored(typed, view.id, sheets);
        setInput(doc, blockId, view.id, view.rows[r], view.cols[c], stored);
        const sr = from.r0 + ((((r - from.r0) % h) + h) % h);
        const sc = from.c0 + ((((c - from.c0) % w) + w) % w);
        setStyle(doc, blockId, view.id, view.rows[r], view.cols[c], styleAt(sr, sc) as Record<string, unknown> | undefined);
      }
    });
    select({ anchor: { r: to.r0, c: to.c0 }, focus: { r: to.r1, c: to.c1 } }, false);
  };

  /* ---- pointer ---- */
  const cellFrom = (x: number, y: number): Pos | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-r]");
    if (!el || !gridRef.current?.contains(el)) return null;
    return { r: Number(el.dataset.r), c: Number(el.dataset.c) };
  };
  const drag = (move: (e: PointerEvent) => void, up?: (e: PointerEvent) => void) => {
    const m = (e: PointerEvent) => move(e);
    const u = (e: PointerEvent) => {
      window.removeEventListener("pointermove", m);
      window.removeEventListener("pointerup", u);
      window.removeEventListener("pointercancel", u);
      up?.(e);
    };
    window.addEventListener("pointermove", m);
    window.addEventListener("pointerup", u);
    window.addEventListener("pointercancel", u);
  };

  const refText = (p: Pos, q?: Pos) => {
    const prefix = edit && view && edit.sheet !== view.id ? quoteSheet(view.name) + "!" : "";
    return prefix + (q && (q.r !== p.r || q.c !== p.c) ? rectA1(rectOf({ anchor: p, focus: q })) : a1(p));
  };

  const onCellDown = (e: React.PointerEvent, p: Pos) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest?.(".ocsh-ce")) return;
    // While a formula is typed after an operator, a click inserts the cell's reference.
    if (edit && POINT_AFTER.test(edit.draft) && edit.draft.startsWith("=")) {
      e.preventDefault();
      const base = edit.draft;
      setEdit({ ...edit, draft: base + refText(p) });
      drag((ev) => {
        const q = cellFrom(ev.clientX, ev.clientY);
        if (q) setEdit((ed) => (ed ? { ...ed, draft: base + refText(p, q) } : ed));
      });
      return;
    }
    if (edit) commit();
    e.preventDefault();
    gridRef.current?.focus({ preventScroll: true });
    setMenu(null);
    if (e.shiftKey) setSel((s) => ({ anchor: s.anchor, focus: p }));
    else setSel(at(p.r, p.c));
    drag((ev) => {
      const q = cellFrom(ev.clientX, ev.clientY);
      if (q) setSel((s) => (s.focus.r === q.r && s.focus.c === q.c ? s : { anchor: s.anchor, focus: q }));
    });
  };
  /** Phone: the round handles at two corners of the selection extend it (9b). */
  const onKnobDown = (e: React.PointerEvent, corner: "tl" | "br") => {
    e.preventDefault();
    e.stopPropagation();
    const q0 = rectOf(sel);
    const fixed = corner === "br" ? { r: q0.r0, c: q0.c0 } : { r: q0.r1, c: q0.c1 };
    drag((ev) => {
      const p = cellFrom(ev.clientX, ev.clientY);
      if (p) setSel({ anchor: fixed, focus: p });
    });
  };
  /** Ctrl+D (and the phone's Fill): the top row of the selection fills the rest. */
  const fillDown = () => {
    const q0 = rectOf(sel);
    if (q0.r1 > q0.r0) applyFill({ ...q0, r1: q0.r0 }, q0);
  };
  const onFillDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const from = rectOf(sel);
    let to = from;
    drag(
      (ev) => {
        const q = cellFrom(ev.clientX, ev.clientY);
        if (!q) return;
        to = fillTarget(from, q);
        setFillTo(to);
      },
      (ev) => {
        setFillTo(null);
        if (to !== from) applyFill(from, to, ev.ctrlKey || ev.metaKey || ev.altKey);
      },
    );
  };
  const onHeadDown = (e: React.PointerEvent, kind: "c" | "r", i: number) => {
    if (e.button !== 0 || !view) return;
    e.preventDefault();
    if (edit) commit();
    gridRef.current?.focus({ preventScroll: true });
    const whole = (a: number, b: number): Sel =>
      kind === "c" ? { anchor: { r: 0, c: a }, focus: { r: nR - 1, c: b } } : { anchor: { r: a, c: 0 }, focus: { r: b, c: nC - 1 } };
    const wholeSel = kind === "c" ? q.r0 === 0 && q.r1 === nR - 1 && i >= q.c0 && i <= q.c1 : q.c0 === 0 && q.c1 === nC - 1 && i >= q.r0 && i <= q.r1;
    if (wholeSel && canEdit && !e.shiftKey) {
      // 4d: drag selected rows or columns by their header to move them (formulas follow the ids).
      let to = -1;
      drag(
        (ev) => {
          const h = headFrom(ev.clientX, ev.clientY, kind);
          if (!h) return;
          const at_ = kind === "c" ? h.c : h.r;
          to = at_ < (kind === "c" ? q.c0 : q.r0) ? at_ : at_ + 1;
          setMoveTo({ kind, at: to });
        },
        () => {
          setMoveTo(null);
          if (to >= 0) move(kind, to);
        },
      );
      return;
    }
    const start = e.shiftKey ? (kind === "c" ? sel.anchor.c : sel.anchor.r) : i;
    setSel(whole(start, i));
    drag((ev) => {
      const q = cellFrom(ev.clientX, ev.clientY) ?? headFrom(ev.clientX, ev.clientY, kind);
      if (q != null) setSel(whole(start, kind === "c" ? q.c : q.r));
    });
  };
  const headFrom = (x: number, y: number, kind: "c" | "r"): Pos | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(kind === "c" ? "[data-hc]" : "[data-hr]");
    if (!el) return null;
    return kind === "c" ? { r: 0, c: Number(el.dataset.hc) } : { r: Number(el.dataset.hr), c: 0 };
  };
  const onResizeDown = (e: React.PointerEvent, kind: "w" | "h", i: number) => {
    if (!view || !canEdit) return;
    e.preventDefault();
    e.stopPropagation();
    const start = kind === "w" ? e.clientX : e.clientY;
    const base = kind === "w" ? colW[i] : rowH[i];
    let v = base;
    drag(
      (ev) => {
        v = Math.max(kind === "w" ? MIN_W : MIN_H, base + ((kind === "w" ? ev.clientX : ev.clientY) - start) / rp);
        setLive({ kind, i, v });
      },
      () => {
        setLive(null);
        if (v !== base) act(() => setSize(doc, blockId, view.id, kind === "w" ? "widths" : "heights", kind === "w" ? view.cols[i] : view.rows[i], v));
      },
    );
  };
  /** Double-click on a column edge: fit the widest value. */
  const autofit = (c: number) => {
    if (!view || !canEdit) return;
    const cv = document.createElement("canvas").getContext("2d");
    if (!cv || !gridRef.current) return;
    cv.font = getComputedStyle(gridRef.current).font;
    let w = 0;
    view.cells.forEach((_, k) => {
      const [rid, cid] = k.split(":");
      if (cid !== view.cols[c]) return;
      const r = view.rIx.get(rid) ?? -1;
      if (r >= 0) w = Math.max(w, cv.measureText(formatValue(display(r, c), styleAt(r, c))).width);
    });
    act(() => setSize(doc, blockId, view.id, "widths", view.cols[c], w ? Math.min(40, w / rp + 1) : null));
  };

  /* ---- rows, columns, sheets ---- */
  const q = rectOf(sel);
  const nRows = q.r1 - q.r0 + 1;
  const nCols = q.c1 - q.c0 + 1;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const ins = (kind: "r" | "c", where: number, n: number) => {
    if (!view) return;
    act(() => (kind === "r" ? insertRows : insertCols)(doc, blockId, view.id, where, n));
  };
  const del = (kind: "r" | "c", sure = false) => {
    if (!view) return;
    const ids = kind === "r" ? view.rows.slice(q.r0, q.r1 + 1) : view.cols.slice(q.c0, q.c1 + 1);
    const n = sure ? 0 : countRefs(doc, blockId, kind === "r" ? "rows" : "cols", view.id, ids);
    if (n) {
      // 4c: say first how many formulas will break.
      const what = kind === "r" ? plural(nRows, "row") : plural(nCols, "column");
      const b = document.getElementById(cellId(sel.anchor))?.getBoundingClientRect();
      setMenu({
        x: b ? b.left : 100,
        y: b ? b.bottom : 100,
        label: `Delete ${what}`,
        body: (
          <div className="ocsh-confirm">
            <p>
              {n} {n === 1 ? "formula uses" : "formulas use"} {kind === "r" ? (nRows === 1 ? "this row" : "these rows") : nCols === 1 ? "this column" : "these columns"} and will show #REF!.
            </p>
            <div className="ocsh-fact">
              <button className="ocsh-btn" onClick={() => (setMenu(null), gridRef.current?.focus())}>Cancel</button>
              <button className="ocsh-btn p dan" onClick={() => (setMenu(null), del(kind, true), gridRef.current?.focus())}>Delete {what}</button>
            </div>
          </div>
        ),
      });
      return;
    }
    act(() => (kind === "r" ? deleteRows(doc, blockId, view.id, q.r0, nRows) : deleteCols(doc, blockId, view.id, q.c0, nCols)));
    select(at(q.r0, q.c0));
  };
  const move = (kind: "r" | "c", to: number) => {
    if (!view || !canEdit) return;
    const [a0, a1_] = kind === "r" ? [q.r0, q.r1] : [q.c0, q.c1];
    const n = a1_ - a0 + 1;
    const max = kind === "r" ? nR : nC;
    if (to < 0 || to > max || (to >= a0 && to <= a1_ + 1)) return;
    act(() => moveIds(doc, blockId, view.id, kind === "r" ? "rows" : "cols", a0, n, to));
    const start = to > a0 ? to - n : to;
    if (kind === "r") setSel({ anchor: { r: start, c: 0 }, focus: { r: start + n - 1, c: nC - 1 } });
    else setSel({ anchor: { r: 0, c: start }, focus: { r: nR - 1, c: start + n - 1 } });
  };
  const hide = (kind: "r" | "c", ids: string[], on: boolean) => {
    if (!view) return;
    act(() => setHidden(doc, blockId, view.id, ids, on));
    // The active cell leaves what was hidden: to the next row or column after it.
    if (on) setSel(kind === "c" ? at(0, Math.min(nC - 1, q.c1 + 1)) : at(Math.min(nR - 1, q.r1 + 1), 0));
  };
  const mergeHere = merges.list.filter((m) => mergeHits(m, q));
  const toggleMerge = () => {
    if (!view || !canEdit) return;
    if (mergeHere.length) {
      act(() => mergeHere.forEach((m) => setMerge(doc, blockId, view.id, view.rows[m.r0], view.cols[m.c0], null)));
      return;
    }
    if (nRows * nCols < 2) return;
    let dropped = 0;
    view.cells.forEach((c, k) => {
      const [rid, cid] = k.split(":");
      const r = view.rIx.get(rid) ?? -1;
      const cc = view.cIx.get(cid) ?? -1;
      if (inRect(q, r, cc) && (r !== q.r0 || cc !== q.c0) && c.get("in")) dropped++;
    });
    act(() => {
      if (dropped) clearRectRaw({ ...q, r0: q.r0, c0: q.c0 }, true);
      for (const m of mergeHere) setMerge(doc, blockId, view.id, view.rows[m.r0], view.cols[m.c0], null);
      setMerge(doc, blockId, view.id, view.rows[q.r0], view.cols[q.c0], [view.rows[q.r1], view.cols[q.c1]]);
    });
    if (dropped) env.toast(`Merged ${rectA1(q)}; only the top-left value was kept (${dropped} cleared).`, um ? { label: "Undo", run: () => um.undo() } : undefined);
    select(at(q.r0, q.c0));
  };
  const freezeTo = (rows: number, cols: number) => view && act(() => setFreeze(doc, blockId, view.id, rows, cols));
  const filterOn = (f: SheetFilter | null) => {
    if (!view) return;
    if (canEdit) act(() => setFilter(doc, blockId, view.id, f));
    else setLocalFilter(f);
  };
  const createFilter = () => {
    if (!view) return;
    filterOn({ row: view.rows[q.r0], cols: view.cols.slice(q.c0, q.c1 + 1 === q.c0 + 1 && nCols === 1 ? Math.max(q.c0 + 1, lastCol() + 1) : q.c1 + 1), hide: {} });
  };
  const lastCol = () => {
    let m = 0;
    view?.cells.forEach((_, k) => (m = Math.max(m, view.cIx.get(k.split(":")[1]) ?? 0)));
    return m;
  };
  const sortBy = (c: number, desc: boolean) => {
    if (!view || !canEdit || !filter) return;
    const hr = view.rows.indexOf(filter.row);
    let last = hr;
    view.cells.forEach((_, k) => (last = Math.max(last, view.rIx.get(k.split(":")[0]) ?? 0)));
    if (last <= hr + 1) return;
    const idx = Array.from({ length: last - hr }, (_, i) => hr + 1 + i);
    const key = (r: number) => display(r, c);
    idx.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      if (x === "" || y === "") return x === y ? 0 : x === "" ? 1 : -1;
      const d = isNumber(x) && isNumber(y) ? Number(x) - Number(y) : x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" });
      return desc ? -d : d;
    });
    act(() => reorderRows(doc, blockId, view.id, hr + 1, idx.map((r) => view.rows[r])));
  };

  const openMenu = (x: number, y: number, label: string, items: NonNullable<MenuState["items"]>) => setMenu({ x, y, label, items });
  const colItems = (): MenuEntry[] => [
    { label: `Insert ${plural(nCols, "column")} left`, run: () => ins("c", q.c0, nCols) },
    { label: `Insert ${plural(nCols, "column")} right`, run: () => ins("c", q.c1 + 1, nCols) },
    { label: nCols === 1 ? `Delete column ${colName(q.c0)}` : `Delete columns ${colName(q.c0)}–${colName(q.c1)}`, danger: true, run: () => del("c") },
    { label: nCols === 1 ? "Clear column" : "Clear columns", run: () => clearRect(q) },
    "sep",
    fc === q.c1 + 1 ? { label: "Unfreeze columns", icon: <Snowflake size={15} />, run: () => freezeTo(fr, 0) } : { label: `Freeze up to column ${colName(q.c1)}`, icon: <Snowflake size={15} />, run: () => freezeTo(fr, q.c1 + 1) },
    { label: "Fit to data", run: () => autofit(q.c0) },
    "sep",
    { label: nCols === 1 ? "Move column left" : "Move columns left", run: () => move("c", q.c0 - 1) },
    { label: nCols === 1 ? "Move column right" : "Move columns right", run: () => move("c", q.c1 + 2) },
    { label: nCols === 1 ? "Hide column" : "Hide columns", run: () => hide("c", view!.cols.slice(q.c0, q.c1 + 1), true) },
    ...(hiddenCols.size ? [{ label: "Unhide all columns", run: () => hide("c", [...hiddenCols].map((c) => view!.cols[c]), false) } as MenuItem] : []),
  ];
  const rowItems = (): MenuEntry[] => [
    { label: `Insert ${plural(nRows, "row")} above`, run: () => ins("r", q.r0, nRows) },
    { label: `Insert ${plural(nRows, "row")} below`, run: () => ins("r", q.r1 + 1, nRows) },
    { label: nRows === 1 ? `Delete row ${q.r0 + 1}` : `Delete rows ${q.r0 + 1}–${q.r1 + 1}`, danger: true, run: () => del("r") },
    { label: nRows === 1 ? "Clear row" : "Clear rows", run: () => clearRect(q) },
    "sep",
    fr === q.r1 + 1 ? { label: "Unfreeze rows", icon: <Snowflake size={15} />, run: () => freezeTo(0, fc) } : { label: `Freeze up to row ${q.r1 + 1}`, icon: <Snowflake size={15} />, run: () => freezeTo(q.r1 + 1, fc) },
    "sep",
    { label: nRows === 1 ? "Move row up" : "Move rows up", run: () => move("r", q.r0 - 1) },
    { label: nRows === 1 ? "Move row down" : "Move rows down", run: () => move("r", q.r1 + 2) },
    { label: nRows === 1 ? "Hide row" : "Hide rows", run: () => hide("r", view!.rows.slice(q.r0, q.r1 + 1), true) },
    ...([...hiddenRows].some((r) => !hidden.has(r)) ? [{ label: "Unhide all rows", run: () => hide("r", [...hiddenRows].filter((r) => !hidden.has(r)).map((r) => view!.rows[r]), false) } as MenuItem] : []),
  ];
  const cellItems = (): MenuEntry[] =>
    canEdit
      ? editCellItems()
      : [
          { label: "Copy", hint: "Ctrl C", run: () => document.execCommand?.("copy") },
          "sep",
          filter ? { label: "Remove filter", icon: <Funnel size={15} />, run: () => filterOn(null) } : { label: "Create a filter", icon: <Funnel size={15} />, run: createFilter },
        ];
  // SHEET-06 (4h, 8a): the selection as a linked chart or a new database, placed after the block.
  const rangeIds = () => (view ? { sheetId: blockId, sheet: view.id, r0: view.rows[q.r0], r1: view.rows[q.r1], c0: view.cols[q.c0], c1: view.cols[q.c1] } : null);
  const chartSel = () => void (rangeIds() && env.sheetActions?.chart(rangeIds()!));
  const toDb = () => {
    const r = rangeIds();
    if (!r || !view) return;
    const vals = Array.from({ length: nRows }, (_, i) => Array.from({ length: nCols }, (_, j) => display(q.r0 + i, q.c0 + j)));
    env.sheetActions?.toDatabase(r, vals, view.name);
  };
  const rangeItems = (): MenuEntry[] =>
    env.sheetActions
      ? ["sep", { label: "Chart from selection", icon: <ChartColumn size={15} />, run: chartSel }, { label: "Convert to database", icon: <DatabaseIcon size={15} />, run: toDb }]
      : [];
  const editCellItems = (): MenuEntry[] => [
    { label: "Copy", hint: "Ctrl C", run: () => document.execCommand?.("copy") },
    { label: "Cut", hint: "Ctrl X", run: () => document.execCommand?.("cut") },
    "sep",
    { label: `Insert ${plural(nRows, "row")} above`, run: () => ins("r", q.r0, nRows) },
    { label: `Insert ${plural(nCols, "column")} left`, run: () => ins("c", q.c0, nCols) },
    { label: nRows === 1 ? "Delete row" : "Delete rows", danger: true, run: () => del("r") },
    { label: nCols === 1 ? "Delete column" : "Delete columns", danger: true, run: () => del("c") },
    { label: "Clear", hint: "Delete", run: () => clearRect(q) },
    mergeHere.length ? { label: "Unmerge", run: toggleMerge } : { label: "Merge cells", run: toggleMerge },
    "sep",
    filter ? { label: "Remove filter", icon: <Funnel size={15} />, run: () => filterOn(null) } : { label: "Create a filter", icon: <Funnel size={15} />, run: createFilter },
    fr || fc ? { label: "Unfreeze", icon: <Snowflake size={15} />, run: () => freezeTo(0, 0) } : { label: `Freeze up to ${a1(sel.anchor)}`, icon: <Snowflake size={15} />, run: () => freezeTo(sel.anchor.r, sel.anchor.c) },
    ...rangeItems(),
  ];

  const addTab = () => {
    let id = "";
    act(() => (id = addSheet(doc, blockId)));
    setSheetSel(id);
    select(at(0, 0));
  };
  const removeTab = (id: string) => {
    if (order.length <= 1) return;
    const name = readView(doc, blockId, id)?.name ?? "Sheet";
    act(() => deleteSheet(doc, blockId, id));
    if (id === sheet) setSheetSel(null);
    env.toast(`Deleted “${name}”`, um ? { label: "Undo", run: () => um.undo() } : undefined);
  };
  const tabColour = (id: string) => {
    const b = document.querySelector<HTMLElement>(`[data-tab="${id}"]`)?.getBoundingClientRect();
    setMenu({
      x: b ? b.left : 100,
      y: b ? b.bottom + 4 : 100,
      label: "Tab colour",
      body: (
        <div className="ocsh-sw" role="group" aria-label="Tab colour">
          <button aria-label="No colour" title="No colour" onClick={() => (act(() => setSheetColor(doc, blockId, id, null)), setMenu(null))} style={{ background: "var(--app)" }} />
          {TONES.map((t) => (
            <button key={t} aria-label={t} title={t} onClick={() => (act(() => setSheetColor(doc, blockId, id, t)), setMenu(null))} style={{ background: `var(--${t}-fg)` }} />
          ))}
        </div>
      ),
    });
  };
  const tabItems = (id: string): MenuEntry[] => [
    { label: "Rename", run: () => setRenaming(id) },
    { label: "Colour", run: () => setTimeout(() => tabColour(id)) },
    ...(order.indexOf(id) > 0 ? [{ label: "Move left", run: () => act(() => moveSheet(doc, blockId, id, order.indexOf(id) - 1)) } as MenuItem] : []),
    ...(order.indexOf(id) < order.length - 1 ? [{ label: "Move right", run: () => act(() => moveSheet(doc, blockId, id, order.indexOf(id) + 1)) } as MenuItem] : []),
    ...(order.length > 1 ? [{ label: "Delete", danger: true, run: () => removeTab(id) } as MenuItem] : []),
  ];

  /* ---- keyboard ---- */
  const onKey = (e: React.KeyboardEvent) => {
    if (e.target !== gridRef.current || !view) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && e.shiftKey && (k === "e" || k === "E")) {
      e.preventDefault();
      toggleFull();
      return;
    }
    if (mod && !e.altKey && (k === "z" || k === "Z" || k === "y")) {
      e.preventDefault();
      e.stopPropagation();
      if (!canEdit || !um) return;
      if (k === "y" || e.shiftKey) um.redo();
      else um.undo();
      return;
    }
    if (mod && (k === "c" || k === "x")) return; // the copy/cut event
    if (mod && (k === "v" || k === "V")) {
      valuesOnly.current = e.shiftKey;
      return; // the paste event
    }
    if (mod && (k === "f" || k === "h")) {
      e.preventDefault();
      setFind((f) => ({ q: f?.q ?? "", by: f?.by ?? "", replace: k === "h" && canEdit, mc: f?.mc ?? false, whole: f?.whole ?? false, formulas: f?.formulas ?? false, all: f?.all ?? false }));
      requestAnimationFrame(() => findRef.current?.focus());
      return;
    }
    if (mod && k === "d" && canEdit) {
      e.preventDefault();
      fillDown();
      return;
    }
    if (mod && (k === "b" || k === "i")) {
      e.preventDefault();
      toggle(k);
      return;
    }
    if (k === "ContextMenu" || (e.shiftKey && k === "F10")) {
      e.preventDefault();
      const el = document.getElementById(cellId(sel.anchor));
      const b = el?.getBoundingClientRect();
      openMenu(b ? b.left + b.width / 2 : 100, b ? b.bottom : 100, "Cell", "cell");
      return;
    }
    if (k === " " && (mod || e.shiftKey)) {
      e.preventDefault();
      if (mod) select({ anchor: { r: 0, c: sel.anchor.c }, focus: { r: nR - 1, c: sel.focus.c } }, false);
      else select({ anchor: { r: sel.anchor.r, c: 0 }, focus: { r: sel.focus.r, c: nC - 1 } }, false);
      return;
    }
    if (k === "F2") {
      e.preventDefault();
      startEdit(null, "edit");
      return;
    }
    if (k === "Delete" || k === "Backspace") {
      e.preventDefault();
      clearRect(rectOf(sel));
      return;
    }
    // From a merged cell, arrows leave from its far edge (otherwise they land inside it again).
    const mg = merges.anchor.get(`${sel.anchor.r}:${sel.anchor.c}`);
    const from = mg && !e.shiftKey && (k === "ArrowDown" || k === "ArrowRight" || k === "Enter" || k === "Tab") ? at(k === "ArrowDown" || k === "Enter" ? mg.r1 : mg.r0, k === "ArrowRight" || k === "Tab" ? mg.c1 : mg.c0) : sel;
    const n = navigate(gridApi, from, { key: k, shift: e.shiftKey, mod });
    if (n) {
      e.preventDefault();
      select(n);
      return;
    }
    if (k.length === 1 && !mod && !e.altKey && canEdit) {
      e.preventDefault();
      startEdit(k, "enter");
    }
  };
  const onEditKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!edit) return;
    const k = e.key;
    e.stopPropagation();
    if (k === "Enter" && !e.altKey) {
      e.preventDefault();
      commit([e.shiftKey ? -1 : 1, 0]);
    } else if (k === "Tab") {
      e.preventDefault();
      commit([0, e.shiftKey ? -1 : 1]);
    } else if (k === "Escape") {
      e.preventDefault();
      cancel();
    } else if (edit.mode === "enter" && !edit.bar && k.startsWith("Arrow") && !(edit.draft.startsWith("=") && POINT_AFTER.test(edit.draft))) {
      e.preventDefault();
      const d: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      const [dr, dc] = d[k];
      const v = readView(doc, blockId, edit.sheet);
      if (v && canEdit && edit.draft !== inputAt(edit.r, edit.c, v)) act(() => writeCell(v, edit.r, edit.c, edit.draft));
      setEdit(null);
      select(at(edit.r + dr, edit.c + dc));
      gridRef.current?.focus({ preventScroll: true });
    } else if (k === "F4" && edit.draft.startsWith("=")) {
      e.preventDefault();
      setEdit({ ...edit, draft: cycleAbs(edit.draft) });
    }
  };

  /* ---- full screen ---- */
  const toggleFull = () => {
    if (edit) commit();
    setFull((f) => {
      if (f) {
        setFlash(true);
        setTimeout(() => setFlash(false), 700);
      }
      return !f;
    });
    requestAnimationFrame(() => requestAnimationFrame(() => (gridRef.current?.focus({ preventScroll: true }), reveal(sel.anchor))));
  };
  useEffect(() => {
    if (!full) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => void (document.body.style.overflow = prev);
  }, [full]);

  /* ---- peers (SHEET-05): where others are ---- */
  const peers = usePeers(awareness, blockId);
  useEffect(() => {
    if (!awareness || !view) return;
    const f = sel.focus;
    awareness.setLocalStateField("sheet", { id: blockId, s: view.id, a: [view.rows[sel.anchor.r], view.cols[sel.anchor.c]], f: [view.rows[f.r], view.cols[f.c]], ed: !!edit });
  }, [awareness, blockId, view, sel, !!edit]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => awareness?.setLocalStateField("sheet", null), [awareness]);

  if (!view) return <div className="ocsh"><div className="ocsh-load">Spreadsheet not found</div></div>;

  /* ---- render ---- */
  const cellId = (p: Pos) => `ocsh-${blockId}-${p.r}-${p.c}`;
  const fq = fillTo;
  const fx = edit ? edit.draft : inputAt(sel.anchor.r, sel.anchor.c);
  const editingHere = edit && edit.sheet === view.id && !edit.bar;
  const rem = (n: number) => `${n}rem`;
  const vw = vp.w / rp;
  const vh = vp.h / rp;
  const sxr = vp.sx / rp;
  const syr = vp.sy / rp;
  const visRows = (from: number, to: number) => {
    const out: number[] = [];
    for (let r = from; r <= to && r < nR; r++) if (rowH[r] > 0) out.push(r);
    return out;
  };
  const r0 = Math.max(fr, indexAt(rowOff, frozenH + syr));
  const r1 = indexAt(rowOff, frozenH + syr + vh);
  const c0 = Math.max(fc, indexAt(colOff, frozenW + sxr));
  const c1 = indexAt(colOff, frozenW + sxr + vw);
  const bodyRows = visRows(r0, r1 + 1);
  const bodyCols: number[] = [];
  for (let c = c0; c <= c1 + 1 && c < nC; c++) if (colW[c] > 0) bodyCols.push(c);
  // The active cell is always rendered, so aria-activedescendant names a real element.
  const withActive = (list: number[], v: number, lo: number) => (v >= lo && !list.includes(v) ? [...list, v].sort((a, b) => a - b) : list);
  const fRows = visRows(0, fr - 1);
  const fCols = Array.from({ length: fc }, (_, i) => i).filter((c) => colW[c] > 0);
  const bRows = withActive(bodyRows, sel.anchor.r, fr);
  const bCols = withActive(bodyCols, sel.anchor.c, fc);
  const showFill = canEdit && !edit;

  /* ---- find and replace (4f; OpenCalc's Pattern: ? * ~ wildcards, case, entire cell) ---- */
  const pattern = find?.q ? new Pattern(find.q, find.mc) : null;
  const inFormulas = !!find && (find.formulas || find.replace);
  const findList: { s: string; r: number; c: number }[] = [];
  if (pattern && find) {
    for (const sid of find.all ? order : [view.id]) {
      const v = sid === view.id ? view : readView(doc, blockId, sid);
      if (!v) continue;
      const hitsHere: { s: string; r: number; c: number }[] = [];
      v.cells.forEach((_, k) => {
        const [rid, cid] = k.split(":");
        const r = v.rIx.get(rid);
        const c = v.cIx.get(cid);
        if (r == null || c == null) return;
        const text = inFormulas ? inputAt(r, c, v) : formatValue(display(r, c, v), styleAt(r, c, v));
        if (pattern.hits(text, find.whole)) hitsHere.push({ s: sid, r, c });
      });
      hitsHere.sort((a, b) => a.r - b.r || a.c - b.c);
      findList.push(...hitsHere);
    }
  }
  const findHits = new Set(findList.filter((h) => h.s === view.id).map((h) => `${h.r}:${h.c}`));
  const findStep = (dir: number) => {
    if (!findList.length) {
      if (find?.q) env.toast("Nothing found.");
      return;
    }
    const key = (h: { s: string; r: number; c: number }) => [order.indexOf(h.s), h.r, h.c];
    const here = [order.indexOf(view.id), sel.anchor.r, sel.anchor.c];
    const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    let i = dir > 0 ? findList.findIndex((h) => cmp(key(h), here) > 0) : findList.map((h) => cmp(key(h), here) < 0).lastIndexOf(true);
    if (i < 0) i = dir > 0 ? 0 : findList.length - 1;
    const h = findList[i];
    if (h.s !== view.id) setSheetSel(h.s);
    select(at(h.r, h.c));
  };
  const replaceOne = () => {
    if (!pattern || !find || !canEdit) return;
    const h = findList.find((x) => x.s === view.id && x.r === sel.anchor.r && x.c === sel.anchor.c);
    if (h) {
      const next = pattern.replace(inputAt(h.r, h.c), find.by, find.whole);
      if (next != null) act(() => writeCell(view, h.r, h.c, next));
    }
    findStep(1);
  };
  const replaceAll = () => {
    if (!pattern || !find || !canEdit) return;
    let n = 0;
    act(() => {
      const sheets = readSheets(doc, blockId);
      for (const h of findList) {
        const v = h.s === view.id ? view : readView(doc, blockId, h.s);
        if (!v) continue;
        const next = pattern.replace(inputAt(h.r, h.c, v), find.by, find.whole);
        if (next == null) continue;
        writeCell(v, h.r, h.c, next, sheets);
        n++;
      }
    });
    env.toast(n ? `Replaced ${n} ${n === 1 ? "cell" : "cells"}.` : "Nothing to replace.", n && um ? { label: "Undo", run: () => um.undo() } : undefined);
  };
  /** The hidden indexes just before `i` (an unhide button's run). */
  const runBefore = (set: Set<number>, i: number) => {
    const out: number[] = [];
    for (let j = i - 1; j >= 0 && set.has(j); j--) out.push(j);
    return out;
  };

  const cellEl = (r: number, c: number, x0: number) => {
    const p = { r, c };
    const st = styleAt(r, c);
    const v = display(r, c);
    const shownText = formatValue(v, st);
    const isAct = sel.anchor.r === r && sel.anchor.c === c;
    const inSel = inRect(q, r, c);
    const multi = q.r1 > q.r0 || q.c1 > q.c0;
    const cls = ["ocsh-c"];
    if (isNumber(v) && !st?.al) cls.push("n");
    if (st?.al) cls.push("al-" + st.al);
    if (st?.b) cls.push("b");
    if (st?.i) cls.push("i");
    if (st?.st) cls.push("st");
    if (st?.wr) cls.push("wr");
    if (findHits.has(`${r}:${c}`)) cls.push("fm");
    const mg = merges.anchor.get(`${r}:${c}`);
    if (mg) cls.push("mg");
    if (isError(v)) cls.push("err");
    if (inSel && multi && !isAct) cls.push("rs");
    if (isAct) cls.push("act");
    if (inSel && multi) {
      if (r === q.r0) cls.push("et");
      if (r === q.r1) cls.push("eb");
      if (c === q.c0) cls.push("el");
      if (c === q.c1) cls.push("er");
    }
    if (fq && inRect(fq, r, c) && !inRect(q, r, c)) cls.push("fp");
    if (fr && r === fr - 1) cls.push("fzr");
    if (fc && c === fc - 1) cls.push("fzc");
    const ed = editingHere && edit!.r === r && edit!.c === c;
    if (ed) cls.push("ed");
    const css: CSSProperties = {
      left: rem(colOff[c] - x0),
      top: 0,
      width: rem(mg ? colOff[mg.c1 + 1] - colOff[c] : colW[c]),
      height: rem(mg ? rowOff[mg.r1 + 1] - rowOff[r] : rowH[r]),
    };
    const bd = [st?.bt && `inset 0 ${st.bt * 0.0625}rem 0 var(--fg)`, st?.bb && `inset 0 -${st.bb * 0.0625}rem 0 var(--fg)`, st?.bl && `inset ${st.bl * 0.0625}rem 0 0 var(--fg)`, st?.br && `inset -${st.br * 0.0625}rem 0 0 var(--fg)`].filter(Boolean);
    if (bd.length) css.boxShadow = bd.join(",");
    if (st?.fg) css.color = colour(st.fg, "fg");
    if (st?.bg && !(inSel && multi && !isAct)) css.background = colour(st.bg, "bg");
    const isFilterHead = filter && view.rows[r] === filter.row && filter.cols.includes(view.cols[c]);
    return (
      <div
        key={c}
        id={isAct ? cellId(p) : undefined}
        className={cls.join(" ")}
        style={css}
        role="gridcell"
        aria-colindex={c + 2}
        aria-selected={inSel}
        data-r={r}
        data-c={c}
        onPointerDown={(e) => onCellDown(e, p)}
        onMouseDown={(e) => !(e.target as HTMLElement).closest?.(".ocsh-ce") && e.preventDefault()}
        onDoubleClick={() => {
          if (!canEdit) return;
          setSel(at(r, c));
          setEdit({ sheet: view.id, r, c, draft: inputAt(r, c), mode: "edit", bar: phone });
          if (phone) requestAnimationFrame(() => fxRef.current?.focus());
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!inSel) setSel(at(r, c));
          openMenu(e.clientX, e.clientY, "Cell", "cell");
        }}
      >
        {ed ? (
          <input
            className="ocsh-ce"
            aria-label={`Edit ${a1(p)}`}
            value={edit!.draft}
            ref={(el) => {
              if (el && document.activeElement !== el) {
                el.focus({ preventScroll: true });
                el.setSelectionRange(el.value.length, el.value.length);
              }
            }}
            spellCheck={false}
            onChange={(e) => setEdit({ ...edit!, draft: e.target.value })}
            onKeyDown={onEditKey}
            onBlur={(e) => {
              // Leaving to the formula bar or a menu keeps the edit; anything else commits.
              const to = e.relatedTarget as HTMLElement | null;
              if (to?.closest?.(".ocsh-fx,.ocsh-tabs") || to === gridRef.current) return;
              if (edit) commit();
            }}
            style={{ width: `max(100%, ${Math.min(40, edit!.draft.length * 0.55 + 1)}rem)` }}
          />
        ) : (
          <span className="ocsh-ct">{shownText}</span>
        )}
        {isFilterHead ? (
          <button
            className={"ocsh-flt" + (filter!.hide[view.cols[c]]?.length ? " on" : "")}
            aria-label={`Filter ${colName(c)}`}
            tabIndex={-1}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu({ x: b.left, y: b.bottom, label: `Filter ${colName(c)}`, body: <FilterPanel key={c} c={c} /> });
            }}
          >
            <Funnel size={12} />
          </button>
        ) : null}
        {showFill && !phone && r === q.r1 && c === q.c1 ? <i className="ocsh-fh" aria-hidden="true" onPointerDown={onFillDown} /> : null}
        {phone && !edit && r === q.r0 && c === q.c0 ? <i className="ocsh-knob tl" aria-hidden="true" onPointerDown={(e) => onKnobDown(e, "tl")} /> : null}
        {phone && !edit && r === q.r1 && c === q.c1 ? <i className="ocsh-knob br" aria-hidden="true" onPointerDown={(e) => onKnobDown(e, "br")} /> : null}
      </div>
    );
  };
  const rowsOf = (rows: number[], cols: number[], x0: number, y0: number) =>
    rows.map((r) => (
      <div key={r} role="row" aria-rowindex={r + 2} style={{ position: "absolute", left: 0, top: rem(rowOff[r] - y0), height: rem(rowH[r]), width: 0 }}>
        {cols.filter((c) => !merges.covered.has(`${r}:${c}`)).map((c) => cellEl(r, c, x0))}
      </div>
    )).concat(
      // A merge whose anchor row or column is scrolled away still shows over its visible cells.
      merges.list
        .filter((m) => rows.length && cols.length && !(rows.includes(m.r0) && cols.includes(m.c0)) && rows.some((r) => r >= m.r0 && r <= m.r1) && cols.some((c) => c >= m.c0 && c <= m.c1))
        .map((m) => (
          <div key={`m${m.r0}:${m.c0}`} role="row" aria-rowindex={m.r0 + 2} style={{ position: "absolute", left: 0, top: rem(rowOff[m.r0] - y0), height: rem(rowH[m.r0]), width: 0 }}>
            {cellEl(m.r0, m.c0, x0)}
          </div>
        )),
    );
  const colHead = (c: number, x0: number) => {
    const hl = c >= q.c0 && c <= q.c1;
    const all = hl && q.r0 === 0 && q.r1 === nR - 1;
    return (
      <div
        key={c}
        className={"ocsh-h1" + (all ? " all" : hl ? " hl" : "") + (moveTo?.kind === "c" && moveTo.at === c ? " drop" : "")}
        role="columnheader"
        aria-colindex={c + 2}
        data-hc={c}
        style={{ left: rem(colOff[c] - x0), top: 0, width: rem(colW[c]), height: rem(HDR) }}
        onPointerDown={(e) => onHeadDown(e, "c", c)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!(c >= q.c0 && c <= q.c1 && q.r0 === 0 && q.r1 === nR - 1)) setSel({ anchor: { r: 0, c }, focus: { r: nR - 1, c } });
          if (canEdit) openMenu(e.clientX, e.clientY, `Column ${colName(c)}`, "col");
        }}
      >
        {colName(c)}
        {canEdit && c > 0 && hiddenCols.has(c - 1) ? (
          <button className="ocsh-unh v" tabIndex={-1} aria-label={`Unhide columns before ${colName(c)}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => hide("c", runBefore(hiddenCols, c).map((i) => view.cols[i]), false)}>
            <ChevronDown size={10} />
          </button>
        ) : null}
        {canEdit ? <span className="ocsh-rz v" onPointerDown={(e) => onResizeDown(e, "w", c)} onDoubleClick={() => autofit(c)} /> : null}
      </div>
    );
  };
  const rowHead = (r: number, y0: number) => {
    const hl = r >= q.r0 && r <= q.r1;
    const all = hl && q.c0 === 0 && q.c1 === nC - 1;
    return (
      <div key={r} role="row" aria-rowindex={r + 2} style={{ position: "absolute", left: 0, top: rem(rowOff[r] - y0), width: rem(RHW), height: rem(rowH[r]) }}>
        <div
          className={"ocsh-h1 rh" + (all ? " all" : hl ? " hl" : "") + (moveTo?.kind === "r" && moveTo.at === r ? " drop" : "")}
          role="rowheader"
          aria-colindex={1}
          data-hr={r}
          style={{ left: 0, top: 0, width: rem(RHW), height: rem(rowH[r]) }}
          onPointerDown={(e) => onHeadDown(e, "r", r)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (!(r >= q.r0 && r <= q.r1 && q.c0 === 0 && q.c1 === nC - 1)) setSel({ anchor: { r, c: 0 }, focus: { r, c: nC - 1 } });
            if (canEdit) openMenu(e.clientX, e.clientY, `Row ${r + 1}`, "row");
          }}
        >
          {r + 1}
          {canEdit && r > 0 && hiddenRows.has(r - 1) && !hidden.has(r - 1) ? (
            <button className="ocsh-unh h" tabIndex={-1} aria-label={`Unhide rows above ${r + 1}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => hide("r", runBefore(hiddenRows, r).filter((i) => !hidden.has(i)).map((i) => view.rows[i]), false)}>
              <ChevronUp size={10} />
            </button>
          ) : null}
          {canEdit ? <span className="ocsh-rz h" onPointerDown={(e) => onResizeDown(e, "h", r)} /> : null}
        </div>
      </div>
    );
  };

  const totalW = RHW + colOff[nC];
  const totalH = HDR + rowOff[nR];
  const regX = (el: HTMLDivElement | null, i: number) => void (el && ((panesX.current[i] = el), (el.style.transform = `translateX(${-vp.sx}px)`)));
  const regY = (el: HTMLDivElement | null, i: number) => void (el && ((panesY.current[i] = el), (el.style.transform = `translateY(${-vp.sy}px)`)));
  const peerBoxes = peers
    .filter((p) => p.s === view.id)
    .map((p) => {
      const a = { r: view.rows.indexOf(p.a[0]), c: view.cols.indexOf(p.a[1]) };
      const f = { r: view.rows.indexOf(p.f[0]), c: view.cols.indexOf(p.f[1]) };
      if (a.r < 0 || a.c < 0 || f.r < 0 || f.c < 0) return null;
      const pr = rectOf({ anchor: a, focus: f });
      return (
        <div
          key={p.id}
          className="ocsh-peer"
          aria-hidden="true"
          style={{
            position: "absolute",
            left: rem(RHW + colOff[pr.c0]),
            top: rem(HDR + rowOff[pr.r0]),
            width: rem(colOff[pr.c1 + 1] - colOff[pr.c0]),
            height: rem(rowOff[pr.r1 + 1] - rowOff[pr.r0]),
            boxShadow: `inset 0 0 0 2px ${p.color}`,
            pointerEvents: "none",
            zIndex: 1,
          }}
        >
          <span style={{ position: "absolute", right: 0, top: "-1rem", background: p.color, color: "#fff", fontSize: ".625rem", fontWeight: 600, padding: "0 .3125rem", borderRadius: ".25rem .25rem 0 0", lineHeight: "1rem", whiteSpace: "nowrap" }}>
            {p.name}
            {p.ed ? " (editing)" : ""}
          </span>
        </div>
      );
    });

  const grid = (
    <div
      ref={gridRef}
      className="ocsh-grid"
      role="grid"
      tabIndex={0}
      aria-label={`${view.name} sheet`}
      aria-rowcount={nR + 1}
      aria-colcount={nC + 1}
      aria-multiselectable="true"
      aria-readonly={!canEdit || undefined}
      aria-activedescendant={cellId(sel.anchor)}
      onKeyDown={onKey}
      onScroll={onScroll}
    >
      <div style={{ position: "relative", width: rem(totalW), height: rem(totalH + 2) }}>
        {/* the sticky layer: headers and frozen panes stay; their contents follow the scroll */}
        <div style={{ position: "sticky", left: 0, top: 0, width: vp.w + "px", height: vp.h + "px", marginBottom: -vp.h + "px", zIndex: 3, pointerEvents: "none" }}>{/* px-ok: measured */}
          <div role="row" aria-rowindex={1}>
            <div role="columnheader" aria-label="Select all" className="ocsh-corner" style={{ width: rem(RHW), height: rem(HDR), pointerEvents: "auto" }} onPointerDown={(e) => (e.preventDefault(), gridRef.current?.focus(), setSel({ anchor: { r: 0, c: 0 }, focus: { r: nR - 1, c: nC - 1 } }))} />
          </div>
          <div className="ocsh-pane" style={{ left: rem(RHW), top: 0, width: rem(frozenW), height: rem(HDR), pointerEvents: "auto" }}>
            {fc ? <div role="row" aria-rowindex={1}>{fCols.map((c) => colHead(c, 0))}</div> : null}
          </div>
          <div className="ocsh-pane" style={{ left: rem(RHW + frozenW), top: 0, right: 0, height: rem(HDR), pointerEvents: "auto" }}>
            <div className="ocsh-in" ref={(el) => regX(el, 0)}>
              <div role="row" aria-rowindex={1}>{bCols.map((c) => colHead(c, frozenW))}</div>
            </div>
          </div>
          {fr ? (
            <div className="ocsh-pane" style={{ left: 0, top: rem(HDR), width: rem(RHW), height: rem(frozenH), pointerEvents: "auto" }}>
              {fRows.map((r) => rowHead(r, 0))}
            </div>
          ) : null}
          <div className="ocsh-pane" style={{ left: 0, top: rem(HDR + frozenH), width: rem(RHW), bottom: 0, pointerEvents: "auto" }}>
            <div className="ocsh-in" ref={(el) => regY(el, 0)}>{bRows.map((r) => rowHead(r, frozenH))}</div>
          </div>
          {fr && fc ? (
            <div className="ocsh-pane" style={{ left: rem(RHW), top: rem(HDR), width: rem(frozenW), height: rem(frozenH), pointerEvents: "auto" }}>
              {rowsOf(fRows, fCols, 0, 0)}
            </div>
          ) : null}
          {fr ? (
            <div className="ocsh-pane" style={{ left: rem(RHW + frozenW), top: rem(HDR), right: 0, height: rem(frozenH), pointerEvents: "auto" }}>
              <div className="ocsh-in" ref={(el) => regX(el, 1)}>{rowsOf(fRows, bCols, frozenW, 0)}</div>
            </div>
          ) : null}
          {fc ? (
            <div className="ocsh-pane" style={{ left: rem(RHW), top: rem(HDR + frozenH), width: rem(frozenW), bottom: 0, pointerEvents: "auto" }}>
              <div className="ocsh-in" ref={(el) => regY(el, 1)}>{rowsOf(bRows, fCols, 0, frozenH)}</div>
            </div>
          ) : null}
        </div>
        {/* the body scrolls natively */}
        <div style={{ position: "absolute", left: rem(RHW), top: rem(HDR) }}>{rowsOf(bRows, bCols, 0, 0)}</div>
        {peerBoxes}
      </div>
    </div>
  );

  function FilterPanel({ c }: { c: number }) {
    const f = filter!;
    const hr = view!.rows.indexOf(f.row);
    const vals = new Set<string>();
    let last = hr;
    view!.cells.forEach((_, k) => (last = Math.max(last, view!.rIx.get(k.split(":")[0]) ?? 0)));
    for (let r = hr + 1; r <= last; r++) vals.add(display(r, c));
    const list = [...vals].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const [off, setOff] = useState(new Set(f.hide[view!.cols[c]] ?? []));
    const apply = () => {
      filterOn({ ...f, hide: { ...f.hide, [view!.cols[c]]: [...off] } });
      setMenu(null);
      gridRef.current?.focus();
    };
    return (
      <div>
        {canEdit ? (
          <>
            <button className="ocsh-mi" role="menuitem" onClick={() => (sortBy(c, false), setMenu(null))}>
              <ArrowDownAZ size={15} /> Sort A → Z
            </button>
            <button className="ocsh-mi" role="menuitem" onClick={() => (sortBy(c, true), setMenu(null))}>
              <ArrowUpZA size={15} /> Sort Z → A
            </button>
            <div className="ocsh-msep" />
          </>
        ) : null}
        <div className="ocsh-fv" role="group" aria-label="Show values">
          {list.map((v) => (
            <label key={v}>
              <input type="checkbox" checked={!off.has(v)} onChange={(e) => setOff((s) => { const n = new Set(s); if (e.target.checked) n.delete(v); else n.add(v); return n; })} />
              {v === "" ? "(Blanks)" : v}
            </label>
          ))}
        </div>
        <div className="ocsh-fact">
          <button className="ocsh-btn" onClick={() => setOff(new Set())}>Show all</button>
          <button className="ocsh-btn p" onClick={apply}>OK</button>
        </div>
      </div>
    );
  }

  const nameBox = (
    <input
      className="ocsh-nb"
      aria-label="Name box"
      key={`${rectA1(q)}`}
      defaultValue={rectA1(q)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const t = parseRef((e.target as HTMLInputElement).value);
          if (t) {
            e.preventDefault();
            select({ anchor: { r: t.r0, c: t.c0 }, focus: { r: t.r1, c: t.c1 } });
            gridRef.current?.focus();
          }
        } else if (e.key === "Escape") gridRef.current?.focus();
      }}
      onFocus={(e) => e.target.select()}
    />
  );
  const fxBar = (
    <div className="ocsh-fx">
      {nameBox}
      <span className="ocsh-fxi" aria-hidden="true">fx</span>
      {canEdit ? null : <Lock size={13} aria-label="View only" />}
      <input
        ref={fxRef}
        className="ocsh-fxv"
        aria-label="Formula bar"
        readOnly={!canEdit}
        value={fx}
        spellCheck={false}
        onFocus={() => canEdit && !edit && startEdit(null, "edit", true)}
        onChange={(e) => edit && setEdit({ ...edit, draft: e.target.value, bar: true })}
        onKeyDown={(e) => {
          if (!edit) return;
          if (e.key === "Enter") (e.preventDefault(), commit([1, 0]));
          else if (e.key === "Escape") (e.preventDefault(), cancel());
          else if (e.key === "Tab") (e.preventDefault(), commit([0, e.shiftKey ? -1 : 1]));
        }}
        onBlur={(e) => {
          const to = e.relatedTarget as HTMLElement | null;
          if (to?.closest?.(".ocsh-tabs") || to?.classList.contains("ocsh-ce")) return;
          if (edit?.bar) commit();
        }}
      />
    </div>
  );

  const tabs = (
    <div className="ocsh-tabs">
      <div className="ocsh-tabs" role="tablist" aria-label="Sheets">
      {order.map((id) => {
        const v = id === view.id ? view : readView(doc, blockId, id);
        if (!v) return null;
        const on = id === view.id;
        if (renaming === id) return null;
        return (
          <button
            key={id}
            className="ocsh-tab"
            data-tab={id}
            onPointerDown={(e) => {
              if (!canEdit || e.button !== 0) return;
              const x0 = e.clientX;
              let moving = false;
              let to = -1;
              drag(
                (ev) => {
                  if (!moving && Math.abs(ev.clientX - x0) < 6) return;
                  moving = true;
                  const tabsEls = [...document.querySelectorAll<HTMLElement>(`[data-sheet-block="${blockId}"] [data-tab]`)];
                  to = tabsEls.findIndex((t) => ev.clientX < t.getBoundingClientRect().left + t.getBoundingClientRect().width / 2);
                  if (to < 0) to = tabsEls.length;
                  setTabDrop(to);
                },
                () => {
                  setTabDrop(null);
                  if (!moving || to < 0) return;
                  const from = order.indexOf(id);
                  const dest = to > from ? to - 1 : to;
                  if (dest !== from) act(() => moveSheet(doc, blockId, id, dest));
                },
              );
            }}
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onMouseDown={(e) => edit && e.preventDefault()}
            onClick={() => {
              if (id === view.id) return;
              // While a formula is open, another tab only changes what the grid shows (2d).
              if (edit && edit.draft.startsWith("=")) setEdit({ ...edit, bar: true });
              else if (edit) commit();
              setSheetSel(id);
              if (!edit) setSel(at(0, 0));
            }}
            onDoubleClick={() => canEdit && setRenaming(id)}
            onKeyDown={(e) => {
              const i = order.indexOf(id);
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                const n = order[(i + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
                setSheetSel(n);
                requestAnimationFrame(() => (e.currentTarget.parentElement?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()));
              } else if (e.key === "F2" && canEdit) setRenaming(id);
              else if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && canEdit) {
                e.preventDefault();
                const b = e.currentTarget.getBoundingClientRect();
                openMenu(b.left, b.bottom, `Sheet ${v.name}`, tabItems(id));
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (canEdit) openMenu(e.clientX, e.clientY, `Sheet ${v.name}`, tabItems(id));
            }}
          >
            {tabDrop === order.indexOf(id) ? <i className="ocsh-tdrop" aria-hidden="true" /> : null}
            {v.name}
            {(sheetOf(doc, blockId, id)?.get("color") as string | undefined) ? <i className="ocsh-tc" aria-hidden="true" style={{ background: `var(--${sheetOf(doc, blockId, id)!.get("color")}-fg)` }} /> : null}
          </button>
        );
      })}
      </div>
      {renaming && order.includes(renaming) ? (() => {
        const id = renaming;
        const v = readView(doc, blockId, id)!;
        return (
            <input
              className="ocsh-tabin"
              aria-label="Sheet name"
              defaultValue={v.name}
              autoFocus
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(null);
              }}
              onBlur={(e) => {
                const name = e.target.value.trim();
                const taken = order.some((o) => o !== id && readView(doc, blockId, o)?.name.toLowerCase() === name.toLowerCase());
                if (name && name !== v.name && !taken) act(() => renameSheet(doc, blockId, id, name));
                else if (taken) env.toast(`There is already a sheet called “${name}”.`);
                setRenaming(null);
              }}
            />
          );
      })() : null}
      {canEdit ? (
        <button
          className="ocsh-ib"
          aria-label={`${view.name} options`}
          title="Sheet options"
          aria-haspopup="menu"
          onClick={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            openMenu(b.left, b.bottom, `Sheet ${view.name}`, tabItems(view.id));
          }}
        >
          <ChevronDown size={14} />
        </button>
      ) : null}
      {canEdit ? (
        <button className="ocsh-ib" aria-label="Add sheet" title="Add sheet" onClick={addTab}>
          <Plus size={15} />
        </button>
      ) : null}
    </div>
  );

  const values = [] as string[];
  if ((q.r1 - q.r0 + 1) * (q.c1 - q.c0 + 1) <= 200_000) for (let r = q.r0; r <= q.r1; r++) if (!hiddenRows.has(r)) for (let c = q.c0; c <= q.c1; c++) values.push(display(r, c));
  const agg = aggregate(values);
  const fmtN = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const aggEl =
    agg.count > 1 ? (
      <span className="ocsh-agg" aria-live="polite">
        {agg.nums ? (
          <>
            <span>Sum<b>{fmtN(agg.sum)}</b></span>
            <span>Average<b>{fmtN(agg.avg)}</b></span>
          </>
        ) : null}
        <span>Count<b>{agg.count}</b></span>
      </span>
    ) : null;

  const cur = styleAt(sel.anchor.r, sel.anchor.c) ?? {};
  const swatches = (kind: "fg" | "bg") => (
    <div className="ocsh-sw" role="group" aria-label={kind === "fg" ? "Text colour" : "Fill colour"}>
      <button aria-label="Automatic" title="Automatic" onClick={() => (style({ [kind]: null }), setMenu(null))} style={{ background: "var(--app)" }} />
      {TONES.map((t) => (
        <button key={t} aria-label={t} title={t} onClick={() => (style({ [kind]: t }), setMenu(null))} style={{ background: `var(--${t}-${kind === "fg" ? "fg" : "bg"})` }} />
      ))}
    </div>
  );
  const pop = (e: React.MouseEvent, label: string, body: ReactNode) => {
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: b.left, y: b.bottom + 4, label, body });
  };
  const fmtItems: MenuEntry[] = [
    { label: "Automatic", run: () => style({ nf: null, dp: null }) },
    { label: "Number", hint: "1,000.12", run: () => style({ nf: "num", dp: null }) },
    { label: "Percent", hint: "10.12%", run: () => style({ nf: "pct", dp: null }) },
    { label: "Currency", hint: "€1,000.12", run: () => style({ nf: "cur", dp: null }) },
    { label: "Date", hint: "14 Mar 2026", run: () => style({ nf: "date", dp: null }) },
    { label: "Scientific", hint: "1.01E+03", run: () => style({ nf: "sci", dp: null }) },
  ];
  const borderItems: MenuEntry[] = [
    { label: "All borders", run: () => borders("all") },
    { label: "Outer borders", run: () => borders("outer") },
    { label: "Inner borders", run: () => borders("inner") },
    { label: "Top border", run: () => borders("top") },
    { label: "Bottom border", run: () => borders("bottom") },
    { label: "Thick bottom border", run: () => borders("bottomthick") },
    { label: "Top and bottom border", run: () => borders("topandbottom") },
    { label: "Left border", run: () => borders("left") },
    { label: "Right border", run: () => borders("right") },
    "sep",
    { label: "No border", run: () => borders("none") },
  ];
  const toolbar = canEdit ? (
    <div className="ocsh-tb" role="toolbar" aria-label="Formatting">
      <button className="ocsh-ib" aria-label="Undo" title="Undo (Ctrl Z)" disabled={!um?.canUndo()} onClick={() => um?.undo()}><Undo2 size={15} /></button>
      <button className="ocsh-ib" aria-label="Redo" title="Redo (Ctrl Shift Z)" disabled={!um?.canRedo()} onClick={() => um?.redo()}><Redo2 size={15} /></button>
      <i className="ocsh-tbs" />
      <button className="ocsh-ib" aria-label="Format as currency" aria-pressed={cur.nf === "cur"} onClick={() => style({ nf: cur.nf === "cur" ? null : "cur" })}><Euro size={15} /></button>
      <button className="ocsh-ib" aria-label="Format as percent" aria-pressed={cur.nf === "pct"} onClick={() => style({ nf: cur.nf === "pct" ? null : "pct" })}><Percent size={15} /></button>
      <button className="ocsh-tbt" aria-label="Fewer decimals" onClick={() => decimals(-1)}>.0</button>
      <button className="ocsh-tbt" aria-label="More decimals" onClick={() => decimals(1)}>.00</button>
      <button className="ocsh-tbt" aria-label="More formats" aria-haspopup="menu" onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); openMenu(b.left, b.bottom + 4, "Number format", fmtItems); }}>123<ChevronDown size={12} /></button>
      <i className="ocsh-tbs" />
      <button className="ocsh-ib" aria-label="Bold" title="Bold (Ctrl B)" aria-pressed={!!cur.b} onClick={() => toggle("b")}><Bold size={15} /></button>
      <button className="ocsh-ib" aria-label="Italic" title="Italic (Ctrl I)" aria-pressed={!!cur.i} onClick={() => toggle("i")}><Italic size={15} /></button>
      <button className="ocsh-ib" aria-label="Strikethrough" aria-pressed={!!cur.st} onClick={() => toggle("st")}><Strikethrough size={15} /></button>
      <button className="ocsh-ib" aria-label="Text colour" aria-haspopup="true" onClick={(e) => pop(e, "Text colour", swatches("fg"))}><Baseline size={15} /><i className="bar" style={{ background: colour(cur.fg, "fg") ?? "var(--fg)" }} /></button>
      <button className="ocsh-ib" aria-label="Fill colour" aria-haspopup="true" onClick={(e) => pop(e, "Fill colour", swatches("bg"))}><PaintBucket size={15} /><i className="bar" style={{ background: colour(cur.bg, "bg") ?? "var(--line-2)" }} /></button>
      <i className="ocsh-tbs" />
      <button className="ocsh-ib" aria-label="Align left" aria-pressed={cur.al === "l"} onClick={() => style({ al: cur.al === "l" ? null : "l" })}><AlignLeft size={15} /></button>
      <button className="ocsh-ib" aria-label="Align centre" aria-pressed={cur.al === "c"} onClick={() => style({ al: cur.al === "c" ? null : "c" })}><AlignCenter size={15} /></button>
      <button className="ocsh-ib" aria-label="Align right" aria-pressed={cur.al === "r"} onClick={() => style({ al: cur.al === "r" ? null : "r" })}><AlignRight size={15} /></button>
      <i className="ocsh-tbs" />
      <button className="ocsh-ib" aria-label="Borders" aria-haspopup="menu" onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); openMenu(b.left, b.bottom + 4, "Borders", borderItems); }}><Grid2x2 size={15} /></button>
      <button className="ocsh-ib" aria-label={mergeHere.length ? "Unmerge cells" : "Merge cells"} aria-pressed={!!mergeHere.length} onClick={toggleMerge}><TableCellsMerge size={15} /></button>
      <button className="ocsh-ib" aria-label="Wrap text" aria-pressed={!!cur.wr} onClick={() => toggle("wr")}><WrapText size={15} /></button>
      <i className="ocsh-tbs" />
      <button className="ocsh-ib" aria-label="Find and replace" title="Find (Ctrl F), replace (Ctrl H)" onClick={() => (setFind((f) => f ?? { q: "", by: "", replace: true, mc: false, whole: false, formulas: false, all: false }), requestAnimationFrame(() => findRef.current?.focus()))}><Search size={15} /></button>
      <button className="ocsh-ib" aria-label={filter ? "Remove filter" : "Create a filter"} aria-pressed={!!filter} onClick={() => (filter ? filterOn(null) : createFilter())}><Funnel size={15} /></button>
      <button
        className="ocsh-ib"
        aria-label={fr || fc ? "Unfreeze" : `Freeze up to ${a1(sel.anchor)}`}
        title={fr || fc ? "Unfreeze" : "Freeze rows above and columns left of the active cell"}
        aria-pressed={!!(fr || fc)}
        onClick={() => (fr || fc ? freezeTo(0, 0) : freezeTo(sel.anchor.r, sel.anchor.c))}
      >
        <Snowflake size={15} />
      </button>
      {env.sheetActions ? (
        <>
          <i className="ocsh-tbs" />
          <button className="ocsh-ib" aria-label="Chart from selection" title="Chart from selection" onClick={chartSel}><ChartColumn size={15} /></button>
        </>
      ) : null}
    </div>
  ) : null;

  const tsvOf = (q0: Rect) => {
    const out: string[][] = [];
    for (let r = q0.r0; r <= q0.r1; r++) if (!hiddenRows.has(r)) out.push(Array.from({ length: q0.c1 - q0.c0 + 1 }, (_, i) => formatValue(display(r, q0.c0 + i), styleAt(r, q0.c0 + i))));
    return toTsv(out);
  };
  const keep = (e: React.MouseEvent) => e.preventDefault();
  const insertKeys =
    phone && edit ? (
      <div className="ocsh-acc" role="toolbar" aria-label="Insert into the formula">
        {["=", "(", ")", ":", "$", ",", "SUM(", a1(sel.anchor)].map((t, i) => (
          <button key={i} onMouseDown={keep} onClick={() => setEdit((ed) => (ed ? { ...ed, draft: ed.draft + t } : ed))} aria-label={i === 7 ? `Insert ${t}` : undefined}>
            {t}
          </button>
        ))}
      </div>
    ) : null;
  const aaSheet = (
    <div>
      <div className="ocsh-sw" role="group" aria-label="Style">
        <button className="ocsh-ib" aria-label="Bold" aria-pressed={!!cur.b} onClick={() => toggle("b")}><Bold size={16} /></button>
        <button className="ocsh-ib" aria-label="Italic" aria-pressed={!!cur.i} onClick={() => toggle("i")}><Italic size={16} /></button>
        <button className="ocsh-ib" aria-label="Strikethrough" aria-pressed={!!cur.st} onClick={() => toggle("st")}><Strikethrough size={16} /></button>
        <button className="ocsh-ib" aria-label="Align left" aria-pressed={cur.al === "l"} onClick={() => style({ al: cur.al === "l" ? null : "l" })}><AlignLeft size={16} /></button>
        <button className="ocsh-ib" aria-label="Align centre" aria-pressed={cur.al === "c"} onClick={() => style({ al: cur.al === "c" ? null : "c" })}><AlignCenter size={16} /></button>
        <button className="ocsh-ib" aria-label="Align right" aria-pressed={cur.al === "r"} onClick={() => style({ al: cur.al === "r" ? null : "r" })}><AlignRight size={16} /></button>
      </div>
      <div className="ocsh-mcap">Text colour</div>
      {swatches("fg")}
      <div className="ocsh-mcap">Fill colour</div>
      {swatches("bg")}
      <div className="ocsh-msep" />
      {fmtItems.map((it, i) =>
        it === "sep" ? null : (
          <button key={i} role="menuitem" className="ocsh-mi" onClick={() => (it.run(), setMenu(null))}>
            {it.label}
            {it.hint ? <small>{it.hint}</small> : null}
          </button>
        ),
      )}
    </div>
  );
  const findBar = find ? (
    <div className="ocsh-find" role="search" aria-label="Find and replace">
      <input
        ref={findRef}
        aria-label="Find"
        placeholder="Find"
        value={find.q}
        onChange={(e) => setFind({ ...find, q: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.preventDefault(), findStep(e.shiftKey ? -1 : 1));
          if (e.key === "Escape") (setFind(null), gridRef.current?.focus());
        }}
      />
      {find.replace ? <input aria-label="Replace with" placeholder="Replace with" value={find.by} onChange={(e) => setFind({ ...find, by: e.target.value })} onKeyDown={(e) => e.key === "Escape" && (setFind(null), gridRef.current?.focus())} /> : null}
      <span className="ocsh-fcount" aria-live="polite">{find.q ? `${findList.length} found` : ""}</span>
      <label><input type="checkbox" checked={find.mc} onChange={(e) => setFind({ ...find, mc: e.target.checked })} />Match case</label>
      <label><input type="checkbox" checked={find.whole} onChange={(e) => setFind({ ...find, whole: e.target.checked })} />Entire cell</label>
      <label><input type="checkbox" checked={find.formulas || find.replace} disabled={find.replace} onChange={(e) => setFind({ ...find, formulas: e.target.checked })} />In formulas</label>
      <label><input type="checkbox" checked={find.all} onChange={(e) => setFind({ ...find, all: e.target.checked })} />All sheets</label>
      <button className="ocsh-btn" onClick={() => findStep(-1)}>Previous</button>
      <button className="ocsh-btn" onClick={() => findStep(1)}>Next</button>
      {find.replace && canEdit ? <button className="ocsh-btn" onClick={replaceOne}>Replace</button> : null}
      {find.replace && canEdit ? <button className="ocsh-btn p" onClick={replaceAll}>Replace all</button> : null}
      <button className="ocsh-ib" aria-label="Close find" onClick={() => (setFind(null), gridRef.current?.focus())}><X size={14} /></button>
    </div>
  ) : null;

  const actionBar =
    phone && canEdit && !edit ? (
      <div className="ocsh-act" role="toolbar" aria-label="Selection">
        <button className="ocsh-tbt" onClick={() => void navigator.clipboard?.writeText(tsvOf(q)).then(() => setNote({ text: `Copied ${rectA1(q)}.` }), () => undefined)}>Copy</button>
        <button
          className="ocsh-tbt"
          onClick={() =>
            void navigator.clipboard?.readText().then(
              (t) => {
                const got = pasteGrid(parseTsv(t).map((r) => r.map((v) => ({ v }))), "the clipboard", false, null);
                if (got) setNote({ text: `Pasted ${got.h} × ${got.w}.` });
              },
              () => env.toast("Paste needs clipboard access."),
            )
          }
        >
          Paste
        </button>
        <button className="ocsh-tbt" onClick={fillDown} disabled={q.r1 === q.r0}>Fill</button>
        <button className="ocsh-tbt" onClick={() => clearRect(q)}>Clear</button>
        <span className="ocsh-grow" />
        <button className="ocsh-tbt" aria-label="Format" aria-haspopup="dialog" onClick={(e) => pop(e, "Format", aaSheet)}>Aa</button>
      </div>
    ) : null;

  const menuEl = menu ? <Menu m={typeof menu.items === "string" ? { ...menu, items: { row: rowItems, col: colItems, cell: cellItems }[menu.items]() } : menu} onClose={(refocus) => (setMenu(null), refocus && gridRef.current?.focus({ preventScroll: true }))} /> : null;
  const noteEl = note ? (
    <div className="ocsh-note" role="status">
      <span>{note.text}</span>
      {note.values ? <button className="ocsh-btn" onClick={() => (note.values!(), setNote(null))}>Paste values only</button> : null}
      {um ? <button className="ocsh-btn" onClick={() => (um.undo(), setNote(null), gridRef.current?.focus())}>Undo</button> : null}
      <button className="ocsh-ib" aria-label="Dismiss" onClick={() => setNote(null)}><X size={14} /></button>
    </div>
  ) : null;

  if (full)
    return (
      <>
        <div className="ocsh" aria-hidden="true"><div className="ocsh-load">Open in full screen</div></div>
        {createPortal(
          <div className="ocsh-full" role="dialog" aria-modal="true" aria-label={`Spreadsheet, ${view.name}`} data-sheet-block={blockId}>
            <div className="ocsh-h" style={{ minHeight: "3.25rem", gap: ".625rem", padding: "0 .75rem" }}>
              <button className="ocsh-btn" onClick={toggleFull} title="Close (Ctrl Shift E)"><X size={15} />Close</button>
              <span className="ocsh-hi"><SheetIcon size={15} /></span>
              <span className="ocsh-tt">Spreadsheet</span>
              <span className="ocsh-grow" />
              {canEdit ? null : <span className="ocsh-tbt"><Lock size={13} /> View only</span>}
            </div>
            {phone ? null : toolbar}
            {fxBar}
            {findBar}
            {insertKeys}
            {grid}
            {actionBar}
            <div className="ocsh-sb">{tabs}{aggEl}</div>
            {noteEl}
          </div>,
          document.body,
        )}
        {menuEl}
      </>
    );

  return (
    <div className={"ocsh compact" + (phone ? " ph" : "") + (flash ? " flash" : "")} data-sheet-block={blockId}>
      <div className="ocsh-h">
        <span className="ocsh-hi"><SheetIcon size={15} /></span>
        <b className="ocsh-hn">Spreadsheet</b>
        {phone ? null : tabs}
        <span className="ocsh-grow" />
        {canEdit ? null : <span className="ocsh-tbt"><Lock size={13} /> View only</span>}
        {phone ? null : aggEl}
        {canEdit && env.sheetActions ? (
          <button className="ocsh-ib" aria-label="Chart from selection" title="Chart from selection" onClick={chartSel}>
            <ChartColumn size={15} />
          </button>
        ) : null}
        <button className="ocsh-ib hot" aria-label="Open full screen" title="Open full screen (Ctrl Shift E)" onClick={toggleFull}>
          <Maximize2 size={15} />
        </button>
      </div>
      {fxBar}
      {findBar}
      {insertKeys}
      {grid}
      {actionBar}
      {phone ? <div className="ocsh-sb">{tabs}{aggEl}</div> : null}
      {noteEl}
      {menuEl}
    </div>
  );
}

/** F4 while editing: B1 → $B$1 → B$1 → $B1 → B1 on the reference before the caret (the last). */
export function cycleAbs(f: string): string {
  const m = /(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?!.*[A-Za-z]{1,3}\$?\d)/.exec(f);
  if (!m || m.index == null) return f;
  const [all, d1, col, d2, row] = m;
  const next = !d1 && !d2 ? `$${col}$${row}` : d1 && d2 ? `${col}$${row}` : !d1 && d2 ? `$${col}${row}` : `${col}${row}`;
  return f.slice(0, m.index) + next + f.slice(m.index + all.length);
}

interface Peer {
  id: number;
  name: string;
  color: string;
  s: string;
  a: [string, string];
  f: [string, string];
  ed: boolean;
}
function usePeers(awareness: AwarenessLike | undefined, blockId: string): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    if (!awareness) return;
    const read = () => {
      const out: Peer[] = [];
      awareness.getStates().forEach((st, id) => {
        if (id === awareness.clientID || !st) return;
        const s = st.sheet as Partial<Peer> & { id?: string; s?: string } | null | undefined;
        if (!s || s.id !== blockId || !Array.isArray(s.a) || !Array.isArray(s.f) || typeof s.s !== "string") return;
        const u = (st.user ?? {}) as { name?: string; color?: string };
        out.push({ id, name: String(u.name ?? "Someone"), color: String(u.color ?? "var(--u2)"), s: s.s, a: s.a as [string, string], f: s.f as [string, string], ed: !!s.ed });
      });
      setPeers((p) => (JSON.stringify(p) === JSON.stringify(out) ? p : out));
    };
    read();
    awareness.on("change", read);
    return () => awareness.off("change", read);
  }, [awareness, blockId]);
  return peers;
}

/** A context menu or popover: arrow keys move, Esc closes and returns focus to the grid. */
function Menu({ m, onClose }: { m: MenuState; onClose: (refocus: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: m.x, y: m.y });
  const items = typeof m.items === "string" ? undefined : m.items;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(m.x, innerWidth - b.width - 8)), y: Math.max(8, Math.min(m.y, innerHeight - b.height - 8)) });
    (el.querySelector<HTMLElement>('[role="menuitem"],input,button') ?? el).focus();
  }, [m.x, m.y, m.label]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose(false);
    };
    const t = setTimeout(() => document.addEventListener("pointerdown", down, true));
    return () => (clearTimeout(t), document.removeEventListener("pointerdown", down, true));
  }, [onClose]);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
  };
  return createPortal(
    <div ref={ref} className="ocsh-pop" role={items ? "menu" : "dialog"} aria-label={m.label} style={{ left: pos.x + "px", top: pos.y + "px" }} onKeyDown={key}>
      {items
        ? items.map((it, i) =>
            it === "sep" ? (
              <div key={i} className="ocsh-msep" role="separator" />
            ) : (
              <button key={i} role="menuitem" className={"ocsh-mi" + (it.danger ? " dan" : "")} onClick={() => (onClose(true), it.run())}>
                {it.icon}
                {it.label}
                {it.hint ? <small>{it.hint}</small> : null}
              </button>
            ),
          )
        : m.body}
    </div>,
    document.body,
  );
}
