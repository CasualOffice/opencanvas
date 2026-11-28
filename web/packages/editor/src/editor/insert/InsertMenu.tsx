// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The "/" insert menu (INS-01, approved frames 1a-7f): desktop popover with category flyouts and
// second steps beside it; phone bottom sheet with drill-in steps, and results docked above the
// keyboard while typing. Focus stays in the text; keys go through controller.ts (frame 6b) and the
// active item is announced in a live region. Lazy: it loads when "/" is first typed.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { Ic } from "../../icons";
import { useStore } from "../../lib/store";
import { useShell } from "../../components/overlay";
import { placePopover } from "../../lib/place";
import { ExtIcon } from "../../ext/ExtIcon";
import { dismissSuggest, suggestStore, type SuggestState } from "../suggest";
import { act, clearRecentList, compactStore, currentNav, insertCtx, liveStore, navStore, recentStore, setNav } from "./controller";
import { activeItem, autoClosed, back, deeper, initialNav, rowFor, variantsOf, viewOf, type Band, type Ctx, type Item, type Nav, type Row, type View } from "./model";
import { ORG_HEAD, type Variant } from "./catalogue";
import "../../styles/insert.css";

const kb = (k: string) => <kbd key={k}>{k}</kbd>;

export default function InsertMenu({ editor }: { editor: Editor }) {
  const s = useStore(suggestStore);
  const { root, compact } = useShell();
  useStore(navStore);
  useStore(recentStore);
  const live = useStore(liveStore);
  useEffect(() => compactStore.set(compact), [compact]);
  if (!s || s.kind !== "slash" || !s.rect || !root) return null;
  const ctx = insertCtx();
  if (autoClosed(s.query, ctx)) return null;
  const nav = currentNav();
  const props = { s, ctx, nav, root, editor };
  return (
    <>
      {compact ? <PhoneMenu {...props} /> : <DeskMenu {...props} />}
      {createPortal(
        <div className="sr-only oci-live" role="status" aria-live="polite">
          {live}
        </div>,
        root,
      )}
    </>
  );
}

interface P {
  s: SuggestState;
  ctx: Ctx;
  nav: Nav;
  root: HTMLElement;
  editor: Editor;
}

// ---------- shared pieces ----------

function Tile({ row, size = 17 }: { row: Row; size?: number }) {
  const b = row.block;
  return <span className={"tile" + (b.ext ? " ext" : "")}>{b.ext ? <ExtIcon pkg={b.ext} size={size} /> : <Ic name={b.icon} size={size} />}</span>;
}

function Seg({ row, sel, onPick }: { row: Row; sel?: Variant; onPick(v: Variant): void }) {
  const vs = variantsOf(row.block, insertCtx());
  const tones = vs.some((v) => v.tone);
  return (
    <span className={"seg" + (tones ? " tones" : "")} aria-hidden="true">
      {vs.map((v) => (
        <span
          key={v.id}
          className={"sg" + (v.id === sel?.id ? " on" : "")}
          title={v.label}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onPick(v);
          }}
        >
          {v.tone ? (
            <span className={`tsw tone-${v.tone}`}>
              <Ic name={v.icon} size={12} />
            </span>
          ) : v.seg ? (
            v.seg
          ) : (
            <Ic name={v.icon} size={15} />
          )}
        </span>
      ))}
    </span>
  );
}

/** "tick tasks off" with the matched query words in bold. */
function Why({ text, matched }: { text: string; matched?: string[] }) {
  if (!matched?.length) return <>{text}</>;
  const re = new RegExp(`\\b(${matched.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/s$/, "")).join("|")})\\w*`, "gi");
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index), <b key={m.index}>{m[0]}</b>);
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

function desc(row: Row, phone = false): ReactNode {
  const b = row.block;
  const v = row.variant;
  if (row.why)
    return (
      <>
        {v ? v.label : b.ext ? b.ext.publisher ?? b.desc : b.desc}{" "}
        <span className="why">
          · <Why text={row.why} matched={row.matched} />
        </span>
      </>
    );
  if (row.note) return `${v ? v.label : b.desc} · ${row.note}`;
  if (b.mode === "seg" && v)
    return (
      <>
        {v.label}
        {v.md && !phone ? (
          <>
            {" "}
            <code className="md">{v.md}</code>
          </>
        ) : null}
      </>
    );
  return b.desc;
}

