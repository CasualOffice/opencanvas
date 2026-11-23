// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Diagram mode (DGM-14, S1): helpers that don't render. Diagram mode itself is React state in the
// board view of one person (never stored in the document, ADR-045 §8); the only document field
// it adds is the board's optional name (`boards/<id>.name`, a plain string, additive).
import * as Y from "yjs";
import { getBoardMap } from "../model";

/** The board's own name, or "" when it has none. */
export function boardName(doc: Y.Doc, boardId: string): string {
  const v = getBoardMap(doc, boardId)?.get("name");
  return typeof v === "string" ? v : "";
}

/** Sets (or, with a blank value, removes) the board's name. One key; nothing else is written. */
export function setBoardName(doc: Y.Doc, boardId: string, name: string, origin?: unknown) {
  const m = getBoardMap(doc, boardId);
  if (!m) return;
  const v = name.replace(/\s+/g, " ").trim().slice(0, 120);
  if (v === boardName(doc, boardId)) return;
  doc.transact(() => (v ? m.set("name", v) : m.delete("name")), origin);
}

const HEADING = /^H[1-6]$/;
const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/**
 * The heading nearest above `el` in the document (the block has no name of its own by default,
 * so the bar uses the heading above it, 1d). Walks back through preceding siblings, then up.
 */
export function headingAbove(el: Element | null): string {
  for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
    for (let p = node.previousElementSibling; p; p = p.previousElementSibling) {
      if (HEADING.test(p.tagName)) return clean(p.textContent);
      const hs = p.querySelectorAll("h1,h2,h3,h4,h5,h6");
      if (hs.length) return clean(hs[hs.length - 1].textContent);
    }
    if (node.getAttribute("contenteditable") !== null) break;
  }
  return "";
}

/** The document's title as written in it (its first level-1 heading), or "". */
export function documentTitle(el: Element | null): string {
  const root = el?.closest("[contenteditable]") ?? null;
  return clean(root?.querySelector("h1")?.textContent);
}

export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Grow/shrink duration (1c: about 220 ms). */
export const GROW_MS = 220;

/** `clip-path` that shows only `r` (the block) inside the full window. */
export function clipFor(r: { left: number; top: number; right: number; bottom: number }, vw: number, vh: number): string {
  const px = (n: number) => `${Math.max(0, Math.round(n))}px`;
  return `inset(${px(r.top)} ${px(vw - r.right)} ${px(vh - r.bottom)} ${px(r.left)} round 12px)`;
}
