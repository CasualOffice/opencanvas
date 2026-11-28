// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// Selection and smart guides, docs/prototypes/board-ux-approved/board-ux.html decisions 9 and 13:
// the marquee takes shapes fully inside (Alt: touching), eight handles with Shift (proportions)
// and Alt (from the centre), several shapes resize and rotate together, equal gaps on the
// whiteboard. Real mouse: e2e/diagram/board-ux.spec.ts.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, getBoardMap, readShapes, type Shape } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (): BlockEnv => ({ role: "edit", compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} });
const one = (doc: Y.Doc, id: string, sid: string) => readShapes(getBoardMap(doc, id)!).find((s) => s.id === sid)!;

let cleanup: (() => void) | null = null;
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
});
function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  cleanup = () => act(() => root.unmount());
  return el;
}
function ptr(target: Element, type: string, x: number, y: number, o: { altKey?: boolean; shiftKey?: boolean } = {}) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...o });
  Object.defineProperty(e, "pointerId", { value: 1 });
  Object.defineProperty(e, "pointerType", { value: "mouse" });
  act(() => void target.dispatchEvent(e));
}
function board(seed: (doc: Y.Doc, id: string) => void) {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  seed(doc, id);
  const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
  return { doc, id, el, root: el.querySelector<HTMLElement>(".ocbd")!, svg: el.querySelector("svg.ocbd-svg")! };
}
const R = (id: string, x: number, y: number, w = 120, h = 60, o: Partial<Shape> = {}) => ({ id, type: "rect" as const, x, y, w, h, ...o });
const shapeEl = (el: Element, sid: string) => el.querySelector(`g[data-s="${sid}"] rect`)!;
function pick(b: ReturnType<typeof board>, sid: string, o: { shiftKey?: boolean } = {}) {
  ptr(shapeEl(b.el, sid), "pointerdown", 0, 0, o);
  ptr(b.svg, "pointerup", 0, 0);
}
function dragFrom(b: ReturnType<typeof board>, target: Element, from: [number, number], to: [number, number], o: { altKey?: boolean; shiftKey?: boolean } = {}) {
  ptr(target, "pointerdown", from[0], from[1], o);
  ptr(b.svg, "pointermove", (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, o);
  ptr(b.svg, "pointermove", to[0], to[1], o);
  ptr(b.svg, "pointerup", to[0], to[1], o);
}
const selected = (b: ReturnType<typeof board>) => [...b.el.querySelectorAll(".ocbd-selring")].length;

describe("marquee (decision 13)", () => {
  const seed = (doc: Y.Doc, id: string) => {
    addShape(doc, id, R("a", 100, 100));
    addShape(doc, id, R("b", 300, 100));
  };
  it("selects shapes fully inside; one it only touches stays out", () => {
    const b = board(seed);
    dragFrom(b, b.svg, [50, 50], [350, 200]);
    expect(selected(b)).toBe(1);
  });
  it("with Alt, shapes it touches count too", () => {
    const b = board(seed);
    dragFrom(b, b.svg, [50, 50], [350, 200], { altKey: true });
    expect(selected(b)).toBe(2);
  });
});

describe("handles on one shape", () => {
  it("eight handles; the left one moves the left edge", () => {
    const b = board((doc, id) => addShape(doc, id, R("a", 100, 100)));
    pick(b, "a");
    expect(b.el.querySelectorAll("[data-rz]").length).toBe(8);
    const w = b.el.querySelector('[data-rz="w"]')!;
    dragFrom(b, w, [94, 130], [44, 130]);
    expect(one(b.doc, b.id, "a")).toMatchObject({ x: 50, w: 170, y: 100, h: 60 });
  });
  it("Shift keeps the proportions on a corner", () => {
    const b = board((doc, id) => addShape(doc, id, R("a", 100, 100)));
    pick(b, "a");
    dragFrom(b, b.el.querySelector('[data-rz="se"]')!, [226, 166], [346, 176], { shiftKey: true });
    expect(one(b.doc, b.id, "a")).toMatchObject({ x: 100, y: 100, w: 240, h: 120 });
  });
  it("Alt resizes from the centre", () => {
    const b = board((doc, id) => addShape(doc, id, R("a", 100, 100)));
    pick(b, "a");
    dragFrom(b, b.el.querySelector('[data-rz="e"]')!, [226, 130], [246, 130], { altKey: true });
    expect(one(b.doc, b.id, "a")).toMatchObject({ x: 80, w: 160 });
  });
  it("a rotated shape resizes along its own sides, keeping the opposite side in place", () => {
    const b = board((doc, id) => addShape(doc, id, R("a", 100, 100, 120, 60, { rot: 90 })));
    pick(b, "a");
    // The right side's handle is drawn below the centre (160,130) once turned by 90°.
    dragFrom(b, b.el.querySelector('[data-rz="e"]')!, [160, 196], [160, 226]);
    expect(one(b.doc, b.id, "a")).toMatchObject({ w: 150, h: 60, x: 85, y: 115, rot: 90 });
  });
});

describe("several shapes (decision 13)", () => {
  const seed = (doc: Y.Doc, id: string) => {
    addShape(doc, id, R("a", 100, 100));
    addShape(doc, id, R("b", 300, 100));
  };
  function both(b: ReturnType<typeof board>) {
    pick(b, "a");
    pick(b, "b", { shiftKey: true });
  }
  it("one box with four corner handles and a rotation handle", () => {
    const b = board(seed);
    both(b);
    expect(b.el.querySelectorAll("[data-rz]").length).toBe(4);
    expect(b.el.querySelector('[data-rot="multi"]')).not.toBeNull();
  });
  it("a corner scales positions and sizes together", () => {
    const b = board(seed);
    both(b);
    dragFrom(b, b.el.querySelector('[data-rz="se"]')!, [432, 172], [752, 172]);
    expect(one(b.doc, b.id, "a")).toMatchObject({ x: 100, w: 240, y: 100, h: 60 });
    expect(one(b.doc, b.id, "b")).toMatchObject({ x: 500, w: 240 });
  });
  it("the rotation handle turns them about their common centre", () => {
    const b = board(seed);
    both(b);
    // Common centre 260,130; from straight above to straight right: 90°.
    dragFrom(b, b.el.querySelector('[data-rot="multi"]')!, [260, 40], [350, 130]);
    const a = one(b.doc, b.id, "a");
    expect(a.rot).toBe(90);
    expect(a.x! + a.w! / 2).toBeCloseTo(260, 5);
    expect(a.y! + a.h! / 2).toBeCloseTo(30, 5);
  });
});

describe("smart guides on the whiteboard (decision 9)", () => {
  // The equal-gap marks diagram mode has: a shape moved near the middle of two others snaps to
  // equal gaps on both sides.
  const seed = (doc: Y.Doc, id: string) => {
    addShape(doc, id, R("a", 100, 100, 100, 60));
    addShape(doc, id, R("m", 260, 100, 100, 60));
    addShape(doc, id, R("c", 400, 100, 100, 60));
  };
  it("equal gaps snap and are marked while moving", () => {
    const b = board(seed);
    ptr(shapeEl(b.el, "m"), "pointerdown", 300, 130);
    ptr(b.svg, "pointermove", 296, 130);
    ptr(b.svg, "pointermove", 293, 130);
    expect(b.el.querySelector(".ocbd-gaps")).not.toBeNull();
    ptr(b.svg, "pointerup", 293, 130);
    expect(one(b.doc, b.id, "m").x).toBe(250);
  });
  it("Alt moves freely", () => {
    const b = board(seed);
    ptr(shapeEl(b.el, "m"), "pointerdown", 300, 130, { altKey: true });
    ptr(b.svg, "pointermove", 296, 130, { altKey: true });
    ptr(b.svg, "pointermove", 293, 130, { altKey: true });
    ptr(b.svg, "pointerup", 293, 130, { altKey: true });
    expect(one(b.doc, b.id, "m").x).toBe(253);
  });
});