function Title({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase().trim()) : -1;
  if (i < 0 || !q.trim()) return <b>{text}</b>;
  const n = q.trim().length;
  return (
    <b>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + n)}</mark>
      {text.slice(i + n)}
    </b>
  );
}

const sameItem = (nav: Nav, view: View, item: Item) => activeItem(nav, view)?.id === item.id;

// ---------- desktop ----------

function DeskMenu({ s, ctx, nav, root }: P) {
  const ref = useRef<HTMLDivElement>(null);
  const fly = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const [fpos, setFpos] = useState<{ left: number; top: number } | null>(null);
  const base = viewOf(nav, ctx, false, 0);
  const top = nav.stack.length ? viewOf(nav, ctx, false) : null;
  const activeView = top ?? base;

  // Outside pointer-down closes (the menu and its flyout are one surface).
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || fly.current?.contains(t)) return;
      dismissSuggest();
    };
    const id = window.setTimeout(() => document.addEventListener("pointerdown", down, true), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("pointerdown", down, true);
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !s.rect) return;
    const ar = root.getBoundingClientRect();
    const r = s.rect;
    const next = placePopover({ left: r.left - ar.left, right: r.right - ar.left, top: r.top - ar.top, bottom: r.bottom - ar.top }, { width: ar.width, height: ar.height }, { width: el.offsetWidth, height: el.scrollHeight });
    setPos((p) => (p && p.left === next.left && p.top === next.top && p.maxHeight === next.maxHeight ? p : next));
  });
  useLayoutEffect(() => {
    const el = ref.current;
    const f = fly.current;
    if (!el || !f) return setFpos((p) => (p ? null : p));
    const ar = root.getBoundingClientRect();
    const mr = el.getBoundingClientRect();
    const anchor = el.querySelector(".mi.open, .mi.on") as HTMLElement | null;
    const at = (anchor ?? el).getBoundingClientRect();
    let left = mr.right - ar.left + 6;
    if (left + f.offsetWidth > ar.width - 8) left = Math.max(8, mr.left - ar.left - f.offsetWidth - 6);
    const topPx = Math.max(8, Math.min(at.top - ar.top - 6, ar.height - f.offsetHeight - 8));
    setFpos((p) => (p && p.left === left && p.top === topPx ? p : { left, top: topPx }));
  });
  // Keep the active item in view.
  useEffect(() => {
    (fly.current ?? ref.current)?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [nav]);

  const go = (next: Nav) => setNav(next);
  const point = (view: View, item: Item, depth: number) => {
    // Pointer: make it the active item of its view (base view: leave any open frame).
    let n = nav;
    if (depth === 0 && n.stack.length) n = { ...n, stack: [], saved: [] };
    view.bands.forEach((band, b) => band.items.forEach((it, i) => it.id === item.id && (n = { ...n, b, i })));
    return n;
  };
  const click = (view: View, item: Item, depth: number, keep = false) => {
    const n = point(view, item, depth);
    const f = deeper(item);
    if (item.kind === "cat" || (f && item.kind === "row" && depth === 0 && keep)) {
      go({ ...n, stack: [f!], saved: [{ b: n.b, i: n.i }], b: 0, i: 0 });
      return;
    }
    go(n);
    const r = (() => {
      switch (item.kind) {
        case "chip":
          return act({ t: "fill", text: item.text.toLowerCase() });
        case "browse":
          return act({ t: "browse" });
        case "ask":
          return act({ t: "ask" });
        case "back":
          return go(back(nav));
        default: {
          const row = rowFor(item, n, ctx);
          if (row) act({ t: "insert", row });
        }
      }
    })();
    void r;
  };
  const pickVariant = (view: View, item: Item, depth: number, v: Variant) => {
    const n = point(view, item, depth);
    go({ ...n, vsel: { ...n.vsel, [item.id]: v.id } });
    liveStore.set(v.label + ".");
  };

  const render = (view: View, depth: number) => (
    <Bands
      view={view}
      nav={nav}
      ctx={ctx}
      q={s.query}
      active={view === activeView}
      openCat={depth === 0 && nav.stack[0]?.kind === "cat" ? nav.stack[0].cat : undefined}
      onClick={(it, keep) => click(view, it, depth, keep)}
      onHover={(it) => {
        if (depth === 0 && it.kind === "cat" && !(nav.stack[0]?.kind === "cat" && nav.stack[0].cat === it.cat.id)) {
          const n = point(view, it, 0);
          go({ ...n, stack: [{ kind: "cat", cat: it.cat.id }], saved: [{ b: n.b, i: n.i }], b: 0, i: 0 });
        }
      }}
      onVariant={(it, v) => pickVariant(view, it, depth, v)}
    />
  );

  const head = base.kind === "root" ? (
    <div className="mq">
      <b>What do you want to insert?</b>
      <span>Type to search</span>
    </div>
  ) : base.kind === "flat" && !s.query ? (
    <div className="mq">
      <b>Insert</b>
    </div>
  ) : null;

  return (
    <>
      {createPortal(
        <div
          className="pop mxp oci"
          ref={ref}
          role="listbox"
          id="oci-menu"
          aria-label="Insert a block"
          // Scrollable, so focusable (WCAG 2.1.1); typing stays in the editor (mouse-down is held,
          // and the "/" plugin takes Tab).
          tabIndex={0}
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: pos?.maxHeight }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {head}
          {base.kind === "search" && !base.results?.groups.length ? (
            <div className="none">
              <Ic name="search" size={16} />
              <span>No blocks match “{s.query.trim()}”</span>
            </div>
          ) : null}
          {render(base, 0)}
          <Foot view={activeView} nav={nav} ctx={ctx} />
        </div>,
        root,
      )}
      {top
        ? createPortal(
            <div
              className="pop mxp oci fly"
              ref={fly}
              role="listbox"
              tabIndex={0}
              aria-label={top.kind === "step" ? `${top.title} ${top.block?.segLabel}` : top.title}
              style={{ left: fpos?.left ?? -9999, top: fpos?.top ?? -9999 }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {top.kind === "step" ? (
                <div className="sh2">
                  {/* Pointer only: ← and ⌫ go back from the keyboard (an option list holds options only). */}
                  <span className="bk" aria-hidden="true" onMouseDown={() => go(back(nav))}>
                    <Ic name="chevron-left" size={16} />
                  </span>
                  <b>{top.title}</b>
                  <span>Choose a {top.block?.segLabel}</span>
                </div>
              ) : top.cat ? (
                <div className="fh">
                  <Ic name={top.cat.icon} size={14} />
                  <b>{top.cat.title}</b>
                </div>
              ) : null}
              {render(top, nav.stack.length)}
              {top.kind === "step" && top.block?.key === "database" ? <p className="sn">Every database can show all six views later; this picks the first one.</p> : null}
              <Foot view={top} nav={nav} ctx={ctx} />
            </div>,
            root,
          )
        : null}
    </>
  );
}

