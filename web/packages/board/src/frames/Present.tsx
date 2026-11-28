// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Present (⇧P, BRD-21, prototype 5b): full screen, one frame at a time, fitted with a margin.
// ← → , Space and PageUp / PageDown step; Esc ends. The board stays live: each frame is drawn
// from the current shapes, so edits by others appear while presenting. Per person, nothing stored.
// Loaded on demand.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Y from "yjs";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { shapesToSvg } from "../export";
import { docIconUrls } from "../icons";
import type { Shape } from "../model";
import { exportScope } from "../export/scope";
import { frameName, framesOf } from "./model";

const SW = 1.75;

const darkPage = () => {
  if (typeof document === "undefined") return false;
  const t = document.documentElement.getAttribute("data-theme");
  if (t) return t === "dark";
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
};

export default function Present({ doc, shapes, start, onClose }: { doc: Y.Doc; shapes: Shape[]; start?: string; onClose: () => void }) {
  ensureStyles();
  const frames = useMemo(() => framesOf(shapes), [shapes]);
  const [i, setI] = useState(() => Math.max(0, frames.findIndex((f) => f.id === start)));
  const box = useRef<HTMLDivElement>(null);
  const cur = frames[Math.min(i, frames.length - 1)];
  const [url, setUrl] = useState<string | null>(null);
  const dark = useMemo(darkPage, []);
  useEffect(() => {
    if (!cur || typeof URL.createObjectURL !== "function") return;
    const u = URL.createObjectURL(new Blob([shapesToSvg(exportScope(shapes, `f:${cur.id}`, []), docIconUrls(doc), { theme: dark ? "dark" : "light", background: false })], { type: "image/svg+xml" }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [doc, shapes, cur, dark]);
  useEffect(() => {
    const el = box.current;
    el?.focus();
    // Full screen where the browser allows it; the overlay covers the window either way.
    void el?.requestFullscreen?.().catch(() => {});
    return () => {
      if (typeof document !== "undefined" && document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!frames.length) onClose();
  }, [frames.length, onClose]);
  if (!cur) return null;
  const go = (d: number) => setI((n) => Math.max(0, Math.min(frames.length - 1, n + d)));
  return createPortal(
    <div
      ref={box}
      className={`ocbd-present${dark ? " dk" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Presenting frames"
      tabIndex={-1}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") return onClose();
        if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") (e.preventDefault(), go(1));
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") (e.preventDefault(), go(-1));
        else if (e.key === "Home") setI(0);
        else if (e.key === "End") setI(frames.length - 1);
      }}
    >
      <div className="ocbd-pstage">{url ? <img src={url} alt={frameName(cur)} /> : null}</div>
      <div className="ocbd-pbar">
        <button type="button" aria-label="Previous frame" disabled={i === 0} onClick={() => go(-1)}>
          <ChevronLeft size={18} strokeWidth={SW} />
        </button>
        <span className="ocbd-pname" aria-live="polite">
          {frameName(cur)} <span className="ocbd-pn">{i + 1} / {frames.length}</span>
        </span>
        <button type="button" aria-label="Next frame" disabled={i === frames.length - 1} onClick={() => go(1)}>
          <ChevronRight size={18} strokeWidth={SW} />
        </button>
        <button type="button" aria-label="Stop presenting" onClick={onClose}>
          <X size={18} strokeWidth={SW} />
        </button>
      </div>
    </div>,
    document.body,
  );
}

const CSS = `
.ocbd-present{position:fixed;inset:0;z-index:2147483000;background:#ffffff;color:#18181b;display:flex;flex-direction:column;outline:none}
.ocbd-present.dk{background:#141417;color:#ededf0}
.ocbd-pstage{flex:1;min-height:0;display:grid;place-items:center;padding:3.5rem 3.5rem 1rem}
.ocbd-pstage img{max-width:100%;max-height:100%;object-fit:contain}
.ocbd-pbar{align-self:center;display:flex;align-items:center;gap:.25rem;margin:0 0 1.25rem;padding:.25rem;border-radius:.75rem;background:rgba(127,127,140,.14)}
.ocbd-pbar button{display:grid;place-items:center;width:2.5rem;height:2.5rem;border:0;border-radius:.5rem;background:none;color:inherit;cursor:pointer}
.ocbd-pbar button:disabled{opacity:.35;cursor:default}
.ocbd-pbar button:focus-visible{outline:2px solid #2a5ad7;outline-offset:1px}
.ocbd-pname{padding:0 .75rem;font-size:.875rem;font-weight:600;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}
.ocbd-pn{font-weight:400;opacity:.7;font-variant-numeric:tabular-nums;margin-left:.375rem}
`;
let injected = false;
function ensureStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-ocbd-present", "");
  s.textContent = CSS;
  document.head.appendChild(s);
}
