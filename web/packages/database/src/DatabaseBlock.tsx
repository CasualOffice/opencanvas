import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as Y from "yjs";
import {
  ArrowDown, ArrowUp, ArrowUpDown, Calendar, CalendarDays, CalendarRange, Check, ChevronLeft, ChevronRight, Copy, Download,
  Ellipsis, ExternalLink, LayoutGrid, ListFilter, PanelRightOpen, Plus, Search, SquareKanban, Sun, Table, Trash2, Upload, X,
  type LucideIcon,
} from "lucide-react";
import type { BlockEnv, OcUser } from "@opencanvas/ui";
import { CsvImportDialog } from "./CsvImportDialog";
import {
  addField, addOption, addRow, appendCsv, databasesRoot, databaseToCsv, databaseToMarkdown, DB_ORIGIN, deleteField, deleteRow, FIELD_LABEL,
  getDbMap, moveRow, readDb, renameField, restoreField, restoreRow, setCell, setDbMeta, setNote, setPrefs, setView,
} from "./model";
import { DEMO_PEOPLE } from "./presets";
import {
  addDays, dateField, defaultMonth, fmtDate, groupField, isoDate, isoMonth, MONTHS, optOf, shiftMonth, titleField, visibleRows,
} from "./query";
import { ensureStyles } from "./styles";
import type { CellValue, DbField, DbRow, DbSnapshot, FieldType, ViewKind, ViewPrefs } from "./types";
import { FIELD_TYPES } from "./types";
import { Avatar, CommitInput, dbIcon, Ic, Pop, TYPE_ICON, type Anchor } from "./ui";

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
      c.snap = m ? readDb(dbId, m) : null;
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
  return useMemo(() => {
    const byId = new Map<string, OcUser>();
    for (const u of [env.me, ...env.users]) if (u && !byId.has(u.id)) byId.set(u.id, u);
    const referenced = new Set<string>();
    if (db) for (const f of db.fields) if (f.type === "person") for (const r of db.rows) if (typeof r.v[f.id] === "string" && r.v[f.id]) referenced.add(r.v[f.id] as string);
    for (const d of DEMO_PEOPLE) if (!byId.has(d.id) && referenced.has(d.id)) byId.set(d.id, d);
    const pickable = [...byId.values()];
    const resolve = (id: unknown): OcUser | null => {
      if (!id) return null;
      const s = String(id);
      return byId.get(s) ?? DEMO_PEOPLE.find((d) => d.id === s) ?? { id: s, name: s, color: "var(--fg-3)" };
    };
    return { resolve, pickable };
  }, [env.me, env.users, db]);
}

const firstName = (u: OcUser) => u.name.split(/\s+/)[0];

/* ------------------------------------------------------------- values */

function Pill({ label, c, st }: { label: string; c?: string; st?: boolean }) {
  return <span className={`ocdb-pill ocdb-c-${c ?? "gray"}${st ? " st" : ""}`}>{label}</span>;
}

function Value({ f, v, people, peek }: { f: DbField; v: CellValue | undefined; people: People; peek?: boolean }): ReactNode {
  const empty = <span className="ocdb-emptyc">{peek ? "Empty" : ""}</span>;
  switch (f.type) {
    case "status":
    case "select": {
      const o = optOf(f, v);
      return o ? <Pill label={o.v} c={o.c} st={f.type === "status"} /> : typeof v === "string" && v ? <Pill label={v} /> : empty;
    }
    case "tags":
      return Array.isArray(v) && v.length ? <>{v.map((t) => <Pill key={t} label={t} c={optOf(f, t)?.c} />)}</> : empty;
    case "person": {
      const u = people.resolve(v);
      return u ? (
        <span className="ocdb-person">
          <Avatar u={u} />
          <span>{u.name}</span>
        </span>
      ) : empty;
    }
    case "date":
      return v ? <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtDate(v)}</span> : empty;
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
          {String(v).replace(/^https?:\/\//, "")}
        </a>
      ) : empty;
    case "number":
      return v == null || v === "" ? empty : <>{fmtNum(Number(v))}</>;
    default:
      return v ? <>{String(v)}</> : empty;
  }
}

function safeUrl(u: string): string {
  return /^(https?:|mailto:)/i.test(u) ? u : "https://" + u.replace(/^\/+/, "");
}

/* --------------------------------------------------------- pop state */