function Foot({ view, nav, ctx }: { view: View; nav: Nav; ctx: Ctx }) {
  const it = activeItem(nav, view);
  let body: ReactNode;
  const row = it ? rowFor(it, nav, ctx) : undefined;
  if (view.kind === "step" && row?.variant)
    body = (
      <>
        {kb("↵")}
        <span>insert {row.variant.label}</span>
        {kb("←")}
        {kb("→")}
        <span>choose</span>
        {kb("⌫")}
        <span>back</span>
      </>
    );
  else if (row && row.block.mode === "seg" && !row.fixed)
    body = (
      <>
        {kb("Tab")}
        <span>change {row.block.segLabel}</span>
        {kb("↵")}
        <span>insert {row.variant?.label}</span>
      </>
    );
  else if (row && row.block.mode === "step" && !row.fixed)
    body = (
      <>
        {kb("↵")}
        <span>insert {row.variant?.label}</span>
        {kb("→")}
        <span>choose {row.block.segLabel}</span>
      </>
    );
  else
    body = (
      <>
        {kb("↑")}
        {kb("↓")}
        {view.kind === "root" ? (
          <>
            {kb("←")}
            {kb("→")}
          </>
        ) : null}
        <span>move</span>
        {kb("↵")}
        <span>{it?.kind === "cat" ? "open" : it?.kind === "chip" ? "search" : "insert"}</span>
        {kb("esc")}
        <span>close</span>
      </>
    );
  return (
    <div className="mf" aria-hidden="true">
      {body}
    </div>
  );
}

interface BandsProps {
  view: View;
  nav: Nav;
  ctx: Ctx;
  q: string;
  active: boolean;
  phone?: boolean;
  openCat?: string;
  onClick(it: Item, keep?: boolean): void;
  onHover?(it: Item): void;
  onVariant?(it: Item, v: Variant): void;
}

