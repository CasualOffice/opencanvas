// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Shapes panel (DGM-14 S2, frames 2a-2h): libraries from the registry, recent, search, click or
// drag to add, connector presets, BPMN behind a host flag, the collapsed rail with flyouts, and the
// Shapes / Outline tabs. Every tile is registry data (libraries.ts); nothing here defines a shape.
// The Icons library (DGM-17, frames 1a-1e): built-in generic icons (icons.ts), searched with the
// shapes; a product we ship no logo for gets Add your own icon and generic alternatives.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as RKE, type ReactNode } from "react";
import {
  Boxes, ChartColumn, ChevronRight, GitBranch, House, MoveRight, Server, TriangleAlert, Zap, GitFork, History, LayoutTemplate, Library as LibraryIcon, ListTree, Network, PanelLeftClose, PanelLeftOpen, Search, Settings2, ImagePlus, Shapes as ShapesIcon, Square, Table, Upload, Users, Workflow, X, type LucideIcon,
} from "lucide-react";
import { HEADS } from "../heads";
import { KIND_MIME, LIBRARIES } from "../libraries";
import { librariesVersion, loadLibrary, panelLibraries, PRESET, presetOf, subscribeLibraries, type PanelLibrary } from "../panel";
import { descriptorOf, type ResolvedDescriptor } from "../registry";
import { AllIcons, LucideResults, useLucideIndex } from "./AllIcons";
import { lucidePaths, searchLucide } from "../lucide";
import { useDocIcons } from "../iconsContext";
import { DOC_PREFIX, searchDocIcons, type DocIcon } from "../icons";
import { GENERIC_ICONS, ICON_CATEGORIES, ICON_KIND, ICON_MIME, iconById, searchIcons, suggestIcons, toneOf, type GenericIcon, type IconHit } from "../icons";

/** Adds a shape of `kind`; for `icon:node`, `icon` is the icon's id (and a Lucide icon's `paths`). */
export type AddShape = (kind: string, icon?: string, paths?: readonly string[]) => void;

const SW = 1.75;
const ICONS: Record<string, LucideIcon> = {
  workflow: Workflow, boxes: Boxes, network: Network, table: Table, "git-fork": GitFork, shapes: ShapesIcon, square: Square,
  "layout-template": LayoutTemplate, "git-branch": GitBranch, users: Users,
  "move-right": MoveRight, "triangle-alert": TriangleAlert, house: House, zap: Zap, server: Server, "chart-column": ChartColumn,
};
const HIDDEN_KEY = "oc-diagram-libraries-hidden";
const OPEN_KEY = "oc-diagram-libraries-open";
const RECENT_KEY = "oc-diagram-recent";
const RAIL_KEY = "oc-diagram-rail";
const RECENT_MAX = 6;

/** Host / administrator switches for the panel (BPMN is off unless the host turns it on, 2f). */
export interface PanelFlags {
  bpmn?: boolean;
}

const descOf = (kind: string) => descriptorOf({ type: "rect", kind });
const isPreset = (k: string) => k.startsWith(PRESET);
const labelOf = (k: string) => (isPreset(k) ? (presetOf(k)?.label ?? k) : (descOf(k).label ?? k));
const keywordsOf = (k: string) => (isPreset(k) ? (presetOf(k)?.keywords ?? []) : (descOf(k).keywords ?? []));
/** A library's tiles: its shapes, then its connector presets. */
const entries = (l: PanelLibrary) => [...l.kinds, ...(l.connectors ?? []).map((c) => PRESET + c)];

function load<T>(key: string, dflt: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    if (v !== null && typeof v === typeof dflt) return v as T;
  } catch {
    /* private window, blocked storage */
  }
  return dflt;
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* per-viewer convenience only */
  }
}

/** The libraries this person sees: BPMN only when the host's flag is on. */
/** The libraries this person may use: BPMN only when the host's flag is on (2f). */
export const availableLibraries = (flags: PanelFlags = {}) =>
  panelLibraries().filter((l) => !l.flag || flags[l.flag] || LIBRARIES.some((x) => x.id === l.id));
/** Those, minus the ones this person hid with the Libraries chooser. */
export const shownLibraries = (flags: PanelFlags = {}, hidden: readonly string[] = []) => availableLibraries(flags).filter((l) => !hidden.includes(l.id));

/** Re-render when a library is registered or loaded. */
const useLibrariesVersion = () => useSyncExternalStore(subscribeLibraries, librariesVersion, librariesVersion);

export interface Hit {
  kind: string;
  library: string;
  /** Where the label matched ([start, end)), or the keyword that matched. */
  at?: [number, number];
  keyword?: string;
  score: number;
}

