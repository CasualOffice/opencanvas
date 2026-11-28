// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Pieces of the knowledge graph (GRAPH-02/03), to docs/prototypes/v05-approved/knowledge-graph.html:
// the graph with its card, legend and zoom (1a, 1b, 3a-3c, 5a), the filter panel (2a, 2b, 5c),
// the sortable list (4a) and the phone list (5b).
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight, Crosshair, FileText, Hash, Lock, Maximize, Minus, Pin, Plus, Search } from "lucide-react";
import { Engine } from "./engine";
import { BUCKETS, ago, canvasOf, colourOf, linksIn, listRows, neighbours, NO_SPACE, ownerColour, sortRows, spaceOf, type Colour, type Filters, type LinkKind, type Row, type SortKey, type View, type VNode } from "./model";

export const KINDS: [LinkKind, string, string][] = [
  ["link", "Links", "Link"],
  ["embed", "Live blocks", "Live block"],
  ["relation", "Relations", "Relation"],
];

export const LineSwatch = ({ k }: { k: string }) => (
  <svg className="gr-ls" viewBox="0 0 22 6" aria-hidden="true">
    <line className={"k-" + k} x1="1" y1="3" x2="21" y2="3" />
  </svg>
);

export function Tile({ n, tones }: { n: VNode; tones: Map<string, string> }) {
  return (
    <span className={`gr-tile tone-${tones.get(spaceOf(n)) ?? "gray"}`} aria-hidden="true">
      {n.kind === "block" ? <Hash size={13} /> : <FileText size={13} />}
    </span>
  );
}

// ---------- the graph ----------

export interface CanvasProps {
  v: View;
  f: Filters;
  tones: Map<string, string>;
  now: number;
  label: string;
  current: string | null;
  center?: string | null;
  bigDeg?: number;
  maxFit?: number;
  pad?: number;
  charge?: number;
  len?: number;
  pins: Map<string, [number, number]>;
  onPins(p: Map<string, [number, number]>): void;
  /** Hover cards and selection cards (desktop); "sheet" hands the selection to the caller (phone). */
  card: "card" | "sheet";
  legend: "full" | "kinds" | false;
  onOpen(id: string): void;
  onLocal?: (id: string) => void;
  onSelect?: (id: string | null) => void;
  onSlash?: () => void;
  onList?: () => void;
  /** Lets the caller focus the graph or select a node. */
  api?: React.MutableRefObject<{ focus(): void; select(id: string | null): void } | null>;
}

