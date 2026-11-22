import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as Y from "yjs";
import {
  ArrowDown, ArrowLeft, ArrowLeftToLine, ArrowRight, ArrowRightToLine, ArrowUp, ArrowUpDown, Calendar, CalendarDays, CalendarRange, Check, ChevronDown, ChevronLeft, ChevronRight,
  ChevronUp, Columns3, Copy, Download, Ellipsis, ExternalLink, GripVertical, Inbox, LayoutGrid, ListChecks, ListFilter, PanelRightOpen, Plus, Search,
  EyeOff, Info, SlidersHorizontal, SquareKanban, Sun, Table, Trash2, Upload, X, type LucideIcon,
} from "lucide-react";
import type { BlockEnv, OcUser, Tone } from "@opencanvas/ui";
import { CsvImportDialog } from "./CsvImportDialog";
import {
  addField, addOption, addRow, appendCsv, clearCells, databasesRoot, databaseToCsv, databaseToMarkdown, DB_ORIGIN, deleteField, deleteRow, FIELD_LABEL,
  getDbMap, moveRow, OPTION_TYPES, pasteCells, readDb, renameField, restoreField, restoreRow, setCell, setDbMeta, setFieldType, setNote,
  setFieldDescription, setOptions, setPrefs, setView,
} from "./model";
import { DEMO_PEOPLE } from "./presets";
import {
  addDays, dateField, defaultMonth, filterLabel, filterOps, filterPatch, filtersOf, fmtDate, groupField, highlightParts, isoDate, isoMonth, MONTHS,
  OP_LABEL, optOf, orderedFields, ruleReady, rulesOf, shiftMonth, sortPatch, sortsOf, titleField, viewFields, visibleRows,
} from "./query";
import { ensureStyles } from "./styles";
import type { CellValue, DbField, DbOption, DbRow, DbSnapshot, FieldType, FilterOp, FilterRule, ViewKind, ViewPrefs } from "./types";
import { FIELD_TYPES } from "./types";
import { Avatar, CommitInput, dbIcon, Ic, Pop, TYPE_ICON, type Anchor } from "./ui";
import { inRange, isGridText, isMulti, moveCell, parseTsv, rangeBounds, rangeToHtml, rangeToTsv, type CellPos, type CellRange } from "./grid";

/* ------------------------------------------------------------- store */

/** Subscribe to one database with observeDeep; returns a cached immutable snapshot. */
function useDb(doc: Y.Doc, dbId: string): DbSnapshot | null {
  const cache = useRef<{ ver: number; snap: DbSnapshot | null; at: number }>({ ver: 0, snap: null, at: -1 });
  const subscribe = useCallback(
    (cb: () => void) => {
      const root = databasesRoot(doc);
      let inner: Y.Map<unknown> | null = null;
      const bump = () => {
        cache.current.ver++;
        cb();
      };
      const attach = () => {
        const m = getDbMap(doc, dbId);
        if (m === inner) return;
        inner?.unobserveDeep(bump);
        inner = m;
        inner?.observeDeep(bump);
      };
      const onRoot = (e: Y.YMapEvent<Y.Map<unknown>>) => {
        if (e.keysChanged.has(dbId)) {
          attach();
          bump();
        }
      };
      root.observe(onRoot);
      attach();
      return () => {
        root.unobserve(onRoot);
        inner?.unobserveDeep(bump);
      };
    },
    [doc, dbId],
  );
  const get = useCallback(() => {
    const c = cache.current;
    if (c.at !== c.ver) {
      const m = getDbMap(doc, dbId);
      c.snap = m ? reuse(c.snap, readDb(dbId, m)) : null;
      c.at = c.ver;
    }
    return c.snap;
  }, [doc, dbId]);
  // Reset cache when the target changes.
  const key = useRef("");
  if (key.current !== dbId) {
    key.current = dbId;
    cache.current = { ver: 0, snap: null, at: -1 };
  }
  return useSyncExternalStore(subscribe, get, get);
}

const sameVal = (a: CellValue | undefined, b: CellValue | undefined) =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]));

/**
 * Keep the previous snapshot's row and field objects when they did not change, so memoised
 * rows skip rendering: with 1,000 rows one edit re-renders one row, not the whole table.
 */
function reuse(prev: DbSnapshot | null, next: DbSnapshot): DbSnapshot {
  if (!prev || prev.id !== next.id) return next;
  const old = new Map(prev.rows.map((r) => [r.id, r]));
  const rows = next.rows.map((r) => {
    const o = old.get(r.id);
    if (!o) return r;
    const ka = Object.keys(o.v), kb = Object.keys(r.v);
    return ka.length === kb.length && kb.every((k) => sameVal(o.v[k], r.v[k])) ? o : r;
  });
  const fields = JSON.stringify(prev.fields) === JSON.stringify(next.fields) ? prev.fields : next.fields;
  return { ...next, rows, fields };
}

/* ------------------------------------------------------------ helpers */

const VIEWS: [ViewKind, string, LucideIcon][] = [
  ["table", "Table", Table],
  ["board", "Board", SquareKanban],
  ["calendar", "Calendar", CalendarDays],
  ["gallery", "Gallery", LayoutGrid],
];
const W: Record<FieldType, number> = { title: 300, text: 180, status: 150, select: 160, tags: 190, person: 160, date: 120, number: 110, checkbox: 90, url: 190, progress: 160 };
const isEmpty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && !v.length);
const fmtNum = (n: number) => (Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "");

type People = { resolve: (id: unknown) => OcUser | null; pickable: OcUser[] };

function usePeople(env: BlockEnv, db: DbSnapshot | null): People {
  // Only the set of sample people still referenced matters; keying on it keeps `people`
  // stable across ordinary edits (so memoised rows don't all re-render).
  const demoKey = useMemo(() => {
    const referenced = new Set<string>();
    if (db) for (const f of db.fields) if (f.type === "person") for (const r of db.rows) if (typeof r.v[f.id] === "string" && r.v[f.id]) referenced.add(r.v[f.id] as string);
    return DEMO_PEOPLE.filter((d) => referenced.has(d.id)).map((d) => d.id).join(",");
  }, [db]);
  return useMemo(() => {
    const byId = new Map<string, OcUser>();
    for (const u of [env.me, ...env.users]) if (u && !byId.has(u.id)) byId.set(u.id, u);
    const referenced = new Set(demoKey.split(","));
    for (const d of DEMO_PEOPLE) if (!byId.has(d.id) && referenced.has(d.id)) byId.set(d.id, d);
    const pickable = [...byId.values()];
    // docs/21: any id renders with its current member name when the
    // editor offers it, so people who lost access show their snapshot label.
    const person = env.person;
    const resolve = (id: unknown): OcUser | null => {
      if (!id) return null;
      const s = String(id);
      const seen = person?.(s);
      if (seen && seen.name !== s) return seen;
      return byId.get(s) ?? DEMO_PEOPLE.find((d) => d.id === s) ?? seen ?? { id: s, name: s, color: "var(--fg-3)" };
    };
    return { resolve, pickable };
  }, [env.me, env.users, env.person, demoKey]);
}

const firstName = (u: OcUser) => u.name.split(/\s+/)[0];

/* ------------------------------------------------------------- values */

/** Text with search matches wrapped in <mark>. */
function Hl({ text, q }: { text: string; q?: string }): ReactNode {
  if (!q || !q.trim()) return text;
  return highlightParts(text, q).map((p, i) => (p.hit ? <mark key={i} className="ocdb-hl">{p.t}</mark> : p.t));
}

function Pill({ label, c, st, q }: { label: string; c?: string; st?: boolean; q?: string }) {
  return <span className={`ocdb-pill ocdb-c-${c ?? "gray"}${st ? " st" : ""}`}><Hl text={label} q={q} /></span>;
}

