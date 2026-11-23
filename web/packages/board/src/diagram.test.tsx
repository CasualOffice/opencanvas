// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-14 S1: entering and leaving diagram mode (approved prototype 1a-1f).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, getBoardMap } from "./model";
import { boardName, clipFor, headingAbove, setBoardName } from "./diagram/mode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toasts: string[] = [];
const env = (role: "edit" | "view" = "edit"): BlockEnv => ({ role, compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: (m) => void toasts.push(m) });

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  toasts.length = 0;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
function mount(node: React.ReactNode, into: HTMLElement = document.body) {
  const el = document.createElement("div");
  into.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  cleanups.push(() => act(() => root.unmount()));
  return el;
}
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o })));
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
    // The diagram chunk loads lazily: give the dynamic import a moment the first time.
    for (let i = 0; i < 50 && (el as HTMLElement).textContent?.trim() === "Diagram" && !document.querySelector(".ocdg"); i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 0));
  });
};
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const shell = () => document.querySelector<HTMLElement>(".ocdg");
const btn = (root: ParentNode, name: string) => [...root.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name);

function fixture() {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  const a = addShape(doc, id, { type: "rect", x: 20, y: 20, w: 100, h: 60, text: "Gateway" });
  return { doc, id, a };
}

describe("diagram mode: entering and leaving (S1)", () => {
  it("the block's top cluster has a labelled Diagram button between Redo and Options", () => {
    const { doc, id } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const top = el.querySelector(".ocbd-top")!;
    const names = [...top.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());
    expect(names).toEqual(["Undo", "Redo", "Diagram", "Board options", "Full screen"]);
    expect(btn(top, "Diagram")!.getAttribute("aria-keyshortcuts")).toBe("Shift+D");
  });

  it("opens full screen from the button, and Back to document returns focus to it with a toast", async () => {
    const { doc, id } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const before = Y.encodeStateAsUpdate(doc);
    await click(btn(el, "Diagram"));
    expect(shell()).toBeTruthy();
    expect(shell()!.getAttribute("role")).toBe("dialog");
    // The board itself moved into the diagram window; the document keeps a placeholder.
    expect(shell()!.querySelector(".ocbd svg.ocbd-svg")).toBeTruthy();
    expect(el.querySelector(".ocbd-ph")).toBeTruthy();
    expect(document.activeElement?.closest(".ocdg")).toBeTruthy();
    await click(btn(shell()!, "Back to document"));
    expect(shell()).toBeNull();
    expect(document.activeElement).toBe(btn(el, "Diagram"));
    expect(toasts).toEqual(["Back in the document"]);
    // Nothing about the mode was written to the document.
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("opens from the options menu and with Shift+D", async () => {
    const { doc, id } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    await click(btn(el, "Board options"));
    const item = [...el.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent?.includes("Open as diagram"));
    expect(item?.textContent).toContain("⇧D");
    await click(item);
    expect(shell()).toBeTruthy();
    await click(btn(shell()!, "Back to document"));
    key(el.querySelector(".ocbd")!, "D", { shiftKey: true });
    await settle();
    expect(shell()).toBeTruthy();
  });

  it("Esc deselects first, then leaves diagram mode (5d)", async () => {
    const { doc, id } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    await click(btn(el, "Diagram"));
    const board = shell()!.querySelector<HTMLElement>(".ocbd")!;
    key(board, "Tab"); // selects the first shape
    key(board, "Escape");
    expect(shell()).toBeTruthy();
    key(board, "Escape");
    await settle();
    expect(shell()).toBeNull();
    // Esc from the top bar leaves too.
    await click(btn(el, "Diagram"));
    key(btn(shell()!, "Back to document")!, "Escape");
    await settle();
    expect(shell()).toBeNull();
  });

  it("is per person: another view of the same board keeps the ordinary whiteboard", async () => {
    const { doc, id } = fixture();
    const mine = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const lea = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    await click(btn(mine, "Diagram"));
    expect(document.querySelectorAll(".ocdg")).toHaveLength(1);
    expect(lea.querySelector(".ocbd .ocbd-tool")).toBeTruthy();
    expect(lea.querySelector(".ocbd-ph")).toBeNull();
    expect(btn(lea, "Diagram")).toBeTruthy();
  });

  it("view-only people can open it too, without Undo and Redo", async () => {
    const { doc, id } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env("view")} />);
    await click(btn(el, "Diagram"));
    expect(btn(shell()!.querySelector("header")!, "Undo")).toBeUndefined();
    expect(btn(shell()!.querySelector("header")!, "Back to document")).toBeTruthy();
  });

  it("names the board after the heading above it until it gets its own name (1d)", async () => {
    const { doc, id } = fixture();
    const page = document.createElement("div");
    page.setAttribute("contenteditable", "true");
    page.innerHTML = "<h1>Checkout platform</h1><p>Intro</p><h2>Service map</h2>";
    document.body.appendChild(page);
    mount(<BoardBlock doc={doc} boardId={id} env={env()} />, page);
    await click(btn(page, "Diagram"));
    expect(shell()!.querySelector(".ocdg-crumb")!.textContent).toBe("Checkout platform/Service map");
    expect(shell()!.getAttribute("aria-label")).toBe("Diagram: Service map");
    const input = shell()!.querySelector<HTMLInputElement>(".ocdg-right input")!;
    expect(input.placeholder).toBe("Service map");
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "Payments flow");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(getBoardMap(doc, id)!.get("name")).toBe("Payments flow");
    expect(shell()!.querySelector(".ocdg-name")!.textContent).toBe("Payments flow");
  });

  it("animates from the block's rectangle, and not at all with reduced motion (1c)", async () => {
    const { doc, id } = fixture();
    const calls: Keyframe[][] = [];
    (HTMLElement.prototype as { animate?: unknown }).animate = function (k: Keyframe[]) {
      calls.push(k);
      const a = { cancel() {}, onfinish: null as null | (() => void) };
      setTimeout(() => a.onfinish?.(), 0);
      return a;
    };
    try {
      const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
      await click(btn(el, "Diagram"));
      expect(calls[0]?.[0]).toHaveProperty("clipPath");
      calls.length = 0;
      await click(btn(shell()!, "Back to document"));
      await settle();
      expect(calls[0]?.[1]).toHaveProperty("clipPath");
      expect(shell()).toBeNull();

      calls.length = 0;
      vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
      await click(btn(el, "Diagram"));
      expect(shell()).toBeTruthy();
      await click(btn(shell()!, "Back to document"));
      expect(shell()).toBeNull();
      expect(calls).toHaveLength(0);
    } finally {
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
      vi.unstubAllGlobals();
    }
  });
});

describe("diagram mode helpers", () => {
  it("board names: one key, blank removes it", () => {
    const { doc, id } = fixture();
    setBoardName(doc, id, "  Service   map ");
    expect(boardName(doc, id)).toBe("Service map");
    setBoardName(doc, id, " ");
    expect(getBoardMap(doc, id)!.has("name")).toBe(false);
  });
  it("finds the heading above an element", () => {
    document.body.innerHTML = '<div contenteditable="true"><h2>A</h2><p>x</p><div><div id="b"></div></div></div>';
    expect(headingAbove(document.getElementById("b"))).toBe("A");
  });
  it("clips to a rectangle", () => {
    expect(clipFor({ left: 10, top: 20, right: 110, bottom: 220 }, 1000, 800)).toBe("inset(20px 890px 580px 10px round 12px)");
  });
});