function Bands(p: BandsProps) {
  const { view, nav } = p;
  const on = (it: Item) => p.active && sameItem(nav, view, it);
  const out: ReactNode[] = [];
  let i = 0;
  while (i < view.bands.length) {
    const band = view.bands[i];
    // Consecutive single-row bands under one heading form one group.
    const group: Band[] = [band];
    while (band.kind === "row" && view.bands[i + group.length]?.kind === "row" && !view.bands[i + group.length].head && view.bands[i + group.length].label === band.label) group.push(view.bands[i + group.length]);
    out.push(<BandGroup key={i} bands={group} {...p} on={on} />);
    i += group.length;
  }
  return <>{out}</>;
}

function BandGroup(p: BandsProps & { bands: Band[]; on(it: Item): boolean }) {
  const band = p.bands[0];
  const headId = band.head ? "oci-h-" + band.head.replace(/\W+/g, "") : undefined;
  const items = p.bands.flatMap((b) => b.items);
  const tag = p.phone ? "button" : "div";
  const optProps = (it: Item, cls: string, label: string) => ({
    key: it.id,
    id: it.id,
    className: cls + (p.on(it) ? " on" : ""),
    ...(p.phone ? { type: "button" as const, "aria-label": label } : { role: "option", "aria-selected": p.on(it), "aria-label": label }),
    onClick: (e: React.MouseEvent) => p.onClick(it, e.metaKey || e.ctrlKey),
    // Movement, not mouseenter: a row re-laid out under a still pointer must not steal the keyboard.
    onMouseMove: p.onHover ? () => p.onHover!(it) : undefined,
  });
  const Tag = tag as "div";
  let body: ReactNode;
  if (band.kind === "tiles") {
    body = (
      <div className={"qrow" + (p.phone ? " ph" : "")}>
        {items.map((it) => {
          const row = rowFor(it, p.nav, p.ctx)!;
          const cap = row.fixed && row.variant ? row.variant.label : row.block.key === "table" ? "Table" : row.block.key === "board" ? "Whiteboard" : row.block.title;
          return (
            <Tag {...optProps(it, "qi", row.variant && !row.fixed ? `${row.block.title}, ${row.variant.label}` : cap)}>
              <span className={"qt" + (row.block.ext ? " ext" : "")}>{row.block.ext ? <ExtIcon pkg={row.block.ext} size={19} /> : <Ic name={row.fixed && row.variant ? row.variant.icon : row.block.icon} size={19} />}</span>
              <span>{cap}</span>
            </Tag>
          );
        })}
      </div>
    );
  } else if (band.kind === "chips") {
    body = (
      <div className={"chips" + (p.phone ? " scroll" : "")}>
        {items.map((it) => {
          if (it.kind === "chip") return <Tag {...optProps(it, "ic", it.text)}>{it.text}</Tag>;
          const row = rowFor(it, p.nav, p.ctx)!;
          const t = row.variant ? row.variant.label : row.block.title;
          return (
            <Tag {...optProps(it, "rc" + (row.block.ext ? " ext" : ""), row.variant ? `${row.block.title}, ${t}` : t)}>
              {row.block.ext ? <ExtIcon pkg={row.block.ext} size={14} /> : <Ic name={row.variant?.icon ?? row.block.icon} size={14} />}
              {t}
            </Tag>
          );
        })}
      </div>
    );
  } else if (band.kind === "bar") {
    body = (
      <>
        <div className="msep" />
        <div className="mbar">
          {items.map((it) =>
            it.kind === "browse" ? (
              <Tag {...optProps(it, "mb", "Browse all blocks")}>
                <Ic name="layout-grid" size={15} />
                Browse all blocks
              </Tag>
            ) : (
              <Tag {...optProps(it, "mb ai", "Ask the assistant")}>
                <Ic name="sparkles" size={15} />
                Ask the assistant
              </Tag>
            ),
          )}
        </div>
      </>
    );
  } else if (band.kind === "cards") {
    body = (
      <div className={band.items[0] && "row" in band.items[0] && band.items[0].row.block.key === "database" ? "vgrid" + (p.phone ? " ph" : "") : "dgrid" + (p.phone ? " ph" : "")}>
        {items.map((it) => {
          const row = (it as { row: Row }).row;
          const v = row.variant!;
          const last = p.phone && p.ctx.rec.variant[row.block.key] === v.id;
          return row.block.key === "database" ? (
            <Tag {...optProps(it, "vcard", v.label)}>
              <ViewPreview id={v.id} />
              <span className="vl">
                <Ic name={v.icon} size={14} />
                <b>{v.short}</b>
                {last ? <LastUsed /> : null}
              </span>
              <span>{viewDesc[v.id]}</span>
            </Tag>
          ) : (
            <Tag {...optProps(it, "dcard", v.label)}>
              <DiagramSketch id={v.id} />
              <span className="dl">
                <b>{v.label}</b>
                <span>{v.why[0].toUpperCase() + v.why.slice(1)}</span>
              </span>
            </Tag>
          );
        })}
      </div>
    );
  } else {
    body = items.map((it) => {
      if (it.kind === "cat")
        return (
          <Tag {...optProps(it, "mi mx cat" + (p.openCat === it.cat.id ? " open" : ""), `${it.cat.title}, ${it.count} blocks`)}>
            <span className={`tile ct tone-${it.cat.tone}`}>
              <Ic name={it.cat.icon} size={16} />
            </span>
            <span className="ml one">
              <b>{it.cat.title}</b>
              <span>{it.cat.desc}</span>
            </span>
            <span className="cnt">{it.count}</span>
            <Ic name="chevron-right" size={15} />
          </Tag>
        );
      if (it.kind === "card") {
        // Phone: a variant as a full-width option (7c).
        const v = it.row.variant!;
        const last = p.ctx.rec.variant[it.row.block.key] === v.id;
        return (
          <Tag {...optProps(it, "mi mx vopt" + (last ? " cur" : ""), v.label)}>
            <span className="tile">
              <Ic name={v.icon} size={17} />
            </span>
            <span className="ml">
              <b>{v.label}</b>
              <span>
                {v.why[0].toUpperCase() + v.why.slice(1)}
                {v.md ? (
                  <>
                    {" · "}
                    <code className="md">{v.md}</code>
                  </>
                ) : null}
              </span>
            </span>
            {last ? <LastUsed /> : null}
          </Tag>
        );
      }
      if (!("row" in it)) return null;
      const row = rowFor(it, p.nav, p.ctx)!;
      const b = row.block;
      const label = row.variant ? `${b.title}, ${row.variant.label}` : b.title;
      let right: ReactNode = null;
      if (b.mode === "seg" && !row.fixed && !p.phone) right = <Seg row={row} sel={row.variant} onPick={(v) => p.onVariant?.(it, v)} />;
      else if ((b.mode === "step" || (p.phone && b.mode === "seg")) && !row.fixed)
        right = (
          <span className="stp">
            {b.mode === "step" ? row.variant?.short : null}
            <Ic name="chevron-right" size={15} />
          </span>
        );
      else if (b.md) right = <span className="mk">{b.md}</span>;
      return (
        <Tag {...optProps(it, "mi mx", label)}>
          <Tile row={row} />
          <span className="ml">
            <Title text={b.title} q={p.q} />
            <span>{desc(row, p.phone)}</span>
          </span>
          {right}
        </Tag>
      );
    });
  }
  return (
    <div role={p.phone ? undefined : "group"} aria-labelledby={p.phone ? undefined : headId} aria-label={!headId && !p.phone ? band.label : undefined} className="oci-g">
      {band.head ? (
        <div className="mh" id={headId}>
          {band.headIcon ? <Ic name={band.headIcon} size={12} /> : null}
          <span>{band.head}</span>
          {band.head === "Recent" ? (
            <span
              className="mh-a"
              aria-hidden="true"
              onMouseDown={(e) => {
                e.preventDefault();
                clearRecentList();
              }}
            >
              Clear
            </span>
          ) : null}
        </div>
      ) : null}
      {body}
    </div>
  );
}

