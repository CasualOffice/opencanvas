// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Whiteboard QA pass (docs/41 §7): geometry defects, each seen failing before its fix.
import { describe, expect, it } from "vitest";
import { anchorPoint, boundaryToward } from "./connectors";
import type { Shape } from "./model";
import { portPoint } from "./ports";
import { qcHandles } from "./select/qc";
import { computeLayout, DEFAULT_LAYOUT } from "./diagram/layout/compute";
import { loadDagre } from "./diagram/layout/load";
import { applyLayout } from "./diagram/layout/apply";
import * as Y from "yjs";
import { createBoard } from "./index";
import { addShape, getBoardMap, readShapes } from "./model";

const near = (a: number[], b: number[]) => {
  expect(a[0]).toBeCloseTo(b[0], 5);
  expect(a[1]).toBeCloseTo(b[1], 5);
};
// 200 × 100 centred on (100, 50), turned 90°: its right side now faces down.
const rot = { id: "r", type: "rect", x: 0, y: 0, w: 200, h: 100, rot: 90 } as Shape;

describe("BRD-35: connectors and quick-connect follow a rotated shape", () => {
  it("anchors turn with the shape", () => {
    near(anchorPoint(rot, "right"), [100, 150]);
    near(anchorPoint(rot, "top"), [150, 50]);
    near(anchorPoint(rot, "center"), [100, 50]);
    near(portPoint(rot, "left")!, [100, -50]);
  });
  it("a centre-bound end meets the turned outline", () => {
    // Straight down from the centre: the turned box's long side (100 from the centre).
    near(boundaryToward(rot, [100, 400]), [100, 150]);
  });
  it("the four + handles sit off the turned sides, not on the corner handles", () => {
    const h = qcHandles(rot, 20);
    near(h.e, [100, 170]);
    near(h.w, [100, -70]);
    near(h.s, [30, 50]);
  });
  it("an unturned shape is unchanged", () => {
    const s = { ...rot, rot: undefined } as Shape;
    near(anchorPoint(s, "right"), [200, 50]);
    near(boundaryToward(s, [100, 400]), [100, 100]);
  });
});

describe("BRD-38: auto-layout ranks connectors to and from a frame", { timeout: 20_000 }, () => {
  it("the demo board (a frame holding a sticky, a loop back into the frame) lays out top to bottom, whatever the ids", async () => {
    const dagre = await loadDagre();
    const list = [
      { id: "zf", type: "rect", x: 30, y: 40, w: 250, h: 170, dashed: true, label: "HOST APP" },
      { id: "zs1", type: "sticky", x: 55, y: 85, w: 190, h: 95, text: "Signs launch token", props: { parent: "zf" } },
      { id: "b2", type: "sticky", x: 340, y: 85, w: 150, h: 110, text: "Room on owner" },
      { id: "a3", type: "sticky", x: 550, y: 85, w: 150, h: 110, text: "Autosave" },
      { id: "t", type: "text", x: 300, y: 300, text: "Every edit merges live.", size: 14 },
      { id: "a1", type: "arrow", pts: [[0, 0], [1, 1]], start: { shapeId: "zf", anchor: "right" }, end: { shapeId: "b2", anchor: "left" } },
      { id: "a2", type: "arrow", pts: [[0, 0], [1, 1]], start: { shapeId: "b2", anchor: "right" }, end: { shapeId: "a3", anchor: "left" } },
      { id: "a3", type: "arrow", pts: [[0, 0], [1, 1]], start: { shapeId: "a3", anchor: "bottom" }, end: { shapeId: "zf", anchor: "bottom" } },
    ] as Shape[];
    const plan = computeLayout(dagre, list, { ...DEFAULT_LAYOUT, direction: "down", keepContainers: true });
    const at = new Map(list.filter((s) => s.type !== "arrow").map((s) => [s.id, [s.x!, s.y!, s.w ?? 0, s.h ?? 0]]));
    for (const m of plan.moves) at.set(m.id, m.to);
    const f = at.get("zf")!, s2 = at.get("b2")!, s3 = at.get("a3")!, s1 = at.get("zs1")!;
    // Layers: the frame, then Room under it, then Autosave under Room.
    expect(s2[1]).toBeGreaterThanOrEqual(f[1] + f[3]);
    expect(s3[1]).toBeGreaterThanOrEqual(s2[1] + s2[3]);
    // The sticky stays inside its frame.
    expect(s1[0]).toBeGreaterThanOrEqual(f[0]);
    expect(s1[1] + s1[3]).toBeLessThanOrEqual(f[1] + f[3]);
  });
});

describe("BRD-38: after auto-layout, connectors leave the sides that face each other", { timeout: 20_000 }, () => {
  it("a right-to-left connector between shapes now stacked top to bottom goes bottom to top", async () => {
    const dagre = await loadDagre();
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const a = addShape(doc, id, { type: "rect", x: 0, y: 0, w: 120, h: 60, text: "A" });
    const b = addShape(doc, id, { type: "rect", x: 300, y: 0, w: 120, h: 60, text: "B" });
    const arrow = addShape(doc, id, { type: "arrow", pts: [[120, 30], [300, 30]], start: { shapeId: a, anchor: "right" }, end: { shapeId: b, anchor: "left" } } as Omit<Shape, "id">);
    const plan = computeLayout(dagre, readShapes(getBoardMap(doc, id)!), DEFAULT_LAYOUT);
    applyLayout(doc, id, plan, false);
    const s = readShapes(getBoardMap(doc, id)!).find((q) => q.id === arrow)!;
    expect([s.start?.anchor, s.end?.anchor]).toEqual(["bottom", "top"]);
    // Keeping the bends keeps the sides too.
    applyLayout(doc, id, computeLayout(dagre, readShapes(getBoardMap(doc, id)!), { ...DEFAULT_LAYOUT, direction: "right" }), true);
    const k = readShapes(getBoardMap(doc, id)!).find((q) => q.id === arrow)!;
    expect([k.start?.anchor, k.end?.anchor]).toEqual(["bottom", "top"]);
  });
});
