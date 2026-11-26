// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Two marks in the canvas for offline editing (OFF-06, frames 1b, 3a, 4d):
//  - the thin amber bar left of a block whose changes are only on this device (a decoration
//    from `unsentBlocks`, never written to the document);
//  - "Restored from <name>'s offline edit" on a block put back by the merge summary: the
//    optional attribute `restoredBy`, shown to everyone until someone edits that block.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { BLOCK_ID_TYPES } from "../editor/blockId";
import { createStore } from "../lib/store";

/** Block ids with changes not sent yet. */
export const unsentBlocks = createStore<ReadonlySet<string>>(new Set());
const key = new PluginKey<DecorationSet>("ocUnsent");
const clearKey = new PluginKey("ocRestored");

function decorate(doc: import("@tiptap/pm/model").Node, ids: ReadonlySet<string>) {
  if (!ids.size) return DecorationSet.empty;
  const out: Decoration[] = [];
  doc.forEach((n, pos) => {
    if (ids.has(n.attrs.blockId as string)) out.push(Decoration.node(pos, pos + n.nodeSize, { class: "oc-unsent" }));
  });
  return DecorationSet.create(doc, out);
}

export const OfflineMarks = Extension.create({
  name: "ocOffline",
  addGlobalAttributes() {
    return [
      {
        types: ["image", "fileAttachment"],
        attributes: {
          // OFF-05: who holds a queued upload (`oc-pending:`); kept on every edit (MOD-01 checks it).
          pendingBy: { default: null, parseHTML: (el) => el.getAttribute("data-pending-by"), renderHTML: (a) => (a.pendingBy ? { "data-pending-by": a.pendingBy } : {}) },
        },
      },
      {
        types: BLOCK_ID_TYPES,
        attributes: {
          restoredBy: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute("data-restored-by"),
            renderHTML: (a) => (a.restoredBy ? { "data-restored-by": `Restored from ${a.restoredBy}’s offline edit` } : {}),
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_c, s) => decorate(s.doc, unsentBlocks.get()),
          apply: (tr, old, _o, s) => (tr.getMeta(key) || tr.docChanged ? decorate(s.doc, unsentBlocks.get()) : old),
        },
        props: { decorations: (s) => key.getState(s) },
        view: (view) => {
          const off = unsentBlocks.subscribe(() => !view.isDestroyed && view.dispatch(view.state.tr.setMeta(key, true).setMeta("addToHistory", false)));
          return { destroy: off };
        },
      }),
      new Plugin({
        key: clearKey,
        // A local edit inside a restored block clears its label (frame 4d).
        appendTransaction: (trs, _old, state) => {
          if (!editor.isEditable || !trs.some((t) => t.docChanged && !t.getMeta(ySyncPluginKey))) return null;
          const tr = state.tr;
          for (const t of trs) {
            if (!t.docChanged || t.getMeta(ySyncPluginKey)) continue;
            t.mapping.maps.forEach((m) =>
              m.forEach((_a, _b, from, to) => {
                state.doc.nodesBetween(Math.max(0, from - 1), Math.min(state.doc.content.size, to + 1), (n, pos) => {
                  if (n.attrs.restoredBy) tr.setNodeAttribute(pos, "restoredBy", null);
                });
              }),
            );
          }
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },
});
