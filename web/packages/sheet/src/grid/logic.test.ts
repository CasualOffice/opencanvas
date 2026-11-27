// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-04 grid logic: the Excel keyboard model, selection, fill and clipboard parsing.

import { describe, expect, it } from "vitest";
import {
  a1,
  at,
  colIndex,
  colName,
  currentRegion,
  fill,
  fillTarget,
  formatValue,
  jump,
  navigate,
  parseHtmlTable,
  parseRef,
  parseTsv,
  pastedValue,
  rectOf,
  toHtml,
  toTsv,
  type Grid,
} from "./logic";

/** A 20 x 10 grid; `filled` cells as A1 names. */
function grid(filled: string[], hidden: number[] = []): Grid {
  const set = new Set(filled.map((n) => { const q = parseRef(n)!; return `${q.r0}:${q.c0}`; }));
  return { rows: 20, cols: 10, page: 5, filled: (r, c) => set.has(`${r}:${c}`), hidden: (r) => hidden.includes(r) };
}
const nav = (g: Grid, from: string, key: string, o: { shift?: boolean; mod?: boolean } = {}) => {
  const q = parseRef(from)!;
  const s = navigate(g, at(q.r0, q.c0), { key, ...o })!;
  return { anchor: a1(s.anchor), focus: a1(s.focus) };
};

