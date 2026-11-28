// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// Whiteboard QA pass (docs/41 §7): rendering defects, each seen failing before its fix.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Cursors } from "./presence/view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("BRD-36: a peer's name label stays inside the board", () => {
  it("near the right edge the label sits left of the arrow", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    const peer = { id: 2, name: "Ravi Menon", color: "#e5603a", x: 380, y: 100 } as unknown as Parameters<typeof Cursors>[0]["peers"][number];
    act(() => root.render(<svg><Cursors peers={[peer]} view={{ tx: 0, ty: 0, z: 1 }} width={390} /></svg>));
    const rect = el.querySelector(".ocbd-clabel rect")!;
    const x = Number(rect.getAttribute("x")), w = Number(rect.getAttribute("width"));
    expect(380 + x + w).toBeLessThanOrEqual(390);
    // Away from the edge it keeps its usual place, right of the arrow.
    act(() => root.render(<svg><Cursors peers={[{ ...peer, x: 50 }]} view={{ tx: 0, ty: 0, z: 1 }} width={390} /></svg>));
    expect(el.querySelector(".ocbd-clabel rect")!.getAttribute("x")).toBe("12");
    act(() => root.unmount());
  });
});
