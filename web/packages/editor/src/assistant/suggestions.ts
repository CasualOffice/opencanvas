// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The `suggestions` Y root (ADR-033, docs/24 §6.3): `{id → {id, by, name, origin, ops, status, at}}`.
// Ops are `editText` against a `blockId` (+ `rev`): `textEdits: [{find, replace}]`. The editor shows
// each pending one inline; accepting applies it as the accepting person, rejecting only marks it.
// Model text is never HTML: inserted links are Markdown `[label](href)` and go through safeHref.
import * as Y from "yjs";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { safeHref } from "../lib/urls";

export const SUGGESTIONS = "suggestions";
export const SUGG_ORIGIN = { source: "assistant-review" };

export interface TextEdit {
  find: string;
  replace: string;
}
export interface SuggOp {
  op: string;
  blockId?: string;
  textEdits?: TextEdit[];
}
export interface Suggestion {
  id: string;
  origin: string;
  status: "pending" | "accepted" | "rejected" | "stale";
  ops: SuggOp[];
  at: number;
}

function asSuggestion(v: unknown): Suggestion | null {
  if (!v || typeof v !== "object") return null;
  const o = (v instanceof Y.Map ? v.toJSON() : v) as Record<string, unknown>;
  if (typeof o.id !== "string" || !Array.isArray(o.ops)) return null;
  const ops = (o.ops as unknown[])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      op: String(x.op ?? ""),
      blockId: typeof x.blockId === "string" ? x.blockId : undefined,
      textEdits: Array.isArray(x.textEdits)
        ? (x.textEdits as unknown[]).filter((t): t is TextEdit => !!t && typeof (t as TextEdit).find === "string" && typeof (t as TextEdit).replace === "string")
        : undefined,
    }));
  const status = (["pending", "accepted", "rejected", "stale"] as const).find((s) => s === o.status) ?? "pending";
  return { id: o.id, origin: typeof o.origin === "string" ? o.origin : "", status, ops, at: typeof o.at === "number" ? o.at : 0 };
}

export const suggestionsRoot = (doc: Y.Doc) => doc.getMap<unknown>(SUGGESTIONS);

/** Every suggestion, oldest first. */
export function readSuggestions(doc: Y.Doc): Suggestion[] {
  const out: Suggestion[] = [];
  suggestionsRoot(doc).forEach((v) => {
    const s = asSuggestion(v);
    if (s) out.push(s);
  });
  return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

/** Inline Markdown links in model text: `[label](href)`. Everything else stays plain text. */
const MD_LINK = /\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)/g;
export type Piece = { text: string; href?: string };
export function pieces(s: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const m of s.matchAll(MD_LINK)) {
    if (m.index! > at) out.push({ text: s.slice(at, m.index) });
    // An unsafe target (javascript:, data:, ...) keeps its label and loses the link.
    out.push({ text: m[1], href: safeHref(m[2]) });
    at = m.index! + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

/** What a text edit changes: the removed and inserted middle, after the common prefix and suffix. */
export function diffEdit(e: TextEdit): { removed: string; inserted: string } {
  const a = e.find, b = e.replace;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return { removed: a.slice(p, a.length - q), inserted: b.slice(p, b.length - q) };
}

/** One line for the inline chip and screen readers, e.g. "link to Tasks · row 1". Plain text. */
export function describe(s: Suggestion): { removed: string; inserted: Piece[]; label: string } {
  const e = s.ops.find((o) => o.textEdits?.length)?.textEdits?.[0];
  if (!e) return { removed: "", inserted: [], label: "change" };
  const { removed, inserted } = diffEdit(e);
  const ins = pieces(inserted.trim());
  const link = ins.length === 1 && ins[0].href !== undefined ? ins[0] : null;
  const label = link ? `link to ${link.text}` : [removed ? `remove “${removed.trim()}”` : "", inserted.trim() ? `add “${ins.map((p) => p.text).join("")}”` : ""].filter(Boolean).join(", ");
  return { removed, inserted: link ? [{ text: `link to ${link.text}`, href: link.href }] : ins, label: label || "change" };
}

export function findBlock(state: { doc: PMNode }, blockId: string): { node: PMNode; pos: number } | null {
  let hit: { node: PMNode; pos: number } | null = null;
  state.doc.descendants((node, pos) => {
    if (hit) return false;
    if (node.attrs?.blockId === blockId) {
      hit = { node, pos };
      return false;
    }
    return true;
  });
  return hit;
}

function setStatus(doc: Y.Doc, id: string, status: Suggestion["status"]) {
  const root = suggestionsRoot(doc);
  const cur = root.get(id);
  if (cur instanceof Y.Map) cur.set("status", status);
  else if (cur && typeof cur === "object") root.set(id, { ...(cur as object), status });
}

/**
 * Applies a suggestion as the accepting person (their undo stack, their authorship). Returns
 * false and marks it stale when the text it targets has changed since.
 */
export function acceptSuggestion(editor: Editor, doc: Y.Doc, s: Suggestion): boolean {
  const { state } = editor;
  const tr = state.tr;
  const link = state.schema.marks.link;
  for (const op of s.ops) {
    if (op.op !== "editText" || !op.blockId || !op.textEdits) continue;
    for (const e of op.textEdits) {
      const b = findBlock({ doc: tr.doc }, op.blockId);
      if (!b) return void doc.transact(() => setStatus(doc, s.id, "stale"), SUGG_ORIGIN), false;
      // Text positions inside the block.
      let text = "";
      const at: number[] = [];
      b.node.descendants((n, p) => {
        if (n.isText) for (let i = 0; i < n.text!.length; i++) (text += n.text![i]), at.push(b.pos + 1 + p + i);
        return true;
      });
      const i = text.indexOf(e.find);
      if (i < 0) return void doc.transact(() => setStatus(doc, s.id, "stale"), SUGG_ORIGIN), false;
      const { removed, inserted } = diffEdit(e);
      let p = 0;
      while (p < e.find.length && p < e.replace.length && e.find[p] === e.replace[p]) p++;
      const from = i + p < at.length ? at[i + p] : at.length ? at[at.length - 1] + 1 : b.pos + 1;
      const to = from + removed.length;
      const nodes = pieces(inserted).filter((pc) => pc.text).map((pc) => state.schema.text(pc.text, pc.href && link ? [link.create({ href: pc.href })] : []));
      tr.replaceWith(from, to, nodes);
    }
  }
  if (tr.docChanged) editor.view.dispatch(tr);
  doc.transact(() => setStatus(doc, s.id, "accepted"), SUGG_ORIGIN);
  return true;
}

export function rejectSuggestion(doc: Y.Doc, id: string) {
  doc.transact(() => setStatus(doc, id, "rejected"), SUGG_ORIGIN);
}
