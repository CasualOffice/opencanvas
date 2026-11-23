// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// UX pass (docs/20-BLOCKS-UX-AUDIT.md): multi-select, box select, groups, align / distribute,
// snapping, copy / paste, z-order, keyboard alternatives, sticky auto-grow, labels, presence.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, getBoardMap, readShapes, type Shape } from "./model";
import { alignMoves, cloneShapes, distributeMoves, reorderIds, snapOffset, stickyHeight, withGroups, wrapText } from "./ops";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (): BlockEnv => ({ role: "edit", compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} });
const shapes = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);
const one = (doc: Y.Doc, id: string, sid: string) => shapes(doc, id).find((s) => s.id === sid)!;

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
// jsdom: no layout, so client coords == board coords (view at 0,0 zoom 1).
function ptr(target: Element, type: string, x: number, y: number, o: { shiftKey?: boolean; altKey?: boolean } = {}) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...o });
  Object.defineProperty(e, "pointerId", { value: 1 });
  Object.defineProperty(e, "pointerType", { value: "mouse" });
  act(() => void target.dispatchEvent(e));
}
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o })));

function fixture() {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  const a = addShape(doc, id, { type: "rect", x: 20, y: 20, w: 100, h: 60, text: "A" });
  const b = addShape(doc, id, { type: "rect", x: 300, y: 200, w: 100, h: 60, text: "B" });
  const c = addShape(doc, id, { type: "sticky", x: 600, y: 40, w: 150, h: 110, fill: "y", text: "C" });
  return { doc, id, a, b, c };
}
const sel = (el: Element) => el.querySelector(".ocbd-swatch")?.getAttribute("aria-label");

describe("ops", () => {
  const S = (id: string, x: number, y: number, w = 100, h = 50): Shape => ({ id, type: "rect", x, y, w, h });
  it("aligns and distributes", () => {
    const list = [S("a", 0, 0), S("b", 40, 100, 60), S("c", 300, 10)];
    expect(alignMoves(list, "left").map((m) => m.patch.x)).toEqual([0, 0, 0]);
    expect(alignMoves(list, "right").map((m) => m.patch.x)).toEqual([300, 340, 300]);
    expect(alignMoves(list, "top").map((m) => m.patch.y)).toEqual([0, 0, 0]);
    const d = distributeMoves([S("a", 0, 0), S("b", 50, 0), S("c", 300, 0)], "h");
    // span 0..400, sizes 300, gap 50: a at 0, b at 150, c at 300
    expect(d.map((m) => m.patch.x)).toEqual([0, 150, 300]);
    expect(distributeMoves(list.slice(0, 2), "h")).toEqual([]);
  });
  it("snaps to other shapes' edges and centres", () => {
    const r = snapOffset([0, 0, 100, 50], [[200, 300, 300, 350]], 197, 3, 6);
    expect(r.dx).toBe(200);
    expect(r.gx).toContain(200);
    const free = snapOffset([0, 0, 100, 50], [[500, 500, 600, 600]], 197, 3, 6);
    expect([free.dx, free.dy]).toEqual([197, 3]);
  });
  it("clones with fresh ids, keeps bindings inside the set and drops the rest", () => {
    const list: Shape[] = [S("a", 0, 0), S("b", 300, 0), { id: "ar", type: "arrow", pts: [[100, 25], [300, 25]], start: { shapeId: "a", anchor: "right" }, end: { shapeId: "zz", anchor: "left" }, group: "g1" }];
    const out = cloneShapes(list, 10, 10);
    expect(out.map((s) => s.id).some((x) => ["a", "b", "ar"].includes(x))).toBe(false);
    const ar = out[2];
    expect(ar.start!.shapeId).toBe(out[0].id);
    expect(ar.end).toBeUndefined();
    expect(ar.group).not.toBe("g1");
    expect(ar.pts![0]).toEqual([110, 35]);
  });
  it("reorders, groups and wraps", () => {
    expect(reorderIds(["a", "b", "c", "d"], ["b"], "front")).toEqual(["a", "c", "d", "b"]);
    expect(reorderIds(["a", "b", "c", "d"], ["c"], "back")).toEqual(["c", "a", "b", "d"]);
    expect(reorderIds(["a", "b", "c", "d"], ["b"], "forward")).toEqual(["a", "c", "b", "d"]);
    expect(reorderIds(["a", "b", "c", "d"], ["c"], "backward")).toEqual(["a", "c", "b", "d"]);
    expect(withGroups([{ ...S("a", 0, 0), group: "g" }, { ...S("b", 0, 0), group: "g" }, S("c", 0, 0)], ["a"]).sort()).toEqual(["a", "b"]);
    expect(wrapText("one two three four five six", 60, 14).length).toBeGreaterThan(1);
    expect(wrapText("a\nb", 600, 14)).toEqual(["a", "b"]);
    expect(stickyHeight("short", 150, 110)).toBe(110);
    expect(stickyHeight("word ".repeat(60), 150, 110)).toBeGreaterThan(110);
  });
});