/** Search the libraries, best match first (2d); the panel groups the hits by library. */
interface IndexEntry {
  kind: string;
  library: string;
  label: string;
  keywords: string[];
  order: number;
}
/** Lower-cased labels and keywords of every tile, built once per set of libraries. */
export function searchIndex(libs: readonly PanelLibrary[]): IndexEntry[] {
  const out: IndexEntry[] = [];
  libs.forEach((l, li) =>
    entries(l).forEach((kind, ki) => out.push({ kind, library: l.id, label: labelOf(kind).toLowerCase(), keywords: keywordsOf(kind).map((w) => w.toLowerCase()), order: li * 1000 + ki })),
  );
  return out;
}

/** Search the libraries, best match first (2d); the panel groups the hits by library. */
export function searchShapes(q: string, index: readonly IndexEntry[] = searchIndex(shownLibraries())): Hit[] {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const out: Hit[] = [];
  for (const e of index) {
    const i = e.label.indexOf(t);
    if (i >= 0) {
      out.push({ kind: e.kind, library: e.library, at: [i, i + t.length], score: (i === 0 ? 0 : 1) * 1e6 + e.order });
      continue;
    }
    const k = e.keywords.findIndex((w) => w.includes(t));
    if (k >= 0) out.push({ kind: e.kind, library: e.library, keyword: keywordsOf(e.kind)[k], score: (e.keywords[k].startsWith(t) ? 2 : 3) * 1e6 + e.order });
  }
  return out.sort((a, b) => a.score - b.score);
}

/** A small drawing of the kind: its outline path or its base type. */
export function Preview({ d }: { d: ResolvedDescriptor }) {
  const w = d.look?.w ?? (d.base === "sticky" ? 150 : 140), h = d.look?.h ?? (d.base === "sticky" ? 110 : 70);
  // Drawn in a 32 × 24 box: the outline stays readable at 24 px (non-scaling strokes). It is
  // scaled from what it actually draws (its bounding box, in the 0..100 drawing units), so a small
  // control fills the tile and an outline that reaches past its box is not clipped (UX-DGM-01).
  const ref = useRef<SVGGElement>(null);
  const [bb, setBb] = useState<[number, number, number, number]>([0, 0, 100, 100]);
  useLayoutEffect(() => {
    const g = ref.current;
    if (!g || typeof g.getBBox !== "function") return;
    try {
      const r = g.getBBox();
      if (r.width > 0 || r.height > 0) setBb((o) => (o[0] === r.x && o[1] === r.y && o[2] === r.width && o[3] === r.height ? o : [r.x, r.y, r.width, r.height]));
    } catch {
      // Not rendered (display:none): keep the shape's box.
    }
  }, [d.kind]);
  const ax = w / 100, ay = h / 100;
  const k = Math.min(30 / Math.max(bb[2] * ax, 1e-6), 22 / Math.max(bb[3] * ay, 1e-6));
  const sx = ax * k, sy = ay * k;
  const ox = 16 - (bb[0] + bb[2] / 2) * sx, oy = 12 - (bb[1] + bb[3] / 2) * sy;
  const tone = d.look?.tone ?? (d.base === "sticky" ? "amber" : undefined);
  const common = { fill: tone ? `var(--${tone}-bg)` : "var(--app)", stroke: tone ? `var(--${tone}-fg)` : "var(--fg-2)", strokeWidth: 1.25, vectorEffect: "non-scaling-stroke" as const, strokeLinejoin: "round" as const };
  if (d.base === "text") {
    return (
      <svg className="ocdg-pv" width={32} height={24} viewBox="0 0 32 24" aria-hidden="true">
        <text x={16} y={18} textAnchor="middle" fontSize={15} fontWeight={600} fill="var(--fg-2)">T</text>
      </svg>
    );
  }
  return (
    <svg className="ocdg-pv" width={32} height={24} viewBox="0 0 32 24" aria-hidden="true">
      <g ref={ref} transform={`translate(${ox} ${oy}) scale(${sx} ${sy})`}>
        {d.look?.icon && iconById(d.look.icon) ? (
          <>
            <rect width={100} height={100} rx={12} {...common} />
            <g transform="translate(6 25) scale(2.1 2.1)">
              <path d={iconById(d.look.icon)!.paths.join(" ")} fill="none" stroke={common.stroke} strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            </g>
          </>
        ) : d.look?.path ? (
          <path d={d.look.path} {...common} />
        ) : d.base === "diamond" ? (
          <path d="M50 0L100 50L50 100L0 50Z" {...common} />
        ) : d.base === "ellipse" ? (
          <ellipse cx={50} cy={50} rx={50} ry={50} {...common} />
        ) : (
          <rect width={100} height={100} rx={12} {...common} strokeDasharray={d.kind === "diagram:container" ? "4 3" : undefined} />
        )}
      </g>
    </svg>
  );
}

