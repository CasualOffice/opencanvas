// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-07 (frame 6, v0.4.1): undo of your own step keeps a newer value someone else wrote over
// it and says so ("1 cell kept Lea's newer value"); comments on cells follow their row and column
// ids; charts float over the sheet (4h).
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { undoKeeping } from "./undo";
import { addComment, createSheetBlock, deleteComment, insertRows, readCharts, readComments, readSheets, setChart, setInput } from "./model";

const ORIGIN = "oc-sheet";
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
};
const input = (d: Y.Doc, block: string, sheet: string, r: number, c: number) => {
  const s = readSheets(d, block).find((x) => x.id === sheet)!;
  return s.cells[`${s.rows[r]}:${s.cols[c]}`] ?? "";
};
const put = (d: Y.Doc, block: string, sheet: string, r: number, c: number, v: string) => {
  const s = readSheets(d, block).find((x) => x.id === sheet)!;
  setInput(d, block, sheet, s.rows[r], s.cols[c], v);
};

describe("undo keeps newer values (6a)", () => {
  it("reverts your paste but keeps the cell someone changed since, and names them", () => {
    const a = new Y.Doc();
    const [block, sheet] = createSheetBlock(a);
    put(a, block, sheet, 0, 0, "old");
    const b = new Y.Doc();
    sync(a, b);
    const um = new Y.UndoManager(a.getMap("sheets"), { trackedOrigins: new Set([ORIGIN]) });
    // Priya pastes A1:A3 (A1 had a value; A2 and A3 were empty): one step.
    a.transact(() => ["p1", "p2", "p3"].forEach((v, r) => put(a, block, sheet, r, 0, v)), ORIGIN);
    sync(a, b);
    // Lea changes A1 and A2 after the paste.
    put(b, block, sheet, 0, 0, "lea1");
    put(b, block, sheet, 1, 0, "lea2");
    sync(a, b);
    const kept = undoKeeping(a, um, "keep");
    expect(kept.cells).toBe(2);
    expect(kept.by).toEqual([b.clientID]);
    expect([0, 1, 2].map((r) => input(a, block, sheet, r, 0))).toEqual(["lea1", "lea2", ""]);
    sync(a, b);
    expect([0, 1, 2].map((r) => input(b, block, sheet, r, 0))).toEqual(["lea1", "lea2", ""]);
  });

  it("a plain undo with no one else's change reports nothing kept", () => {
    const a = new Y.Doc();
    const [block, sheet] = createSheetBlock(a);
    const um = new Y.UndoManager(a.getMap("sheets"), { trackedOrigins: new Set([ORIGIN]) });
    a.transact(() => put(a, block, sheet, 0, 0, "x"), ORIGIN);
    expect(undoKeeping(a, um, "keep")).toEqual({ cells: 0, by: [] });
    expect(input(a, block, sheet, 0, 0)).toBe("");
  });
});

describe("cell comments (6b)", () => {
  it("threads follow the cell through an insert, and a deleted comment goes", () => {
    const doc = new Y.Doc();
    const [block, sheet] = createSheetBlock(doc);
    const s0 = readSheets(doc, block)[0];
    const [r, c] = [s0.rows[0], s0.cols[1]];
    const first = addComment(doc, block, sheet, r, c, { by: "u_lea", name: "Lea", text: "Worth it?" }, 1000);
    addComment(doc, block, sheet, r, c, { by: "u_amara", name: "Amara", text: "Yes" }, 2000);
    insertRows(doc, block, sheet, 0, 2);
    const s = readSheets(doc, block)[0];
    const thread = readComments(doc, block, sheet).get(`${s.rows[2]}:${s.cols[1]}`)!;
    expect(thread.map((t) => [t.name, t.text])).toEqual([["Lea", "Worth it?"], ["Amara", "Yes"]]);
    deleteComment(doc, block, sheet, r, c, first);
    expect(readComments(doc, block, sheet).get(`${r}:${c}`)!.map((t) => t.text)).toEqual(["Yes"]);
  });
});

describe("floating charts (4h)", () => {
  it("are stored on the sheet by id, anchored to a cell", () => {
    const doc = new Y.Doc();
    const [block, sheet] = createSheetBlock(doc);
    const s = readSheets(doc, block)[0];
    setChart(doc, block, sheet, "c1", { attrs: { kind: "bar", r0: s.rows[0] }, row: s.rows[1], col: s.cols[3] });
    expect(readCharts(doc, block, sheet)).toEqual([{ id: "c1", attrs: { kind: "bar", r0: s.rows[0] }, row: s.rows[1], col: s.cols[3] }]);
    setChart(doc, block, sheet, "c1", null);
    expect(readCharts(doc, block, sheet)).toEqual([]);
  });
});
