// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The empty board (board UX prototype 9a, decision 11). Editors get the three things people look
// for (draw, double-click to type, the shortcuts), three starter templates and a pointer at the
// tools; it goes with the first shape. View-only people see "This board is empty" and nothing else.
import * as Y from "yjs";
import { ChevronDown, Circle, MousePointerClick, Shapes, StickyNote, Workflow, type LucideIcon } from "lucide-react";
import { addShape } from "../model";
import { TEMPLATES, type Template } from "./templates";

const SW = 1.75;
const ICON: Record<Template["id"], LucideIcon> = { retro: StickyNote, flow: Workflow, brain: Circle };

/** Inserts a template centred on (cx, cy) in one transaction (one Undo step). Returns the new ids. */
export function insertTemplate(doc: Y.Doc, boardId: string, t: Template, cx: number, cy: number, origin: unknown): string[] {
  const list = t.build(Math.round(cx), Math.round(cy));
  doc.transact(() => list.forEach((s) => addShape(doc, boardId, s, origin)), origin);
  return list.map((s) => s.id);
}

export function EmptyBoard({ edit, onTemplate }: { edit: boolean; onTemplate: (t: Template) => void }) {
  ensureStyles();
  if (!edit) return <div className="ocbd-empty">This board is empty</div>;
  return (
    <>
      <div className="ocbd-empty ocbd-empty2">
        <Shapes size={28} strokeWidth={1.5} aria-hidden="true" />
        <h3>Start your board</h3>
        <p>Pick a tool below and drag to draw, or double-click anywhere to type.</p>
        <div className="ocbd-ehints">
          <span>
            <MousePointerClick size={14} strokeWidth={SW} aria-hidden="true" />
            Right-click for more
          </span>
          <span>
            <kbd>N</kbd> sticky note
          </span>
          <span>
            <kbd>F</kbd> frame
          </span>
          <span>
            <kbd>?</kbd> all shortcuts
          </span>
        </div>
        <div className="ocbd-etpl" role="group" aria-label="Start from a template">
          {TEMPLATES.map((t) => {
            const I = ICON[t.id];
            return (
              <button key={t.id} type="button" onClick={() => onTemplate(t)}>
                <I size={16} strokeWidth={SW} aria-hidden="true" />
                {t.name}
              </button>
            );
          })}
        </div>
      </div>
      <div className="ocbd-ehint" aria-hidden="true">
        <ChevronDown size={14} strokeWidth={SW} />
        Tools
      </div>
    </>
  );
}

const CSS = `
.ocbd-empty2{gap:.625rem;max-width:30rem}
.ocbd-empty2 svg{color:var(--fg-3)}
.ocbd-empty2 h3{margin:0;font-size:1rem;font-weight:600;color:var(--fg)}
.ocbd-empty2 p{margin:0;color:var(--fg-2);font-size:.8438rem}
.ocbd-ehints{display:flex;flex-wrap:wrap;justify-content:center;gap:.375rem .875rem;font-size:.75rem;color:var(--fg-3)}
.ocbd-ehints span{display:inline-flex;align-items:center;gap:.3125rem}
.ocbd-ehints kbd{font:inherit;font-size:.6875rem;font-weight:600;min-width:1.25rem;padding:.0625rem .3125rem;border:1px solid var(--line-2);border-radius:.3125rem;background:var(--app);color:var(--fg-2);text-align:center}
.ocbd-etpl{display:flex;flex-wrap:wrap;justify-content:center;gap:.5rem;margin-top:.25rem;pointer-events:auto}
.ocbd-etpl button{display:inline-flex;align-items:center;gap:.375rem;min-height:2.25rem;padding:0 .875rem;border:1px solid var(--line-2);border-radius:.5rem;background:var(--app);color:var(--fg);font:inherit;font-size:.8125rem;font-weight:500;cursor:pointer}
.ocbd-etpl button:hover{background:var(--hover)}
.ocbd-etpl button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.ocbd-etpl button svg{color:var(--fg-2)}
.ocbd-ehint{position:absolute;left:50%;bottom:4rem;transform:translateX(-50%);display:flex;align-items:center;gap:.25rem;font-size:.75rem;color:var(--fg-3);pointer-events:none}
@media (max-height:22em){.ocbd-ehints,.ocbd-ehint{display:none}}
`;
let injected = false;
function ensureStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-ocbd-empty", "");
  s.textContent = CSS;
  document.head.appendChild(s);
}