type PopState =
  | { kind: "cell"; rowId: string; fid: string; anchor: Anchor; key: string }
  | { kind: "header"; fid: string; anchor: Anchor; key: string }
  | { kind: "filter"; fid?: string; anchor: Anchor; key: string }
  | { kind: "sort"; anchor: Anchor; key: string }
  | { kind: "addField"; anchor: Anchor; key: string }
  | { kind: "more"; anchor: Anchor; key: string };

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
  const gwRef = useRef<HTMLDivElement>(null);

  const open = (p: PopState) => setPop((cur) => (cur && cur.key === p.key ? null : p));
  const closePop = () => setPop(null);
  const patchPrefs = (patch: Partial<ViewPrefs>) => {
    if (edit) setPrefs(doc, dbId, view, patch);
    else setLocalPrefs((lp) => ({ ...lp, [view]: { ...(lp[view] ?? {}), ...patch } }));
  };

  useEffect(() => {
    if (peek && !db.rows.some((r) => r.id === peek)) setPeek(null);
  }, [db.rows, peek]);

  const newRow = (values: Record<string, CellValue> = {}, openPeek = view !== "table") => {
    if (!edit) return;
    const v = { ...values };
    const st = db.fields.find((f) => f.type === "status");
    if (st && !(st.id in v) && st.options?.length) v[st.id] = st.options[0].v;
    const rid = addRow(doc, dbId, v);
    if (prefs.filter || prefs.q) patchPrefs({ filter: null, q: "" });
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
  if (prefs.filter && prefs.filter.vals.length) {
    const f = db.fields.find((x) => x.id === prefs.filter!.f);
    if (f) {
      const label = prefs.filter.vals.map((v) => (f.type === "person" ? (people.resolve(v) ? firstName(people.resolve(v)!) : v) : v || "Empty")).join(", ");
      chips.push(
        <span className="ocdb-chip" key="f">
          <Ic i={ListFilter} s={12} />
          <span>{f.name}: {label}</span>
          <button className="ocdb-chip-x" onClick={() => patchPrefs({ filter: null })} aria-label="Clear filter"><Ic i={X} s={12} /></button>
        </span>,
      );
    }
  }
  if (prefs.sort) {
    const f = db.fields.find((x) => x.id === prefs.sort!.f);
    if (f)
      chips.push(
        <span className="ocdb-chip" key="s">
          <Ic i={prefs.sort.dir > 0 ? ArrowUp : ArrowDown} s={12} />
          <span>{f.name}</span>
          <button className="ocdb-chip-x" onClick={() => patchPrefs({ sort: null })} aria-label="Clear sort"><Ic i={X} s={12} /></button>
        </span>,
      );
  }

  const Icon = dbIcon(db.icon);
  const ctx: Ctx = { doc, db, env, edit, compact, people, rows, prefs, open, setPeek, newRow, focusRow, setFocusRow, patchPrefs };

  return (
    <div className={"ocdb" + (compact ? " ocdb-compact" : "") + (edit ? "" : " ocdb-ro")} data-db={dbId}>
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
                setTimeout(() => searchRef.current?.focus(), 30);
              }
            }}
          >
            <Ic i={Search} />
          </button>
          <button className={"ocdb-ib" + (prefs.filter ? " on" : "")} title="Filter" aria-label="Filter" onClick={(e) => open({ kind: "filter", anchor: e.currentTarget, key: "filter" })}>
            <Ic i={ListFilter} />
          </button>
          <button className={"ocdb-ib" + (prefs.sort ? " on" : "")} title="Sort" aria-label="Sort" onClick={(e) => open({ kind: "sort", anchor: e.currentTarget, key: "sort" })}>
            <Ic i={ArrowUpDown} />
          </button>
          <button className="ocdb-ib" title="More" aria-label="Database options" onClick={(e) => open({ kind: "more", anchor: e.currentTarget, key: "more" })}>
            <Ic i={Ellipsis} />
          </button>
        </div>
      </div>
      {chips.length ? <div className="ocdb-chips">{chips}</div> : null}

      <div className="ocdb-view">
        {view === "table" ? (
          <TableView ctx={ctx} gwRef={gwRef} />
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
            <button className="ocdb-btn ghost sm" onClick={() => { patchPrefs({ filter: null, q: "" }); setQDraft(null); setShowQ(false); }}>Clear filters</button>
          </div>
        ) : null}
      </div>

      {pop ? (
        <Pop
          anchor={pop.anchor}
          compact={compact}
          onClose={closePop}
          alignRight={pop.kind !== "cell" && pop.kind !== "header"}
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
        onImport={(csv) => {
          const n = appendCsv(doc, dbId, csv, people.pickable);
          env.toast(n ? `Imported ${n} ${n === 1 ? "row" : "rows"}` : "Nothing to import");
        }}
      />
    </div>
  );
}

