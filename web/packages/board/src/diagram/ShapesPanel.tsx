// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Shapes panel (DGM-14 S2, frames 2a-2e, 2g): libraries from the registry, search, click or drag
// to add. Every tile is registry data (libraries.ts); nothing here defines a shape.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKE } from "react";
import { Boxes, ChevronRight, Network, Search, Shapes, Upload, Workflow, X, type LucideIcon } from "lucide-react";
import { KIND_MIME, LIBRARIES, type Library } from "../libraries";
import { descriptorOf, type ResolvedDescriptor } from "../registry";
import { GENERIC_ICONS, ICON_CATEGORIES, ICON_KIND, ICON_MIME, iconById, searchIcons, suggestIcons, toneOf, type GenericIcon, type IconHit } from "../icons";

const SW = 1.75;
const ICONS: Record<string, LucideIcon> = { workflow: Workflow, boxes: Boxes, network: Network };
const OPEN_KEY = "oc-diagram-libraries-open";

const descOf = (kind: string) => descriptorOf({ type: "rect", kind });

function readOpen(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "null");
    if (v && typeof v === "object") return v as Record<string, boolean>;
  } catch {
    /* private window, blocked storage */
  }
  return {};
}
/** Open by default (1a): Flowchart, the Icons library, its Compute and Storage groups. */
const OPEN_DEFAULT: Record<string, boolean> = { flowchart: true, icons: true, "icons:compute": true, "icons:storage": true };
function writeOpen(v: Record<string, boolean>) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(v));
  } catch {
    /* per-viewer convenience only */
  }
}

export interface Hit {
  kind: string;
  library: string;
  /** Where the label matched ([start, end)), or the keyword that matched. */
  at?: [number, number];
  keyword?: string;
  score: number;
}

/** Search the libraries, best match first (2d); the panel groups the hits by library. */
export function searchShapes(q: string, libraries: readonly Library[] = LIBRARIES): Hit[] {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const out: Hit[] = [];
  libraries.forEach((l, li) =>
    l.kinds.forEach((kind, ki) => {
      const d = descOf(kind);
      const label = (d.label ?? kind).toLowerCase();
      const i = label.indexOf(t);
      let hit: Hit | null = null;
      if (i === 0) hit = { kind, library: l.id, at: [0, t.length], score: 0 };
      else if (i > 0) hit = { kind, library: l.id, at: [i, i + t.length], score: 1 };
      else {
        const k = d.keywords?.find((w) => w.toLowerCase().includes(t));
        if (k) hit = { kind, library: l.id, keyword: k, score: k.toLowerCase().startsWith(t) ? 2 : 3 };
      }
      if (hit) out.push({ ...hit, score: hit.score * 10_000 + li * 100 + ki });
    }),
  );
  return out.sort((a, b) => a.score - b.score);
}

/** A small drawing of the kind: its outline path or its base type. */
export function Preview({ d }: { d: ResolvedDescriptor }) {
  const w = d.look?.w ?? 140, h = d.look?.h ?? 70;
  const k = Math.min(36 / w, 26 / h);
  const pw = w * k, ph = h * k;
  const common = { fill: d.look?.tone ? `var(--${d.look.tone}-bg)` : "var(--app)", stroke: d.look?.tone ? `var(--${d.look.tone}-fg)` : "var(--fg-2)", strokeWidth: 1.25, vectorEffect: "non-scaling-stroke" as const, strokeLinejoin: "round" as const };
  return (
    <svg className="ocdg-pv" width={40} height={30} viewBox="0 0 40 30" aria-hidden="true">
      <g transform={`translate(${(40 - pw) / 2} ${(30 - ph) / 2}) scale(${pw / 100} ${ph / 100})`}>
        {d.look?.icon && iconById(d.look.icon) ? (
          <>
            <rect width={100} height={100} rx={12} {...common} />
            <g transform="translate(6 25) scale(2.1 2.1)">
              <path d={iconById(d.look.icon)!.paths.join(" ")} fill="none" stroke={common.stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            </g>
          </>
        ) : d.look?.path ? (
          <path d={d.look.path} {...common} />
        ) : d.base === "diamond" ? (
          <path d="M50 0L100 50L50 100L0 50Z" {...common} />
        ) : d.base === "ellipse" ? (
          <ellipse cx={50} cy={50} rx={50} ry={50} {...common} />
        ) : (
          <rect width={100} height={100} rx={12} {...common} />
        )}
      </g>
    </svg>
  );
}

function Tile({ kind, onAdd, hit }: { kind: string; onAdd: (k: string) => void; hit?: Hit }) {
  const d = descOf(kind);
  const label = d.label ?? kind;
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
      title={`${label}. Click to add in the middle of the view, or drag onto the canvas`}
      aria-label={`Add ${label}`}
      onClick={() => onAdd(kind)}
      onDragStart={(e) => {
        e.dataTransfer.setData(KIND_MIME, kind);
        e.dataTransfer.effectAllowed = "copy";
        e.currentTarget.classList.add("dragging");
      }}
      onDragEnd={(e) => e.currentTarget.classList.remove("dragging")}
    >
      <Preview d={d} />
      <span className="ocdg-tl">{name}</span>
      {hit?.keyword ? <span className="ocdg-tk">{hit.keyword}</span> : null}
    </button>
  );
}