export function GraphCanvas(p: CanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const eng = useRef<Engine | null>(null);
  const cardEl = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [pinned, setPinned] = useState(0);
  const live = useRef(p);
  live.current = p;
  const placeCard = useRef(() => {});
  placeCard.current = () => {
    const c = cardEl.current,
      e = eng.current,
      h = host.current;
    const id = c?.dataset.id;
    if (!c || !e || !h || !id) return;
    const s = e.screenOf(id);
    if (!s) return;
    const W = h.clientWidth,
      H = h.clientHeight,
      cw = c.offsetWidth,
      ch = c.offsetHeight,
      gap = 14;
    let x = s.x + s.r + gap;
    if (x + cw > W - 8) x = s.x - s.r - gap - cw;
    x = Math.max(8, x);
    const y = Math.max(8, Math.min(H - ch - 8, s.y - ch * 0.35));
    c.style.left = `${x}px`;
    c.style.top = `${y}px`;
  };

  useEffect(() => {
    const e = new Engine(host.current!, {
      label: p.label,
      current: p.current,
      center: p.center ?? null,
      bigDeg: p.bigDeg ?? 4,
      maxFit: p.maxFit ?? 1.8,
      pad: p.pad ?? 36,
      charge: p.charge,
      len: p.len,
      pins: new Map(p.pins),
      onPins: (m) => (live.current.onPins(m), setPinned((n) => n + 1)),
      onHover: setHover,
      onSelect: (id) => (setSel(id), live.current.onSelect?.(id)),
      onOpen: (id) => live.current.onOpen(id),
      onKey: (k) => (k === "slash" ? live.current.onSlash?.() : live.current.onList?.()),
      onFrame: () => placeCard.current(),
      say: (t) => {
        // Cleared first, so the same words twice are read twice.
        setSaid("");
        window.setTimeout(() => setSaid(t), 30);
      },
    });
    eng.current = e;
    if (p.api) p.api.current = { focus: () => e.focus(), select: (id) => e.select(id) };
    return () => {
      e.destroy();
      eng.current = null;
      if (p.api) p.api.current = null;
    };
    // The engine lives as long as the panel; its options change through setView below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    eng.current?.setView(p.v, (n) => colourOf(n, p.f.colour, p.tones, p.now), p.center ?? null);
  }, [p.v, p.f.colour, p.tones, p.now, p.center]);

  const cardId = p.card === "card" ? hover ?? sel : null;
  useLayoutEffect(() => placeCard.current());

  const n = cardId ? p.v.byId.get(cardId) : null;
  const act = !!n && (!hover || hover === sel);
  return (
    <div className="gr-wrap" ref={host}>
      <svg width="0" height="0" className="gr-defs" aria-hidden="true">
        <defs>
          <marker id="gr-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M0 1 L10 5 L0 9z" />
          </marker>
        </defs>
      </svg>
      {n ? (
        <div ref={cardEl} data-id={n.id} className={"gr-card" + (act ? " act" : "")} role={act ? "dialog" : undefined} aria-label={act ? n.title : undefined} key={n.id + pinned}>
          <NodeCard n={n} v={p.v} tones={p.tones} now={p.now} />
          {act ? (
            <div className="gr-ca">
              <button type="button" className="gr-btn pri" onClick={() => p.onOpen(n.id)}>
                <ArrowUpRight size={15} aria-hidden="true" />
                Open
              </button>
              {p.onLocal && n.kind === "canvas" ? (
                <button type="button" className="gr-btn" onClick={() => p.onLocal!(n.id)}>
                  <Crosshair size={15} aria-hidden="true" />
                  Local graph
                </button>
              ) : null}
              <button type="button" className="gr-btn" aria-pressed={eng.current?.isPinned(n.id) ?? false} onClick={() => eng.current?.togglePin(n.id)}>
                <Pin size={15} aria-hidden="true" />
                {eng.current?.isPinned(n.id) ? "Unpin" : "Pin"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite">
        {said}
      </div>
      {p.legend ? <Legend f={p.f} v={p.v} tones={p.tones} kindsOnly={p.legend === "kinds"} /> : null}
      <div className="gr-zoom" role="group" aria-label="Zoom">
        <button type="button" className="gr-ib" aria-label="Zoom in" title="Zoom in (+)" onClick={() => eng.current?.zoomBy(1.25)}>
          <Plus size={16} aria-hidden="true" />
        </button>
        <button type="button" className="gr-ib" aria-label="Zoom out" title="Zoom out (−)" onClick={() => eng.current?.zoomBy(1 / 1.25)}>
          <Minus size={16} aria-hidden="true" />
        </button>
        <button type="button" className="gr-ib" aria-label="Fit graph" title="Fit (F)" onClick={() => eng.current?.fit()}>
          <Maximize size={16} aria-hidden="true" />
        </button>
        <button type="button" className="gr-ib" aria-label="Unpin all" title="Unpin all" disabled={!p.pins.size} onClick={() => eng.current?.unpinAll()}>
          <Pin size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** The card's body (3b canvas, 3c block); also the phone sheet's head. */
export function NodeCard({ n, v, tones, now }: { n: VNode; v: View; tones: Map<string, string>; now: number }) {
  const x = neighbours(v, n.id);
  const titles = (ids: string[]) => ids.map((id) => v.byId.get(id)?.title ?? "").filter(Boolean);
  const from = titles(x.from);
  const when = ago(n.updatedAt, now);
  const parent = n.kind === "block" ? v.byId.get(n.fileId)?.title : null;
  return (
    <>
      <div className="gr-ct">
        <Tile n={n} tones={tones} />
        <span>{n.title}</span>
      </div>
      <div className="gr-cp">{n.kind === "block" ? `Block in ${parent ?? "a canvas"}` : n.path || spaceOf(n)}</div>
      {when ? (
        <div className="gr-cm">
          {n.updatedBy ? (
            <span className="gr-av" style={{ background: ownerColour(n.updatedBy) }} aria-hidden="true">
              {initials(n.updatedBy)}
            </span>
          ) : null}
          Updated {when}
          {n.updatedBy ? ` by ${n.updatedBy}` : ""}
        </div>
      ) : null}
      <div className="gr-cs">
        <span className="gr-pill">{linksIn(n.in)}</span>
        {n.kind === "canvas" ? <span className="gr-pill">{n.out} out</span> : null}
      </div>
      {from.length ? (
        <div className="gr-cx">
          Linked from <b>{from.slice(0, 3).join(", ")}</b>
          {from.length > 3 ? ` and ${from.length - 3} more` : ""}
        </div>
      ) : null}
    </>
  );
}

const initials = (s: string) =>
  s
    .trim()
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();

function Legend({ f, v, tones, kindsOnly }: { f: Filters; v: View; tones: Map<string, string>; kindsOnly: boolean }) {
  const spaces = useMemo(() => [...new Set(v.nodes.filter((n) => n.kind === "canvas").map(spaceOf))].sort((a, b) => [...tones.keys()].indexOf(a) - [...tones.keys()].indexOf(b)).slice(0, 8), [v, tones]);
  const owners = useMemo(() => [...new Set(v.nodes.map((n) => n.updatedBy).filter((x): x is string => !!x))].slice(0, 6), [v]);
  const kinds = KINDS.filter(([k]) => f.kinds.has(k) && v.edges.some((e) => e.k === k));
  return (
    <div className="gr-lg" aria-hidden="true">
      {kindsOnly ? null : (
        <div className="r">
          {f.colour === "updated"
            ? BUCKETS.map(([b, l, c]) => (
                <span key={b}>
                  <i className="gr-dot" style={{ background: c }} />
                  {l}
                </span>
              ))
            : f.colour === "owner"
              ? owners.map((o) => (
                  <span key={o}>
                    <i className="gr-dot" style={{ background: ownerColour(o) }} />
                    {o.split(" ")[0]}
                  </span>
                ))
              : spaces.map((s) => (
                  <span key={s}>
                    <i className="gr-dot" style={{ background: `var(--${tones.get(s) ?? "gray"}-fg)` }} />
                    {s}
                  </span>
                ))}
        </div>
      )}
      {kinds.length || f.blocks ? (
        <div className="r">
          {kinds.map(([k, , one]) => (
            <span key={k}>
              <LineSwatch k={k} />
              {one}
            </span>
          ))}
          {f.blocks ? (
            <span>
              <i className="gr-bsq" />
              Block
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------- filters (2a, 5c) ----------

export function FilterPanel({ f, set, counts, owners, hostName, search }: { f: Filters; set(p: Partial<Filters>): void; counts: [string, number, string][]; owners: boolean; hostName: string; search?: React.Ref<HTMLInputElement> }) {
  const uid = useId();
  const toggle = <T,>(s: Set<T>, x: T, on: boolean) => {
    const n = new Set(s);
    if (on) n.add(x);
    else n.delete(x);
    return n;
  };
  return (
    <>
      <div className="gr-inp">
        <Search size={15} aria-hidden="true" />
        <input ref={search} type="search" aria-label="Search canvases" placeholder="Search canvases" value={f.search} onChange={(e) => set({ search: e.target.value })} />
        <kbd aria-hidden="true">/</kbd>
      </div>
      <h3 className="gr-fh" id={uid + "s"}>Spaces</h3>
      <div role="group" aria-labelledby={uid + "s"}>
        {counts.map(([s, n, tone]) => (
          <label className="gr-ck" key={s}>
            <input type="checkbox" checked={!f.spaces || f.spaces.has(s)} onChange={(e) => set({ spaces: toggle(f.spaces ?? new Set(counts.map((c) => c[0])), s, e.target.checked) })} />
            <i className="gr-dot" style={{ background: `var(--${tone}-fg)` }} aria-hidden="true" />
            {s}
            <span className="n">{n}</span>
          </label>
        ))}
      </div>
      <h3 className="gr-fh" id={uid + "k"}>Links</h3>
      <div role="group" aria-labelledby={uid + "k"}>
        {KINDS.map(([k, l]) => (
          <label className="gr-ck" key={k}>
            <input type="checkbox" checked={f.kinds.has(k)} onChange={(e) => set({ kinds: toggle(f.kinds, k, e.target.checked) })} />
            <LineSwatch k={k} />
            {l}
          </label>
        ))}
      </div>
      <h3 className="gr-fh">Show</h3>
      <Switch label="Blocks" on={f.blocks} set={(blocks) => set({ blocks })} />
      <Switch label="Orphans" on={f.orphans} set={(orphans) => set({ orphans })} />
      <h3 className="gr-fh" id={uid + "w"}>Updated within</h3>
      <Seg
        label="Updated within"
        value={String(f.within)}
        items={[
          ["0", "Any time"],
          ["30", "30 days"],
          ["7", "7 days"],
        ]}
        set={(w) => set({ within: Number(w) })}
      />
      <h3 className="gr-fh">Colour by</h3>
      <Seg
        label="Colour by"
        value={f.colour}
        items={[["space", "Space"], ["updated", "Updated"], ...(owners ? [["owner", "Owner"] as [string, string]] : [])]}
        set={(c) => set({ colour: c as Colour })}
      />
      <p className="gr-ft">
        <Lock size={13} aria-hidden="true" />
        <span>Only canvases you can open in {hostName} are shown.</span>
      </p>
    </>
  );
}

export function Switch({ label, on, set }: { label: string; on: boolean; set(v: boolean): void }) {
  const id = useId();
  return (
    <div className="gr-tg">
      <span id={id}>{label}</span>
      <button type="button" className="gr-sw" role="switch" aria-checked={on} aria-labelledby={id} onClick={() => set(!on)} />
    </div>
  );
}

export function Seg({ label, value, items, set, className }: { label: string; value: string; items: [string, string][]; set(v: string): void; className?: string }) {
  return (
    <div className={"gr-seg" + (className ? " " + className : "")} role="group" aria-label={label}>
      {items.map(([v, l]) => (
        <button type="button" key={v} aria-pressed={value === v} onClick={() => set(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** Spaces with their canvas counts and tones, for the filter panel. */
export function spaceCounts(nodes: { kind: string; space: string | null }[], tones: Map<string, string>): [string, number, string][] {
  const n = new Map<string, number>();
  for (const x of nodes) if (x.kind === "canvas") n.set(x.space || NO_SPACE, (n.get(x.space || NO_SPACE) ?? 0) + 1);
  return [...tones.keys()].filter((s) => n.has(s)).map((s) => [s, n.get(s)!, tones.get(s)!]);
}

// ---------- the list (4a) ----------

const COLS: [SortKey, string, boolean][] = [
  ["title", "Canvas", false],
  ["space", "Space", false],
  ["in", "Links in", true],
  ["out", "Links out", true],
  ["from", "Linked from", false],
  ["updated", "Updated", false],
];

export function useRows(v: View) {
  const [sort, setSort] = useState<{ k: SortKey; dir: "asc" | "desc" }>({ k: "in", dir: "desc" });
  const rows = useMemo(() => sortRows(listRows(v), sort.k, sort.dir), [v, sort]);
  return { rows, sort, setSort };
}

export function GraphList({ v, tones, now, current, rows, sort, setSort, onOpen }: { v: View; tones: Map<string, string>; now: number; current: string | null; rows: Row[]; sort: { k: SortKey; dir: "asc" | "desc" }; setSort(s: { k: SortKey; dir: "asc" | "desc" }): void; onOpen(id: string): void }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const title = (id: string) => v.byId.get(id)?.title ?? "";
  const chips = (ids: string[]) =>
    ids.length ? (
      ids.map((id) => (
        <button type="button" className="gr-chip" key={id} onClick={() => onOpen(id)}>
          {title(id)}
        </button>
      ))
    ) : (
      <span className="gr-hint">Nothing</span>
    );
  return (
    <table className="gr-table">
      <caption className="sr-only">
        Canvases you can open and their links, {rows.length} {rows.length === 1 ? "row" : "rows"}
      </caption>
      <thead>
        <tr>
          {COLS.map(([k, l, num]) => (
            <th key={k} scope="col" className={num ? "num" : undefined} aria-sort={sort.k === k ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
              <button type="button" onClick={() => setSort(sort.k === k ? { k, dir: sort.dir === "asc" ? "desc" : "asc" } : { k, dir: k === "title" || k === "space" ? "asc" : "desc" })}>
                {l}
                <ChevronDown size={13} aria-hidden="true" />
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const ex = open.has(r.id);
          const n = v.byId.get(r.id)!;
          return [
            <tr key={r.id} className={r.id === current ? "cur" : undefined}>
              <td>
                <button
                  type="button"
                  className="gr-xb"
                  aria-expanded={ex}
                  onClick={() =>
                    setOpen((s) => {
                      const x = new Set(s);
                      if (ex) x.delete(r.id);
                      else x.add(r.id);
                      return x;
                    })
                  }
                >
                  <ChevronRight size={14} className="chev" aria-hidden="true" />
                  <Tile n={n} tones={tones} />
                  {r.title}
                  {r.id === current ? <span className="sr-only"> (this canvas)</span> : null}
                </button>
              </td>
              <td>
                <span className={`gr-pill tone-${tones.get(r.space) ?? "gray"}`}>{r.space}</span>
              </td>
              <td className="num">{r.in}</td>
              <td className="num">{r.out}</td>
              <td className="dim">{r.from.length ? r.from.slice(0, 2).map(title).join(", ") + (r.from.length > 2 ? ` +${r.from.length - 2}` : "") : "–"}</td>
              <td className="dim nw">{ago(r.updatedAt, now) || "–"}</td>
            </tr>,
            ex ? (
              <tr key={r.id + ":x"} className="ex">
                <td colSpan={6}>
                  <div className="gr-nbl">
                    <span className="lab">Links to</span>
                    {chips(r.to)}
                  </div>
                  <div className="gr-nbl">
                    <span className="lab">Linked from</span>
                    {chips(r.from)}
                  </div>
                  <div className="gr-nbl">
                    <span className="lab" />
                    <button type="button" className="gr-btn" onClick={() => onOpen(r.id)}>
                      <ArrowUpRight size={14} aria-hidden="true" />
                      Open {r.title}
                    </button>
                  </div>
                </td>
              </tr>
            ) : null,
          ];
        })}
      </tbody>
    </table>
  );
}

/** 5b: the phone list, most linked first; a tap opens the sheet. */
export function PhoneList({ v, tones, current, onPick }: { v: View; tones: Map<string, string>; current: string | null; onPick(id: string): void }) {
  const rows = useMemo(() => listRows(v).sort((a, b) => b.in + b.out - (a.in + a.out) || a.title.localeCompare(b.title)), [v]);
  return (
    <>
      <div className="gr-pls">
        <span>Most linked first</span>
        <span className="grow" />
        <span>
          {rows.length} {rows.length === 1 ? "canvas" : "canvases"}
        </span>
      </div>
      <ul className="gr-pl">
        {rows.map((r) => (
          <li key={r.id}>
            <button type="button" className={"gr-pli" + (r.id === current ? " cur" : "")} onClick={() => onPick(r.id)}>
              <Tile n={v.byId.get(r.id)!} tones={tones} />
              <span className="mn">
                <span className="t">{r.title}</span>
                <span className="s">
                  <i className="gr-dot sm" style={{ background: `var(--${tones.get(r.space) ?? "gray"}-fg)` }} aria-hidden="true" />
                  {r.space} · {r.in} in · {r.out} out
                </span>
              </span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The canvas id to open for a node (a block opens its canvas at the block). */
export const target = (n: VNode | undefined, id: string): [string, string | null] => (n?.kind === "block" ? [n.fileId, n.blockId ?? null] : [canvasOf(id), null]);
