// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// BRD-22: the style panel and rotation, to docs/prototypes/board-ux-approved/board-ux.html
// decisions 4 and 5. Exporters: export.test.ts (board-style fixture, shared with Rust).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, getBoardMap, readShapes } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (): BlockEnv => ({ role: "edit", compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} });
const shapes = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);
const one = (doc: Y.Doc, id: string, sid: string) => shapes(doc, id).find((s) => s.id === sid)!;

let cleanup: (() => void) | null = null;
// The panel is its own lazy chunk: load it once so a click opens it within one act().
beforeAll(async () => void (await import("./style/StylePanel")));
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
  return e;
}
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o })));
const click = async (el: Element) => {
  await act(async () => void (el as HTMLElement).click());
};
function board(seed?: (doc: Y.Doc, id: string) => void) {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  seed?.(doc, id);
  const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
  const root = el.querySelector<HTMLElement>(".ocbd")!;
  const svg = el.querySelector("svg.ocbd-svg")!;
  return { doc, id, el, root, svg };
}
const shapeEl = (el: Element, sid: string) => el.querySelector(`g[data-s="${sid}"] rect, g[data-s="${sid}"] path, g[data-s="${sid}"] ellipse`)!;
function pick(b: ReturnType<typeof board>, sid: string, o: { shiftKey?: boolean } = {}) {
  ptr(shapeEl(b.el, sid), "pointerdown", 0, 0, o);
  ptr(b.svg, "pointerup", 0, 0);
}
async function openStyle(b: ReturnType<typeof board>) {
  await click(b.el.querySelector('.ocbd-swatch [aria-label="Style"]')!);
  const p = b.el.querySelector<HTMLElement>('[role="dialog"][aria-label="Style"]');
  expect(p).not.toBeNull();
  return p!;
}
const radio = (p: Element, group: string, name: string) => p.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${group}"] [aria-label="${name}"]`)!;
const rect = (doc: Y.Doc, id: string) => addShape(doc, id, { id: "a", type: "rect", x: 100, y: 100, w: 120, h: 60, text: "Alpha" });

