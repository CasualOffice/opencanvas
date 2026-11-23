// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Diagram keyboard and accessibility (DGM-14 S5, prototype 5a-5d): the Outline tab, Commands (⌘K),
// drawing a connector from the keyboard (C), the shortcuts sheet (?) and the live region.
// Part of the lazy diagram chunk. Canvas actions run as the canvas's own shortcuts, dispatched on
// it, so this file does not reach into the canvas code.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKE } from "react";
import * as Y from "yjs";
import { Box, ChevronDown, ChevronRight, CircleHelp, Command as CmdIcon, Copy, Spline, Trash2, Maximize, Map as MapIcon, Group, Keyboard, ListTree, X, Square } from "lucide-react";
import { addShape, getBoardMap, updateShape, type Shape } from "../model";
import { announce, connectAnnouncement, connectorFor, filterCommands, nextTarget, outlineTree, siblingOf, SHORTCUTS, SIDE_KEYS, startConnect, visibleRows, type Command, type Connecting } from "./keyboard";

const SW = 1.75;

/** What the diagram window needs from the canvas: its shapes and the shared selection. */
export interface DiagramCanvas {
  shapes: Shape[];
  sel: string[];
  select: (ids: string[]) => void;
}

export const A11Y_CSS = `
.ocdg :focus-visible{outline:.15625rem solid var(--accent);outline-offset:.125rem}
.ocdg .ocbd:focus-visible{outline-offset:-.15625rem}
.ocdg-left{width:16rem;border-right:1px solid var(--line)}
.ocdg-ol{list-style:none;margin:0;padding:.25rem .5rem}
.ocdg-oh{display:flex;align-items:center;justify-content:space-between;padding:.5rem 1rem .25rem;font-size:.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--fg-2)}
.ocdg-or{display:flex;align-items:center;gap:.375rem;min-height:1.875rem;padding:0 .5rem;border-radius:.375rem;font-size:.8125rem;cursor:default;color:var(--fg)}
.ocdg-or:hover{background:var(--hover)}
.ocdg-or[aria-selected="true"]{background:var(--accent-soft);color:var(--fg)}
.ocdg-or .ocdg-tw{width:1rem;display:inline-grid;place-items:center;color:var(--fg-2);flex:none}
.ocdg-or .ocdg-on{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ocdg-or .ocdg-ok{font-size:.6875rem;color:var(--fg-2)}
.ocdg-or input{flex:1;min-width:0;height:1.5rem;font:inherit;border:1px solid var(--accent);border-radius:.25rem;padding:0 .25rem;background:var(--app);color:var(--fg)}
.ocdg-keys{display:flex;flex-wrap:wrap;gap:.25rem .625rem;padding:.625rem 1rem;border-top:1px solid var(--line);font-size:.6875rem;color:var(--fg-2)}
.ocdg-kbd{display:inline-grid;place-items:center;min-width:1.25rem;height:1.25rem;padding:0 .25rem;border:1px solid var(--line-2);border-bottom-width:2px;border-radius:.25rem;background:var(--app);color:var(--fg-2);font-size:.6875rem;font-family:var(--font);margin-right:.125rem}
.ocdg-scrim{position:absolute;inset:0;background:rgba(0,0,0,.18);z-index:20;display:flex;justify-content:center;align-items:flex-start;padding-top:12vh}
.ocdg-pal{width:min(35rem,calc(100% - 2rem));background:var(--pop,var(--app));border-radius:.75rem;box-shadow:var(--sh-pop);overflow:hidden;display:flex;flex-direction:column;max-height:70vh}
.ocdg-pal-in{display:flex;align-items:center;gap:.5rem;padding:0 1rem;height:3rem;border-bottom:1px solid var(--line)}
.ocdg-pal-in input{flex:1;border:0;background:none;font:inherit;font-size:.9375rem;color:var(--fg);outline:none;height:100%}
.ocdg-pal-ls{overflow:auto;padding:.375rem;margin:0;list-style:none}
.ocdg-pal-g{font-size:.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--fg-2);padding:.5rem .625rem .25rem}
.ocdg-pal-it{display:flex;align-items:center;gap:.625rem;min-height:2.25rem;padding:0 .625rem;border-radius:.5rem;font-size:.8125rem;cursor:pointer}
.ocdg-pal-it[aria-selected="true"]{background:var(--accent-soft)}
.ocdg-pal-it .ocdg-on{flex:1}
.ocdg-pal-it .ocdg-ok{color:var(--fg-2);font-size:.75rem}
.ocdg-pal-ft{display:flex;gap:1rem;padding:.5rem 1rem;border-top:1px solid var(--line);font-size:.6875rem;color:var(--fg-2)}
.ocdg-sheet{width:min(45rem,calc(100% - 2rem));background:var(--pop,var(--app));border-radius:.75rem;box-shadow:var(--sh-pop);padding:1rem 1.25rem 1.25rem;max-height:80vh;overflow:auto}
.ocdg-sheet h2{font-size:.9375rem;margin:0;flex:1}
.ocdg-sheet-hd{display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem}
.ocdg-sheet-g{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:.5rem 2rem}
.ocdg-sheet h3{font-size:.6875rem;text-transform:uppercase;letter-spacing:.04em;color:var(--fg-2);margin:.5rem 0 .25rem}
.ocdg-sheet dl{margin:0}
.ocdg-sheet .ocdg-row{min-height:1.75rem}
.ocdg-sheet dd{margin:0}
.ocdg-sheet p{font-size:.75rem;color:var(--fg-2);margin:.75rem 0 0}
.ocdg-hintbar{position:absolute;left:50%;bottom:1rem;transform:translateX(-50%);z-index:5;display:flex;align-items:center;gap:.875rem;padding:.5rem .875rem;border-radius:.625rem;background:var(--pop,var(--app));box-shadow:var(--sh-pop);font-size:.75rem;color:var(--fg-2);white-space:nowrap}
.ocdg-hintbar b{color:var(--fg);font-weight:600;display:inline-flex;align-items:center;gap:.375rem}
.ocdg-cmdk{display:inline-flex;align-items:center;gap:.375rem;height:2rem;padding:0 .5rem 0 .625rem;border:1px solid var(--line-2);border-radius:.5rem;background:none;color:var(--fg-2);font-size:.8125rem;margin-right:.375rem}
.ocdg-cmdk:hover{background:var(--hover);color:var(--fg)}
@media (max-width:45em){.ocdg-cmdk span:not(.ocdg-kbd){display:none}}
`;

