// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-06 (frame 8a): "Open as spreadsheet" on a database. Both options were approved: a live
// view (fields stay typed and edits write back; free columns on the right) or a copy.
import { useState } from "react";
import { ensureStyles } from "./styles";
import { Modal } from "./ui";

export function OpenAsSheetDialog({ name, rows, compact, onClose, onOpen }: { name: string; rows: number; compact: boolean; onClose: () => void; onOpen: (mode: "view" | "convert") => void }) {
  ensureStyles();
  const [mode, setMode] = useState<"view" | "convert">("view");
  return (
    <Modal
      compact={compact}
      title={`Open “${name}” as a spreadsheet`}
      onClose={onClose}
      footer={
        <>
          <button className="ocdb-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ocdb-btn primary" onClick={() => onOpen(mode)}>Open</button>
        </>
      }
    >
      <fieldset className="ocdb-ch" role="radiogroup" aria-label="How to open it">
        <label>
          <input type="radio" name="ocdb-sheet-mode" checked={mode === "view"} onChange={() => setMode("view")} />
          <div>
            <b>View as spreadsheet</b>
            <span>Same data, live. Fields stay typed; add free columns on the right for your own formulas.</span>
          </div>
        </label>
        <label>
          <input type="radio" name="ocdb-sheet-mode" checked={mode === "convert"} onChange={() => setMode("convert")} />
          <div>
            <b>Convert to a copy</b>
            <span>New Spreadsheet block with the {rows} {rows === 1 ? "row" : "rows"} as values. The database doesn’t change.</span>
          </div>
        </label>
      </fieldset>
    </Modal>
  );
}
