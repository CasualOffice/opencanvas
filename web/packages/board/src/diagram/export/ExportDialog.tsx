// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Export dialog (DGM-14.6, approved frames 7f and 7g), from the board options menu in diagram mode.
// PNG and SVG are the existing board exports (in the browser). draw.io and Mermaid are converted
// by the server (`env.exportBoard`, `oc_model::diagram_export`), which also reports what changes;
// Mermaid shows a preview of the text with Copy text.
import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { AlertTriangle, Check, Copy, FileCode2, FileImage, FileText, Info, Network, X } from "lucide-react";
import type { BlockEnv, DiagramExportReport } from "@opencanvas/ui";
import { getBoardMap, readShapes, type Shape } from "../../model";
import { exportShapesPng, shapesToSvg } from "../../export";
import { ensureLayoutStyles } from "../layout/AutoLayout";

const SW = 1.75;

export type ExportFormat = "png" | "svg" | "drawio" | "mmd";

const FORMATS: { f: ExportFormat; name: string; sub: string; Icon: typeof FileImage }[] = [
  { f: "png", name: "PNG", sub: "A picture for slides and chat", Icon: FileImage },
  { f: "svg", name: "SVG", sub: "Sharp at any size", Icon: FileCode2 },
  { f: "drawio", name: "draw.io", sub: "Keep editing in diagrams.net", Icon: Network },
  { f: "mmd", name: "Mermaid", sub: "Text for docs and READMEs", Icon: FileText },
];

/** What changes for the picture formats (made in the browser, nothing to ask the server). */
const PICTURE: Record<"png" | "svg", DiagramExportReport["items"]> = {
  png: [
    { level: "gray", code: "picture", title: "A picture: shapes can’t be edited afterwards", count: 0, examples: [] },
    { level: "gray", code: "light", title: "Drawn in light colours, fitted to the shapes", count: 0, examples: [] },
    { level: "ok", code: "sharp", title: "Twice the screen resolution", count: 0, examples: [] },
  ],
  svg: [
    { level: "ok", code: "text", title: "Text stays text, sharp at any size", count: 0, examples: [] },
    { level: "gray", code: "light", title: "Drawn in light colours, fitted to the shapes", count: 0, examples: [] },
  ],
};

/** The selected shapes and the connectors between them. */
export function selectionShapes(all: Shape[], ids: string[]): Shape[] {
  const want = new Set(ids);
  const picked = all.filter((s) => want.has(s.id) && s.type !== "arrow");
  const kept = new Set(picked.map((s) => s.id));
  return all.filter((s) => kept.has(s.id) || (s.type === "arrow" && (want.has(s.id) || (!!s.start?.shapeId && !!s.end?.shapeId && kept.has(s.start.shapeId) && kept.has(s.end.shapeId)))));
}

const fileName = (name: string, ext: string) => `${(name.replace(/[^\p{L}\p{N} ._-]/gu, "_").trim() || "board").slice(0, 80)}.${ext}`;

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export interface ExportDialogProps {
  doc: Y.Doc;
  boardId: string;
  env: BlockEnv;
  name: string;
  selection: string[];
  onClose: () => void;
}

