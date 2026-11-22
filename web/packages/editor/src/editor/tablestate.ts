// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Which table the caret is in (for the table tools, tablemenu.tsx, which load
// the first time someone works in a table).
import type { Editor } from "@tiptap/core";
import { createStore } from "../lib/store";

export interface TableAt {
  /** Position before the table node. */
  pos: number;
}

export const tableStore = createStore<TableAt | null>(null);

/** The table that contains the selection, if any. */
export function tableAround(editor: Editor): TableAt | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "table") return { pos: $from.before(d) };
  return null;
}

export function trackTable(editor: Editor): () => void {
  const f = () => {
    const t = editor.isEditable ? tableAround(editor) : null;
    const prev = tableStore.get();
    if (t?.pos !== prev?.pos) tableStore.set(t);
  };
  editor.on("selectionUpdate", f);
  editor.on("update", f);
  f();
  return () => {
    editor.off("selectionUpdate", f);
    editor.off("update", f);
    tableStore.set(null);
  };
}