const LastUsed = () => (
  <span className="last">
    <Ic name="history" size={12} />
    Last used
  </span>
);

const viewDesc: Record<string, string> = { table: "Rows with properties", board: "Cards by status", calendar: "Items on their dates", gallery: "Cards with a cover" };

function ViewPreview({ id }: { id: string }) {
  if (id === "table")
    return (
      <span className="pv vt" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className={i ? "" : "h"}>
            <u />
            <u />
            <u />
          </i>
        ))}
      </span>
    );
  if (id === "board")
    return (
      <span className="pv vb" aria-hidden="true">
        {[3, 2, 1].map((n, j) => (
          <i key={j}>
            <s className={`tone-${["gray", "amber", "green"][j]}`} />
            {Array.from({ length: n }, (_, k) => (
              <u key={k} />
            ))}
          </i>
        ))}
      </span>
    );
  if (id === "calendar")
    return (
      <span className="pv vc" aria-hidden="true">
        {Array.from({ length: 14 }, (_, i) => (
          <i key={i} className={[3, 9].includes(i) ? "e" : i === 5 ? "e g" : ""} />
        ))}
      </span>
    );
  // Timeline: offset bars; Workload: a heat grid (green, amber, red cells).
  if (id === "timeline" || id === "workload")
    return (
      <span className={"pv " + (id === "timeline" ? "vtl" : "vc vwl")} aria-hidden="true">
        {id === "timeline" ? [0, 25, 45].map((l, i) => <u key={i} style={{ marginLeft: `${l}%` }} />) : Array.from({ length: 12 }, (_, i) => <i key={i} className={["e g", "e", "e r"][i % 3]} />)}
      </span>
    );
  return (
    <span className="pv vg" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <i key={i}>
          <s />
          <u />
        </i>
      ))}
    </span>
  );
}

