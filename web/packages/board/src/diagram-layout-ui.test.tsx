// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-14.6 auto-layout UI (approved frames 6a-6c): button and Shift+L, options, preview overlay that
// re-runs on edits, Apply as one step with an Undo toast, Esc cancels without writing.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, getBoardMap, readShapes, updateShape, type Shape } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toasts: { m: string; action?: { label: string; run: () => void } }[] = [];
const env: BlockEnv = { role: "edit", compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: (m, action) => void toasts.push({ m, action }) };

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  toasts.length = 0;
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
const until = (check: () => void) =>
  vi.waitFor(async () => {
    await act(async () => {});
    check();
  }, { timeout: 10_000 });
const btn = (root: ParentNode, name: string) => [...root.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name) as HTMLElement | undefined;
const shell = () => document.querySelector<HTMLElement>(".ocdg")!;
const pop = () => shell().querySelector('[role="dialog"][aria-label="Auto-layout"]')!;
const key = (k: string, o: KeyboardEventInit = {}) => act(() => void (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o })));
const preview = () => document.querySelector('[data-testid="layout-preview"]');
const bar = () => shell().querySelector('[aria-label="Layout preview"]');

function fixture() {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  const a = addShape(doc, id, { type: "rect", x: 400, y: 300, w: 120, h: 60, text: "Gateway" });
  const b = addShape(doc, id, { type: "rect", x: 20, y: 20, w: 120, h: 60, text: "Orders" });
  const c = addShape(doc, id, { type: "rect", x: 700, y: 10, w: 120, h: 60, text: "Database" });
  const arrow = (s: string, e: string) => addShape(doc, id, { type: "arrow", pts: [[0, 0], [1, 1]], start: { shapeId: s, anchor: "center" }, end: { shapeId: e, anchor: "center" } } as Omit<Shape, "id">);
  arrow(a, b);
  arrow(b, c);
  return { doc, id, a, b, c };
}
const shapes = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);

async function openPreview(doc: Y.Doc, id: string) {
  const el = mount(<BoardBlock doc={doc} boardId={id} env={env} />);
  act(() => btn(el, "Diagram")!.click());
  await until(() => expect(document.querySelector(".ocdg")).toBeTruthy());
  act(() => btn(shell(), "Auto-layout")!.click());
  await until(() => expect(btn(pop(), "Preview")!.hasAttribute("disabled")).toBe(false));
  act(() => btn(pop(), "Preview")!.click());
  await until(() => expect(preview()).toBeTruthy());
}

describe("auto-layout UI (DGM-14.6)", { timeout: 30_000 }, () => {
  it("Shift+L opens the options with the approved defaults", async () => {
    const { doc, id } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env} />);
    act(() => btn(el, "Diagram")!.click());
    await until(() => expect(document.querySelector(".ocdg")).toBeTruthy());
    const al = btn(shell(), "Auto-layout")!;
    expect(al.getAttribute("aria-keyshortcuts")).toBe("Shift+L");
    key("L", { shiftKey: true });
    await until(() => expect(pop()).toBeTruthy());
    // 6a defaults: Down, Normal, whole diagram, containers kept, bends off.
    const checked = [...pop().querySelectorAll('[aria-checked="true"]')].map((b) => b.textContent?.trim());
    expect(checked).toEqual(["Down", "Normal", "Keep shapes in their containers"]);
    expect(pop().querySelector<HTMLInputElement>('input[type="radio"]:checked')!.parentElement!.textContent).toContain("The whole diagram");
    expect(pop().textContent).toContain("Off: connectors are routed again");
    expect(pop().textContent).toContain("Select two or more first");
  });

  it("Preview draws current and proposed boxes and writes nothing; Esc cancels and stays in diagram mode", async () => {
    const { doc, id } = fixture();
    const before = Y.encodeStateAsUpdate(doc);
    await openPreview(doc, id);
    expect(document.querySelectorAll("[data-to]").length).toBe(3);
    expect(bar()!.textContent).toContain("3 shapes move.");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    key("Escape");
    await until(() => expect(preview()).toBeNull());
    expect(document.querySelector(".ocdg")).toBeTruthy();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("re-runs the preview when someone edits, and says so", async () => {
    const { doc, id, c } = fixture();
    await openPreview(doc, id);
    const w0 = document.querySelector(`[data-to="${c}"]`)!.getAttribute("width");
    // A remote edit: Database gets wider.
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    updateShape(remote, id, c, { w: 300 });
    act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc))));
    await until(() => expect(bar()!.textContent).toContain("The preview was updated."));
    expect(document.querySelector(`[data-to="${c}"]`)!.getAttribute("width")).not.toBe(w0);
  });

  it("Apply writes every position as one step; the toast's Undo puts them all back", async () => {
    const { doc, id } = fixture();
    const pos = () => shapes(doc, id).filter((s) => s.type === "rect").map((s) => [s.id, s.x, s.y]);
    const before = pos();
    await openPreview(doc, id);
    act(() => btn(shell(), "Apply")!.click());
    await until(() => expect(preview()).toBeNull());
    expect(pos()).not.toEqual(before);
    const t = toasts.find((x) => x.m.startsWith("Layout applied"))!;
    expect(t.m).toBe("Layout applied to 3 shapes. Undo puts them all back.");
    expect(t.action?.label).toBe("Undo");
    act(() => t.action!.run());
    expect(pos()).toEqual(before);
  });
});
