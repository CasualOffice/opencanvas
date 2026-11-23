// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Auto-layout UI (DGM-14.6, approved frames 6a–6c): the top-bar button and ⇧L, the options popover,
// the preview overlay (dashed current outlines, proposed boxes in accent) with its bar, and Apply
// as one transaction with an Undo toast. Nothing is written until Apply; others never see the
// preview. Dagre loads the first time the popover opens.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { ChevronDown, LayoutDashboard, ArrowDown, ArrowRight } from "lucide-react";
import type { BlockEnv } from "@opencanvas/ui";
import { getBoardMap, readShapes, type Shape } from "../../model";
import { computeLayout, containerIds, DEFAULT_LAYOUT, type DagreLike, type LayoutOptions, type LayoutPlan } from "./compute";
import { applyLayout } from "./apply";
import { loadDagre } from "./load";

const SW = 1.75;

export interface LayoutView {
  tx: number;
  ty: number;
  z: number;
}

export interface AutoLayoutProps {
  doc: Y.Doc;
  boardId: string;
  env: BlockEnv;
  origin: unknown;
  /** The canvas viewport (board → screen) and the current selection. */
  view?: LayoutView;
  selection?: string[];
  /** Undo of this view (the toast's Undo). */
  undo: () => void;
}

type Scope = "all" | "selection" | "container";

const nameOf = (s: Shape) => (s.label || s.text || "Container").replace(/\s+/g, " ").trim().slice(0, 40);

/** "12 shapes move, 2 containers resize." */
export function planSummary(p: LayoutPlan): string {
  const parts: string[] = [];
  if (p.shapes) parts.push(`${p.shapes} ${p.shapes === 1 ? "shape moves" : "shapes move"}`);
  if (p.containers) parts.push(`${p.containers} ${p.containers === 1 ? "container resizes" : "containers resize"}`);
  return parts.length ? `${parts.join(", ")}.` : "Everything is already in place.";
}