// Heavy suite (full board mounts in jsdom): an explicit timeout for slow CI runners.
describe("board selection", { timeout: 60_000 }, () => {
  it("box-selects by dragging on empty canvas, Shift adds", () => {
    const { doc, id, c } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const svg = el.querySelector("svg.ocbd-svg")!;
    ptr(svg, "pointerdown", 0, 0);
    ptr(svg, "pointermove", 200, 150);
    expect(el.querySelector(".ocbd-marquee")).toBeTruthy();
    ptr(svg, "pointermove", 420, 280);
    ptr(svg, "pointerup", 420, 280);
    expect(sel(el)).toBe("2 shapes");
    expect(el.querySelector(".ocbd-marquee")).toBeNull();
    // Shift-click the sticky adds it; Shift-click again removes it.
    ptr(el.querySelector(`[data-s="${c}"] rect`)!, "pointerdown", 650, 60, { shiftKey: true });
    ptr(svg, "pointerup", 650, 60);
    expect(sel(el)).toBe("3 shapes");
    ptr(el.querySelector(`[data-s="${c}"] rect`)!, "pointerdown", 650, 60, { shiftKey: true });
    ptr(svg, "pointerup", 650, 60);
    expect(sel(el)).toBe("2 shapes");
  });

  it("drags a multi-selection together, snapping to other shapes", () => {
    const { doc, id, a, b, c } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const svg = el.querySelector("svg.ocbd-svg")!;
    act(() => el.querySelector<HTMLElement>(".ocbd")!.focus());
    key(el.querySelector(".ocbd")!, "a", { ctrlKey: true });
    expect(sel(el)).toBe("3 shapes");
    ptr(el.querySelector(`[data-s="${a}"] rect`)!, "pointerdown", 50, 50);
    ptr(svg, "pointermove", 90, 70);
    ptr(svg, "pointerup", 90, 70);
    expect([one(doc, id, a).x, one(doc, id, b).x, one(doc, id, c).x]).toEqual([60, 340, 640]);
    // Select only A and drag so its left edge lands 3 px from B's left edge: it snaps.
    ptr(svg, "pointerdown", 1000, 1000);
    ptr(svg, "pointerup", 1000, 1000);
    ptr(el.querySelector(`[data-s="${a}"] rect`)!, "pointerdown", 80, 40);
    ptr(svg, "pointermove", 357, 300);
    expect(el.querySelector(".ocbd-guides line")).toBeTruthy();
    ptr(svg, "pointerup", 357, 300);
    expect(one(doc, id, a).x).toBe(340);
    // Alt moves freely.
    ptr(el.querySelector(`[data-s="${a}"] rect`)!, "pointerdown", 360, 300);
    ptr(svg, "pointermove", 363, 300, { altKey: true });
    ptr(svg, "pointerup", 363, 300);
    expect(one(doc, id, a).x).toBe(343);
  });

  it("groups, then a click selects the whole group; ungroup splits it", () => {
    const { doc, id, a, b } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const svg = el.querySelector("svg.ocbd-svg")!;
    const root = el.querySelector(".ocbd")!;
    ptr(svg, "pointerdown", 0, 0);
    ptr(svg, "pointermove", 420, 280);
    ptr(svg, "pointerup", 420, 280);
    key(root, "g", { ctrlKey: true });
    expect(one(doc, id, a).group).toBeTruthy();
    expect(one(doc, id, a).group).toBe(one(doc, id, b).group);
    key(root, "Escape");
    ptr(el.querySelector(`[data-s="${b}"] rect`)!, "pointerdown", 350, 230);
    ptr(svg, "pointerup", 350, 230);
    expect(sel(el)).toBe("2 shapes");
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Ungroup"]')!.click());
    expect(one(doc, id, a).group).toBeUndefined();
  });
});

