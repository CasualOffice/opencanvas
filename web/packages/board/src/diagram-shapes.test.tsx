// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-14 S2: shape libraries as registry data, the shapes panel, search, click and drag to add.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, getBoardMap, readShapes } from "./model";
import { ALL_LIBRARIES, KIND_MIME, LIBRARIES } from "./libraries";
import { descriptorOf, LEGACY_TYPES, makeNode, registerShape, unregisterShape } from "./registry";
import { exportBoardSvg } from "./export";
import { searchShapes } from "./diagram/ShapesPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (role: "edit" | "view" = "edit"): BlockEnv => ({ role, compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} });
let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  document.body.innerHTML = "";
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
});
function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  cleanups.push(() => act(() => root.unmount()));
  return el;
}
// Each poll flushes React's pending work inside act, then checks (no fixed waits).
const until = (check: () => void) =>
  vi.waitFor(async () => {
    await act(async () => {});
    check();
  }, { timeout: 20_000 });
const btn = (root: ParentNode, name: string) => [...root.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name);
async function open(doc: Y.Doc, id: string, role: "edit" | "view" = "edit") {
  const el = mount(<BoardBlock doc={doc} boardId={id} env={env(role)} />);
  act(() => btn(el, "Diagram")!.click());
  await until(() => expect(document.querySelector(".ocdg")).toBeTruthy());
  return document.querySelector<HTMLElement>(".ocdg")!;
}
const type = (input: HTMLInputElement, v: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const all = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);

describe("shape libraries (registry data)", () => {
  it("registers Flowchart, UML and Network as declarative kinds on a legacy base type", () => {
    expect(LIBRARIES.map((l) => l.id)).toEqual(ALL_LIBRARIES.filter((l) => !l.flag).map((l) => l.id));
    expect(LIBRARIES.slice(0, 5).map((l) => l.id)).toEqual(["basic", "flowchart", "uml", "erd", "network"]);
    for (const l of LIBRARIES) {
      for (const k of l.kinds) {
        const d = descriptorOf({ type: "rect", kind: k });
        expect(d.kind).toBe(k);
        expect(d.library).toBe(l.id);
        expect(d.label).toBeTruthy();
        expect(LEGACY_TYPES).toContain(d.base);
        expect(Object.isFrozen(d)).toBe(true);
        const n = makeNode(k, {});
        expect(n.type).toBe(d.base);
        expect(n.kind).toBe(k);
      }
    }
  });

  it("a look is data only: path data, sizes, a tone name and default text", () => {
    const base = { kind: "test:look", base: "rect" as const, version: 1 };
    expect(() => registerShape({ ...base, look: { path: "M0 0<script>" } })).toThrow(/path data/);
    expect(() => registerShape({ ...base, look: { path: "M0 0H1", onclick: "x" } as never })).toThrow(/unexpected look.onclick/);
    expect(() => registerShape({ ...base, look: { tone: "url(x)" } })).toThrow(/tone/);
    expect(() => registerShape({ ...base, look: { w: -1 } })).toThrow(/size/);
    expect(() => registerShape({ ...base, keywords: [() => 1] as never })).toThrow(/keywords/);
    const d = registerShape({ ...base, look: { path: "M0 0H100V100Z", w: 10, h: 20, tone: "blue", text: "T" }, library: "test", keywords: ["k"] });
    expect(Object.isFrozen(d.look)).toBe(true);
    unregisterShape("test:look");
  });

  it("exporters and older readers draw the base type", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    addShape(doc, id, makeNode("network:database", { x: 0, y: 0, w: 120, h: 90, text: "orders-db" }));
    const svg = await exportBoardSvg(doc, id);
    expect(svg).toContain("<rect");
    expect(svg).toContain("orders-db");
  });
});

describe("search (2d, 2e)", () => {
  it("puts label matches first, then keywords, grouped in library order", () => {
    const hits = searchShapes("data");
    expect(hits[0]).toMatchObject({ kind: "network:database", at: [0, 4] });
    expect(hits.map((h) => h.kind)).toContain("flowchart:stored-data");
    expect(hits.find((h) => h.kind === "network:cache")).toMatchObject({ keyword: "data" });
    expect(searchShapes("kafka").map((h) => [h.kind, h.keyword])).toEqual([["network:queue", "kafka"]]);
    expect(searchShapes("   ")).toEqual([]);
    expect(searchShapes("zzz")).toEqual([]);
  });
});

