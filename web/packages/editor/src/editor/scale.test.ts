// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SCALE-02: reflow at 200 % zoom and a 24 px default font (docs/19 §Scaling, S5 and S6).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clampCaretLabels } from "./carets";

const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 16, width: right - left, height: 16, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

describe("collaborator caret labels (S6)", () => {
  it("a label at the column's right edge is moved back inside it, so the page never scrolls sideways", () => {
    const root = document.createElement("div");
    root.innerHTML = '<span class="collaboration-carets__caret"><div class="collaboration-carets__label">Asha Rao · Design</div></span><span class="collaboration-carets__caret"><div class="collaboration-carets__label">Ravi</div></span>';
    const [a, b] = root.querySelectorAll<HTMLElement>(".collaboration-carets__label");
    root.getBoundingClientRect = () => rect(0, 600);
    // Measured with the shift removed: 4.4 px past the edge, and one well inside.
    a!.getBoundingClientRect = () => (a!.style.transform ? rect(470, 600) : rect(474.4, 604.4));
    b!.getBoundingClientRect = () => rect(100, 140);
    clampCaretLabels(root);
    expect(a!.style.transform).toBe("translateX(-5px)");
    expect(b!.style.transform).toBe("");
    // Once the caret moves away the shift is dropped again.
    a!.getBoundingClientRect = () => rect(200, 330);
    clampCaretLabels(root);
    expect(a!.style.transform).toBe("");
  });
});

describe("comments panel (S5)", () => {
  it("grows with the text size but never past 30 % of the window, and never below its 16 px width", () => {
    const css = readFileSync(new URL("../styles/app.css", `file://${__filename}`), "utf8");
    expect(css).toMatch(/\.side\{width:min\(23\.75rem, max\(380px, 30vw\)\)/);
  });
});
