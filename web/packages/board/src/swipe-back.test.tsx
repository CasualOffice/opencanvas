// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom

/**
 * A sideways two-finger swipe over a board must never reach the browser: at the page edge
 * macOS and Chrome turn it into Back (owner report 2026-11-24). The board takes horizontal
 * wheel input and pans with it, inline as well as full screen.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const env = (): BlockEnv => ({ role: "edit", compact: false, me: { id: "u", name: "U", color: "#2a5ad7" }, users: [], toast: () => {} });

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
});

function wheel(target: Element, deltaX: number, deltaY: number) {
  const e = new WheelEvent("wheel", { deltaX, deltaY, bubbles: true, cancelable: true });
  act(() => void target.dispatchEvent(e));
  return e;
}

describe("swipe back", () => {
  it("a sideways swipe over an inline board is taken by the board, not the browser", () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    addShape(doc, id, { type: "rect", x: 20, y: 20, w: 100, h: 60, text: "A" });
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    act(() => root.render(<BoardBlock doc={doc} boardId={id} env={env()} />));
    cleanup = () => act(() => root.unmount());
    const svg = el.querySelector("svg.ocbd-svg")!;
    expect(wheel(svg, -40, 2).defaultPrevented).toBe(true);
    // A vertical scroll still scrolls the document.
    expect(wheel(svg, 0, 40).defaultPrevented).toBe(false);
  });
});
