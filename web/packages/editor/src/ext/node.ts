// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The one generic node every SDK block is stored as (BSDK-02, ADR-040, docs/15 §4.2):
// `extBlock {blockId, type, v, attrs (JSON), dataId?, fallback}` with content `block*`. The
// schema is the same in every client whether or not it has the package, which y-prosemirror
// needs. The node view (ExtView) draws the approved chrome (BSDK-03): the sandboxed frame when
// this editor can run the block, else the read-only fallback states; children sit below it.
import { Node } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { fallbackText, focusBlock, type ExtAttrs } from "./model";
import { ExtView } from "./ExtView";

const json = (s: string | null) => {
  if (!s) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
};

export const ExtBlock = Node.create({
  name: "extBlock",
  group: "block",
  content: "block*",
  defining: true,
  isolating: true,
  draggable: true,
  selectable: true,
  addAttributes: () => ({
    type: { default: "", parseHTML: (el) => el.getAttribute("data-ext-type") ?? "", renderHTML: (a) => ({ "data-ext-type": a.type }) },
    v: { default: 1, parseHTML: (el) => Number(el.getAttribute("data-ext-v")) || 1, renderHTML: (a) => ({ "data-ext-v": String(a.v) }) },
    attrs: { default: null, parseHTML: (el) => json(el.getAttribute("data-ext-attrs")), renderHTML: (a) => (a.attrs ? { "data-ext-attrs": JSON.stringify(a.attrs) } : {}) },
    dataId: { default: null, parseHTML: (el) => el.getAttribute("data-ext-data"), renderHTML: (a) => (a.dataId ? { "data-ext-data": a.dataId } : {}) },
    fallback: { default: null, parseHTML: (el) => json(el.getAttribute("data-ext-fallback")), renderHTML: (a) => (a.fallback ? { "data-ext-fallback": JSON.stringify(a.fallback) } : {}) },
  }),
  parseHTML: () => [{ tag: 'div[data-type="extBlock"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", { ...HTMLAttributes, "data-type": "extBlock" }, 0],
  renderText: ({ node }) => fallbackText(node.attrs as ExtAttrs),
  addKeyboardShortcuts() {
    return {
      // Enter on a selected block moves focus into its frame (decision 2, frame 1e).
      Enter: ({ editor }) => {
        const sel = editor.state.selection;
        if (!(sel instanceof NodeSelection) || sel.node.type.name !== "extBlock") return false;
        return focusBlock(sel.node.attrs.blockId as string | null);
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ExtView, { stopEvent: ({ event }) => (event.target as HTMLElement | null)?.closest?.(".oc-ext-chrome") != null });
  },
});
