// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// PSYNC-03: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y over the main document and the room's parts. The
// collaboration extension's own commands only look at the main document's stack, so a step made
// in a database or board part (its own Y.Doc) would never be reached from the text.
import { Extension } from "@tiptap/core";
import { bridge } from "../lib/bridge";

const step = (redo: boolean) => {
  const parts = bridge.parts;
  const u = parts?.crossUndo;
  // Not split, nothing to do, or the main document's turn: the collaboration command runs.
  if (!parts?.split || !u || !(redo ? u.canRedo() : u.canUndo()) || u.nextIsMain(redo)) return false;
  return redo ? u.redo() : u.undo();
};

export const PartsUndo = Extension.create({
  name: "partsUndo",
  // Ahead of the collaboration extension's shortcuts.
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      "Mod-z": () => step(false),
      "Mod-y": () => step(true),
      "Shift-Mod-z": () => step(true),
    };
  },
});
