// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Match decorations for find (SRCH-01): a light amber wash on every text match and solid
// amber on the current one. Registered on the editor while the find bar is open; removed on
// close. Decorations follow edits through the transaction mapping until the next recompute.
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const findKey = new PluginKey<DecorationSet>("ocFind");

export interface Marks {
  ranges: { from: number; to: number }[];
  current: number;
}

export function findPlugin() {
  return new Plugin<DecorationSet>({
    key: findKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const m = tr.getMeta(findKey) as Marks | undefined;
        if (m) {
          const size = tr.doc.content.size;
          const decos = m.ranges
            .filter((r) => r.from >= 0 && r.to <= size && r.from < r.to)
            .map((r, i) => Decoration.inline(r.from, r.to, { class: i === m.current ? "oc-find-hit cur" : "oc-find-hit" }));
          return DecorationSet.create(tr.doc, decos);
        }
        return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
      },
    },
    props: { decorations: (state) => findKey.getState(state) },
  });
}

export function setMarks(editor: Editor, marks: Marks) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(findKey, marks).setMeta("addToHistory", false));
}
