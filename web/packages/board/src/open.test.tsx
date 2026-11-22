// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// Open items from docs/20-BLOCKS-UX-AUDIT.md: minimap (B19), manual connector waypoints (B20),
// and the editor's shared undo manager (docs/19 #42).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { elbowVia, resolveArrow, withResolvedArrows } from "./connectors";
import { shapesToSvg } from "./export";
import { addShape, getBoardMap, readShapes, type Shape } from "./model";
import { cloneShapes, movePatch } from "./ops";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (extra: Partial<BlockEnv> = {}): BlockEnv => ({ role: "edit", compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {}, ...extra });
const shapes = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);
const one = (doc: Y.Doc, id: string, sid: string) => shapes(doc, id).find((s) => s.id === sid)!;
const drawn = (doc: Y.Doc, id: string, sid: string) => withResolvedArrows(shapes(doc, id)).find((s) => s.id === sid)!.pts!;

let cleanup: (() => void) | null = null;
// jsdom has no layout: give the canvas a size so the view and the minimap have something to show.
const size = { w: 800, h: 440 };
beforeEach(() => {
  Object.defineProperty(SVGElement.prototype, "clientWidth", { configurable: true, get() { return (this as Element).classList.contains("ocbd-svg") ? size.w : 0; } });
  Object.defineProperty(SVGElement.prototype, "clientHeight", { configurable: true, get() { return (this as Element).classList.contains("ocbd-svg") ? size.h : 0; } });
});
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
  delete (SVGElement.prototype as { clientWidth?: number }).clientWidth;
  delete (SVGElement.prototype as { clientHeight?: number }).clientHeight;
});
function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  cleanup = () => act(() => root.unmount());
  return el;
}
function ptr(target: Element, type: string, x: number, y: number, o: { shiftKey?: boolean; altKey?: boolean } = {}) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail: type === "dblclick" ? 2 : 1, ...o });
  Object.defineProperty(e, "pointerId", { value: 1 });
  Object.defineProperty(e, "pointerType", { value: "mouse" });
  act(() => void target.dispatchEvent(e));
}
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o })));
/** The board's view transform: [tx, ty, z]. */
function view(el: Element): [number, number, number] {
  const t = el.querySelector("svg.ocbd-svg > g[transform]")!.getAttribute("transform")!;
  const m = t.match(/translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/)!;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function fixture() {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  const a = addShape(doc, id, { type: "rect", x: 0, y: 0, w: 100, h: 60 });
  const b = addShape(doc, id, { type: "rect", x: 400, y: 300, w: 100, h: 60 });
  const ar = addShape(doc, id, { type: "arrow", pts: [[100, 30], [400, 330]], start: { shapeId: a, anchor: "right" }, end: { shapeId: b, anchor: "left" } });
  return { doc, id, a, b, ar };
}

/* ------------------------------------------------------------- B20 */

describe("connector waypoints: geometry", () => {
  const A: Shape = { id: "a", type: "rect", x: 0, y: 0, w: 100, h: 60 };
  const B: Shape = { id: "b", type: "rect", x: 400, y: 300, w: 100, h: 60 };
  const byId = new Map([A, B].map((s) => [s.id, s]));

  it("a straight connector passes through its waypoints; centre ends aim at the nearest one", () => {
    const s: Shape = { id: "x", type: "arrow", pts: [[0, 0], [1, 1]], start: { shapeId: "a", anchor: "center" }, end: { shapeId: "b", anchor: "right" }, via: [[50, 200], [300, 200]] };
    expect(resolveArrow(s, byId)).toEqual([[50, 60], [50, 200], [300, 200], [500, 330]]);
    // Free ends keep their stored points.
    expect(resolveArrow({ id: "f", type: "arrow", pts: [[0, 0], [10, 0]], via: [[5, 5]] }, byId)).toEqual([[0, 0], [5, 5], [10, 0]]);
  });

  it("an elbow connector routes orthogonally through its waypoints and into the bound sides", () => {
    // Leaves right, corners at the waypoint, enters the left side horizontally (two corners).
    expect(elbowVia([[0, 0], [100, 50], [200, 0]], "right", "left")).toEqual([[0, 0], [100, 0], [100, 50], [150, 50], [150, 0], [200, 0]]);
    // Into a top side: the last leg ends vertically with one corner.
    expect(elbowVia([[0, 0], [100, 50], [200, 100]], "right", "top")).toEqual([[0, 0], [100, 0], [100, 50], [200, 50], [200, 100]]);
    const s: Shape = { id: "x", type: "arrow", pts: [[0, 0], [1, 1]], route: "elbow", start: { shapeId: "a", anchor: "right" }, end: { shapeId: "b", anchor: "left" }, via: [[250, 100]] };
    const pts = resolveArrow(s, byId);
    expect(pts[0]).toEqual([100, 30]);
    expect(pts.at(-1)).toEqual([400, 330]);
    for (let i = 1; i < pts.length; i++) expect(pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1]).toBe(true);
    expect(pts.some((p) => p[0] === 250 || p[1] === 100)).toBe(true);
  });

  it("moves and clones carry the waypoints along", () => {
    expect(movePatch({ id: "x", type: "arrow", pts: [[0, 0], [10, 0]], via: [[5, 5]] }, 10, 20)).toEqual({ pts: [[10, 20], [20, 20]], via: [[15, 25]] });
    expect(cloneShapes([{ id: "x", type: "arrow", pts: [[0, 0], [10, 0]], via: [[5, 5]] }], 1, 1)[0].via).toEqual([[6, 6]]);
  });

  it("both exporters draw the path through the waypoints", () => {
    const svg = shapesToSvg([A, B, { id: "x", type: "arrow", pts: [[0, 0], [1, 1]], start: { shapeId: "a", anchor: "right" }, end: { shapeId: "b", anchor: "left" }, via: [[250, 30], [250, 330]] }]);
    expect(svg).toContain(`d="M100 30 L250 30 L250 330 L400 330"`);
  });
});