/** A connector preset: a short line with its ends. */
function PresetPreview({ id }: { id: string }) {
  const p = presetOf(id);
  const pr = p?.props ?? {};
  const head = (v: string | undefined, dflt: string | null) => (v === "none" ? null : (v ?? dflt));
  const st = pr.startCard ?? head(pr.startArrow, null), en = pr.endCard ?? head(pr.endArrow, "arrow");
  const glyph = (name: string | null, at: "start" | "end") => {
    if (!name) return null;
    const d = name === "arrow" ? "M11 4L19 10L11 16" : HEADS[name]?.d;
    if (!d) return null;
    // 20 × 20 glyph, tip at (19, 10): placed at the line's end, mirrored at the start.
    const tr = at === "end" ? "translate(14 4) scale(.8)" : "translate(18 4) scale(-.8 .8) translate(-1 0)";
    return <path d={d} transform={tr} fill={HEADS[name]?.fill ?? "none"} stroke="var(--fg-2)" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />;
  };
  return (
    <svg className="ocdg-pv" width={32} height={24} viewBox="0 0 32 24" aria-hidden="true">
      <line x1={3} y1={12} x2={29} y2={12} stroke="var(--fg-2)" strokeWidth={1.4} strokeDasharray={p?.fields.dashed ? "3 2" : undefined} />
      {glyph(st ?? null, "start")}
      {glyph(en ?? null, "end")}
    </svg>
  );
}

function Tile({ kind, onAdd, hit }: { kind: string; onAdd: (k: string) => void; hit?: Hit }) {
  const label = labelOf(kind);
  const preset = isPreset(kind);
  const name = hit?.at ? (
    <>
      {label.slice(0, hit.at[0])}
      <mark>{label.slice(hit.at[0], hit.at[1])}</mark>
      {label.slice(hit.at[1])}
    </>
  ) : (
    label
  );
  return (
    <button
      type="button"
      className="ocdg-tile"
      data-kind={kind}
      draggable
      title={preset ? `${label}. Click, then draw from one shape to another; with two shapes selected it connects them` : `${label}. Click to add in the middle of the view, or drag onto the canvas`}
      aria-label={preset ? `Connector: ${label}` : `Add ${label}`}
      onClick={() => onAdd(kind)}
      onDragStart={(e) => {
        e.dataTransfer.setData(KIND_MIME, kind);
        e.dataTransfer.effectAllowed = "copy";
        e.currentTarget.classList.add("dragging");
      }}
      onDragEnd={(e) => e.currentTarget.classList.remove("dragging")}
    >
      {preset ? <PresetPreview id={kind} /> : <Preview d={descOf(kind)} />}
      <span className="ocdg-tl">{name}</span>
      {hit?.keyword ? <span className="ocdg-tk">{hit.keyword}</span> : null}
    </button>
  );
}

