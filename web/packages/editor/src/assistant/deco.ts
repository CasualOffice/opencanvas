// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// What the assistant draws inside the document: the selection it works on, the slot the inline
// command bar and plan render into, the agent's label on the block it touches, the outline on
// blocks it created, and pending suggestions with ✓ / ✕. DOM is built with textContent only:
// model text never becomes HTML.
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { describe, findBlock, type Suggestion } from "./suggestions";

export interface DecoModel {
  sel: { from: number; to: number } | null;
  /** Position (between top-level blocks) where the inline card renders. */
  slotAt: number | null;
  agent: { blockId: string; label: string } | null;
  created: string[];
  newTag: boolean;
  suggestions: Suggestion[];
  focus: string | null;
  canAccept: boolean;
  onAccept(id: string): void;
  onReject(id: string): void;
}

export const decoKey = new PluginKey<DecorationSet>("assistant");

function lastTextblock(node: PMNode, pos: number): number | null {
  if (node.isTextblock) return pos + node.nodeSize - 1;
  let end: number | null = null;
  node.forEach((c, off) => {
    const e = lastTextblock(c, pos + 1 + off);
    if (e != null && c.type.name !== "bulletList" && c.type.name !== "orderedList") end = e;
  });
  return end;
}

function chip(s: Suggestion, m: DecoModel): HTMLElement {
  const d = describe(s);
  const wrap = document.createElement("span");
  wrap.className = "ai-sugg" + (m.focus === s.id ? " on" : "");
  wrap.contentEditable = "false";
  wrap.dataset.sugg = s.id;
  if (d.removed.trim()) {
    const del = document.createElement("del");
    del.className = "ai-del";
    del.textContent = d.removed;
    wrap.append(del);
  }
  const ins = document.createElement("span");
  ins.className = "ai-ins";
  ins.textContent = "+ " + d.inserted.map((p) => p.text).join("");
  wrap.append(ins);
  if (m.canAccept) {
    const b = (cls: string, label: string, path: string, run: () => void) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ai-sb " + cls;
      btn.setAttribute("aria-label", label);
      btn.title = label;
      btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`; // static Lucide path, no model text
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        run();
      });
      return btn;
    };
    wrap.append(
      b("ok", `Accept: ${d.label}`, '<path d="M20 6 9 17l-5-5"/>', () => m.onAccept(s.id)),
      b("no", `Reject: ${d.label}`, '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', () => m.onReject(s.id)),
    );
  }
  return wrap;
}

export function buildDecorations(state: EditorState, m: DecoModel, slot: HTMLElement): DecorationSet {
  const out: Decoration[] = [];
  const size = state.doc.content.size;
  if (m.sel && m.sel.to > m.sel.from && m.sel.to <= size) out.push(Decoration.inline(m.sel.from, m.sel.to, { class: "ai-sel" }));
  if (m.slotAt != null && m.slotAt <= size) out.push(Decoration.widget(m.slotAt, () => slot, { key: "ai-slot", side: 1, stopEvent: () => true, ignoreSelection: true }));
  for (const id of m.created) {
    const b = findBlock(state, id);
    if (b) out.push(Decoration.node(b.pos, b.pos + b.node.nodeSize, { class: "ai-new", ...(m.newTag ? { "data-ai-tag": "New · by Assistant" } : {}) }));
  }
  if (m.agent) {
    const b = findBlock(state, m.agent.blockId);
    if (b) out.push(Decoration.node(b.pos, b.pos + b.node.nodeSize, { class: "ai-touch", "data-ai-agent": m.agent.label }));
  }
  for (const s of m.suggestions) {
    if (s.status !== "pending") continue;
    const id = s.ops.find((o) => o.blockId)?.blockId;
    const b = id ? findBlock(state, id) : null;
    if (!b) continue;
    const end = lastTextblock(b.node, b.pos);
    if (end == null) continue;
    if (m.focus === s.id) out.push(Decoration.node(b.pos, b.pos + b.node.nodeSize, { class: "ai-focus" }));
    out.push(Decoration.widget(end, () => chip(s, m), { key: `sg:${s.id}:${m.focus === s.id ? 1 : 0}:${m.canAccept ? 1 : 0}`, side: 1, stopEvent: () => true, ignoreSelection: true }));
  }
  return DecorationSet.create(state.doc, out);
}

/** The plugin keeps the last model; `tr.setMeta(decoKey, model)` redraws. */
export function assistantPlugin(slot: HTMLElement, initial: DecoModel): Plugin {
  let model = initial;
  return new Plugin<DecorationSet>({
    key: decoKey,
    state: {
      init: (_, st) => buildDecorations(st, model, slot),
      apply(tr, old, _o, st) {
        const next = tr.getMeta(decoKey) as DecoModel | undefined;
        if (next) model = next;
        if (next || tr.docChanged) {
          if (!next && tr.docChanged) model = { ...model, sel: model.sel && { from: tr.mapping.map(model.sel.from), to: tr.mapping.map(model.sel.to) }, slotAt: model.slotAt == null ? null : tr.mapping.map(model.slotAt) };
          return buildDecorations(st, model, slot);
        }
        return old;
      },
    },
    props: { decorations: (st) => decoKey.getState(st) },
  });
}