describe("connector waypoints: editing", () => {
  function selectArrow(el: Element, ar: string) {
    const svg = el.querySelector("svg.ocbd-svg")!;
    ptr(el.querySelector(`[data-s="${ar}"] path`)!, "pointerdown", 250, 180);
    ptr(svg, "pointerup", 250, 180);
    return svg;
  }

  it("double-click on a selected connector adds a waypoint there; dragging moves it; Delete removes it", () => {
    const { doc, id, ar } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const svg = selectArrow(el, ar);
    const hit = el.querySelector(`[data-s="${ar}"] path`)!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
    ptr(svg, "dblclick", 250, 180);
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    expect(one(doc, id, ar).via).toEqual([[250, 180]]);
    expect(one(doc, id, ar).start).toBeTruthy();
    expect(drawn(doc, id, ar)).toEqual([[100, 30], [250, 180], [400, 330]]);
    // The stored points follow, for readers that ignore `via`.
    expect(one(doc, id, ar).pts).toEqual([[100, 30], [250, 180], [400, 330]]);
    expect(el.querySelector("textarea.ocbd-edit")).toBeNull();

    const wp = el.querySelector('circle.ocbd-wp[data-wp="0"]')!;
    expect(wp).toBeTruthy();
    ptr(wp, "pointerdown", 250, 180);
    ptr(svg, "pointermove", 260, 100);
    ptr(svg, "pointerup", 260, 100);
    expect(one(doc, id, ar).via).toEqual([[260, 100]]);

    key(el.querySelector(".ocbd")!, "Delete");
    expect(one(doc, id, ar)).toBeTruthy();
    expect(one(doc, id, ar).via).toBeUndefined();
    expect(drawn(doc, id, ar)).toEqual([[100, 30], [400, 330]]);
  });

  it("dragging a segment's midpoint handle inserts a waypoint", () => {
    const { doc, id, ar } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const svg = selectArrow(el, ar);
    const mid = el.querySelector('circle.ocbd-wpadd[data-seg="0"]')!;
    expect(mid).toBeTruthy();
    ptr(mid, "pointerdown", 250, 180);
    ptr(svg, "pointermove", 100, 300);
    ptr(svg, "pointerup", 100, 300);
    expect(one(doc, id, ar).via).toEqual([[100, 300]]);
  });

  it("keyboard: W adds a waypoint, arrows move it, Alt+arrows pick another, Delete removes, Escape leaves", () => {
    const { doc, id, ar } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    selectArrow(el, ar);
    const root = el.querySelector<HTMLElement>(".ocbd")!;
    act(() => root.focus());
    key(root, "w");
    expect(one(doc, id, ar).via).toEqual([[250, 180]]);
    expect(el.querySelector(".ocbd-sr[role=status]")!.textContent).toMatch(/Waypoint 1 of 1/);
    key(root, "ArrowRight", { shiftKey: true });
    key(root, "ArrowUp");
    expect(one(doc, id, ar).via).toEqual([[260, 179]]);
    key(root, "w");
    expect(one(doc, id, ar).via).toHaveLength(2);
    key(root, "ArrowLeft", { altKey: true });
    expect(el.querySelector(".ocbd-sr[role=status]")!.textContent).toMatch(/Waypoint 1 of 2/);
    key(root, "Delete");
    expect(one(doc, id, ar).via).toHaveLength(1);
    key(root, "Escape");
    // Back to the connector: arrows nudge it (and detach it) again.
    expect(el.querySelector("circle.ocbd-wp.on")).toBeNull();
    expect(shapes(doc, id).some((s) => s.id === ar)).toBe(true);
  });

  it("toolbar buttons add and clear waypoints (single-pointer path)", () => {
    const { doc, id, ar } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    selectArrow(el, ar);
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Add waypoint"]')!.click());
    expect(one(doc, id, ar).via).toHaveLength(1);
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Clear waypoints"]')!.click());
    expect(one(doc, id, ar).via).toBeUndefined();
  });

  it("bound ends still follow their shapes with waypoints set", () => {
    const { doc, id, b, ar } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const svg = selectArrow(el, ar);
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Add waypoint"]')!.click());
    ptr(el.querySelector(`[data-s="${b}"] rect`)!, "pointerdown", 450, 330);
    ptr(svg, "pointermove", 550, 330);
    ptr(svg, "pointerup", 550, 330);
    expect(drawn(doc, id, ar).at(-1)).toEqual([500, 330]);
    expect(drawn(doc, id, ar)[1]).toEqual([250, 180]);
  });
});