function popTitle(p: PopState, db: DbSnapshot): string {
  const f = "fid" in p && p.fid ? db.fields.find((x) => x.id === p.fid) : undefined;
  switch (p.kind) {
    case "cell":
    case "header":
      return f?.name ?? "";
    case "filter":
      return "Filter";
    case "sort":
      return "Sort";
    case "addField":
      return "Add a field";
    case "more":
      return db.name || "Database";
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
  patchPrefs: (p: Partial<ViewPrefs>) => void;
}

/* ============================================================ table */

function TableView({ ctx, gwRef }: { ctx: Ctx; gwRef: React.RefObject<HTMLDivElement | null> }) {
  const { db, rows, edit, prefs, open } = ctx;
  const total = db.fields.reduce((t, f) => t + (W[f.type] ?? 160), 0) + (edit ? 44 : 0);
  return (
    <div className="ocdb-gw" ref={gwRef}>
      <table className="ocdb-grid" style={{ width: total }}>
        <colgroup>
          {db.fields.map((f) => <col key={f.id} style={{ width: W[f.type] ?? 160 }} />)}
          {edit ? <col style={{ width: 44 }} /> : null}
        </colgroup>
        <thead>
          <tr>
            {db.fields.map((f) => (
              <th key={f.id}>
                <button className="ocdb-hcell" onClick={(e) => open({ kind: "header", fid: f.id, anchor: e.currentTarget, key: "h" + f.id })}>
                  <Ic i={TYPE_ICON[f.type] ?? TYPE_ICON.text} s={14} />
                  <span>{f.name}</span>
                  {prefs.sort?.f === f.id ? <span className="ocdb-sortic"><Ic i={prefs.sort.dir > 0 ? ArrowUp : ArrowDown} s={12} /></span> : null}
                </button>
              </th>
            ))}
            {edit ? (
              <th className="ocdb-addcol">
                <button title="Add field" aria-label="Add field" onClick={(e) => open({ kind: "addField", anchor: e.currentTarget, key: "addField" })}>
                  <Ic i={Plus} />
                </button>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-row={r.id}>
              {db.fields.map((f) => <Cell key={f.id} ctx={ctx} f={f} r={r} />)}
              {edit ? <td /> : null}
            </tr>
          ))}
        </tbody>
        {rows.length ? (
          <tfoot>
            <tr>
              {db.fields.map((f, i) => <td key={f.id}>{footCell(f, i, rows)}</td>)}
              {edit ? <td /> : null}
            </tr>
          </tfoot>
        ) : null}
      </table>
      {edit ? (
        <button className="ocdb-newrow" onClick={() => ctx.newRow({}, false)}>
          <Ic i={Plus} />
          New row
        </button>
      ) : null}
      {db.rows.length === 0 ? <p className="ocdb-hint" style={{ padding: "16px 10px" }}>No rows yet.{edit ? " Add one to get started." : ""}</p> : null}
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

function Cell({ ctx, f, r }: { ctx: Ctx; f: DbField; r: DbRow }) {
  const { doc, db, edit, people, open, setPeek, focusRow, setFocusRow } = ctx;
  const v = r.v[f.id];
  if (f.type === "title") {
    return (
      <td>
        <div className="ocdb-ct">
          <CommitInput
            value={typeof v === "string" ? v : v == null ? "" : String(v)}
            readOnly={!edit}
            placeholder="Untitled"
            ariaLabel={f.name}
            autoFocus={focusRow === r.id}
            onCommit={(x) => setCell(doc, db.id, r.id, f.id, x)}
            onEnter={() => focusRow === r.id && setFocusRow(null)}
          />
          <button className="ocdb-peekbtn" onClick={() => setPeek(r.id)} aria-label="Open row">
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
      <td>
        <div className={"ocdb-cin" + (num ? " ocdb-num" : "")}>
          {edit ? (
            <CommitInput
              value={v == null ? "" : String(v)}
              inputMode={num ? "decimal" : "text"}
              ariaLabel={f.name}
              onCommit={(x) => setCell(doc, db.id, r.id, f.id, num ? parseNum(x) : x.trim() ? x : null)}
            />
          ) : (
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{num ? (v == null || v === "" ? "" : fmtNum(Number(v))) : String(v ?? "")}</span>
          )}
        </div>
      </td>
    );
  }
  if (f.type === "checkbox") {
    return (
      <td>
        <div className="ocdb-cin">
          <button
            className={"ocdb-cbx" + (v ? " on" : "")}
            role="checkbox"
            aria-checked={!!v}
            aria-label={f.name}
            disabled={!edit}
            onClick={() => setCell(doc, db.id, r.id, f.id, !v)}
          >
            <Check size={12} strokeWidth={3} />
          </button>
        </div>
      </td>
    );
  }
  return (
    <td>
      <button
        className="ocdb-cin"
        disabled={!edit && f.type !== "url"}
        aria-label={`${f.name}: ${isEmpty(v) ? "empty" : Array.isArray(v) ? v.join(", ") : String(f.type === "person" ? (people.resolve(v)?.name ?? v) : v)}`}
        onClick={(e) => {
          if (!edit) return;
          open({ kind: "cell", rowId: r.id, fid: f.id, anchor: e.currentTarget, key: `c${r.id}${f.id}` });
        }}
      >
        <Value f={f} v={v} people={people} />
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
  return db.fields
    .filter((f) => f.type !== "title" && f.id !== skip && !isEmpty(r.v[f.id]) && ["person", "date", "tags", "select", "status", "number"].includes(f.type))
    .slice(0, 3)
    .map((f) => {
      const v = r.v[f.id];
      if (f.type === "person") {
        const u = people.resolve(v);
        return u ? <span key={f.id}><Avatar u={u} size="xs" />{firstName(u)}</span> : null;
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
  const g = groupField(db);
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

  if (!g) return <p className="ocdb-hint">Add a Status or Select field to use the board view.</p>;
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

function CalendarView({ ctx }: { ctx: Ctx }) {
  const { db, rows, compact, setPeek, edit, newRow, people } = ctx;
  const df = dateField(db);
  // The shown month lives in the view prefs (`views.calendar.cal`) so collaborators see the same month.
  const month = ctx.prefs.cal && /^\d{4}-\d{2}$/.test(ctx.prefs.cal) ? ctx.prefs.cal : defaultMonth(db);
  const setMonth = (m: string) => m !== month && ctx.patchPrefs({ cal: m });
  if (!df) return <p className="ocdb-hint">Add a Date field to use the calendar view.</p>;
  const tf = titleField(db);
  const g = groupField(db);
  const pf = db.fields.find((f) => f.type === "person");
  const tone = (r: DbRow) => optOf(g, g ? r.v[g.id] : undefined)?.c ?? "gray";
  const [y, m] = month.split("-").map(Number);
  const today = isoDate(new Date());
  const head = (
    <div className="ocdb-calh">
      <b>{MONTHS[m - 1]} {y}</b>
      <button className="ocdb-btn ghost sm" onClick={() => setMonth(isoMonth(new Date()))}>Today</button>
      <button className="ocdb-ib" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}><Ic i={ChevronLeft} /></button>
      <button className="ocdb-ib" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}><Ic i={ChevronRight} /></button>
    </div>
  );
  const title = (r: DbRow) => String(r.v[tf.id] ?? "") || "Untitled";

  if (compact) {
    const items = rows.filter((r) => typeof r.v[df.id] === "string" && (r.v[df.id] as string).startsWith(month)).sort((a, c) => String(a.v[df.id]).localeCompare(String(c.v[df.id])));
    const byDay = new Map<string, DbRow[]>();
    for (const r of items) {
      const k = String(r.v[df.id]);
      byDay.set(k, [...(byDay.get(k) ?? []), r]);
    }
    return (
      <div className="ocdb-cal">
        {head}
        <div className="ocdb-agenda">
          {byDay.size ? (
            [...byDay.entries()].map(([d, list]) => (
              <div key={d}>
                <div className="ocdb-ad">{new Date(d + "T12:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</div>
                {list.map((r) => {
                  const u = pf ? people.resolve(r.v[pf.id]) : null;
                  return (
                    <button key={r.id} className="ocdb-ai" onClick={() => setPeek(r.id)}>
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
          {edit ? (
            <button className="ocdb-kadd" onClick={() => newRow({ [df.id]: month === isoMonth(new Date()) ? today : month + "-01" }, true)}>
              <Ic i={Plus} s={14} />
              New
            </button>
          ) : null}
        </div>
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
      <div key={key} className={"ocdb-day" + (inM ? "" : " out") + (key === today ? " today" : "")}>
        <span className="ocdb-dn">{date.getDate()}</span>
        {edit ? (
          <button className="ocdb-dadd" aria-label={`Add on ${fmtDate(key)}`} onClick={() => newRow({ [df.id]: key }, true)}>
            <Ic i={Plus} s={14} />
          </button>
        ) : null}
        {(byDate.get(key) ?? []).map((r) => (
          <button key={r.id} className={`ocdb-cev ocdb-pill ocdb-c-${tone(r)}`} title={title(r)} onClick={() => setPeek(r.id)}>
            {title(r)}
          </button>
        ))}
      </div>,
    );
  }
  return (
    <div className="ocdb-cal">
      {head}
      <div className="ocdb-calg">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="ocdb-dow">{d}</div>)}
        {cells}
      </div>
    </div>
  );
}

/* ========================================================= gallery */

function GalleryView({ ctx }: { ctx: Ctx }) {
  const { db, rows, edit, setPeek, newRow } = ctx;
  const g = groupField(db);
  const tf = titleField(db);
  const Icon = dbIcon(db.icon);
  return (
    <div className="ocdb-gal">
      {rows.map((r) => {
        const o = g ? optOf(g, r.v[g.id]) : undefined;
        const title = String(r.v[tf.id] ?? "");
        return (
          <button key={r.id} className="ocdb-gcard" onClick={() => setPeek(r.id)}>
            <div className={`ocdb-gcov ocdb-c-${o?.c ?? "gray"}`}><Icon size={26} strokeWidth={1.4} aria-hidden="true" /></div>
            <div className="ocdb-gb">
              <span className={"ocdb-gt" + (title ? "" : " untitled")}>{title || "Untitled"}</span>
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
      const canFilter = ["status", "select", "person", "tags", "checkbox"].includes(f.type);
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
          <div className="ocdb-mh"><Ic i={TYPE_ICON[f.type]} s={12} />{FIELD_LABEL[f.type]}</div>
          <button className="ocdb-mi" onClick={() => { patchPrefs({ sort: { f: f.id, dir: 1 } }); close(); }}><Ic i={ArrowUp} />Sort ascending</button>
          <button className="ocdb-mi" onClick={() => { patchPrefs({ sort: { f: f.id, dir: -1 } }); close(); }}><Ic i={ArrowDown} />Sort descending</button>
          {canFilter ? (
            <button className="ocdb-mi" onClick={() => setPop({ kind: "filter", fid: f.id, anchor: pop.anchor, key: "filter" })}>
              <Ic i={ListFilter} />Filter by {f.name.toLowerCase()}
            </button>
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
                  if (prefs.sort?.f === f.id) p.sort = null;
                  if (prefs.filter?.f === f.id) p.filter = null;
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
    case "filter":
      return <FilterBody ctx={ctx} fid={pop.fid} close={close} />;
    case "sort":
      return (
        <>
          <div className="ocdb-mh">Sort by</div>
          {db.fields.map((f) => {
            const on = prefs.sort?.f === f.id;
            return (
              <button
                key={f.id}
                className="ocdb-mi"
                onClick={() => {
                  patchPrefs({ sort: on ? { f: f.id, dir: prefs.sort!.dir > 0 ? -1 : 1 } : { f: f.id, dir: 1 } });
                  close();
                }}
              >
                <Ic i={TYPE_ICON[f.type]} />
                <span className="lbl">{f.name}</span>
                {on ? <span className="chk"><Ic i={prefs.sort!.dir > 0 ? ArrowUp : ArrowDown} s={14} /></span> : null}
              </button>
            );
          })}
          {prefs.sort ? (
            <>
              <div className="ocdb-msep" />
              <button className="ocdb-mi" onClick={() => { patchPrefs({ sort: null }); close(); }}><Ic i={X} />Clear sort</button>
            </>
          ) : null}
        </>
      );
    case "addField":
      return (
        <>
          <div className="ocdb-mh">Add a field</div>
          {FIELD_TYPES.filter((t) => t !== "title").map((t) => (
            <button
              key={t}
              className="ocdb-mi"
              onClick={() => {
                close();
                addField(doc, db.id, t);
                setTimeout(() => gwRef.current?.scrollTo?.({ left: gwRef.current.scrollWidth, behavior: "smooth" }), 50);
                env.toast(`Added a ${FIELD_LABEL[t]} field. Click its header to rename it.`);
              }}
            >
              <Ic i={TYPE_ICON[t]} />
              {FIELD_LABEL[t]}
            </button>
          ))}
        </>
      );
    case "more":
      return (
        <>
          {edit ? <button className="ocdb-mi" onClick={() => { close(); onImport(); }}><Ic i={Upload} />Import CSV</button> : null}
          <button className="ocdb-mi" onClick={() => { close(); onExport(); }}><Ic i={Download} />Export CSV<span className="mk">.csv</span></button>
          <button className="ocdb-mi" onClick={() => { close(); onCopyMd(); }}><Ic i={Copy} />Copy as Markdown table</button>
          {edit ? (
            <>
              <div className="ocdb-msep" />
              <button className="ocdb-mi" onClick={(e) => setPop({ kind: "addField", anchor: pop.anchor, key: "addField" + e.timeStamp })}><Ic i={Plus} />Add a field</button>
            </>
          ) : null}
        </>
      );
  }
}

function FilterBody({ ctx, fid, close }: { ctx: Ctx; fid?: string; close: () => void }) {
  const { db, prefs, patchPrefs, people, env } = ctx;
  const filterable = db.fields.filter((f) => ["status", "select", "person", "tags", "checkbox"].includes(f.type));
  const [cur, setCur] = useState<string | undefined>(fid ?? prefs.filter?.f ?? (groupField(db) ?? filterable[0])?.id);
  const f = db.fields.find((x) => x.id === cur);
  if (!filterable.length || !f) {
    return <p className="ocdb-hint" style={{ padding: "10px 12px" }}>Add a Status, Select or Person field to filter.</p>;
  }
  const vals: { v: string; node: ReactNode }[] =
    f.type === "person"
      ? people.pickable.map((u) => ({ v: u.id, node: <span className="ocdb-person"><Avatar u={u} /><span>{u.name}{u.id === env.me.id ? " (you)" : ""}</span></span> }))
      : f.type === "checkbox"
        ? [{ v: "true", node: <>Checked</> }, { v: "false", node: <>Not checked</> }]
        : (f.options ?? []).map((o) => ({ v: o.v, node: <Pill label={o.v} c={o.c} st={f.type === "status"} /> }));
  const sel = prefs.filter?.f === f.id ? prefs.filter.vals : [];
  const toggle = (v: string) => {
    const next = sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v];
    patchPrefs({ filter: next.length ? { f: f.id, vals: next } : null });
  };
  return (
    <>
      {filterable.length > 1 ? (
        <>
          <div className="ocdb-mh">Field</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "2px 6px 6px" }}>
            {filterable.map((x) => (
              <button key={x.id} className={"ocdb-btn sm" + (x.id === f.id ? "" : " ghost")} onClick={() => setCur(x.id)}>
                <Ic i={TYPE_ICON[x.type]} s={14} />
                {x.name}
              </button>
            ))}
          </div>
        </>
      ) : null}
      <div className="ocdb-mh">Show only</div>
      {vals.map(({ v, node }) => (
        <button key={v} className="ocdb-mi" role="menuitemcheckbox" aria-checked={sel.includes(v)} onClick={() => toggle(v)}>
          {node}
          {sel.includes(v) ? <span className="chk"><Ic i={Check} s={14} /></span> : null}
        </button>
      ))}
      <div className="ocdb-msep" />
      <button className="ocdb-mi" onClick={() => { patchPrefs({ filter: null }); close(); }}><Ic i={X} />Clear filter</button>
    </>
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".ocdb-pop,.ocdb-sheet,.ocdb-modal")) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  if (!r || typeof document === "undefined") return null;
  const tf = titleField(db);
  const Icon = dbIcon(db.icon);
  return createPortal(
    <aside ref={ref} className={"ocdb-side ocdb-layer" + (compact ? " ocdb-compact" : "")} aria-label="Row details">
      <div className="ocdb-shd">
        <Ic i={Icon} s={14} />
        <span>{db.name}</span>
        <span className="grow" />
        {edit ? (
          <button className="ocdb-ib" title="Delete row" aria-label="Delete row" onClick={() => onDelete(r.id)}>
            <Ic i={Trash2} />
          </button>
        ) : null}
        <button className="ocdb-ib" aria-label="Close" onClick={onClose}>
          <Ic i={X} />
        </button>
      </div>
      <div className="ocdb-sbd">
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