export default function AutoLayout(p: AutoLayoutProps) {
  ensureLayoutStyles();
  const { doc, boardId, env } = p;
  const live = useRef(false);
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<LayoutOptions["direction"]>(DEFAULT_LAYOUT.direction);
  const [spacing, setSpacing] = useState<LayoutOptions["spacing"]>(DEFAULT_LAYOUT.spacing);
  const [scope, setScope] = useState<Scope>("all");
  const [container, setContainer] = useState("");
  const [keepContainers, setKeepContainers] = useState(true);
  const [keepBends, setKeepBends] = useState(false);
  const [dagre, setDagre] = useState<DagreLike | null>(null);
  const [plan, setPlan] = useState<LayoutPlan | null>(null);
  const [notice, setNotice] = useState("");
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const sel = useMemo(() => p.selection ?? [], [p.selection]);

  const shapes = useCallback(() => {
    const m = getBoardMap(doc, boardId);
    return m ? readShapes(m) : [];
  }, [doc, boardId]);
  const containers = useMemo(() => {
    if (!open) return [];
    const all = shapes();
    const ids = containerIds(all);
    return all.filter((s) => ids.has(s.id)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || (a.id < b.id ? -1 : 1));
  }, [open, shapes]);

  const options = useCallback((): LayoutOptions => {
    const sc: LayoutOptions["scope"] =
      scope === "selection" ? { kind: "selection", ids: sel } : scope === "container" && container ? { kind: "container", id: container } : { kind: "all" };
    return { direction: dir, spacing, scope: sc, keepContainers, keepBends };
  }, [dir, spacing, scope, sel, container, keepContainers, keepBends]);

  // Opening loads Dagre (lazy chunk, ADR-047 §5).
  useEffect(() => {
    if (open && !dagre) void loadDagre().then(setDagre, () => env.toast("Couldn't load auto-layout"));
  }, [open, dagre, env]);

  const run = useCallback(() => (dagre ? computeLayout(dagre, shapes(), options()) : null), [dagre, shapes, options]);

  const preview = () => {
    const next = run();
    if (!next) return;
    setOpen(false);
    setNotice("");
    live.current = true;
    setPlan(next);
  };
  const cancel = useCallback(() => {
    live.current = false;
    setPlan(null);
    setNotice("");
    btn.current?.focus();
  }, []);
  const apply = useCallback(() => {
    const cur = run();
    live.current = false;
    setPlan(null);
    setNotice("");
    btn.current?.focus();
    if (!cur || !cur.moves.length) return env.toast("Everything is already in place.");
    applyLayout(doc, boardId, cur, keepBends, p.origin);
    const n = cur.shapes + cur.containers;
    env.toast(`Layout applied to ${n} ${n === 1 ? "shape" : "shapes"}. Undo puts them all back.`, { label: "Undo", run: p.undo });
  }, [run, env, doc, boardId, keepBends, p.origin, p.undo]);

  // Someone edits during the preview: work it out again and say so (6b).
  useEffect(() => {
    if (!plan) return;
    const m = getBoardMap(doc, boardId);
    if (!m) return;
    const h = () => {
      if (!live.current) return;
      const next = run();
      if (next) setPlan(next);
      setNotice("The board changed. The preview was updated.");
    };
    m.observeDeep(h);
    return () => m.unobserveDeep(h);
  }, [plan !== null, doc, boardId, run]); // eslint-disable-line react-hooks/exhaustive-deps

  // ⇧L opens the options; in the preview Esc cancels and Enter applies.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (plan) {
        if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), cancel());
        else if (e.key === "Enter" && !typing) (e.preventDefault(), e.stopPropagation(), apply());
        return;
      }
      if (open && e.key === "Escape") return e.stopPropagation(), setOpen(false), btn.current?.focus();
      if (!typing && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "L" || e.key === "l")) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [plan, open, cancel, apply]);

  // Clicking outside closes the popover.
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", h, true);
    return () => document.removeEventListener("pointerdown", h, true);
  }, [open]);
  useEffect(() => {
    if (open) pop.current?.querySelector<HTMLElement>("[aria-checked=\"true\"]")?.focus();
  }, [open]);

  const canSel = sel.length >= 2;
  const ready = !!dagre && (scope !== "container" || !!container) && (scope !== "selection" || canSel);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="ocdg-lb"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts="Shift+L"
        title="Auto-layout (⇧L)"
        disabled={!!plan}
        onClick={() => setOpen((o) => !o)}
      >
        <LayoutDashboard size={16} strokeWidth={SW} />
        <span className="ocdg-lbt">Auto-layout</span>
        <ChevronDown size={14} strokeWidth={SW} />
      </button>
      {open ? (
        <div ref={pop} className="ocdg-pop" role="dialog" aria-label="Auto-layout" aria-describedby="ocdg-al-d">
          <h2 className="ocdg-ph">Auto-layout</h2>
          <p className="ocdg-hint ocdg-pd" id="ocdg-al-d">Arranges shapes in layers that follow the connectors.</p>
          <div className="ocdg-pf">
            <span className="ocdg-lbl" id="ocdg-al-dir">Direction</span>
            <div className="ocdg-seg" role="radiogroup" aria-labelledby="ocdg-al-dir">
              {([["down", "Down", ArrowDown], ["right", "Right", ArrowRight]] as const).map(([v, l, I]) => (
                <button key={v} type="button" role="radio" aria-checked={dir === v} onClick={() => setDir(v)}>
                  <I size={14} strokeWidth={SW} aria-hidden="true" /> {l}
                </button>
              ))}
            </div>
          </div>
          <div className="ocdg-pf">
            <span className="ocdg-lbl" id="ocdg-al-sp">Spacing</span>
            <div className="ocdg-seg" role="radiogroup" aria-labelledby="ocdg-al-sp">
              {([["compact", "Compact"], ["normal", "Normal"], ["roomy", "Roomy"]] as const).map(([v, l]) => (
                <button key={v} type="button" role="radio" aria-checked={spacing === v} onClick={() => setSpacing(v)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <fieldset className="ocdg-pf ocdg-fs">
            <legend className="ocdg-lbl">Arrange</legend>
            <label className="ocdg-rad">
              <input type="radio" name="ocdg-al-scope" checked={scope === "all"} onChange={() => setScope("all")} /> The whole diagram
            </label>
            <label className="ocdg-rad" aria-disabled={!canSel}>
              <input type="radio" name="ocdg-al-scope" checked={scope === "selection"} disabled={!canSel} onChange={() => setScope("selection")} /> Selected shapes
              {!canSel ? <span className="ocdg-hint ocdg-in">Select two or more first</span> : null}
            </label>
            <label className="ocdg-rad" aria-disabled={!containers.length}>
              <input type="radio" name="ocdg-al-scope" checked={scope === "container"} disabled={!containers.length} onChange={() => {
                setScope("container");
                setContainer((c) => c || (sel.length === 1 && containers.some((s) => s.id === sel[0]) ? sel[0]! : containers[0]?.id ?? ""));
              }} /> Inside a container…
            </label>
            {scope === "container" ? (
              <select className="ocdg-inp" aria-label="Container" value={container} onChange={(e) => setContainer(e.target.value)}>
                {containers.map((s) => (
                  <option key={s.id} value={s.id}>{nameOf(s)}</option>
                ))}
              </select>
            ) : null}
          </fieldset>
          <div className="ocdg-pf">
            <button type="button" role="switch" aria-checked={keepContainers} className="ocdg-sw" onClick={() => setKeepContainers(!keepContainers)}>
              <span className="ocdg-swt">Keep shapes in their containers</span>
              <span className="ocdg-tgl" aria-hidden="true" />
            </button>
            <button type="button" role="switch" aria-checked={keepBends} className="ocdg-sw" onClick={() => setKeepBends(!keepBends)}>
              <span className="ocdg-swt">
                Keep your bends
                <span className="ocdg-hint">{keepBends ? "On: bends are kept" : "Off: connectors are routed again"}</span>
              </span>
              <span className="ocdg-tgl" aria-hidden="true" />
            </button>
          </div>
          <div className="ocdg-pa">
            <button type="button" className="ocdg-pri" disabled={!ready} onClick={preview}>
              {dagre ? "Preview" : "Loading…"}
            </button>
            <span className="ocdg-hint">Nothing changes until you apply.</span>
          </div>
        </div>
      ) : null}
      {plan ? <Preview plan={plan} view={p.view} dir={dir} notice={notice} onCancel={cancel} onApply={apply} /> : null}
    </>
  );
}

/** The proposed layout over the canvas (6b): dashed outlines where shapes are now, accent boxes where they would go. */
function Preview({ plan, view, dir, notice, onCancel, onApply }: { plan: LayoutPlan; view?: LayoutView; dir: LayoutOptions["direction"]; notice: string; onCancel: () => void; onApply: () => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    const find = () => document.querySelector(".ocdg-mid .ocbd-svg")?.getBoundingClientRect() ?? null;
    setRect(find());
    const h = () => setRect(find());
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  const v = view ?? { tx: 0, ty: 0, z: 1 };
  const box = (b: [number, number, number, number]) => ({ x: b[0] * v.z + v.tx, y: b[1] * v.z + v.ty, width: b[2] * v.z, height: b[3] * v.z });
  return (
    <>
      {rect ? (
        <svg className="ocdg-prev" data-testid="layout-preview" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} aria-hidden="true">
          {plan.moves.map((m) => (
            <rect key={"f" + m.id} {...box(m.from)} rx={4} fill="none" stroke="var(--fg-3)" strokeDasharray="4 3" />
          ))}
          {plan.moves.map((m) => (
            <rect key={"t" + m.id} data-to={m.id} {...box(m.to)} rx={4} fill="var(--accent-soft)" fillOpacity={0.55} stroke="var(--accent)" strokeWidth={1.5} />
          ))}
        </svg>
      ) : null}
      <div className="ocdg-pbar" role="region" aria-label="Layout preview">
        <div className="ocdg-pbt">
          <strong>Preview · {dir === "right" ? "left to right" : "top to bottom"}</strong>
          <span>{planSummary(plan)} Dashed outlines show where shapes are now.</span>
          <span className="ocdg-sr" role="status">{notice}</span>
          {notice ? <span className="ocdg-pnote" aria-hidden="true">{notice}</span> : null}
        </div>
        <button type="button" className="ocdg-sec-b" onClick={onCancel} aria-keyshortcuts="Escape">Cancel</button>
        <button type="button" className="ocdg-pri" onClick={onApply} aria-keyshortcuts="Enter">Apply</button>
      </div>
    </>
  );
}

export const LAYOUT_CSS = `
.ocdg-lb{display:inline-flex;align-items:center;gap:.375rem;height:2rem;padding:0 .5rem 0 .625rem;border:1px solid var(--line-2);border-radius:.5rem;background:var(--app);color:var(--fg);font-size:.8125rem;font-weight:500;margin-right:.25rem;white-space:nowrap}
.ocdg-lb:hover{background:var(--hover)}
.ocdg-lb[aria-expanded="true"]{background:var(--press)}
.ocdg-lb:disabled{opacity:.5}
.ocdg-pop{position:absolute;top:2.75rem;right:6rem;z-index:5;width:19rem;max-width:calc(100vw - 1rem);max-height:calc(100vh - 4rem);overflow:auto;background:var(--pop);border-radius:.75rem;box-shadow:var(--sh-pop);padding:.875rem 0 .75rem}
.ocdg-pd{padding:0 1rem;margin:-.25rem 0 .5rem}
.ocdg-pf{padding:.375rem 1rem;display:flex;flex-direction:column;gap:.375rem;border:0;margin:0;min-width:0}
.ocdg-fs legend{padding:0;margin-bottom:.25rem}
.ocdg-seg button{display:inline-flex;align-items:center;justify-content:center;gap:.25rem}
.ocdg-rad{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem;min-height:1.75rem;font-size:.8125rem}
.ocdg-rad[aria-disabled="true"]{color:var(--fg-2)}
.ocdg-rad input{margin:0;accent-color:var(--accent)}
.ocdg-in{margin:0 0 0 auto}
.ocdg-pa{display:flex;align-items:center;gap:.75rem;padding:.625rem 1rem 0;border-top:1px solid var(--line);margin-top:.375rem}
.ocdg-pri{height:2rem;padding:0 .875rem;border:0;border-radius:.5rem;background:var(--accent);color:var(--accent-fg)!important;font-size:.8125rem;font-weight:500}
.ocdg-pri:disabled{opacity:.5;cursor:default}
.ocdg-sec-b{height:2rem;padding:0 .875rem;border:1px solid var(--line-2);border-radius:.5rem;background:var(--app);font-size:.8125rem}
.ocdg-sec-b:hover{background:var(--hover)}
.ocdg-prev{position:fixed;pointer-events:none;z-index:2;overflow:hidden}
.ocdg-pbar{position:absolute;left:50%;bottom:1rem;transform:translateX(-50%);z-index:4;display:flex;align-items:center;gap:.5rem;max-width:calc(100% - 2rem);padding:.5rem .5rem .5rem .875rem;background:var(--pop);border-radius:.75rem;box-shadow:var(--sh-pop);font-size:.8125rem}
.ocdg-pbt{display:flex;flex-direction:column;min-width:0;margin-right:.5rem}
.ocdg-pbt span{color:var(--fg-2);font-size:.75rem}
.ocdg-pbt .ocdg-pnote{color:var(--accent)}
/* Editor toasts and dialogs show above diagram mode (the toast's Undo, Import into this diagram). */
body:has(>.ocdg) .toasts{position:fixed;z-index:1010}
body:has(>.ocdg) .scrim{position:fixed;z-index:1005}
body:has(>.ocdg) .modal{position:fixed;z-index:1006}
@media (max-width:45em){.ocdg-lbt{display:none}.ocdg-pop{right:.5rem}.ocdg-pbar{left:.5rem;right:.5rem;transform:none;flex-wrap:wrap}}
`;

let injected = false;
export function ensureLayoutStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-ocdg-layout", "");
  s.textContent = LAYOUT_CSS;
  document.head.appendChild(s);
}

// Injected when the diagram chunk loads, so toasts show above diagram mode for every role.
ensureLayoutStyles();
