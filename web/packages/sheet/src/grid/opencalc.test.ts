// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The rules ported from OpenCalc (opencalc.ts) behave as OpenCalc's own tests say
// (crates/casual-calc-wasm/src/find.rs and style.rs).

import { describe, expect, it } from "vitest";
import { borderEdges, mergeHits, Pattern } from "./opencalc";

describe("Find pattern (find.rs)", () => {
  it("wildcards, ~ escapes, case and entire cell", () => {
    expect(new Pattern("b?d").hits("A bad day", false)).toBe(true);
    expect(new Pattern("b*y").hits("A bad day", false)).toBe(true);
    expect(new Pattern("ba*").matchesWhole("bad")).toBe(true);
    expect(new Pattern("~*").hits("5*2", false)).toBe(true);
    expect(new Pattern("~*").hits("52", false)).toBe(false);
    expect(new Pattern("Venue", true).hits("venue hire", false)).toBe(false);
    expect(new Pattern("venue").hits("Venue hire", false)).toBe(true);
    expect(new Pattern("venue").hits("Venue hire", true)).toBe(false);
    expect(new Pattern("").hits("x", false)).toBe(false);
    expect(new Pattern("*").matchesWhole("")).toBe(false);
  });
  it("replace rewrites every match, keeps the rest, and answers null when nothing matched", () => {
    expect(new Pattern("a").replace("banana", "o", false)).toBe("bonono");
    expect(new Pattern("A1").replace("=A1+A1*2", "B2", false)).toBe("=B2+B2*2");
    expect(new Pattern("n?n").replace("banana", "-", false)).toBe("ba-a");
    expect(new Pattern("x").replace("banana", "o", false)).toBeNull();
    expect(new Pattern("banana").replace("Banana", "kiwi", true)).toBe("kiwi");
    // A character that folds to two (İ) keeps the original intact around the match.
    expect(new Pattern("stanbul").replace("İstanbul", "X", false)).toBe("İX");
  });
  it("a pathological pattern stays linear", () => {
    const t = Date.now();
    expect(new Pattern("*a*a*a*a*a*a*a*a*a*b").hits("a".repeat(5000), false)).toBe(false);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("borders (style.rs border_edges)", () => {
  const q = { r0: 0, c0: 0, r1: 1, c1: 1 };
  it("outer, inner, thick bottom", () => {
    expect(borderEdges("outer", 0, 0, q)).toEqual([true, false, true, false]);
    expect(borderEdges("outer", 1, 1, q)).toEqual([false, true, false, true]);
    expect(borderEdges("inner", 0, 0, q)).toEqual([false, true, false, true]);
    expect(borderEdges("bottomthick", 0, 0, q)).toEqual([false, false, false, false]);
    expect(borderEdges("bottomthick", 1, 0, q)).toEqual([false, true, false, false]);
  });
  it("merges that touch a range", () => {
    expect(mergeHits({ r0: 0, c0: 0, r1: 1, c1: 1 }, { r0: 1, c0: 1, r1: 2, c1: 2 })).toBe(true);
    expect(mergeHits({ r0: 0, c0: 0, r1: 1, c1: 1 }, { r0: 2, c0: 0, r1: 3, c1: 1 })).toBe(false);
  });
});