// Heavy suite (full board mounts in jsdom): an explicit timeout for slow CI runners.
describe("board keyboard", { timeout: 60_000 }, () => {
  it("Tab walks the shapes; arrows nudge; Alt+arrows resize; Delete removes; undo restores", () => {
    const { doc, id, a, b } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const root = el.querySelector<HTMLElement>(".ocbd")!;
    expect(root.tabIndex).toBe(0);
    act(() => root.focus());
    key(root, "Tab");
    expect(el.querySelector(".ocbd-sr[role=status]")!.textContent).toMatch(/Rectangle: A\. 1 of 3/);
    key(root, "ArrowRight", { shiftKey: true });
    expect(one(doc, id, a).x).toBe(30);
    key(root, "ArrowDown", { altKey: true });
    expect(one(doc, id, a).h).toBe(61);
    key(root, "Tab");
    expect(el.querySelector(".ocbd-sr[role=status]")!.textContent).toMatch(/Rectangle: B/);
    key(root, "Delete");
    expect(shapes(doc, id).some((s) => s.id === b)).toBe(false);
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!.click());
    expect(shapes(doc, id).some((s) => s.id === b)).toBe(true);
  });

  it("changes z-order with Ctrl+] / Ctrl+Shift+[", () => {
    const { doc, id, a } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const root = el.querySelector<HTMLElement>(".ocbd")!;
    act(() => root.focus());
    key(root, "Tab");
    key(root, "]", { ctrlKey: true });
    expect(shapes(doc, id).map((s) => s.id).indexOf(a)).toBe(1);
    key(root, "]", { ctrlKey: true, shiftKey: true });
    expect(shapes(doc, id).at(-1)!.id).toBe(a);
    key(root, "[", { ctrlKey: true, shiftKey: true });
    expect(shapes(doc, id)[0].id).toBe(a);
  });

  it("places a sticky from the keyboard, and the note grows to fit long text", () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const root = el.querySelector<HTMLElement>(".ocbd")!;
    act(() => root.focus());
    key(root, "n");
    key(root, "Enter");
    const ta = el.querySelector<HTMLTextAreaElement>("textarea.ocbd-edit")!;
    expect(ta).toBeTruthy();
    const text = "A long sticky note that wraps across several lines and needs more room than the default";
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, text);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    key(ta, "Enter", { ctrlKey: true });
    const s = shapes(doc, id)[0];
    expect(s.type).toBe("sticky");
    expect(s.text).toBe(text);
    expect(s.h).toBeGreaterThan(110);
  });

  it("connects two selected shapes without drawing, and labels the connector", () => {
    const { doc, id, a, b } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const svg = el.querySelector("svg.ocbd-svg")!;
    ptr(svg, "pointerdown", 0, 0);
    ptr(svg, "pointermove", 420, 280);
    ptr(svg, "pointerup", 420, 280);
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Connect with an arrow"]')!.click());
    const ar = shapes(doc, id).find((s) => s.type === "arrow")!;
    expect(ar.start!.shapeId).toBe(a);
    expect(ar.end!.shapeId).toBe(b);
    // Enter edits the label in place.
    const root = el.querySelector<HTMLElement>(".ocbd")!;
    act(() => root.focus());
    key(root, "Enter");
    const ta = el.querySelector<HTMLTextAreaElement>("textarea.ocbd-edit")!;
    expect(ta.getAttribute("aria-label")).toBe("Connector label");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "yes");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    key(ta, "Enter");
    expect(one(doc, id, ar.id).text).toBe("yes");
    expect(el.querySelector(".ocbd-alabel")!.textContent).toBe("yes");
  });
});

