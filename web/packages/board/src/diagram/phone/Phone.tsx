// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Diagram mode on a phone (DGM-14 S11, prototype 11b-11e): full screen without side panels or
// rulers, a bottom bar (Select, Pan, Add, Outline, Undo), an action bar and small sheet for the
// selected shape, an add-a-shape sheet that can connect the new shape to the selected one, and an
// options sheet that says what needs a larger screen. Touch targets are at least 44 px (2.75rem).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import {
  Circle, Copy, Diamond, Download, Hand, Image as ImageIcon, LayoutGrid, ListTree, Maximize, Monitor, MousePointer2, Palette, Plus, Search, Spline, Square, StickyNote, Trash2, Type, Undo2, Upload, Waypoints, X, Table2,
} from "lucide-react";
import { addShape, bbox, updateShape, type Shape } from "../../model";
import { exportBoardPng, exportBoardSvg } from "../../export";
import { Outline, type DiagramCanvas } from "../A11y";
import { facingSide, kindName, shapeName } from "../keyboard";

const SW = 1.75;

/** Phone layout: the window is at most 30em wide (390 px phones, small tablets in portrait excluded). */
export const PHONE_QUERY = "(max-width: 30em)";
export function usePhone(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof matchMedia !== "function") return () => {};
      const m = matchMedia(PHONE_QUERY);
      m.addEventListener?.("change", cb);
      return () => m.removeEventListener?.("change", cb);
    },
    () => typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}

export type PhoneSheet = null | "add" | "outline" | "options" | "shape" | "connect";

export const PHONE_CSS = `
.ocdg-phone .ocbd-tool,.ocdg-phone .ocbd-zoom,.ocdg-phone .ocbd-swatch,.ocdg-phone .ocdg-rulers,.ocdg-phone .ocdg-cmdk,.ocdg-phone .ocdg-top [aria-label="Outline"],.ocdg-phone .ocdg-top [aria-label="Undo"],.ocdg-phone .ocdg-top [aria-label="Redo"]{display:none}
.ocdg-phone .ocdg-top{height:3.25rem;padding:0 .25rem}
.ocdg-phone .ocdg-back{width:2.75rem;height:2.75rem;padding:0;justify-content:center;font-size:0;gap:0}
.ocdg-phone .ocdg-ib{width:2.75rem;height:2.75rem}
.ocdg-phone .ocdg-vs{display:none}
.ocdg-phone .ocdg-crumb{flex-direction:column-reverse;align-items:flex-start;gap:0;line-height:1.2}
.ocdg-phone .ocdg-doc{display:block;font-size:.6875rem;max-width:11rem}
.ocdg-phone .ocdg-sl{display:none}
.ocdg-phone .ocdg-name{max-width:11rem}
.ocdg-phone .ocdg-people{display:flex}
.ocdg-pbar{flex:none;display:flex;justify-content:space-around;align-items:center;border-top:1px solid var(--line);background:var(--app);padding:.25rem .5rem calc(.25rem + env(safe-area-inset-bottom,0px));position:relative;z-index:6}
.ocdg-pbar button,.ocdg-pact button,.ocdg-pbtn{min-width:2.75rem;min-height:2.75rem;border:0;background:none;border-radius:.75rem;display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:.125rem;color:var(--fg-2);font-size:.6875rem;padding:0 .375rem}
.ocdg-pbar button[aria-pressed="true"]{color:var(--accent);background:var(--accent-soft)}
.ocdg-pbar button:disabled{opacity:.4}
.ocdg-pact{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(4.5rem + env(safe-area-inset-bottom,0px));z-index:6;display:flex;gap:.125rem;padding:.25rem;border-radius:1rem;background:var(--pop,var(--app));box-shadow:var(--sh-pop)}
.ocdg-pact button{color:var(--fg)}
.ocdg-pact button.danger{color:var(--red-fg)}
.ocdg-pscrim{position:fixed;inset:0;background:rgba(0,0,0,.25);z-index:30;display:flex;flex-direction:column;justify-content:flex-end}
.ocdg-psheet{background:var(--app);border-radius:1rem 1rem 0 0;box-shadow:var(--sh-pop);max-height:85vh;display:flex;flex-direction:column;padding-bottom:env(safe-area-inset-bottom,0px)}
.ocdg-psheet.half{height:55vh}
.ocdg-pgrab{width:2.25rem;height:.25rem;border-radius:1rem;background:var(--line-2);margin:.5rem auto .25rem}
.ocdg-phd{display:flex;align-items:center;gap:.5rem;padding:0 .5rem 0 1rem;min-height:3rem}
.ocdg-phd h2{flex:1;margin:0;font-size:.9375rem}
.ocdg-pbody{overflow:auto;padding:0 1rem 1rem;flex:1}
.ocdg-psearch{display:flex;align-items:center;gap:.5rem;height:2.75rem;border:1px solid var(--line-2);border-radius:.75rem;padding:0 .75rem;margin-bottom:.75rem;color:var(--fg-2)}
.ocdg-psearch input{flex:1;border:0;background:none;font:inherit;font-size:1rem;color:var(--fg);outline:none;min-width:0}
.ocdg-pgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:.5rem;margin:0 0 .75rem;padding:0;list-style:none}
.ocdg-pgrid button{width:100%;min-height:4.5rem;border:1px solid var(--line);border-radius:.75rem;background:var(--panel);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.375rem;font-size:.6875rem;color:var(--fg);padding:.25rem}
.ocdg-pg{font-size:.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--fg-2);margin:.25rem 0 .5rem}
.ocdg-plist{list-style:none;margin:0;padding:0}
.ocdg-plist button,.ocdg-plist .ocdg-pli{width:100%;min-height:2.75rem;display:flex;align-items:center;gap:.75rem;border:0;background:none;padding:0 .25rem;font-size:.9375rem;color:var(--fg);text-align:left;border-radius:.5rem}
.ocdg-plist button:disabled{color:var(--fg-2);cursor:default}
.ocdg-plist .ocdg-ptag{margin-left:auto;font-size:.75rem;color:var(--fg-2);background:var(--sunk);border-radius:1rem;padding:.125rem .5rem}
.ocdg-pnote{font-size:.8125rem;color:var(--fg-2);margin:.75rem 0 0;display:flex;gap:.5rem}
.ocdg-psw{display:flex;align-items:center;justify-content:space-between;gap:.75rem;width:100%;min-height:3rem;border:1px solid var(--line);border-radius:.75rem;background:var(--panel);padding:.375rem .75rem;margin-bottom:.75rem;text-align:left;color:var(--fg)}
.ocdg-psw small{display:block;color:var(--fg-2);font-size:.75rem}
.ocdg-tones{display:flex;gap:.5rem;flex-wrap:wrap}
.ocdg-tones button{width:2.75rem;height:2.75rem;border-radius:50%;border:0}
.ocdg-tones button[aria-pressed="true"]{outline:.15625rem solid var(--accent);outline-offset:.125rem}
.ocdg-pfield{display:flex;flex-direction:column;gap:.25rem;margin-bottom:.75rem;font-size:.75rem;color:var(--fg-2)}
.ocdg-pfield input{height:2.75rem;border:1px solid var(--line-2);border-radius:.625rem;padding:0 .75rem;font:inherit;font-size:1rem;background:var(--app);color:var(--fg)}
`;

