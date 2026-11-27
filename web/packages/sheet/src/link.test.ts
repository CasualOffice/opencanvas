// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-06 (frame 8a): a database opened as a spreadsheet, as a live view or as a copy.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { HEADER_ROW, createSheetFrom, linkedEdits, linkOf, syncLinked, type LinkedDb } from "./link";
import { readSheets } from "./model";

const db = (): LinkedDb => ({
  fields: [
    { id: "f1", name: "Item", type: "title" },
    { id: "f2", name: "Price", type: "number" },
  ],
  rows: [
    { id: "r1", cells: ["Venue hire", "4200"] },
    { id: "r2", cells: ["Lunch", "38"] },
  ],
});

const cellsOf = (doc: Y.Doc, block: string) => readSheets(doc, block)[0];

describe("createSheetFrom", () => {
  it("copies values into a new block, the database untouched (convert)", () => {
    const doc = new Y.Doc();
    const b = createSheetFrom(doc, "Launch budget", [["Item", "Price"], ["Venue hire", "4200"]]);
    const s = cellsOf(doc, b);
    expect(s.name).toBe("Launch budget");
    expect(s.cells[`${s.rows[0]}:${s.cols[0]}`]).toBe("Item");
    expect(s.cells[`${s.rows[1]}:${s.cols[1]}`]).toBe("4200");
    expect(linkOf(doc, b)).toBeNull();
    expect(s.rows.length).toBeGreaterThanOrEqual(2);
  });
});

describe("live view", () => {
  it("lays out fields as columns and records as rows, with free columns to the right", () => {
    const doc = new Y.Doc();
    const b = createSheetFrom(doc, "Launch budget", [], { db: "d1", snap: db() });
    expect(linkOf(doc, b)).toBe("d1");
    const s = cellsOf(doc, b);
    expect(s.rows.slice(0, 3)).toEqual([HEADER_ROW, "r1", "r2"]);
    expect(s.cols.slice(0, 2)).toEqual(["f1", "f2"]);
    expect(s.cols.length).toBeGreaterThan(2);
    expect(s.cells["hdr:f1"]).toBe("Item");
    expect(s.cells["r1:f2"]).toBe("4200");
  });

  it("follows the database: values, new and deleted records, fields", () => {
    const doc = new Y.Doc();
    const b = createSheetFrom(doc, "Launch budget", [], { db: "d1", snap: db() });
    // A free formula to the right stays where it is.
    const free = cellsOf(doc, b).cols[2];
    doc.getMap<Y.Map<unknown>>("sheets"); // root exists
    const next = db();
    next.rows[0].cells[1] = "4300";
    next.rows.splice(1, 1);
    next.rows.push({ id: "r3", cells: ["Badges", "1.1"] });
    next.fields.push({ id: "f3", name: "Paid", type: "checkbox" });
    next.rows.forEach((r) => r.cells.push("false"));
    syncLinked(doc, b, next, true);
    const s = cellsOf(doc, b);
    expect(s.rows.slice(0, 3)).toEqual([HEADER_ROW, "r1", "r3"]);
    expect(s.cols.slice(0, 4)).toEqual(["f1", "f2", "f3", free]);
    expect(s.cells["r1:f2"]).toBe("4300");
    expect(s.cells["r3:f1"]).toBe("Badges");
    expect(s.cells["hdr:f3"]).toBe("Paid");
    expect(s.cells["r2:f1"]).toBeUndefined();
  });

  it("without structure (someone else's change) only values are written", () => {
    const doc = new Y.Doc();
    const b = createSheetFrom(doc, "x", [], { db: "d1", snap: db() });
    const next = db();
    next.rows.push({ id: "r9", cells: ["New", "1"] });
    next.rows[0].cells[0] = "Hall";
    syncLinked(doc, b, next, false);
    const s = cellsOf(doc, b);
    expect(s.rows).not.toContain("r9");
    expect(s.cells["r1:f1"]).toBe("Hall");
  });

  it("edits in field columns write back; formulas there are refused", () => {
    const doc = new Y.Doc();
    const b = createSheetFrom(doc, "x", [], { db: "d1", snap: db() });
    const cells = (doc.getMap<Y.Map<unknown>>("sheets").get(b)!.get("sheets") as Y.Map<Y.Map<unknown>>).values().next().value!.get("cells") as Y.Map<Y.Map<unknown>>;
    cells.get("r2:f2")!.set("in", "40");
    cells.get("r1:f1")!.set("in", "=1+1");
    const out = linkedEdits(doc, b, db());
    expect(out.writes).toEqual([{ row: "r2", field: "f2", text: "40" }]);
    expect(out.refused).toBe(1);
    // The refused formula is put back.
    expect(cellsOf(doc, b).cells["r1:f1"]).toBe("Venue hire");
  });
});