// Heavy suite (full board mounts in jsdom): an explicit timeout for slow CI runners.
describe("board clipboard and presence", { timeout: 60_000 }, () => {
  const clipEvent = (type: string, data: Map<string, string>) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", { value: { setData: (t: string, v: string) => data.set(t, v), getData: (t: string) => data.get(t) ?? "", files: [], items: [], types: [...data.keys()] } });
    return e;
  };

  it("copies and pastes shapes with a bound connector between them", () => {
    const { doc, id, a, b } = fixture();
    addShape(doc, id, { type: "arrow", pts: [[120, 50], [300, 230]], start: { shapeId: a, anchor: "right" }, end: { shapeId: b, anchor: "left" } });
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const svg = el.querySelector("svg.ocbd-svg")!;
    const root = el.querySelector<HTMLElement>(".ocbd")!;
    ptr(svg, "pointerdown", 0, 0);
    ptr(svg, "pointermove", 420, 280);
    ptr(svg, "pointerup", 420, 280);
    expect(sel(el)).toBe("3 shapes");
    act(() => root.focus());
    const data = new Map<string, string>();
    act(() => void root.dispatchEvent(clipEvent("copy", data)));
    expect(data.get("text/html")).toContain("data-oc-board");
    act(() => void root.dispatchEvent(clipEvent("paste", data)));
    const all = shapes(doc, id);
    expect(all).toHaveLength(7);
    const arrows = all.filter((s) => s.type === "arrow");
    const copy = arrows.find((s) => s.start!.shapeId !== a)!;
    const ca = one(doc, id, copy.start!.shapeId), cb = one(doc, id, copy.end!.shapeId);
    expect([ca.text, cb.text]).toEqual(["A", "B"]);
    expect(ca.x).toBe(44);
    expect(sel(el)).toBe("3 shapes");
    // Cut removes the (pasted) selection.
    act(() => void root.dispatchEvent(clipEvent("cut", new Map())));
    expect(shapes(doc, id)).toHaveLength(4);
  });

  it("pasting plain text makes a text shape", () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const root = el.querySelector<HTMLElement>(".ocbd")!;
    act(() => root.focus());
    act(() => void root.dispatchEvent(clipEvent("paste", new Map([["text/plain", "Hello board"]]))));
    expect(shapes(doc, id)[0]).toMatchObject({ type: "text", text: "Hello board" });
  });

  it("shows other people's selections and publishes its own", () => {
    const { doc, id, a } = fixture();
    const local = new Awareness(doc);
    const remote = new Awareness(new Y.Doc());
    remote.setLocalState({ user: { name: "Ravi Menon", color: "#e5602a" }, board: { id, sel: [a] } });
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} awareness={local} />);
    act(() => applyAwarenessUpdate(local, encodeAwarenessUpdate(remote, [remote.clientID]), "remote"));
    const ps = el.querySelector(".ocbd-peersel")!;
    expect(ps).toBeTruthy();
    expect(ps.textContent).toContain("Ravi Menon");
    const root = el.querySelector<HTMLElement>(".ocbd")!;
    act(() => root.focus());
    key(root, "Tab");
    expect((local.getLocalState()!.board as { sel: string[] }).sel).toEqual([a]);
    local.destroy();
    remote.destroy();
  });
});