/** A built-in icon tile (DGM-17, 1a): the glyph on its category tone. */
function IconTile({ icon, onAdd, hit }: { icon: GenericIcon; onAdd: AddShape; hit?: IconHit }) {
  const tone = toneOf(icon);
  const label = icon.name;
  const name = hit?.at ? (
    <>
      {label.slice(0, hit.at[0])}
      <mark>{label.slice(hit.at[0], hit.at[1])}</mark>
      {label.slice(hit.at[1])}
    </>
  ) : (
    label
  );
  return (
    <button
      type="button"
      className="ocdg-tile"
      data-kind={ICON_KIND}
      data-icon={icon.id}
      draggable
      title={`${label}. Click to add in the middle of the view, or drag onto the canvas`}
      aria-label={`Add ${label} icon`}
      onClick={() => onAdd(ICON_KIND, icon.id)}
      onDragStart={(e) => {
        e.dataTransfer.setData(KIND_MIME, ICON_KIND);
        e.dataTransfer.setData(ICON_MIME, icon.id);
        e.dataTransfer.effectAllowed = "copy";
        e.currentTarget.classList.add("dragging");
      }}
      onDragEnd={(e) => e.currentTarget.classList.remove("dragging")}
    >
      <svg className="ocdg-pv" width={32} height={24} viewBox="0 0 32 24" aria-hidden="true">
        <rect x={4} y={0} width={24} height={24} rx={6} fill={`var(--${tone}-bg)`} />
        <g transform="translate(7 3) scale(0.75)" fill="none" stroke={`var(--${tone}-fg)`} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          {icon.paths.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
      </svg>
      <span className="ocdg-tl">{name}</span>
      {hit?.keyword ? <span className="ocdg-tk">{hit.keyword}</span> : null}
    </button>
  );
}

/** An icon added to this document (3a): its cleaned file as a picture. */
function DocIconTile({ icon, url, onPlace, hit }: { icon: DocIcon; url?: string; onPlace: (id: string) => void; hit?: { at?: [number, number]; keyword?: string } }) {
  const label = icon.name;
  const name = hit?.at ? (
    <>
      {label.slice(0, hit.at[0])}
      <mark>{label.slice(hit.at[0], hit.at[1])}</mark>
      {label.slice(hit.at[1])}
    </>
  ) : (
    label
  );
  return (
    <button
      type="button"
      className="ocdg-tile"
      data-kind={ICON_KIND}
      data-icon={DOC_PREFIX + icon.id}
      draggable
      title={`${label}. Added to this document${icon.byName ? ` by ${icon.byName}` : ""}. Click to add in the middle of the view, or drag onto the canvas`}
      aria-label={`Add ${label} icon`}
      onClick={() => onPlace(icon.id)}
      onDragStart={(e) => {
        e.dataTransfer.setData(KIND_MIME, ICON_KIND);
        e.dataTransfer.setData(ICON_MIME, DOC_PREFIX + icon.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      <span className="ocdg-pv ocdg-dpv" aria-hidden="true">{url ? <img src={url} alt="" /> : null}</span>
      <span className="ocdg-tl">{name}</span>
      {hit?.keyword ? <span className="ocdg-tk">{hit.keyword}</span> : null}
    </button>
  );
}

/** Open by default (1a): the Icons library and its Compute and Storage groups. */
const ICON_OPEN: Record<string, boolean> = { icons: true, "icons:compute": true, "icons:storage": true };
const matchClass = (score: number) => Math.floor(score / 10_000);
/** Shape hits score class × 1e6; icon hits class × 1e4. */
const shapeClass = (score: number) => Math.floor(score / 1e6);

const COLS = 3;
/** Arrow keys move between tiles (2d). */
function onGridKey(e: RKE<HTMLElement>) {
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS }[e.key];
  if (!step) return;
  const tiles = [...(e.currentTarget.closest(".ocdg-lp")?.querySelectorAll<HTMLButtonElement>(".ocdg-tile") ?? [])];
  const i = tiles.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  e.preventDefault();
  tiles[Math.max(0, Math.min(tiles.length - 1, i + step))]?.focus();
}

function BetaTag({ id }: { id: string }) {
  return (
    <span className="ocdg-beta" tabIndex={0} aria-describedby={`${id}-beta`}>
      Beta
      <span role="tooltip" id={`${id}-beta`} className="ocdg-tip">
        Beta: these shapes may still change. Diagrams you make with them keep working, and other apps draw them as plain boxes.
      </span>
    </span>
  );
}

/** What the panel shows: everything, or one part of it (a flyout from the rail). */
type Only = { library: string } | "search" | "recent" | "icons";

export function ShapesPanel({ onAdd, flags, only, autoFocus }: { onAdd: AddShape; flags?: PanelFlags; only?: Only; autoFocus?: boolean }) {
  const docCtx = useDocIcons();
  const onAddOwnIcon = docCtx.api && docCtx.edit && docCtx.openAdd ? () => docCtx.openAdd!() : undefined;
  const place = (id: string) => docCtx.place?.(id);
  const [q, setQ] = useState("");
  const [open, setOpenState] = useState(() => load<Record<string, boolean>>(OPEN_KEY, {}));
  const [recent, setRecent] = useState(() => load<string[]>(RECENT_KEY, []).filter((k) => typeof k === "string"));
  const [hidden, setHiddenState] = useState(() => load<string[]>(HIDDEN_KEY, []).filter((k) => typeof k === "string"));
  const [chooser, setChooser] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const version = useLibrariesVersion();
  const bpmn = !!flags?.bpmn;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const libs = useMemo(() => shownLibraries(flags, hidden), [version, bpmn, hidden]);
  // The first library is open until the person chooses otherwise.
  const isOpen = (id: string) => open[id] ?? id === libs[0]?.id;
  const index = useMemo(() => searchIndex(libs), [libs]);
  const hits = useMemo(() => searchShapes(q, index), [q, index]);
  const iconHits = useMemo(() => searchIcons(q), [q]);
  const lucide = useLucideIndex(q.trim().length > 0);
  const lucideHits = useMemo(() => (lucide ? searchLucide(lucide, q) : []), [lucide, q]);
  const docHits = useMemo(() => searchDocIcons(docCtx.list, q), [docCtx.list, q]);
  const suggested = useMemo(() => (hits.length || iconHits.length || docHits.length ? [] : suggestIcons(q)), [q, hits.length, iconHits.length, docHits.length]);
  const anyHit = hits.length + iconHits.length + docHits.length > 0 || (lucideHits.length > 0 && !suggested.length);
  // Icons go first when they match at least as well as the best shape (1d), so Enter adds them.
  const iconsFirst = iconHits.length > 0 && (!hits.length || matchClass(iconHits[0].score) <= shapeClass(hits[0].score));
  const iconOpen = (k: string) => open[k] ?? ICON_OPEN[k] ?? false;
  const setOpen = (id: string, v: boolean) =>
    setOpenState((o) => {
      const n = { ...o, [id]: v };
      save(OPEN_KEY, n);
      return n;
    });
  const setHidden = (id: string, hide: boolean) =>
    setHiddenState((h) => {
      const n = hide ? [...h.filter((x) => x !== id), id] : h.filter((x) => x !== id);
      save(HIDDEN_KEY, n);
      return n;
    });
  // Libraries kept in their own chunk load when they're opened, or when someone searches.
  const searchingNow = q.trim().length > 0;
  useEffect(() => {
    for (const l of libs) if (l.load && (searchingNow || isOpen(l.id) || (typeof only === "object" && only.library === l.id))) void loadLibrary(l);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libs, searchingNow, open, only]);
  const add = (kind: string) => {
    onAdd(kind);
    // Recent: your last six from any library, newest first (2a).
    setRecent((r) => {
      const n = [kind, ...r.filter((k) => k !== kind)].slice(0, RECENT_MAX);
      save(RECENT_KEY, n);
      return n;
    });
  };
  const addFirst = () => {
    if (docHits[0]) place(docHits[0].icon.id);
    else if (iconsFirst) onAdd(ICON_KIND, iconHits[0].id);
    else if (hits[0]) add(hits[0].kind);
    else if (lucideHits[0]) {
      const name = lucideHits[0].name;
      void lucidePaths(name).then((p) => p && onAdd(ICON_KIND, `lucide:${name}`, p));
    }
  };
  const known = (k: string) => (isPreset(k) ? !!presetOf(k) : descOf(k).kind === k) && libs.some((l) => entries(l).includes(k));
  const recentShown = recent.filter(known);

  // "/" puts the cursor in the search field (2a), unless someone is typing.
  useEffect(() => {
    if (only && only !== "search") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input,textarea,select,[contenteditable='true']")) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [only]);
  useEffect(() => {
    if (!autoFocus) return;
    const el = only === "search" ? input.current : document.querySelector<HTMLElement>(".ocdg-fly .ocdg-tile");
    el?.focus();
  }, [autoFocus, only]);

  const searching = q.trim().length > 0;
  const showSearch = !only || only === "search";
  const lib = typeof only === "object" ? libs.find((l) => l.id === only.library) : undefined;

  const top = iconHits[0] ? iconById(iconHits[0].id) : undefined;
  // Search results from the Icons library; a keyword match says it is not the vendor's logo (1c).
  const iconResults = (
    <section className="ocdg-lib" aria-label="Icons">
      <h3 className="ocdg-lh">Icons</h3>
      <div className="ocdg-tiles">
        {iconHits.map((h) => (
          <IconTile key={h.id} icon={iconById(h.id)!} hit={h} onAdd={onAdd} />
        ))}
      </div>
      {top && iconHits[0].keyword ? (
        <p className="ocdg-ihint">
          {`${top.name} is a generic icon drawn by OpenCanvas, not a vendor logo. Need the real logo? `}
          <button type="button" className="ocdg-link" disabled={!onAddOwnIcon} onClick={() => onAddOwnIcon?.()}>
            Add your own icon
          </button>
        </p>
      ) : null}
    </section>
  );
  // The Icons library's groups (Compute and Storage open by default): in the panel and in the rail's flyout.
  const iconGroups = ICON_CATEGORIES.map((c) => {
    const items = GENERIC_ICONS.filter((i) => i.category === c.id);
    const key = `icons:${c.id}`;
    const on = iconOpen(key);
    return (
      <section key={c.id} className="ocdg-ig" data-group={c.id} aria-label={c.name}>
        <h4 className="ocdg-igh">
          <button type="button" aria-expanded={on} onClick={() => setOpen(key, !on)}>
            <ChevronRight size={12} strokeWidth={SW} className="ocdg-chev" aria-hidden="true" />
            <span>{c.name}</span>
            <span className="ocdg-cnt">{items.length}</span>
          </button>
        </h4>
        {on ? (
          <div className="ocdg-tiles">
            {items.map((i) => (
              <IconTile key={i.id} icon={i} onAdd={onAdd} />
            ))}
          </div>
        ) : null}
      </section>
    );
  });
  const iconLibrary = (
    <section className="ocdg-lib" data-library="icons">
      <h3 className="ocdg-lh">
        <button type="button" aria-expanded={iconOpen("icons")} onClick={() => setOpen("icons", !iconOpen("icons"))}>
          <ChevronRight size={14} strokeWidth={SW} className="ocdg-chev" aria-hidden="true" />
          <ShapesIcon size={14} strokeWidth={SW} aria-hidden="true" />
          <span>Icons</span>
          <span className="ocdg-cnt">{GENERIC_ICONS.length}</span>
        </button>
      </h3>
      {iconOpen("icons") ? iconGroups : null}
    </section>
  );

  let body: ReactNode;
  if (searching) {
    const n = hits.length + iconHits.length + lucideHits.length + docHits.length;
    body = anyHit ? (
      <>
        <p className="ocdg-sr" role="status">{`${n} ${n === 1 ? "match" : "matches"} found`}</p>
        {docHits.length ? (
          <section className="ocdg-lib" aria-label="In this document">
            <h3 className="ocdg-lh">In this document</h3>
            <div className="ocdg-tiles">
              {docHits.map((h) => (
                <DocIconTile key={h.icon.id} icon={h.icon} url={docCtx.urls.get(h.icon.id)} hit={h} onPlace={place} />
              ))}
            </div>
          </section>
        ) : null}
        {iconsFirst ? iconResults : null}
        {/* Groups in the order of their best match, so the first tile is what Enter adds. */}
        {libs
          .filter((l) => hits.some((h) => h.library === l.id))
          .sort((a, b) => hits.findIndex((h) => h.library === a.id) - hits.findIndex((h) => h.library === b.id))
          .map((l) => (
            <section key={l.id} className="ocdg-lib" aria-label={l.name}>
              <h3 className="ocdg-lh">{l.name}</h3>
              <div className="ocdg-tiles">
                {hits
                  .filter((h) => h.library === l.id)
                  .map((h) => (
                    <Tile key={h.kind} kind={h.kind} hit={h} onAdd={add} />
                  ))}
              </div>
            </section>
          ))}
        {iconHits.length && !iconsFirst ? iconResults : null}
        {lucide && lucideHits.length ? <LucideResults idx={lucide} hits={lucideHits} onAdd={onAdd} /> : null}
      </>
    ) : suggested.length ? (
      <div className="ocdg-none ocdg-noicon" role="status">
        <ShapesIcon size={20} strokeWidth={SW} aria-hidden="true" className="ocdg-ei" />
        <p>
          <b>{`No built-in icon for “${q.trim()}”`}</b>
        </p>
        <p className="ocdg-hint">OpenCanvas ships generic icons only, no product logos. Add the logo yourself and it stays in this document for everyone here.</p>
        <button type="button" className="ocdg-btn pri" disabled={!onAddOwnIcon} onClick={() => onAddOwnIcon?.()}>
          <Upload size={14} strokeWidth={SW} />
          Add your own icon
        </button>
        <p className="ocdg-hint ocdg-or">Or use a generic one:</p>
        <div className="ocdg-tiles">
          {suggested.map((i) => (
            <IconTile key={i.id} icon={i} onAdd={onAdd} />
          ))}
        </div>
      </div>
    ) : (
      <div className="ocdg-none" role="status">
        <p>{`No shapes match “${q.trim()}”.`}</p>
        <p className="ocdg-hint">Check the spelling, or try a shorter or more general word.</p>
        <button type="button" className="ocdg-btn" onClick={() => (setQ(""), input.current?.focus())}>
          <X size={14} strokeWidth={SW} />
          Clear search
        </button>
      </div>
    );
  } else if (only === "search") {
    body = <p className="ocdg-hint ocdg-pad">Type a shape's name, or a word like “database” or “decision”.</p>;
  } else if (only === "icons") {
    body = <section className="ocdg-lib" data-library="icons">{iconGroups}</section>;
  } else if (only === "recent") {
    body = recentShown.length ? (
      <div className="ocdg-tiles">{recentShown.map((k) => <Tile key={k} kind={k} onAdd={add} />)}</div>
    ) : (
      <p className="ocdg-hint ocdg-pad">Shapes you add show here.</p>
    );
  } else if (lib) {
    const list = entries(lib);
    body = list.length ? <div className="ocdg-tiles">{list.map((k) => <Tile key={k} kind={k} onAdd={add} />)}</div> : <p className="ocdg-hint ocdg-pad" role="status">Loading shapes…</p>;
  } else {
    body = (
      <>
        {recentShown.length ? (
          <section className="ocdg-lib" data-library="recent" aria-label="Recent">
            <h3 className="ocdg-lh ocdg-lh-plain">
              <History size={14} strokeWidth={SW} aria-hidden="true" />
              Recent
            </h3>
            <div className="ocdg-tiles">{recentShown.map((k) => <Tile key={k} kind={k} onAdd={add} />)}</div>
          </section>
        ) : null}
        {/* In this document (DGM-17 part 3, 3a): icons people added, above the Icons library. */}
        <section className="ocdg-lib" data-library="doc-icons" aria-labelledby="ocdg-doc-icons">
          <h3 className="ocdg-lh ocdg-lh-plain" id="ocdg-doc-icons">
            <span>In this document</span>
            <span className="ocdg-cnt">{docCtx.list.length}</span>
            <button type="button" className="ocdg-ib ocdg-dmng" aria-label="Manage icons" title="Manage icons" disabled={!docCtx.openManage} onClick={() => docCtx.openManage?.()}>
              <Settings2 size={14} strokeWidth={SW} />
            </button>
          </h3>
          {docCtx.list.length ? (
            <div className="ocdg-tiles">
              {docCtx.list.map((i) => (
                <DocIconTile key={i.id} icon={i} url={docCtx.urls.get(i.id)} onPlace={place} />
              ))}
            </div>
          ) : (
            <p className="ocdg-hint ocdg-pad">Logos and icons you add are kept in this document, so everyone here can reuse them.</p>
          )}
          <button type="button" className="ocdg-btn ocdg-addic" disabled={!onAddOwnIcon} title={onAddOwnIcon ? undefined : "Adding icons needs the OpenCanvas server"} onClick={() => onAddOwnIcon?.()}>
            <ImagePlus size={14} strokeWidth={SW} />
            Add icon
          </button>
        </section>
        {iconLibrary}
        <AllIcons open={!!open.lucide} onToggle={() => setOpen("lucide", !open.lucide)} onAdd={onAdd} />
        {/* Each library in panel order. */}
        {libs.map((l) => {
          const I = ICONS[l.icon] ?? Boxes;
          const on = isOpen(l.id);
          const list = entries(l);
          return (
            <section key={l.id} className="ocdg-lib" data-library={l.id}>
              <h3 className="ocdg-lh">
                <button type="button" aria-expanded={on} onClick={() => setOpen(l.id, !on)}>
                  <ChevronRight size={14} strokeWidth={SW} className="ocdg-chev" aria-hidden="true" />
                  <I size={14} strokeWidth={SW} aria-hidden="true" />
                  <span>{l.name}</span>
                  <span className="ocdg-cnt">{list.length || l.count || 0}</span>
                </button>
                {l.beta ? <BetaTag id={`ocdg-${l.id}`} /> : null}
              </h3>
              {on ? (
                list.length ? (
                  <div className="ocdg-tiles">
                    {list.map((k) => (
                      <Tile key={k} kind={k} onAdd={add} />
                    ))}
                  </div>
                ) : (
                  <p className="ocdg-hint ocdg-pad" role="status">Loading shapes…</p>
                )
              ) : null}
            </section>
          );
        })}
      </>
    );
  }

  return (
    <div className="ocdg-lp">
      {showSearch ? (
        <div className="ocdg-search">
          <Search size={14} strokeWidth={SW} aria-hidden="true" />
          <input
            ref={input}
            type="search"
            value={q}
            placeholder="Search shapes and icons"
            aria-label="Search shapes"
            aria-keyshortcuts="/"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (docHits[0] || hits[0] || iconHits[0] || lucideHits[0])) {
                e.preventDefault();
                addFirst();
              } else if (e.key === "Escape" && q) {
                e.stopPropagation();
                setQ("");
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                e.currentTarget.closest(".ocdg-lp")?.querySelector<HTMLButtonElement>(".ocdg-tile")?.focus();
              }
            }}
          />
          {q ? null : <kbd aria-hidden="true">/</kbd>}
        </div>
      ) : null}
      <div className="ocdg-lscroll" onKeyDown={onGridKey}>
        {body}
      </div>
      {!only ? (
        <div className="ocdg-lfoot">
          <button type="button" className="ocdg-lchoose" aria-haspopup="dialog" aria-expanded={chooser} onClick={() => setChooser((v) => !v)}>
            <LibraryIcon size={14} strokeWidth={SW} aria-hidden="true" />
            Libraries
            <span className="ocdg-cnt">{`${libs.length} on`}</span>
          </button>
          {chooser ? (
            <div className="ocdg-chooser" role="dialog" aria-label="Libraries" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), e.nativeEvent.stopImmediatePropagation(), setChooser(false))}>
              <p className="ocdg-hint">Show these libraries. Your administrator decides which are installed.</p>
              {availableLibraries(flags).map((l) => {
                const I = ICONS[l.icon] ?? Boxes;
                return (
                  <label key={l.id} className="ocdg-chk">
                    <input type="checkbox" checked={!hidden.includes(l.id)} onChange={(e) => setHidden(l.id, !e.target.checked)} />
                    <I size={14} strokeWidth={SW} aria-hidden="true" />
                    <span>{l.name}</span>
                    {l.beta ? <span className="ocdg-beta ocdg-beta-s">Beta</span> : null}
                  </label>
                );
              })}
              <button type="button" className="ocdg-btn" onClick={() => setChooser(false)}>
                Done
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type Tab = "shapes" | "outline";

/**
 * The left side of diagram mode: Shapes and Outline as tabs (editors), or the outline alone
 * (view only, 10c). The shapes side folds to a rail of library icons (2h) whose buttons open
 * flyouts; the rail also reaches search, recent and the outline.
 */
export function LeftPanel({ tab, onTab, shapes, outline, onAdd, flags }: { tab: Tab; onTab: (t: Tab) => void; shapes: boolean; outline: ReactNode; onAdd: AddShape; flags?: PanelFlags }) {
  const [rail, setRailState] = useState(() => load<boolean>(RAIL_KEY, false));
  const [fly, setFly] = useState<Only | null>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const setRail = (v: boolean) => {
    setRailState(v);
    save(RAIL_KEY, v);
    setFly(null);
  };
  // A flyout closes on Esc or a click outside it (and after a shape is added).
  useEffect(() => {
    if (!fly) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Esc closes the flyout only, not diagram mode.
        e.preventDefault();
        e.stopImmediatePropagation();
        setFly(null);
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!flyRef.current?.contains(t) && !(t as Element).closest?.(".ocdg-rail")) setFly(null);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [fly]);

  if (!shapes) {
    return outline ? (
      <aside className="ocdg-side ocdg-left" data-side="left" aria-label="Outline">
        {outline}
      </aside>
    ) : null;
  }

  if (rail) {
    const libs = shownLibraries(flags, load<string[]>(HIDDEN_KEY, []));
    const same = (o: Only) => JSON.stringify(o) === JSON.stringify(fly);
    const railBtn = (label: string, I: LucideIcon, o: Only | null, run?: () => void) => (
      <button key={label} type="button" className="ocdg-ib" aria-label={label} title={label} aria-expanded={o ? same(o) : undefined} aria-haspopup={o ? "dialog" : undefined} onClick={run ?? (() => setFly(o && !same(o) ? o : null))}>
        <I size={16} strokeWidth={SW} />
      </button>
    );
    const flyName = fly === "search" ? "Search shapes" : fly === "recent" ? "Recent" : fly === "icons" ? "Icons" : fly ? (libs.find((l) => l.id === fly.library)?.name ?? "Shapes") : "";
    return (
      <aside className="ocdg-side ocdg-left ocdg-rail" data-side="left" aria-label="Shapes">
        {railBtn("Expand shapes panel", PanelLeftOpen, null, () => setRail(false))}
        <span className="ocdg-rsep" />
        {railBtn("Search shapes", Search, "search")}
        {railBtn("Recent", History, "recent")}
        {railBtn("Icons", ShapesIcon, "icons")}
        {libs.map((l) => railBtn(l.name, ICONS[l.icon] ?? Boxes, { library: l.id }))}
        <span className="ocdg-rsep" />
        {railBtn("Outline", ListTree, null, () => (setRail(false), onTab("outline")))}
        {fly ? (
          <div ref={flyRef} className="ocdg-fly" role="dialog" aria-label={flyName}>
            <h2 className="ocdg-flyh">{flyName}</h2>
            <ShapesPanel key={JSON.stringify(fly)} only={fly} flags={flags} autoFocus onAdd={(k, icon, paths) => (onAdd(k, icon, paths), setFly(null))} />
          </div>
        ) : null}
      </aside>
    );
  }

  const tabs: [Tab, string][] = [["shapes", "Shapes"], ["outline", "Outline"]];
  const onTabKey = (e: RKE) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next: Tab = tab === "shapes" ? "outline" : "shapes";
    onTab(next);
    requestAnimationFrame(() => document.getElementById(`ocdg-tab-${next}`)?.focus());
  };
  return (
    <aside className="ocdg-side ocdg-left" data-side="left" aria-label={tab === "outline" ? "Outline" : "Shapes"}>
      <div className="ocdg-tabs">
        <div role="tablist" aria-label="Left panel" onKeyDown={onTabKey}>
          {tabs.map(([t, label]) => (
            <button key={t} type="button" role="tab" id={`ocdg-tab-${t}`} aria-selected={tab === t} aria-controls={`ocdg-tp-${t}`} tabIndex={tab === t ? 0 : -1} onClick={() => onTab(t)}>
              {label}
            </button>
          ))}
        </div>
        {tab === "shapes" ? (
          <button type="button" className="ocdg-ib" aria-label="Collapse shapes panel" title="Collapse to a rail" onClick={() => setRail(true)}>
            <PanelLeftClose size={16} strokeWidth={SW} />
          </button>
        ) : null}
      </div>
      <div role="tabpanel" id={`ocdg-tp-${tab}`} aria-labelledby={`ocdg-tab-${tab}`} className="ocdg-tp">
        {tab === "shapes" ? <ShapesPanel onAdd={onAdd} flags={flags} /> : outline}
      </div>
    </aside>
  );
}
