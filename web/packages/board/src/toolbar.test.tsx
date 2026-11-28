// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// SCALE-02 / UX4-01: the board tool bar, option A (docs/prototypes/v04-approved/board-toolbar.html).
// One row, tools left in priority order and the zoom pill right; tools overflow from the end into
// "More", measured on the board's own width; the zoom pill shrinks last; one Tab stop per group.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { fitTools, fitRail, TOOLS_LEFT_KEY } from "./toolbar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const env = (compact = false, role: "edit" | "view" = "edit"): BlockEnv => ({ role, compact, me: { id: "p", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} });

let cleanups: (() => void)[] = [];
const cw = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
const ch = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!;
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  document.body.innerHTML = "";
  Object.defineProperty(Element.prototype, "clientWidth", cw);
  Object.defineProperty(Element.prototype, "clientHeight", ch);
  try {
    localStorage.removeItem(TOOLS_LEFT_KEY);
  } catch {
    /* no storage */
  }
});
/** The board (`.ocbd`) is `w` × `h` CSS px; the root font is jsdom's 16 px. */
function boardSize(w: number, h = 440) {
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get() { return (this as Element).classList.contains("ocbd") ? w : 0; } });
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get() { return (this as Element).classList.contains("ocbd") ? h : 0; } });
}
function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  cleanups.push(() => act(() => root.unmount()));
  return el;
}
function board(compact = false, role: "edit" | "view" = "edit") {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  return mount(<BoardBlock doc={doc} boardId={id} env={env(compact, role)} />);
}
const key = (el: Element, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));
const tools = (el: Element) => [...el.querySelectorAll<HTMLButtonElement>(".ocbd-tool [data-tool]")].map((b) => b.getAttribute("aria-label"));
const more = (el: Element) => el.querySelector<HTMLButtonElement>('.ocbd-tool [aria-haspopup="menu"]')!;

describe("fitTools: what stays at each board width (3a), centred (BRD-32)", () => {
  it("a wide board centres all ten tools and the lock, the pill reserved on both sides", () => {
    expect(fitTools(68.75, 10, false, 1)).toEqual({ shown: 10, zoomFull: true, centred: true }); // 1100 px
    expect(fitTools(68.75, 10, false, 1, 1)).toEqual({ shown: 10, zoomFull: true, centred: true }); // with Frames
  });
  it("the pill's width is reserved on both sides: tools leave from the end before the pill shrinks", () => {
    const r = fitTools(40, 10, false, 1);
    expect(r).toMatchObject({ zoomFull: true, centred: true });
    expect(r.shown).toBeGreaterThanOrEqual(3);
    expect(r.shown).toBeLessThan(10);
  });
  it("320 px compact: Select, Sticky note and Pen, More and the 100% button, from the left edge", () => {
    expect(fitTools(20, 9, true, 1)).toEqual({ shown: 3, zoomFull: false, centred: false });
  });
  it("never fewer than three tools, and an unmeasured board shows everything", () => {
    expect(fitTools(10, 9, true).shown).toBe(3);
    expect(fitTools(0, 9, false)).toEqual({ shown: 9, zoomFull: true, centred: true });
  });
  it("the rail fits by the board's height", () => {
    expect(fitRail(27.5, 9, false)).toBe(9);
    expect(fitRail(18.75, 9, true)).toBeLessThan(9);
  });
});

