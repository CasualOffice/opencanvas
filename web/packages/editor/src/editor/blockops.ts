// Block operations shared by the block menu, the gutter, the phone bar and the
// keyboard (⌘D duplicate, ⌘⇧↑/↓ move, ⌘/ block menu). No React here: this sits
// in the initial bundle; the menu UI (blockmenu.tsx) loads on first use.
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection, type EditorState } from "@tiptap/pm/state";
import type * as Y from "yjs";
import { bridge } from "../lib/bridge";
import { createStore } from "../lib/store";

export interface BlockMenuState {
  pos: number;
  node: PMNode;
  rect: { left: number; right: number; top: number; bottom: number };
}
export const blockMenuStore = createStore<BlockMenuState | null>(null);

/** The top-level block containing `pos`: its node, start position and index in the doc. */
export function topBlockAt(state: EditorState, pos: number): { node: PMNode; pos: number; index: number } | null {
  const doc = state.doc;
  if (!doc.childCount) return null;
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  const index = $p.depth === 0 ? Math.min($p.index(0), doc.childCount - 1) : $p.index(0);
  let start = 0;
  for (let i = 0; i < index; i++) start += doc.child(i).nodeSize;
  return { node: doc.child(index), pos: start, index };
}

/** Index of the top-level block that starts at `pos`, or -1 when `pos` is not a top-level block. */
export function indexAt(doc: PMNode, pos: number): number {
  let found = -1;
  doc.forEach((_n, off, j) => {
    if (off === pos) found = j;
  });
  return found;
}

/** Duplicated database / board blocks get their own copy of the data (not a second view of the same one). */
export function cloneEmbeddedData(json: Record<string, unknown>): Record<string, unknown> {
  const walk = (n: Record<string, unknown>) => {
    const attrs = n.attrs as Record<string, unknown> | undefined;
    if (attrs && "blockId" in attrs) attrs.blockId = null; // ids are unique per document (docs/15 §4)
    if (n.type === "database" && attrs?.dbId) {
      const root = bridge.doc.getMap("databases");
      const src = root.get(String(attrs.dbId)) as Y.Map<unknown> | undefined;
      if (src) {
        const id = "db_" + Math.random().toString(36).slice(2, 10);
        root.set(id, src.clone());
        attrs.dbId = id;
      }
    }
    if (n.type === "board" && attrs?.boardId) {
      const root = bridge.doc.getMap("boards");
      const src = root.get(String(attrs.boardId)) as Y.Map<unknown> | undefined;
      if (src) {
        const id = "brd_" + Math.random().toString(36).slice(2, 10);
        root.set(id, src.clone());
        attrs.boardId = id;
      }
    }
    (n.content as Record<string, unknown>[] | undefined)?.forEach(walk);
  };
  walk(json);
  return json;
}

export function duplicateBlock(editor: Editor, pos: number, node: PMNode): boolean {
  // A deep copy: toJSON() shares the node's own attrs object, which must never be mutated.
  const json = cloneEmbeddedData(JSON.parse(JSON.stringify(node.toJSON())) as Record<string, unknown>);
  return editor.chain().focus().insertContentAt(pos + node.nodeSize, json).run();
}

/** Moves the top-level block at `pos` one place up or down. Keeps the caret inside it. */
export function moveBlock(editor: Editor, pos: number, node: PMNode, dir: -1 | 1): boolean {
  const doc = editor.state.doc;
  const idx = indexAt(doc, pos);
  const j = idx + dir;
  if (idx < 0 || j < 0 || j >= doc.childCount) return false;
  const other = doc.child(j);
  const { from } = editor.state.selection;
  const inside = from > pos && from < pos + node.nodeSize ? from - pos : null;
  return editor
    .chain()
    .command(({ tr }) => {
      const target = dir === -1 ? pos - other.nodeSize : pos + other.nodeSize;
      tr.delete(pos, pos + node.nodeSize);
      tr.insert(target, node);
      if (inside !== null) tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(target + inside, tr.doc.content.size))));
      tr.scrollIntoView();
      return true;
    })
    .run();
}

export function deleteBlock(editor: Editor, pos: number, node: PMNode): boolean {
  return editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
}

/** Opens the block menu for the block at the caret (⌘/), anchored to that block. */
export function openBlockMenuAtCaret(editor: Editor): boolean {
  const b = topBlockAt(editor.state, editor.state.selection.from);
  if (!b) return false;
  const dom = editor.view.nodeDOM(b.pos) as HTMLElement | null;
  const r = dom?.getBoundingClientRect?.() ?? editor.view.coordsAtPos(editor.state.selection.from);
  blockMenuStore.set({ pos: b.pos, node: b.node, rect: { left: r.left, right: r.left + 1, top: r.top, bottom: Math.min(r.bottom, r.top + 28) } });
  return true;
}

/**
 * "+" (gutter and phone bar): open the slash menu on a fresh line below the
 * block, or in the block itself when it is an empty paragraph. Never types "/"
 * into the middle of existing text.
 */
export function insertBelow(editor: Editor, pos: number, node: PMNode): boolean {
  if (node.type.name === "paragraph" && node.content.size === 0) {
    return editor.chain().focus().setTextSelection(pos + 1).insertContent("/").run();
  }
  const at = pos + node.nodeSize;
  return editor.chain().focus().insertContentAt(at, { type: "paragraph", content: [{ type: "text", text: "/" }] }).setTextSelection(at + 2).run();
}

/** Phone "+": like the gutter's, for the block that holds the caret. */
export function insertBelowCaret(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  // Already in an empty paragraph at any depth (list item, column, toggle): type "/" right there.
  if (empty && $from.parent.type.name === "paragraph" && $from.parent.content.size === 0) return editor.chain().focus().insertContent("/").run();
  const b = topBlockAt(editor.state, editor.state.selection.from);
  if (!b) return editor.chain().focus().insertContent("/").run();
  return insertBelow(editor, b.pos, b.node);
}
