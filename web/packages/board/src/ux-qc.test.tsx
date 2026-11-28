// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// Quick-connect, docs/prototypes/board-ux-approved/board-ux.html decision 10: four + handles on
// one selected shape. Click adds the same kind of shape on that side, connected, and starts typing
// in it; drag connects to another shape, or makes a new one where it is let go.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, getBoardMap, readShapes, type Shape } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (): BlockEnv => ({ role: "edit", compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} });
const all = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);

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
function ptr(target: Element, type: string, x: number, y: number) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
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
const A = (o: Partial<Shape> = {}) => ({ id: "a", type: "rect" as const, x: 100, y: 100, w: 120, h: 60, text: "Plan", fill: "blue", stroke: "red", sw: 4, ...o });
function pick(b: ReturnType<typeof board>, sid: string) {
  ptr(b.el.querySelector(`g[data-s="${sid}"] rect`)!, "pointerdown", 0, 0);
  ptr(b.svg, "pointerup", 0, 0);
}
const plus = (b: ReturnType<typeof board>, dir: string) => b.el.querySelector(`[data-qc="${dir}"]`)!;

describe("quick-connect (decision 10)", () => {
  it("one selected shape gets four + handles; several shapes, a connector or a locked shape get none", () => {
    const b = board((doc, id) => {
      addShape(doc, id, A());
      addShape(doc, id, { id: "c", type: "arrow", pts: [[0, 300], [100, 300]] });
      addShape(doc, id, { id: "l", type: "rect", x: 400, y: 300, w: 60, h: 40, locked: true });
    });
    pick(b, "a");
    expect(b.el.querySelectorAll("[data-qc]").length).toBe(4);
    ptr(b.el.querySelector('g[data-s="c"] path')!, "pointerdown", 0, 0);
    ptr(b.svg, "pointerup", 0, 0);
    expect(b.el.querySelectorAll("[data-qc]").length).toBe(0);
    pick(b, "l");
    expect(b.el.querySelectorAll("[data-qc]").length).toBe(0);
  });

  it("click: the same kind and style on that side, bound both ends, selected and typing", () => {
    const b = board((doc, id) => addShape(doc, id, A()));
    pick(b, "a");
    const h = plus(b, "e");
    ptr(h, "pointerdown", 250, 130);
    ptr(b.svg, "pointerup", 250, 130);
    const list = all(b.doc, b.id);
    const made = list.find((s) => s.type === "rect" && s.id !== "a")!;
    expect(made).toMatchObject({ x: 290, y: 100, w: 120, h: 60, fill: "blue", stroke: "red", sw: 4, text: "" });
    const c = list.find((s) => s.type === "arrow")!;
    expect(c.start).toMatchObject({ shapeId: "a", anchor: "right" });
    expect(c.end).toMatchObject({ shapeId: made.id, anchor: "left" });
    expect(document.activeElement?.matches("textarea.ocbd-edit")).toBe(true);
  });

  it("a taken spot: the new shape steps further out", () => {
    const b = board((doc, id) => {
      addShape(doc, id, A());
      addShape(doc, id, { id: "b", type: "rect", x: 300, y: 90, w: 100, h: 80 });
    });
    pick(b, "a");
    ptr(plus(b, "e"), "pointerdown", 250, 130);
    ptr(b.svg, "pointerup", 250, 130);
    const made = all(b.doc, b.id).find((s) => s.type === "rect" && s.id !== "a" && s.id !== "b")!;
    expect(made.x).toBe(480);
  });

  it("drag to another shape: only a connector", () => {
    const b = board((doc, id) => {
      addShape(doc, id, A());
      addShape(doc, id, { id: "t", type: "ellipse", x: 400, y: 300, w: 120, h: 80 });
    });
    pick(b, "a");
    ptr(plus(b, "s"), "pointerdown", 160, 190);
    ptr(b.svg, "pointermove", 300, 280);
    ptr(b.el.querySelector('g[data-s="t"] ellipse')!, "pointermove", 460, 340);
    ptr(b.el.querySelector('g[data-s="t"] ellipse')!, "pointerup", 460, 340);
    const list = all(b.doc, b.id);
    expect(list.length).toBe(3);
    const c = list.find((s) => s.type === "arrow")!;
    expect(c.start?.shapeId).toBe("a");
    expect(c.end?.shapeId).toBe("t");
  });

  it("drag to empty canvas: a new shape centred where it is let go, connected", () => {
    const b = board((doc, id) => addShape(doc, id, A()));
    pick(b, "a");
    ptr(plus(b, "s"), "pointerdown", 160, 190);
    ptr(b.svg, "pointermove", 300, 300);
    ptr(b.svg, "pointermove", 400, 400);
    ptr(b.svg, "pointerup", 400, 400);
    const made = all(b.doc, b.id).find((s) => s.type === "rect" && s.id !== "a")!;
    expect(made).toMatchObject({ x: 340, y: 370 });
    expect(all(b.doc, b.id).find((s) => s.type === "arrow")!.end?.shapeId).toBe(made.id);
  });

  it("a sticky note clones as a sticky note with its colour", () => {
    const b = board((doc, id) => addShape(doc, id, { id: "a", type: "sticky", x: 100, y: 100, w: 150, h: 110, fill: "p", text: "Idea" }));
    pick(b, "a");
    ptr(plus(b, "w"), "pointerdown", 70, 155);
    ptr(b.svg, "pointerup", 70, 155);
    const made = all(b.doc, b.id).find((s) => s.type === "sticky" && s.id !== "a")!;
    expect(made).toMatchObject({ fill: "p", x: 100 - 150 - 70, w: 150, h: 110 });
  });
});
