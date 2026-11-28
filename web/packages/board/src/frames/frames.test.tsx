// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// BRD-21 (board UX prototype 5a-5c, decision 6): frames are a real tool (F), stored as
// `diagram:container` with explicit membership (`props.parent`); a shape joins by centre-drop;
// moving a frame moves its members; deleting it keeps its contents; rename; the zoom menu lists
// frames; Present (⇧P) steps through them.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "../index";
import { addShape, getBoardMap, readShapes, type Shape } from "../model";
import { CONTAINER } from "../kinds";
import { adopted, frameAt, membershipChanges, membersOf, nextFrameName } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (o: Partial<BlockEnv> = {}): BlockEnv => ({ role: "edit", compact: false, me: { id: "p", name: "Priya", color: "#2a5ad7" }, users: [], toast: () => {}, ...o });
const shapes = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);
const one = (doc: Y.Doc, id: string, sid: string) => shapes(doc, id).find((s) => s.id === sid);
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
}
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o })));
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};

const F = (id: string, x: number, y: number, w = 400, h = 300, o: Partial<Shape> = {}): Shape => ({ ...(id ? { id } : {}), type: "rect", kind: CONTAINER, x, y, w, h, label: id, ...o }) as Shape;
const R = (id: string, x: number, y: number, o: Partial<Shape> = {}): Shape => ({ id, type: "rect", x, y, w: 100, h: 60, ...o });

describe("frame membership", () => {
  it("finds the innermost frame under a point", () => {
    const all = [F("big", 0, 0, 1000, 1000), F("small", 100, 100, 200, 200)];
    expect(frameAt(all, 150, 150)?.id).toBe("small");
    expect(frameAt(all, 900, 900)?.id).toBe("big");
    expect(frameAt(all, 2000, 0)).toBeNull();
  });
  it("centre-drop: joins, leaves, and moving with its frame keeps it", () => {
    const all = [F("f", 0, 0), R("a", 20, 20), R("b", 600, 0, { props: { parent: "f" } }), R("c", 50, 50, { props: { parent: "f" } })];
    expect(membershipChanges(all, ["a", "b"])).toEqual([["a", "f"], ["b", null]]);
    expect(membershipChanges(all, ["f", "c"])).toEqual([]);
    // A frame never joins its own member.
    const nest = [F("outer", 0, 0, 1000, 1000), F("inner", 10, 10, 100, 100, { props: { parent: "outer" } })];
    expect(membershipChanges(nest, ["outer"])).toEqual([]);
  });
  it("members through nested frames; a new frame adopts free shapes whose centre is inside", () => {
    const all = [F("f", 0, 0), F("g", 10, 10, 200, 200, { props: { parent: "f" } }), R("a", 20, 20, { props: { parent: "g" } }), R("b", 50, 250), R("c", 900, 900)];
    expect(membersOf(all, "f").sort()).toEqual(["a", "g"]);
    expect(adopted(all, F("n", 0, 200, 300, 200))).toEqual(["b"]);
    expect(nextFrameName([F("x", 0, 0, 1, 1, { label: "Frame 1" })])).toBe("Frame 2");
  });
});

