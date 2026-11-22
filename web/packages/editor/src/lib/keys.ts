// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Keyboard shortcut labels that match the person's platform: ⌘⇧K on a Mac,
// Ctrl+Shift+K elsewhere. Combos use ProseMirror's spelling ("Mod-Shift-k").

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

const MAC: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Shift: "⇧", Alt: "⌥", Enter: "↩", ArrowUp: "↑", ArrowDown: "↓", Backspace: "⌫", Escape: "Esc" };
const PC: Record<string, string> = { Mod: "Ctrl", Ctrl: "Ctrl", Shift: "Shift", Alt: "Alt", Enter: "Enter", ArrowUp: "↑", ArrowDown: "↓", Backspace: "Backspace", Escape: "Esc" };

/** "Mod-Shift-k" → "⌘⇧K" (Mac) or "Ctrl+Shift+K". */
export function keyLabel(combo: string, mac = isMac): string {
  const parts = combo.split("-").map((p) => (p === "" ? "-" : p));
  const map = mac ? MAC : PC;
  const out = parts.map((p) => map[p] ?? (p.length === 1 ? p.toUpperCase() : p));
  return mac ? out.join("") : out.join("+");
}

/** The parts of a combo, for rendering each in its own <kbd>. */
export function keyParts(combo: string, mac = isMac): string[] {
  const map = mac ? MAC : PC;
  return combo.split("-").map((p) => map[p] ?? (p.length === 1 ? p.toUpperCase() : p));
}
