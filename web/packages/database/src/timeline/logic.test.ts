// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DB5-01 Timeline and Workload logic: working days, spans, dependencies, the shift of
// dependents, the critical path and workload.

import { describe, expect, it } from "vitest";
import type { DbRow, DbSnapshot } from "../types";
import { addDays, barLabel, byWeek, conflicts, criticalPath, day, diffDays, edges, iso, resolve, shiftPlan, spanDays, spanOf, workload, type Span } from "./logic";

const D = (s: string) => day(s)!;
const row = (id: string, v: Record<string, unknown>): DbRow => ({ id, v: v as DbRow["v"] });
const P = { start: "s", end: "e", dep: "dep", work: true };

describe("working days", () => {
  it("skip weekends when asked", () => {
    // 2026-12-11 is a Friday.
    expect(iso(addDays(D("2026-12-11"), 1, true))).toBe("2026-12-14");
    expect(iso(addDays(D("2026-12-14"), -1, true))).toBe("2026-12-11");
    expect(iso(addDays(D("2026-12-11"), 1, false))).toBe("2026-12-12");
    expect(spanDays(D("2026-12-14"), D("2026-12-20"), true)).toBe(5);
    expect(diffDays(D("2026-12-11"), D("2026-12-15"), true)).toBe(2);
  });
});

describe("spans and settings", () => {
  it("start and end, or start and a duration in working days; no start goes to the tray", () => {
    expect(spanOf(row("a", { s: "2026-12-14", e: "2026-12-18" }), P)).toEqual({ id: "a", s: D("2026-12-14"), e: D("2026-12-18"), ms: false });
    const sp = spanOf(row("a", { s: "2026-12-17", d: 3 }), { start: "s", dur: "d", work: true })!;
    expect(iso(sp.e)).toBe("2026-12-21");
    expect(spanOf(row("a", { s: "" }), P)).toBeNull();
    expect(spanOf(row("a", { s: "2026-12-14", t: true }), { ...P, ms: { f: "t", v: "true" } })!.ms).toBe(true);
  });
  it("defaults pick the first two dates, the self-relation, status and progress", () => {
    const db = {
      id: "db",
      fields: [
        { id: "t", name: "Task", type: "title" },
        { id: "st", name: "Status", type: "status" },
        { id: "s", name: "Start", type: "date" },
        { id: "e", name: "Due", type: "date" },
        { id: "dep", name: "Blocked by", type: "relation", rel: { db: "db", two: true, back: "b" } },
        { id: "b", name: "Blocks", type: "relation", rel: { db: "db", two: true, back: "dep" } },
        { id: "pr", name: "Progress", type: "progress" },
      ],
      rows: [],
    } as unknown as DbSnapshot;
    const r = resolve(db);
    expect([r.start, r.end, r.dep, r.color, r.prog, r.zoom, r.work]).toEqual(["s", "e", "dep", "st", "pr", "week", true]);
  });
});

describe("dependencies", () => {
  const rows = [
    row("api", { s: "2026-12-14", e: "2026-12-18" }),
    row("sdk", { s: "2026-12-21", e: "2026-12-23", dep: ["api"] }),
    row("beta", { s: "2026-12-24", e: "2026-12-28", dep: ["sdk"] }),
    row("side", { s: "2026-12-14", e: "2026-12-15" }),
  ];
  const spans = new Map(rows.map((r) => [r.id, spanOf(r, P)!] as [string, Span]));
  const es = edges(rows, "dep");
  it("edges come from Blocked by", () => {
    expect(es).toEqual([["api", "sdk"], ["sdk", "beta"]]);
    expect(conflicts(spans, es)).toEqual([]);
  });
  it("moving API freeze past its dependents: shift both by the same working days", () => {
    spans.set("api", { ...spans.get("api")!, s: D("2026-12-17"), e: D("2026-12-23") });
    expect(conflicts(spans, es)).toEqual([["api", "sdk"]]);
    // SDK docs must start Dec 24: 3 working days later; Partner beta moves the same.
    expect(shiftPlan(spans, es, "api", true)).toEqual({ days: 3, ids: ["sdk", "beta"] });
    spans.set("api", { ...spans.get("api")!, s: D("2026-12-14"), e: D("2026-12-18") });
    expect(shiftPlan(spans, es, "api", true)).toEqual({ days: 0, ids: [] });
  });
  it("the critical path is the chain with no slack", () => {
    const c = criticalPath(spans, es, true);
    expect([...c].sort()).toEqual(["api", "beta", "sdk"]);
    expect(c.has("side")).toBe(false);
  });
  it("names the bar for screen readers", () => {
    expect(barLabel("API freeze", spans.get("api")!, ["SDK docs", "Partner beta"], [])).toBe("API freeze, Dec 14 to Dec 18, blocks SDK docs and Partner beta");
  });
});

describe("workload and the phone list", () => {
  it("spreads estimates over working days, unassigned on its own row", () => {
    const rows = [
      row("a", { s: "2026-12-14", e: "2026-12-25", who: "u1", est: 60 }),
      row("b", { s: "2026-12-14", e: "2026-12-18", who: "u1", est: 10 }),
      row("c", { s: "2026-12-21", e: "2026-12-21", est: 4 }),
    ];
    const w = workload(rows, { ...P, who: "who", est: "est" }, [D("2026-12-14"), D("2026-12-21")]);
    expect(w.get("u1")!.map((c) => c.hours)).toEqual([40, 30]);
    expect(w.get("")!.map((c) => c.hours)).toEqual([0, 4]);
    expect(byWeek(rows, P).map((g) => [iso(g.week), g.items.length])).toEqual([["2026-12-14", 2], ["2026-12-21", 1]]);
  });
});