describe("shapes panel (S2)", { timeout: 60_000 }, () => {
  it("lists the libraries with counts; a tile adds its shape in the middle of the view", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id);
    const panel = dg.querySelector<HTMLElement>('aside[aria-label="Shapes"]')!;
    expect(panel).toBeTruthy();
    const heads = [...panel.querySelectorAll(".ocdg-lh button")].map((b) => b.textContent);
    expect(heads).toEqual(LIBRARIES.map((l) => `${l.name}${l.kinds.length}`));
    expect(heads).not.toContain(expect.stringMatching(/^BPMN/));
    act(() => btn(panel, "Add Process")!.click());
    expect(all(doc, id)).toHaveLength(1);
    expect(all(doc, id)[0]).toMatchObject({ type: "rect", kind: "flowchart:process", text: "Process", w: 140, h: 70 });
    // Network opens on click and remembers it (per person).
    act(() => (panel.querySelector('[data-library="network"] .ocdg-lh button') as HTMLElement).click());
    expect(panel.querySelectorAll('[data-library="network"] .ocdg-tile')).toHaveLength(LIBRARIES.find((l) => l.id === "network")!.kinds.length);
    expect(JSON.parse(localStorage.getItem("oc-diagram-libraries-open")!)).toMatchObject({ network: true });
  });

  it("search: Enter adds the best match; no results gives one plain way out", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id);
    const input = dg.querySelector<HTMLInputElement>('input[aria-label="Search shapes"]')!;
    type(input, "kafka");
    const tile = dg.querySelector<HTMLElement>('.ocdg-tile[data-kind="network:queue"]')!;
    expect(tile.textContent).toContain("kafka");
    act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(all(doc, id)[0]).toMatchObject({ kind: "network:queue", fill: "amber", text: "Queue" });
    type(input, "zzz");
    expect(dg.querySelector(".ocdg-none")!.textContent).toContain("No shapes match “zzz”.");
    act(() => btn(dg, "Clear search")!.click());
    expect(input.value).toBe("");
    expect(dg.querySelector(".ocdg-none")).toBeNull();
  });

  it("a tile dropped on the canvas lands centred where it was dropped, on the grid", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id);
    const data = new Map<string, string>();
    const dt = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? "", types: [] as string[], effectAllowed: "", dropEffect: "" };
    const start = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.assign(start, { dataTransfer: dt });
    act(() => void dg.querySelector('.ocdg-tile[data-kind="flowchart:decision"]')!.dispatchEvent(start));
    expect(data.get(KIND_MIME)).toBe("flowchart:decision");
    dt.types = [KIND_MIME];
    // An empty board fits to the identity view (and stays there); map board points through it anyway.
    const layer = dg.querySelector("svg.ocbd-svg > g[transform]")!;
    const [, tx, ty, z] = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(layer.getAttribute("transform")!)!.map(Number);
    for (const t of ["dragover", "drop"]) {
      const e = new Event(t, { bubbles: true, cancelable: true });
      Object.assign(e, { dataTransfer: dt, clientX: 500 * z + tx, clientY: 300 * z + ty });
      act(() => void dg.querySelector(".ocbd")!.dispatchEvent(e));
    }
    // 140 × 100 centred on (500, 300) is (430, 250): on the 20 grid (440, 260).
    expect(all(doc, id)[0]).toMatchObject({ type: "diamond", kind: "flowchart:decision", x: 440, y: 260 });
  });

  it("draws a library shape with its outline", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const s = addShape(doc, id, makeNode("network:database", { x: 0, y: 0, w: 120, h: 90, text: "orders-db" }));
    const dg = await open(doc, id);
    const g = dg.querySelector(`[data-s="${s}"]`)!;
    expect(g.getAttribute("data-kind")).toBe("network:database");
    expect(g.querySelector("path")!.getAttribute("d")).toBe(descriptorOf({ type: "rect", kind: "network:database" }).look!.path);
  });

  it("view-only people get no shapes panel (10c)", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id, "view");
    expect(dg.querySelector('aside[aria-label="Shapes"]')).toBeNull();
  });
});