let injected = false;
function ensurePhoneStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-ocdg-phone", "");
  s.textContent = PHONE_CSS;
  document.head.appendChild(s);
}

const TONES = ["gray", "blue", "green", "amber", "red", "purple", "pink"] as const;

/** Shapes offered on the phone (11d): one tap places it in view, or next to the selected shape. */
export const PHONE_SHAPES: { id: string; label: string; icon: typeof Square; make: () => Omit<Shape, "id"> }[] = [
  { id: "process", label: "Process", icon: Square, make: () => ({ type: "rect", w: 150, h: 64, text: "Process" }) },
  { id: "decision", label: "Decision", icon: Diamond, make: () => ({ type: "diamond", w: 140, h: 90, text: "Decision" }) },
  { id: "start", label: "Start or end", icon: Circle, make: () => ({ type: "ellipse", w: 140, h: 64, text: "Start" }) },
  { id: "sticky", label: "Sticky note", icon: StickyNote, make: () => ({ type: "sticky", w: 150, h: 110, fill: "y", text: "" }) },
  { id: "text", label: "Text", icon: Type, make: () => ({ type: "text", text: "Text", size: 18 }) },
  { id: "container", label: "Container", icon: LayoutGrid, make: () => ({ type: "rect", w: 320, h: 200, label: "Group", dashed: true }) },
];

