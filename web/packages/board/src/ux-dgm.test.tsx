// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// UX-DGM-01: issues found using the board and the diagram window as a person would (audit 2026-11-24).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const env = (): BlockEnv => ({ role: "edit", compact: false, me: { id: "p", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} });

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
  }, { timeout: 30_000 });
const shell = () => document.querySelector<HTMLElement>(".ocdg");

function board() {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  addShape(doc, id, { type: "rect", x: 20, y: 40, w: 120, h: 60, text: "Load balancer" });
  addShape(doc, id, { type: "rect", x: 300, y: 40, w: 120, h: 60, text: "Payments service" });
  return { doc, id };
}
async function openDiagram() {
  const f = board();
  const el = mount(<BoardBlock doc={f.doc} boardId={f.id} env={env()} />);
  act(() => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Diagram")!.click());
  await until(() => expect(shell()).toBeTruthy());
  return f;
}

describe("diagram window", { timeout: 120_000 }, () => {
  // Must run first: the styles are injected once per page.
  it("the Commands button in the top bar is styled from the start, not only after ⌘K was used once", async () => {
    await openDiagram();
    expect(shell()!.querySelector(".ocdg-cmdk")).toBeTruthy();
    const css = [...document.head.querySelectorAll("style")].map((s) => s.textContent).join("\n");
    expect(css).toContain(".ocdg-cmdk{");
  });

  it("closing Commands with Esc gives focus back to the canvas, so Esc and shortcuts keep working", async () => {
    await openDiagram();
    const cv = shell()!.querySelector<HTMLElement>(".ocbd")!;
    act(() => cv.focus());
    key(cv, "k", { ctrlKey: true });
    const input = await vi.waitFor(() => document.querySelector<HTMLInputElement>('[aria-label="Commands"] input')!);
    expect(document.activeElement).toBe(input);
    key(input, "Escape");
    await until(() => expect(document.querySelector('[aria-label="Commands"]')).toBeNull());
    expect(document.activeElement).toBe(cv);
  });

  it("closing the shortcuts sheet gives focus back to where it was", async () => {
    await openDiagram();
    const cv = shell()!.querySelector<HTMLElement>(".ocbd")!;
    act(() => cv.focus());
    key(cv, "?");
    const close = await vi.waitFor(() => document.querySelector<HTMLButtonElement>('[aria-labelledby="ocdg-ks-t"] button[aria-label="Close"]')!);
    expect(document.activeElement).toBe(close);
    act(() => close.click());
    await until(() => expect(document.querySelector('[aria-labelledby="ocdg-ks-t"]')).toBeNull());
    expect(document.activeElement).toBe(cv);
  });
});

function selectAllOn(top: number) {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  addShape(doc, id, { type: "rect", x: 300, y: top, w: 160, h: 80, text: "Shape" });
  const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
  const svg = el.querySelector<SVGSVGElement>("svg.ocbd-svg")!;
  Object.defineProperty(svg, "clientWidth", { value: 1100, configurable: true });
  Object.defineProperty(svg, "clientHeight", { value: 440, configurable: true });
  const root = el.querySelector<HTMLElement>(".ocbd")!;
  act(() => root.focus());
  key(root, "a", { ctrlKey: true });
  return el.querySelector<HTMLElement>(".ocbd-swatch")!;
}

describe("selection toolbar", { timeout: 30_000 }, () => {
  it("a shape near the top of a board gets its toolbar below it, not over the board's own buttons and the shape", () => {
    const bar = selectAllOn(10);
    // The shape spans y 10..90 at zoom 1; the bar starts under it.
    expect(parseFloat(bar.style.top)).toBeGreaterThanOrEqual(90);
    expect(bar.dataset.place).toBe("below");
  });

  it("a shape with room above keeps its toolbar above it", () => {
    const bar = selectAllOn(200);
    expect(parseFloat(bar.style.top)).toBe(186);
    expect(bar.dataset.place).toBeUndefined();
  });
});
