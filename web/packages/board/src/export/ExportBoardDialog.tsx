// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The whiteboard export dialog (BRD-20, board UX prototype 6a, decision 7). Loaded on demand.
// Format PNG / SVG, Background None / Light / Dark (Light by default, the last choice remembered),
// "Colours drawn for" when transparent, Scale 1-3x for PNG, and What: the whole board, the
// selection or one frame. Copy puts the picture on the clipboard; where the browser can't, the
// dialog says so and offers Download.
import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { Copy, Download, X } from "lucide-react";
import type { Shape } from "../model";
import { isContainer } from "../kinds";
import { copyImage, download } from "./clipboard";
import { readExportBg, writeExportBg } from "./prefs";
import { describe, fileName, pixelSize, render, type ExportChoice } from "./run";
import { exportScope, type ExportScope } from "./scope";

const SW = 1.75;
const frameName = (s: Shape) => String(s.label || s.text || "Frame").slice(0, 80);

export interface ExportBoardDialogProps {
  doc: Y.Doc;
  shapes: Shape[];
  selection: string[];
  /** The scope to open with (the selection when there is one). */
  scope?: ExportScope;
  name?: string;
  toast: (m: string) => void;
  onClose: () => void;
}

function Seg<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="ocbd-xf">
      <span className="ocbd-xl" aria-hidden="true">{label}</span>
      <div className="ocbd-xseg" role="radiogroup" aria-label={label}>
        {options.map(([v, l]) => (
          <button key={String(v)} type="button" role="radio" aria-checked={v === value} tabIndex={v === value ? 0 : -1} onClick={() => onChange(v)}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ExportBoardDialog({ doc, shapes, selection, scope: initial, name = "board", toast, onClose }: ExportBoardDialogProps) {
  ensureStyles();
  const [c, setC] = useState<ExportChoice>(() => ({ fmt: "png", bg: readExportBg(), ink: "light", scale: 2 }));
  const [scope, setScope] = useState<ExportScope>(initial ?? (selection.length ? "selection" : "board"));
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const frames = useMemo(() => shapes.filter((s) => isContainer(s)), [shapes]);
  const list = useMemo(() => exportScope(shapes, scope, selection), [shapes, scope, selection]);
  const set = (p: Partial<ExportChoice>) => {
    setFailed(false);
    setC((o) => ({ ...o, ...p }));
    if (p.bg) writeExportBg(p.bg);
  };

  // The preview is the SVG export itself, shown as an image (never inline markup).
  useEffect(() => {
    let url: string | null = null;
    let live = true;
    void render(doc, list, { ...c, fmt: "svg" }).then((b) => {
      if (!live || typeof URL.createObjectURL !== "function") return;
      url = URL.createObjectURL(b);
      setPreview(url);
    });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [doc, list, c.bg, c.ink]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => box.current?.querySelector<HTMLElement>("[role=radio][aria-checked=true]")?.focus(), []);

  const [w, h] = pixelSize(list, c);
  const what = scope === "selection" ? "selection" : scope.startsWith("f:") ? "frame" : "board";
  const save = async () => {
    try {
      download(await render(doc, list, c), fileName(name, c.fmt));
      toast(`Exported as ${describe(c)}`);
    } catch {
      toast(`Couldn't export the ${what} as ${c.fmt.toUpperCase()}`);
    }
  };
  const copy = async () => {
    const ok = await copyImage(render(doc, list, c), c.fmt === "png" ? "image/png" : "image/svg+xml");
    if (ok) {
      toast(`Copied as ${describe(c)}`);
      onClose();
    } else setFailed(true);
  };

  return (
    <div className="ocbd-xscrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className="ocbd-xd"
        role="dialog"
        aria-modal="true"
        aria-label={`Export ${what}`}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
          const t = e.target as HTMLElement;
          if (t.getAttribute("role") === "radio" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
            const sib = (e.key === "ArrowRight" ? t.nextElementSibling : t.previousElementSibling) as HTMLElement | null;
            if (sib) {
              e.preventDefault();
              sib.click();
              requestAnimationFrame(() => sib.focus());
            }
          }
        }}
      >
        <div className="ocbd-xh">
          <Download size={16} strokeWidth={SW} aria-hidden="true" />
          <h3>Export {what}</h3>
          <button type="button" className="ocbd-ib" aria-label="Close" onClick={onClose}>
            <X size={16} strokeWidth={SW} />
          </button>
        </div>
        <div className="ocbd-xg">
          <div className={`ocbd-xprev${c.bg === "transparent" ? " tr" : ""}${(c.bg === "transparent" ? c.ink : c.bg) === "dark" ? " dk" : ""}`}>
            {preview ? <img src={preview} alt={`Preview of the ${what}`} /> : null}
          </div>
          <div className="ocbd-xfs">
            <Seg label="Format" value={c.fmt} options={[["png", "PNG"], ["svg", "SVG"]]} onChange={(fmt) => set({ fmt })} />
            <Seg label="Background" value={c.bg} options={[["transparent", "None"], ["light", "Light"], ["dark", "Dark"]]} onChange={(bg) => set({ bg })} />
            {c.bg === "transparent" ? <Seg label="Colours drawn for" value={c.ink} options={[["light", "Light page"], ["dark", "Dark page"]]} onChange={(ink) => set({ ink })} /> : null}
            {c.fmt === "png" ? <Seg label="Scale" value={c.scale} options={[[1, "1×"], [2, "2×"], [3, "3×"]]} onChange={(scale) => set({ scale })} /> : null}
            <label className="ocbd-xf">
              <span className="ocbd-xl">What</span>
              <select value={scope} onChange={(e) => setScope(e.target.value as ExportScope)}>
                <option value="board">Whole board</option>
                <option value="selection" disabled={!selection.length}>Selection{selection.length ? ` (${selection.length})` : ""}</option>
                {frames.map((f) => (
                  <option key={f.id} value={`f:${f.id}`}>Frame: {frameName(f)}</option>
                ))}
              </select>
            </label>
            <p className="ocbd-xmeta">
              {w} × {h} px · {list.length} shape{list.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        {failed ? (
          <p className="ocbd-xerr" role="alert">
            This browser can’t copy images to the clipboard. Download the {c.fmt.toUpperCase()} instead.
          </p>
        ) : null}
        <div className="ocbd-xa">
          <button type="button" className="ocbd-xb" onClick={() => void copy()}>
            <Copy size={15} strokeWidth={SW} aria-hidden="true" />
            Copy {c.fmt.toUpperCase()}
          </button>
          <button type="button" className="ocbd-xb pri" onClick={() => void save()}>
            <Download size={15} strokeWidth={SW} aria-hidden="true" />
            Download
          </button>
        </div>
      </div>
    </div>
  );
}

const CSS = `
.ocbd-xscrim{position:absolute;inset:0;z-index:30;background:rgba(10,10,15,.32);display:grid;place-items:center;padding:1rem}
.ocbd-xd{width:38rem;max-width:100%;max-height:calc(100% - 1rem);overflow:auto;background:var(--pop);color:var(--fg);border-radius:.875rem;box-shadow:var(--sh-pop);padding:1rem 1.25rem;display:flex;flex-direction:column;gap:.875rem}
.ocbd-xh{display:flex;align-items:center;gap:.5rem}
.ocbd-xh h3{flex:1;margin:0;font-size:1rem;font-weight:600}
.ocbd-xg{display:grid;grid-template-columns:minmax(0,1fr) 15rem;gap:1rem}
.ocbd-xprev{border:1px solid var(--line-2);border-radius:.625rem;min-height:10rem;display:grid;place-items:center;padding:.75rem;background:#fff}
.ocbd-xprev.dk{background:#141417}
.ocbd-xprev.tr{background-color:#fff;background-image:linear-gradient(45deg,#eee 25%,transparent 25%),linear-gradient(-45deg,#eee 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#eee 75%),linear-gradient(-45deg,transparent 75%,#eee 75%);background-size:1rem 1rem;background-position:0 0,0 .5rem,.5rem -.5rem,-.5rem 0}
.ocbd-xprev.tr.dk{background-color:#2a2a30;background-image:linear-gradient(45deg,#33333a 25%,transparent 25%),linear-gradient(-45deg,#33333a 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#33333a 75%),linear-gradient(-45deg,transparent 75%,#33333a 75%)}
.ocbd-xprev img{max-width:100%;max-height:16rem;display:block}
.ocbd-xfs{display:flex;flex-direction:column;gap:.75rem}
.ocbd-xf{display:flex;flex-direction:column;gap:.3125rem}
.ocbd-xl{font-size:.75rem;font-weight:600;color:var(--fg-2)}
.ocbd-xseg{display:flex;background:var(--sunk);border-radius:.5rem;padding:.1875rem;gap:.125rem}
.ocbd-xseg button{flex:1;min-height:2rem;border:0;border-radius:.375rem;background:none;color:var(--fg-2);font:inherit;font-size:.8125rem;cursor:pointer}
.ocbd-xseg button[aria-checked=true]{background:var(--app);color:var(--fg);box-shadow:0 1px 2px rgba(0,0,0,.12);font-weight:600}
.ocbd-xf select{min-height:2.25rem;border:1px solid var(--line-2);border-radius:.5rem;background:var(--app);color:var(--fg);font:inherit;font-size:.8125rem;padding:0 .5rem}
.ocbd-xmeta{margin:0;font-size:.75rem;color:var(--fg-3);font-variant-numeric:tabular-nums}
.ocbd-xerr{margin:0;color:var(--red-fg);font-size:.8125rem}
.ocbd-xa{display:flex;justify-content:flex-end;gap:.5rem}
.ocbd-xb{display:inline-flex;align-items:center;gap:.375rem;min-height:2.25rem;padding:0 .875rem;border:1px solid var(--line-2);border-radius:.5rem;background:var(--app);color:var(--fg);font:inherit;font-size:.8125rem;font-weight:500;cursor:pointer}
.ocbd-xb.pri{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.ocbd-xseg button:focus-visible,.ocbd-xb:focus-visible,.ocbd-xf select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (max-width:40em){.ocbd-xg{grid-template-columns:1fr}.ocbd-xa .ocbd-xb{flex:1;justify-content:center}}
`;
let injected = false;
function ensureStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-ocbd-export", "");
  s.textContent = CSS;
  document.head.appendChild(s);
}
