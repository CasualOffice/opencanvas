// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** Highlights one block for a moment (deep links, the host's Action_ScrollToBlock). A
 *  decoration, not a DOM class: ProseMirror would drop a class on its next render. */
const flashKey = new PluginKey<DecorationSet>("blockFlash");

/** Block node types that can carry a `blockId` (docs/15 §4). */
export const BLOCK_ID_TYPES = [
  "paragraph", "heading", "bulletList", "orderedList", "listItem", "taskList", "taskItem",
  "blockquote", "codeBlock", "horizontalRule", "image", "table", "callout", "toggle",
  "database", "board", "bookmark", "embed", "fileAttachment", "columns",
];

/**
 * Keeps the optional `blockId` attribute the host REST API addresses blocks by
 * (`POST /v1/files/:id/patch`). Without a schema attribute ProseMirror drops it on the
 * first local edit. Ids are never copied onto the second half of a split block, so a
 * split cannot create duplicates; the editor does not invent ids itself.
 */
export const BlockId = Extension.create({
  name: "blockId",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: flashKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(flashKey) as { from: number; to: number } | null | undefined;
            if (meta === null) return DecorationSet.empty;
            if (meta) return DecorationSet.create(tr.doc, [Decoration.node(meta.from, meta.to, { class: "flash" })]);
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: { decorations: (st) => flashKey.getState(st) },
      }),
    ];
  },
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_ID_TYPES,
        attributes: {
          blockId: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute("data-block-id"),
            renderHTML: (attrs) => (attrs.blockId ? { "data-block-id": attrs.blockId } : {}),
          },
        },
      },
    ];
  },
});

/** `b_` + 26 lowercase base32 characters (docs/15 §4). */
export function newBlockId(): string {
  const a = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  return "b_" + Array.from(bytes, (b) => a[b & 31]).join("");
}

/**
 * Gives the text block around `pos` a `blockId` when it has none, so the host can link to it
 * (mention notifications carry it, docs/05 §5). Returns the id.
 */
export function ensureBlockIdAt(editor: Editor, pos: number): string | null {
  const $p = editor.state.doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) {
    const n = $p.node(d);
    if (!BLOCK_ID_TYPES.includes(n.type.name)) continue;
    if (n.attrs.blockId) return n.attrs.blockId as string;
    const id = newBlockId();
    editor.view.dispatch(editor.state.tr.setNodeMarkup($p.before(d), undefined, { ...n.attrs, blockId: id }).setMeta("addToHistory", false));
    return id;
  }
  return null;
}

/** Scrolls to the block with this `blockId` and flashes it. False when it isn't in the canvas. */
export function flashBlock(editor: Editor, id: string): boolean {
  let at = -1;
  let size = 0;
  editor.state.doc.descendants((n, pos) => {
    if (at >= 0) return false;
    if (n.attrs.blockId === id) {
      at = pos;
      size = n.nodeSize;
      return false;
    }
    return true;
  });
  if (at < 0) return false;
  editor.view.dispatch(editor.state.tr.setMeta(flashKey, { from: at, to: at + size }));
  (editor.view.nodeDOM(at) as HTMLElement | null)?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  window.setTimeout(() => !editor.isDestroyed && editor.view.dispatch(editor.state.tr.setMeta(flashKey, null)), 1900);
  return true;
}
