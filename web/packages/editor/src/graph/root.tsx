// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The knowledge graph (GRAPH-02/03, ADR-082), to the approved prototype
// docs/prototypes/v05-approved/knowledge-graph.html: the local graph beside the canvas with a
// depth slider (1b), the full graph with filters, search, preview, selection and pins (1a, 2a,
// 2b, 3a), the sortable list (4a), the keyboard and screen reader model (4b), the phone with the
// list first (5a-5c), and the empty, off, loading and too-large states (6a-6d). A lazy chunk:
// nothing here is in the editor's initial JS (GRAPH-A4). Everything drawn is what the server
// answered for this person; a canvas they cannot open is never drawn, counted or bridged.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, AtSign, ChevronLeft, Crosshair, Download, Filter, Info, Layers, Link2, List, Maximize, Pin, Share2, Unlink, X } from "lucide-react";
import { fetchGraph, type GraphError } from "./api";
import { defaults, loadPins, savePins, spaceTones, view as makeView, type Filters, type GraphData, type View } from "./model";
import { FilterPanel, GraphCanvas, GraphList, NodeCard, PhoneList, Seg, spaceCounts, Switch, target, useRows } from "./parts";
import { csv } from "./model";
import "./graph.css";

export interface GraphRootProps {
  mode: "local" | "full";
  ticket: string;
  fileId: string;
  title: string;
  userId: string;
  hostName: string;
  compact: boolean;
  /** Opens another canvas through the host (UI_OpenFile), or this one at a block. */
  open(fileId: string, blockId: string | null): void;
  onClose(): void;
  /** The local panel's "Open full graph". */
  onFull?: () => void;
  /** "Linked from" (and unlinked mentions) for this canvas. */
  onLinkedFrom?: () => void;
  toast?: (text: string) => void;
}

export default function GraphRoot(p: GraphRootProps) {
  return p.mode === "local" ? <LocalGraph {...p} /> : <FullGraph {...p} />;
}

// ---------- data ----------

type Load = { s: "loading"; slow: boolean } | { s: "ready"; data: GraphData; now: number } | { s: "error"; e: GraphError };

/** Answers kept for the panel's life: a deeper or block-carrying answer serves shallower views. */
function useGraph(ticket: string, full: boolean, depth: number, blocks: boolean) {
  const cache = useRef<{ depth: number; blocks: boolean; data: GraphData; now: number }[]>([]);
  const [load, setLoad] = useState<Load>({ s: "loading", slow: false });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const hit = cache.current.find((c) => (full || c.depth >= depth) && (c.blocks || !blocks));
    if (hit) return setLoad({ s: "ready", data: hit.data, now: hit.now });
    const ac = new AbortController();
    setLoad({ s: "loading", slow: false });
    const slow = window.setTimeout(() => setLoad((l) => (l.s === "loading" ? { s: "loading", slow: true } : l)), 3000);
    fetchGraph(ticket, { full, depth, blocks, signal: ac.signal })
      .then((data) => {
        const now = Date.now();
        cache.current.push({ depth, blocks, data, now });
        setLoad({ s: "ready", data, now });
      })
      .catch((e: GraphError) => {
        if (!ac.signal.aborted) setLoad({ s: "error", e });
      })
      .finally(() => window.clearTimeout(slow));
    return () => (ac.abort(), window.clearTimeout(slow));
  }, [ticket, full, depth, blocks, tick]);
  return { load, retry: () => setTick((t) => t + 1) };
}

