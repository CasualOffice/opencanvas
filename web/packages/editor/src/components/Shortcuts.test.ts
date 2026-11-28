// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The editor's keyboard shortcut list names the whiteboard keys (board UX pass, BRD-17..31).
import { describe, expect, it } from "vitest";
import { GROUPS } from "./Shortcuts";

describe("keyboard shortcuts", () => {
  it("has a Whiteboard group with the board UX keys", () => {
    const board = GROUPS.find(([t]) => t === "Whiteboard");
    expect(board).toBeTruthy();
    const what = board![1].map(([, d]) => d).join(" | ");
    for (const w of ["Frame tool", "Wrap the selection in a frame", "Present frames", "Keep the tool active", "Style panel", "Rotate", "Copy as PNG", "Context menu", "All whiteboard shortcuts"]) expect(what).toContain(w);
  });
});