let injected = false;
function ensureA11yStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-ocdg-a11y", "");
  s.textContent = A11Y_CSS;
  document.head.appendChild(s);
}

/** A modal gives focus back to what had it when it closes, unless something else took it meanwhile. */
function useReturnFocus() {
  const [from] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
  useEffect(
    () => () => {
      const now = document.activeElement;
      if (from?.isConnected && (!now || now === document.body)) from.focus({ preventScroll: true });
    },
    [from],
  );
}

const Kbd = ({ k }: { k: string[] }) => (
  <>
    {k.map((x, i) => (
      <kbd key={i} className="ocdg-kbd">{x}</kbd>
    ))}
  </>
);

/** Runs one of the canvas's own shortcuts by dispatching it on the canvas. */
function canvasKey(root: HTMLElement | null, key: string, o: KeyboardEventInit = {}) {
  const c = root?.querySelector<HTMLElement>(".ocbd");
  if (!c) return;
  c.focus({ preventScroll: true });
  c.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...o }));
}

/* ------------------------------------------------------------ outline (5a) */

export function Outline({ doc, boardId, canvas, edit, origin, onSay }: { doc: Y.Doc; boardId: string; canvas: DiagramCanvas; edit: boolean; origin: unknown; onSay: (s: string) => void }) {
  ensureA11yStyles();
  const tree = useMemo(() => outlineTree(canvas.shapes), [canvas.shapes]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(tree.filter((n) => n.children.length).map((n) => n.id)));
  const rows = visibleRows(tree, open);
  const [focus, setFocus] = useState<string | null>(canvas.sel[0] ?? rows[0]?.id ?? null);
  const [renaming, setRenaming] = useState<{ id: string; v: string } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const cur = rows.find((r) => r.id === focus) ?? rows[0];
  const shapes = canvas.shapes;

  useEffect(() => {
    // Selection made on the canvas moves the outline's focus (shared selection).
    if (canvas.sel.length === 1 && canvas.sel[0] !== focus && tree.some((n) => n.id === canvas.sel[0])) setFocus(canvas.sel[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas.sel]);

  const say = (id: string, selected = canvas.sel.includes(id)) => onSay(announce(shapes, id, selected));
  const go = (id: string) => {
    setFocus(id);
    say(id);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus());
  };
  const onKey = (e: RKE<HTMLUListElement>) => {
    if (renaming || !cur) return;
    const i = rows.indexOf(cur);
    const k = e.key;
    if (e.altKey && (k === "ArrowUp" || k === "ArrowDown")) {
      e.preventDefault();
      if (!edit) return;
      const target = siblingOf(shapes, cur.id, k === "ArrowUp" ? -1 : 1);
      if (!target) return onSay(k === "ArrowUp" ? "Already first" : "Already last");
      reorder(doc, boardId, cur.id, target, k === "ArrowUp", origin);
      onSay(`${cur.name} moved ${k === "ArrowUp" ? "up" : "down"}`);
      return;
    }
    if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      const n = rows[Math.max(0, Math.min(rows.length - 1, i + (k === "ArrowDown" ? 1 : -1)))];
      if (n) go(n.id);
    } else if (k === "Home" || k === "End") {
      e.preventDefault();
      const n = k === "Home" ? rows[0] : rows[rows.length - 1];
      if (n) go(n.id);
    } else if (k === "ArrowRight") {
      e.preventDefault();
      if (cur.children.length && !open.has(cur.id)) setOpen(new Set([...open, cur.id]));
      else if (cur.children.length) go(cur.children[0]);
    } else if (k === "ArrowLeft") {
      e.preventDefault();
      if (cur.children.length && open.has(cur.id)) setOpen(new Set([...open].filter((x) => x !== cur.id)));
      else if (cur.parent) go(cur.parent);
    } else if (k === "Enter" || k === " ") {
      e.preventDefault();
      canvas.select([cur.id]);
      say(cur.id, true);
    } else if (k === "F2" && edit && !cur.connector) {
      e.preventDefault();
      const s = shapes.find((x) => x.id === cur.id);
      setRenaming({ id: cur.id, v: s?.text ?? s?.label ?? "" });
    }
  };
  const commit = () => {
    if (!renaming) return;
    const s = shapes.find((x) => x.id === renaming.id);
    if (s) updateShape(doc, boardId, s.id, s.type === "rect" && s.label && !s.text ? { label: renaming.v } : { text: renaming.v }, origin);
    onSay(`Renamed to ${renaming.v || "nothing"}`);
    const id = renaming.id;
    setRenaming(null);
    go(id);
  };

  const shapesN = tree.filter((n) => !n.connector).length;
  const conn = rows.filter((r) => r.connector);
  const item = (n: (typeof rows)[number]) => (
    <li
      key={n.id}
      data-id={n.id}
      role="treeitem"
      className="ocdg-or"
      aria-level={n.depth + 1}
      aria-expanded={n.children.length ? open.has(n.id) : undefined}
      aria-selected={canvas.sel.includes(n.id)}
      tabIndex={n.id === cur?.id ? 0 : -1}
      style={{ paddingLeft: `${0.5 + n.depth * 1}rem` }}
      onFocus={() => setFocus(n.id)}
      onClick={() => {
        setFocus(n.id);
        canvas.select([n.id]);
      }}
      onDoubleClick={() => edit && !n.connector && setRenaming({ id: n.id, v: n.name })}
    >
      <span className="ocdg-tw" aria-hidden="true">
        {n.children.length ? (open.has(n.id) ? <ChevronDown size={14} strokeWidth={SW} /> : <ChevronRight size={14} strokeWidth={SW} />) : n.connector ? <Spline size={14} strokeWidth={SW} /> : <Square size={12} strokeWidth={SW} />}
      </span>
      {renaming?.id === n.id ? (
        <input
          aria-label={`Rename ${n.name}`}
          autoFocus
          value={renaming.v}
          onChange={(e) => setRenaming({ id: n.id, v: e.target.value })}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setRenaming(null);
              go(n.id);
            }
          }}
        />
      ) : (
        <span className="ocdg-on">{n.name}</span>
      )}
      {n.children.length ? <span className="ocdg-ok">{n.children.length}</span> : null}
    </li>
  );
  return (
    <div className="ocdg-panel" style={{ display: "flex", flexDirection: "column", padding: 0 }}>
      <div style={{ flex: 1, overflow: "auto" }}>
        <div className="ocdg-oh" id="ocdg-ol-shapes">
          <span>Shapes</span>
          <span>{shapesN}</span>
        </div>
        {rows.length ? (
          <ul ref={listRef} className="ocdg-ol" role="tree" aria-labelledby="ocdg-ol-shapes" onKeyDown={onKey}>
            {rows.filter((r) => !r.connector).map(item)}
            {conn.length ? (
              <li role="none">
                <div className="ocdg-oh" style={{ padding: ".5rem .5rem .25rem" }} aria-hidden="true">
                  <span>Connectors</span>
                  <span>{conn.length}</span>
                </div>
                <ul role="group" className="ocdg-ol" style={{ padding: 0 }} aria-label="Connectors">
                  {conn.map(item)}
                </ul>
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="ocdg-hint" style={{ padding: "0 1rem" }}>Nothing on this board yet.</p>
        )}
      </div>
      <div className="ocdg-keys" aria-hidden="true">
        <span><Kbd k={["↑", "↓"]} />move</span>
        <span><Kbd k={["→"]} />open</span>
        <span><Kbd k={["↵"]} />select</span>
        {edit ? <span><Kbd k={["F2"]} />rename</span> : null}
        {edit ? <span><Kbd k={["⌥", "↑"]} />reorder</span> : null}
      </div>
    </div>
  );
}

/** Puts `id` just before (up) or after (down) `target` in the board order; only `id` is re-inserted, so edits merge. */
function reorder(doc: Y.Doc, boardId: string, id: string, target: string, up: boolean, origin: unknown) {
  const o = getBoardMap(doc, boardId)?.get("order");
  if (!(o instanceof Y.Array)) return;
  doc.transact(() => {
    const arr = o.toArray() as string[];
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] === id) o.delete(i, 1);
    const now = o.toArray() as string[];
    const t = now.indexOf(target);
    o.insert(t < 0 ? now.length : up ? t : t + 1, [id]);
  }, origin);
}

