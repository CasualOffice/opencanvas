// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// BRD-18 (context menu) and BRD-19 (tool lock), to docs/prototypes/board-ux-approved/board-ux.html
// decisions 1, 2, 3 and 14. Real-mouse checks: e2e/diagram/board-ux.spec.ts.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, getBoardMap, readShapes } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (): BlockEnv => ({ role: "edit", compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} });
const shapes = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});
function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  cleanup = () => act(() => root.unmount());
  return el;
}
function ptr(target: Element, type: string, x: number, y: number, o: { shiftKey?: boolean; pointerType?: string; button?: number } = {}) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: o.button ?? 0, shiftKey: o.shiftKey });
  Object.defineProperty(e, "pointerId", { value: 1 });
  Object.defineProperty(e, "pointerType", { value: o.pointerType ?? "mouse" });
  act(() => void target.dispatchEvent(e));
  return e;
}
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o })));
const click = (el: Element) => act(() => void (el as HTMLElement).click());
function board(seed?: (doc: Y.Doc, id: string) => void) {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  seed?.(doc, id);
  const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
  const root = el.querySelector<HTMLElement>(".ocbd")!;
  const svg = el.querySelector("svg.ocbd-svg")!;
  return { doc, id, el, root, svg };
}
const two = (doc: Y.Doc, id: string) => {
  addShape(doc, id, { id: "a", type: "rect", x: 100, y: 100, w: 120, h: 60, text: "Alpha" });
  addShape(doc, id, { id: "b", type: "rect", x: 300, y: 100, w: 120, h: 60, text: "Beta" });
};
const shapeEl = (el: Element, sid: string) => el.querySelector(`g[data-s="${sid}"] rect, g[data-s="${sid}"] path`)!;
const menu = (el: Element) => el.querySelector<HTMLElement>('[role="menu"].ocbd-ctx');
const item = (m: Element, name: string) => [...m.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((b) => b.textContent?.trim().startsWith(name))!;
function rightClick(target: Element, x = 150, y = 120) {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 });
  act(() => void target.dispatchEvent(e));
  return e;
}

