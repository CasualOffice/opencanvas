// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// BRD-20 (board UX prototype, decision 7): one export dialog for PNG and SVG with a background
// (transparent / light / dark), colours when transparent, a scale for PNG and a scope (board,
// selection, frame); Copy as PNG / SVG with a Download fallback where the browser can't.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "../index";
import { addShape, getBoardMap, readShapes, type Shape } from "../model";
import { shapesToSvg } from "../export";
import { CONTAINER } from "../kinds";
import { exportScope } from "./scope";
import { copyImage } from "./clipboard";
import { readExportBg, writeExportBg } from "./prefs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (toast: (m: string) => void = () => {}): BlockEnv => ({ role: "edit", compact: false, me: { id: "p", name: "Priya", color: "#2a5ad7" }, users: [], toast });
let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  cleanup = () => act(() => root.unmount());
  return el;
}
// The dialog is a lazy chunk: wait for it (and for the render after a click) under load too.
const flush = async (until?: () => unknown) => {
  for (let i = 0; i < 6 || (until && !until() && i < 150); i++) await act(async () => void (await new Promise((r) => setTimeout(r, i < 6 ? 0 : 20))));
};

const S = (id: string, x: number, y: number, o: Partial<Shape> = {}): Shape => ({ id, type: "rect", x, y, w: 100, h: 60, text: id, ...o });

describe("export rendering", () => {
  it("light with a background stays the default (the Rust fixture's bytes)", () => {
    const list = [S("a", 0, 0)];
    expect(shapesToSvg(list, new Map(), { theme: "light", background: true })).toBe(shapesToSvg(list));
  });
  it("dark draws the dark palette; transparent has no background rect", () => {
    const list = [S("a", 0, 0, { fill: "blue" })];
    const dark = shapesToSvg(list, new Map(), { theme: "dark", background: true });
    expect(dark).toContain('fill="#141417"');
    expect(dark).toContain("#1a2746");
    expect(dark).not.toContain("#e6eefd");
    const clear = shapesToSvg(list, new Map(), { theme: "dark", background: false });
    expect(clear).not.toContain('fill="#141417"');
    expect(clear).toContain("#1a2746");
    // The module palette is restored afterwards.
    expect(shapesToSvg(list)).toContain("#e6eefd");
  });
});

describe("export scope", () => {
  const f: Shape = { id: "f", type: "rect", kind: CONTAINER, x: 0, y: 0, w: 400, h: 300, label: "Sprint" };
  const a = S("a", 20, 40, { props: { parent: "f" } });
  const b = S("b", 600, 40);
  const c: Shape = { id: "c", type: "arrow", start: { shapeId: "a", anchor: "center" }, end: { shapeId: "b", anchor: "center" }, pts: [[120, 70], [600, 70]] } as Shape;
  const all = [f, a, b, c];
  it("board is everything", () => expect(exportScope(all, "board", []).map((s) => s.id)).toEqual(["f", "a", "b", "c"]));
  it("selection takes connectors between selected shapes and a selected frame's members", () => {
    expect(exportScope(all, "selection", ["a", "b"]).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(exportScope(all, "selection", ["f"]).map((s) => s.id)).toEqual(["f", "a"]);
  });
  it("a frame is the frame and its members", () => expect(exportScope(all, "f:f", []).map((s) => s.id)).toEqual(["f", "a"]));
});

describe("clipboard", () => {
  it("says unsupported where the browser can't put an image on the clipboard", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    expect(await copyImage(new Blob(["x"], { type: "image/png" }))).toBe(false);
  });
  it("writes a ClipboardItem when it can", async () => {
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = class {
      constructor(public items: Record<string, Blob>) {}
    };
    expect(await copyImage(new Blob(["<svg/>"], { type: "image/svg+xml" }))).toBe(true);
    expect(write).toHaveBeenCalledOnce();
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  });
  it("remembers the background per person, Light by default", () => {
    expect(readExportBg()).toBe("light");
    writeExportBg("dark");
    expect(readExportBg()).toBe("dark");
  });
});

describe("export dialog", () => {
  function board() {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    addShape(doc, id, { type: "rect", x: 20, y: 20, w: 100, h: 60, text: "A", fill: "blue" });
    return { doc, id };
  }
  it("opens from the board menu; Dark + SVG downloads a dark SVG", async () => {
    const { doc, id } = board();
    const saved: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => (saved.push(b as Blob), "blob:x"));
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Board options"]')!.click());
    const item = [...el.querySelectorAll<HTMLButtonElement>(".ocbd-menu [role=menuitem]")].find((b) => b.textContent?.startsWith("Export"));
    expect(item?.textContent).toContain("Export…");
    act(() => item!.click());
    await flush(() => el.querySelector('[role="dialog"]'));
    const dlg = el.querySelector<HTMLElement>('[role="dialog"][aria-label="Export board"]')!;
    expect(dlg).toBeTruthy();
    const radio = (group: string, name: string) => [...dlg.querySelectorAll<HTMLButtonElement>(`[role=radiogroup][aria-label="${group}"] [role=radio]`)].find((b) => b.textContent === name)!;
    expect(radio("Background", "Light").getAttribute("aria-checked")).toBe("true");
    expect(radio("Scale", "2×").getAttribute("aria-checked")).toBe("true");
    act(() => radio("Background", "Dark").click());
    act(() => radio("Format", "SVG").click());
    // Scale is PNG only; Colours only when transparent.
    expect(dlg.querySelector('[aria-label="Scale"]')).toBeNull();
    expect(dlg.querySelector('[aria-label="Colours drawn for"]')).toBeNull();
    act(() => radio("Background", "None").click());
    expect(dlg.querySelector('[aria-label="Colours drawn for"]')).toBeTruthy();
    act(() => radio("Background", "Dark").click());
    const dl = [...dlg.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Download")!;
    await act(async () => dl.click());
    await flush(() => names.length);
    expect(names).toEqual(["board.svg"]);
    const before = saved.length;
    expect(before).toBeGreaterThan(0);
    const text = await saved.at(-1)!.text();
    expect(text).toContain("#141417");
    expect(readExportBg()).toBe("dark");
  });
  it("Copy says so and offers Download where images can't be copied", async () => {
    const { doc, id } = board();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Board options"]')!.click());
    act(() => [...el.querySelectorAll<HTMLButtonElement>(".ocbd-menu [role=menuitem]")].find((b) => b.textContent?.startsWith("Export"))!.click());
    await flush(() => el.querySelector('[role="dialog"]'));
    const dlg = el.querySelector<HTMLElement>('[role="dialog"]')!;
    act(() => [...dlg.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((b) => b.textContent === "SVG")!.click());
    const copy = [...dlg.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Copy SVG")!;
    await act(async () => copy.click());
    await flush(() => dlg.querySelector("[role=alert]"));
    expect(dlg.querySelector("[role=alert]")?.textContent).toMatch(/can.t copy images/i);
  });
  it("the board menu has Copy as PNG and Copy as SVG", () => {
    const { doc, id } = board();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Board options"]')!.click());
    const items = [...el.querySelectorAll(".ocbd-menu [role=menuitem]")].map((b) => b.textContent);
    expect(items).toContain("Copy as PNG⇧⌘C");
    expect(items).toContain("Copy as SVG");
  });
});

void getBoardMap;
void readShapes;
