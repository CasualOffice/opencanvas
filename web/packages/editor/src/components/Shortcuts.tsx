// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Keyboard shortcuts help: `?` (outside text) or ⌘⇧/ anywhere, and the More menu.
import { keyParts } from "../lib/keys";
import { Modal, ModalHead } from "./overlay";

const GROUPS: [string, [string, string][]][] = [
  [
    "Blocks",
    [
      ["/", "Insert a block"],
      ["Mod-/", "Block menu: turn into, move, duplicate, delete"],
      ["Mod-d", "Duplicate block"],
      ["Mod-Shift-ArrowUp", "Move block up"],
      ["Mod-Shift-ArrowDown", "Move block down"],
      ["Mod-Enter", "Open or close a toggle"],
      ["Tab", "Next table cell, indent a list item"],
    ],
  ],
  [
    "Text",
    [
      ["Mod-b", "Bold"],
      ["Mod-i", "Italic"],
      ["Mod-u", "Underline"],
      ["Mod-Shift-s", "Strikethrough"],
      ["Mod-e", "Inline code"],
      ["Mod-Shift-h", "Highlight"],
      ["Mod-k", "Add or edit a link"],
      ["@", "Mention someone"],
    ],
  ],
  [
    "Markdown",
    [
      ["#", "Heading 1 (## and ### for 2 and 3)"],
      ["-", "Bulleted list"],
      ["1.", "Numbered list"],
      ["[]", "Checklist"],
      [">", "Quote"],
      [">>", "Toggle"],
      ["```", "Code block"],
      ["---", "Divider"],
    ],
  ],
  [
    "Canvas",
    [
      ["Mod-z", "Undo your last change"],
      ["Mod-Shift-z", "Redo"],
      ["Escape", "Close a menu or dialog"],
      ["Mod-Shift-/", "Keyboard shortcuts"],
    ],
  ],
];

/** Markdown triggers are typed literally; key combos are split into keys. */
const literal = (k: string) => !/^(Mod|Shift|Alt|Ctrl)-|^(Escape|Tab|Enter)$/.test(k);

export function Shortcuts({ onClose }: { onClose(): void }) {
  return (
    <Modal onClose={onClose} label="Keyboard shortcuts" wide>
      <ModalHead title="Keyboard shortcuts" sub="Everything here also works from the menus." onClose={onClose} icon="keyboard" tone="gray" />
      <div className="mbd keys">
        {GROUPS.map(([title, rows]) => (
          <section key={title}>
            <h3>{title}</h3>
            <dl>
              {rows.map(([k, what]) => (
                <div key={k + what}>
                  <dt>{what}</dt>
                  <dd>{literal(k) ? <kbd>{k}</kbd> : keyParts(k).map((p, i) => <kbd key={i}>{p}</kbd>)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