describe("BRD-18: the context menu", () => {
  it("right-click on a shape selects it and opens the shape menu with shortcuts", () => {
    const b = board(two);
    const e = rightClick(shapeEl(b.el, "a"));
    expect(e.defaultPrevented).toBe(true);
    const m = menu(b.el)!;
    expect(m).not.toBeNull();
    for (const n of ["Cut", "Copy", "Paste", "Duplicate", "Arrange", "Align", "Group", "Lock", "Add link", "Delete"]) expect(item(m, n), n).toBeTruthy();
    expect(item(m, "Duplicate").getAttribute("aria-keyshortcuts")).toMatch(/D/);
    expect(document.activeElement).toBe(item(m, "Cut"));
    // Align needs two shapes: listed, disabled, with the reason.
    expect(item(m, "Align").getAttribute("aria-disabled")).toBe("true");
    expect(b.el.querySelector(".ocbd-swatch")).toBeNull();
  });

  it("right-click on empty canvas opens the canvas menu; Escape closes it and focus returns to the board", () => {
    const b = board(two);
    rightClick(b.svg, 700, 400);
    const m = menu(b.el)!;
    expect(item(m, "Select all")).toBeTruthy();
    expect(item(m, "Snap to objects").getAttribute("aria-checked")).toBe("true");
    key(document.activeElement!, "Escape");
    expect(menu(b.el)).toBeNull();
    expect(document.activeElement).toBe(b.root);
  });

  it("Shift+F10 opens it from the keyboard; arrows move, → opens Arrange, Enter runs Bring to front", () => {
    const b = board(two);
    act(() => b.root.focus());
    key(b.root, "Tab"); // selects the first shape, "a"
    key(b.root, "F10", { shiftKey: true });
    const m = menu(b.el)!;
    expect(m).not.toBeNull();
    const arrange = item(m, "Arrange");
    act(() => arrange.focus());
    key(arrange, "ArrowRight");
    const subs = b.el.querySelectorAll('[role="menu"].ocbd-ctx');
    expect(subs.length).toBe(2);
    expect(document.activeElement?.textContent).toMatch(/Bring to front/);
    key(document.activeElement!, "Enter");
    expect(menu(b.el)).toBeNull();
    expect(shapes(b.doc, b.id).map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("← closes a submenu and returns to its item", () => {
    const b = board(two);
    rightClick(shapeEl(b.el, "a"));
    const arrange = item(menu(b.el)!, "Arrange");
    act(() => arrange.focus());
    key(arrange, "ArrowRight");
    key(document.activeElement!, "ArrowLeft");
    expect(b.el.querySelectorAll('[role="menu"].ocbd-ctx').length).toBe(1);
    expect(document.activeElement).toBe(item(menu(b.el)!, "Arrange"));
  });

  it("Duplicate and Delete run from the menu", () => {
    const b = board(two);
    rightClick(shapeEl(b.el, "a"));
    click(item(menu(b.el)!, "Duplicate"));
    expect(shapes(b.doc, b.id).length).toBe(3);
    rightClick(shapeEl(b.el, "b"));
    click(item(menu(b.el)!, "Delete"));
    expect(shapes(b.doc, b.id).map((s) => s.id)).not.toContain("b");
  });

  it("Lock keeps a shape from moving and being deleted; the toolbar then offers Unlock", () => {
    const b = board(two);
    rightClick(shapeEl(b.el, "a"));
    click(item(menu(b.el)!, "Lock"));
    expect(shapes(b.doc, b.id).find((s) => s.id === "a")!.locked).toBe(true);
    ptr(shapeEl(b.el, "a"), "pointerdown", 150, 120);
    ptr(b.svg, "pointermove", 250, 220);
    ptr(b.svg, "pointerup", 250, 220);
    expect(shapes(b.doc, b.id).find((s) => s.id === "a")!.x).toBe(100);
    key(b.root, "Delete");
    expect(shapes(b.doc, b.id).map((s) => s.id)).toContain("a");
    const bar = b.el.querySelector(".ocbd-swatch")!;
    expect(bar.querySelector('[aria-label="Unlock"]')).not.toBeNull();
    key(b.root, "l", { shiftKey: true, ctrlKey: true });
    expect(shapes(b.doc, b.id).find((s) => s.id === "a")!.locked).toBeFalsy();
  });

  it("the marquee skips locked shapes", () => {
    const b = board((doc, id) => {
      two(doc, id);
      addShape(doc, id, { id: "l", type: "rect", x: 100, y: 200, w: 60, h: 40, locked: true });
    });
    ptr(b.svg, "pointerdown", 50, 50);
    ptr(b.svg, "pointermove", 600, 400);
    ptr(b.svg, "pointerup", 600, 400);
    const ring = b.el.querySelectorAll(".ocbd-selring");
    expect(ring.length).toBe(2);
  });

  it("Add link (Shift+Ctrl+K) stores a link and draws its badge", () => {
    const b = board(two);
    ptr(shapeEl(b.el, "a"), "pointerdown", 150, 120);
    ptr(b.svg, "pointerup", 150, 120);
    key(b.root, "k", { shiftKey: true, ctrlKey: true });
    const input = b.el.querySelector<HTMLInputElement>(".ocbd-linkpop input")!;
    expect(document.activeElement).toBe(input);
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      set.call(input, "https://example.org/spec");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    key(input, "Enter");
    expect(shapes(b.doc, b.id).find((s) => s.id === "a")!.link).toBe("https://example.org/spec");
    expect(b.el.querySelector('[data-link="a"]')).not.toBeNull();
  });

  it("rejects a link that is not http(s) or mailto", () => {
    const b = board(two);
    ptr(shapeEl(b.el, "a"), "pointerdown", 150, 120);
    ptr(b.svg, "pointerup", 150, 120);
    key(b.root, "k", { shiftKey: true, ctrlKey: true });
    const input = b.el.querySelector<HTMLInputElement>(".ocbd-linkpop input")!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      set.call(input, "javascript:alert(1)");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    key(input, "Enter");
    expect(shapes(b.doc, b.id).find((s) => s.id === "a")!.link).toBeUndefined();
    expect(b.el.querySelector(".ocbd-linkpop")?.textContent).toMatch(/http/);
  });

  it("the floating toolbar's More opens the same menu", () => {
    const b = board(two);
    ptr(shapeEl(b.el, "a"), "pointerdown", 150, 120);
    ptr(b.svg, "pointerup", 150, 120);
    click(b.el.querySelector('.ocbd-swatch [aria-label="More"]')!);
    expect(item(menu(b.el)!, "Arrange")).toBeTruthy();
  });

  it("a long press with a finger opens the menu as a sheet", () => {
    vi.useFakeTimers();
    const b = board(two);
    ptr(shapeEl(b.el, "a"), "pointerdown", 150, 120, { pointerType: "touch" });
    act(() => void vi.advanceTimersByTime(520));
    const m = menu(b.el)!;
    expect(m).not.toBeNull();
    expect(m.classList.contains("sheet")).toBe(true);
    expect(m.querySelector('.ocbd-quick [aria-label="Delete"]')).not.toBeNull();
    ptr(b.svg, "pointerup", 150, 120, { pointerType: "touch" });
    expect(menu(b.el)).not.toBeNull();
  });

  it("a finger that moves is a pan, not a long press", () => {
    vi.useFakeTimers();
    const b = board(two);
    ptr(shapeEl(b.el, "a"), "pointerdown", 150, 120, { pointerType: "touch" });
    ptr(b.svg, "pointermove", 190, 120, { pointerType: "touch" });
    act(() => void vi.advanceTimersByTime(600));
    expect(menu(b.el)).toBeNull();
  });
});

describe("BRD-19: tool lock", () => {
  it("Q keeps the tool after each shape; Escape releases it and returns to Select", () => {
    const b = board();
    act(() => b.root.focus());
    key(b.root, "r");
    key(b.root, "q");
    const lockBtn = b.el.querySelector<HTMLElement>('[aria-label="Keep tool active"]')!;
    expect(lockBtn.getAttribute("aria-pressed")).toBe("true");
    for (const x of [200, 400]) {
      ptr(b.svg, "pointerdown", x, 200);
      ptr(b.svg, "pointerup", x, 200);
    }
    expect(shapes(b.doc, b.id).filter((s) => s.type === "rect").length).toBe(2);
    expect(b.el.querySelector('[data-tool="rect"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(b.el.querySelector('[data-tool="rect"] .ocbd-lk')).not.toBeNull();
    key(b.root, "Escape");
    expect(b.el.querySelector('[data-tool="select"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(lockBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("without the lock the tool returns to Select (unchanged)", () => {
    const b = board();
    key(b.root, "r");
    ptr(b.svg, "pointerdown", 200, 200);
    ptr(b.svg, "pointerup", 200, 200);
    expect(b.el.querySelector('[data-tool="select"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("double-clicking a tool picks it and locks it", () => {
    const b = board();
    const t = b.el.querySelector('[data-tool="ellipse"]')!;
    act(() => void t.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(t.getAttribute("aria-pressed")).toBe("true");
    expect(b.el.querySelector('[aria-label="Keep tool active"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("? opens the keyboard shortcut list, with the new keys", () => {
    const b = board();
    key(b.root, "?", { shiftKey: true });
    const d = b.el.querySelector('[role="dialog"][aria-label="Keyboard shortcuts"]')!;
    expect(d).not.toBeNull();
    expect(d.textContent).toMatch(/Keep the tool active/);
    expect(d.textContent).toMatch(/Context menu/);
    key(document.activeElement!, "Escape");
    expect(b.el.querySelector('[role="dialog"][aria-label="Keyboard shortcuts"]')).toBeNull();
  });
});