describe("names", () => {
  it("columns and references", () => {
    expect([0, 25, 26, 701, 702].map(colName)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
    expect(colIndex("AA")).toBe(26);
    expect(parseRef("$B$3")).toEqual({ r0: 2, c0: 1, r1: 2, c1: 1 });
    expect(parseRef("C4:A1")).toEqual({ r0: 0, c0: 0, r1: 3, c1: 2 });
    expect(parseRef("hello")).toBeNull();
  });
});

describe("keyboard", () => {
  const g = grid(["A1", "A2", "A3", "A6", "C1"]);
  it("arrows move and stop at the edges", () => {
    expect(nav(g, "B2", "ArrowDown").anchor).toBe("B3");
    expect(nav(g, "A1", "ArrowUp").anchor).toBe("A1");
    expect(nav(g, "A1", "ArrowLeft").anchor).toBe("A1");
    expect(nav(g, "J1", "ArrowRight").anchor).toBe("J1");
  });
  it("Shift extends from the active cell", () => {
    const s = navigate(g, { anchor: { r: 1, c: 1 }, focus: { r: 2, c: 1 } }, { key: "ArrowRight", shift: true })!;
    expect([a1(s.anchor), a1(s.focus)]).toEqual(["B2", "C3"]);
  });
  it("Ctrl+arrow jumps like Excel", () => {
    expect(nav(g, "A1", "ArrowDown", { mod: true }).anchor).toBe("A3"); // end of the run
    expect(nav(g, "A3", "ArrowDown", { mod: true }).anchor).toBe("A6"); // next filled
    expect(nav(g, "A6", "ArrowDown", { mod: true }).anchor).toBe("A20"); // edge
    expect(nav(g, "A1", "ArrowRight", { mod: true }).anchor).toBe("C1");
    expect(nav(g, "B5", "ArrowDown", { mod: true, shift: true })).toEqual({ anchor: "B5", focus: "B20" });
  });
  it("Home, End, Ctrl+Home, Ctrl+End, PageDown", () => {
    expect(nav(g, "D1", "Home").anchor).toBe("A1");
    expect(nav(g, "A1", "End").anchor).toBe("C1");
    expect(nav(g, "E9", "Home", { mod: true }).anchor).toBe("A1");
    expect(nav(g, "A1", "End", { mod: true }).anchor).toBe("C6");
    expect(nav(g, "A1", "PageDown").anchor).toBe("A6");
  });
  it("Ctrl+A selects the region, then the sheet", () => {
    const g2 = grid(["A1", "B1", "A2", "B2", "E9"]);
    const one = navigate(g2, at(0, 0), { key: "a", mod: true })!;
    expect(rectOf(one)).toEqual({ r0: 0, c0: 0, r1: 1, c1: 1 });
    const two = navigate(g2, one, { key: "a", mod: true })!;
    expect(rectOf(two)).toEqual({ r0: 0, c0: 0, r1: 19, c1: 9 });
    expect(currentRegion(g2, { r: 15, c: 7 })).toBeNull();
  });
  it("Enter and Tab move, Shift reverses, and walk inside a range", () => {
    expect(nav(g, "B2", "Enter").anchor).toBe("B3");
    expect(nav(g, "B2", "Enter", { shift: true }).anchor).toBe("B1");
    expect(nav(g, "B2", "Tab").anchor).toBe("C2");
    const range = { anchor: { r: 1, c: 1 }, focus: { r: 2, c: 2 } };
    const s1 = navigate(g, range, { key: "Enter" })!;
    expect(a1(s1.anchor)).toBe("B3");
    const s2 = navigate(g, s1, { key: "Enter" })!;
    expect(a1(s2.anchor)).toBe("C2");
    expect(rectOf(s2)).toEqual({ r0: 1, c0: 1, r1: 2, c1: 2 });
  });
  it("arrows skip rows hidden by a filter", () => {
    const g3 = grid([], [3, 4]);
    expect(nav(g3, "A3", "ArrowDown").anchor).toBe("A6");
    expect(nav(g3, "A6", "ArrowUp").anchor).toBe("A3");
  });
  it("arrows, Tab and Ctrl+arrows skip hidden columns", () => {
    const g4: Grid = { ...grid(["A1", "D1"]), hiddenCol: (c) => c === 1 || c === 2 };
    expect(nav(g4, "A1", "ArrowRight").anchor).toBe("D1");
    expect(nav(g4, "D1", "ArrowLeft").anchor).toBe("A1");
    expect(nav(g4, "A1", "Tab").anchor).toBe("D1");
    expect(nav(g4, "A1", "ArrowRight", { mod: true }).anchor).toBe("D1");
  });
});

describe("fill", () => {
  const cells: Record<string, string> = { A1: "1", A2: "3", B1: "=A1*$C$1", C1: "x" };
  const get = (r: number, c: number) => cells[a1({ r, c })] ?? "";
  // A stand-in for the engine's shift: moves every relative A1 reference.
  const shift = (s: string, dr: number, dc: number) =>
    s.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (_, d1, col, d2, row) => `${d1}${d1 ? col : colName(colIndex(col) + dc)}${d2}${d2 ? row : Number(row) + dr}`);
  it("continues a series of numbers", () => {
    expect(fill({ r0: 0, c0: 0, r1: 1, c1: 0 }, { r0: 0, c0: 0, r1: 4, c1: 0 }, get, shift)).toEqual([[2, 0, "5"], [3, 0, "7"], [4, 0, "9"]]);
  });
  it("shifts formulas and keeps $ parts", () => {
    expect(fill({ r0: 0, c0: 1, r1: 0, c1: 1 }, { r0: 0, c0: 1, r1: 2, c1: 1 }, get, shift)).toEqual([[1, 1, "=A2*$C$1"], [2, 1, "=A3*$C$1"]]);
  });
  it("repeats text and a single number", () => {
    expect(fill({ r0: 0, c0: 2, r1: 0, c1: 2 }, { r0: 0, c0: 2, r1: 0, c1: 4 }, get, shift)).toEqual([[0, 3, "x"], [0, 4, "x"]]);
    expect(fill({ r0: 0, c0: 0, r1: 0, c1: 0 }, { r0: 0, c0: 0, r1: 2, c1: 0 }, get, shift)).toEqual([[1, 0, "1"], [2, 0, "1"]]);
  });
  it("Ctrl-drag copies a series and counts up a single number", () => {
    expect(fill({ r0: 0, c0: 0, r1: 1, c1: 0 }, { r0: 0, c0: 0, r1: 3, c1: 0 }, get, shift, true)).toEqual([[2, 0, "1"], [3, 0, "3"]]);
    expect(fill({ r0: 0, c0: 0, r1: 0, c1: 0 }, { r0: 0, c0: 0, r1: 2, c1: 0 }, get, shift, true)).toEqual([[1, 0, "2"], [2, 0, "3"]]);
  });
  it("the drag target grows along one axis", () => {
    expect(fillTarget({ r0: 1, c0: 1, r1: 1, c1: 1 }, { r: 5, c: 2 })).toEqual({ r0: 1, c0: 1, r1: 5, c1: 1 });
    expect(fillTarget({ r0: 1, c0: 1, r1: 1, c1: 1 }, { r: 1, c: 4 })).toEqual({ r0: 1, c0: 1, r1: 1, c1: 4 });
  });
});

