// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-14 S3: the diagram canvas (approved prototype 3a-3h).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, getBoardMap, readShapes } from "./model";
import { equalGapOffset, gridOffset, type Box } from "./ops";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("snapping helpers", () => {
  it("centres a box between two neighbours so both gaps are equal, with two marks", () => {
    const left: Box = [0, 0, 100, 50], right: Box = [300, 0, 400, 50];
    // Centred would be 150..250 (gaps 50 / 50); it sits at 147..247 (gaps 47 / 53).
    const r = equalGapOffset([147, 10, 247, 40], [left, right], 6);
    expect(r.dx).toBe(3);
    expect(r.dy).toBe(0);
    expect(r.marks).toEqual([
      { x1: 100, y1: 25, x2: 150, y2: 25, gap: 50 },
      { x1: 250, y1: 25, x2: 300, y2: 25, gap: 50 },
    ]);
    // Too far from equal: nothing.
    expect(equalGapOffset([120, 10, 220, 40], [left, right], 6).marks).toEqual([]);
    // No overlap on the other axis: not neighbours.
    expect(equalGapOffset([147, 200, 247, 240], [left, right], 6).marks).toEqual([]);
    // Vertical too, and an axis can be skipped.
    const r2 = equalGapOffset([0, 148, 50, 248], [[0, 0, 50, 100], [0, 300, 50, 400]], 6);
    expect(r2.dy).toBe(2);
    expect(equalGapOffset([0, 148, 50, 248], [[0, 0, 50, 100], [0, 300, 50, 400]], 6, { y: true }).marks).toEqual([]);
  });
  it("puts the top-left corner on the grid", () => {
    expect(gridOffset([13, 29, 50, 50], 20)).toEqual([7, -9]);
    expect(gridOffset([13, 29, 50, 50], 0)).toEqual([0, 0]);
  });
});

const env = (role: "edit" | "view" = "edit"): BlockEnv => ({ role, compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} });
let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  document.body.innerHTML = "";
});
function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  cleanups.push(() => act(() => root.unmount()));
  return el;
}
function ptr(target: Element, type: string, x: number, y: number, o: { altKey?: boolean } = {}) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...o });
  Object.defineProperty(e, "pointerId", { value: 1 });
  Object.defineProperty(e, "pointerType", { value: "mouse" });
  act(() => void target.dispatchEvent(e));
}
const btn = (root: ParentNode, name: string) => [...root.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name);
async function open(doc: Y.Doc, id: string, role: "edit" | "view" = "edit") {
  const el = mount(<BoardBlock doc={doc} boardId={id} env={env(role)} />);
  await act(async () => {
    btn(el, "Diagram")!.click();
    for (let i = 0; i < 50 && !document.querySelector(".ocdg"); i++) await new Promise((r) => setTimeout(r, 5));
  });
  return document.querySelector<HTMLElement>(".ocdg")!;
}
const sw = (root: ParentNode, name: string) => [...root.querySelectorAll('[role="switch"]')].find((b) => b.textContent?.includes(name)) as HTMLElement | undefined;

describe("diagram canvas (S3)", () => {
  it("draws a line grid with major lines and rulers; both can be turned off in the settings", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    addShape(doc, id, { type: "rect", x: 20, y: 20, w: 100, h: 60 });
    const dg = await open(doc, id);
    expect(dg.querySelector("[data-grid]")).toBeTruthy();
    expect(dg.querySelector(".ocdg-rulers")).toBeTruthy();
    expect(dg.querySelector(".ocbd-dot")).toBeNull();
    act(() => sw(dg, "Show grid")!.click());
    expect(dg.querySelector("[data-grid]")).toBeNull();
    act(() => sw(dg, "Show rulers")!.click());
    expect(dg.querySelector(".ocdg-rulers")).toBeNull();
  });

  it("moving a shape snaps to the grid (Alt moves freely)", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const a = addShape(doc, id, { type: "rect", x: 20, y: 20, w: 100, h: 60, text: "A" });
    const dg = await open(doc, id);
    const svg = dg.querySelector("svg.ocbd-svg")!;
    const g = dg.querySelector(`[data-s="${a}"]`)!;
    ptr(g, "pointerdown", 50, 50);
    ptr(svg, "pointermove", 63, 57);
    ptr(svg, "pointerup", 63, 57);
    await act(async () => void (await new Promise((r) => requestAnimationFrame(() => r(0)))));
    const s = readShapes(getBoardMap(doc, id)!).find((q) => q.id === a)!;
    expect([s.x, s.y]).toEqual([40, 20]);
  });

  it("shows ports on hover and draws a connector from port to port, stored with both ports and the chosen route", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const a = addShape(doc, id, { type: "rect", x: 20, y: 20, w: 100, h: 60, text: "A" });
    const b = addShape(doc, id, { type: "rect", x: 300, y: 20, w: 100, h: 60, text: "B" });
    const dg = await open(doc, id);
    // New connectors: Avoid shapes.
    act(() => (dg.querySelector('[role="radio"][data-v="avoid"]') as HTMLElement).click());
    const svg = dg.querySelector("svg.ocbd-svg")!;
    ptr(svg, "pointermove", 60, 50);
    const ports = dg.querySelectorAll(`[data-port-of="${a}"]`);
    expect([...ports].map((p) => p.getAttribute("data-port"))).toEqual(["top", "right", "bottom", "left"]);
    const right = dg.querySelector(`[data-port-of="${a}"][data-port="right"]`)!;
    ptr(right, "pointerdown", 120, 50);
    ptr(svg, "pointermove", 250, 52);
    ptr(svg, "pointermove", 305, 52);
    ptr(svg, "pointerup", 305, 52);
    const arrow = readShapes(getBoardMap(doc, id)!).find((s) => s.type === "arrow")!;
    expect(arrow.start).toMatchObject({ shapeId: a, anchor: "right" });
    expect(arrow.end).toMatchObject({ shapeId: b, anchor: "left" });
    expect(arrow.route).toBe("elbow");
    expect(arrow.routing).toBe("avoid");
  });

  it("view-only people get no ports", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const a = addShape(doc, id, { type: "rect", x: 20, y: 20, w: 100, h: 60, text: "A" });
    const dg = await open(doc, id, "view");
    ptr(dg.querySelector("svg.ocbd-svg")!, "pointermove", 60, 50);
    expect(dg.querySelectorAll(`[data-port-of="${a}"]`)).toHaveLength(0);
  });
});