const SKETCH: Record<string, ReactNode> = {
  flowchart: <><rect x="4" y="15" width="16" height="10" rx="2" /><path d="M32 12l8 8-8 8-8-8z" /><rect x="46" y="15" width="14" height="10" rx="2" /><path d="M20 20h4M40 20h6" /></>,
  uml: <><rect x="6" y="6" width="20" height="28" rx="1.5" /><path d="M6 14h20M6 24h20" /><rect x="40" y="10" width="18" height="20" rx="1.5" /><path d="M40 17h18" /><path d="M26 20h14" /><path d="M36 17l4 3-4 3" /></>,
  erd: <><rect x="4" y="8" width="20" height="24" rx="1.5" /><path d="M4 14h20" /><path d="M8 19h10M8 25h8" /><rect x="40" y="8" width="20" height="24" rx="1.5" /><path d="M40 14h20" /><path d="M44 19h10M44 25h8" /><path d="M24 20h16M28 16v8M34 20l6-5M34 20l6 5" /></>,
  network: <><path d="M22 14a6 6 0 0 1 11-3 5 5 0 0 1 6 5 4 4 0 0 1-1 8H22a5 5 0 0 1 0-10z" /><rect x="8" y="30" width="12" height="7" rx="1" /><rect x="44" y="30" width="12" height="7" rx="1" /><path d="M14 30v-4h8M50 30v-4h-12" /></>,
  mindmap: <><ellipse cx="32" cy="20" rx="9" ry="6" /><path d="M23 18 12 9M23 22 12 31M41 18l11-9M41 22l11 9" /><circle cx="9" cy="8" r="3" /><circle cx="9" cy="32" r="3" /><circle cx="55" cy="8" r="3" /><circle cx="55" cy="32" r="3" /></>,
  org: <><rect x="25" y="3" width="14" height="9" rx="1.5" /><rect x="6" y="28" width="14" height="9" rx="1.5" /><rect x="25" y="28" width="14" height="9" rx="1.5" /><rect x="44" y="28" width="14" height="9" rx="1.5" /><path d="M32 12v8M13 28v-8h38v8M32 20v8" /></>,
  wireframe: <><rect x="10" y="4" width="44" height="32" rx="2" /><path d="M10 10h44" /><rect x="15" y="15" width="16" height="12" rx="1" /><path d="M36 16h13M36 21h10M36 26h13" /></>,
  blank: <><rect x="10" y="6" width="44" height="28" rx="2" strokeDasharray="3 3" /><path d="M32 15v10M27 20h10" /></>,
};

export function DiagramSketch({ id, lg }: { id: string; lg?: boolean }) {
  return (
    <svg viewBox="0 0 64 40" className={"dsk" + (lg ? " lg" : "")} aria-hidden="true">
      {SKETCH[id] ?? SKETCH.blank}
    </svg>
  );
}

// ---------- phone (7a-7f) ----------

function useKeyboardInset(): number {
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const f = () => {
      const covered = Math.round(window.innerHeight - (vv.height + vv.offsetTop));
      setKb(covered > 60 ? covered : 0);
    };
    vv.addEventListener("resize", f);
    f();
    return () => vv.removeEventListener("resize", f);
  }, []);
  return kb;
}