/** Where a shape added next to `to` goes (11d: to the right, with a gap), and the connector between them. */
export function placeNextTo(to: Shape, w: number, h: number, shapes: Shape[]): { x: number; y: number } {
  const [, y0, x1, y1] = bbox(to);
  let x = x1 + 80;
  const y = (y0 + y1) / 2 - h / 2;
  // Step right past anything already there.
  for (let i = 0; i < 20; i++) {
    const hit = shapes.some((s) => s.type !== "arrow" && s.type !== "pen" && s.id !== to.id && (() => {
      const [a, b, c, d] = bbox(s);
      return a < x + w && c > x && b < y + h && d > y;
    })());
    if (!hit) break;
    x += w + 40;
  }
  return { x, y };
}

interface PhoneProps {
  doc: Y.Doc;
  boardId: string;
  canvas: DiagramCanvas;
  edit: boolean;
  origin: unknown;
  root: () => HTMLElement | null;
  sheet: PhoneSheet;
  setSheet: (s: PhoneSheet) => void;
  undo: { can: boolean; run: () => void };
  connectorStyle: () => Partial<Shape>;
  onSay: (s: string) => void;
}

function canvasKey(root: HTMLElement | null, key: string, o: KeyboardEventInit = {}) {
  const c = root?.querySelector<HTMLElement>(".ocbd");
  if (!c) return;
  c.focus({ preventScroll: true });
  c.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...o }));
}