export default function ExportDialog({ doc, boardId, env, name, selection, onClose }: ExportDialogProps) {
  ensureLayoutStyles();
  ensureExportStyles();
  const server = !!env.exportBoard;
  const [fmt, setFmt] = useState<ExportFormat>(server ? "drawio" : "png");
  const [scope, setScope] = useState<"all" | "selection">("all");
  const [res, setRes] = useState<{ key: string; text: string; report: DiagramExportReport } | { key: string; error: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const ids = scope === "selection" ? selection : null;
  const key = `${fmt}:${ids?.join(",") ?? "*"}`;

  // Ask the server for the report (and the Mermaid text) of the chosen format and scope.
  useEffect(() => {
    if ((fmt !== "drawio" && fmt !== "mmd") || !env.exportBoard) return;
    let live = true;
    env.exportBoard(boardId, fmt, ids).then(
      (r) => live && setRes({ key, ...r }),
      () => live && setRes({ key, error: "The export server couldn’t be reached. Try again." }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);

  const shapes = () => {
    const m = getBoardMap(doc, boardId);
    const all = m ? readShapes(m) : [];
    return ids ? selectionShapes(all, ids) : all;
  };
  const current = res && res.key === key ? res : null;
  const items = fmt === "png" || fmt === "svg" ? PICTURE[fmt] : current && "report" in current ? current.report.items : [];
  const tool = FORMATS.find((x) => x.f === fmt)!.name;
  const ext = fmt === "mmd" ? "mmd" : fmt;
  const action = fmt === "mmd" ? "Download .mmd" : `Export .${ext}`;
  const ready = fmt === "png" || fmt === "svg" || (!!current && "report" in current);

  const run = async () => {
    setBusy(true);
    try {
      if (fmt === "svg") save(new Blob([shapesToSvg(shapes())], { type: "image/svg+xml" }), fileName(name, "svg"));
      else if (fmt === "png") save(await exportShapesPng(shapes(), 2), fileName(name, "png"));
      else if (current && "text" in current) save(new Blob([current.text], { type: fmt === "mmd" ? "text/plain" : "application/xml" }), fileName(name, ext));
      onClose();
    } catch {
      env.toast(`Couldn’t export the diagram as ${tool}`);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!current || !("text" in current)) return;
    try {
      await navigator.clipboard.writeText(current.text);
      setCopied(true);
    } catch {
      env.toast("Couldn’t copy. Select the text and copy it instead.");
    }
  };

  const counts = useMemo(() => (current && "report" in current ? current.report.counts : null), [current]);

  return (
    <div className="ocdg-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="ocdg-dlg ocdg-exp" role="dialog" aria-modal="true" aria-labelledby="ocdg-ex-t">
        <header className="ocdg-dh">
          <h2 id="ocdg-ex-t">Export diagram</h2>
          <button type="button" className="ocdg-ib" aria-label="Close" onClick={onClose}>
            <X size={16} strokeWidth={SW} />
          </button>
        </header>
        <div className="ocdg-fmts" role="radiogroup" aria-label="Format">
          {FORMATS.map(({ f, name: n, sub, Icon }) => {
            const off = (f === "drawio" || f === "mmd") && !server;
            return (
              <button key={f} type="button" role="radio" aria-checked={fmt === f} disabled={off} className="ocdg-fmt" onClick={() => (setFmt(f), setCopied(false))}>
                <Icon size={18} strokeWidth={SW} aria-hidden="true" />
                <span className="ocdg-fn">{n}</span>
                <span className="ocdg-fs2">{off ? "Needs the canvas server" : sub}</span>
              </button>
            );
          })}
        </div>
        <div className="ocdg-row">
          <span className="ocdg-lbl" id="ocdg-ex-sc">Export</span>
          <div className="ocdg-seg" role="radiogroup" aria-labelledby="ocdg-ex-sc">
            <button type="button" role="radio" aria-checked={scope === "all"} onClick={() => setScope("all")}>Whole diagram</button>
            <button type="button" role="radio" aria-checked={scope === "selection"} disabled={!selection.length} title={selection.length ? undefined : "Select shapes first"} onClick={() => setScope("selection")}>
              Selection
            </button>
          </div>
        </div>
        <section className="ocdg-chg" aria-labelledby="ocdg-ex-c" aria-busy={!ready}>
          <h3 className="ocdg-sh" id="ocdg-ex-c">What changes in {tool}</h3>
          {current && "error" in current ? <p className="ocdg-err" role="alert">{current.error}</p> : null}
          {!ready && !(current && "error" in current) ? <p className="ocdg-hint">Checking the diagram…</p> : null}
          <ul className="ocdg-items" data-testid="export-report">
            {items.map((i) => (
              <li key={i.code} className="ocdg-item" data-level={i.level} data-code={i.code}>
                {i.level === "warn" ? <AlertTriangle size={14} strokeWidth={SW} aria-hidden="true" /> : i.level === "ok" ? <Check size={14} strokeWidth={SW} aria-hidden="true" /> : <Info size={14} strokeWidth={SW} aria-hidden="true" />}
                <span className="ocdg-it">
                  {i.title}
                  {i.detail ? <span className="ocdg-hint">{i.detail}</span> : null}
                  {i.examples.length && !i.detail ? <span className="ocdg-hint">{i.examples.join(", ")}</span> : null}
                </span>
                {i.code === "kept" && counts ? <span className="ocdg-cnt">{`${counts.shapes} · ${counts.connectors}`}</span> : i.count > 1 ? <span className="ocdg-cnt">{i.count}</span> : null}
              </li>
            ))}
          </ul>
          {fmt === "mmd" && current && "text" in current ? (
            <div className="ocdg-code">
              <pre tabIndex={0} aria-label="Mermaid text" data-testid="mermaid-preview">{current.text}</pre>
              <button type="button" className="ocdg-sec-b" onClick={() => void copy()}>
                {copied ? <Check size={14} strokeWidth={SW} aria-hidden="true" /> : <Copy size={14} strokeWidth={SW} aria-hidden="true" />}
                {copied ? "Copied" : "Copy text"}
              </button>
            </div>
          ) : null}
        </section>
        <footer className="ocdg-df">
          <button type="button" className="ocdg-sec-b" onClick={onClose}>Cancel</button>
          <button type="button" className="ocdg-pri" disabled={!ready || busy} onClick={() => void run()}>
            {fmt === "png" || fmt === "svg" ? `Export ${tool}` : action}
          </button>
        </footer>
      </div>
    </div>
  );
}

export const EXPORT_CSS = `
.ocdg-scrim{position:absolute;inset:0;z-index:20;background:rgba(10,10,15,.32);display:grid;place-items:center;padding:1rem}
.ocdg-dlg{width:40rem;max-width:100%;max-height:calc(100vh - 2rem);overflow:auto;background:var(--pop);color:var(--fg);border-radius:.875rem;box-shadow:var(--sh-pop);padding:1rem 1.25rem;display:flex;flex-direction:column;gap:.875rem}
.ocdg-dh{display:flex;align-items:center;justify-content:space-between}
.ocdg-dh h2{font-size:1rem;font-weight:600;margin:0}
.ocdg-fmts{display:grid;grid-template-columns:repeat(4,1fr);gap:.5rem}
.ocdg-fmt{display:flex;flex-direction:column;align-items:flex-start;gap:.25rem;padding:.75rem;border:1px solid var(--line-2);border-radius:.625rem;background:var(--app);text-align:left;min-height:5.5rem}
.ocdg-fmt:hover{background:var(--hover)}
.ocdg-fmt[aria-checked="true"]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent);background:var(--accent-soft)}
.ocdg-fmt:disabled{opacity:.55;cursor:default}
.ocdg-fn{font-weight:600;font-size:.875rem}
.ocdg-fs2{font-size:.75rem;color:var(--fg-2)}
.ocdg-chg{border-top:1px solid var(--line);padding-top:.75rem}
.ocdg-items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.375rem}
.ocdg-item{display:flex;align-items:flex-start;gap:.5rem;font-size:.8125rem}
.ocdg-item svg{margin-top:.1875rem;color:var(--fg-2)}
.ocdg-item[data-level="warn"] svg{color:var(--amber-fg)}
.ocdg-item[data-level="ok"] svg{color:var(--green-fg)}
.ocdg-it{display:flex;flex-direction:column;flex:1;min-width:0}
.ocdg-it .ocdg-hint{margin:0}
.ocdg-cnt{font-size:.75rem;color:var(--fg-2);font-variant-numeric:tabular-nums;background:var(--sunk);border-radius:1rem;padding:0 .5rem}
.ocdg-err{color:var(--red-fg);font-size:.8125rem;margin:0 0 .5rem}
.ocdg-code{margin-top:.75rem;display:flex;flex-direction:column;align-items:flex-start;gap:.5rem}
.ocdg-code pre{margin:0;width:100%;max-height:12rem;overflow:auto;background:var(--sunk);border-radius:.5rem;padding:.625rem .75rem;font-family:var(--mono);font-size:.75rem;line-height:1.5;white-space:pre}
.ocdg-code .ocdg-sec-b{display:inline-flex;align-items:center;gap:.375rem}
.ocdg-df{display:flex;justify-content:flex-end;gap:.5rem}
@media (max-width:45em){.ocdg-fmts{grid-template-columns:repeat(2,1fr)}}
`;

let injected = false;
export function ensureExportStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-ocdg-export", "");
  s.textContent = EXPORT_CSS;
  document.head.appendChild(s);
}
