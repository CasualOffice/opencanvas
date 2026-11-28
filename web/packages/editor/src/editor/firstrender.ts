// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// PSYNC-BUG-3: the canvas is rendered once when the editor mounts, not twice. y-tiptap renders
// the Yjs document as soon as the ProseMirror view exists, and Tiptap's EditorContent then sets
// the node views again on mount (`createNodeViews`), which redraws every block: on the 50 MB
// canvas that second render and the layout it forced were most of the first screen's long frame.
// With an empty mapping y-tiptap skips its own first render; `renderContent` runs it once the
// node views are in place (CanvasEditor's layout effect, in the same commit as EditorContent's
// mount, so no transaction runs on the empty document in between).
import type { Editor } from "@tiptap/core";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

/** `ySyncOptions` for the Collaboration extension: no render until `renderContent`. */
export const deferFirstRender = () => ({ mapping: new Map() });

/** Renders the Yjs document into the editor (y-tiptap's first render). */
export function renderContent(editor: Editor) {
  if (editor.isDestroyed) return;
  const binding = (ySyncPluginKey.getState(editor.state) as { binding?: { _forceRerender(): void } } | undefined)?.binding;
  binding?._forceRerender();
}