/* ------------------------------------------------------------- B19 */

describe("minimap", () => {
  it("toggles from the zoom bar and with M", () => {
    const { doc, id } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    expect(el.querySelector(".ocbd-mini")).toBeNull();
    const btn = el.querySelector<HTMLButtonElement>('[aria-label="Minimap"]')!;
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    act(() => btn.click());
    expect(el.querySelector(".ocbd-mini")).toBeTruthy();
    expect(el.querySelectorAll(".ocbd-mini [data-ms]")).toHaveLength(3);
    const root = el.querySelector<HTMLElement>(".ocbd")!;
    act(() => root.focus());
    key(root, "m");
    expect(el.querySelector(".ocbd-mini")).toBeNull();
  });

  function withMap() {
    const { doc, id, b } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Minimap"]')!.click());
    const map = el.querySelector<HTMLElement>(".ocbd-mini")!;
    const world = map.querySelector("g.ocbd-mini-world")!.getAttribute("transform")!;
    const [, ox, oy, k] = world.match(/translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/)!.map(Number);
    /** Minimap pixel for a board point. */
    const at = (x: number, y: number): [number, number] => [ox + x * k, oy + y * k];
    return { doc, id, b, el, map, at, k };
  }

  it("click jumps the view to that spot", () => {
    const { el, map, at } = withMap();
    const [px, py] = at(450, 330);
    ptr(map.querySelector("svg")!, "pointerdown", px, py);
    ptr(map.querySelector("svg")!, "pointerup", px, py);
    const [tx, ty, z] = view(el);
    // The view's centre is now the clicked board point.
    expect((size.w / 2 - tx) / z).toBeCloseTo(450, 0);
    expect((size.h / 2 - ty) / z).toBeCloseTo(330, 0);
  });

  it("dragging the viewport rectangle pans the board", () => {
    const { el, map, k } = withMap();
    const [tx0, ty0, z] = view(el);
    const vp = map.querySelector(".ocbd-mini-vp")!;
    ptr(vp, "pointerdown", 50, 40);
    ptr(window as unknown as Element, "pointermove", 60, 40);
    ptr(window as unknown as Element, "pointerup", 60, 40);
    const [tx1, ty1] = view(el);
    expect(tx1).toBeCloseTo(tx0 - (10 / k) * z, 3);
    expect(ty1).toBeCloseTo(ty0, 3);
  });

  it("arrow keys pan the view from the focused minimap (keyboard alternative to dragging)", () => {
    const { el, map } = withMap();
    const [tx0] = view(el);
    key(map, "ArrowRight");
    expect(view(el)[0]).toBeLessThan(tx0);
  });
});