describe("board tool bar, option A", () => {
  it("is in the priority order, Pan last", () => {
    boardSize(1100);
    const el = board();
    expect(tools(el)).toEqual(["Select", "Sticky note", "Pen", "Text", "Rectangle", "Arrow", "Ellipse", "Diamond", "Frame", "Pan"]);
    expect(more(el)).toBeTruthy();
    // Tools and zoom sit in one row.
    expect(el.querySelector(".ocbd-dock .ocbd-tool")).toBeTruthy();
    expect(el.querySelector(".ocbd-dock .ocbd-zoom")).toBeTruthy();
  });

  it("overflows from the end into More on a narrow board; More holds the rest as radio items", () => {
    boardSize(320);
    const el = board(true);
    expect(tools(el)).toEqual(["Select", "Sticky note", "Pen"]);
    // The pill is one 100% button that opens zoom in, out, fit and minimap.
    const zb = el.querySelector<HTMLButtonElement>('.ocbd-zoom [aria-haspopup="menu"]')!;
    expect(zb.textContent).toBe("100%");
    act(() => zb.click());
    const zm = el.querySelector('[role="menu"][aria-label="Zoom"]')!;
    expect([...zm.querySelectorAll('[role^="menuitem"]')].map((b) => b.textContent)).toEqual(["Zoom in", "Zoom out", "Zoom to fit", "Minimap"]);
    act(() => more(el).click());
    const m = el.querySelector('[role="menu"][aria-label="More tools"]')!;
    const items = [...m.querySelectorAll('[role="menuitemradio"]')].map((b) => b.getAttribute("aria-label"));
    expect(items).toEqual(["Text", "Rectangle", "Arrow", "Ellipse", "Diamond", "Frame", "Pan"]);
    expect(m.querySelector('[role="menuitemcheckbox"]')!.textContent).toContain("Tools on the left");
  });

  it("a tool picked from More shows on More, pressed", () => {
    boardSize(320);
    const el = board(true);
    act(() => more(el).click());
    act(() => el.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-label="Arrow"]')!.click());
    expect(el.querySelector('[role="menu"][aria-label="More tools"]')).toBeNull();
    expect(more(el).getAttribute("aria-pressed")).toBe("true");
    expect(more(el).getAttribute("aria-label")).toBe("More tools, Arrow selected");
  });

  it("one Tab stop in the tool bar, arrows, Home and End inside; Enter on More opens the menu and Esc returns", () => {
    boardSize(400);
    const el = board();
    const bar = el.querySelector<HTMLElement>(".ocbd-tool")!;
    const stops = () => [...bar.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.tabIndex === 0);
    expect(stops()).toHaveLength(1);
    expect(stops()[0].getAttribute("aria-label")).toBe("Select");
    stops()[0].focus();
    key(document.activeElement!, "ArrowRight");
    expect(document.activeElement!.getAttribute("aria-label")).toBe("Sticky note");
    expect(stops()).toEqual([document.activeElement]);
    // End reaches the tool lock (BRD-19), the last button in the bar; More is just before it.
    key(document.activeElement!, "End");
    expect(document.activeElement!.getAttribute("aria-label")).toBe("Keep tool active");
    key(document.activeElement!, "ArrowLeft");
    expect(document.activeElement).toBe(more(el));
    key(document.activeElement!, "Home");
    expect(document.activeElement!.getAttribute("aria-label")).toBe("Select");
    key(document.activeElement!, "End");
    key(document.activeElement!, "ArrowLeft");
    key(document.activeElement!, "Enter");
    const m = el.querySelector('[role="menu"][aria-label="More tools"]')!;
    expect(document.activeElement).toBe(m.querySelector('[role^="menuitem"]'));
    key(document.activeElement!, "Escape");
    expect(el.querySelector('[role="menu"][aria-label="More tools"]')).toBeNull();
    expect(document.activeElement).toBe(more(el));
  });

  it("the zoom pill is one Tab stop with arrows inside", () => {
    boardSize(1100);
    const el = board();
    const z = [...el.querySelectorAll<HTMLButtonElement>(".ocbd-zoom button")];
    expect(z.filter((b) => b.tabIndex === 0)).toHaveLength(1);
  });

  it("'Tools on the left' is a personal setting, off by default, kept per device", () => {
    boardSize(1100);
    const el = board();
    expect(el.querySelector(".ocbd")!.hasAttribute("data-rail")).toBe(false);
    act(() => more(el).click());
    const cb = el.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
    expect(cb.getAttribute("aria-checked")).toBe("false");
    act(() => cb.click());
    expect(el.querySelector(".ocbd")!.hasAttribute("data-rail")).toBe(true);
    expect(el.querySelector(".ocbd-tool")!.getAttribute("aria-orientation")).toBe("vertical");
    expect(localStorage.getItem(TOOLS_LEFT_KEY)).toBe("1");
    const again = board();
    expect(again.querySelector(".ocbd")!.hasAttribute("data-rail")).toBe(true);
  });

  it("viewers get Select and Pan", () => {
    boardSize(1100);
    expect(tools(board(false, "view"))).toEqual(["Select", "Pan"]);
  });
});
