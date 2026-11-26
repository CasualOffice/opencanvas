// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-02: the Yjs model with the engine. Concurrent row inserts and formula edits converge on
// the same cells (the reason references are stored as ids, ADR-080 §3).

import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { instantiate, type SheetEngine, type Shown } from "./engine/engine";
import { addSheet, createSheetBlock, deleteRows, deleteSheet, insertRows, NEW_COLS, NEW_ROWS, readSheets, renameSheet, setInput } from "./model";

interface Fs { readFileSync(p: URL): Uint8Array<ArrayBuffer> }
const { readFileSync } = (await import(/* @vite-ignore */ ["node", "fs"].join(":"))) as Fs;
let e: SheetEngine;
beforeAll(async () => {
  e = await instantiate(readFileSync(new URL("./engine/oc_sheet.wasm", import.meta.url)));
});

/** Types `text` into A1-addressed `cell` the way the grid will: converted to stored form. */
function type(doc: Y.Doc, block: string, sheet: string, cell: string, text: string) {
  const sheets = readSheets(doc, block);
  const s = sheets.find((x) => x.id === sheet)!;
  const col = cell.charCodeAt(0) - 65;
  const row = Number(cell.slice(1)) - 1;
  setInput(doc, block, sheet, s.rows[row], s.cols[col], e.toIds(text, sheet, sheets));
}

function shown(doc: Y.Doc, block: string, sheet: string, cell: string) {
  const sheets = readSheets(doc, block);
  const s = sheets.find((x) => x.id === sheet)!;
  const out: Shown[] = e.compute(sheets);
  const rid = s.rows[Number(cell.slice(1)) - 1];
  const cid = s.cols[cell.charCodeAt(0) - 65];
  return out.find((x) => x[0] === sheet && x[1] === rid && x[2] === cid)?.[3];
}

function formula(doc: Y.Doc, block: string, sheet: string, cell: string) {
  const sheets = readSheets(doc, block);
  const s = sheets.find((x) => x.id === sheet)!;
  const key = `${s.rows[Number(cell.slice(1)) - 1]}:${s.cols[cell.charCodeAt(0) - 65]}`;
  return e.toA1(s.cells[key] ?? "", sheet, sheets);
}

const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
};

describe("spreadsheet model", () => {
  it("a new block has one sheet of 100 rows and 26 columns", () => {
    const doc = new Y.Doc();
    const [block] = createSheetBlock(doc);
    const [s] = readSheets(doc, block);
    expect([s.name, s.rows.length, s.cols.length]).toEqual(["Sheet1", NEW_ROWS, NEW_COLS]);
  });

  it("computes, keeps formulas on their cells through inserts, and breaks on deletes", () => {
    const doc = new Y.Doc();
    const [block, sheet] = createSheetBlock(doc, "Budget");
    type(doc, block, sheet, "A1", "10");
    type(doc, block, sheet, "A2", "20");
    type(doc, block, sheet, "A3", "=SUM(A1:A2)");
    expect(shown(doc, block, sheet, "A3")).toBe("30");
    insertRows(doc, block, sheet, 1, 2);
    expect(formula(doc, block, sheet, "A5")).toBe("=SUM(A1:A4)");
    expect(shown(doc, block, sheet, "A5")).toBe("30");
    // Deleting a row inside the range shrinks it, as in Excel.
    deleteRows(doc, block, sheet, 1, 1);
    expect(formula(doc, block, sheet, "A4")).toBe("=SUM(A1:A3)");
    expect(shown(doc, block, sheet, "A4")).toBe("30");
    // Deleting an end row: Excel moves that end inward; ids alone cannot yet (SHEET-02 open item).
    deleteRows(doc, block, sheet, 0, 1);
    expect(formula(doc, block, sheet, "A3")).toBe("=SUM(#REF!)");
  });

  it("cross-sheet references follow renames and break when the sheet goes", () => {
    const doc = new Y.Doc();
    const [block, budget] = createSheetBlock(doc, "Budget");
    const rates = addSheet(doc, block, "Rates");
    type(doc, block, rates, "B3", "35");
    type(doc, block, budget, "A1", "=Rates!B3*2");
    expect(shown(doc, block, budget, "A1")).toBe("70");
    renameSheet(doc, block, rates, "Prices");
    expect(formula(doc, block, budget, "A1")).toBe("=Prices!B3*2");
    deleteSheet(doc, block, rates);
    expect(formula(doc, block, budget, "A1")).toBe("=#REF!*2");
  });

  it("a row inserted by one person while another types a formula: both converge on the same cells", () => {
    const a = new Y.Doc();
    const [block, sheet] = createSheetBlock(a, "Budget");
    for (const [cell, v] of [["A1", "1"], ["A2", "2"], ["A3", "3"], ["A4", "4"]]) type(a, block, sheet, cell, v);
    const b = new Y.Doc();
    sync(a, b);
    // Offline at the same time: Lea inserts two rows above row 2; Ravi sums A2:A4 into B1.
    insertRows(a, block, sheet, 1, 2);
    type(b, block, sheet, "B1", "=SUM(A2:A4)");
    sync(a, b);
    for (const d of [a, b]) {
      expect(formula(d, block, sheet, "B1")).toBe("=SUM(A4:A6)");
      expect(shown(d, block, sheet, "B1")).toBe("9");
    }
    expect(JSON.stringify(readSheets(a, block))).toBe(JSON.stringify(readSheets(b, block)));
  });
});