function PhoneMenu({ s, ctx, nav, root }: P) {
  const kbh = useKeyboardInset();
  const view = viewOf(nav, ctx, true);
  const go = (n: Nav) => setNav(n);
  const close = () => dismissSuggest();
  const click = (it: Item) => {
    let n = nav;
    view.bands.forEach((band, b) => band.items.forEach((x, i) => x.id === it.id && (n = { ...n, b, i })));
    // A search result inserts the variant it shows (7e); elsewhere a variant block opens its step (7c).
    const f = view.kind === "search" && it.kind === "row" ? null : deeper(it, true);
    if (f) return go({ ...n, stack: [...n.stack, f], saved: [...n.saved, { b: n.b, i: n.i }], b: 0, i: 0 });
    if (it.kind === "chip") return act({ t: "fill", text: it.text.toLowerCase() });
    if (it.kind === "browse") return act({ t: "browse" });
    const row = rowFor(it, n, ctx);
    if (row) act({ t: "insert", row });
  };
  const bands = <Bands view={view} nav={nav} ctx={ctx} q={s.query} active phone onClick={click} />;

  // Typing with the keyboard open: results docked on it, not a sheet (7e).
  if (s.query && kbh && !nav.stack.length)
    return createPortal(
      <div className="sheet oci dock" role="dialog" aria-label="Insert" style={{ bottom: kbh }} onMouseDown={(e) => e.preventDefault()}>
        {view.bands.length ? bands : <NoMatch q={s.query} />}
      </div>,
      root,
    );

  const step = nav.stack[nav.stack.length - 1];
  const title = view.kind === "cat" ? view.title : view.kind === "step" ? view.title : "Insert";
  const sub = view.kind === "step" ? `Choose a ${view.block?.segLabel}` : view.kind === "flat" && ctx.profile ? undefined : undefined;
  return createPortal(
    <>
      <div className="scrim light" onPointerDown={(e) => (e.preventDefault(), close())} />
      <div className="sheet oci mx-sheet" role="dialog" aria-label="Insert" onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
        <div className="grab" />
        <div className="sh-hd">
          {step ? (
            <button className="bk" aria-label="Back" onClick={() => go(back(nav))}>
              <Ic name="chevron-left" size={20} />
            </button>
          ) : null}
          <b>{title}</b>
          {sub ? <span>{sub}</span> : null}
          <button className="cx" aria-label="Close" onClick={close}>
            <Ic name="x" size={18} />
          </button>
        </div>
        {!step && view.kind !== "flat" ? (
          <label className="pin mx-pin">
            <Ic name="search" size={16} />
            <input
              aria-label="Search or describe what you need"
              placeholder="Search or describe what you need"
              value={s.query}
              onChange={(e) => {
                s.replace(e.target.value);
                navStore.set(initialNav(e.target.value));
              }}
            />
          </label>
        ) : null}
        {view.kind === "flat" ? <FlatGrid view={view} onClick={click} /> : view.bands.length ? bands : <NoMatch q={s.query} />}
        {view.kind === "step" && view.block?.key === "database" ? <p className="sn">Every database can show all six views later; this picks the first one.</p> : null}
      </div>
    </>,
    root,
  );
}

function NoMatch({ q }: { q: string }) {
  return (
    <div className="none">
      <Ic name="search" size={16} />
      <span>No blocks match “{q.trim()}”</span>
    </div>
  );
}

/** The meeting profile on a phone (7f): large tiles with their variants already set. */
function FlatGrid({ view, onClick }: { view: View; onClick(it: Item): void }) {
  return (
    <div className="mx-g">
      {view.bands.map((b) =>
        b.items.map((it) => {
          if (!("row" in it)) return null;
          const r = it.row;
          const t = r.variant && r.block.mode === "seg" && r.block.key !== "heading" ? r.variant.label : r.block.title;
          return (
            <Fragment key={it.id}>
              <button type="button" className="gb" aria-label={r.variant ? `${r.block.title}, ${r.variant.label}` : r.block.title} onClick={() => onClick({ ...it, row: { ...r, fixed: true } })}>
                {r.block.ext ? <ExtIcon pkg={r.block.ext} size={22} /> : <Ic name={r.variant?.icon ?? r.block.icon} size={22} />}
                <span>{t}</span>
              </button>
            </Fragment>
          );
        }),
      )}
    </div>
  );
}

export { ORG_HEAD };