/* ------------------------------------------------------------ commands (5b) */

const ACTIONS: (Command & { icon: typeof Box; run: (root: HTMLElement | null) => void })[] = [
  { id: "duplicate", label: "Duplicate", group: "Commands", keys: ["⌘", "D"], when: (c) => c.edit && c.sel.length > 0, icon: Copy, run: (r) => canvasKey(r, "d", { ctrlKey: true }) },
  { id: "delete", label: "Delete", group: "Commands", keys: ["Del"], when: (c) => c.edit && c.sel.length > 0, icon: Trash2, run: (r) => canvasKey(r, "Delete") },
  { id: "group", label: "Group", group: "Commands", keys: ["⌘", "G"], when: (c) => c.edit && c.sel.length > 1, icon: Group, run: (r) => canvasKey(r, "g", { ctrlKey: true }) },
  { id: "connect", label: "Start a connector", group: "Commands", keys: ["C"], when: (c) => c.edit && c.sel.length === 1 && c.sel[0].type !== "arrow", icon: Spline, run: (r) => canvasKey(r, "c") },
  { id: "fit", label: "Zoom to fit", group: "Commands", keys: ["⇧", "1"], icon: Maximize, run: (r) => canvasKey(r, "!", { shiftKey: true, code: "Digit1" }) },
  { id: "minimap", label: "Minimap", group: "Commands", keys: ["M"], icon: MapIcon, run: (r) => canvasKey(r, "m") },
  { id: "outline", label: "Show outline", group: "Commands", keys: ["⌥", "O"], icon: ListTree, run: () => {} },
  { id: "shortcuts", label: "Keyboard shortcuts", group: "Help", keys: ["?"], icon: Keyboard, run: () => {} },
  { id: "help-connect", label: "How connectors work", group: "Help", icon: CircleHelp, run: () => {} },
];