/** A built-in icon tile (DGM-17, 1a): the glyph on its category tone. */
function IconTile({ icon, onAdd, hit }: { icon: GenericIcon; onAdd: (kind: string, icon?: string) => void; hit?: IconHit }) {
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
      <svg className="ocdg-pv" width={40} height={30} viewBox="0 0 40 30" aria-hidden="true">
        <rect x={6} y={0} width={28} height={28} rx={7} fill={`var(--${tone}-bg)`} />
        <g transform="translate(10 4) scale(0.8333)" fill="none" stroke={`var(--${tone}-fg)`} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
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

export interface ShapesPanelProps {
  /** Adds a shape of `kind`; for `icon:node`, `icon` is the built-in icon's id. */
  onAdd: (kind: string, icon?: string) => void;
  /** Opens Add your own icon (DGM-17 part 2); without it the button is disabled. */
  onAddOwnIcon?: () => void;
}

const matchClass = (score: number) => Math.floor(score / 10_000);

export function ShapesPanel({ onAdd, onAddOwnIcon }: ShapesPanelProps) {
  const [q, setQ] = useState("");
  const [open, setOpenState] = useState(() => ({ ...OPEN_DEFAULT, ...readOpen() }));
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => searchShapes(q), [q]);
  const iconHits = useMemo(() => searchIcons(q), [q]);
  const suggested = useMemo(() => (hits.length || iconHits.length ? [] : suggestIcons(q)), [q, hits.length, iconHits.length]);
  // Icons go first when they match at least as well as the best shape (1d).
  const iconsFirst = iconHits.length > 0 && (!hits.length || matchClass(iconHits[0].score) <= matchClass(hits[0].score));
  const addFirst = () => {
    if (iconsFirst) onAdd(ICON_KIND, iconHits[0].id);
    else if (hits[0]) onAdd(hits[0].kind);
  };
  const setOpen = (id: string, v: boolean) =>
    setOpenState((o) => {
      const n = { ...o, [id]: v };
      writeOpen(n);
      return n;
    });

  // "/" puts the cursor in the search field (2a), unless someone is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input,textarea,select,[contenteditable='true']")) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const searching = q.trim().length > 0;
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
  return (
    <div className="ocdg-lp">
      <h2 className="ocdg-ph ocdg-sr">Shapes</h2>
      <div className="ocdg-search">
        <Search size={14} strokeWidth={SW} aria-hidden="true" />
        <input
          ref={input}
          type="search"
          value={q}
          placeholder="Search shapes and icons"
          aria-label="Search shapes"
          aria-keyshortcuts="/"
          aria-controls="ocdg-lib-results"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (hits[0] || iconHits[0])) {
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
      <div className="ocdg-lscroll" id="ocdg-lib-results" onKeyDown={onGridKey}>
        {searching ? (
          hits.length || iconHits.length ? (
            <>
              <p className="ocdg-sr" role="status">{`${hits.length + iconHits.length} ${hits.length + iconHits.length === 1 ? "match" : "matches"} found`}</p>
              {iconsFirst ? iconResults : null}
              {/* Groups in the order of their best match, so the first tile is what Enter adds. */}
              {LIBRARIES.filter((l) => hits.some((h) => h.library === l.id))
                .sort((a, b) => hits.findIndex((h) => h.library === a.id) - hits.findIndex((h) => h.library === b.id))
                .map((l) => (
                <section key={l.id} className="ocdg-lib" aria-label={l.name}>
                  <h3 className="ocdg-lh">{l.name}</h3>
                  <div className="ocdg-tiles">
                    {hits
                      .filter((h) => h.library === l.id)
                      .map((h) => (
                        <Tile key={h.kind} kind={h.kind} hit={h} onAdd={onAdd} />
                      ))}
                  </div>
                </section>
              ))}
              {iconHits.length && !iconsFirst ? iconResults : null}
            </>
          ) : suggested.length ? (
            <div className="ocdg-none ocdg-noicon" role="status">
              <Shapes size={20} strokeWidth={SW} aria-hidden="true" className="ocdg-ei" />
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
          )
        ) : (
          <>
            {/* Recent (2a) and In this document (DGM-17 part 2) go here, above the Icons library. */}
            <section className="ocdg-lib" data-library="icons">
              <h3 className="ocdg-lh">
                <button type="button" aria-expanded={!!open.icons} onClick={() => setOpen("icons", !open.icons)}>
                  <ChevronRight size={14} strokeWidth={SW} className="ocdg-chev" aria-hidden="true" />
                  <Shapes size={14} strokeWidth={SW} aria-hidden="true" />
                  <span>Icons</span>
                  <span className="ocdg-cnt">{GENERIC_ICONS.length}</span>
                </button>
              </h3>
              {open.icons
                ? ICON_CATEGORIES.map((c) => {
                    const items = GENERIC_ICONS.filter((i) => i.category === c.id);
                    const key = `icons:${c.id}`;
                    const on = !!open[key];
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
                  })
                : null}
            </section>
            {LIBRARIES.map((l) => {
              const I = ICONS[l.icon] ?? Boxes;
              const on = !!open[l.id];
              return (
                <section key={l.id} className="ocdg-lib" data-library={l.id}>
                  <h3 className="ocdg-lh">
                    <button type="button" aria-expanded={on} onClick={() => setOpen(l.id, !on)}>
                      <ChevronRight size={14} strokeWidth={SW} className="ocdg-chev" aria-hidden="true" />
                      <I size={14} strokeWidth={SW} aria-hidden="true" />
                      <span>{l.name}</span>
                      <span className="ocdg-cnt">{l.kinds.length}</span>
                    </button>
                  </h3>
                  {on ? (
                    <div className="ocdg-tiles">
                      {l.kinds.map((k) => (
                        <Tile key={k} kind={k} onAdd={onAdd} />
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
