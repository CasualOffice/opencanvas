// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import type { Editor } from "@tiptap/core";

/**
 * A press on the empty page below the last block puts the caret at the end of the canvas
 * (adding an empty paragraph when the last block is not one), as people expect. Without it the
 * editor lost focus, and the next "/" or keystroke went to the start of the document.
 * Returns true when it handled the press.
 */
export function focusEndOnClickBelow(editor: Editor | null, target: EventTarget | null, clientY: number): boolean {
  if (!editor || !editor.isEditable || editor.isDestroyed) return false;
  const dom = editor.view.dom as HTMLElement;
  const el = target instanceof Element ? target : null;
  // Only the page around the editor: never a block, a menu, a button or the title.
  if (!el || dom.contains(el) || el.closest("button, a, input, textarea, select, [role=menu], [role=dialog], [contenteditable]")) return false;
  const last = dom.lastElementChild as HTMLElement | null;
  const bottom = (last ?? dom).getBoundingClientRect().bottom;
  if (clientY <= bottom) return false;
  const { doc } = editor.state;
  const end = doc.lastChild;
  if (!end || end.type.name !== "paragraph" || end.content.size > 0) {
    editor.chain().insertContentAt(doc.content.size, { type: "paragraph" }).focus("end").run();
  } else {
    editor.commands.focus("end");
  }
  return true;
}
