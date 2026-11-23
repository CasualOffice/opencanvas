// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-14 S5: outline, commands (⌘K), keyboard connector (C), shortcuts sheet (?) (prototype 5a-5d).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, getBoardMap, readShapes } from "./model";
import { announce, connectorFor, filterCommands, nextTarget, outlineTree, siblingOf, startConnect } from "./diagram/keyboard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (role: "edit" | "view" = "edit"): BlockEnv => ({ role, compact: false, me: { id: "p", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} });

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
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o })));
const until = (check: () => void) =>
  vi.waitFor(async () => {
    await act(async () => {});
    check();
  }, { timeout: 5_000 });
const shell = () => document.querySelector<HTMLElement>(".ocdg");

function fixture() {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  const vpc = addShape(doc, id, { type: "rect", x: 0, y: 0, w: 600, h: 400, label: "VPC", dashed: true });
  const lb = addShape(doc, id, { type: "rect", x: 20, y: 40, w: 120, h: 60, text: "Load balancer" });
  const pay = addShape(doc, id, { type: "rect", x: 300, y: 40, w: 120, h: 60, text: "Payments service" });
  const card = addShape(doc, id, { type: "rect", x: 800, y: 40, w: 120, h: 60, text: "Card processor" });
  const arrow = addShape(doc, id, { type: "arrow", pts: [[140, 70], [300, 70]], start: { shapeId: lb, anchor: "right" }, end: { shapeId: pay, anchor: "left" } });
  return { doc, id, vpc, lb, pay, card, arrow };
}
const shapesOf = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);

describe("S5 logic", () => {
  it("outline: containers hold the shapes inside them, then connectors; announcements name the container", () => {
    const { doc, id, vpc, lb, pay, card, arrow } = fixture();
    const shapes = shapesOf(doc, id);
    const t = outlineTree(shapes);
    expect(t.map((n) => [n.id, n.depth, n.parent])).toEqual([[vpc, 0, null], [lb, 1, vpc], [pay, 1, vpc], [card, 0, null], [arrow, 0, null]]);
    expect(t[4].name).toBe("Load balancer → Payments service");
    expect(announce(shapes, pay, true)).toBe("Payments service, Rectangle, in VPC, 1 connection, selected. 3 of 5.");
    expect(siblingOf(shapes, pay, -1)).toBe(lb);
    expect(siblingOf(shapes, lb, -1)).toBeNull();
  });

  it("keyboard connector: starts at the nearest shape, Tab cycles by distance, the end side is chosen", () => {
    const { doc, id, lb, pay, card } = fixture();
    const shapes = shapesOf(doc, id);
    const st = startConnect(shapes, pay)!;
    // The VPC frame's centre (300,200) is nearest, then the load balancer, then the card processor.
    expect(st.from).toBe(pay);
    const n1 = nextTarget(shapes, nextTarget(shapes, st));
    expect([nextTarget(shapes, st).to, n1.to]).toEqual([lb, card]);
    expect(n1.side).toBe("left");
    expect(connectorFor(shapes, { ...n1, side: "top" })).toEqual({ start: { shapeId: pay, anchor: "right" }, end: { shapeId: card, anchor: "top" } });
  });

  it("commands: filtered by the selection; typing a shape name puts it first", () => {
    const { doc, id, card } = fixture();
    const shapes = shapesOf(doc, id);
    const cmds = [
      { id: "duplicate", label: "Duplicate", group: "Commands" as const, when: (c: { sel: unknown[] }) => c.sel.length > 0 },
      { id: "fit", label: "Zoom to fit", group: "Commands" as const },
    ];
    expect(filterCommands(cmds, shapes, { sel: [], edit: true }, "").map((c) => c.id)).toEqual(["fit"]);
    expect(filterCommands(cmds, shapes, { sel: [shapes[0]], edit: true }, "").map((c) => c.id)).toContain("duplicate");
    expect(filterCommands(cmds, shapes, { sel: [], edit: true }, "card")[0].id).toBe(`go:${card}`);
  });
});

