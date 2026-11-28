// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Whiteboard QA pass (docs/41 §7): geometry defects, each seen failing before its fix.
import { describe, expect, it } from "vitest";
import { anchorPoint, boundaryToward } from "./connectors";
import type { Shape } from "./model";
import { portPoint } from "./ports";
import { qcHandles } from "./select/qc";

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