function Sheet({ title, onClose, half, children }: { title: string; onClose: () => void; half?: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.querySelector<HTMLElement>("input,button:not([aria-label='Close'])")?.focus({ preventScroll: true }), []);
  return (
    <div className="ocdg-pscrim" onClick={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
      <div ref={ref} className={"ocdg-psheet" + (half ? " half" : "")} role="dialog" aria-modal="true" aria-label={title}>
        <div className="ocdg-pgrab" aria-hidden="true" />
        <div className="ocdg-phd">
          <h2>{title}</h2>
          <button type="button" className="ocdg-ib" aria-label="Close" onClick={onClose}>
            <X size={18} strokeWidth={SW} />
          </button>
        </div>
        <div className="ocdg-pbody">{children}</div>
      </div>
    </div>
  );
}

export function Phone(p: PhoneProps) {
  ensurePhoneStyles();
  const { doc, boardId, canvas, edit, origin, sheet, setSheet, onSay } = p;
  const [tool, setTool] = useState<"select" | "hand">("select");
  const sel = canvas.sel.length === 1 ? canvas.shapes.find((s) => s.id === canvas.sel[0]) ?? null : null;
  const node = sel && sel.type !== "arrow" && sel.type !== "pen" ? sel : null;
  const [q, setQ] = useState("");
  const [link, setLink] = useState(true);
  const close = () => setSheet(null);

  // 11b: fitted to the screen when it opens.
  useEffect(() => {
    const id = requestAnimationFrame(() => canvasKey(p.root(), "!", { shiftKey: true, code: "Digit1" }));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (t: "select" | "hand") => {
    setTool(t);
    canvasKey(p.root(), t === "select" ? "v" : "h");
  };

  const add = (make: () => Omit<Shape, "id">, label: string) => {
    const base = make();
    const w = base.w ?? 120, h = base.h ?? 40;
    const to = link && node ? node : null;
    let at: { x: number; y: number };
    if (to) at = placeNextTo(to, w, h, canvas.shapes);
    else {
      // The middle of what is in view: the board's own fit keeps content centred, so use the content's middle.
      const b = canvas.shapes.filter((s) => s.type !== "arrow").map(bbox);
      const cx = b.length ? (Math.min(...b.map((x) => x[0])) + Math.max(...b.map((x) => x[2]))) / 2 : 0;
      const cy = b.length ? (Math.min(...b.map((x) => x[1])) + Math.max(...b.map((x) => x[3]))) / 2 : 0;
      at = { x: cx - w / 2, y: cy - h / 2 };
    }
    let id = "";
    doc.transact(() => {
      id = addShape(doc, boardId, { ...base, ...at }, origin);
      if (to) {
        const n = { ...base, ...at, id } as Shape;
        addShape(doc, boardId, { type: "arrow", pts: [[0, 0], [1, 1]], start: { shapeId: to.id, anchor: facingSide(n, to) }, end: { shapeId: id, anchor: facingSide(to, n) }, ...p.connectorStyle() }, origin);
      }
    }, origin);
    canvas.select([id]);
    canvas.reveal?.(id);
    close();
    onSay(to ? `${label} added and connected to ${shapeName(to)}` : `${label} added`);
  };

  const connectTo = (b: Shape) => {
    if (!node) return;
    addShape(doc, boardId, { type: "arrow", pts: [[0, 0], [1, 1]], start: { shapeId: node.id, anchor: facingSide(b, node) }, end: { shapeId: b.id, anchor: facingSide(node, b) }, ...p.connectorStyle() }, origin);
    close();
    onSay(`Connected ${shapeName(node)} to ${shapeName(b)}`);
  };

  const save = async (fmt: "png" | "svg") => {
    const blob = fmt === "svg" ? new Blob([exportBoardSvg(doc, boardId)], { type: "image/svg+xml" }) : await exportBoardPng(doc, boardId, 2);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `board.${fmt}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    close();
  };

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? PHONE_SHAPES.filter((s) => s.label.toLowerCase().includes(t)) : PHONE_SHAPES;
  }, [q]);
  const near = useMemo(() => {
    if (!node) return [];
    const [a, b, c, d] = bbox(node);
    const cx = (a + c) / 2, cy = (b + d) / 2;
    return canvas.shapes
      .filter((s) => s.id !== node.id && s.type !== "arrow" && s.type !== "pen")
      .map((s) => {
        const [x0, y0, x1, y1] = bbox(s);
        return [s, Math.hypot((x0 + x1) / 2 - cx, (y0 + y1) / 2 - cy)] as const;
      })
      .sort((x, y) => x[1] - y[1])
      .map((x) => x[0]);
  }, [node, canvas.shapes]);
  const links = node ? canvas.shapes.filter((s) => s.type === "arrow" && (s.start?.shapeId === node.id || s.end?.shapeId === node.id)).length : 0;

  return (
    <>
      <PhoneBar edit={edit} tool={tool} onTool={pick} onAdd={() => setSheet("add")} onOutline={() => setSheet("outline")} undo={p.undo} />
      {node && edit && !sheet ? (
        <div className="ocdg-pact" role="toolbar" aria-label={`${shapeName(node)} actions`}>
          <button type="button" aria-label="Edit text" onClick={() => canvasKey(p.root(), "Enter")}>
            <Type size={20} strokeWidth={SW} />
          </button>
          <button type="button" aria-label="Name and colour" onClick={() => setSheet("shape")}>
            <Palette size={20} strokeWidth={SW} />
          </button>
          <button type="button" aria-label="Connect" onClick={() => setSheet("connect")}>
            <Spline size={20} strokeWidth={SW} />
          </button>
          <button type="button" aria-label="Duplicate" onClick={() => canvasKey(p.root(), "d", { ctrlKey: true })}>
            <Copy size={20} strokeWidth={SW} />
          </button>
          <button type="button" className="danger" aria-label="Delete" onClick={() => canvasKey(p.root(), "Delete")}>
            <Trash2 size={20} strokeWidth={SW} />
          </button>
        </div>
      ) : null}

      {sheet === "shape" && node ? (
        <Sheet title={shapeName(node)} onClose={close}>
          <p className="ocdg-pnote" style={{ marginTop: 0 }}>{kindName(node)} · {links} {links === 1 ? "connection" : "connections"}</p>
          <label className="ocdg-pfield">
            Name
            <input defaultValue={node.text ?? node.label ?? ""} onBlur={(e) => updateShape(doc, boardId, node.id, node.label && !node.text ? { label: e.target.value } : { text: e.target.value }, origin)} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />
          </label>
          {node.type === "rect" || node.type === "ellipse" || node.type === "diamond" ? (
            <>
              <div className="ocdg-pg" id="ocdg-ptone">Colour</div>
              <div className="ocdg-tones" role="group" aria-labelledby="ocdg-ptone">
                {TONES.map((c) => (
                  <button key={c} type="button" aria-label={c[0].toUpperCase() + c.slice(1)} aria-pressed={node.fill === c} style={{ background: `var(--${c}-bg)`, boxShadow: `inset 0 0 0 .125rem var(--${c}-fg)` }} onClick={() => updateShape(doc, boardId, node.id, { fill: c }, origin)} />
                ))}
              </div>
            </>
          ) : null}
        </Sheet>
      ) : null}

      {sheet === "connect" && node ? (
        <Sheet title={`Connect ${shapeName(node)} to`} onClose={close} half>
          <ul className="ocdg-plist">
            {near.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => connectTo(s)}>
                  <Square size={18} strokeWidth={SW} aria-hidden="true" />
                  {shapeName(s)}
                  <span className="ocdg-ptag">{kindName(s)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      ) : null}

      {sheet === "add" ? (
        <Sheet title="Add a shape" onClose={close} half>
          <label className="ocdg-psearch">
            <Search size={18} strokeWidth={SW} aria-hidden="true" />
            <input aria-label="Search shapes" placeholder="Search shapes" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          {node ? (
            <button type="button" role="switch" aria-checked={link} className="ocdg-psw" onClick={() => setLink(!link)}>
              <span>
                Connect it to {shapeName(node)}
                <small>Placed to the right, with a connector</small>
              </span>
              <span className="ocdg-tgl" aria-hidden="true" />
            </button>
          ) : null}
          <div className="ocdg-pg">Basic</div>
          <ul className="ocdg-pgrid">
            {shown.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => add(s.make, s.label)}>
                  <s.icon size={22} strokeWidth={SW} aria-hidden="true" />
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
          {!shown.length ? <p className="ocdg-pnote">No shapes match.</p> : null}
        </Sheet>
      ) : null}

      {sheet === "outline" ? (
        <Sheet title="Outline" onClose={close}>
          <Outline doc={doc} boardId={boardId} canvas={{ ...canvas, select: (ids) => (canvas.select(ids), ids[0] && canvas.reveal?.(ids[0]), close()) }} edit={edit} origin={origin} onSay={onSay} />
        </Sheet>
      ) : null}

      {sheet === "options" ? (
        <Sheet title="Diagram" onClose={close}>
          <ul className="ocdg-plist">
            <li><button type="button" onClick={() => setSheet("outline")}><ListTree size={18} strokeWidth={SW} aria-hidden="true" />Outline</button></li>
            <li><button type="button" onClick={() => (close(), canvasKey(p.root(), "!", { shiftKey: true, code: "Digit1" }))}><Maximize size={18} strokeWidth={SW} aria-hidden="true" />Zoom to fit</button></li>
            <li><button type="button" onClick={() => void save("png")}><ImageIcon size={18} strokeWidth={SW} aria-hidden="true" />Export as PNG</button></li>
            <li><button type="button" onClick={() => void save("svg")}><Download size={18} strokeWidth={SW} aria-hidden="true" />Export as SVG</button></li>
          </ul>
          <div className="ocdg-pg" style={{ marginTop: ".75rem" }}>On a computer</div>
          <ul className="ocdg-plist">
            {([[LayoutGrid, "Auto-layout"], [Upload, "Import Mermaid or draw.io"], [Waypoints, "Edit connector bends"], [Table2, "Edit attributes and columns"]] as const).map(([I, l]) => (
              <li key={l}>
                <button type="button" disabled aria-describedby="ocdg-plarge">
                  <I size={18} strokeWidth={SW} aria-hidden="true" />
                  {l}
                  <span className="ocdg-ptag">Larger screen</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="ocdg-pnote" id="ocdg-plarge">
            <Monitor size={16} strokeWidth={SW} aria-hidden="true" />
            Big diagrams are easier on a computer. On a phone you can view, move, rename, recolour, add and connect shapes.
          </p>
        </Sheet>
      ) : null}
    </>
  );
}

/** The bottom bar (11b): Select, Pan, Add, Outline, Undo. Rendered below the canvas. */
export function PhoneBar({ edit, tool, onTool, onAdd, onOutline, undo }: { edit: boolean; tool: "select" | "hand"; onTool: (t: "select" | "hand") => void; onAdd: () => void; onOutline: () => void; undo: { can: boolean; run: () => void } }) {
  ensurePhoneStyles();
  return (
    <nav className="ocdg-pbar" aria-label="Diagram tools">
      <button type="button" aria-pressed={tool === "select"} onClick={() => onTool("select")}>
        <MousePointer2 size={20} strokeWidth={SW} aria-hidden="true" />
        Select
      </button>
      <button type="button" aria-pressed={tool === "hand"} onClick={() => onTool("hand")}>
        <Hand size={20} strokeWidth={SW} aria-hidden="true" />
        Pan
      </button>
      {edit ? (
        <button type="button" onClick={onAdd}>
          <Plus size={20} strokeWidth={SW} aria-hidden="true" />
          Add
        </button>
      ) : null}
      <button type="button" onClick={onOutline}>
        <ListTree size={20} strokeWidth={SW} aria-hidden="true" />
        Outline
      </button>
      {edit ? (
        <button type="button" disabled={!undo.can} onClick={undo.run}>
          <Undo2 size={20} strokeWidth={SW} aria-hidden="true" />
          Undo
        </button>
      ) : null}
    </nav>
  );
}