function usePins(user: string, surface: string) {
  const [pins, setPins] = useState(() => loadPins(user, surface));
  const set = useCallback((m: Map<string, [number, number]>) => (setPins(new Map(m)), savePins(user, surface, m)), [user, surface]);
  return [pins, set] as const;
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- states (6a-6c) ----------

function Loading({ hostName, slow }: { hostName: string; slow: boolean }) {
  return (
    <div className="gr-load" role="status" aria-label="Loading the graph">
      {[
        [44, 40, 2.25],
        [18, 22, 1.25],
        [72, 18, 1.5],
        [78, 58, 1],
        [24, 66, 1.375],
        [50, 76, 0.875],
      ].map(([l, t, s], i) => (
        <span key={i} className={"gr-sk" + (reduced() ? " still" : "")} style={{ left: `${l}%`, top: `${t}%`, width: `${s}rem`, height: `${s}rem` }} />
      ))}
      <div className="gr-load-t">{slow ? `Still checking access with ${hostName}` : "Checking which canvases you can open"}</div>
    </div>
  );
}

function Problem({ e, hostName, retry, toast }: { e: GraphError; hostName: string; retry(): void; toast?: (t: string) => void }) {
  if (e.code === "LINKS_OFF")
    return (
      <div className="gr-est">
        <div>
          <div className="gr-eic">
            <Unlink size={20} aria-hidden="true" />
          </div>
          <h4>The graph needs links turned on</h4>
          <p>{hostName} has not turned on the link index, so OpenCanvas cannot see which canvases link to each other. Ask your admin to turn on links.</p>
          <button
            type="button"
            className="gr-btn"
            onClick={() => {
              const note = `Please turn on links for OpenCanvas in ${hostName}: set [host.flags] links = true for this host, so the knowledge graph and "Linked from" work.`;
              void navigator.clipboard?.writeText(note).then(() => toast?.("Note copied"), () => toast?.("Could not copy the note"));
            }}
          >
            Copy a note for your admin
          </button>
        </div>
      </div>
    );
  const busy = e.code === "RATE_LIMITED";
  return (
    <div className="gr-est" role="alert">
      <div>
        <div className="gr-eic">
          <Info size={20} aria-hidden="true" />
        </div>
        <h4>{busy ? "Too many graphs at once" : "The graph did not load"}</h4>
        <p>{busy ? `Try again in ${e.retryAfter || 30} seconds.` : e.code === "ROLE_FORBIDDEN" ? "You can no longer open this canvas." : `${hostName} or OpenCanvas did not answer. Try again.`}</p>
        <button type="button" className="gr-btn" onClick={retry}>
          Try again
        </button>
      </div>
    </div>
  );
}

function Empty({ title, onLinkedFrom }: { title: string; onLinkedFrom?: () => void }) {
  return (
    <div className="gr-est">
      <div>
        <svg viewBox="0 0 120 70" className="gr-eart" aria-hidden="true">
          <line x1="60" y1="35" x2="20" y2="15" />
          <line x1="60" y1="35" x2="100" y2="20" />
          <line x1="60" y1="35" x2="88" y2="62" />
          <circle cx="20" cy="15" r="5" />
          <circle cx="100" cy="20" r="6" />
          <circle cx="88" cy="62" r="4" />
          <circle cx="60" cy="35" r="10" className="me" />
          <circle cx="60" cy="35" r="14" className="ring" />
        </svg>
        <h4>No links yet</h4>
        <p>
          {title} does not link to another canvas, and nothing links to it. Type <code>[[</code> to link a canvas, or see if other canvases mention it.
        </p>
        {onLinkedFrom ? (
          <button type="button" className="gr-btn" onClick={onLinkedFrom}>
            <AtSign size={15} aria-hidden="true" />
            Unlinked mentions
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 6d: more canvases than the graph draws. */
function Banner({ data, drawn, children }: { data: GraphData; drawn: number; children?: React.ReactNode }) {
  if (!data.truncated) return null;
  return (
    <div className="gr-ban" role="status">
      <Info size={16} aria-hidden="true" />
      <span>
        <b>{data.total ? `Showing ${drawn.toLocaleString()} of ${data.total.toLocaleString()} canvases` : `Showing the ${drawn.toLocaleString()} most linked canvases`}</b>, the most linked ones you can open. Narrow with filters.
      </span>
      <span className="grow" />
      {children}
    </div>
  );
}

/** 5a: the phone's sheet for the selected canvas. */
function Sheet({ id, v, tones, now, onOpen, onLocal, onClose }: { id: string; v: View; tones: Map<string, string>; now: number; onOpen(): void; onLocal?: () => void; onClose(): void }) {
  const n = v.byId.get(id);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), [id]);
  if (!n) return null;
  return (
    <div className="gr-sheet" role="dialog" aria-label={n.title} tabIndex={-1} ref={ref} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
      <div className="grab" />
      <button type="button" className="gr-ib gr-shx" aria-label="Close" onClick={onClose}>
        <X size={18} aria-hidden="true" />
      </button>
      <NodeCard n={n} v={v} tones={tones} now={now} />
      <div className="gr-sha">
        <button type="button" className="gr-btn pri" onClick={onOpen}>
          <ArrowUpRight size={16} aria-hidden="true" />
          Open
        </button>
        {onLocal && n.kind === "canvas" ? (
          <button type="button" className="gr-btn" onClick={onLocal}>
            <Crosshair size={16} aria-hidden="true" />
            Local graph
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---------- the local graph (1b) ----------

function LocalGraph(p: GraphRootProps) {
  const [depth, setDepth] = useState(1);
  const [blocks, setBlocks] = useState(false);
  const [mode, setMode] = useState<"graph" | "list">(p.compact ? "list" : "graph");
  const [sheet, setSheet] = useState<string | null>(null);
  const { load, retry } = useGraph(p.ticket, false, depth, blocks);
  const [pins, setPins] = usePins(p.userId, "local:" + p.fileId);
  const f: Filters = useMemo(() => ({ ...defaults(), blocks }), [blocks]);
  const ready = load.s === "ready" ? load : null;
  const tones = useMemo(() => spaceTones(ready?.data.nodes ?? []), [ready]);
  const v = useMemo(() => (ready ? makeView(ready.data, f, ready.now, { current: p.fileId, root: p.fileId, depth }) : null), [ready, f, p.fileId, depth]);
  const open = (id: string) => {
    const [fid, bid] = target(v?.byId.get(id), id);
    p.open(fid, bid);
  };
  const canv = v ? v.nodes.filter((n) => n.kind === "canvas").length : 0;
  const links = v ? v.edges.filter((e) => e.k !== "in").length : 0;
  const empty = !!v && !links;
  return (
    <aside className="side gr-side" aria-label="Local graph" aria-busy={load.s === "loading"}>
      <div className="shd">
        <Share2 size={16} aria-hidden="true" />
        <b>Local graph</b>
        <span className="grow" />
        <button type="button" className="gr-ib" aria-label="Close graph" onClick={p.onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {load.s === "error" ? (
        <Problem e={load.e} hostName={p.hostName} retry={retry} toast={p.toast} />
      ) : (
        <>
          <div className="gr-lp">
            <div className="row">
              <label htmlFor="gr-depth">Depth</label>
              <input id="gr-depth" type="range" min={1} max={3} step={1} value={depth} aria-valuetext={`${depth} ${depth > 1 ? "links" : "link"} away`} onChange={(e) => setDepth(Number(e.target.value))} />
              <span className="val">
                {depth} {depth > 1 ? "links" : "link"}
              </span>
            </div>
            <Switch label="Show blocks" on={blocks} set={setBlocks} />
            {p.compact && v && !empty ? (
              <Seg
                label="View"
                className="gr-pseg"
                value={mode}
                items={[
                  ["list", "List"],
                  ["graph", "Graph"],
                ]}
                set={(m) => setMode(m as "graph" | "list")}
              />
            ) : null}
          </div>
          {ready && v ? <Banner data={ready.data} drawn={canv} /> : null}
          {load.s === "loading" ? (
            <Loading hostName={p.hostName} slow={load.slow} />
          ) : empty ? (
            <Empty title={p.title} onLinkedFrom={p.onLinkedFrom} />
          ) : v && ready ? (
            mode === "list" ? (
              <div className="gr-list ph">
                <PhoneList v={v} tones={tones} current={p.fileId} onPick={setSheet} />
              </div>
            ) : (
              <div className="gr-gv">
                <GraphCanvas
                  v={v}
                  f={f}
                  tones={tones}
                  now={ready.now}
                  label={`Local graph of ${p.title}`}
                  current={p.fileId}
                  center={p.fileId}
                  bigDeg={1}
                  maxFit={1.6}
                  pad={30}
                  charge={420}
                  len={92}
                  pins={pins}
                  onPins={setPins}
                  card={p.compact ? "sheet" : "card"}
                  legend="kinds"
                  onOpen={open}
                  onSelect={p.compact ? setSheet : undefined}
                  onList={p.compact ? () => setMode("list") : undefined}
                />
              </div>
            )
          ) : null}
          {sheet && v && ready ? <Sheet id={sheet} v={v} tones={tones} now={ready.now} onOpen={() => open(sheet)} onClose={() => setSheet(null)} /> : null}
          <div className="gr-sf">
            <span className="gr-stat">{v ? `${canv} ${canv === 1 ? "canvas" : "canvases"} · ${links} ${links === 1 ? "link" : "links"}` : ""}</span>
            <span className="grow" />
            {p.onFull ? (
              <button type="button" className="gr-btn" onClick={p.onFull}>
                <Maximize size={15} aria-hidden="true" />
                Open full graph
              </button>
            ) : null}
          </div>
        </>
      )}
    </aside>
  );
}

// ---------- the full graph (1a, 2a, 2b, 4a, 5a-5c, 6d) ----------

function FullGraph(p: GraphRootProps) {
  const [f, setF] = useState<Filters>(defaults);
  const set = (x: Partial<Filters>) => setF((o) => ({ ...o, ...x }));
  const [mode, setMode] = useState<"graph" | "list">(p.compact ? "list" : "graph");
  const [root, setRoot] = useState<{ id: string; depth: number } | null>(null);
  const [filters, setFilters] = useState(false);
  const [sheet, setSheet] = useState<string | null>(null);
  const { load, retry } = useGraph(p.ticket, true, 1, f.blocks);
  const [pins, setPins] = usePins(p.userId, "full");
  const ready = load.s === "ready" ? load : null;
  const tones = useMemo(() => spaceTones(ready?.data.nodes ?? []), [ready]);
  const v = useMemo(() => (ready ? makeView(ready.data, f, ready.now, { current: p.fileId, root: root?.id, depth: root?.depth }) : null), [ready, f, p.fileId, root]);
  const list = useRows(v ?? EMPTY);
  const searchRef = useRef<HTMLInputElement>(null);
  const graphApi = useRef<{ focus(): void; select(id: string | null): void } | null>(null);
  const dlg = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(null);

  useEffect(() => {
    back.current = document.activeElement;
    dlg.current?.querySelector<HTMLElement>(".gr-x")?.focus();
    return () => (back.current as HTMLElement | null)?.focus?.();
  }, []);

  const open = (id: string) => {
    const [fid, bid] = target(v?.byId.get(id), id);
    p.open(fid, bid);
    if (fid === p.fileId) p.onClose();
  };
  const switchTo = (m: "graph" | "list") => {
    setMode(m);
    setSheet(null);
    window.setTimeout(() => (m === "graph" ? graphApi.current?.focus() : dlg.current?.querySelector<HTMLElement>(".gr-table th button, .gr-pli")?.focus()), 0);
  };
  const slash = () => (p.compact ? setFilters(true) : searchRef.current?.focus());
  const canv = v ? v.nodes.filter((n) => n.kind === "canvas").length : 0;
  const links = v ? v.edges.filter((e) => e.k !== "in").length : 0;
  const blocksN = v ? v.nodes.length - canv : 0;
  const counts = useMemo(() => spaceCounts(ready?.data.nodes ?? [], tones), [ready, tones]);
  const owners = !!ready?.data.nodes.some((n) => n.updatedBy);
  const rootTitle = root ? v?.byId.get(root.id)?.title ?? "" : "";
  const status = !v ? "" : v.matches ? `${[...v.matches].filter((id) => v.byId.get(id)?.kind === "canvas").length} of ${canv} match` : `${canv} ${canv === 1 ? "canvas" : "canvases"} · ${links} ${links === 1 ? "link" : "links"}${blocksN ? ` · ${blocksN} ${blocksN === 1 ? "block" : "blocks"}` : ""}`;

  const download = () => {
    const blob = new Blob([csv(list.rows)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "graph.csv";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const panel = <FilterPanel f={f} set={set} counts={counts} owners={owners} hostName={p.hostName} search={searchRef} />;
  const body =
    load.s === "loading" ? (
      <Loading hostName={p.hostName} slow={load.slow} />
    ) : load.s === "error" ? (
      <Problem e={load.e} hostName={p.hostName} retry={retry} toast={p.toast} />
    ) : v && ready ? (
      !canv ? (
        <div className="gr-est">
          <div>
            <h4>Nothing to show</h4>
            <p>No canvas you can open matches these filters.</p>
            <button type="button" className="gr-btn" onClick={() => (setF(defaults()), setRoot(null))}>
              Reset filters
            </button>
          </div>
        </div>
      ) : mode === "list" ? (
        <div className={"gr-list" + (p.compact ? " ph" : "")}>
          {p.compact ? <PhoneList v={v} tones={tones} current={p.fileId} onPick={setSheet} /> : <GraphList v={v} tones={tones} now={ready.now} current={p.fileId} rows={list.rows} sort={list.sort} setSort={list.setSort} onOpen={open} />}
        </div>
      ) : (
        <div className="gr-gv">
          <GraphCanvas
            v={v}
            f={f}
            tones={tones}
            now={ready.now}
            label={`Graph of ${p.hostName} canvases`}
            current={p.fileId}
            center={root?.id ?? null}
            bigDeg={p.compact ? 99 : 4}
            pad={p.compact ? 18 : 36}
            pins={pins}
            onPins={setPins}
            card={p.compact ? "sheet" : "card"}
            legend={p.compact ? false : "full"}
            onOpen={open}
            onLocal={(id) => setRoot({ id, depth: 1 })}
            onSelect={p.compact ? setSheet : undefined}
            onSlash={slash}
            onList={() => switchTo("list")}
            api={graphApi}
          />
        </div>
      )
    ) : null;

  return (
    <div
      className={"gr-full" + (p.compact ? " ph" : "")}
      role="dialog"
      aria-modal="true"
      aria-label="Graph"
      ref={dlg}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          if (filters) setFilters(false);
          else p.onClose();
        }
        // aria-modal: Tab stays inside the dialog.
        if (e.key === "Tab" && dlg.current) {
          const all = [...dlg.current.querySelectorAll<HTMLElement>('button:not([disabled]), input, [tabindex="0"]')].filter((x) => x.offsetParent !== null || x instanceof SVGElement);
          const first = all[0],
            last = all[all.length - 1];
          if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last?.focus());
          else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first?.focus());
        }
      }}
    >
      <div className="gr-top">
        {p.compact ? (
          <>
            <button type="button" className="gr-ib big gr-x" aria-label="Back" onClick={p.onClose}>
              <ChevronLeft size={20} aria-hidden="true" />
            </button>
            <h2 className="gr-h">Graph</h2>
            <button type="button" className="gr-ib big" aria-label="Filters" aria-expanded={filters} onClick={() => setFilters(true)}>
              <Filter size={18} aria-hidden="true" />
            </button>
          </>
        ) : (
          <>
            <span className="gr-crumbs">
              <span className="par">{p.hostName}</span>
              <span className="sep">/</span>
              <span className="gr-tile tone-gray" aria-hidden="true">
                <Share2 size={13} />
              </span>
              <h2 className="gr-h">Graph</h2>
            </span>
            <span className="grow" />
            <Seg
              label="View"
              value={mode}
              items={[
                ["graph", "Graph"],
                ["list", "List"],
              ]}
              set={(m) => switchTo(m as "graph" | "list")}
            />
            <button type="button" className="gr-ib gr-x" aria-label="Close graph" onClick={p.onClose}>
              <X size={18} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
      {p.compact ? (
        <Seg
          label="View"
          className="gr-pseg"
          value={mode}
          items={[
            ["list", "List"],
            ["graph", "Graph"],
          ]}
          set={(m) => switchTo(m as "graph" | "list")}
        />
      ) : null}
      {ready && v ? (
        <Banner data={ready.data} drawn={canv}>
          <button type="button" className="gr-btn" onClick={() => (p.compact ? setFilters(true) : dlg.current?.querySelector<HTMLElement>(".gr-fp input[type=checkbox]")?.focus())}>
            Pick spaces
          </button>
          <button type="button" className="gr-btn" onClick={() => setRoot({ id: p.fileId, depth: 2 })}>
            Local graph of {p.title}
          </button>
        </Banner>
      ) : null}
      <div className="gr-body">
        {p.compact ? null : (
          <aside className="gr-fp" aria-label="Filters">
            {panel}
          </aside>
        )}
        <div className="gr-main">
          <div className="gr-tb">
            <span className="gr-stat" role="status">
              {status}
            </span>
            {root ? (
              <span className="gr-loc">
                <Crosshair size={13} aria-hidden="true" />
                Around {rootTitle}, depth {root.depth}
                <button type="button" aria-label="Show the whole graph" onClick={() => setRoot(null)}>
                  <X size={13} aria-hidden="true" />
                </button>
              </span>
            ) : null}
            <span className="grow" />
            {pins.size && mode === "graph" ? (
              <span className="gr-stat">
                <Pin size={13} aria-hidden="true" />
                {pins.size} pinned
              </span>
            ) : null}
            {mode === "list" && !p.compact ? (
              <button type="button" className="gr-btn" onClick={download}>
                <Download size={15} aria-hidden="true" />
                CSV
              </button>
            ) : null}
            <button type="button" className={"gr-btn" + (f.blocks ? " on" : "")} aria-pressed={f.blocks} onClick={() => set({ blocks: !f.blocks })}>
              <Layers size={15} aria-hidden="true" />
              Blocks
            </button>
            {p.onLinkedFrom && !p.compact ? (
              <button type="button" className="gr-btn" onClick={() => (p.onClose(), p.onLinkedFrom!())}>
                <Link2 size={15} aria-hidden="true" />
                Linked from
              </button>
            ) : null}
          </div>
          {body}
        </div>
      </div>
      {sheet && v && ready ? <Sheet id={sheet} v={v} tones={tones} now={ready.now} onOpen={() => open(sheet)} onLocal={() => (setRoot({ id: sheet, depth: 1 }), setSheet(null), switchTo("graph"))} onClose={() => setSheet(null)} /> : null}
      {filters && p.compact ? (
        <>
          <div className="gr-scrim" onClick={() => setFilters(false)} />
          <div className="gr-sheet gr-fsheet" role="dialog" aria-label="Filters">
            <div className="grab" />
            <div className="gr-fsh">
              <b>Filters</b>
              <span className="grow" />
              <button type="button" className="gr-btn" onClick={() => setF(defaults())}>
                Reset
              </button>
            </div>
            {panel}
            <button type="button" className="gr-btn pri wide" onClick={() => setFilters(false)}>
              <List size={16} aria-hidden="true" />
              Show {canv} {canv === 1 ? "canvas" : "canvases"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

const EMPTY: View = { nodes: [], edges: [], byId: new Map(), nb: new Map(), matches: null };