describe("BRD-22: style panel", () => {
  it("Style in the floating toolbar opens the panel; each control writes one key", async () => {
    const b = board(rect);
    pick(b, "a");
    const p = await openStyle(b);
    await click(radio(p, "Stroke colour", "Red"));
    expect(one(b.doc, b.id, "a").stroke).toBe("red");
    await click(radio(p, "Stroke width", "Bold"));
    expect(one(b.doc, b.id, "a").sw).toBe(4);
    await click(radio(p, "Stroke style", "Dotted"));
    expect(one(b.doc, b.id, "a").dash).toBe("dotted");
    await click(radio(p, "Font", "Serif"));
    expect(one(b.doc, b.id, "a").font).toBe("serif");
    await click(radio(p, "Text size", "Large"));
    expect(one(b.doc, b.id, "a").size).toBe(16);
    await click(radio(p, "Fill colour", "None"));
    expect(one(b.doc, b.id, "a").fill).toBeUndefined();
    // Drawn: the shape's outline in the tone, the width, the dots; the font on the group.
    const r = b.el.querySelector('g[data-s="a"] rect')!;
    expect(r.getAttribute("stroke")).toBe("var(--red-fg)");
    expect(r.getAttribute("stroke-width")).toBe("4");
    expect(r.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(b.el.querySelector('[data-font="serif"] g[data-s="a"], g[data-s="a"][data-font="serif"]')).not.toBeNull();
  });

  it("opacity: the slider writes `op`, and the drawn shape gets it", async () => {
    const b = board(rect);
    pick(b, "a");
    const p = await openStyle(b);
    const range = p.querySelector<HTMLInputElement>('input[type="range"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      set.call(range, "50");
      range.dispatchEvent(new Event("input", { bubbles: true }));
      range.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(one(b.doc, b.id, "a").op).toBe(50);
    expect(b.el.querySelector('g[data-s="a"]')!.closest("[opacity]")!.getAttribute("opacity")).toBe("0.5");
  });

  it("a connector gets arrowheads (props.startArrow / endArrow) and no fill or font", async () => {
    const b = board((doc, id) => addShape(doc, id, { id: "c", type: "arrow", pts: [[100, 100], [300, 100]] }));
    pick(b, "c");
    const p = await openStyle(b);
    expect(p.querySelector('[aria-label="Fill colour"]')).toBeNull();
    expect(p.querySelector('[aria-label="Font"]')).toBeNull();
    await click(radio(p, "End arrowhead", "Triangle"));
    await click(radio(p, "Start arrowhead", "Arrow"));
    const s = one(b.doc, b.id, "c");
    expect(s.props).toMatchObject({ endArrow: "triangle", startArrow: "arrow" });
  });

  it("two shapes with different strokes show Mixed and no pressed colour", async () => {
    const b = board((doc, id) => {
      addShape(doc, id, { id: "a", type: "rect", x: 100, y: 100, w: 120, h: 60, stroke: "red" });
      addShape(doc, id, { id: "b", type: "rect", x: 300, y: 100, w: 120, h: 60, stroke: "blue" });
    });
    pick(b, "a");
    pick(b, "b", { shiftKey: true });
    const p = await openStyle(b);
    expect(p.querySelectorAll('[aria-label="Stroke colour"] [aria-checked="true"]').length).toBe(0);
    expect(p.textContent).toMatch(/Mixed/);
    await click(radio(p, "Stroke colour", "Green"));
    expect(shapes(b.doc, b.id).map((s) => s.stroke)).toEqual(["green", "green"]);
  });

  it("new shapes use the last style picked (per person, not in the board)", async () => {
    const b = board(rect);
    pick(b, "a");
    const p = await openStyle(b);
    await click(radio(p, "Stroke colour", "Purple"));
    await click(radio(p, "Stroke width", "Bold"));
    key(b.root, "Escape");
    key(b.root, "Escape");
    key(b.root, "r");
    ptr(b.svg, "pointerdown", 500, 300);
    ptr(b.svg, "pointerup", 500, 300);
    const made = shapes(b.doc, b.id).find((s) => s.id !== "a")!;
    expect(made.stroke).toBe("purple");
    expect(made.sw).toBe(4);
    expect(JSON.parse(localStorage.getItem("oc.board.style")!)).toMatchObject({ stroke: "purple", sw: 4 });
  });

  it("Alt+S opens it from the keyboard; Escape closes it and keeps the selection", async () => {
    const b = board(rect);
    pick(b, "a");
    await act(async () => void b.root.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", altKey: true, bubbles: true, cancelable: true })));
    const p = b.el.querySelector('[role="dialog"][aria-label="Style"]')!;
    expect(p).not.toBeNull();
    key(document.activeElement!, "Escape");
    expect(b.el.querySelector('[role="dialog"][aria-label="Style"]')).toBeNull();
    expect(b.el.querySelector(".ocbd-swatch")).not.toBeNull();
  });
});

describe("BRD-22: rotation", () => {
  it("Shift+R and Alt+Shift+R rotate by 15°; back to 0 removes the key", () => {
    const b = board(rect);
    pick(b, "a");
    key(b.root, "R", { shiftKey: true, code: "KeyR" });
    expect(one(b.doc, b.id, "a").rot).toBe(15);
    expect(b.el.querySelector('g[data-s="a"]')!.closest("[transform]")!.getAttribute("transform")).toMatch(/rotate\(15 160 130\)/);
    key(b.root, "R", { shiftKey: true, altKey: true, code: "KeyR" });
    expect(one(b.doc, b.id, "a").rot).toBeUndefined();
  });

  it("the rotation handle snaps to 15° steps; Alt rotates freely", () => {
    const b = board(rect);
    pick(b, "a");
    const h = b.el.querySelector("[data-rot]")!;
    expect(h).not.toBeNull();
    // Centre 160,130. From straight above to the right at about 40° clockwise: snaps to 45.
    ptr(h, "pointerdown", 160, 60);
    ptr(b.svg, "pointermove", 160 + Math.sin((40 * Math.PI) / 180) * 70, 130 - Math.cos((40 * Math.PI) / 180) * 70);
    ptr(b.svg, "pointerup", 160 + Math.sin((40 * Math.PI) / 180) * 70, 130 - Math.cos((40 * Math.PI) / 180) * 70);
    expect(one(b.doc, b.id, "a").rot).toBe(45);
    ptr(b.el.querySelector("[data-rot]")!, "pointerdown", 160, 60);
    ptr(b.svg, "pointermove", 160 + Math.sin((52 * Math.PI) / 180) * 70, 130 - Math.cos((52 * Math.PI) / 180) * 70, { altKey: true });
    ptr(b.svg, "pointerup", 160 + Math.sin((52 * Math.PI) / 180) * 70, 130 - Math.cos((52 * Math.PI) / 180) * 70, { altKey: true });
    expect(one(b.doc, b.id, "a").rot).toBeCloseTo(97, 0);
  });

  it("the panel's degree field sets the rotation", async () => {
    const b = board(rect);
    pick(b, "a");
    const p = await openStyle(b);
    const f = p.querySelector<HTMLInputElement>('input[aria-label="Rotation in degrees"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      set.call(f, "30");
      f.dispatchEvent(new Event("input", { bubbles: true }));
    });
    key(f, "Enter");
    expect(one(b.doc, b.id, "a").rot).toBe(30);
  });

  it("connectors and locked shapes have no rotation handle", () => {
    const b = board((doc, id) => {
      addShape(doc, id, { id: "c", type: "arrow", pts: [[100, 100], [300, 100]] });
      addShape(doc, id, { id: "l", type: "rect", x: 400, y: 100, w: 60, h: 40, locked: true });
    });
    pick(b, "c");
    expect(b.el.querySelector("[data-rot]")).toBeNull();
    pick(b, "l");
    expect(b.el.querySelector("[data-rot]")).toBeNull();
  });
});
