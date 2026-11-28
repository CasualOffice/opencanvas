// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// BRD-17 (D11): the diagram header at narrow widths, decision 8 of
// docs/prototypes/board-ux-approved/board-ux.html. Measured on the diagram window: under 64 em
// Commands loses its label; under 48 em the document crumb and the Back label go and Outline and
// Auto-layout move into ⋯; under 36 em Commands and Redo do too. The title keeps 8 rem.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape } from "./model";
import { foldedNames, headerFold } from "./diagram/headerFold";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (): BlockEnv => ({ role: "edit", compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} });

describe("the fold steps (decision 8)", () => {
  it("by the diagram window's width in em", () => {
    expect(headerFold(80)).toBe("wide");
    expect(headerFold(64)).toBe("wide");
    expect(headerFold(56)).toBe("mid");
    expect(headerFold(40)).toBe("narrow");
    expect(headerFold(31.25)).toBe("tiny");
    // Not measured yet (or no layout): everything shows.
    expect(headerFold(0)).toBe("wide");
  });
  it("what ⋯ holds at each step", () => {
    expect(foldedNames("wide")).toEqual([]);
    expect(foldedNames("mid")).toEqual([]);
    expect(foldedNames("narrow")).toEqual(["Outline", "Auto-layout"]);
    expect(foldedNames("tiny")).toEqual(["Commands", "Outline", "Auto-layout", "Redo"]);
  });
});

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  document.body.innerHTML = "";
  // The override shadows jsdom's own (on Element.prototype).
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});
/** The diagram window `px` wide (16 px = 1 em in jsdom). */
function windowWidth(px: number) {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return (this as Element).classList.contains("ocdg") ? px : 0; } });
}
async function openDiagram(px: number) {
  windowWidth(px);
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  addShape(doc, id, { type: "rect", x: 20, y: 20, w: 100, h: 60, text: "Gateway" });
  getBoardName(doc, id);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(<BoardBlock doc={doc} boardId={id} env={env()} />));
  cleanups.push(() => act(() => root.unmount()));
  act(() => void el.querySelector(".ocbd")!.dispatchEvent(new KeyboardEvent("keydown", { key: "D", shiftKey: true, bubbles: true, cancelable: true })));
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(document.querySelector(".ocdg-top")).toBeTruthy();
  }, { timeout: 20_000 });
  await act(async () => {});
  return document.querySelector<HTMLElement>(".ocdg-top")!;
}
function getBoardName(doc: Y.Doc, id: string) {
  doc.getMap("boards").get(id) instanceof Y.Map && (doc.getMap("boards").get(id) as Y.Map<unknown>).set("name", "Checkout flow");
}
const named = (root: ParentNode, name: string) => [...root.querySelectorAll<HTMLElement>("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name);

describe("the diagram header (BRD-17)", { timeout: 60_000 }, () => {
  it("at 500 px: Back is an icon, board name only, Commands, Outline, Auto-layout and Redo in ⋯", async () => {
    const top = await openDiagram(500);
    expect(top.getAttribute("data-fold")).toBe("tiny");
    const back = top.querySelector<HTMLElement>(".ocdg-back")!;
    expect(back.getAttribute("aria-label")).toBe("Back to document");
    expect(back.textContent?.trim()).toBe("");
    expect(top.querySelector(".ocdg-doc")).toBeNull();
    expect(top.querySelector(".ocdg-crumb")!.getAttribute("title")).toMatch(/Checkout flow/);
    expect(top.querySelector(".ocdg-cmdk")).toBeNull();
    expect(named(top, "Outline")).toBeUndefined();
    expect(named(top, "Redo")).toBeUndefined();
    expect(named(top, "Undo")).toBeDefined();
    expect(top.querySelector<HTMLElement>(".ocdg-lb")!.hidden).toBe(true);
    // ⋯ holds them, at the top of the board options.
    await act(async () => named(top, "Board options")!.click());
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Board options"]')!;
    const items = [...menu.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent?.replace(/\s+/g, " ").trim());
    expect(items.slice(0, 4)).toEqual([expect.stringMatching(/^Commands/), expect.stringMatching(/^Outline/), expect.stringMatching(/^Auto-layout/), expect.stringMatching(/^Redo/)]);
    await act(async () => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((b) => b.textContent?.startsWith("Auto-layout"))!.click());
    expect(document.querySelector('[role="dialog"][aria-label="Auto-layout"]')).not.toBeNull();
  });

  it("at 1280 px everything shows: Commands with ⌘K, Outline, the document crumb, Redo", async () => {
    const top = await openDiagram(1280);
    expect(top.getAttribute("data-fold")).toBe("wide");
    expect(top.querySelector(".ocdg-cmdk")?.textContent).toMatch(/Commands/);
    expect(named(top, "Outline")).toBeDefined();
    expect(named(top, "Redo")).toBeDefined();
    expect(top.querySelector<HTMLElement>(".ocdg-lb")!.hidden).toBe(false);
  });

  it("at 896 px Commands is an icon; at 640 px Outline and Auto-layout fold but Commands and Redo stay", async () => {
    let top = await openDiagram(896);
    expect(top.getAttribute("data-fold")).toBe("mid");
    expect(named(top, "Commands")).toBeDefined();
    expect(top.querySelector(".ocdg-cmdk .ocdg-kbd")).toBeNull();
    cleanups.forEach((c) => c());
    cleanups = [];
    document.body.innerHTML = "";
    top = await openDiagram(640);
    expect(top.getAttribute("data-fold")).toBe("narrow");
    expect(named(top, "Commands")).toBeDefined();
    expect(named(top, "Redo")).toBeDefined();
    expect(named(top, "Outline")).toBeUndefined();
  });
});
