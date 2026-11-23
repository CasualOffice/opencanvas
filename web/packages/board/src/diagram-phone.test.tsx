// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-14 S11: diagram mode on a phone (prototype 11a-11e), and Go to moving the view (S5).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, getBoardMap, readShapes } from "./model";
import { setBoardName } from "./diagram/mode";
import { placeNextTo } from "./diagram/phone/Phone";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (role: "edit" | "view" = "edit", compact = true): BlockEnv => ({ role, compact, me: { id: "p", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} });

let phone = true;
let cleanups: (() => void)[] = [];
beforeEach(() => {
  phone = true;
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("30em") ? phone : false, media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
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
  }, { timeout: 5_000 });
const shell = () => document.querySelector<HTMLElement>(".ocdg");
const button = (root: ParentNode, name: string) => [...root.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name);
const click = (el: Element | null | undefined) => {
  expect(el, "button").toBeTruthy();
  act(() => (el as HTMLElement).click());
};

function fixture(named = true) {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  const pay = addShape(doc, id, { type: "rect", x: 300, y: 40, w: 120, h: 60, text: "Payments service" });
  const db = addShape(doc, id, { type: "rect", x: 300, y: 240, w: 120, h: 60, text: "payments-db" });
  if (named) setBoardName(doc, id, "Service map");
  return { doc, id, pay, db };
}
const shapesOf = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);

async function openOnPhone(named = true) {
  const f = fixture(named);
  const el = mount(<BoardBlock doc={f.doc} boardId={f.id} env={env()} />);
  const cover = el.querySelector<HTMLButtonElement>(".ocbd-cover")!;
  expect(cover.textContent).toContain("Open diagram");
  click(cover);
  await until(() => expect(shell()).toBeTruthy());
  return { ...f, el };
}

describe("S11 phone", { timeout: 30_000 }, () => {
  it("11a: a diagram board's cover says Open diagram and opens it; a plain whiteboard keeps Tap to open board", async () => {
    const plain = fixture(false);
    const el = mount(<BoardBlock doc={plain.doc} boardId={plain.id} env={env()} />);
    expect(el.querySelector(".ocbd-cover")!.textContent).toContain("Tap to open board");
    cleanups.forEach((c) => c());
    cleanups = [];
    await openOnPhone();
    expect(shell()!.classList.contains("ocdg-phone")).toBe(true);
  });

  it("11b: bottom bar with Select, Pan, Add, Outline, Undo; no side panel", async () => {
    await openOnPhone();
    const bar = shell()!.querySelector('nav[aria-label="Diagram tools"]')!;
    expect([...bar.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Select", "Pan", "Add", "Outline", "Undo"]);
    click(button(bar, "Pan"));
    expect(button(bar, "Pan")!.getAttribute("aria-pressed")).toBe("true");
    click(button(bar, "Outline"));
    await until(() => expect(document.querySelector('[role="dialog"][aria-label="Outline"] [role="tree"]')).toBeTruthy());
  });

  it("11c/11d: selecting a shape shows the action bar; Add with Connect it to places and connects", async () => {
    const { doc, id, pay } = await openOnPhone();
    const bar = shell()!.querySelector('nav[aria-label="Diagram tools"]')!;
    // Select through the outline sheet.
    click(button(bar, "Outline"));
    const row = await vi.waitFor(() => document.querySelector<HTMLElement>(`[data-id="${pay}"]`)!);
    click(row);
    await until(() => expect(shell()!.querySelector('[role="toolbar"][aria-label="Payments service actions"]')).toBeTruthy());
    const acts = shell()!.querySelector('[role="toolbar"][aria-label="Payments service actions"]')!;
    expect([...acts.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Edit text", "Name and colour", "Connect", "Duplicate", "Delete"]);
    click(button(acts, "Name and colour"));
    await until(() => expect(document.querySelector('[role="dialog"][aria-label="Payments service"]')).toBeTruthy());
    click(button(document.querySelector('[role="dialog"][aria-label="Payments service"]')!, "Green"));
    await until(() => expect(shapesOf(doc, id).find((s) => s.id === pay)!.fill).toBe("green"));
    click(button(document.querySelector('[role="dialog"][aria-label="Payments service"]')!, "Close"));

    const before = shapesOf(doc, id).length;
    click(button(bar, "Add"));
    const add = await vi.waitFor(() => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Add a shape"]')!);
    expect(add.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
    expect(add.querySelector('[role="switch"]')!.textContent).toContain("Connect it to Payments service");
    click(button(add, "Process"));
    await until(() => expect(shapesOf(doc, id).length).toBe(before + 2));
    const all = shapesOf(doc, id);
    const made = all.find((s) => s.type === "rect" && s.text === "Process")!;
    const link = all.find((s) => s.type === "arrow")!;
    expect([link.start?.shapeId, link.end?.shapeId]).toEqual([pay, made.id]);
    expect(made.x).toBeGreaterThan(420);
  });

  it("11e: the options sheet lists what needs a larger screen, disabled, with a reason", async () => {
    await openOnPhone();
    click(button(shell()!.querySelector(".ocdg-top")!, "Board options"));
    const sh = await vi.waitFor(() => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Diagram"]')!);
    const items = [...sh.querySelectorAll("button")].map((b) => [b.textContent?.trim(), b.disabled]);
    expect(items).toContainEqual(["Export as PNG", false]);
    expect(items).toContainEqual(["Auto-layoutLarger screen", true]);
    expect(sh.textContent).toContain("Big diagrams are easier on a computer");
  });

  it("placeNextTo steps right past shapes already there", () => {
    const { doc, id, pay } = fixture();
    addShape(doc, id, { type: "rect", x: 500, y: 40, w: 150, h: 60, text: "busy" });
    const s = shapesOf(doc, id);
    const at = placeNextTo(s.find((x) => x.id === pay)!, 150, 64, s);
    expect(at.x).toBeGreaterThanOrEqual(650);
  });
});

describe("S5 Go to moves the view", { timeout: 30_000 }, () => {
  it("Go to from Commands centres the shape (zoom unchanged)", async () => {
    phone = false;
    const f = fixture();
    const far = addShape(f.doc, f.id, { type: "rect", x: 4000, y: 3000, w: 100, h: 50, text: "Faraway" });
    const el = mount(<BoardBlock doc={f.doc} boardId={f.id} env={env("edit", false)} />);
    click(button(el, "Diagram"));
    await until(() => expect(shell()).toBeTruthy());
    const g = () => shell()!.querySelector("svg.ocbd-svg > g[transform]")!.getAttribute("transform")!;
    const before = g();
    const cv = shell()!.querySelector(".ocbd")!;
    act(() => void cv.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true })));
    const input = await vi.waitFor(() => document.querySelector<HTMLInputElement>('[aria-label="Commands"] input')!);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "faraway");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {});
    act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    await until(() => expect(g()).not.toBe(before));
    const m = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/.exec(g())!;
    const z = +m[3];
    // Centre of the shape (4050, 3025) maps to the middle of the canvas (jsdom: 0 × 0 → 0, 0).
    expect(+m[1] + 4050 * z).toBeCloseTo(0, 0);
    expect(+m[2] + 3025 * z).toBeCloseTo(0, 0);
    void far;
  });
});