export function Commands({ root, canvas, edit, onClose, onOutline, onShortcuts, onSay }: { root: HTMLElement | null; canvas: DiagramCanvas; edit: boolean; onClose: () => void; onOutline: () => void; onShortcuts: () => void; onSay: (s: string) => void }) {
  ensureA11yStyles();
  useReturnFocus();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const sel = canvas.shapes.filter((s) => canvas.sel.includes(s.id));
  const list = filterCommands(ACTIONS, canvas.shapes, { sel, edit }, q);
  const i = Math.min(at, Math.max(0, list.length - 1));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const run = (c: Command) => {
    onClose();
    if (c.id.startsWith("go:")) {
      const id = c.id.slice(3);
      canvas.select([id]);
      onSay(announce(canvas.shapes, id, true));
      return root?.querySelector<HTMLElement>(".ocbd")?.focus({ preventScroll: true });
    }
    if (c.id === "outline") return onOutline();
    if (c.id === "shortcuts" || c.id === "help-connect") return onShortcuts();
    ACTIONS.find((a) => a.id === c.id)?.run(root);
  };
  const what = sel.length === 1 ? (sel[0].type === "arrow" ? "the selected connector" : "the selected shape") : sel.length ? `${sel.length} selected shapes` : "this diagram";
  let last = "";
  return (
    <div className="ocdg-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ocdg-pal" role="dialog" aria-modal="true" aria-label="Commands">
        <div className="ocdg-pal-in">
          <CmdIcon size={16} strokeWidth={SW} aria-hidden="true" />
          <input
            ref={ref}
            role="combobox"
            aria-expanded="true"
            aria-controls="ocdg-pal-ls"
            aria-activedescendant={list[i] ? `ocdg-pal-${i}` : undefined}
            aria-label={`Commands for ${what}`}
            placeholder={`Commands for ${what}`}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setAt(0);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setAt((i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % Math.max(1, list.length));
              } else if (e.key === "Enter" && list[i]) {
                e.preventDefault();
                run(list[i]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <kbd className="ocdg-kbd">Esc</kbd>
        </div>
        <ul className="ocdg-pal-ls" id="ocdg-pal-ls" role="listbox" aria-label="Results">
          {list.map((c, k) => {
            const head = c.group !== last && k > 0 ? c.group : k === 0 ? (c.group === "Commands" ? "Commands" : c.group) : null;
            last = c.group;
            const I = ACTIONS.find((a) => a.id === c.id)?.icon ?? Box;
            return (
              <li key={c.id} role="none">
                {head ? <div className="ocdg-pal-g" aria-hidden="true">{head}</div> : null}
                <div id={`ocdg-pal-${k}`} role="option" aria-selected={k === i} className="ocdg-pal-it" onMouseMove={() => setAt(k)} onClick={() => run(c)}>
                  <I size={16} strokeWidth={SW} aria-hidden="true" />
                  <span className="ocdg-on">{c.label}</span>
                  {c.hint ? <span className="ocdg-ok">{c.hint}</span> : null}
                  {c.keys ? <span aria-label={`Shortcut ${c.keys.join(" ")}`}><Kbd k={c.keys} /></span> : null}
                </div>
              </li>
            );
          })}
          {!list.length ? <li className="ocdg-pal-g" role="none">No matches</li> : null}
        </ul>
        <div className="ocdg-pal-ft" aria-hidden="true">
          <span><Kbd k={["↑", "↓"]} />move</span>
          <span><Kbd k={["↵"]} />run</span>
          <span><Kbd k={["Esc"]} />close</span>
          <span>Type a shape name to jump to it</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ shortcuts (5d) */

export function Shortcuts({ onClose }: { onClose: () => void }) {
  ensureA11yStyles();
  useReturnFocus();
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="ocdg-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
      <div className="ocdg-sheet" role="dialog" aria-modal="true" aria-labelledby="ocdg-ks-t">
        <div className="ocdg-sheet-hd">
          <Keyboard size={18} strokeWidth={SW} aria-hidden="true" />
          <h2 id="ocdg-ks-t">Keyboard shortcuts</h2>
          <button ref={ref} type="button" className="ocdg-ib" aria-label="Close" onClick={onClose}>
            <X size={16} strokeWidth={SW} />
          </button>
        </div>
        <div className="ocdg-sheet-g">
          {SHORTCUTS.map(([g, items]) => (
            <section key={g}>
              <h3>{g}</h3>
              <dl>
                {items.map(([l, k]) => (
                  <div key={l} className="ocdg-row">
                    <dt>{l}</dt>
                    <dd><Kbd k={k} /></dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p>Everything here also works from Commands (⌘K). On Windows and Linux, ⌘ is Ctrl.</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ keyboard connector (5c) */

/**
 * The diagram window's own keys, handled before the canvas sees them: ⌘K, ?, ⌥O, and while
 * drawing a connector Tab / arrows / Enter / Esc. Returns the state the window renders.
 */
export function useDiagramKeys(o: { doc: Y.Doc; boardId: string; canvas?: DiagramCanvas; edit: boolean; origin: unknown; connectorStyle: () => Partial<Shape>; onSay: (s: string) => void; onOutline: () => void }) {
  const [palette, setPalette] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [conn, setConn] = useState<Connecting | null>(null);
  const O = useRef(o);
  O.current = o;
  const C = useRef(conn);
  C.current = conn;
  const onKeyDownCapture = (e: RKE<HTMLElement>) => {
    const { canvas, edit, onSay } = O.current;
    const t = e.target as HTMLElement;
    const typing = !!t.closest("input,textarea,select,[contenteditable='true']");
    const mod = e.metaKey || e.ctrlKey;
    const onCanvas = !!t.classList?.contains("ocbd");
    const st = C.current;
    if (st && canvas) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Tab") {
        const n = nextTarget(canvas.shapes, st, e.shiftKey ? -1 : 1);
        setConn(n);
        onSay(connectAnnouncement(canvas.shapes, n));
      } else if (SIDE_KEYS[e.key]) {
        const n = { ...st, side: SIDE_KEYS[e.key] };
        setConn(n);
        onSay(connectAnnouncement(canvas.shapes, n));
      } else if (e.key === "Enter") {
        const ends = connectorFor(canvas.shapes, st);
        setConn(null);
        if (!ends) return onSay("Not connected");
        const a = canvas.shapes.find((s) => s.id === st.from)!, b = canvas.shapes.find((s) => s.id === st.to)!;
        const id = addShape(O.current.doc, O.current.boardId, { type: "arrow", pts: [[a.x ?? 0, a.y ?? 0], [b.x ?? 0, b.y ?? 0]], start: ends.start, end: ends.end, ...O.current.connectorStyle() }, O.current.origin);
        canvas.select([id]);
        onSay(`Connected ${a.text || "shape"} to ${b.text || "shape"}`);
      } else if (e.key === "Escape") {
        setConn(null);
        onSay("Connector cancelled");
      }
      return;
    }
    if (typing) return;
    if (mod && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      e.stopPropagation();
      setPalette(true);
    } else if (!mod && e.key === "?") {
      e.preventDefault();
      e.stopPropagation();
      setSheet(true);
    } else if (e.altKey && !mod && e.code === "KeyO") {
      e.preventDefault();
      e.stopPropagation();
      O.current.onOutline();
    } else if (onCanvas && edit && canvas && !mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "c" && canvas.sel.length === 1) {
      const n = startConnect(canvas.shapes, canvas.sel[0]);
      if (!n) return;
      e.preventDefault();
      e.stopPropagation();
      setConn(n);
      onSay(`Connecting from ${canvas.shapes.find((s) => s.id === n.from)?.text || "shape"}. ${connectAnnouncement(canvas.shapes, n)}`);
    }
  };
  return { palette, setPalette, sheet, setSheet, conn, onKeyDownCapture };
}

export function ConnectHint({ canvas, conn }: { canvas: DiagramCanvas; conn: Connecting }) {
  ensureA11yStyles();
  const from = canvas.shapes.find((s) => s.id === conn.from);
  return (
    <div className="ocdg-hintbar" role="status" aria-hidden="true">
      <b><Spline size={14} strokeWidth={SW} />Connecting from {from?.text || "shape"}</b>
      <span><Kbd k={["Tab"]} />next shape</span>
      <span><Kbd k={["←", "↑", "→", "↓"]} />side</span>
      <span><Kbd k={["↵"]} />connect</span>
      <span><Kbd k={["Esc"]} />cancel</span>
    </div>
  );
}

/** Ring drawn on the canvas around the keyboard connector's target (board coordinates in `view`). */
export { ensureA11yStyles };
