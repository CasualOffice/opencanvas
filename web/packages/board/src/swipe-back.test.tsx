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
import { afterEach, describe, expect, it, vi } from "vitest";
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
    // A vertical scroll still scrolls the document...
    expect(wheel(svg, 0, 40).defaultPrevented).toBe(false);
    // ...and a sideways swipe never reaches the browser (one gesture keeps its axis, UX-DGM-01).
    expect(wheel(svg, -40, 2).defaultPrevented).toBe(true);
  });

  it("one trackpad gesture keeps its axis: a sideways pan that drifts down does not start scrolling the page (UX-DGM-01)", () => {
    let now = 1000;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => now);
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    act(() => root.render(<BoardBlock doc={doc} boardId={id} env={env()} />));
    cleanup = () => (act(() => root.unmount()), spy.mockRestore());
    const svg = el.querySelector("svg.ocbd-svg")!;
    const g = () => svg.querySelector(":scope > g[transform]")!.getAttribute("transform");
    // Sideways, then the fingers drift downwards within the same gesture (events 16 ms apart).
    const seq: [number, number][] = [[30, 2], [30, 5], [20, 15], [10, 25], [5, 30], [2, 30]];
    const prevented = seq.map(([dx, dy]) => ((now += 16), wheel(svg, dx, dy).defaultPrevented));
    expect(prevented).toEqual([true, true, true, true, true, true]);
    expect(g()).toBe("translate(-97 0) scale(1)");
    // A new gesture after a pause that goes down scrolls the document again.
    now += 400;
    expect(wheel(svg, 1, 40).defaultPrevented).toBe(false);
    // ...and stays a scroll even if it drifts sideways (but never reaches the browser's Back).
    now += 16;
    expect(wheel(svg, 30, 4).defaultPrevented).toBe(true);
    expect(g()).toBe("translate(-97 0) scale(1)");
  });
});
