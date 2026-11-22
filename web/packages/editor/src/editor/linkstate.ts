// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Link popover state (kept tiny: it is in the initial bundle; the popover UI
// itself, linkpop.tsx, loads the first time someone opens it).
//
//  - "edit": a URL field for the selection (⌘K, the toolbar's link button, the
//    phone bar), or for an existing link.
//  - "view": shown when an editor clicks a link: open, edit, copy, remove.
import { getMarkRange, type Editor } from "@tiptap/core";
import { createStore } from "../lib/store";
import { isAllowedUri } from "./link";

export interface LinkEdit {
  mode: "edit" | "view";
  from: number;
  to: number;
  href: string;
  /** Viewport rect the popover anchors to. */
  rect: { left: number; right: number; top: number; bottom: number };
}

export const linkStore = createStore<LinkEdit | null>(null);

/** Turns what someone typed into a link target: adds https://, mailto: for emails. */
export function normalizeHref(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  let href: string;
  if (/^(https?:|mailto:|tel:)/i.test(v)) href = v;
  else if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(v)) href = "mailto:" + v;
  else if (/^\/\//.test(v)) href = "https:" + v;
  else href = "https://" + v;
  if (/\s/.test(href.replace(/^mailto:/, "")) || !isAllowedUri(href)) return null;
  try {
    if (/^https?:/i.test(href)) new URL(href);
  } catch {
    return null;
  }
  return href;
}

function rectFor(editor: Editor, from: number, to: number) {
  const a = editor.view.coordsAtPos(from);
  const b = editor.view.coordsAtPos(to);
  return { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
}

/** The link mark's range around `pos`, if there is one. */
export function linkAt(editor: Editor, pos: number): { from: number; to: number; href: string } | null {
  const type = editor.schema.marks.link;
  if (!type) return null;
  const $pos = editor.state.doc.resolve(pos);
  const range = getMarkRange($pos, type) ?? (pos > 0 ? getMarkRange(editor.state.doc.resolve(pos - 1), type) : undefined);
  if (!range) return null;
  let href = "";
  editor.state.doc.nodesBetween(range.from, range.to, (n) => {
    const m = n.marks.find((x) => x.type === type);
    if (m && !href) href = String(m.attrs.href ?? "");
  });
  return { ...range, href };
}

/** ⌘K / toolbar / phone bar: edit the link under the selection, or link the selected text. */
export function openLinkEditor(editor: Editor): boolean {
  if (!editor.isEditable) return false;
  const { from, to, empty, $from } = editor.state.selection;
  if ($from.parent.type.spec.code) return false;
  const existing = linkAt(editor, from);
  if (existing && (empty || (from >= existing.from && to <= existing.to))) {
    linkStore.set({ mode: "edit", ...existing, rect: rectFor(editor, existing.from, existing.to) });
    return true;
  }
  linkStore.set({ mode: "edit", from, to: empty ? from : to, href: "", rect: rectFor(editor, from, to) });
  return true;
}

/** Click on a link in an editable canvas: show its actions instead of doing nothing. */
export function openLinkActions(editor: Editor, pos: number): boolean {
  const l = linkAt(editor, pos);
  if (!l) return false;
  linkStore.set({ mode: "view", ...l, rect: rectFor(editor, l.from, l.to) });
  return true;
}

/** Applies `href` to the range (or inserts it as text when nothing was selected). */
export function applyLink(editor: Editor, e: Pick<LinkEdit, "from" | "to" | "href">, raw: string): boolean {
  const href = normalizeHref(raw);
  if (!href) return false;
  const chain = editor.chain().focus();
  if (e.from === e.to) {
    const text = href.replace(/^mailto:/, "");
    chain
      .insertContentAt(e.from, { type: "text", text, marks: [{ type: "link", attrs: { href } }] })
      .setTextSelection(e.from + text.length)
      .run();
  } else {
    chain.setTextSelection({ from: e.from, to: e.to }).setLink({ href }).setTextSelection(e.to).run();
  }
  return true;
}

export function removeLink(editor: Editor, e: Pick<LinkEdit, "from" | "to">) {
  editor.chain().focus().setTextSelection({ from: e.from, to: e.to }).unsetLink().setTextSelection(e.to).run();
}
