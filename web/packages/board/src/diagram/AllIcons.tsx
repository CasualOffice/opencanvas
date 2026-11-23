// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// All icons (DGM-17, owner scope 2026-11-24): every Lucide icon, by category, in a virtualised
// grid so 2,000+ tiles stay smooth; and the tiles search shows. The index and the path data load
// lazily (../lucide.ts), the paths per category as rows scroll into view.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, LibraryBig } from "lucide-react";
import { KIND_MIME } from "../libraries";
import { ICON_KIND, ICON_MIME, iconDragData } from "../icons";
import { loadCategoryPaths, loadLucideIndex, lucideLabel, type LucideHit, type LucideIndex } from "../lucide";

const SW = 1.75;
const COLS = 3;
/** Row height in rem (a tile and its gap); converted with the root font size. */
const ROW_REM = 4.5;
/** Rows drawn beyond the visible ones, each side. */
const OVERSCAN = 3;

export type AddIcon = (kind: string, icon?: string, paths?: readonly string[]) => void;

/** The index, once loaded (null while loading). */
export function useLucideIndex(want: boolean): LucideIndex | null {
  const [idx, setIdx] = useState<LucideIndex | null>(null);
  useEffect(() => {
    if (!want || idx) return;
    let live = true;
    void loadLucideIndex().then((v) => live && setIdx(v));
    return () => {
      live = false;
    };
  }, [want, idx]);
  return idx;
}

/** Path data for the named icons, loading their categories' files as needed. */
function usePaths(idx: LucideIndex | null, rows: { name: string; cat: number }[]): Record<string, string[]> {
  const [paths, setPaths] = useState<Record<string, string[]>>({});
  const cats = useMemo(() => [...new Set(rows.map((r) => r.cat))].sort((a, b) => a - b).join(","), [rows]);
  useEffect(() => {
    if (!idx || !cats) return;
    let live = true;
    for (const c of cats.split(",").map(Number)) {
      void loadCategoryPaths(idx.categories[c].id).then((m) => live && setPaths((p) => (Object.keys(m).every((k) => k in p) ? p : { ...p, ...m })));
    }
    return () => {
      live = false;
    };
  }, [idx, cats]);
  return paths;
}

export function LucideTile({ name, paths, onAdd, hit }: { name: string; paths?: string[]; onAdd: AddIcon; hit?: LucideHit }) {
  const label = lucideLabel(name);
  const id = `lucide:${name}`;
  const nm = hit?.at ? (
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
      data-icon={id}
      draggable={!!paths}
      disabled={!paths}
      title={`${label}. Click to add in the middle of the view, or drag onto the canvas`}
      aria-label={`Add ${label} icon`}
      onClick={() => paths && onAdd(ICON_KIND, id, paths)}
      onDragStart={(e) => {
        if (!paths) return;
        e.dataTransfer.setData(KIND_MIME, ICON_KIND);
        e.dataTransfer.setData(ICON_MIME, iconDragData(id, paths));
        e.dataTransfer.effectAllowed = "copy";
        e.currentTarget.classList.add("dragging");
      }}
      onDragEnd={(e) => e.currentTarget.classList.remove("dragging")}
    >
      <svg className="ocdg-pv" width={40} height={30} viewBox="0 0 40 30" aria-hidden="true">
        <rect x={6} y={0} width={28} height={28} rx={7} fill="var(--gray-bg)" />
        <g transform="translate(10 4) scale(0.8333)" fill="none" stroke="var(--gray-fg)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          {(paths ?? []).map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
      </svg>
      <span className="ocdg-tl">{nm}</span>
      {hit?.tag ? <span className="ocdg-tk">{hit.tag}</span> : null}
    </button>
  );
}

/** Search results from the Lucide set (the first `limit`). */
export function LucideResults({ idx, hits, onAdd, limit = 30 }: { idx: LucideIndex; hits: LucideHit[]; onAdd: AddIcon; limit?: number }) {
  const shown = useMemo(() => hits.slice(0, limit), [hits, limit]);
  const paths = usePaths(idx, shown);
  return (
    <section className="ocdg-lib" aria-label="All icons">
      <h3 className="ocdg-lh">All icons</h3>
      <div className="ocdg-tiles">
        {shown.map((h) => (
          <LucideTile key={h.name} name={h.name} hit={h} paths={paths[h.name]} onAdd={onAdd} />
        ))}
      </div>
      {hits.length > limit ? <p className="ocdg-ihint">{`${limit} of ${hits.length} shown. Type more to narrow the search.`}</p> : null}
    </section>
  );
}

const remPx = () => {
  const v = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(v) && v > 0 ? v : 16;
};

/** The All icons section: category picker and a virtualised grid. */
export function AllIcons({ open, onToggle, onAdd }: { open: boolean; onToggle: () => void; onAdd: AddIcon }) {
  const idx = useLucideIndex(open);
  const [cat, setCat] = useState("");
  const [top, setTop] = useState(0);
  const [viewH, setViewH] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useMemo(() => {
    if (!idx) return [];
    const ci = cat ? idx.categories.findIndex((c) => c.id === cat) : -1;
    return idx.icons.filter((i) => ci < 0 || i[2].includes(ci)).map(([name, , cats]) => ({ name, cat: cats[0] }));
  }, [idx, cat]);
  const rowH = ROW_REM * remPx();
  const rows = Math.ceil(list.length / COLS);
  const h = viewH || 20 * remPx();
  const first = Math.max(0, Math.floor(top / rowH) - OVERSCAN);
  const last = Math.min(rows, Math.ceil((top + h) / rowH) + OVERSCAN);
  const visible = useMemo(() => list.slice(first * COLS, last * COLS), [list, first, last]);
  const paths = usePaths(idx, visible);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setViewH(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [idx, open]);

  return (
    <section className="ocdg-lib" data-library="lucide">
      <h3 className="ocdg-lh">
        <button type="button" aria-expanded={open} onClick={onToggle}>
          <ChevronRight size={14} strokeWidth={SW} className="ocdg-chev" aria-hidden="true" />
          <LibraryBig size={14} strokeWidth={SW} aria-hidden="true" />
          <span>All icons</span>
          <span className="ocdg-cnt">{idx ? idx.icons.length.toLocaleString("en") : "Lucide"}</span>
        </button>
      </h3>
      {open ? (
        idx ? (
          <div className="ocdg-all">
            <select className="ocdg-inp ocdg-allcat" aria-label="Category" value={cat} onChange={(e) => (setCat(e.target.value), setTop(0), box.current && (box.current.scrollTop = 0))}>
              <option value="">{`All categories (${idx.icons.length.toLocaleString("en")})`}</option>
              {idx.categories.map((c) => (
                <option key={c.id} value={c.id}>{`${c.name} (${c.count})`}</option>
              ))}
            </select>
            <div ref={box} className="ocdg-allg" tabIndex={0} aria-label={`${list.length} icons`} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
              <div style={{ height: rows * rowH, position: "relative" }}>
                <div className="ocdg-tiles" style={{ position: "absolute", left: 0, right: 0, top: first * rowH, gridAutoRows: rowH }}>
                  {visible.map((r) => (
                    <LucideTile key={r.name} name={r.name} paths={paths[r.name]} onAdd={onAdd} />
                  ))}
                </div>
              </div>
            </div>
            <p className="ocdg-ihint">Lucide icons (ISC). Generic only, no product logos.</p>
          </div>
        ) : (
          <p className="ocdg-ihint" role="status">Loading icons…</p>
        )
      ) : null}
    </section>
  );
}
