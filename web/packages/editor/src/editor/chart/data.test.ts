// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-06 (4h): what a linked chart draws, from a sheet range or a database's groups. The same
// rules run in Rust for exports (crates/oc-model/src/chart.rs); the cases here match its tests.
import { describe, expect, it } from "vitest";
import { a1Range, fromGrid, fromGroups, niceTicks, parseNum, short, toTable } from "./data";

describe("parseNum", () => {
  it("reads numbers as the sheet shows them", () => {
    expect(parseNum("4200")).toBe(4200);
    expect(parseNum("€4,200.50")).toBe(4200.5);
    expect(parseNum("-3")).toBe(-3);
    expect(parseNum("(1,000)")).toBe(-1000);
    expect(parseNum("12%")).toBe(12);
    expect(parseNum("1e3")).toBe(1000);
    expect(parseNum("")).toBeNull();
    expect(parseNum("Venue")).toBeNull();
    expect(parseNum("TRUE")).toBeNull();
    expect(parseNum("#REF!")).toBeNull();
  });
});

describe("fromGrid", () => {
  it("takes a header row and a category column", () => {
    const d = fromGrid([
      ["Category", "Total", "Gross"],
      ["Venue", "6600", "7854"],
      ["Food", "5400", ""],
    ]);
    expect(d.catLabel).toBe("Category");
    expect(d.categories).toEqual(["Venue", "Food"]);
    expect(d.series).toEqual([
      { name: "Total", values: [6600, 5400] },
      { name: "Gross", values: [7854, null] },
    ]);
  });
  it("numbers only: every column is a series, rows are numbered", () => {
    const d = fromGrid([
      ["1", "10"],
      ["2", "20"],
    ]);
    expect(d.categories).toEqual(["1", "2"]);
    expect(d.series.map((s) => s.name)).toEqual(["Series 1", "Series 2"]);
    expect(d.series[1].values).toEqual([10, 20]);
  });
  it("skips empty rows and keeps a one-column range", () => {
    const d = fromGrid([["Cost"], ["4"], [""], ["6"]]);
    expect(d.categories).toEqual(["1", "2"]);
    expect(d.series).toEqual([{ name: "Cost", values: [4, 6] }]);
  });
});

describe("fromGroups", () => {
  const items = [
    { key: "Venue", value: 4200 },
    { key: "Food", value: 38 },
    { key: "Venue", value: 890 },
    { key: "", value: null },
  ];
  it("sums, counts and averages per group in first-seen order", () => {
    expect(fromGroups(items, "sum", "Total")).toEqual({ catLabel: "", categories: ["Venue", "Food", "(empty)"], series: [{ name: "Sum of Total", values: [5090, 38, null] }] });
    expect(fromGroups(items, "count", "").series[0]).toEqual({ name: "Count", values: [2, 1, 1] });
    expect(fromGroups(items, "avg", "Total").series[0].values).toEqual([2545, 38, null]);
    expect(fromGroups(items, "max", "Total").series[0].values).toEqual([4200, 38, null]);
  });
});

describe("helpers", () => {
  it("a1Range reads A1 ranges", () => {
    expect(a1Range("B2:C10")).toEqual({ r0: 1, c0: 1, r1: 9, c1: 2 });
    expect(a1Range("c10:b2")).toEqual({ r0: 1, c0: 1, r1: 9, c1: 2 });
    expect(a1Range("AA1")).toEqual({ r0: 0, c0: 26, r1: 0, c1: 26 });
    expect(a1Range("nope")).toBeNull();
  });
  it("ticks and short labels", () => {
    expect(niceTicks(0, 8600)).toEqual([0, 2000, 4000, 6000, 8000, 10000]);
    expect(niceTicks(-5, 5)).toEqual([-6, -4, -2, 0, 2, 4, 6]);
    expect(short(6600)).toBe("6.6k");
    expect(short(1_250_000)).toBe("1.3M");
    expect(short(38)).toBe("38");
    expect(short(2.5)).toBe("2.5");
  });
  it("toTable is the accessible fallback and the export's table", () => {
    const d = fromGrid([
      ["Category", "Total"],
      ["Venue", "6600"],
      ["Food", "5400.5"],
    ]);
    expect(toTable(d)).toEqual([
      ["Category", "Total"],
      ["Venue", "6600"],
      ["Food", "5400.5"],
    ]);
  });
});