describe("zoom shortcuts", () => {
  it("Shift+1 fits the content and Shift+2 zooms to the selection", () => {
    const { doc, id, a } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const root = el.querySelector<HTMLElement>(".ocbd")!;
    act(() => root.focus());
    key(root, "!", { shiftKey: true, code: "Digit1" });
    const fitZ = view(el)[2];
    key(root, "Tab");
    expect(el.querySelector(".ocbd-sr[role=status]")!.textContent).toMatch(/Rectangle/);
    key(root, "@", { shiftKey: true, code: "Digit2" });
    const [tx, ty, z] = view(el);
    expect(z).toBeGreaterThan(fitZ);
    // The selected rectangle's centre (50, 30) sits in the view.
    expect((50 * z + tx) > 0 && (50 * z + tx) < size.w && (30 * z + ty) > 0 && (30 * z + ty) < size.h).toBe(true);
    void a;
  });
});

describe("inside the editor", () => {
  it("keeps its keyboard shortcuts when it sits in a contenteditable document", () => {
    const { doc, id, a } = fixture();
    const host = document.createElement("div");
    host.setAttribute("contenteditable", "true");
    document.body.appendChild(host);
    const el = document.createElement("div");
    el.setAttribute("contenteditable", "false");
    host.appendChild(el);
    const root = createRoot(el);
    act(() => root.render(<BoardBlock doc={doc} boardId={id} env={env()} />));
    cleanup = () => act(() => root.unmount());
    const board = el.querySelector<HTMLElement>(".ocbd")!;
    act(() => board.focus());
    key(board, "Tab");
    key(board, "ArrowRight");
    expect(one(doc, id, a).x).toBe(1);
  });
});

/* -------------------------------------------------- docs/19 #42 undo */

describe("shared undo manager", () => {
  it("tracks board edits in the editor's UndoManager when one is passed", () => {
    const { doc, id, a } = fixture();
    const um = new Y.UndoManager(doc.getXmlFragment("content"), { captureTimeout: 0 });
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env({ undoManager: um })} />);
    const root = el.querySelector<HTMLElement>(".ocbd")!;
    act(() => root.focus());
    key(root, "Tab");
    key(root, "ArrowRight", { shiftKey: true });
    expect(one(doc, id, a).x).toBe(10);
    expect(um.undoStack.length).toBeGreaterThan(0);
    act(() => void um.undo());
    expect(one(doc, id, a).x).toBe(0);
    // The board's own buttons and Ctrl+Z drive the same manager.
    act(() => void um.redo());
    expect(one(doc, id, a).x).toBe(10);
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!.click());
    expect(one(doc, id, a).x).toBe(0);
    key(root, "z", { ctrlKey: true, shiftKey: true });
    expect(one(doc, id, a).x).toBe(10);
  });

  it("leaves the shared manager alive when the board unmounts", () => {
    const { doc, id } = fixture();
    const um = new Y.UndoManager(doc.getXmlFragment("content"));
    mount(<BoardBlock doc={doc} boardId={id} env={env({ undoManager: um })} />);
    act(() => cleanup?.());
    cleanup = null;
    expect(um.scope.length).toBeGreaterThan(1);
    expect(() => um.undo()).not.toThrow();
  });
});
