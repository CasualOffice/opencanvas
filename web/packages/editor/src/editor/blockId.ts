// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { Extension, type Editor } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

/** Highlights one block for a moment (deep links, the host's Action_ScrollToBlock). A
 *  decoration, not a DOM class: ProseMirror would drop a class on its next render. */
const flashKey = new PluginKey<DecorationSet>("blockFlash");

/** Block node types that can carry a `blockId` (docs/15 §4). */
export const BLOCK_ID_TYPES = [
  "paragraph", "heading", "bulletList", "orderedList", "listItem", "taskList", "taskItem",
  "blockquote", "codeBlock", "horizontalRule", "image", "table", "callout", "toggle",
  "database", "board", "bookmark", "embed", "fileAttachment", "columns", "extBlock",
  "liveBlock", "blockRef",
];

const assignKey = new PluginKey("blockIdAssign");
const ID_TYPES = new Set(BLOCK_ID_TYPES);

/** True when `doc` is the placeholder of a fragment that has not loaded yet (one empty block). */
function isBlank(doc: PMNode): boolean {
  const f = doc.firstChild;
  return doc.childCount === 1 && !!f && f.isTextblock && f.content.size === 0 && !f.attrs.blockId;
}

/** Blocks one background pass gives ids to (PSYNC-A1): a document without ids (an import, a
 *  generated file) gets them in idle chunks, not one transaction with a step per block. */
export const ID_CHUNK = 200;

/**
 * Sets a fresh `blockId` on every block that has none, and on every later copy of an id that is
 * already used (document order: the first keeps it); at most `limit` blocks (the rest on the
 * next call). Null when nothing needs one. Textblocks' inline content is never walked, so this
 * stays cheap on every keystroke.
 */
export function assignBlockIds(state: EditorState, limit = Infinity): Transaction | null {
  if (isBlank(state.doc)) return null;
  const seen = new Set<string>();
  const fix: { pos: number; node: PMNode }[] = [];
  state.doc.descendants((node, pos) => {
    if (ID_TYPES.has(node.type.name)) {
      const id = node.attrs.blockId as string | null;
      if (!id || seen.has(id)) fix.push({ pos, node });
      else seen.add(id);
    }
    return !node.isTextblock && !node.isAtom;
  });
  if (!fix.length) return null;
  const tr = state.tr;
  for (const { pos, node } of fix.slice(0, limit)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: newBlockId() }, node.marks);
  return tr.setMeta(assignKey, true);
}

/** A transaction y-prosemirror made from a Yjs change (load, a remote edit, Yjs undo), or one
 *  another plugin appended to such a transaction. */
function fromYjs(tr: Transaction): boolean {
  const root = (tr.getMeta("appendedTransaction") as Transaction | undefined) ?? tr;
  return !!(root.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin;
}

/** Drops the `blockId`s of a pasted slice that are still in the document (a copy), keeping the
 *  ones that are not (a cut and paste, or a drag that moves the block, keeps its id). */
function stripUsedIds(slice: Slice, used: Set<string>): Slice {
  const map = (f: Fragment): Fragment => {
    const out: PMNode[] = [];
    let changed = false;
    f.forEach((n) => {
      const id = n.attrs?.blockId as string | null | undefined;
      const content = n.isTextblock ? n.content : map(n.content);
      const attrs = id && used.has(id) ? { ...n.attrs, blockId: null } : n.attrs;
      if (attrs === n.attrs && content === n.content) out.push(n);
      else {
        changed = true;
        out.push(n.type.create(attrs, content, n.marks));
      }
    });
    return changed ? Fragment.from(out) : f;
  };
  return new Slice(map(slice.content), slice.openStart, slice.openEnd);
}

/**
 * Stable block ids (docs/15 §4, VH-00). Keeps the optional `blockId` attribute the host REST API
 * (`POST /v1/files/:id/patch`) and version diffs (docs/30 §6) address blocks by: without a schema
 * attribute ProseMirror would drop it on the first local edit. An editable editor gives every
 * block without one an id (older documents get theirs on load), a split keeps the id on the first
 * half only, and a pasted copy of a block that is still in the document gets a new one. Read-only
 * editors never write. Two editors assigning ids to the same block at once converge (Yjs keeps one
 * attribute value).
 */
export const BlockId = Extension.create({
  name: "blockId",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: assignKey,
        // A local edit: the ids join the same transaction (and the same undo step). A batch that
        // started from Yjs is left to `later` (y-prosemirror would not write what is appended to
        // it, even by another plugin such as the trailing paragraph).
        appendTransaction: (trs, _old, state) =>
          editor.isEditable && !trs.some(fromYjs) && trs.some((t) => t.docChanged && !t.getMeta(assignKey)) ? assignBlockIds(state) : null,
        view: (view) => {
          // The loaded document and remote changes (a block an older client inserted) arrive from
          // Yjs; y-prosemirror does not write back what is appended to those, so the ids follow
          // as their own transaction, outside the undo history.
          // At most ID_CHUNK blocks per transaction, the next chunk when the browser is idle: a
          // large document without ids (an import, a generated file) would otherwise be one
          // transaction with thousands of steps, which plugins that compare a transaction's
          // changed ranges handle in quadratic time (it held the 50 MB canvas's first screen).
          let queued = false;
          const idle = (f: () => void) =>
            typeof requestIdleCallback === "function" ? requestIdleCallback(f, { timeout: 500 }) : setTimeout(f, 16);
          const run = () => {
            queued = false;
            if (view.isDestroyed || !editor.isEditable) return;
            const tr = assignBlockIds(view.state, ID_CHUNK);
            if (tr) view.dispatch(tr.setMeta("addToHistory", false));
          };
          let first = true;
          const later = () => {
            if (queued) return;
            queued = true;
            // The first pass right away (most documents need few ids or none), later ones idle.
            if (first) {
              first = false;
              queueMicrotask(run);
            } else idle(run);
          };
          later();
          return {
            update: (v, prev) => {
              if (v.state.doc !== prev.doc && editor.isEditable) later();
            },
          };
        },
        props: {
          transformPasted: (slice, view) => {
            if (view.dragging?.move) return slice;
            const used = new Set<string>();
            view.state.doc.descendants((n) => {
              if (n.attrs.blockId) used.add(n.attrs.blockId as string);
              return !n.isTextblock;
            });
            return used.size ? stripUsedIds(slice, used) : slice;
          },
        },
      }),
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