function Value({ f, v, people, peek, q }: { f: DbField; v: CellValue | undefined; people: People; peek?: boolean; q?: string }): ReactNode {
  const empty = <span className="ocdb-emptyc">{peek ? "Empty" : ""}</span>;
  switch (f.type) {
    case "status":
    case "select": {
      const o = optOf(f, v);
      return o ? <Pill label={o.v} c={o.c} st={f.type === "status"} q={q} /> : typeof v === "string" && v ? <Pill label={v} q={q} /> : empty;
    }
    case "tags":
      return Array.isArray(v) && v.length ? <>{v.map((t) => <Pill key={t} label={t} c={optOf(f, t)?.c} q={q} />)}</> : empty;
    case "person": {
      const u = people.resolve(v);
      // `data-person-id`: the editor's hover card (name, second line, avatar) on hover/focus.
      return u ? (
        <span className={"ocdb-person" + (u.deactivated ? " former" : "")} data-person-id={u.id}>
          <Avatar u={u} />
          <span aria-label={u.deactivated ? `${u.name}, no longer has access` : undefined}><Hl text={u.name} q={q} /></span>
        </span>
      ) : empty;
    }
    case "date":
      return v ? <span style={{ fontVariantNumeric: "tabular-nums" }}><Hl text={fmtDate(v)} q={q} /></span> : empty;
    case "progress": {
      const n = Math.max(0, Math.min(100, Number(v) || 0));
      return (
        <span className="ocdb-prog">
          <i><b style={{ width: n + "%" }} /></i>
          <span>{n}%</span>
        </span>
      );
    }
    case "url":
      return v ? (
        <a className="ocdb-url" href={safeUrl(String(v))} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          <Hl text={String(v).replace(/^https?:\/\//, "")} q={q} />
        </a>
      ) : empty;
    case "number":
      return v == null || v === "" ? empty : <Hl text={fmtNum(Number(v))} q={q} />;
    default:
      return v ? <Hl text={String(v)} q={q} /> : empty;
  }
}

function safeUrl(u: string): string {
  return /^(https?:|mailto:)/i.test(u) ? u : "https://" + u.replace(/^\/+/, "");
}

/* --------------------------------------------------------- pop state */

type PopState =
  | { kind: "cell"; rowId: string; fid: string; anchor: Anchor; key: string }
  | { kind: "header"; fid: string; anchor: Anchor; key: string }
  | { kind: "filter"; fid?: string; at?: number; anchor: Anchor; key: string }
  | { kind: "fields"; anchor: Anchor; key: string }
  | { kind: "sort"; anchor: Anchor; key: string }
  /** Naming a field (`isNew`: just added, so Escape removes it again). */
  | { kind: "fieldNew"; fid: string; isNew: boolean; anchor: Anchor; key: string }
  | { kind: "describe"; fid: string; anchor: Anchor; key: string }
  | { kind: "more"; anchor: Anchor; key: string }
  | { kind: "settings"; anchor: Anchor; key: string }
  | { kind: "fieldType"; fid: string; anchor: Anchor; key: string }
  | { kind: "options"; fid: string; anchor: Anchor; key: string };

/* ========================================================== component */

export function DatabaseBlock({ doc, dbId, env }: { doc: Y.Doc; dbId: string; env: BlockEnv }) {
  ensureStyles();
  const db = useDb(doc, dbId);
  if (!db) {
    return (
      <div className={"ocdb" + (env.compact ? " ocdb-compact" : "")}>
        <p className="ocdb-hint">This database is missing or still loading.</p>
      </div>
    );
  }
  return <DbView doc={doc} db={db} env={env} />;
}

function DbView({ doc, db, env }: { doc: Y.Doc; db: DbSnapshot; env: BlockEnv }) {
  const edit = env.role === "edit";
  const compact = env.compact;
  const dbId = db.id;
  const people = usePeople(env, db);
  // Editors share view + prefs through Yjs. Viewers/commenters cannot write the document,
  // so their view switch, filter, sort and search stay local to this tab.
  const [localView, setLocalView] = useState<ViewKind | null>(null);
  const [localPrefs, setLocalPrefs] = useState<Record<string, ViewPrefs>>({});
  const view: ViewKind = edit ? db.view : (localView ?? db.view);
  const prefs: ViewPrefs = useMemo(() => (edit ? (db.views[view] ?? {}) : { ...(db.views[view] ?? {}), ...(localPrefs[view] ?? {}) }), [edit, db.views, view, localPrefs]);
  const rows = useMemo(() => visibleRows(db, prefs, people.pickable), [db, prefs, people]);
  const [pop, setPop] = useState<PopState | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [showQ, setShowQ] = useState(!!prefs.q);
  const [qDraft, setQDraft] = useState<string | null>(null);
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Range selections index the visible rows; a new sort / filter / search starts afresh.
  const queryKey = JSON.stringify([prefs.sorts ?? prefs.sort, prefs.filters ?? prefs.filter, prefs.q]);
  const gwRef = useRef<HTMLDivElement>(null);

  // Stable so memoised table rows don't re-render when the popover changes.
  const open = useCallback((p: PopState) => setPop((cur) => (cur && cur.key === p.key ? null : p)), []);
  const patchPrefs = (patch: Partial<ViewPrefs>) => {
    if (edit) setPrefs(doc, dbId, view, patch);
    else setLocalPrefs((lp) => ({ ...lp, [view]: { ...(lp[view] ?? {}), ...patch } }));
  };

  /* ---- adding a field: add, scroll to it, flash the column, name it in place ---- */
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const flashField = (fid: string) => {
    clearTimeout(flashTimer.current);
    setFlash(fid);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  };
  /** Field whose naming popover opens once its header exists (and the anchor to use otherwise). */
  const pendingNew = useRef<{ fid: string; fallback: Anchor } | null>(null);
  /** Header to give focus back to after a field popover closes. */
  const headBack = useRef<string | null>(null);
  const addFieldAt = (type: FieldType, fallback: Anchor, at?: { fid: string; side: -1 | 1 }) => {
    if (!edit) return;
    um?.stopCapturing();
    const fid = addField(doc, dbId, type);
    if (at) {
      const ids = orderedFields(db, prefs).map((f) => f.id).filter((x) => x !== fid);
      const i = ids.indexOf(at.fid);
      ids.splice(i < 0 ? ids.length : at.side < 0 ? i : i + 1, 0, fid);
      patchPrefs({ fields: ids });
    }
    // A field hidden in this view would never show its new column: make sure it isn't.
    if ((prefs.hidden ?? []).includes(fid)) patchPrefs({ hidden: (prefs.hidden ?? []).filter((x) => x !== fid) });
    pendingNew.current = { fid, fallback };
    setPop(null);
    flashField(fid);
  };
  useLayoutEffect(() => {
    const p = pendingNew.current;
    if (p) {
      const btn = gwRef.current?.querySelector<HTMLElement>(`th[data-fid="${p.fid}"] .ocdb-hcell`);
      if (!btn && view === "table" && !db.fields.some((f) => f.id === p.fid)) return; // not in the snapshot yet
      pendingNew.current = null;
      btn?.closest("th")?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
      setPop({ kind: "fieldNew", fid: p.fid, isNew: true, anchor: btn ?? p.fallback, key: "fn" + p.fid });
      return;
    }
    const h = headBack.current;
    if (h && !pop) {
      headBack.current = null;
      const btn = gwRef.current?.querySelector<HTMLElement>(`th[data-fid="${h}"] .ocdb-hcell`) ?? gwRef.current?.querySelector<HTMLElement>(".ocdb-addcol button");
      btn?.focus({ preventScroll: true });
    }
  });
  const closePop = () => {
    if (pop && (pop.kind === "fieldNew" || pop.kind === "describe" || pop.kind === "header")) headBack.current = pop.fid;
    setPop(null);
  };
  /** Escape while naming a field that was just added removes it again. */
  const discardNew = () => {
    if (pop?.kind !== "fieldNew" || !pop.isNew) return closePop();
    const f = db.fields.find((x) => x.id === pop.fid);
    deleteField(doc, dbId, pop.fid);
    if (prefs.fields?.includes(pop.fid)) patchPrefs({ fields: prefs.fields.filter((x) => x !== pop.fid) });
    setFlash(null);
    headBack.current = "__add";
    setPop(null);
    env.toast(`Discarded the new field${f ? ` “${f.name}”` : ""}`);
  };

  useEffect(() => {
    if (peek && !db.rows.some((r) => r.id === peek)) setPeek(null);
  }, [db.rows, peek]);

  /* ---- undo: this user's own changes to this database (Cmd/Ctrl+Z, Shift+Cmd+Z, Ctrl+Y) ---- */
  // With the editor's manager (env.undoManager) database edits join the canvas undo stack;
  // without one the block keeps its own.
  const shared = env.undoManager;
  const um = useMemo(() => {
    const m = getDbMap(doc, dbId);
    if (!m) return null;
    if (shared) {
      shared.addToScope(m);
      shared.trackedOrigins.add(DB_ORIGIN);
      return shared;
    }
    return new Y.UndoManager(m, { trackedOrigins: new Set([DB_ORIGIN]), captureTimeout: 500 });
  }, [doc, dbId, shared]);
  useEffect(() => () => void (um && um !== shared && um.destroy()), [um, shared]);
  const onRootKey = (e: React.KeyboardEvent) => {
    if (!edit || !um || !(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== "z" && k !== "y") return;
    // Text fields keep their own (native) undo while they have focus.
    const t = e.target as HTMLElement;
    // Only editable elements inside this block count: the block itself lives in the editor's
    // contenteditable document.
    const ce = t.closest("textarea,[contenteditable='true']");
    if ((ce && e.currentTarget.contains(ce)) || (t instanceof HTMLInputElement && !t.readOnly && t.type !== "checkbox" && t.type !== "range")) return;
    e.preventDefault();
    e.stopPropagation();
    const redo = k === "y" || e.shiftKey;
    if (redo ? !um.redoStack.length : !um.undoStack.length) return env.toast(redo ? "Nothing to redo" : "Nothing to undo");
    if (redo) um.redo();
    else um.undo();
  };

  const newRow = (values: Record<string, CellValue> = {}, openPeek = view !== "table") => {
    if (!edit) return;
    const v = { ...values };
    const st = db.fields.find((f) => f.type === "status");
    if (st && !(st.id in v) && st.options?.length) v[st.id] = st.options[0].v;
    const rid = addRow(doc, dbId, v);
    if (filtersOf(db, prefs).length || prefs.q) patchPrefs({ ...filterPatch([]), q: "" });
    setQDraft(null);
    if (openPeek) setPeek(rid);
    else setFocusRow(rid);
  };

  const removeRow = (rid: string) => {
    const b = deleteRow(doc, dbId, rid);
    setPeek(null);
    if (b) env.toast("Row deleted", { label: "Undo", run: () => restoreRow(doc, dbId, b) });
  };

  const exportCsv = () => {
    const csv = databaseToCsv(doc, dbId, people.pickable);
    const name = (db.name || "database").replace(/[\\/:*?"<>|]+/g, "-");
    try {
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name + ".csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      env.toast(`Exported ${db.rows.length} ${db.rows.length === 1 ? "row" : "rows"} as CSV`);
    } catch {
      navigator.clipboard?.writeText(csv).then(
        () => env.toast("CSV copied to the clipboard"),
        () => env.toast("Couldn't export CSV"),
      );
    }
  };

  const copyMd = () => {
    const md = databaseToMarkdown(db, people.pickable);
    const p = navigator.clipboard?.writeText(md);
    if (p) p.then(() => env.toast(`Copied ${db.rows.length} rows as a Markdown table`), () => env.toast("Couldn't copy to the clipboard"));
    else env.toast("Clipboard isn't available here");
  };

  // Search: local draft while typing, shared through view prefs.
  const qValue = qDraft ?? prefs.q ?? "";
  const searchOn = showQ || !!prefs.q;

  /* ---- chips ---- */
  const chips: ReactNode[] = [];
  const filters = filtersOf(db, prefs);
  const rules = rulesOf(db, prefs);
  const sorts = sortsOf(db, prefs);
  const hiddenCount = db.fields.filter((f) => f.type !== "title" && (prefs.hidden ?? []).includes(f.id)).length;
  const personLabel = (v: string) => (people.resolve(v) ? firstName(people.resolve(v)!) : v);
  rules.forEach((flt, i) => {
    const f = db.fields.find((x) => x.id === flt.f)!;
    const label = filterLabel(f, flt, f.type === "person" ? personLabel : undefined);
    const ready = ruleReady(f, flt);
    chips.push(
      <span className={"ocdb-chip" + (ready ? "" : " draft")} key={"f" + i}>
        <button className="ocdb-chip-b" onClick={(e) => open({ kind: "filter", fid: f.id, at: i, anchor: e.currentTarget, key: "filter" })} aria-label={`Filter: ${label}${ready ? "" : " (not set yet)"}. Edit`}>
          <Ic i={ListFilter} s={12} />
          <span>{label}</span>
        </button>
        <button className="ocdb-chip-x" onClick={() => patchPrefs(filterPatch(rules.filter((_, j) => j !== i)))} aria-label={`Remove filter ${label}`}><Ic i={X} s={12} /></button>
      </span>,
    );
  });
  sorts.forEach((s, i) => {
    const f = db.fields.find((x) => x.id === s.f)!;
    chips.push(
      <span className="ocdb-chip" key={"s" + s.f}>
        <button className="ocdb-chip-b" onClick={(e) => open({ kind: "sort", anchor: e.currentTarget, key: "sort" })} aria-label={`Sorted by ${f.name}, ${s.dir > 0 ? "ascending" : "descending"}. Edit sort`}>
          <Ic i={s.dir > 0 ? ArrowUp : ArrowDown} s={12} />
          <span>{sorts.length > 1 ? `${i + 1}. ` : ""}{f.name}</span>
        </button>
        <button className="ocdb-chip-x" onClick={() => patchPrefs(sortPatch(sorts.filter((_, j) => j !== i)))} aria-label={`Remove sort by ${f.name}`}><Ic i={X} s={12} /></button>
      </span>,
    );
  });

  const Icon = dbIcon(db.icon);
  const ctx: Ctx = { doc, db, env, edit, compact, people, rows, prefs, open, setPeek, newRow, focusRow, setFocusRow, patchPrefs, view, flash, addFieldAt, onImport: edit ? () => setImportOpen(true) : undefined };

  const importCsv = (csv: string) => {
    // A private origin so the toast's Undo removes exactly this import, whatever happened since.
    const m = getDbMap(doc, dbId);
    const origin = { csvImport: dbId };
    const once = m ? new Y.UndoManager(m, { trackedOrigins: new Set([origin]) }) : null;
    um?.stopCapturing();
    um?.trackedOrigins.add(origin);
    let n = 0;
    doc.transact(() => void (n = appendCsv(doc, dbId, csv, people.pickable)), origin);
    if (!n) {
      once?.destroy();
      return env.toast("Nothing to import");
    }
    setTimeout(() => once?.destroy(), 120_000);
    env.toast(`Imported ${n} ${n === 1 ? "row" : "rows"}`, once ? { label: "Undo", run: () => { once.undo(); once.destroy(); } } : undefined);
  };

  return (
    <div className={"ocdb" + (compact ? " ocdb-compact" : "") + (edit ? "" : " ocdb-ro")} data-db={dbId} onKeyDown={onRootKey}>
      <div className="ocdb-h">
        <span className={`ocdb-hi ocdb-c-${db.tone}`}><Ic i={Icon} s={14} /></span>
        <CommitInput
          className="ocdb-hn"
          value={db.name}
          readOnly={!edit}
          placeholder="Untitled database"
          ariaLabel="Database name"
          onCommit={(v) => setDbMeta(doc, dbId, { name: v })}
        />
        <span className="ocdb-hc">{db.rows.length} {db.rows.length === 1 ? "row" : "rows"}</span>
      </div>

      <div className="ocdb-bar">
        <div className="ocdb-tabs" role="tablist" aria-label="Views">
          {VIEWS.map(([k, label, I]) => (
            <button
              key={k}
              className="ocdb-tab"
              role="tab"
              aria-selected={view === k}
              onClick={() => (edit ? setView(doc, dbId, k) : setLocalView(k))}
            >
              <Ic i={I} s={14} />
              {label}
            </button>
          ))}
        </div>
        <div className="ocdb-tools">
          <input
            ref={searchRef}
            className={"ocdb-search" + (searchOn ? " show" : "")}
            placeholder="Search"
            aria-label="Search rows"
            tabIndex={searchOn ? 0 : -1}
            value={qValue}
            onChange={(e) => {
              setQDraft(e.target.value);
              patchPrefs({ q: e.target.value });
            }}
            onBlur={() => {
              setQDraft(null);
              if (!qValue) setShowQ(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQDraft(null);
                patchPrefs({ q: "" });
                setShowQ(false);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <button
            className={"ocdb-ib" + (searchOn ? " on" : "")}
            title="Search"
            aria-label="Search"
            onClick={() => {
              if (searchOn && qValue) {
                patchPrefs({ q: "" });
                setQDraft(null);
                setShowQ(false);
              } else {
                setShowQ(true);
                // Focus now (inside the click) so typing straight away lands in the field.
                searchRef.current?.focus();
              }
            }}
          >
            <Ic i={Search} />
          </button>
          <button className={"ocdb-ib" + (filters.length ? " on" : "")} title="Filter" aria-label={filters.length ? `Filter (${filters.length} active)` : "Filter"} aria-haspopup="dialog" onClick={(e) => open({ kind: "filter", anchor: e.currentTarget, key: "filter" })}>
            <Ic i={ListFilter} />
          </button>
          <button className={"ocdb-ib" + (hiddenCount ? " on" : "")} title="Fields" aria-label={hiddenCount ? `Fields (${hiddenCount} hidden)` : "Fields"} aria-haspopup="dialog" onClick={(e) => open({ kind: "fields", anchor: e.currentTarget, key: "fields" })}>
            <Ic i={Columns3} />
          </button>
          <button className={"ocdb-ib" + (sorts.length ? " on" : "")} title="Sort" aria-label={sorts.length ? `Sort (${sorts.length} active)` : "Sort"} aria-haspopup="dialog" onClick={(e) => open({ kind: "sort", anchor: e.currentTarget, key: "sort" })}>
            <Ic i={ArrowUpDown} />
          </button>
          {view !== "table" ? (
            <button className="ocdb-ib" title="View settings" aria-label={`${VIEWS.find((x) => x[0] === view)![1]} view settings`} aria-haspopup="dialog" onClick={(e) => open({ kind: "settings", anchor: e.currentTarget, key: "settings" })}>
              <Ic i={SlidersHorizontal} />
            </button>
          ) : null}
          <button className="ocdb-ib" title="More" aria-label="Database options" onClick={(e) => open({ kind: "more", anchor: e.currentTarget, key: "more" })}>
            <Ic i={Ellipsis} />
          </button>
        </div>
      </div>
      {chips.length ? <div className="ocdb-chips">{chips}</div> : null}

      <div className="ocdb-view">
        {view === "table" ? (
          <TableView key={queryKey} ctx={ctx} gwRef={gwRef} />
        ) : view === "board" ? (
          <KanbanView ctx={ctx} />
        ) : view === "calendar" ? (
          <CalendarView ctx={ctx} />
        ) : (
          <GalleryView ctx={ctx} />
        )}
        {!rows.length && db.rows.length && view !== "calendar" ? (
          <div className="ocdb-nomatch">
            No rows match.
            <button className="ocdb-btn ghost sm" onClick={() => { patchPrefs({ ...filterPatch([]), q: "" }); setQDraft(null); setShowQ(false); }}>Clear filters</button>
          </div>
        ) : null}
      </div>

      {pop ? (
        <Pop
          anchor={pop.anchor}
          compact={compact}
          onClose={closePop}
          onEscape={pop.kind === "fieldNew" ? discardNew : undefined}
          alignRight={pop.kind !== "cell" && pop.kind !== "header" && pop.kind !== "fieldNew" && pop.kind !== "describe"}
          title={popTitle(pop, db)}
        >
          <PopBody
            pop={pop}
            ctx={ctx}
            close={closePop}
            setPop={setPop}
            onImport={() => setImportOpen(true)}
            onExport={exportCsv}
            onCopyMd={copyMd}
            gwRef={gwRef}
          />
        </Pop>
      ) : null}

      {peek ? <Peek ctx={ctx} rowId={peek} onClose={() => setPeek(null)} onDelete={removeRow} /> : null}

      <CsvImportDialog
        open={importOpen}
        env={env}
        title={`Import CSV into “${db.name || "Untitled"}”`}
        onClose={() => setImportOpen(false)}
        onImport={importCsv}
      />
    </div>
  );
}

/**
 * The view's whole field order (`prefs.fields`) with `fid` moved to position `to` among the
 * fields the view shows; hidden fields keep their place. Reordering never rewrites the shared
 * `fields` array, so a collaborator's rename at the same moment can't be lost.
 */
function moveInView(db: DbSnapshot, prefs: ViewPrefs, fid: string, to: number): string[] {
  const all = orderedFields(db, prefs).map((f) => f.id);
  const shown = viewFields(db, prefs).map((f) => f.id);
  const from = shown.indexOf(fid);
  const t = Math.max(0, Math.min(to, shown.length - 1));
  if (from < 0 || t === from) return all;
  const rest = all.filter((x) => x !== fid);
  const others = shown.filter((x) => x !== fid);
  if (t < others.length) rest.splice(rest.indexOf(others[t]), 0, fid);
  else rest.splice(rest.indexOf(others[others.length - 1]) + 1, 0, fid);
  return rest;
}

function popTitle(p: PopState, db: DbSnapshot): string {
  const f = "fid" in p && p.fid ? db.fields.find((x) => x.id === p.fid) : undefined;
  switch (p.kind) {
    case "cell":
    case "header":
      return f?.name ?? "";
    case "filter":
      return "Filter";
    case "fields":
      return "Fields";
    case "sort":
      return "Sort";
    case "fieldNew":
      return p.isNew ? "New field" : "Field";
    case "describe":
      return `${f?.name ?? "Field"}: description`;
    case "more":
      return db.name || "Database";
    case "settings":
      return "View settings";
    case "fieldType":
      return `${f?.name ?? "Field"}: type`;
    case "options":
      return `${f?.name ?? "Field"}: options`;
  }
}

interface Ctx {
  doc: Y.Doc;
  db: DbSnapshot;
  env: BlockEnv;
  edit: boolean;
  compact: boolean;
  people: People;
  rows: DbRow[];
  prefs: ViewPrefs;
  open: (p: PopState) => void;
  setPeek: (rid: string | null) => void;
  newRow: (values?: Record<string, CellValue>, openPeek?: boolean) => void;
  focusRow: string | null;
  setFocusRow: (rid: string | null) => void;
  /** Field whose column is briefly highlighted after it was added. */
  flash: string | null;
  addFieldAt: (type: FieldType, fallback: Anchor, at?: { fid: string; side: -1 | 1 }) => void;
  patchPrefs: (p: Partial<ViewPrefs>) => void;
  view: ViewKind;
  onImport?: () => void;
}

/* ============================================================ table */

/** Default row height (40 px cell + 1 px rule); measured from the DOM once rendered. */
const ROW_H = 41;
/** Tables longer than this render only the rows near the viewport. */
export const VIRTUAL_AT = 80;
const OVERSCAN = 16;
/** How long a new column stays highlighted. */
const FLASH_MS = 1200;
const MIN_W = 70, MAX_W = 900;
const TITLE_W_PHONE = 132;
const clampW = (w: number) => Math.round(Math.max(MIN_W, Math.min(MAX_W, w)));

/** What a memoised table row needs. Kept referentially stable between ordinary edits. */
interface RowCtx {
  doc: Y.Doc;
  dbId: string;
  edit: boolean;
  people: People;
  open: Ctx["open"];
  setPeek: Ctx["setPeek"];
  focusRow: string | null;
  setFocusRow: Ctx["setFocusRow"];
  q: string;
  /** Phone layout (prototype PhoneDb, MOB-04b): the title is a button that opens the row. */
  compact: boolean;
  /** Row drag handles are shown (editor, no sort active). */
  grip: boolean;
  act: React.RefObject<{ grip: (e: React.PointerEvent, rid: string) => void; gripKey: (e: React.KeyboardEvent, rid: string) => void }>;
}

const posOf = (td: Element): CellPos => ({ r: Number(td.getAttribute("data-r")), c: Number(td.getAttribute("data-c")) });
const isTextInput = (t: EventTarget | null): t is HTMLInputElement =>
  t instanceof HTMLInputElement && !t.readOnly && t.type !== "checkbox" && t.type !== "range" && t.type !== "date";

function TableView({ ctx, gwRef }: { ctx: Ctx; gwRef: React.RefObject<HTMLDivElement | null> }) {
  const { db, rows, edit, prefs, open, doc, people, env } = ctx;
  // The view's columns (its order, hidden fields left out). Stable between edits so rows stay memoised.
  const layoutKey = JSON.stringify([prefs.fields ?? null, prefs.hidden ?? null]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fields = useMemo(() => viewFields(db, prefs), [db.fields, layoutKey]);
  const sorts = sortsOf(db, prefs);
  const [range, setRange] = useState<CellRange | null>(null);
  const [live, setLive] = useState("");
  const [colW, setColW] = useState<{ fid: string; w: number } | null>(null);
  const [dropCol, setDropCol] = useState<number | null>(null);
  /** Column under the pointer in the header, and the one being dragged (for the column tint / edge). */
  const [hovCol, setHovCol] = useState<string | null>(null);
  const [dragFid, setDragFid] = useState<string | null>(null);
  /** Overlays drawn over whole columns: the new-field flash, the hover tint, the resize / drag edge. */
  const [marks, setMarks] = useState<{ k: "flash" | "hover" | "edge"; fid: string; left: number; width: number; height: number }[]>([]);
  useLayoutEffect(() => {
    const want: { k: "flash" | "hover" | "edge"; fid: string }[] = [];
    if (ctx.flash) want.push({ k: "flash", fid: ctx.flash });
    const active = colW?.fid ?? dragFid;
    if (active) want.push({ k: "edge", fid: active });
    else if (hovCol && hovCol !== ctx.flash) want.push({ k: "hover", fid: hovCol });
    const table = headRef.current?.closest("table");
    const next = want.flatMap((w) => {
      const th = headRef.current?.querySelector<HTMLElement>(`th[data-fid="${w.fid}"]`);
      return th && table ? [{ ...w, left: th.offsetLeft, width: th.offsetWidth, height: table.offsetHeight }] : [];
    });
    setMarks((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
  });
  const [dropRow, setDropRow] = useState<{ before: string | null; id: string } | null>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const headRef = useRef<HTMLTableRowElement>(null);
  const suppress = useRef(false);
  const rh = useRef(ROW_H);
  // Fresh values for document-level listeners.
  const R = useRef({ rows, fields, range, people, edit });
  R.current = { rows, fields, range, people, edit };
  const rangeSet = (g: CellRange | null) => {
    R.current.range = g;
    setRange(g);
  };

  const widthOf0 = (f: DbField) => (colW?.fid === f.id ? colW.w : clampW(prefs.widths?.[f.id] ?? W[f.type] ?? 160));
  // MOB-04b (prototype PhoneDb): on a phone the sticky title column is at most 132 px.
  const widthOf = (f: DbField) => (ctx.compact && f.type === "title" ? Math.min(TITLE_W_PHONE, widthOf0(f)) : widthOf0(f));
  const total = fields.reduce((t, f) => t + widthOf(f), 0) + (edit ? 44 : 0);

  /* ---- virtual window: only rows near the viewport are in the DOM ---- */
  const virtual = rows.length > VIRTUAL_AT;
  const [win, setWin] = useState<[number, number]>([0, 60]);
  useLayoutEffect(() => {
    if (!virtual) return;
    const calc = () => {
      const tb = tbodyRef.current;
      if (!tb) return;
      const first = tb.querySelector<HTMLElement>("tr[data-row]");
      if (first?.offsetHeight) rh.current = first.offsetHeight;
      const top = tb.getBoundingClientRect().top;
      const sp = scrollParent(tb);
      const own = sp && sp !== document.scrollingElement;
      const vTop = own ? Math.max(0, sp.getBoundingClientRect().top) : 0;
      const vBot = own ? Math.min(window.innerHeight, sp.getBoundingClientRect().bottom) : window.innerHeight;
      const s = Math.max(0, Math.floor((vTop - top) / rh.current) - OVERSCAN);
      const e = Math.max(s, Math.min(rows.length, Math.ceil((vBot - top) / rh.current) + OVERSCAN));
      setWin((w) => (w[0] === s && w[1] === e ? w : [s, e]));
    };
    calc();
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(calc);
    };
    window.addEventListener("scroll", on, true);
    window.addEventListener("resize", on);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", on, true);
      window.removeEventListener("resize", on);
    };
  }, [virtual, rows.length]);
  const s1 = virtual ? Math.min(win[1], rows.length) : rows.length;
  const s0 = virtual ? Math.min(win[0], s1) : 0;

  /* ---- focus ---- */
  const pendingFocus = useRef<CellPos | null>(null);
  /** Header to focus after a keyboard column move (the header element moves in the DOM). */
  const headFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const fid = headFocus.current;
    const el = fid ? headRef.current?.querySelector<HTMLElement>(`th[data-fid="${fid}"] .ocdb-hcell`) : null;
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
    if (el) headFocus.current = null;
  });
  const cellEl = (p: CellPos) => tbodyRef.current?.querySelector<HTMLElement>(`td[data-r="${p.r}"][data-c="${p.c}"]`) ?? null;
  const focusIn = (td: HTMLElement) => {
    const t = td.querySelector<HTMLElement>("input.ocdb-ce,button.ocdb-cin,button.ocdb-cbx") ?? td;
    t.focus({ preventScroll: true });
    t.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  const focusCell = (p: CellPos) => {
    const el = cellEl(p);
    if (el) return focusIn(el);
    // Not rendered (virtualised): scroll its row into view; focus it once it renders.
    pendingFocus.current = p;
    const tb = tbodyRef.current;
    if (!tb) return;
    const y = tb.getBoundingClientRect().top + p.r * rh.current;
    const sp = scrollParent(tb);
    if (!sp || sp === document.scrollingElement) window.scrollBy?.(0, y - window.innerHeight / 2);
    else sp.scrollTop += y - sp.getBoundingClientRect().top - sp.clientHeight / 2;
  };
  useLayoutEffect(() => {
    const p = pendingFocus.current;
    const el = p && cellEl(p);
    if (el) {
      pendingFocus.current = null;
      focusIn(el);
    }
  });

  /* ---- rows: keyboard + pointer reorder ---- */
  const placeBefore = (idx: number): string | null => {
    // Row id that should follow a row moved to visible index `idx` (end of the visible rows when idx === rows.length).
    if (idx < rows.length) return rows[idx].id;
    const last = rows[rows.length - 1];
    const at = db.rows.findIndex((r) => r.id === last?.id);
    return at >= 0 ? (db.rows[at + 1]?.id ?? null) : null;
  };
  const canReorder = () => {
    if (!edit) return false;
    if (sorts.length) {
      setLive("Rows are sorted. Clear the sort to reorder them by hand.");
      env.toast("Clear the sort to reorder rows by hand");
      return false;
    }
    return true;
  };
  const moveBy = (rid: string, d: -1 | 1, c: number) => {
    if (!canReorder()) return;
    const i = rows.findIndex((r) => r.id === rid);
    const j = i + d;
    if (i < 0 || j < 0 || j >= rows.length) return;
    moveRow(doc, db.id, rid, placeBefore(d < 0 ? j : j + 1));
    setLive(`Moved to row ${j + 1} of ${rows.length}`);
    rangeSet({ a: { r: j, c }, f: { r: j, c } });
    requestAnimationFrame(() => focusCell({ r: j, c }));
  };
  const act = useRef<RowCtx["act"]["current"]>({ grip: () => {}, gripKey: () => {} });
  act.current.gripKey = (e, rid) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    e.stopPropagation();
    if (!canReorder()) return;
    const i = rows.findIndex((r) => r.id === rid);
    const j = i + (e.key === "ArrowUp" ? -1 : 1);
    if (i < 0 || j < 0 || j >= rows.length) return;
    moveRow(doc, db.id, rid, placeBefore(e.key === "ArrowUp" ? j : j + 1));
    setLive(`Moved to row ${j + 1} of ${rows.length}`);
    requestAnimationFrame(() => tbodyRef.current?.querySelector<HTMLElement>(`tr[data-row="${rid}"] .ocdb-grip`)?.focus());
  };
  act.current.grip = (e, rid) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!canReorder()) return;
    e.preventDefault();
    const tb = tbodyRef.current;
    if (!tb) return;
    let before: string | null | undefined;
    const move = (ev: PointerEvent) => {
      let target: string | null = null;
      for (const tr of tb.querySelectorAll<HTMLElement>("tr[data-row]")) {
        const r = tr.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          target = tr.getAttribute("data-row");
          break;
        }
      }
      const idx = target ? rows.findIndex((r) => r.id === target) : rows.length;
      before = placeBefore(idx);
      setDropRow({ before: target, id: rid });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDropRow(null);
      if (ev.type === "pointerup" && before !== undefined && before !== rid) {
        moveRow(doc, db.id, rid, before);
        setLive("Row moved");
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  /* ---- keyboard: spreadsheet navigation ---- */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    const td = t.closest<HTMLElement>("td[data-r]");
    if (!td || t.closest(".ocdb-grip")) return;
    const p = posOf(td);
    const text = isTextInput(t);
    const mod = e.metaKey || e.ctrlKey;
    if (e.altKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      if (rows[p.r]) moveBy(rows[p.r].id, e.key === "ArrowUp" ? -1 : 1, p.c);
      return;
    }
    if (e.altKey) return;
    if (e.key === "Enter" && text && !e.shiftKey && !mod) {
      // The input committed and blurred itself; carry on down the column like a spreadsheet.
      if (p.r + 1 < rows.length) requestAnimationFrame(() => focusCell({ r: p.r + 1, c: p.c }));
      return;
    }
    if (e.key === "Escape") {
      if (isMulti(R.current.range)) {
        e.preventDefault();
        rangeSet({ a: p, f: p });
      }
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && edit && (!text || isMulti(R.current.range))) {
      e.preventDefault();
      const g = R.current.range && inRange(R.current.range, p.r, p.c) ? R.current.range : { a: p, f: p };
      const b = rangeBounds(g);
      clearCells(doc, db.id, rows.slice(b.r0, b.r1 + 1).map((r) => r.id), fields.slice(b.c0, b.c1 + 1).map((f) => f.id));
      const n = (b.r1 - b.r0 + 1) * (b.c1 - b.c0 + 1);
      setLive(`Cleared ${n} ${n === 1 ? "cell" : "cells"}`);
      return;
    }
    if (mod && e.key.toLowerCase() === "a" && !text) {
      e.preventDefault();
      rangeSet({ a: { r: 0, c: 0 }, f: { r: rows.length - 1, c: fields.length - 1 } });
      return;
    }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(e.key)) return;
    if (text) {
      const el = t as HTMLInputElement;
      if ((e.key === "Home" || e.key === "End") && !mod) {
        // Caret to the start / end on every platform (macOS would scroll the page instead).
        e.preventDefault();
        const at = e.key === "Home" ? 0 : el.value.length;
        if (e.shiftKey) el.setSelectionRange(Math.min(at, el.selectionStart ?? 0), Math.max(at, el.selectionEnd ?? 0), e.key === "Home" ? "backward" : "forward");
        else el.setSelectionRange(at, at);
        return;
      }
      const collapsed = el.selectionStart === el.selectionEnd;
      const horiz = e.key === "ArrowLeft" || e.key === "ArrowRight" || ((e.key === "Home" || e.key === "End") && !mod);
      if (horiz && e.shiftKey) return; // extending a text selection
      if (e.key === "ArrowLeft" && !(collapsed && el.selectionStart === 0)) return;
      if (e.key === "ArrowRight" && !(collapsed && el.selectionEnd === el.value.length)) return;
      if ((e.key === "Home" || e.key === "End") && !mod) return;
    }
    const cur = e.shiftKey && R.current.range ? R.current.range.f : p;
    const to = moveCell(cur, e.key, rows.length, fields.length, mod);
    if (!to) return;
    e.preventDefault();
    if (e.shiftKey) {
      const a = R.current.range?.a ?? p;
      rangeSet({ a, f: to });
      const b = rangeBounds({ a, f: to });
      setLive(`${b.r1 - b.r0 + 1} by ${b.c1 - b.c0 + 1} cells selected`);
    } else {
      rangeSet({ a: to, f: to });
      focusCell(to);
    }
  };

  const onFocus = (e: React.FocusEvent) => {
    const td = (e.target as HTMLElement).closest("td[data-r]");
    if (!td) return;
    const p = posOf(td);
    if (!R.current.range || !inRange(R.current.range, p.r, p.c)) rangeSet({ a: p, f: p });
  };

  /* ---- pointer: click-drag or Shift+click selects a range ---- */
  const onPointerDown = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement;
    const td = t.closest<HTMLElement>("td[data-r]");
    if (!td || e.button !== 0 || t.closest(".ocdb-grip,.ocdb-peekbtn")) return;
    const p = posOf(td);
    if (e.shiftKey) {
      e.preventDefault();
      rangeSet({ a: R.current.range?.a ?? p, f: p });
      suppress.current = true;
      return;
    }
    rangeSet({ a: p, f: p });
    if (t.closest("input") || e.pointerType !== "mouse") return;
    const tb = tbodyRef.current;
    const move = (ev: PointerEvent) => {
      const el = document.elementFromPoint?.(ev.clientX, ev.clientY)?.closest("td[data-r]");
      if (!el || !tb?.contains(el)) return;
      const q = posOf(el);
      const g = R.current.range;
      if (g && (g.f.r !== q.r || g.f.c !== q.c)) {
        rangeSet({ a: g.a, f: q });
        suppress.current = true;
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setTimeout(() => (suppress.current = false), 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /* ---- clipboard: copy / cut / paste ranges as TSV (Excel, Sheets) ---- */
  useEffect(() => {
    const active = () => {
      const a = document.activeElement as HTMLElement | null;
      return a && tbodyRef.current?.contains(a) ? a : null;
    };
    const onCopy = (e: ClipboardEvent) => {
      const a = active();
      const td = a?.closest("td[data-r]");
      if (!a || !td || !e.clipboardData) return;
      const { range: g, rows: rs, fields: fs, people: pp, edit: ed } = R.current;
      if (isTextInput(a) && !isMulti(g) && a.selectionStart !== a.selectionEnd) return; // copy the selected text
      const p = posOf(td);
      const rg = g && inRange(g, p.r, p.c) ? g : { a: p, f: p };
      e.preventDefault();
      e.clipboardData.setData("text/plain", rangeToTsv(rg, rs, fs, pp.pickable));
      e.clipboardData.setData("text/html", rangeToHtml(rg, rs, fs, pp.pickable));
      const b = rangeBounds(rg);
      const n = (b.r1 - b.r0 + 1) * (b.c1 - b.c0 + 1);
      if (e.type === "cut" && ed) {
        clearCells(doc, db.id, rs.slice(b.r0, b.r1 + 1).map((r) => r.id), fs.slice(b.c0, b.c1 + 1).map((f) => f.id));
        setLive(`Cut ${n} ${n === 1 ? "cell" : "cells"}`);
      } else setLive(`Copied ${n} ${n === 1 ? "cell" : "cells"}`);
    };
    const onPaste = (e: ClipboardEvent) => {
      const a = active();
      const td = a?.closest("td[data-r]");
      const { range: g, rows: rs, fields: fs, people: pp, edit: ed } = R.current;
      if (!a || !td || !ed || !e.clipboardData) return;
      const text = e.clipboardData.getData("text/plain");
      if (!text) return;
      const grid = isGridText(text);
      if (isTextInput(a) && !grid && !isMulti(g)) return; // ordinary paste into the input
      e.preventDefault();
      const p = posOf(td);
      const inside = g && inRange(g, p.r, p.c) ? rangeBounds(g) : null;
      const start: CellPos = inside ? { r: inside.r0, c: inside.c0 } : p;
      let block = parseTsv(text);
      if (!grid && inside) {
        // One value into a selected range fills the range.
        block = Array.from({ length: inside.r1 - inside.r0 + 1 }, () => Array.from({ length: inside.c1 - inside.c0 + 1 }, () => text.replace(/\r?\n$/, "")));
      }
      const width = Math.min(Math.max(...block.map((l) => l.length)), fs.length - start.c);
      const fids = fs.slice(start.c, start.c + width).map((f) => f.id);
      const rids = rs.slice(start.r, start.r + block.length).map((r) => r.id);
      if (isTextInput(a)) a.blur();
      const written = pasteCells(doc, db.id, rids, fids, block.map((l) => l.slice(0, width)), pp.pickable);
      const end = { r: start.r + written.length - 1, c: start.c + width - 1 };
      rangeSet({ a: start, f: end });
      const n = written.length * width;
      setLive(`Pasted ${n} ${n === 1 ? "cell" : "cells"}`);
      requestAnimationFrame(() => focusCell(start));
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, [doc, db.id]);

  /* ---- columns: resize (pointer + keyboard) and reorder (pointer + Alt+Shift+arrows) ---- */
  const setWidth = (f: DbField, w: number | null) => {
    const next = { ...(prefs.widths ?? {}) };
    if (w === null) delete next[f.id];
    else next[f.id] = clampW(w);
    ctx.patchPrefs({ widths: next });
  };
  const onResizeDown = (e: React.PointerEvent, f: DbField) => {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX, w0 = widthOf(f);
    let w = w0;
    const move = (ev: PointerEvent) => {
      w = clampW(w0 + ev.clientX - sx);
      setColW({ fid: f.id, w });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setColW(null);
      if (w !== w0) setWidth(f, w);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const onResizeKey = (e: React.KeyboardEvent, f: DbField) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      setWidth(f, widthOf(f) + (e.key === "ArrowLeft" ? -step : step));
    } else if (e.key === "Home" || e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      setWidth(f, null);
    }
  };
  const shiftField = (f: DbField, j: number, d: -1 | 1) => {
    const to = j + d;
    if (to < 0 || to >= fields.length) return;
    ctx.patchPrefs({ fields: moveInView(db, prefs, f.id, to) });
    setLive(`${f.name} moved to column ${to + 1} of ${fields.length}`);
    headFocus.current = f.id;
  };
  const onHeadDown = (e: React.PointerEvent, f: DbField, j: number) => {
    if (e.button !== 0 || e.pointerType !== "mouse") return;
    const sx = e.clientX;
    let started = false;
    let to = j;
    const move = (ev: PointerEvent) => {
      if (!started && Math.abs(ev.clientX - sx) < 6) return;
      if (!started) setDragFid(f.id);
      started = true;
      const ths = [...(headRef.current?.querySelectorAll<HTMLElement>("th[data-fid]") ?? [])];
      to = ths.findIndex((th) => {
        const r = th.getBoundingClientRect();
        return ev.clientX < r.left + r.width / 2;
      });
      if (to < 0) to = ths.length;
      setDropCol(to);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDropCol(null);
      setDragFid(null);
      if (!started) return;
      suppress.current = true;
      setTimeout(() => (suppress.current = false), 0);
      const final = to > j ? to - 1 : to;
      if (final !== j) {
        ctx.patchPrefs({ fields: moveInView(db, prefs, f.id, final) });
        setLive(`${f.name} moved to column ${final + 1}`);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const q = (prefs.q ?? "").trim();
  const grip = edit && !sorts.length && !ctx.compact;
  const rc = useMemo<RowCtx>(
    () => ({ doc, dbId: db.id, edit, people, open, setPeek: ctx.setPeek, focusRow: ctx.focusRow, setFocusRow: ctx.setFocusRow, q, compact: ctx.compact, grip, act }),
    [doc, db.id, edit, people, open, ctx.setPeek, ctx.focusRow, ctx.setFocusRow, q, ctx.compact, grip],
  );
  const multi = isMulti(range) ? rangeBounds(range!) : null;
  const sortOf = (fid: string) => sorts.find((s) => s.f === fid);

  if (!db.rows.length) {
    return (
      <div className="ocdb-empty">
        <span className="ocdb-empty-ic"><Ic i={Table} s={18} /></span>
        <b>No rows yet</b>
        <span>{edit ? "Add a row, or bring in rows from a CSV file." : "Rows will show up here when someone adds them."}</span>
        {edit ? (
          <span className="ocdb-empty-acts">
            <button className="ocdb-btn sm" onClick={() => ctx.newRow({}, false)}><Ic i={Plus} s={14} />New row</button>
            {ctx.onImport ? <button className="ocdb-btn ghost sm" onClick={ctx.onImport}><Ic i={Upload} s={14} />Import CSV</button> : null}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="ocdb-gw" ref={gwRef} onScroll={ctx.compact ? (e) => e.currentTarget.classList.toggle("scrolled", e.currentTarget.scrollLeft > 0) : undefined}>
      <table className="ocdb-grid" style={{ width: total }} aria-label={db.name || "Database"} aria-rowcount={rows.length + 1} aria-multiselectable={edit || undefined}>
        <colgroup>
          {fields.map((f) => <col key={f.id} style={{ width: widthOf(f) }} />)}
          {edit ? <col style={{ width: 44 }} /> : null}
        </colgroup>
        <thead>
          <tr ref={headRef} aria-rowindex={1}>
            {fields.map((f, j) => {
              const s = sortOf(f.id);
              return (
                <th
                  key={f.id}
                  data-fid={f.id}
                  aria-sort={s ? (s.dir > 0 ? "ascending" : "descending") : undefined}
                  className={(dropCol === j ? "drop-b" : "") + (dropCol === fields.length && j === fields.length - 1 ? " drop-a" : "") + (f.description ? " desc" : "")}
                  onPointerEnter={() => setHovCol(f.id)}
                  onPointerLeave={() => setHovCol((h) => (h === f.id ? null : h))}
                >
                  <button
                    className="ocdb-hcell"
                    aria-haspopup="dialog"
                    aria-describedby={f.description ? `${db.id}-tip-${f.id}` : undefined}
                    aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
                    onPointerDown={(e) => onHeadDown(e, f, j)}
                    onKeyDown={(e) => {
                      if (e.altKey && e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                        e.preventDefault();
                        shiftField(f, j, e.key === "ArrowLeft" ? -1 : 1);
                      }
                    }}
                    onClick={(e) => {
                      if (suppress.current) return;
                      open({ kind: "header", fid: f.id, anchor: e.currentTarget, key: "h" + f.id });
                    }}
                  >
                    <Ic i={TYPE_ICON[f.type] ?? TYPE_ICON.text} s={14} />
                    <span>{f.name}</span>
                    {s ? <span className="ocdb-sortic"><Ic i={s.dir > 0 ? ArrowUp : ArrowDown} s={12} />{sorts.length > 1 ? <small>{sorts.indexOf(s) + 1}</small> : null}</span> : null}
                  </button>
                  {f.description ? (
                    <span className="ocdb-hinfo-w">
                      <button
                        className="ocdb-hinfo"
                        aria-label={`About ${f.name}`}
                        aria-describedby={`${db.id}-tip-${f.id}`}
                        onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
                        onClick={(e) => e.currentTarget.focus()}
                      >
                        <Ic i={Info} s={13} />
                      </button>
                      <span className="ocdb-tip" role="tooltip" id={`${db.id}-tip-${f.id}`}>{f.description}</span>
                    </span>
                  ) : null}
                  <span
                    className={"ocdb-rsz" + (colW?.fid === f.id ? " on" : "")}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${f.name}`}
                    aria-valuenow={widthOf(f)}
                    aria-valuemin={MIN_W}
                    aria-valuemax={MAX_W}
                    tabIndex={0}
                    title="Drag or use the arrow keys to resize. Double-click to reset."
                    onPointerDown={(e) => onResizeDown(e, f)}
                    onKeyDown={(e) => onResizeKey(e, f)}
                    onDoubleClick={() => setWidth(f, null)}
                  />
                </th>
              );
            })}
            {edit ? (
              <th className="ocdb-addcol">
                <button title="Add a field" aria-label="Add a field" onClick={(e) => ctx.addFieldAt("text", e.currentTarget)}>
                  <Ic i={Plus} />
                </button>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody
          ref={tbodyRef}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onPointerDown={onPointerDown}
          onClickCapture={(e) => {
            if (suppress.current) {
              e.stopPropagation();
              e.preventDefault();
              suppress.current = false;
            }
          }}
        >
          {s0 > 0 ? <tr className="ocdb-spacer" aria-hidden="true" style={{ height: s0 * rh.current }}><td colSpan={fields.length + (edit ? 1 : 0)} /></tr> : null}
          {rows.slice(s0, s1).map((r, k) => {
            const i = s0 + k;
            return (
              <Row
                key={r.id}
                r={r}
                i={i}
                fields={fields}
                rc={rc}
                sel={multi && i >= multi.r0 && i <= multi.r1 ? `${multi.c0}-${multi.c1}` : null}
                drop={dropRow ? (dropRow.before === r.id ? "b" : dropRow.id === r.id ? "d" : !dropRow.before && i === rows.length - 1 ? "a" : null) : null}
              />
            );
          })}
          {s1 < rows.length ? <tr className="ocdb-spacer" aria-hidden="true" style={{ height: (rows.length - s1) * rh.current }}><td colSpan={fields.length + (edit ? 1 : 0)} /></tr> : null}
        </tbody>
        {rows.length ? (
          <tfoot>
            <tr>
              {fields.map((f, i) => <td key={f.id}>{footCell(f, i, rows)}</td>)}
              {edit ? <td /> : null}
            </tr>
          </tfoot>
        ) : null}
      </table>
      {marks.map((m) => (
        <div key={m.k + m.fid} className={`ocdb-colmark ${m.k}`} data-fid={m.fid} aria-hidden="true" style={{ left: m.left, width: m.width, height: m.height }} />
      ))}
      {edit ? (
        <button className="ocdb-newrow" onClick={() => ctx.newRow({}, false)}>
          <Ic i={Plus} />
          New row
        </button>
      ) : null}
      <div className="ocdb-sr" role="status" aria-live="polite">{live}</div>
    </div>
  );
}

function footCell(f: DbField, i: number, rows: DbRow[]): ReactNode {
  if (i === 0) return <div className="ocdb-cin">Count<b>{rows.length}</b></div>;
  if (f.type === "number") {
    const s = rows.reduce((t, r) => t + (Number(r.v[f.id]) || 0), 0);
    return <div className="ocdb-cin ocdb-num">Sum<b>{fmtNum(s)}</b></div>;
  }
  if (f.type === "checkbox") {
    const c = rows.filter((r) => r.v[f.id]).length;
    return <div className="ocdb-cin">Done<b>{c}/{rows.length}</b></div>;
  }
  if (f.type === "progress") {
    const avg = rows.length ? Math.round(rows.reduce((t, r) => t + (Number(r.v[f.id]) || 0), 0) / rows.length) : 0;
    return <div className="ocdb-cin">Average<b>{avg}%</b></div>;
  }
  return null;
}

const Row = memo(function Row({ r, i, fields, rc, sel, drop }: { r: DbRow; i: number; fields: DbField[]; rc: RowCtx; sel: string | null; drop: "a" | "b" | "d" | null }) {
  const [c0, c1] = sel ? sel.split("-").map(Number) : [-1, -2];
  return (
    <tr data-row={r.id} aria-rowindex={i + 2} className={drop === "b" ? "drop-b" : drop === "a" ? "drop-a" : drop === "d" ? "dragging" : undefined}>
      {fields.map((f, j) => <Cell key={f.id} rc={rc} f={f} r={r} ri={i} ci={j} inSel={j >= c0 && j <= c1} />)}
      {rc.edit ? <td /> : null}
    </tr>
  );
});

function Cell({ rc, f, r, ri, ci, inSel }: { rc: RowCtx; f: DbField; r: DbRow; ri: number; ci: number; inSel: boolean }) {
  const { doc, dbId, edit, people, open, setPeek, focusRow, setFocusRow, q } = rc;
  const v = r.v[f.id];
  const hit = !!q && (f.type === "title" || f.type === "text" || f.type === "number") && String(v ?? "").toLowerCase().includes(q.toLowerCase());
  const tdProps = { "data-r": ri, "data-c": ci, tabIndex: -1, className: (inSel ? "sel" : "") + (hit ? " hit" : "") || undefined };
  if (f.type === "title" && rc.compact) {
    const t = typeof v === "string" ? v : v == null ? "" : String(v);
    return (
      <td {...tdProps}>
        <button className={"ocdb-ttl" + (t ? "" : " empty")} onClick={() => setPeek(r.id)} aria-label={`Open ${t || "Untitled"}`} title={t || undefined}>
          {t || "Untitled"}
        </button>
      </td>
    );
  }
  if (f.type === "title") {
    return (
      <td {...tdProps}>
        <div className={"ocdb-ct" + (rc.grip ? " grip" : "")}>
          {rc.grip ? (
            <button
              className="ocdb-grip"
              aria-label={`Move row ${String(v ?? "") || "Untitled"}. Use the up and down arrow keys`}
              title="Drag to move. Arrow keys move it too."
              onPointerDown={(e) => rc.act.current.grip(e, r.id)}
              onKeyDown={(e) => rc.act.current.gripKey(e, r.id)}
            >
              <Ic i={GripVertical} s={14} />
            </button>
          ) : null}
          <CommitInput
            value={typeof v === "string" ? v : v == null ? "" : String(v)}
            readOnly={!edit}
            placeholder="Untitled"
            ariaLabel={f.name}
            autoFocus={focusRow === r.id}
            onCommit={(x) => setCell(doc, dbId, r.id, f.id, x)}
            onEnter={() => focusRow === r.id && setFocusRow(null)}
          />
          <button className="ocdb-peekbtn" onClick={() => setPeek(r.id)} aria-label={`Open ${String(v ?? "") || "Untitled"}`}>
            <Ic i={PanelRightOpen} s={13} />
            Open
          </button>
        </div>
      </td>
    );
  }
  if (f.type === "text" || f.type === "number") {
    const num = f.type === "number";
    return (
      <td {...tdProps}>
        <div className={"ocdb-cin" + (num ? " ocdb-num" : "")}>
          {edit ? (
            <CommitInput
              value={v == null ? "" : String(v)}
              inputMode={num ? "decimal" : "text"}
              ariaLabel={f.name}
              onCommit={(x) => setCell(doc, dbId, r.id, f.id, num ? parseNum(x) : x.trim() ? x : null)}
            />
          ) : (
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              <Hl text={num ? (v == null || v === "" ? "" : fmtNum(Number(v))) : String(v ?? "")} q={q} />
            </span>
          )}
        </div>
      </td>
    );
  }
  if (f.type === "checkbox") {
    return (
      <td {...tdProps}>
        <div className="ocdb-cin">
          <button
            className={"ocdb-cbx" + (v ? " on" : "")}
            role="checkbox"
            aria-checked={!!v}
            aria-label={f.name}
            disabled={!edit}
            onClick={() => setCell(doc, dbId, r.id, f.id, !v)}
          >
            <Check size={12} strokeWidth={3} />
          </button>
        </div>
      </td>
    );
  }
  return (
    <td {...tdProps}>
      <button
        className="ocdb-cin"
        disabled={!edit && f.type !== "url"}
        aria-haspopup={edit ? "dialog" : undefined}
        aria-label={`${f.name}: ${isEmpty(v) ? "empty" : Array.isArray(v) ? v.join(", ") : String(f.type === "person" ? (people.resolve(v)?.name ?? v) : v)}`}
        onClick={(e) => {
          if (!edit) return;
          open({ kind: "cell", rowId: r.id, fid: f.id, anchor: e.currentTarget, key: `c${r.id}${f.id}` });
        }}
        onKeyDown={(e) => {
          // Typing on a closed option / person / date cell opens its editor (like a spreadsheet).
          if (!edit || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1 || e.key === " ") return;
          e.preventDefault();
          open({ kind: "cell", rowId: r.id, fid: f.id, anchor: e.currentTarget, key: `c${r.id}${f.id}` });
        }}
      >
        <Value f={f} v={v} people={people} q={q} />
      </button>
    </td>
  );
}

function parseNum(x: string): number | null {
  const t = x.trim().replace(/[,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/* ========================================================== kanban */

function cardMeta(ctx: Ctx, r: DbRow, skip?: string): ReactNode[] {
  const { db, people } = ctx;
  return viewFields(db, ctx.prefs)
    .filter((f) => f.type !== "title" && f.id !== skip && !isEmpty(r.v[f.id]) && ["person", "date", "tags", "select", "status", "number"].includes(f.type))
    .slice(0, 3)
    .map((f) => {
      const v = r.v[f.id];
      if (f.type === "person") {
        const u = people.resolve(v);
        return u ? <span key={f.id} className={"ocdb-person" + (u.deactivated ? " former" : "")} data-person-id={u.id}><Avatar u={u} size="xs" /><span>{firstName(u)}</span></span> : null;
      }
      if (f.type === "date") return <span key={f.id}><Ic i={Calendar} s={12} />{fmtDate(v)}</span>;
      if (f.type === "number") return <span key={f.id}>{f.name.replace(/ \(.*\)/, "")} {fmtNum(Number(v))}</span>;
      return <span key={f.id}><Value f={f} v={v} people={people} /></span>;
    });
}

/** Long-press delay before a touch drag picks a card up. */
export const LONG_PRESS_MS = 250;

interface KDrag {
  id: string;
  /** pointer position (client px) */
  x: number;
  y: number;
  /** grab offset inside the card, and its size */
  ox: number;
  oy: number;
  w: number;
  /** drop target: group value + card to insert before (null = end of column) */
  to: string;
  before: string | null;
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

function KanbanView({ ctx }: { ctx: Ctx }) {
  const { db, rows, edit, doc, newRow, setPeek } = ctx;
  const g = groupField(db, ctx.prefs);
  const [drag, setDragState] = useState<KDrag | null>(null);
  const dragRef = useRef<KDrag | null>(null);
  const setDrag = (d: KDrag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  /** Keyboard pick-up: the card being moved and where it came from (for Escape). */
  const [kb, setKb] = useState<{ id: string; v: CellValue; next: string | null } | null>(null);
  const [live, setLive] = useState("");
  const kanRef = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const gesture = useRef<(() => void) | null>(null);
  useEffect(() => () => gesture.current?.(), []);

  // Keep focus on a keyboard-moved card (it remounts when it changes column).
  useLayoutEffect(() => {
    if (!kb) return;
    const el = kanRef.current?.querySelector<HTMLElement>(`[data-kcard="${kb.id}"]`);
    if (el && document.activeElement !== el) el.focus({ preventScroll: false });
  });

  if (!g) return <NeedField ctx={ctx} type="status" text="The board view groups rows by a Status or Select field." />;
  const tf = titleField(db);
  const known = new Set((g.options ?? []).map((o) => o.v));
  const groupOf = (r: DbRow) => {
    const v = r.v[g.id];
    return v && known.has(String(v)) ? String(v) : "";
  };
  const cols = [...(g.options ?? []).map((o) => o.v), ""]
    .map((gv) => ({ gv, items: rows.filter((r) => groupOf(r) === gv) }))
    .filter((c) => c.gv !== "" || c.items.length || drag?.to === "");
  const titleOf = (rid: string) => String(db.rows.find((r) => r.id === rid)?.v[tf.id] ?? "") || "Untitled";
  const colName = (gv: string) => gv || `No ${g.name.toLowerCase()}`;

  /** Put `rid` into column `gv`, before `before` (null = after the column's last card). */
  const place = (rid: string, gv: string, before: string | null) => {
    const col = cols.find((c) => c.gv === gv);
    const others = (col?.items ?? []).filter((r) => r.id !== rid);
    let target: string | null | undefined;
    if (before && before !== rid) target = before;
    else if (others.length) {
      const idx = db.rows.findIndex((r) => r.id === others[others.length - 1].id);
      target = db.rows.slice(idx + 1).find((r) => r.id !== rid)?.id ?? null;
    }
    const row = db.rows.find((r) => r.id === rid);
    doc.transact(() => {
      if (target !== undefined) moveRow(doc, db.id, rid, target);
      if (row && groupOf(row) !== gv) setCell(doc, db.id, rid, g.id, gv || null);
    }, DB_ORIGIN);
  };

  /* ---- pointer drag (mouse: move 4px; touch/pen: long-press) ---- */
  const hitTest = (x: number, y: number, d: KDrag): Pick<KDrag, "to" | "before"> => {
    const hit = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
    const colEl = hit?.closest<HTMLElement>("[data-kcol]");
    if (!colEl || !kanRef.current?.contains(colEl)) return { to: d.to, before: d.before };
    const to = colEl.getAttribute("data-kcol") ?? "";
    let before: string | null = null;
    for (const c of colEl.querySelectorAll<HTMLElement>("[data-kcard]")) {
      const id = c.getAttribute("data-kcard")!;
      if (id === d.id) continue;
      const r = c.getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        before = id;
        break;
      }
    }
    return { to, before };
  };

  const onCardPointerDown = (e: React.PointerEvent<HTMLButtonElement>, r: DbRow) => {
    if (!edit || kb || (e.pointerType === "mouse" && e.button !== 0)) return;
    gesture.current?.();
    const card = e.currentTarget;
    const rect = card.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const touch = e.pointerType !== "mouse";
    let started = false;
    let px = sx, py = sy;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const begin = () => {
      started = true;
      try { navigator.vibrate?.(8); } catch { /* not allowed */ }
      const d: KDrag = { id: r.id, x: px, y: py, ox: sx - rect.left, oy: sy - rect.top, w: rect.width, to: groupOf(r), before: null };
      Object.assign(d, hitTest(px, py, d));
      setDrag(d);
      raf = requestAnimationFrame(autoScroll);
    };
    const autoScroll = () => {
      const d = dragRef.current;
      const kan = kanRef.current;
      if (!d || !kan) return;
      const k = kan.getBoundingClientRect();
      const edge = 48, speed = (dist: number) => Math.ceil(((edge - dist) / edge) * 14);
      let moved = false;
      if (px < k.left + edge && kan.scrollLeft > 0) (kan.scrollLeft -= speed(px - k.left)), (moved = true);
      else if (px > k.right - edge && kan.scrollLeft < kan.scrollWidth - kan.clientWidth) (kan.scrollLeft += speed(k.right - px)), (moved = true);
      const sp = scrollParent(kan);
      if (sp) {
        const top = sp === document.scrollingElement ? 0 : sp.getBoundingClientRect().top;
        const bottom = sp === document.scrollingElement ? window.innerHeight : sp.getBoundingClientRect().bottom;
        if (py < top + edge) (sp.scrollTop -= speed(py - top)), (moved = true);
        else if (py > bottom - edge) (sp.scrollTop += speed(bottom - py)), (moved = true);
      }
      if (moved) {
        const next = { ...d, ...hitTest(px, py, d) };
        if (next.to !== d.to || next.before !== d.before) setDrag(next);
      }
      raf = requestAnimationFrame(autoScroll);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      px = ev.clientX;
      py = ev.clientY;
      if (!started) {
        const dist = Math.hypot(px - sx, py - sy);
        if (touch) {
          if (dist > 8) end(); // it's a scroll, not a long-press
        } else if (dist > 4) begin();
        return;
      }
      const d = dragRef.current!;
      setDrag({ ...d, x: px, y: py, ...hitTest(px, py, d) });
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const d = dragRef.current;
      if (started && d && ev.type === "pointerup") {
        place(d.id, d.to, d.before);
        setLive(`Moved ${titleOf(d.id)} to ${colName(d.to)}`);
      }
      if (started) {
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
      }
      end();
    };
    // While dragging by touch, stop the page from scrolling under the finger.
    const touchMove = (ev: TouchEvent) => {
      if (started) ev.preventDefault();
    };
    const noMenu = (ev: Event) => {
      if (started || touch) ev.preventDefault();
    };
    const end = () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.removeEventListener("touchmove", touchMove);
      card.removeEventListener("contextmenu", noMenu);
      gesture.current = null;
      if (started) setDrag(null);
    };
    gesture.current = end;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    document.addEventListener("touchmove", touchMove, { passive: false });
    card.addEventListener("contextmenu", noMenu);
    if (touch) timer = setTimeout(begin, LONG_PRESS_MS);
  };

  /* ---- keyboard: Space picks up, arrows move, Space/Enter drops, Escape cancels ---- */
  const onCardKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, r: DbRow) => {
    if (!edit) return;
    const picked = kb?.id === r.id;
    if (!picked) {
      if (e.key === " ") {
        e.preventDefault();
        suppressClick.current = true;
        const idx = db.rows.findIndex((x) => x.id === r.id);
        setKb({ id: r.id, v: r.v[g.id] ?? null, next: db.rows[idx + 1]?.id ?? null });
        setLive(`Picked up ${titleOf(r.id)}. Use the arrow keys to move it, Space to drop, Escape to cancel.`);
      }
      return;
    }
    const ci = cols.findIndex((c) => c.gv === groupOf(r));
    const items = cols[ci]?.items ?? [];
    const i = items.findIndex((x) => x.id === r.id);
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      suppressClick.current = true;
      setKb(null);
      setLive(`Dropped ${titleOf(r.id)} in ${colName(groupOf(r))}, position ${i + 1} of ${items.length}`);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      doc.transact(() => {
        moveRow(doc, db.id, r.id, kb!.next);
        setCell(doc, db.id, r.id, g.id, kb!.v);
      }, DB_ORIGIN);
      setKb(null);
      setLive(`Cancelled. ${titleOf(r.id)} is back where it was.`);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      if (e.key === "ArrowUp" && i > 0) place(r.id, groupOf(r), items[i - 1].id);
      else if (e.key === "ArrowDown" && i < items.length - 1) place(r.id, groupOf(r), items[i + 2]?.id ?? null);
      else return;
      setLive(`${titleOf(r.id)}: position ${e.key === "ArrowUp" ? i : i + 2} of ${items.length} in ${colName(groupOf(r))}`);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const to = cols[ci + (e.key === "ArrowLeft" ? -1 : 1)];
      if (!to) return;
      const others = to.items;
      place(r.id, to.gv, others[Math.min(i, others.length)]?.id ?? null);
      setLive(`${titleOf(r.id)} moved to ${colName(to.gv)}`);
    }
  };

  const dragRow = drag ? db.rows.find((r) => r.id === drag.id) : undefined;
  const marker = <div className="ocdb-kdrop" key="__drop" aria-hidden="true" />;

  return (
    <div className={"ocdb-kan" + (drag ? " dragging" : "")} ref={kanRef}>
      {cols.map(({ gv, items }) => {
        const o = optOf(g, gv);
        const target = drag && drag.to === gv;
        const cards: ReactNode[] = [];
        for (const r of items) {
          if (target && drag.before === r.id) cards.push(marker);
          const title = String(r.v[tf.id] ?? "");
          const picked = kb?.id === r.id;
          cards.push(
            <button
              key={r.id}
              data-kcard={r.id}
              className={"ocdb-kcard" + (drag?.id === r.id ? " dragging" : "") + (picked ? " picked" : "") + (edit ? " movable" : "")}
              aria-roledescription={edit ? "Movable card" : undefined}
              aria-pressed={edit ? picked : undefined}
              aria-keyshortcuts={edit ? "Space" : undefined}
              onPointerDown={(e) => onCardPointerDown(e, r)}
              onKeyDown={(e) => onCardKeyDown(e, r)}
              onBlur={() => {
                if (!picked) return;
                setTimeout(() => {
                  if ((document.activeElement as HTMLElement | null)?.getAttribute?.("data-kcard") !== r.id) setKb((k) => (k?.id === r.id ? null : k));
                }, 0);
              }}
              onClick={() => {
                if (suppressClick.current || picked) {
                  suppressClick.current = false;
                  return;
                }
                setPeek(r.id);
              }}
            >
              <span className={"ocdb-kt" + (title ? "" : " untitled")}>{title || "Untitled"}</span>
              <span className="ocdb-km">{cardMeta(ctx, r, g.id)}</span>
            </button>,
          );
        }
        if (target && drag.before === null) cards.push(marker);
        return (
          <div key={gv || "__none"} data-kcol={gv} className={"ocdb-kcol" + (target ? " over" : "")}>
            <div className="ocdb-khead">
              {o ? <Pill label={o.v} c={o.c} st /> : <Pill label={`No ${g.name.toLowerCase()}`} />}
              <span className="kc">{items.length}</span>
              {edit ? (
                <button className="ocdb-ib" aria-label={`Add card to ${gv || "no " + g.name.toLowerCase()}`} onClick={() => newRow({ [g.id]: gv || null }, true)}>
                  <Ic i={Plus} s={14} />
                </button>
              ) : null}
            </div>
            {cards}
            {edit ? (
              <button className="ocdb-kadd" onClick={() => newRow({ [g.id]: gv || null }, true)}>
                <Ic i={Plus} s={14} />
                New
              </button>
            ) : null}
          </div>
        );
      })}
      <div className="ocdb-sr" aria-live="assertive" role="status">{live}</div>
      {drag && dragRow && typeof document !== "undefined"
        ? createPortal(
            <div className="ocdb-kghost" style={{ left: drag.x - drag.ox, top: drag.y - drag.oy, width: drag.w }} aria-hidden="true">
              <span className={"ocdb-kt" + (dragRow.v[tf.id] ? "" : " untitled")}>{String(dragRow.v[tf.id] ?? "") || "Untitled"}</span>
              <span className="ocdb-km">{cardMeta(ctx, dragRow, g.id)}</span>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/* ======================================================== calendar */

interface CDrag {
  id: string;
  x: number;
  y: number;
  ox: number;
  oy: number;
  w: number;
  /** Day under the pointer (`YYYY-MM-DD`), "" over the unscheduled tray, null elsewhere. */
  to: string | null;
}

const shiftIso = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return isoDate(new Date(y, m - 1, d + n));
};

/**
 * Month grid (agenda list when compact). Items move by drag (mouse; long-press on touch), by
 * Alt+arrows while focused (a day; up / down a week), or from the row's peek. Rows without a date
 * sit in a tray beside the grid: drag them onto a day, or focus one and press Alt+an arrow to
 * put it on today (or the month's first day). Double-click a day to add an item on it.
 */
function CalendarView({ ctx }: { ctx: Ctx }) {
  const { db, rows, compact, setPeek, edit, newRow, people, doc } = ctx;
  const df = dateField(db, ctx.prefs);
  // The shown month lives in the view prefs (`views.calendar.cal`) so collaborators see the same month.
  const month = ctx.prefs.cal && /^\d{4}-\d{2}$/.test(ctx.prefs.cal) ? ctx.prefs.cal : defaultMonth(db, undefined, ctx.prefs);
  const setMonth = (m: string) => m !== month && ctx.patchPrefs({ cal: m });
  const [drag, setDragState] = useState<CDrag | null>(null);
  const dragRef = useRef<CDrag | null>(null);
  const setDrag = (d: CDrag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const [live, setLive] = useState("");
  const [trayOpen, setTrayOpen] = useState(true);
  const calRef = useRef<HTMLDivElement>(null);
  const focusItem = useRef<string | null>(null);
  const suppressClick = useRef(false);
  const gesture = useRef<(() => void) | null>(null);
  useEffect(() => () => gesture.current?.(), []);
  // Keep focus on an item moved from the keyboard: it remounts in its new day.
  useLayoutEffect(() => {
    const id = focusItem.current;
    if (!id) return;
    const el = calRef.current?.querySelector<HTMLElement>(`[data-cev="${id}"]`);
    if (el) {
      focusItem.current = null;
      if (document.activeElement !== el) el.focus({ preventScroll: false });
    }
  });

  if (!df) return <NeedField ctx={ctx} type="date" text="The calendar places rows on a Date field." />;
  const tf = titleField(db);
  const g = groupField(db, db.views.board);
  const pf = db.fields.find((f) => f.type === "person");
  const tone = (r: DbRow) => optOf(g, g ? r.v[g.id] : undefined)?.c ?? "gray";
  const [y, m] = month.split("-").map(Number);
  const today = isoDate(new Date());
  const title = (r: DbRow) => String(r.v[tf.id] ?? "") || "Untitled";
  const dated = (r: DbRow) => typeof r.v[df.id] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.v[df.id] as string);
  const undated = rows.filter((r) => !dated(r));
  const titleOf = (rid: string) => title(db.rows.find((r) => r.id === rid) ?? { id: rid, v: {} });

  /** Put a row on `day` (null unschedules it), following it to its month. */
  const schedule = (rid: string, day: string | null, keepFocus: boolean) => {
    setCell(doc, db.id, rid, df.id, day);
    if (day && !day.startsWith(month)) setMonth(day.slice(0, 7));
    if (keepFocus) focusItem.current = rid;
    setLive(day ? `${titleOf(rid)} moved to ${new Date(day + "T12:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}` : `${titleOf(rid)} has no date now`);
  };

  /* ---- keyboard: Alt+arrows move a focused item; Alt+Backspace unschedules ---- */
  const onItemKey = (e: React.KeyboardEvent, r: DbRow) => {
    if (!edit || !e.altKey || e.metaKey || e.ctrlKey) return;
    const cur = dated(r) ? (r.v[df.id] as string) : null;
    if (e.key === "Backspace" || e.key === "Delete") {
      if (!cur) return;
      e.preventDefault();
      schedule(r.id, null, false);
      return;
    }
    const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -7 : e.key === "ArrowDown" ? 7 : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    schedule(r.id, cur ? shiftIso(cur, step) : today.startsWith(month) ? today : month + "-01", true);
  };

  /* ---- pointer: drag to a day or the tray (mouse: move 4 px; touch / pen: long-press) ---- */
  const hitTest = (x: number, y: number): string | null => {
    const hit = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
    const el = hit?.closest<HTMLElement>("[data-day],.ocdb-tray");
    if (!el || !calRef.current?.contains(el)) return null;
    return el.hasAttribute("data-day") ? el.getAttribute("data-day") : "";
  };
  const onItemPointerDown = (e: React.PointerEvent<HTMLButtonElement>, r: DbRow) => {
    if (!edit || (e.pointerType === "mouse" && e.button !== 0)) return;
    gesture.current?.();
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const touch = e.pointerType !== "mouse";
    let started = false;
    let px = sx, py = sy;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const begin = () => {
      started = true;
      try { navigator.vibrate?.(8); } catch { /* not allowed */ }
      setDrag({ id: r.id, x: px, y: py, ox: sx - rect.left, oy: sy - rect.top, w: Math.max(120, rect.width), to: hitTest(px, py) });
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      px = ev.clientX;
      py = ev.clientY;
      if (!started) {
        const dist = Math.hypot(px - sx, py - sy);
        if (touch) {
          if (dist > 8) end(); // a scroll, not a long-press
        } else if (dist > 4) begin();
        return;
      }
      setDrag({ ...dragRef.current!, x: px, y: py, to: hitTest(px, py) });
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const d = dragRef.current;
      if (started && d && ev.type === "pointerup" && d.to !== null) {
        const was = dated(r) ? (r.v[df.id] as string) : null;
        const to = d.to || null;
        if (to !== was) schedule(r.id, to, false);
      }
      if (started) {
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
      }
      end();
    };
    const touchMove = (ev: TouchEvent) => {
      if (started) ev.preventDefault();
    };
    const noMenu = (ev: Event) => {
      if (started || touch) ev.preventDefault();
    };
    const end = () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.removeEventListener("touchmove", touchMove);
      el.removeEventListener("contextmenu", noMenu);
      gesture.current = null;
      if (started) setDrag(null);
    };
    gesture.current = end;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    document.addEventListener("touchmove", touchMove, { passive: false });
    el.addEventListener("contextmenu", noMenu);
    if (touch) timer = setTimeout(begin, LONG_PRESS_MS);
  };

  const itemProps = (r: DbRow, day: string | null) => ({
    "data-cev": r.id,
    title: title(r),
    "aria-label": `${title(r)}${day ? `, ${fmtDate(day)}` : ", no date"}. Open`,
    "aria-roledescription": edit ? "Movable item" : undefined,
    "aria-keyshortcuts": edit ? "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown" : undefined,
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => onItemPointerDown(e, r),
    onKeyDown: (e: React.KeyboardEvent) => onItemKey(e, r),
    onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
    onClick: () => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      setPeek(r.id);
    },
  });

  const head = (
    <div className="ocdb-calh">
      <b>{MONTHS[m - 1]} {y}</b>
      <button className="ocdb-btn ghost sm" onClick={() => setMonth(isoMonth(new Date()))}>Today</button>
      <button className="ocdb-ib" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}><Ic i={ChevronLeft} /></button>
      <button className="ocdb-ib" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}><Ic i={ChevronRight} /></button>
      {!compact && undated.length ? (
        <button className={"ocdb-btn ghost sm" + (trayOpen ? " on" : "")} aria-expanded={trayOpen} aria-controls={`${db.id}-tray`} onClick={() => setTrayOpen((o) => !o)}>
          <Ic i={Inbox} s={14} />No date<span className="ocdb-badge">{undated.length}</span>
        </button>
      ) : null}
    </div>
  );
  const help = edit ? <span className="ocdb-sr" id={`${db.id}-calhelp`}>Drag items to another day, or focus one and press Alt with the arrow keys: left and right move a day, up and down a week.</span> : null;
  const liveEl = <div className="ocdb-sr" role="status" aria-live="polite">{live}</div>;

  const tray = (
    <aside
      id={`${db.id}-tray`}
      className={"ocdb-tray" + (drag && drag.to === "" ? " over" : "")}
      aria-label={`No date, ${undated.length} ${undated.length === 1 ? "item" : "items"}`}
    >
      <div className="ocdb-trayh"><Ic i={Inbox} s={14} />No date<span className="ocdb-badge">{undated.length}</span></div>
      {undated.length ? (
        undated.map((r) => (
          <button key={r.id} className={`ocdb-cev ocdb-pill ocdb-c-${tone(r)}` + (drag?.id === r.id ? " dragging" : "")} aria-describedby={edit ? `${db.id}-calhelp` : undefined} {...itemProps(r, null)}>
            {title(r)}
          </button>
        ))
      ) : (
        <p className="ocdb-hint">{edit ? "Drop an item here to clear its date." : "Every row has a date."}</p>
      )}
    </aside>
  );

  const dragRow = drag ? db.rows.find((r) => r.id === drag.id) : undefined;
  const ghost =
    drag && dragRow && typeof document !== "undefined"
      ? createPortal(
          <div className={`ocdb-cghost ocdb-pill ocdb-c-${tone(dragRow)}`} style={{ left: drag.x - drag.ox, top: drag.y - drag.oy, width: drag.w }} aria-hidden="true">
            {title(dragRow)}
          </div>,
          document.body,
        )
      : null;

  if (compact) {
    const items = rows.filter((r) => dated(r) && (r.v[df.id] as string).startsWith(month)).sort((a, c) => String(a.v[df.id]).localeCompare(String(c.v[df.id])));
    const byDay = new Map<string, DbRow[]>();
    for (const r of items) {
      const k = String(r.v[df.id]);
      byDay.set(k, [...(byDay.get(k) ?? []), r]);
    }
    return (
      <div className="ocdb-cal" ref={calRef}>
        {head}
        {help}
        <div className="ocdb-agenda">
          {byDay.size ? (
            [...byDay.entries()].map(([d, list]) => (
              <div key={d}>
                <div className="ocdb-ad">{new Date(d + "T12:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</div>
                {list.map((r) => {
                  const u = pf ? people.resolve(r.v[pf.id]) : null;
                  return (
                    <button key={r.id} className="ocdb-ai" data-cev={r.id} aria-describedby={edit ? `${db.id}-calhelp` : undefined} onKeyDown={(e) => onItemKey(e, r)} onClick={() => setPeek(r.id)}>
                      <span className={`ocdb-pill ocdb-c-${tone(r)}`} style={{ padding: 0, width: 8, height: 8, borderRadius: 4 }} />
                      <span className="t">{title(r)}</span>
                      {u ? <Avatar u={u} /> : null}
                    </button>
                  );
                })}
              </div>
            ))
          ) : (
            <p className="ocdb-hint">Nothing scheduled this month.</p>
          )}
          {undated.length ? (
            <div>
              <div className="ocdb-ad">No date</div>
              {undated.map((r) => (
                <button key={r.id} className="ocdb-ai" data-cev={r.id} aria-describedby={edit ? `${db.id}-calhelp` : undefined} onKeyDown={(e) => onItemKey(e, r)} onClick={() => setPeek(r.id)}>
                  <span className={`ocdb-pill ocdb-c-${tone(r)}`} style={{ padding: 0, width: 8, height: 8, borderRadius: 4 }} />
                  <span className="t">{title(r)}</span>
                </button>
              ))}
            </div>
          ) : null}
          {edit ? (
            <button className="ocdb-kadd" onClick={() => newRow({ [df.id]: month === isoMonth(new Date()) ? today : month + "-01" }, true)}>
              <Ic i={Plus} s={14} />
              New
            </button>
          ) : null}
        </div>
        {liveEl}
      </div>
    );
  }

  const first = new Date(y, m - 1, 1);
  const startDow = (first.getDay() + 6) % 7;
  const days = new Date(y, m, 0).getDate();
  const total = Math.ceil((startDow + days) / 7) * 7;
  const byDate = new Map<string, DbRow[]>();
  for (const r of rows) {
    const k = r.v[df.id];
    if (typeof k === "string") byDate.set(k, [...(byDate.get(k) ?? []), r]);
  }
  const cells: ReactNode[] = [];
  for (let i = 0; i < total; i++) {
    const date = new Date(y, m - 1, i - startDow + 1);
    const inM = date.getMonth() === m - 1;
    const key = isoDate(date);
    cells.push(
      <div
        key={key}
        data-day={key}
        className={"ocdb-day" + (inM ? "" : " out") + (key === today ? " today" : "") + (drag && drag.to === key ? " over" : "")}
        onDoubleClick={edit ? (e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          newRow({ [df.id]: key }, true);
        } : undefined}
      >
        <span className="ocdb-dn">{date.getDate()}</span>
        {edit ? (
          <button className="ocdb-dadd" aria-label={`Add on ${fmtDate(key)}`} title="Add an item (or double-click the day)" onClick={() => newRow({ [df.id]: key }, true)}>
            <Ic i={Plus} s={14} />
          </button>
        ) : null}
        {(byDate.get(key) ?? []).map((r) => (
          <button key={r.id} className={`ocdb-cev ocdb-pill ocdb-c-${tone(r)}` + (drag?.id === r.id ? " dragging" : "")} aria-describedby={edit ? `${db.id}-calhelp` : undefined} {...itemProps(r, key)}>
            {title(r)}
          </button>
        ))}
      </div>,
    );
  }
  const showTray = trayOpen && (undated.length > 0 || !!drag);
  return (
    <div className={"ocdb-cal" + (drag ? " dragging" : "")} ref={calRef}>
      {head}
      {help}
      <div className={"ocdb-calwrap" + (showTray ? " tray" : "")}>
        <div className="ocdb-calg">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="ocdb-dow">{d}</div>)}
          {cells}
        </div>
        {showTray ? tray : null}
      </div>
      {liveEl}
      {ghost}
    </div>
  );
}

/* ========================================================= gallery */

const IMG_URL = /^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif|svg)(\?\S*)?$/i;

function GalleryView({ ctx }: { ctx: Ctx }) {
  const { db, rows, edit, setPeek, newRow, prefs } = ctx;
  const g = groupField(db, db.views.board);
  const tf = titleField(db);
  const Icon = dbIcon(db.icon);
  const cover = prefs.cover ?? "color";
  const urlField = db.fields.find((f) => f.id === cover && f.type === "url");
  return (
    <div className={"ocdb-gal" + (cover === "none" ? " nocover" : "")}>
      {rows.map((r) => {
        const o = g ? optOf(g, r.v[g.id]) : undefined;
        const title = String(r.v[tf.id] ?? "");
        const src = urlField && typeof r.v[urlField.id] === "string" && IMG_URL.test(String(r.v[urlField.id])) ? String(r.v[urlField.id]) : null;
        return (
          <button key={r.id} className="ocdb-gcard" onClick={() => setPeek(r.id)} aria-label={`${title || "Untitled"}. Open`}>
            {cover === "none" ? null : src ? (
              <div className="ocdb-gcov img"><img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" /></div>
            ) : (
              <div className={`ocdb-gcov ocdb-c-${o?.c ?? "gray"}`}><Icon size={26} strokeWidth={1.4} aria-hidden="true" /></div>
            )}
            <div className="ocdb-gb">
              <span className={"ocdb-gt" + (title ? "" : " untitled")}><Hl text={title || "Untitled"} q={prefs.q} /></span>
              <span className="ocdb-km">{cardMeta(ctx, r)}</span>
            </div>
          </button>
        );
      })}
      {edit ? (
        <button className="ocdb-gcard ocdb-gnew" onClick={() => newRow({}, true)}>
          <span><Ic i={Plus} />New</span>
        </button>
      ) : null}
    </div>
  );
}

/** Empty state for a view that needs a field the database doesn't have, with a one-click fix. */
function NeedField({ ctx, type, text }: { ctx: Ctx; type: FieldType; text: string }) {
  const { doc, db, edit, env } = ctx;
  return (
    <div className="ocdb-empty">
      <span className="ocdb-empty-ic"><Ic i={TYPE_ICON[type]} s={18} /></span>
      <b>{type === "date" ? "No date field yet" : "Nothing to group by yet"}</b>
      <span>{text}</span>
      {edit ? (
        <span className="ocdb-empty-acts">
          <button
            className="ocdb-btn sm"
            onClick={() => {
              addField(doc, db.id, type);
              env.toast(`Added a ${FIELD_LABEL[type]} field`);
            }}
          >
            <Ic i={Plus} s={14} />Add a {FIELD_LABEL[type]} field
          </button>
        </span>
      ) : null}
    </div>
  );
}

/* ====================================================== popover bodies */

interface PopBodyProps {
  pop: PopState;
  ctx: Ctx;
  close: () => void;
  setPop: (p: PopState | null) => void;
  onImport: () => void;
  onExport: () => void;
  onCopyMd: () => void;
  gwRef: React.RefObject<HTMLDivElement | null>;
}

function PopBody({ pop, ctx, close, setPop, onImport, onExport, onCopyMd, gwRef }: PopBodyProps) {
  const { db, doc, edit, prefs, patchPrefs, env } = ctx;
  switch (pop.kind) {
    case "cell": {
      const f = db.fields.find((x) => x.id === pop.fid);
      const r = db.rows.find((x) => x.id === pop.rowId);
      if (!f || !r) return null;
      return <CellEditor ctx={ctx} f={f} r={r} close={close} />;
    }
    case "header": {
      const f = db.fields.find((x) => x.id === pop.fid);
      if (!f) return null;
      const shown = viewFields(db, prefs);
      const j = shown.indexOf(f);
      const sortBy = (dir: 1 | -1) => {
        // Like a spreadsheet header: this column becomes the sort. More keys live in the Sort menu.
        patchPrefs(sortPatch([{ f: f.id, dir }]));
        close();
      };
      const move = (d: -1 | 1) => {
        patchPrefs({ fields: moveInView(db, prefs, f.id, j + d) });
        close();
      };
      const hide = () => {
        patchPrefs({ hidden: [...(prefs.hidden ?? []).filter((x) => x !== f.id), f.id] });
        close();
        env.toast(`“${f.name}” hidden in this view`, { label: "Show", run: () => patchPrefs({ hidden: (prefs.hidden ?? []).filter((x) => x !== f.id) }) });
      };
      return (
        <>
          <div className="ocdb-pad">
            <CommitInput
              className="ocdb-pin"
              value={f.name}
              readOnly={!edit}
              ariaLabel="Field name"
              onCommit={(v) => v.trim() && renameField(doc, db.id, f.id, v.trim())}
              onEnter={close}
            />
          </div>
          {edit && f.type !== "title" ? (
            <button className="ocdb-mi" aria-haspopup="dialog" onClick={() => setPop({ kind: "fieldType", fid: f.id, anchor: pop.anchor, key: "ft" + f.id })}>
              <Ic i={TYPE_ICON[f.type]} />
              <span className="lbl">Type</span>
              <span className="mk">{FIELD_LABEL[f.type]}</span>
              <Ic i={ChevronRight} s={14} />
            </button>
          ) : (
            <div className="ocdb-mh"><Ic i={TYPE_ICON[f.type]} s={12} />{FIELD_LABEL[f.type]}</div>
          )}
          {edit && OPTION_TYPES.includes(f.type) ? (
            <button className="ocdb-mi" aria-haspopup="dialog" onClick={() => setPop({ kind: "options", fid: f.id, anchor: pop.anchor, key: "op" + f.id })}>
              <Ic i={ListChecks} />
              <span className="lbl">Edit options</span>
              <span className="mk">{f.options?.length ?? 0}</span>
              <Ic i={ChevronRight} s={14} />
            </button>
          ) : null}
          <div className="ocdb-msep" />
          <button className="ocdb-mi" onClick={() => sortBy(1)}><Ic i={ArrowUp} />Sort ascending</button>
          <button className="ocdb-mi" onClick={() => sortBy(-1)}><Ic i={ArrowDown} />Sort descending</button>
          <button className="ocdb-mi" onClick={() => setPop({ kind: "filter", fid: f.id, anchor: pop.anchor, key: "filter" })}>
            <Ic i={ListFilter} />Filter by {f.name.toLowerCase()}
          </button>
          <div className="ocdb-msep" />
          <button className="ocdb-mi" disabled={j <= 0} onClick={() => move(-1)}><Ic i={ArrowLeft} /><span className="lbl">Move left</span><span className="mk">Alt Shift ←</span></button>
          <button className="ocdb-mi" disabled={j < 0 || j === shown.length - 1} onClick={() => move(1)}><Ic i={ArrowRight} /><span className="lbl">Move right</span><span className="mk">Alt Shift →</span></button>
          {f.type !== "title" ? <button className="ocdb-mi" onClick={hide}><Ic i={EyeOff} /><span className="lbl">Hide in this view</span></button> : null}
          {edit ? (
            <>
              <div className="ocdb-msep" />
              <button className="ocdb-mi" onClick={() => ctx.addFieldAt("text", pop.anchor, { fid: f.id, side: -1 })}><Ic i={ArrowLeftToLine} /><span className="lbl">Insert left</span></button>
              <button className="ocdb-mi" onClick={() => ctx.addFieldAt("text", pop.anchor, { fid: f.id, side: 1 })}><Ic i={ArrowRightToLine} /><span className="lbl">Insert right</span></button>
              <button className="ocdb-mi" aria-haspopup="dialog" onClick={() => setPop({ kind: "describe", fid: f.id, anchor: pop.anchor, key: "ds" + f.id })}>
                <Ic i={Info} /><span className="lbl">{f.description ? "Edit description" : "Add a description"}</span>
              </button>
            </>
          ) : null}
          {edit && f.type !== "title" ? (
            <>
              <div className="ocdb-msep" />
              <button
                className="ocdb-mi danger"
                onClick={() => {
                  close();
                  const b = deleteField(doc, db.id, f.id);
                  const p: Partial<ViewPrefs> = {};
                  const s = sortsOf(db, prefs), fl = rulesOf(db, prefs);
                  if (s.some((x) => x.f === f.id)) Object.assign(p, sortPatch(s.filter((x) => x.f !== f.id)));
                  if (fl.some((x) => x.f === f.id)) Object.assign(p, filterPatch(fl.filter((x) => x.f !== f.id)));
                  if (Object.keys(p).length) patchPrefs(p);
                  if (b) env.toast(`Field “${f.name}” deleted`, { label: "Undo", run: () => restoreField(doc, db.id, b) });
                }}
              >
                <Ic i={Trash2} />Delete field
              </button>
            </>
          ) : null}
        </>
      );
    }
    case "fieldType": {
      const f = db.fields.find((x) => x.id === pop.fid);
      if (!f) return null;
      return (
        <>
          <button className="ocdb-mi" onClick={() => setPop({ kind: "header", fid: f.id, anchor: pop.anchor, key: "h" + f.id })}>
            <Ic i={ChevronLeft} />
            <span className="lbl">{f.name}</span>
          </button>
          <div className="ocdb-mh">Change type</div>
          {FIELD_TYPES.filter((t) => t !== "title").map((t) => (
            <button
              key={t}
              className="ocdb-mi"
              role="menuitemradio"
              aria-checked={f.type === t}
              onClick={() => {
                if (t !== f.type) {
                  setFieldType(doc, db.id, f.id, t, ctx.people.pickable);
                  env.toast(`“${f.name}” is now a ${FIELD_LABEL[t]} field. Undo with Ctrl+Z`);
                }
                close();
              }}
            >
              <Ic i={TYPE_ICON[t]} />
              <span className="lbl">{FIELD_LABEL[t]}</span>
              {f.type === t ? <span className="chk"><Ic i={Check} s={14} /></span> : null}
            </button>
          ))}
        </>
      );
    }
    case "options": {
      const f = db.fields.find((x) => x.id === pop.fid);
      if (!f) return null;
      return <OptionsEditor ctx={ctx} f={f} />;
    }
    case "filter":
      return <FilterBody ctx={ctx} fid={pop.fid} at={pop.at} close={close} />;
    case "fields":
      return <FieldsBody ctx={ctx} />;
    case "sort":
      return <SortBody ctx={ctx} close={close} />;
    case "settings":
      return <SettingsBody ctx={ctx} />;
    case "fieldNew":
      return <NewFieldBody key={pop.fid} ctx={ctx} fid={pop.fid} isNew={pop.isNew} done={close} />;
    case "describe":
      return <DescribeBody key={pop.fid} ctx={ctx} fid={pop.fid} done={close} />;
    case "more":
      return (
        <>
          {edit ? <button className="ocdb-mi" onClick={() => { close(); onImport(); }}><Ic i={Upload} />Import CSV</button> : null}
          <button className="ocdb-mi" onClick={() => { close(); onExport(); }}><Ic i={Download} />Export CSV<span className="mk">.csv</span></button>
          <button className="ocdb-mi" onClick={() => { close(); onCopyMd(); }}><Ic i={Copy} />Copy as Markdown table</button>
          {edit ? (
            <>
              <div className="ocdb-msep" />
              <button className="ocdb-mi" onClick={() => ctx.addFieldAt("text", pop.anchor)}><Ic i={Plus} />Add a field</button>
            </>
          ) : null}
        </>
      );
  }
}

const TONES: Tone[] = ["gray", "blue", "green", "amber", "red", "purple", "pink"];
const TONE_NAME: Record<Tone, string> = { gray: "Gray", blue: "Blue", green: "Green", amber: "Amber", red: "Red", purple: "Purple", pink: "Pink" };

/** Several sort keys: change direction, reorder (buttons, no drag needed), remove, add. */
function SortBody({ ctx, close }: { ctx: Ctx; close: () => void }) {
  const { db, prefs, patchPrefs } = ctx;
  const sorts = sortsOf(db, prefs);
  const set = (next: typeof sorts) => patchPrefs(sortPatch(next));
  const unused = db.fields.filter((f) => !sorts.some((s) => s.f === f.id));
  return (
    <>
      {sorts.length ? <div className="ocdb-mh">Sorted by</div> : null}
      {sorts.map((s, i) => {
        const f = db.fields.find((x) => x.id === s.f)!;
        return (
          <div className="ocdb-rule" key={s.f}>
            <span className="n">{i + 1}</span>
            <Ic i={TYPE_ICON[f.type]} s={14} />
            <span className="lbl">{f.name}</span>
            <button
              className="ocdb-btn ghost sm"
              aria-label={`${f.name}: ${s.dir > 0 ? "ascending" : "descending"}. Switch direction`}
              onClick={() => set(sorts.map((x, j) => (j === i ? { f: x.f, dir: x.dir > 0 ? -1 : 1 } : x)))}
            >
              <Ic i={s.dir > 0 ? ArrowUp : ArrowDown} s={14} />
              {s.dir > 0 ? "Ascending" : "Descending"}
            </button>
            <button className="ocdb-ib" aria-label={`Move ${f.name} up`} disabled={i === 0} onClick={() => set(swap(sorts, i, i - 1))}><Ic i={ChevronUp} s={14} /></button>
            <button className="ocdb-ib" aria-label={`Move ${f.name} down`} disabled={i === sorts.length - 1} onClick={() => set(swap(sorts, i, i + 1))}><Ic i={ChevronDown} s={14} /></button>
            <button className="ocdb-ib" aria-label={`Remove sort by ${f.name}`} onClick={() => set(sorts.filter((_, j) => j !== i))}><Ic i={X} s={14} /></button>
          </div>
        );
      })}
      {unused.length ? <div className="ocdb-mh">{sorts.length ? "Then by" : "Sort by"}</div> : null}
      {unused.map((f) => (
        <button key={f.id} className="ocdb-mi" onClick={() => set([...sorts, { f: f.id, dir: 1 }])}>
          <Ic i={TYPE_ICON[f.type]} />
          <span className="lbl">{f.name}</span>
          <Ic i={Plus} s={14} />
        </button>
      ))}
      {sorts.length ? (
        <>
          <div className="ocdb-msep" />
          <button className="ocdb-mi" onClick={() => { set([]); close(); }}><Ic i={X} />Clear sorts</button>
        </>
      ) : null}
    </>
  );
}

function swap<T>(a: T[], i: number, j: number): T[] {
  const n = a.slice();
  [n[i], n[j]] = [n[j], n[i]];
  return n;
}

/**
 * Text input that shows its own draft while focused and reports every change, so a value that
 * is stored converted (numbers) doesn't fight the typing ("4." stays "4." until blur).
 */
function LiveInput({ value, onValue, ...rest }: { value: string; onValue: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...rest}
      value={draft ?? value}
      onFocus={(e) => {
        setDraft(value);
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        setDraft(null);
        rest.onBlur?.(e);
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        onValue(e.target.value);
      }}
    />
  );
}

const numIn = (s: string): number | null => {
  const t = s.trim().replace(/[,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * Filter editor: one row per rule (field, condition, value), all of which must match. Text,
 * number and date fields take a typed condition; option-like fields and checkboxes pick values.
 * Rules are stored in the view settings (shared), unfinished ones included, and show as chips.
 */
function FilterBody({ ctx, fid, at, close }: { ctx: Ctx; fid?: string; at?: number; close: () => void }) {
  const { db, prefs, patchPrefs, people, env } = ctx;
  const rules = rulesOf(db, prefs);
  const set = (next: FilterRule[]) => patchPrefs(filterPatch(next));
  const [focusAt, setFocusAt] = useState<number | null>(at ?? null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const added = useRef(false);
  const newRule = (f: DbField): FilterRule => {
    const ops = filterOps(f.type);
    return ops ? { f: f.id, op: ops[0] } : { f: f.id, vals: [] };
  };
  const add = (f: DbField) => {
    set([...rules, newRule(f)]);
    setFocusAt(rules.length);
  };
  // "Filter by <field>" from a column menu: edit that field's rule, adding one when it has none.
  useEffect(() => {
    if (!fid || at !== undefined || added.current) return;
    added.current = true;
    const i = rules.findIndex((r) => r.f === fid);
    const f = db.fields.find((x) => x.id === fid);
    if (i >= 0) setFocusAt(i);
    else if (f) add(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (focusAt === null) return;
    const row = bodyRef.current?.querySelectorAll<HTMLElement>(".ocdb-frule")[focusAt];
    const el = row?.querySelector<HTMLElement>("input,select:not([data-op]),.ocdb-fval button") ?? row?.querySelector<HTMLElement>("select");
    if (el) {
      el.focus({ preventScroll: true });
      row?.scrollIntoView?.({ block: "nearest" });
      setFocusAt(null);
    }
  });
  const patch = (i: number, p: Partial<FilterRule>) => {
    set(rules.map((r, j) => {
      if (j !== i) return r;
      const n: FilterRule = { ...r, ...p };
      for (const k of Object.keys(n) as (keyof FilterRule)[]) if (n[k] === undefined) delete n[k];
      return n;
    }));
  };
  const remove = (i: number) => {
    set(rules.filter((_, j) => j !== i));
    requestAnimationFrame(() => bodyRef.current?.querySelector<HTMLElement>(".ocdb-frule .ocdb-ib, .ocdb-fadd button")?.focus());
  };

  const valueEditor = (f: DbField, r: FilterRule, i: number): ReactNode => {
    const label = `${f.name} value`;
    if (!r.op) {
      if (f.type === "checkbox") return null;
      const vals: { v: string; node: ReactNode; text: string }[] =
        f.type === "person"
          ? [...people.pickable.map((u) => ({ v: u.id, text: u.name, node: <span className="ocdb-person"><Avatar u={u} size="xs" /><span>{firstName(u)}{u.id === env.me.id ? " (you)" : ""}</span></span> })), { v: "", text: "No one", node: <span className="ocdb-emptyc">No one</span> }]
          : [...(f.options ?? []).map((o) => ({ v: o.v, text: o.v, node: <Pill label={o.v} c={o.c} st={f.type === "status"} /> })), { v: "", text: "Empty", node: <span className="ocdb-emptyc">Empty</span> }];
      const sel = r.vals ?? [];
      return (
        <div className="ocdb-fval" role="group" aria-label={`${f.name}: show rows with any of`}>
          {vals.map(({ v, node, text }) => (
            <button
              key={v || "__empty"}
              className={"ocdb-fopt" + (sel.includes(v) ? " on" : "")}
              aria-pressed={sel.includes(v)}
              aria-label={text}
              onClick={() => patch(i, { vals: sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v] })}
            >
              {node}
              {sel.includes(v) ? <Ic i={Check} s={12} /> : null}
            </button>
          ))}
        </div>
      );
    }
    if (r.op === "empty") return null;
    if (f.type === "date") {
      if (r.op === "next" || r.op === "past") {
        return (
          <span className="ocdb-fin days">
            <LiveInput className="ocdb-pin" inputMode="numeric" aria-label={`${f.name}: number of days`} value={r.v == null ? "" : String(r.v)} onValue={(s) => patch(i, { v: numIn(s) ?? undefined })} />
            <span>days</span>
          </span>
        );
      }
      return <input type="date" className="ocdb-pin" aria-label={label} value={typeof r.v === "string" ? r.v : ""} onChange={(e) => patch(i, { v: e.target.value || undefined })} />;
    }
    if (f.type === "number" || f.type === "progress") {
      const num = (k: "v" | "v2", aria: string) => (
        <LiveInput className="ocdb-pin" inputMode="decimal" aria-label={aria} placeholder={k === "v" ? "Value" : "and"} value={r[k] == null ? "" : String(r[k])} onValue={(s) => patch(i, { [k]: numIn(s) ?? undefined })} />
      );
      return r.op === "between" ? (
        <span className="ocdb-fin two">
          {num("v", `${f.name} from`)}
          <span>and</span>
          {num("v2", `${f.name} to`)}
        </span>
      ) : (
        num("v", label)
      );
    }
    return <LiveInput className="ocdb-pin" aria-label={label} placeholder="Type a value" value={typeof r.v === "string" ? r.v : ""} onValue={(s) => patch(i, { v: s })} />;
  };

  return (
    <div className="ocdb-filters" ref={bodyRef}>
      {rules.length ? <div className="ocdb-mh">{rules.length > 1 ? "Rows that match all of these" : "Rows where"}</div> : null}
      {rules.map((r, i) => {
        const f = db.fields.find((x) => x.id === r.f)!;
        const ops = filterOps(f.type);
        const ready = ruleReady(f, r);
        const opValue = f.type === "checkbox" ? ((r.vals ?? [])[0] === "false" ? "unchecked" : "checked") : (r.op ?? "");
        return (
          <div className={"ocdb-frule" + (ready ? "" : " draft")} key={i}>
            <div className="ocdb-frow">
              <span className="ocdb-ffield"><Ic i={TYPE_ICON[f.type]} s={14} /><span>{f.name}</span></span>
              {ops ? (
                <select
                  className="ocdb-fop"
                  data-op=""
                  aria-label={`${f.name} condition`}
                  value={opValue}
                  onChange={(e) => {
                    const op = e.target.value as FilterOp;
                    // Keep a value that still makes sense for the new condition; dates and day counts don't mix.
                    const keepV = f.type !== "date" || (op === "next" || op === "past") === (r.op === "next" || r.op === "past");
                    patch(i, { op, v: keepV ? r.v : undefined, v2: op === "between" ? r.v2 : undefined });
                  }}
                >
                  {ops.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
                </select>
              ) : f.type === "checkbox" ? (
                <select className="ocdb-fop" data-op="" aria-label={`${f.name} condition`} value={opValue} onChange={(e) => patch(i, { vals: [e.target.value === "unchecked" ? "false" : "true"] })}>
                  <option value="checked">is checked</option>
                  <option value="unchecked">is not checked</option>
                </select>
              ) : (
                <span className="ocdb-fop static">is any of</span>
              )}
              {ops && r.op !== "empty" && !(r.op === "between") ? <span className="ocdb-fval1">{valueEditor(f, r, i)}</span> : null}
              <button className="ocdb-ib" aria-label={`Remove filter ${filterLabel(f, r)}`} onClick={() => remove(i)}><Ic i={X} s={14} /></button>
            </div>
            {!ops || r.op === "between" ? valueEditor(f, r, i) : null}
          </div>
        );
      })}
      <div className="ocdb-mh">{rules.length ? "Add another filter" : "Filter by"}</div>
      <div className="ocdb-fadd">
        {db.fields.map((f) => (
          <button key={f.id} className="ocdb-btn ghost sm" onClick={() => add(f)} aria-label={`${f.name}: add a filter`}>
            <Ic i={TYPE_ICON[f.type]} s={14} />
            {f.name}
          </button>
        ))}
      </div>
      {rules.length ? (
        <>
          <div className="ocdb-msep" />
          <button className="ocdb-mi" onClick={() => { set([]); close(); }}><Ic i={X} />Clear all filters</button>
        </>
      ) : null}
    </div>
  );
}

/**
 * Naming a field that was just added: the name is selected, the type picker sits under it.
 * Enter (or Done, or a click outside) keeps it; Escape removes the new field again (DbView).
 */
function NewFieldBody({ ctx, fid, isNew, done }: { ctx: Ctx; fid: string; isNew: boolean; done: () => void }) {
  const { doc, db, people } = ctx;
  const f = db.fields.find((x) => x.id === fid);
  const [name, setName] = useState(f?.name ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const live = useRef({ name, doc, dbId: db.id, fid });
  live.current = { name, doc, dbId: db.id, fid };
  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, []);
  // However the popover closes, the name is kept (renaming a removed field does nothing).
  useEffect(
    () => () => {
      const { name: n, doc: d, dbId, fid: id } = live.current;
      const m = getDbMap(d, dbId);
      const cur = m ? readDb(dbId, m).fields.find((x) => x.id === id) : undefined;
      if (cur && n.trim() && n.trim() !== cur.name) renameField(d, dbId, id, n.trim());
    },
    [],
  );
  if (!f) return null;
  const types = FIELD_TYPES.filter((t) => t !== "title");
  const pick = (t: FieldType) => {
    if (t !== f.type) {
      setFieldType(doc, db.id, fid, t, people.pickable);
      // A name nobody typed follows the type ("Text" becomes "Date").
      if (!name.trim() || name.trim() === FIELD_LABEL[f.type]) setName(FIELD_LABEL[t]);
    }
  };
  const onRadioKey = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const t = types[(i + d + types.length) % types.length];
    pick(t);
    (e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-t="${t}"]`))?.focus();
  };
  return (
    <div className="ocdb-newf">
      <div className="ocdb-pad">
        <input
          ref={inputRef}
          className="ocdb-pin ocdb-newf-name"
          aria-label="Field name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              done();
            }
          }}
        />
      </div>
      <div className="ocdb-mh">Type</div>
      <div className="ocdb-types" role="radiogroup" aria-label="Field type">
        {types.map((t, i) => (
          <button
            key={t}
            data-t={t}
            role="radio"
            aria-checked={f.type === t}
            tabIndex={f.type === t ? 0 : -1}
            className={"ocdb-type" + (f.type === t ? " on" : "")}
            onClick={() => pick(t)}
            onKeyDown={(e) => onRadioKey(e, i)}
          >
            <Ic i={TYPE_ICON[t]} s={14} />
            <span>{FIELD_LABEL[t]}</span>
          </button>
        ))}
      </div>
      <div className="ocdb-newf-ft">
        <span className="ocdb-hintk"><kbd>Enter</kbd> save{isNew ? <> · <kbd>Esc</kbd> discard</> : null}</span>
        <button className="ocdb-btn sm primary" onClick={done}>Done</button>
      </div>
    </div>
  );
}

/** A field's description: a short multi-line note shown in its header tooltip and the row peek. */
function DescribeBody({ ctx, fid, done }: { ctx: Ctx; fid: string; done: () => void }) {
  const { doc, db } = ctx;
  const f = db.fields.find((x) => x.id === fid);
  const [text, setText] = useState(f?.description ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const live = useRef({ text, cancelled: false });
  live.current.text = text;
  useLayoutEffect(() => {
    const el = ref.current;
    el?.focus({ preventScroll: true });
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  // Saved when the popover closes (Save, Ctrl+Enter, a click outside); Escape cancels.
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") live.current.cancelled = true;
    };
    document.addEventListener("keydown", onEsc, true);
    return () => {
      document.removeEventListener("keydown", onEsc, true);
      if (!live.current.cancelled) setFieldDescription(doc, db.id, fid, live.current.text);
    };
  }, [doc, db.id, fid]);
  if (!f) return null;
  return (
    <div className="ocdb-descb">
      <div className="ocdb-pad">
        <textarea
          ref={ref}
          className="ocdb-pin ocdb-desc"
          aria-label={`Description of ${f.name}`}
          placeholder="What goes in this field, and how to fill it"
          rows={3}
          maxLength={1000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              done();
            }
          }}
        />
      </div>
      <div className="ocdb-newf-ft">
        <span className="ocdb-hintk"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel</span>
        {f.description ? <button className="ocdb-btn sm ghost" onClick={() => { setText(""); live.current.text = ""; done(); }}>Remove</button> : null}
        <button className="ocdb-btn sm primary" onClick={done}>Save</button>
      </div>
    </div>
  );
}

/**
 * Fields shown in this view and their order: a switch per field (the title can't be hidden),
 * drag the grip or use its arrow keys, or the up / down buttons (single-pointer alternative).
 */
function FieldsBody({ ctx }: { ctx: Ctx }) {
  const { db, prefs, patchPrefs } = ctx;
  const all = orderedFields(db, prefs);
  const hidden = new Set(prefs.hidden ?? []);
  const [msg, setMsg] = useState("");
  const [drop, setDrop] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const isShown = (f: DbField) => f.type === "title" || !hidden.has(f.id);
  const toggle = (f: DbField) => {
    if (f.type === "title") return;
    const next = isShown(f) ? [...hidden, f.id] : [...hidden].filter((x) => x !== f.id);
    patchPrefs({ hidden: next });
    setMsg(`${f.name} ${isShown(f) ? "hidden" : "shown"}`);
  };
  const moveTo = (from: number, to: number, focusGrip = false) => {
    if (to < 0 || to >= all.length || to === from) return;
    const ids = all.map((f) => f.id);
    const [x] = ids.splice(from, 1);
    ids.splice(to, 0, x);
    patchPrefs({ fields: ids });
    setMsg(`${all[from].name} moved to position ${to + 1} of ${all.length}`);
    if (focusGrip) requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`li[data-fid="${x}"] .ocdb-fgrip`)?.focus());
  };
  const onGripDown = (e: React.PointerEvent, from: number) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    let to = from;
    const move = (ev: PointerEvent) => {
      const lis = [...(listRef.current?.querySelectorAll<HTMLElement>("li[data-fid]") ?? [])];
      const i = lis.findIndex((li) => {
        const r = li.getBoundingClientRect();
        return ev.clientY < r.top + r.height / 2;
      });
      to = i < 0 ? lis.length : i;
      setDrop(to);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDrop(null);
      if (ev.type === "pointerup") moveTo(from, to > from ? to - 1 : to);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const hideable = all.filter((f) => f.type !== "title");
  const shownCount = all.filter(isShown).length;
  return (
    <div className="ocdb-fields">
      <div className="ocdb-mh">
        <span>{shownCount} of {all.length} shown</span>
        <span className="grow" />
        {hidden.size && hideable.some((f) => hidden.has(f.id)) ? (
          <button className="ocdb-link" onClick={() => { patchPrefs({ hidden: [] }); setMsg("All fields shown"); }}>Show all</button>
        ) : (
          <button className="ocdb-link" onClick={() => { patchPrefs({ hidden: hideable.map((f) => f.id) }); setMsg("Fields hidden, except the title"); }}>Hide all</button>
        )}
      </div>
      <ul ref={listRef} aria-label="Fields in this view">
        {all.map((f, i) => {
          const on = isShown(f);
          return (
            <li key={f.id} data-fid={f.id} className={(on ? "" : "off") + (drop === i ? " drop-b" : "") + (drop === all.length && i === all.length - 1 ? " drop-a" : "")}>
              <button
                className="ocdb-fgrip"
                aria-label={`Reorder ${f.name}. Use the up and down arrow keys`}
                title="Drag to reorder. Arrow keys move it too."
                onPointerDown={(e) => onGripDown(e, i)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                  e.preventDefault();
                  moveTo(i, i + (e.key === "ArrowUp" ? -1 : 1), true);
                }}
              >
                <Ic i={GripVertical} s={14} />
              </button>
              <Ic i={TYPE_ICON[f.type]} s={14} />
              <span className="lbl">{f.name}</span>
              <button className="ocdb-ib" aria-label={`Move ${f.name} up`} disabled={i === 0} onClick={() => moveTo(i, i - 1)}><Ic i={ChevronUp} s={14} /></button>
              <button className="ocdb-ib" aria-label={`Move ${f.name} down`} disabled={i === all.length - 1} onClick={() => moveTo(i, i + 1)}><Ic i={ChevronDown} s={14} /></button>
              <button
                className="ocdb-switch"
                role="switch"
                aria-checked={on}
                aria-label={`Show ${f.name}`}
                title={f.type === "title" ? "The title is always shown" : undefined}
                disabled={f.type === "title"}
                onClick={() => toggle(f)}
              >
                <i />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="ocdb-sr" role="status" aria-live="polite">{msg}</div>
    </div>
  );
}

/** Per-view settings: board group-by, calendar date field, gallery cover. */
function SettingsBody({ ctx }: { ctx: Ctx }) {
  const { db, prefs, patchPrefs, view, edit, doc, env } = ctx;
  const radio = (on: boolean, label: ReactNode, icon: LucideIcon, pick: () => void, key: string) => (
    <button key={key} className="ocdb-mi" role="menuitemradio" aria-checked={on} onClick={pick}>
      <Ic i={icon} />
      <span className="lbl">{label}</span>
      {on ? <span className="chk"><Ic i={Check} s={14} /></span> : null}
    </button>
  );
  const add = (t: FieldType, k: "group" | "date") => {
    const fid = addField(doc, db.id, t);
    patchPrefs({ [k]: fid });
    env.toast(`Added a ${FIELD_LABEL[t]} field`);
  };
  if (view === "board") {
    const g = groupField(db, prefs);
    const opts = db.fields.filter((f) => f.type === "status" || f.type === "select");
    return (
      <>
        <div className="ocdb-mh">Group cards by</div>
        {opts.map((f) => radio(g?.id === f.id, f.name, TYPE_ICON[f.type], () => patchPrefs({ group: f.id }), f.id))}
        {!opts.length ? <p className="ocdb-hint" style={{ padding: "4px 10px" }}>No Status or Select field yet.</p> : null}
        {edit ? <button className="ocdb-mi" onClick={() => add("status", "group")}><Ic i={Plus} />New Status field</button> : null}
      </>
    );
  }
  if (view === "calendar") {
    const d = dateField(db, prefs);
    const opts = db.fields.filter((f) => f.type === "date");
    return (
      <>
        <div className="ocdb-mh">Show rows by</div>
        {opts.map((f) => radio(d?.id === f.id, f.name, TYPE_ICON.date, () => patchPrefs({ date: f.id }), f.id))}
        {!opts.length ? <p className="ocdb-hint" style={{ padding: "4px 10px" }}>No Date field yet.</p> : null}
        {edit ? <button className="ocdb-mi" onClick={() => add("date", "date")}><Ic i={Plus} />New Date field</button> : null}
      </>
    );
  }
  const cover = prefs.cover ?? "color";
  return (
    <>
      <div className="ocdb-mh">Card cover</div>
      {radio(cover === "color", "Group colour", LayoutGrid, () => patchPrefs({ cover: "color" }), "color")}
      {radio(cover === "none", "None", X, () => patchPrefs({ cover: "none" }), "none")}
      {db.fields.filter((f) => f.type === "url").map((f) => radio(cover === f.id, `Image from ${f.name}`, TYPE_ICON.url, () => patchPrefs({ cover: f.id }), f.id))}
    </>
  );
}

/**
 * Options of a status / select / tags field: rename (cells follow), recolour, reorder with
 * buttons (a keyboard and single-pointer alternative to dragging), delete and add.
 */
function OptionsEditor({ ctx, f }: { ctx: Ctx; f: DbField }) {
  const { doc, db } = ctx;
  const opts = f.options ?? [];
  const [tone, setTone] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState("");
  const write = (next: DbOption[], renames?: Record<string, string>) => setOptions(doc, db.id, f.id, next, renames);
  const used = (v: string) => db.rows.filter((r) => (Array.isArray(r.v[f.id]) ? (r.v[f.id] as string[]).includes(v) : r.v[f.id] === v)).length;
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (opts.some((o) => o.v === v)) return setMsg(`“${v}” already exists`);
    write([...opts, { v, c: TONES[(opts.length + 1) % TONES.length] }]);
    setDraft("");
    setMsg(`Added “${v}”`);
  };
  return (
    <div className="ocdb-opts">
      <div className="ocdb-mh">{opts.length} {opts.length === 1 ? "option" : "options"}</div>
      <ul aria-label={`${f.name} options`}>
        {opts.map((o, i) => (
          <li key={o.v}>
            <button
              className={`ocdb-tone ocdb-c-${o.c}`}
              aria-label={`Colour of ${o.v}: ${TONE_NAME[o.c] ?? o.c}. Change`}
              aria-expanded={tone === o.v}
              onClick={() => setTone(tone === o.v ? null : o.v)}
            />
            <CommitInput
              className="ocdb-pin"
              value={o.v}
              ariaLabel={`Option ${i + 1} name`}
              onCommit={(v) => {
                const nv = v.trim();
                if (!nv || nv === o.v) return;
                if (opts.some((x) => x.v === nv)) return setMsg(`“${nv}” already exists`);
                write(opts.map((x) => (x.v === o.v ? { ...x, v: nv } : x)), { [o.v]: nv });
                setMsg(`Renamed to “${nv}”`);
              }}
            />
            <button className="ocdb-ib" aria-label={`Move ${o.v} up`} disabled={i === 0} onClick={() => write(swap(opts, i, i - 1))}><Ic i={ChevronUp} s={14} /></button>
            <button className="ocdb-ib" aria-label={`Move ${o.v} down`} disabled={i === opts.length - 1} onClick={() => write(swap(opts, i, i + 1))}><Ic i={ChevronDown} s={14} /></button>
            <button
              className="ocdb-ib"
              aria-label={`Delete ${o.v}`}
              onClick={() => {
                const n = used(o.v);
                write(opts.filter((x) => x.v !== o.v));
                setMsg(n ? `Deleted “${o.v}” and cleared it from ${n} ${n === 1 ? "row" : "rows"}. Ctrl+Z undoes it.` : `Deleted “${o.v}”`);
              }}
            >
              <Ic i={Trash2} s={14} />
            </button>
            {tone === o.v ? (
              <div className="ocdb-tones" role="radiogroup" aria-label={`Colour of ${o.v}`}>
                {TONES.map((t) => (
                  <button
                    key={t}
                    role="radio"
                    aria-checked={o.c === t}
                    aria-label={TONE_NAME[t]}
                    className={`ocdb-tone ocdb-c-${t}`}
                    onClick={() => {
                      write(opts.map((x) => (x.v === o.v ? { ...x, c: t } : x)));
                      setTone(null);
                    }}
                  >
                    {o.c === t ? <Check size={11} strokeWidth={3} /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="ocdb-pad ocdb-optadd">
        <input
          className="ocdb-pin"
          placeholder="Add an option"
          aria-label="New option name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button className="ocdb-btn sm" onClick={add} disabled={!draft.trim()}><Ic i={Plus} s={14} />Add</button>
      </div>
      <div className="ocdb-sr" role="status" aria-live="polite">{msg}</div>
    </div>
  );
}

/* ------------------------------------------------------- cell editor */

function CellEditor({ ctx, f, r, close }: { ctx: Ctx; f: DbField; r: DbRow; close: () => void }) {
  const { doc, db, people, env, compact } = ctx;
  const v = r.v[f.id];
  const set = (x: CellValue) => setCell(doc, db.id, r.id, f.id, x);
  const [q, setQ] = useState("");

  if (f.type === "status" || f.type === "select" || f.type === "tags") {
    const multi = f.type === "tags";
    const cur: string[] = multi ? (Array.isArray(v) ? v : []) : v ? [String(v)] : [];
    const opts = (f.options ?? []).filter((o) => o.v.toLowerCase().includes(q.trim().toLowerCase()));
    const exact = (f.options ?? []).some((o) => o.v.toLowerCase() === q.trim().toLowerCase());
    const pick = (val: string) => {
      if (multi) set(cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val]);
      else {
        set(val);
        close();
      }
    };
    const create = () => {
      const name = q.trim();
      if (!name) return;
      addOption(doc, db.id, f.id, name);
      pick(name);
      setQ("");
    };
    return (
      <>
        <div className="ocdb-pad">
          <input
            className="ocdb-pin"
            placeholder={multi ? "Search or add tags" : "Search or add an option"}
            aria-label="Search options"
            value={q}
            autoFocus={!compact}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (opts.length === 1 || exact) pick((exact ? (f.options ?? []).find((o) => o.v.toLowerCase() === q.trim().toLowerCase()) : opts[0])!.v);
                else create();
                if (multi) setQ("");
              }
            }}
          />
        </div>
        <div className="ocdb-mh">{multi ? `${f.name} · pick several` : f.name}</div>
        {opts.map((o) => (
          <button key={o.v} className="ocdb-mi" role={multi ? "menuitemcheckbox" : "menuitemradio"} aria-checked={cur.includes(o.v)} onClick={() => pick(o.v)}>
            <Pill label={o.v} c={o.c} st={f.type === "status"} />
            {cur.includes(o.v) ? <span className="chk"><Ic i={Check} s={14} /></span> : null}
          </button>
        ))}
        {q.trim() && !exact ? (
          <button className="ocdb-mi" onClick={create}>
            <Ic i={Plus} />
            <span className="lbl">Create “{q.trim()}”</span>
          </button>
        ) : null}
        {!multi && cur.length ? (
          <>
            <div className="ocdb-msep" />
            <button className="ocdb-mi" onClick={() => { set(null); close(); }}><Ic i={X} />Clear</button>
          </>
        ) : null}
      </>
    );
  }
  if (f.type === "person") {
    const list = people.pickable.filter((u) => u.name.toLowerCase().includes(q.trim().toLowerCase()));
    return (
      <>
        {people.pickable.length > 6 ? (
          <div className="ocdb-pad">
            <input className="ocdb-pin" placeholder="Search people" aria-label="Search people" value={q} autoFocus={!compact} onChange={(e) => setQ(e.target.value)} />
          </div>
        ) : null}
        <div className="ocdb-mh">{f.name}</div>
        {list.map((u) => (
          <button key={u.id} className="ocdb-mi" role="menuitemradio" aria-checked={v === u.id} onClick={() => { set(u.id); close(); }}>
            <Avatar u={u} />
            <span className="lbl">{u.name}{u.id === env.me.id ? " (you)" : ""}</span>
            {v === u.id ? <span className="chk"><Ic i={Check} s={14} /></span> : null}
          </button>
        ))}
        {!list.length ? <p className="ocdb-hint" style={{ padding: "6px 10px" }}>No one matches.</p> : null}
        {v ? (
          <>
            <div className="ocdb-msep" />
            <button className="ocdb-mi" onClick={() => { set(null); close(); }}><Ic i={X} />Clear</button>
          </>
        ) : null}
      </>
    );
  }
  if (f.type === "date") {
    const quick: [string, LucideIcon, number][] = [["Today", Calendar, 0], ["Tomorrow", Sun, 1], ["Next week", CalendarRange, 7]];
    return (
      <>
        <div className="ocdb-pad">
          <input
            type="date"
            className="ocdb-pin"
            aria-label={f.name}
            defaultValue={typeof v === "string" ? v : ""}
            onChange={(e) => {
              if (e.target.value) set(e.target.value);
            }}
          />
        </div>
        {quick.map(([label, I, n]) => (
          <button key={label} className="ocdb-mi" onClick={() => { set(addDays(n)); close(); }}>
            <Ic i={I} />
            {label}
            <span className="mk">{fmtDate(addDays(n))}</span>
          </button>
        ))}
        {v ? (
          <>
            <div className="ocdb-msep" />
            <button className="ocdb-mi" onClick={() => { set(null); close(); }}><Ic i={X} />Clear</button>
          </>
        ) : null}
      </>
    );
  }
  if (f.type === "url") {
    return (
      <>
        <div className="ocdb-pad">
          <input
            className="ocdb-pin"
            defaultValue={typeof v === "string" ? v : ""}
            placeholder="https://"
            aria-label="URL"
            inputMode="url"
            autoFocus={!compact}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const t = (e.target as HTMLInputElement).value.trim();
                set(t || null);
                close();
              }
            }}
            onBlur={(e) => {
              const t = e.target.value.trim();
              if (t !== (v ?? "")) set(t || null);
            }}
          />
        </div>
        <div className="ocdb-note">Press Enter to save</div>
        {v ? (
          <>
            <div className="ocdb-msep" />
            <a className="ocdb-mi" href={safeUrl(String(v))} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}><Ic i={ExternalLink} />Open link</a>
          </>
        ) : null}
      </>
    );
  }
  if (f.type === "progress") return <ProgressEditor value={Number(v) || 0} onCommit={(n) => set(n)} />;
  return null;
}

function ProgressEditor({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [n, setN] = useState(value);
  const last = useRef(value);
  const commit = () => {
    if (n !== last.current) {
      last.current = n;
      onCommit(n);
    }
  };
  const ref = useRef(commit);
  ref.current = commit;
  useEffect(() => () => ref.current(), []);
  return (
    <div className="ocdb-range">
      <input type="range" min={0} max={100} step={5} value={n} aria-label="Progress" onChange={(e) => setN(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
      <b>{n}%</b>
    </div>
  );
}

/* ============================================================ peek */

function Peek({ ctx, rowId, onClose, onDelete }: { ctx: Ctx; rowId: string; onClose: () => void; onDelete: (rid: string) => void }) {
  const { db, doc, edit, compact, people, open } = ctx;
  const r = db.rows.find((x) => x.id === rowId);
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Previous / next follow the current view's order (filters, search and sorts applied).
  const list = ctx.rows;
  const idx = list.findIndex((x) => x.id === rowId);
  const go = (d: -1 | 1) => {
    const n = list[idx + d];
    if (!n) return;
    // Commit any open draft first (the fields remount for the next row).
    const a = document.activeElement as HTMLElement | null;
    if (a && ref.current?.contains(a) && a.matches("input,textarea")) a.blur();
    ctx.setPeek(n.id);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-nav="${d < 0 ? "prev" : "next"}"]`)?.focus());
  };
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    // Remember what opened the panel and give focus back to it on close.
    const opener = document.activeElement as HTMLElement | null;
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".ocdb-pop,.ocdb-sheet,.ocdb-modal")) return;
      if (e.key === "Escape") return closeRef.current();
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest?.("input,textarea,[contenteditable='true']");
      const inside = !!(t && ref.current?.contains(t));
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && (inside || !typing)) {
        e.preventDefault();
        goRef.current(e.key === "ArrowUp" ? -1 : 1);
      } else if (inside && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "j" || e.key === "k")) {
        e.preventDefault();
        goRef.current(e.key === "k" ? -1 : 1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    };
  }, []);
  if (!r || typeof document === "undefined") return null;
  const tf = titleField(db);
  const Icon = dbIcon(db.icon);
  const title = String(r.v[tf.id] ?? "") || "Untitled";
  return createPortal(
    <aside ref={ref} tabIndex={-1} role="dialog" className={"ocdb-side ocdb-layer" + (compact ? " ocdb-compact" : "")} aria-label={`${title}: row details`}>
      <div className="ocdb-shd">
        <Ic i={Icon} s={14} />
        <span>{db.name}</span>
        <span className="grow" />
        {idx >= 0 && list.length > 1 ? (
          <span className="ocdb-pnav">
            <span className="ocdb-pcount" aria-live="polite">{idx + 1} of {list.length}</span>
            <button className="ocdb-ib" data-nav="prev" title="Previous row (K or Alt+Up)" aria-label="Previous row" aria-keyshortcuts="Alt+ArrowUp K" disabled={idx <= 0} onClick={() => go(-1)}>
              <Ic i={ChevronUp} />
            </button>
            <button className="ocdb-ib" data-nav="next" title="Next row (J or Alt+Down)" aria-label="Next row" aria-keyshortcuts="Alt+ArrowDown J" disabled={idx >= list.length - 1} onClick={() => go(1)}>
              <Ic i={ChevronDown} />
            </button>
          </span>
        ) : null}
        {edit ? (
          <button className="ocdb-ib" title="Delete row" aria-label="Delete row" onClick={() => onDelete(r.id)}>
            <Ic i={Trash2} />
          </button>
        ) : null}
        <button className="ocdb-ib" aria-label="Close" onClick={onClose}>
          <Ic i={X} />
        </button>
      </div>
      <div className="ocdb-sbd" key={r.id}>
        <CommitArea
          className="ocdb-ptitle"
          value={String(r.v[tf.id] ?? "")}
          readOnly={!edit}
          placeholder="Untitled"
          ariaLabel={tf.name}
          singleLine
          autoFocus={edit && !r.v[tf.id] && !compact}
          onCommit={(x) => setCell(doc, db.id, r.id, tf.id, x)}
        />
        <div className="ocdb-props">
          {db.fields
            .filter((f) => f.id !== tf.id)
            .map((f) => (
              <PeekProp key={f.id} ctx={ctx} f={f} r={r} open={open} people={people} />
            ))}
        </div>
        <div className="ocdb-notes">
          <CommitArea
            value={db.notes[r.id] ?? ""}
            readOnly={!edit}
            placeholder={edit ? "Add notes, links or a checklist" : "No notes"}
            ariaLabel="Notes"
            onCommit={(x) => setNote(doc, db.id, r.id, x)}
          />
        </div>
      </div>
    </aside>,
    document.body,
  );
}

function PeekProp({ ctx, f, r, open, people }: { ctx: Ctx; f: DbField; r: DbRow; open: Ctx["open"]; people: People }) {
  const { doc, db, edit } = ctx;
  const v = r.v[f.id];
  const label = (
    <div className="ocdb-pk">
      <Ic i={TYPE_ICON[f.type] ?? TYPE_ICON.text} s={14} />
      <span>{f.name}</span>
      {f.description ? <small className="ocdb-pdesc">{f.description}</small> : null}
    </div>
  );
  if (f.type === "text" || f.type === "number") {
    const num = f.type === "number";
    return (
      <>
        {label}
        <div className="ocdb-pv">
          <CommitInput
            value={v == null ? "" : String(v)}
            readOnly={!edit}
            placeholder="Empty"
            inputMode={num ? "decimal" : "text"}
            ariaLabel={f.name}
            onCommit={(x) => setCell(doc, db.id, r.id, f.id, num ? parseNum(x) : x.trim() ? x : null)}
          />
        </div>
      </>
    );
  }
  if (f.type === "checkbox") {
    return (
      <>
        {label}
        <div className="ocdb-pv">
          <button className={"ocdb-cbx" + (v ? " on" : "")} role="checkbox" aria-checked={!!v} aria-label={f.name} disabled={!edit} onClick={() => setCell(doc, db.id, r.id, f.id, !v)}>
            <Check size={12} strokeWidth={3} />
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      {label}
      <button
        className="ocdb-pv"
        disabled={!edit}
        onClick={(e) => open({ kind: "cell", rowId: r.id, fid: f.id, anchor: e.currentTarget, key: `p${r.id}${f.id}` })}
      >
        <Value f={f} v={v} people={people} peek />
      </button>
    </>
  );
}

/** Auto-growing textarea with draft-while-focused semantics (see CommitInput). */
function CommitArea({
  value, onCommit, readOnly, placeholder, className, ariaLabel, singleLine, autoFocus,
}: { value: string; onCommit: (v: string) => void; readOnly?: boolean; placeholder?: string; className?: string; ariaLabel?: string; singleLine?: boolean; autoFocus?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const skip = useRef(false);
  const shown = draft ?? value;
  useEffect(() => {
    const el = ref.current;
    if (!el || CSS_FIELD_SIZING) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [shown]);
  return (
    <textarea
      ref={ref}
      className={className}
      value={shown}
      readOnly={readOnly}
      placeholder={placeholder}
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      rows={1}
      onFocus={() => !readOnly && setDraft(value)}
      onChange={(e) => setDraft(singleLine ? e.target.value.replace(/\n/g, " ") : e.target.value)}
      onBlur={() => {
        if (skip.current) skip.current = false;
        else if (draft !== null && draft !== value) onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          skip.current = true;
          e.stopPropagation();
          (e.target as HTMLTextAreaElement).blur();
        } else if (e.key === "Enter" && (singleLine || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}

const CSS_FIELD_SIZING = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");
