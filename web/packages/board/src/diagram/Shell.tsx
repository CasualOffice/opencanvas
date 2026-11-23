// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Diagram mode chrome (DGM-14, approved prototype docs/prototypes/diagram-approved, S1 frames 1c/1d).
// Loaded lazily from BoardBlock (its own chunk): nothing here is in the initial bundle.
// The canvas is the board's own view, passed in as `children`; this adds the window around it.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import * as Y from "yjs";
import { ArrowLeft, Command as CmdIcon, Ellipsis, ListTree, Redo2, Undo2 } from "lucide-react";
import { Commands, ConnectHint, Outline, Shortcuts, useDiagramKeys, type DiagramCanvas } from "./A11y";
import type { BlockEnv } from "@opencanvas/ui";
import { getBoardMap } from "../model";
import type { DiagramPrefs } from "../BoardBlock";
export { Rulers } from "./Rulers";
import { boardName, clipFor, GROW_MS, reducedMotion, setBoardName } from "./mode";
export { documentTitle, headingAbove } from "./mode";
import { ensureDiagramStyles } from "./styles";

const SW = 1.75;

export interface DiagramPeer {
  id: number;
  name: string;
  color: string;
}

export interface DiagramShellProps {
  doc: Y.Doc;
  boardId: string;
  env: BlockEnv;
  /** The block's place in the document (its placeholder while diagram mode is open). */
  anchor: () => HTMLElement | null;
  /** Read from the document when the mode opened: the heading above the block and the document's title. */
  place: { heading: string; title: string };
  closing: boolean;
  /** Called when the leave transition has finished (at once with reduced motion). */
  onClosed: () => void;
  onBack: () => void;
  peers: DiagramPeer[];
  undo: { can: boolean; run: () => void };
  redo: { can: boolean; run: () => void };
  menuOpen: boolean;
  onMenu: () => void;
  /** Transaction origin of this view (undo). */
  origin: unknown;
  prefs: DiagramPrefs;
  onPrefs: (patch: Partial<DiagramPrefs>) => void;
  /** Right-hand panel content for the current selection; null shows the diagram's settings. */
  inspector?: ReactNode;
  /** The canvas's shapes and shared selection (S5: outline, commands, keyboard connector). */
  canvas?: DiagramCanvas;
  children: ReactNode;
}

function useBoardName(doc: Y.Doc, boardId: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = getBoardMap(doc, boardId);
      if (!m) return () => {};
      const h = (e: Y.YMapEvent<unknown>) => e.keysChanged.has("name") && cb();
      m.observe(h);
      return () => m.unobserve(h);
    },
    () => boardName(doc, boardId),
  );
}

const initials = (n: string) =>
  n
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