describe("frames on the board", { timeout: 60_000 }, () => {
  function board(extra: (doc: Y.Doc, id: string) => void = () => {}) {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    extra(doc, id);
    return { doc, id };
  }

  it("F then a drag draws a frame that adopts the shapes in it, behind them", () => {
    let a = "";
    const { doc, id } = board((d, b) => (a = addShape(d, b, { type: "rect", x: 100, y: 100, w: 100, h: 60, text: "A" })));
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const root = el.querySelector<HTMLElement>(".ocbd")!;
    act(() => root.focus());
    key(root, "f");
    expect(el.querySelector('[aria-label="Frame"][aria-pressed="true"]')).toBeTruthy();
    const svg = el.querySelector("svg.ocbd-svg")!;
    ptr(svg, "pointerdown", 50, 50);
    ptr(svg, "pointermove", 200, 150);
    ptr(svg, "pointermove", 450, 350);
    ptr(svg, "pointerup", 450, 350);
    const f = shapes(doc, id).find((s) => s.kind === CONTAINER)!;
    expect(f).toMatchObject({ type: "rect", kind: CONTAINER, label: "Frame 1", x: 50, y: 50, w: 400, h: 300 });
    expect(one(doc, id, a)?.props?.parent).toBe(f.id);
    expect((getBoardMap(doc, id)!.get("order") as Y.Array<string>).toArray()[0]).toBe(f.id);
    // Its name sits above it.
    expect(el.querySelector(`[data-frame-name="${f.id}"]`)?.textContent).toBe("Frame 1");
  });

  it("dropping a shape's centre in a frame adds it; moving the frame moves it; deleting the frame keeps it", () => {
    let a = "", f = "";
    const { doc, id } = board((d, b) => {
      f = addShape(d, b, F("", 0, 0, 400, 300, { label: "Sprint" }));
      a = addShape(d, b, { type: "rect", x: 600, y: 100, w: 100, h: 60, text: "A" });
    });
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const svg = el.querySelector("svg.ocbd-svg")!;
    ptr(el.querySelector(`[data-s="${a}"] rect`)!, "pointerdown", 650, 130);
    ptr(svg, "pointermove", 500, 130);
    ptr(svg, "pointermove", 250, 130);
    ptr(svg, "pointerup", 250, 130);
    expect(one(doc, id, a)?.props?.parent).toBe(f);
    expect(el.querySelector(".ocbd-sr[role=status]")?.textContent).toBe("Added to Sprint");
    // Drag the frame by its name: the member moves with it.
    const ax = one(doc, id, a)!.x!;
    ptr(el.querySelector(`[data-frame-name="${f}"]`)!, "pointerdown", 10, -10);
    ptr(svg, "pointermove", 40, -10);
    ptr(svg, "pointermove", 110, -10);
    ptr(svg, "pointerup", 110, -10);
    expect(one(doc, id, f)!.x).toBe(100);
    expect(one(doc, id, a)!.x).toBe(ax + 100);
    // Delete the frame: the shape stays and leaves it.
    key(el.querySelector(".ocbd")!, "Delete");
    expect(one(doc, id, f)).toBeUndefined();
    expect(one(doc, id, a)).toBeTruthy();
    expect(one(doc, id, a)?.props?.parent).toBeUndefined();
  });

  it("clicking inside a frame reaches the canvas; F2 renames the selected frame", () => {
    let f = "";
    const { doc, id } = board((d, b) => (f = addShape(d, b, F("", 0, 0, 400, 300, { label: "Sprint" }))));
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const body = el.querySelector(`[data-s="${f}"] rect`)!;
    expect(body.getAttribute("pointer-events")).toBe("none");
    act(() => el.querySelector<HTMLElement>(`[data-frame-name="${f}"]`)!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Frame name"]')!;
    expect(input.value).toBe("Sprint");
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "Next sprint");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    key(input, "Enter");
    expect(one(doc, id, f)!.label).toBe("Next sprint");
  });

  it("the zoom menu lists frames; Present (⇧P) steps through them", async () => {
    const { doc, id } = board((d, b) => {
      addShape(d, b, F("", 0, 0, 400, 300, { label: "One" }));
      addShape(d, b, F("", 600, 0, 400, 300, { label: "Two" }));
    });
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env({ compact: true })} />);
    const zoom = el.querySelector<HTMLButtonElement>('.ocbd-zoom [aria-haspopup="menu"]')!;
    act(() => zoom.click());
    const items = [...el.querySelectorAll(".ocbd-zoommenu [role=menuitem]")].map((b) => b.textContent);
    expect(items).toContain("One");
    expect(items).toContain("Two");
    act(() => zoom.click());
    const root = el.querySelector<HTMLElement>(".ocbd")!;
    act(() => root.focus());
    key(root, "P", { shiftKey: true });
    for (let t = 0; t < 100 && !el.ownerDocument.querySelector('[aria-label="Presenting frames"]'); t++) await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    const pres = el.ownerDocument.querySelector<HTMLElement>('[role="dialog"][aria-label="Presenting frames"]')!;
    expect(pres).toBeTruthy();
    expect(pres.textContent).toContain("One");
    expect(pres.textContent).toContain("1 / 2");
    key(pres, "ArrowRight");
    expect(pres.textContent).toContain("Two");
    expect(pres.textContent).toContain("2 / 2");
    key(pres, "Escape");
    await flush();
    expect(el.ownerDocument.querySelector('[aria-label="Presenting frames"]')).toBeNull();
  });
});
