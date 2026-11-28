// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// Board audit fixes (docs/41, BRD-05..16) that jsdom can see. The mouse focus bug (BRD-05), the
// toolbar overlap (BRD-10) and the chooser height (BRD-11) need layout: e2e/diagram/board-audit.spec.ts.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, bbox, getBoardMap, readShapes, type Shape } from "./model";
import { computeLayout } from "./diagram/layout/compute";
import { applyLayout } from "./diagram/layout/apply";
import { Commands } from "./diagram/A11y";
import { nameOf } from "./diagram/props/fields";
import { freeSpot } from "./ops";
import { loadDagre } from "./diagram/layout/load";
import "./libraries";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (): BlockEnv => ({ role: "edit", compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} });
const shapes = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);

let cleanup: (() => void) | null = null;
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
function ptr(target: Element, type: string, x: number, y: number, o: { shiftKey?: boolean } = {}) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...o });
  Object.defineProperty(e, "pointerId", { value: 1 });
  Object.defineProperty(e, "pointerType", { value: "mouse" });
  act(() => void target.dispatchEvent(e));
  return e;
}
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o })));
function board(seed?: (doc: Y.Doc, id: string) => void) {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  seed?.(doc, id);
  const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
  const root = el.querySelector<HTMLElement>(".ocbd")!;
  const svg = el.querySelector("svg.ocbd-svg")!;
  return { doc, id, el, root, svg };
}
function typeInto(ta: HTMLTextAreaElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    set.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("BRD-05: placing a sticky or text with the mouse", () => {
  it("does not let the pointer-down's default action move focus off the new editor", () => {
    const b = board();
    key(b.root, "n");
    const down = ptr(b.svg, "pointerdown", 300, 200);
    expect(down.defaultPrevented).toBe(true);
    ptr(b.svg, "pointerup", 300, 200);
    const ta = b.el.querySelector<HTMLTextAreaElement>("textarea.ocbd-edit");
    expect(ta).not.toBeNull();
    expect(document.activeElement).toBe(ta);
  });
});

describe("BRD-06: Escape while typing keeps the text", () => {
  it("commits a sticky's text on Escape", () => {
    let sid = "";
    const b = board((doc, id) => (sid = addShape(doc, id, { type: "sticky", x: 100, y: 100, w: 150, h: 110, fill: "y", text: "" })));
    key(b.root, "Tab");
    key(b.root, "Enter");
    const ta = b.el.querySelector<HTMLTextAreaElement>("textarea.ocbd-edit")!;
    typeInto(ta, "Kept on Escape");
    key(ta, "Escape");
    expect(shapes(b.doc, b.id).find((s) => s.id === sid)!.text).toBe("Kept on Escape");
    expect(b.el.querySelector("textarea.ocbd-edit")).toBeNull();
  });
});

describe("BRD-07: drag to size", () => {
  it("a drag with the rectangle tool makes a rectangle of the dragged box", () => {
    const b = board();
    key(b.root, "r");
    ptr(b.svg, "pointerdown", 100, 100);
    ptr(b.svg, "pointermove", 180, 150);
    ptr(b.svg, "pointermove", 300, 220);
    ptr(b.svg, "pointerup", 300, 220);
    const r = shapes(b.doc, b.id).find((s) => s.type === "rect")!;
    expect([r.x, r.y, r.w, r.h]).toEqual([100, 100, 200, 120]);
  });
  it("a drag up and left works too, and Shift keeps it square", () => {
    const b = board();
    key(b.root, "o");
    ptr(b.svg, "pointerdown", 300, 300);
    ptr(b.svg, "pointermove", 200, 250, { shiftKey: true });
    ptr(b.svg, "pointerup", 200, 250, { shiftKey: true });
    const e = shapes(b.doc, b.id).find((s) => s.type === "ellipse")!;
    expect([e.x, e.y, e.w, e.h]).toEqual([200, 200, 100, 100]);
  });
  it("a click without a drag keeps the default size, centred on the click", () => {
    const b = board();
    key(b.root, "r");
    ptr(b.svg, "pointerdown", 300, 200);
    ptr(b.svg, "pointerup", 301, 201);
    const r = shapes(b.doc, b.id).find((s) => s.type === "rect")!;
    expect([r.x, r.y, r.w, r.h]).toEqual([230, 160, 140, 80]);
  });
});

describe("BRD-09: auto-layout keeps drawn frames and loose connectors", () => {
  function flow() {
    const doc = new Y.Doc();
    const id = createBoard(doc, "flow");
    return { doc, id, list: () => shapes(doc, id) };
  }
  const find = (list: Shape[], t: string) => list.find((s) => (s.text || s.label || "").startsWith(t))!;
  const inside = (a: Shape, b: Shape) => {
    const [ax0, ay0, ax1, ay1] = bbox(a), [bx0, by0, bx1, by1] = bbox(b);
    return ax0 >= bx0 && ay0 >= by0 && ax1 <= bx1 && ay1 <= by1;
  };
  const overlaps = (a: Shape, b: Shape) => {
    const [ax0, ay0, ax1, ay1] = bbox(a), [bx0, by0, bx1, by1] = bbox(b);
    return ax0 < bx1 && bx0 < ax1 && ay0 < by1 && by0 < ay1;
  };
  it("the frame keeps the sticky it held, the text overlaps nothing, connectors follow their shapes", async () => {
    const f = flow();
    const plan = computeLayout(await loadDagre(), f.list(), { direction: "down", spacing: "normal", scope: { kind: "all" }, keepContainers: true, keepBends: false });
    applyLayout(f.doc, f.id, plan, false);
    const list = f.list();
    const frame = find(list, "Host app"), jwt = find(list, "Signs launch"), room = find(list, "Room on owner"), auto = find(list, "Autosave");
    const text = find(list, "Every edit");
    expect(inside(jwt, frame)).toBe(true);
    expect(jwt.props?.parent).toBe(frame.id); // the membership is recorded
    for (const s of list.filter((q) => q.type !== "arrow" && q.id !== text.id && q.id !== frame.id && q.id !== jwt.id)) expect(overlaps(text, s), `text over ${s.text}`).toBe(false);
    // Every connector now starts and ends on a shape.
    const arrows = list.filter((s) => s.type === "arrow");
    expect(arrows.length).toBe(3);
    for (const a of arrows) expect([a.start?.shapeId, a.end?.shapeId].every(Boolean)).toBe(true);
    const ends = arrows.map((a) => `${a.start!.shapeId}>${a.end!.shapeId}`).sort();
    expect(ends).toEqual([`${auto.id}>${frame.id}`, `${frame.id}>${room.id}`, `${room.id}>${auto.id}`].sort());
  });
});

describe("BRD-12: new shapes go to a free spot", () => {
  it("freeSpot keeps a free box and moves an overlapping one to the nearest gap", () => {
    expect(freeSpot([0, 0, 100, 50], [[500, 500, 600, 600]])).toEqual([0, 0]);
    const [dx, dy] = freeSpot([0, 0, 100, 50], [[-10, -10, 110, 60]]);
    const moved: [number, number, number, number] = [dx, dy, 100 + dx, 50 + dy];
    expect(moved[0] >= 110 || moved[2] <= -10 || moved[1] >= 60 || moved[3] <= -10).toBe(true);
    expect(Math.hypot(dx, dy)).toBeLessThan(200);
  });
  it("a shape placed from the keyboard does not land on the shape already in the middle", () => {
    const b = board((doc, id) => void addShape(doc, id, { type: "rect", x: 160, y: 110, w: 280, h: 180, text: "Middle" }));
    key(b.root, "r");
    key(b.root, "Enter");
    const list = shapes(b.doc, b.id);
    const [m, n] = [list.find((s) => s.text === "Middle")!, list.find((s) => s.text !== "Middle")!];
    const [ax0, ay0, ax1, ay1] = bbox(m), [bx0, by0, bx1, by1] = bbox(n);
    expect(ax0 < bx1 && bx0 < ax1 && ay0 < by1 && by0 < ay1).toBe(false);
  });
});

describe("BRD-13: align, distribute and group from Commands", () => {
  it("lists them for a selection and runs them on the canvas", () => {
    const S = (id: string, x: number): Shape => ({ id, type: "rect", x, y: x, w: 50, h: 50, text: id });
    const canvas = { shapes: [S("a", 0), S("b", 100), S("c", 200)], sel: ["a", "b", "c"], select: () => {}, align: vi.fn(), distribute: vi.fn() };
    const el = mount(<Commands root={null} canvas={canvas} edit onClose={() => {}} onOutline={() => {}} onShortcuts={() => {}} onSay={() => {}} />);
    const input = el.querySelector<HTMLInputElement>("input")!;
    const labels = () => [...el.querySelectorAll('[role="option"] .ocdg-on')].map((o) => o.textContent);
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      set.call(input, "align");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(labels()).toEqual(expect.arrayContaining(["Align left", "Align right", "Align top", "Align bottom"]));
    act(() => [...el.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes("Align left"))!.click());
    expect(canvas.align).toHaveBeenCalledWith("left");
  });
});

describe("BRD-15: library shapes are named by their label", () => {
  it("a Basic shapes cylinder is called Cylinder, not cylinder", () => {
    expect(nameOf({ id: "x", type: "rect", kind: "basic:cylinder", x: 0, y: 0, w: 60, h: 80 })).toBe("Cylinder");
  });
});
