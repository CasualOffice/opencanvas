// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Collaborator caret labels stay inside the text column (SCALE-02 S6): a label hangs to the right
// of its caret, so a caret at the column's right edge pushed it past the edge and the document
// scrolled sideways (5 px at 200 % zoom). Each label is measured without its shift and moved back
// by what overflows.
import { Plugin, PluginKey } from "@tiptap/pm/state";

export function clampCaretLabels(root: HTMLElement) {
  const labels = root.querySelectorAll<HTMLElement>(".collaboration-carets__label");
  if (!labels.length) return;
  const edge = root.getBoundingClientRect().right;
  labels.forEach((l) => {
    l.style.transform = "";
    const over = l.getBoundingClientRect().right - edge;
    if (over > 0) l.style.transform = `translateX(-${Math.ceil(over)}px)`;
  });
}

/** Re-clamps after every update (carets move on edits and on awareness changes) and on resize. */
export function caretClampPlugin() {
  return new Plugin({
    key: new PluginKey("ocCaretClamp"),
    view(view) {
      let raf = 0;
      const run = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => clampCaretLabels(view.dom as HTMLElement));
      };
      const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(run) : null;
      ro?.observe(view.dom);
      run();
      return {
        update: run,
        destroy: () => (cancelAnimationFrame(raf), ro?.disconnect()),
      };
    },
  });
}
