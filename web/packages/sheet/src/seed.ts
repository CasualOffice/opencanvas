// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// A spreadsheet block filled from a grid of typed values (A1 formulas), for the demo and
// templates. Formulas are stored with references as ids through the engine, as typing does.

import type * as Y from "yjs";
import { loadSheetEngine } from "./engine/engine";
import { createSheetBlock, readSheets, setInput, setSize, setStyle, sheetOf } from "./model";
import { parseRef } from "./grid/logic";

export interface SeededSheet {
  blockId: string;
  sheetId: string;
  rows: string[];
  cols: string[];
}

/** `grid` is rows of typed cells; `styles` maps A1 ranges to a cell style; `widths` are rem by
 *  column index. */
export async function seedSheet(doc: Y.Doc, name: string, grid: string[][], styles: Record<string, Record<string, unknown>> = {}, widths: number[] = []): Promise<SeededSheet> {
  const engine = await loadSheetEngine();
  const [blockId, sheetId] = createSheetBlock(doc, name);
  const s = sheetOf(doc, blockId, sheetId)!;
  const rows = (s.get("rows") as Y.Array<string>).toArray();
  const cols = (s.get("cols") as Y.Array<string>).toArray();
  doc.transact(() => {
    const sheets = readSheets(doc, blockId);
    grid.forEach((row, r) =>
      row.forEach((typed, c) => {
        if (!typed) return;
        const stored = typed.startsWith("=") ? engine.toIds(typed, sheetId, sheets) : typed;
        setInput(doc, blockId, sheetId, rows[r], cols[c], stored);
      }),
    );
    // Ranges that overlap add up (a total row's bold keeps its column's currency format).
    const per = new Map<string, Record<string, unknown>>();
    for (const [ref, st] of Object.entries(styles)) {
      const q = parseRef(ref);
      if (!q) continue;
      for (let r = q.r0; r <= q.r1; r++) for (let c = q.c0; c <= q.c1; c++) per.set(`${r}:${c}`, { ...(per.get(`${r}:${c}`) ?? {}), ...st });
    }
    for (const [k, st] of per) {
      const [r, c] = k.split(":").map(Number);
      setStyle(doc, blockId, sheetId, rows[r], cols[c], st);
    }
    widths.forEach((w, c) => w && setSize(doc, blockId, sheetId, "widths", cols[c], w));
  });
  return { blockId, sheetId, rows, cols };
}
