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

function selectAllOn(top: number, panX = 0) {
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
  // A sideways swipe pans the board, taking the shape towards one edge.
  if (panX) act(() => void svg.dispatchEvent(new WheelEvent("wheel", { deltaX: panX, bubbles: true, cancelable: true })));
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

  // The bar's width depends on the shape (sticky colours, connector tools) and the text size; a
  // guessed half width let it run off the canvas edge in diagram mode (UX-DGM-01).
  describe("is measured and kept inside the canvas", () => {
    const W = 440;
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
    afterEach(() => Object.defineProperty(HTMLElement.prototype, "offsetWidth", desc));
    const wide = () =>
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return (this as Element).classList.contains("ocbd-swatch") ? W : 0; } });
    it("at the left edge", () => {
      wide();
      const bar = selectAllOn(200, 560);
      expect(parseFloat(bar.style.left) - W / 2).toBeGreaterThanOrEqual(8);
    });
    it("at the right edge", () => {
      wide();
      const bar = selectAllOn(200, -560);
      expect(parseFloat(bar.style.left) + W / 2).toBeLessThanOrEqual(1100 - 8);
    });
  });
});

// On a 390 px phone the nine tools do not fit: the last one (Text) was cut off at the right with
// no sign that the bar scrolls, and the buttons were 40 px (UX-DGM-01).
describe("phone tool bar", { timeout: 30_000 }, () => {
  const sw = Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth")!;
  const cw = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
  afterEach(() => {
    Object.defineProperty(Element.prototype, "scrollWidth", sw);
    Object.defineProperty(Element.prototype, "clientWidth", cw);
  });
  it("tools are 44 px and do not shrink", async () => {
    const { CSS: BOARD_CSS } = await import("./styles");
    expect(BOARD_CSS).toMatch(/\.ocbd-compact \.ocbd-tool \.ocbd-ib\{[^}]*width:2\.75rem;height:2\.75rem/);
    expect(BOARD_CSS).toMatch(/\.ocbd-tool>\*,\.ocbd-tool \.ocbd-ib\{[^}]*flex:none/);
  });
  it("says which side has more tools, and keeps the chosen tool in view", () => {
    Object.defineProperty(Element.prototype, "scrollWidth", { configurable: true, get() { return (this as Element).classList.contains("ocbd-tool") ? 420 : 0; } });
    Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get() { return (this as Element).classList.contains("ocbd-tool") ? 366 : 0; } });
    const into = vi.fn();
    (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView = into;
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const el = mount(<BoardBlock doc={doc} boardId={id} env={{ ...env(), compact: true }} />);
    const bar = el.querySelector<HTMLElement>('[aria-label="Board tools"]')!;
    expect(bar.dataset.more).toBe("right");
    bar.scrollLeft = 54;
    act(() => void bar.dispatchEvent(new Event("scroll")));
    expect(bar.dataset.more).toBe("left");
    bar.scrollLeft = 20;
    act(() => void bar.dispatchEvent(new Event("scroll")));
    expect(bar.dataset.more).toBe("both");
    act(() => bar.querySelector<HTMLButtonElement>('[aria-label="Text"]')!.click());
    expect(into.mock.contexts.at(-1)).toBe(bar.querySelector('[aria-label="Text"]'));
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
});