export default function DiagramShell(p: DiagramShellProps) {
  ensureDiagramStyles();
  const { doc, boardId, env, anchor, closing, place: ctx } = p;
  const ref = useRef<HTMLDivElement>(null);
  const name = useBoardName(doc, boardId);
  const shown = name || ctx.heading || "Board";
  const edit = env.role === "edit";

  // Enter: one motion from the block's rectangle to the full window, panels last (1c).
  useLayoutEffect(() => {
    const el = ref.current;
    const at = anchor();
    if (!el || !at || reducedMotion() || typeof el.animate !== "function") return;
    const r = at.getBoundingClientRect();
    const a = el.animate([{ clipPath: clipFor(r, innerWidth, innerHeight) }, { clipPath: clipFor({ left: 0, top: 0, right: innerWidth, bottom: innerHeight }, innerWidth, innerHeight) }], { duration: GROW_MS, easing: "cubic-bezier(.2,.8,.2,1)" });
    el.querySelectorAll<HTMLElement>(".ocdg-side").forEach((s) => s.animate([{ opacity: 0, transform: `translateX(${s.dataset.side === "left" ? -12 : 12}px)` }, { opacity: 1, transform: "none" }], { duration: 160, delay: GROW_MS - 60, easing: "ease-out", fill: "backwards" }));
    return () => a.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leave: the reverse, back into the block's rectangle; then the board returns to the document.
  const done = useRef(p.onClosed);
  done.current = p.onClosed;
  useEffect(() => {
    if (!closing) return;
    const el = ref.current;
    const at = anchor();
    if (!el || !at || reducedMotion() || typeof el.animate !== "function") return done.current();
    const r = at.getBoundingClientRect();
    const a = el.animate([{ clipPath: clipFor({ left: 0, top: 0, right: innerWidth, bottom: innerHeight }, innerWidth, innerHeight) }, { clipPath: clipFor(r, innerWidth, innerHeight) }], { duration: GROW_MS, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
    let over = false;
    const finish = () => !over && ((over = true), done.current());
    a.onfinish = finish;
    const t = setTimeout(finish, GROW_MS + 200);
    return () => clearTimeout(t);
  }, [closing, anchor]);

  // The document underneath stays mounted and keeps its scroll position; only the page scroll is held.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // S5: outline, commands, shortcuts and the keyboard connector; announcements go to the live region.
  const [outline, setOutline] = useState(false);
  const [said, say] = useState("");
  const cv = p.canvas;
  const connectorStyle = () => (p.prefs.connector === "straight" ? {} : p.prefs.connector === "avoid" ? { route: "elbow" as const, routing: "avoid" as const } : { route: "elbow" as const });
  const keys = useDiagramKeys({ doc, boardId, canvas: cv, edit, origin: p.origin, connectorStyle, onSay: say, onOutline: () => setOutline((v) => !v) });

  const people = [{ id: -1, name: env.me.name, color: env.me.color }, ...p.peers];

  return (
    <div ref={ref} className="ocdg" role="dialog" aria-modal="true" aria-label={`Diagram: ${shown}`} data-board={boardId} onKeyDownCapture={keys.onKeyDownCapture}>
      <header className="ocdg-top">
        <button type="button" className="ocdg-back" onClick={p.onBack} aria-keyshortcuts="Escape">
          <ArrowLeft size={16} strokeWidth={SW} />
          Back to document
        </button>
        <span className="ocdg-vs" />
        <nav className="ocdg-crumb" aria-label="Location">
          {ctx.title ? (
            <>
              <span className="ocdg-doc">{ctx.title}</span>
              <span className="ocdg-sl" aria-hidden="true">/</span>
            </>
          ) : null}
          <span className="ocdg-name" aria-current="page">{shown}</span>
        </nav>
        <span className="ocdg-sp" />
        {cv ? (
          <>
            <button type="button" className="ocdg-cmdk" aria-keyshortcuts="Meta+K Control+K" onClick={() => keys.setPalette(true)}>
              <CmdIcon size={14} strokeWidth={SW} aria-hidden="true" />
              <span>Commands</span>
              <span className="ocdg-kbd" aria-hidden="true">⌘K</span>
            </button>
            <button type="button" className="ocdg-ib" aria-label="Outline" title="Outline (Alt+O)" aria-keyshortcuts="Alt+O" aria-pressed={outline} onClick={() => setOutline((v) => !v)}>
              <ListTree size={16} strokeWidth={SW} />
            </button>
          </>
        ) : null}
        <ul className="ocdg-people" aria-label={`${people.length} ${people.length === 1 ? "person" : "people"} here`}>
          {people.slice(0, 5).map((u) => (
            <li key={u.id} className="ocdg-av" style={{ background: u.color }} title={u.id === -1 ? `${u.name} (you)` : u.name}>
              <span aria-hidden="true">{initials(u.name)}</span>
              <span className="ocdg-sr">{u.id === -1 ? `${u.name} (you)` : u.name}</span>
            </li>
          ))}
        </ul>
        {edit ? (
          <>
            <button type="button" className="ocdg-ib" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!p.undo.can} onClick={p.undo.run}>
              <Undo2 size={16} strokeWidth={SW} />
            </button>
            <button type="button" className="ocdg-ib" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!p.redo.can} onClick={p.redo.run}>
              <Redo2 size={16} strokeWidth={SW} />
            </button>
          </>
        ) : null}
        <button type="button" className="ocdg-ib" aria-label="Board options" title="Board options" aria-haspopup="menu" aria-expanded={p.menuOpen} onClick={p.onMenu}>
          <Ellipsis size={16} strokeWidth={SW} />
        </button>
      </header>
      <div className="ocdg-body">
        {cv && outline ? (
          <aside className="ocdg-side ocdg-left" data-side="left" aria-label="Outline">
            <Outline doc={doc} boardId={boardId} canvas={cv} edit={edit} origin={p.origin} onSay={say} />
          </aside>
        ) : null}
        <main className="ocdg-mid">
          {p.children}
          {cv && keys.conn ? <ConnectHint canvas={cv} conn={keys.conn} /> : null}
        </main>
        <aside className="ocdg-side ocdg-right" data-side="right" aria-label="Properties">
          {p.inspector ?? <DiagramSettings name={name} heading={ctx.heading} edit={edit} onName={(v) => setBoardName(doc, boardId, v, p.origin)} prefs={p.prefs} onPrefs={p.onPrefs} />}
        </aside>
      </div>
      {cv && keys.palette ? <Commands root={ref.current} canvas={cv} edit={edit} onSay={say} onClose={() => keys.setPalette(false)} onOutline={() => setOutline(true)} onShortcuts={() => keys.setSheet(true)} /> : null}
      {keys.sheet ? <Shortcuts onClose={() => keys.setSheet(false)} /> : null}
      <div className="ocdg-sr ocdg-live" role="status" aria-live="polite">{said}</div>
    </div>
  );
}

function Switch({ on, label, hint, onChange }: { on: boolean; label: string; hint?: string; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="ocdg-sw" onClick={() => onChange(!on)}>
      <span className="ocdg-swt">
        {label}
        {hint ? <span className="ocdg-hint">{hint}</span> : null}
      </span>
      <span className="ocdg-tgl" aria-hidden="true" />
    </button>
  );
}

const CONNECTORS: [DiagramPrefs["connector"], string][] = [["straight", "Straight"], ["elbow", "Elbow"], ["avoid", "Avoid shapes"]];

function DiagramSettings({ name, heading, edit, onName, prefs, onPrefs }: { name: string; heading: string; edit: boolean; onName: (v: string) => void; prefs: DiagramPrefs; onPrefs: (p: Partial<DiagramPrefs>) => void }) {
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  return (
    <div className="ocdg-panel">
      <h2 className="ocdg-ph">Diagram</h2>
      <section className="ocdg-sec">
        <label className="ocdg-fld">
          <span className="ocdg-lbl">Name</span>
          <input
            className="ocdg-inp"
            value={v}
            placeholder={heading || "Untitled board"}
            readOnly={!edit}
            onChange={(e) => setV(e.target.value)}
            onBlur={() => onName(v)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
              if (e.key === "Escape") {
                e.stopPropagation();
                setV(name);
              }
            }}
          />
        </label>
        <p className="ocdg-hint">{name ? "Shown in the top bar." : heading ? "Optional. Without a name the heading above the board is used." : "Optional."}</p>
      </section>
      <section className="ocdg-sec" aria-labelledby="ocdg-s-grid">
        <h3 className="ocdg-sh" id="ocdg-s-grid">Grid and rulers</h3>
        <Switch on={prefs.grid} label="Show grid" onChange={(grid) => onPrefs({ grid })} />
        <label className="ocdg-row">
          <span className="ocdg-lbl">Grid size</span>
          <span className="ocdg-unit">
            <input className="ocdg-inp ocdg-num" type="number" min={5} max={200} step={5} value={prefs.gridSize} onChange={(e) => onPrefs({ gridSize: Math.max(5, Math.min(200, Number(e.target.value) || 20)) })} />
            px
          </span>
        </label>
        <Switch on={prefs.rulers} label="Show rulers" onChange={(rulers) => onPrefs({ rulers })} />
      </section>
      {edit ? (
        <>
          <section className="ocdg-sec" aria-labelledby="ocdg-s-snap">
            <h3 className="ocdg-sh" id="ocdg-s-snap">Snapping</h3>
            <Switch on={prefs.snapGrid} label="Snap to grid" onChange={(snapGrid) => onPrefs({ snapGrid })} />
            <Switch on={prefs.snapShapes} label="Snap to other shapes" hint="Shows guides and equal gaps" onChange={(snapShapes) => onPrefs({ snapShapes })} />
          </section>
          <section className="ocdg-sec" aria-labelledby="ocdg-s-conn">
            <h3 className="ocdg-sh" id="ocdg-s-conn">New connectors</h3>
            <div className="ocdg-seg" role="radiogroup" aria-label="Style">
              {CONNECTORS.map(([v, l]) => (
                <button key={v} type="button" role="radio" data-v={v} aria-checked={prefs.connector === v} onClick={() => onPrefs({ connector: v })}>
                  {l}
                </button>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
