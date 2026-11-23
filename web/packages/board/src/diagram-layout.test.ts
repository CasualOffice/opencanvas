// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DGM-14.6 auto-layout (S6): deterministic Dagre layout, containers kept, applied as one undo step.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createBoard } from "./index";
import { addShape, getBoardMap, readShapes, type Shape } from "./model";
import { computeLayout, DEFAULT_LAYOUT, type LayoutOptions } from "./diagram/layout/compute";
import { applyLayout } from "./diagram/layout/apply";
import { loadDagre } from "./diagram/layout/load";

const ORIGIN = { test: "layout" };

function board() {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  const box = (text: string, x: number, y: number, parent?: string) =>
    addShape(doc, id, { type: "rect", x, y, w: 120, h: 60, text, ...(parent ? { props: { parent } } : {}) });
  const vpc = addShape(doc, id, { type: "rect", x: 400, y: 400, w: 300, h: 300, dashed: true, label: "VPC" });
  const a = box("Gateway", 500, 20);
  const b = box("Orders", 10, 300, vpc);
  const c = box("Payments", 900, 50, vpc);
  const d = box("Database", 30, 30);
  const arrow = (s: string, e: string) =>
    addShape(doc, id, { type: "arrow", pts: [[0, 0], [1, 1]], start: { shapeId: s, anchor: "center" }, end: { shapeId: e, anchor: "center" }, via: [[5, 5]] } as Omit<Shape, "id">);
  arrow(a, b);
  arrow(a, c);
  arrow(b, d);
  arrow(c, d);
  return { doc, id, ids: { vpc, a, b, c, d } };
}

const shapes = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);
const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((x, y) => (x.id < y.id ? -1 : 1));

describe("auto-layout (DGM-14.6)", { timeout: 20_000 }, () => {
  it("follows the connectors, top to bottom or left to right", async () => {
    const dagre = await loadDagre();
    const { doc, id, ids } = board();
    const plan = computeLayout(dagre, shapes(doc, id), DEFAULT_LAYOUT);
    const at = new Map(plan.moves.map((m) => [m.id, m.to]));
    expect(at.get(ids.b)![1]).toBeGreaterThan(at.get(ids.a)![1] + 60);
    expect(at.get(ids.d)![1]).toBeGreaterThan(at.get(ids.b)![1] + 60);
    const right = computeLayout(dagre, shapes(doc, id), { ...DEFAULT_LAYOUT, direction: "right" });
    const rt = new Map(right.moves.map((m) => [m.id, m.to]));
    expect(rt.get(ids.d)![0]).toBeGreaterThan(rt.get(ids.b)![0] + 120);
  });

  it("is deterministic: same input, same positions, whatever the order of the shapes", async () => {
    const dagre = await loadDagre();
    const { doc, id } = board();
    const list = shapes(doc, id);
    const one = computeLayout(dagre, list, DEFAULT_LAYOUT);
    const two = computeLayout(dagre, [...list].reverse(), DEFAULT_LAYOUT);
    expect(byId(two.moves)).toEqual(byId(one.moves));
    expect(computeLayout(dagre, list, DEFAULT_LAYOUT)).toEqual(one);
  });

  it("keeps shapes inside their containers and resizes the container around them", async () => {
    const dagre = await loadDagre();
    const { doc, id, ids } = board();
    const plan = computeLayout(dagre, shapes(doc, id), DEFAULT_LAYOUT);
    const at = new Map(plan.moves.map((m) => [m.id, m.to]));
    const v = at.get(ids.vpc)!;
    for (const k of [ids.b, ids.c]) {
      const s = at.get(k)!;
      expect(s[0]).toBeGreaterThanOrEqual(v[0]);
      expect(s[1]).toBeGreaterThanOrEqual(v[1]);
      expect(s[0] + s[2]).toBeLessThanOrEqual(v[0] + v[2]);
      expect(s[1] + s[3]).toBeLessThanOrEqual(v[1] + v[3]);
    }
    expect(plan.containers).toBe(1);
  });

  it("arranges only the selection or a container's contents when asked", async () => {
    const dagre = await loadDagre();
    const { doc, id, ids } = board();
    const sel: LayoutOptions = { ...DEFAULT_LAYOUT, scope: { kind: "selection", ids: [ids.a, ids.d] } };
    const s = computeLayout(dagre, shapes(doc, id), sel).moves;
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((m) => m.id === ids.a || m.id === ids.d)).toBe(true);
    const inside: LayoutOptions = { ...DEFAULT_LAYOUT, scope: { kind: "container", id: ids.vpc } };
    const c = computeLayout(dagre, shapes(doc, id), inside).moves;
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((m) => m.id === ids.b || m.id === ids.c)).toBe(true);
  });

  it("applies everything as one transaction: one Undo restores every position and bend", async () => {
    const dagre = await loadDagre();
    const { doc, id } = board();
    const before = shapes(doc, id);
    const um = new Y.UndoManager(getBoardMap(doc, id)!, { trackedOrigins: new Set([ORIGIN]) });
    let tx = 0;
    doc.on("afterTransaction", () => tx++);
    const plan = computeLayout(dagre, before, DEFAULT_LAYOUT);
    expect(plan.moves.length).toBeGreaterThan(3);
    applyLayout(doc, id, plan, false, ORIGIN);
    expect(tx).toBe(1);
    expect(shapes(doc, id).filter((s) => s.type === "arrow").every((s) => !s.via)).toBe(true);
    expect(um.undoStack.length).toBe(1);
    um.undo();
    expect(byId(shapes(doc, id))).toEqual(byId(before));
  });

  it("keeps bends when asked", async () => {
    const dagre = await loadDagre();
    const { doc, id } = board();
    applyLayout(doc, id, computeLayout(dagre, shapes(doc, id), DEFAULT_LAYOUT), true, ORIGIN);
    expect(shapes(doc, id).filter((s) => s.type === "arrow").every((s) => s.via?.length === 1)).toBe(true);
  });
});