describe("S5 in the diagram window", { timeout: 30_000 }, () => {
  const open = async () => {
    const f = fixture();
    const el = mount(<BoardBlock doc={f.doc} boardId={f.id} env={env()} />);
    act(() => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Diagram")!.click());
    await until(() => expect(shell()).toBeTruthy());
    return f;
  };
  const live = () => shell()!.querySelector(".ocdg-live")?.textContent ?? "";

  it("Alt+O opens the Outline; arrows move, Enter selects (shared with the canvas), F2 renames", async () => {
    const { doc, id, lb, pay } = await open();
    key(shell()!.querySelector(".ocbd")!, "o", { altKey: true, code: "KeyO" });
    const tree = await vi.waitFor(() => shell()!.querySelector<HTMLElement>('aside[aria-label="Outline"] [role="tree"]')!);
    const row = (sid: string) => tree.querySelector<HTMLElement>(`[data-id="${sid}"]`)!;
    expect(row(lb).getAttribute("aria-level")).toBe("2");
    act(() => row(lb).focus());
    key(row(lb), "ArrowDown");
    key(row(pay), "Enter");
    await until(() => expect(row(pay).getAttribute("aria-selected")).toBe("true"));
    expect(live()).toContain("Payments service, Rectangle, in VPC");
    // The canvas shows the same selection (its resize handles appear for it).
    expect(shell()!.querySelector(".ocbd")!.textContent).toContain("Drag to resize");
    key(row(pay), "F2");
    const inp = await vi.waitFor(() => row(pay).querySelector("input")!);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(inp, "Payments API");
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    });
    key(inp, "Enter");
    await until(() => expect(shapesOf(doc, id).find((s) => s.id === pay)!.text).toBe("Payments API"));
    // ⌥↑ moves it above the load balancer in the board order.
    key(row(pay), "ArrowUp", { altKey: true });
    await until(() => expect(shapesOf(doc, id).map((s) => s.id).indexOf(pay)).toBeLessThan(shapesOf(doc, id).map((s) => s.id).indexOf(lb)));
  });

  it("⌘K opens Commands; typing a shape name and Enter selects it", async () => {
    const { card } = await open();
    key(shell()!.querySelector(".ocbd")!, "k", { metaKey: true });
    const input = await vi.waitFor(() => document.querySelector<HTMLInputElement>('[role="dialog"][aria-label="Commands"] input')!);
    expect(document.activeElement).toBe(input);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "card");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await until(() => expect(document.querySelector('[role="option"][aria-selected="true"]')!.textContent).toContain("Card processor"));
    key(input, "Enter");
    await until(() => expect(document.querySelector('[aria-label="Commands"][role="dialog"]')).toBeNull());
    expect(live()).toContain("Card processor");
    void card;
  });

  it("C draws a connector from the keyboard: Tab, arrow for the side, Enter; ? opens the shortcuts", async () => {
    const { doc, id, pay, card } = await open();
    const cv = shell()!.querySelector<HTMLElement>(".ocbd")!;
    // Select Payments service through Commands, then press C on the canvas.
    key(cv, "k", { ctrlKey: true });
    const input = await vi.waitFor(() => document.querySelector<HTMLInputElement>('[aria-label="Commands"] input')!);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "payments");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {});
    key(input, "Enter");
    await until(() => expect(document.querySelector('[aria-label="Commands"]')).toBeNull());
    const before = shapesOf(doc, id).length;
    key(cv, "c");
    await until(() => expect(shell()!.querySelector(".ocdg-hintbar")!.textContent).toContain("Connecting from Payments service"));
    key(cv, "Tab");
    key(cv, "Tab");
    key(cv, "ArrowUp");
    expect(live()).toBe("To Card processor, top side. Press Enter to connect.");
    key(cv, "Enter");
    await until(() => expect(shapesOf(doc, id).length).toBe(before + 1));
    const a = shapesOf(doc, id).at(-1)!;
    expect([a.type, a.start?.shapeId, a.end?.shapeId, a.end?.anchor]).toEqual(["arrow", pay, card, "top"]);
    expect(shell()!.querySelector(".ocdg-hintbar")).toBeNull();

    key(cv, "?");
    await until(() => expect(document.querySelector('[role="dialog"][aria-labelledby="ocdg-ks-t"]')).toBeTruthy());
    expect(document.querySelector('[aria-labelledby="ocdg-ks-t"]')!.textContent).toContain("Start a connector");
  });
});
