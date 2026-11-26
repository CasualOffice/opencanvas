// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The WASM engine (SHEET-01) gives the native results (crates/oc-sheet engine tests): the
// prototype's Launch budget across three sheets, references kept through a row insert, only
// the changed cells after an edit in a kept workbook.

import { describe, expect, it } from "vitest";
import { instantiate, setEngineSource, loadSheetEngine, type EngineSheet, type Shown } from "./engine";

interface Fs { readFileSync(p: URL): Uint8Array<ArrayBuffer> }
const { readFileSync } = (await import(/* @vite-ignore */ ["node", "fs"].join(":"))) as Fs;
const wasm = readFileSync(new URL("./oc_sheet.wasm", import.meta.url));

const ids = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);

/** Budget, Rates and Summary with typed (A1) inputs, stored through the engine's converter. */
async function launchBudget() {
  const e = await instantiate(wasm);
  const sheets: EngineSheet[] = [
    { id: "sb", name: "Budget", rows: ids("b", 10), cols: ids("x", 5), cells: {} },
    { id: "sr", name: "Rates", rows: ids("r", 5), cols: ids("y", 3), cells: {} },
    { id: "ss", name: "Summary", rows: ids("s", 5), cols: ids("z", 3), cells: {} },
  ];
  const put = (k: number, a1: string, typed: string) => {
    const c = a1.charCodeAt(0) - 65;
    const r = Number(a1.slice(1)) - 1;
    sheets[k].cells[`${sheets[k].rows[r]}:${sheets[k].cols[c]}`] = e.toIds(typed, sheets[k].id, sheets);
  };
  put(1, "A1", "Venue"), put(1, "B1", "4200"), put(1, "A2", "Catering"), put(1, "B2", "35");
  put(0, "A2", "Venue"), put(0, "B2", "1"), put(0, "C2", "=B2*VLOOKUP(A2,Rates!$A$1:$B$5,2,FALSE)");
  put(0, "A3", "Catering"), put(0, "B3", "120"), put(0, "C3", "=B3*VLOOKUP(A3,Rates!$A$1:$B$5,2,FALSE)");
  put(0, "C4", "=SUM(C2:C3)");
  put(2, "A1", "=Budget!C4");
  return { e, sheets };
}

const at = (out: Shown[], s: string, r: string, c: string) => out.find((x) => x[0] === s && x[1] === r && x[2] === c)?.[3];

describe("sheet engine (WASM)", () => {
  it("computes the Launch budget across sheets from stored ids", async () => {
    const { e, sheets } = await launchBudget();
    const out = e.compute(sheets);
    expect(at(out, "sb", "b3", "x2")).toBe("8400");
    expect(at(out, "ss", "s0", "z0")).toBe("8400");
    expect(e.toA1(sheets[0].cells["b3:x2"], "sb", sheets)).toBe("=SUM(C2:C3)");
    // A row inserted inside the range: the formula reads C2:C4 and the total stays.
    sheets[0].rows.splice(2, 0, "new");
    expect(e.toA1(sheets[0].cells["b3:x2"], "sb", sheets)).toBe("=SUM(C2:C4)");
    expect(at(e.compute(sheets), "sb", "b3", "x2")).toBe("8400");
  });

  it("a kept workbook answers only the cells an edit changed", async () => {
    const { e, sheets } = await launchBudget();
    expect(at(e.open("blk", sheets), "ss", "s0", "z0")).toBe("8400");
    const changed = e.set("blk", "sb", "b2", "x1", "100").map((x) => x.join(" ")).sort();
    expect(changed).toEqual(["sb b2 x1 100", "sb b2 x2 3500", "sb b3 x2 7700", "ss s0 z0 7700"]);
    e.close("blk");
    expect(() => e.set("blk", "sb", "b2", "x1", "1")).toThrow("not open");
  });

  it("shifts relative references for fill and paste", async () => {
    const { e } = await launchBudget();
    expect(e.shift("=A1+$B$1+C$2", 1, 1)).toBe("=B2+$B$1+D$2");
  });

  it("loads once through the lazy loader", async () => {
    let fetched = 0;
    setEngineSource(async () => (fetched++, wasm.slice().buffer));
    const [a, b] = await Promise.all([loadSheetEngine(), loadSheetEngine()]);
    expect(a).toBe(b);
    expect(fetched).toBe(1);
  });
});