describe("clipboard", () => {
  it("TSV from Excel: quotes, tabs and newlines inside cells, CRLF", () => {
    expect(parseTsv('a\tb\r\n"multi\nline"\t"say ""hi"""\r\n')).toEqual([["a", "b"], ["multi\nline", 'say "hi"']]);
    expect(parseTsv("1\t\t3")).toEqual([["1", "", "3"]]);
    const g = [["x\ty", "plain"], ['q"', ""]];
    expect(parseTsv(toTsv(g))).toEqual(g);
  });
  it("Excel HTML: values, bold, colours, colspan", () => {
    const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><style>.xl65{font-weight:700;color:#FF0000}</style><body><table>
      <tr><td class="xl65">Item</td><td style="background:#FFFF00">€4,200.00</td></tr>
      <tr><td colspan="2">wide</td></tr></table></body></html>`;
    const t = parseHtmlTable(html)!;
    expect(t.cells[0][0]).toEqual({ v: "Item", st: { b: true, fg: "#FF0000" } });
    expect(t.cells[0][1].st).toEqual({ bg: "#FFFF00" });
    expect(t.cells[1].map((c) => c.v)).toEqual(["wide", ""]);
    expect(pastedValue(t.cells[0][1].v)).toEqual({ v: "4200.00", nf: "cur" });
  });
  it("Google Sheets HTML: the typed value wins over the shown text", () => {
    const html = `<google-sheets-html-origin><table><tr><td data-sheets-value='{"1":3,"3":0.25}'>25%</td></tr></table>`;
    expect(parseHtmlTable(html)!.cells[0][0].v).toBe("0.25");
  });
  it("our own HTML round-trips with its marker", () => {
    const t = parseHtmlTable(toHtml([[{ v: "a<b", st: { i: true } }]], "tok"))!;
    expect(t.source).toBe("tok");
    expect(t.cells[0][0]).toEqual({ v: "a<b", st: { i: true } });
  });
  it("pasted and typed text: percent, grouping", () => {
    expect(pastedValue("15%")).toEqual({ v: "0.15", nf: "pct" });
    expect(pastedValue("1,234.5")).toEqual({ v: "1234.5" });
    expect(pastedValue("Venue")).toEqual({ v: "Venue" });
  });
});

describe("formats", () => {
  it("number formats through the style", () => {
    expect(formatValue("0.25", { nf: "pct" }, "en-US")).toBe("25%");
    expect(formatValue("4200", { nf: "cur" }, "en-US", "EUR")).toBe("€4,200.00");
    expect(formatValue("1234.5", { nf: "num" }, "en-US")).toBe("1,234.50");
    expect(formatValue("46095", { nf: "date" }, "en-US")).toBe("Mar 14, 2026");
    expect(formatValue("abc", { nf: "num" })).toBe("abc");
    expect(formatValue("3.14159", { dp: 2 }, "en-US")).toBe("3.14");
  });
});
