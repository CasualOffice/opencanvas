// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-14 S2: the shapes panel (libraries, chooser, lazy libraries, search, recent, rail, tabs,
// BPMN flag, connector presets) and the registry's declarative `look`. The library content lives
// in libraries.ts and is owned separately, so these tests bring their own test libraries.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, getBoardMap, readShapes } from "./model";
import { KIND_MIME, LIBRARIES } from "./libraries";
import { panelLibraries, presetOf, registerLibrary } from "./panel";
import { descriptorOf, LEGACY_TYPES, makeNode, registerShape, unregisterShape } from "./registry";
import { exportBoardSvg } from "./export";
import { searchIndex, searchShapes } from "./diagram/ShapesPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ---- test libraries: placed first, so they are open by default ---- */
const Z = ["tz:alpha", "tz:beta", "tz:gamma", "tz:diamond"];
registerShape({ kind: "tz:alpha", base: "rect", version: 1, label: "Zeta store", keywords: ["zetakw"], look: { path: "M0 12C0 -4 100 -4 100 12V88C100 104 0 104 0 88Z", w: 120, h: 90, tone: "green" } });
registerShape({ kind: "tz:beta", base: "rect", version: 1, label: "Big zeta", look: { w: 150, h: 70, tone: "amber", text: "Beta text" } });
registerShape({ kind: "tz:gamma", base: "rect", version: 1, label: "Gamma", keywords: ["zeta-ish"] });
registerShape({ kind: "tz:diamond", base: "diamond", version: 1, label: "Choice", look: { w: 140, h: 100 } });
registerLibrary({ id: "tz", name: "Test shapes", icon: "boxes", kinds: Z }, LIBRARIES[0]?.id);
registerLibrary({ id: "tflag", name: "Flagged", icon: "git-fork", kinds: ["tz:gamma"], flag: "bpmn", beta: true });

const env = (role: "edit" | "view" = "edit", extra: Partial<BlockEnv> = {}): BlockEnv => ({ role, compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {}, ...extra });
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
async function open(doc: Y.Doc, id: string, e: BlockEnv = env()) {
  const el = mount(<BoardBlock doc={doc} boardId={id} env={e} />);
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
const panelOf = (dg: HTMLElement) => dg.querySelector<HTMLElement>('aside[aria-label="Shapes"]')!;
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o })));

describe("registry looks and library content", () => {
  it("every library kind is declarative, on a legacy base type", () => {
    for (const l of LIBRARIES) {
      for (const k of l.kinds) {
        const d = descriptorOf({ type: "rect", kind: k });
        expect(d.kind).toBe(k);
        expect(LEGACY_TYPES).toContain(d.base);
        expect(Object.isFrozen(d)).toBe(true);
        expect(makeNode(k, {})).toMatchObject({ type: d.base, kind: k });
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
    addShape(doc, id, makeNode("tz:alpha", { x: 0, y: 0, w: 120, h: 90, text: "orders-db" }));
    const svg = await exportBoardSvg(doc, id);
    expect(svg).toContain("<rect");
    expect(svg).toContain("orders-db");
  });
});

describe("panel model", () => {
  it("presets join the libraries they belong to; BPMN is flagged and Beta; a library can be placed (the Icons slot)", () => {
    const libs = panelLibraries();
    expect(libs[0].id).toBe("tz");
    const uml = libs.find((l) => l.id === "uml");
    if (uml) expect(uml.connectors).toEqual(["uml-inheritance", "uml-realization", "uml-association", "uml-aggregation", "uml-composition", "uml-dependency"]);
    const bpmn = libs.find((l) => l.id === "bpmn");
    if (bpmn) expect(bpmn).toMatchObject({ flag: "bpmn", beta: true });
    expect(presetOf("preset:uml-composition")).toMatchObject({ props: { startArrow: "diamond-filled", endArrow: "none" } });
    expect(presetOf("erd-one-many")).toMatchObject({ fields: { route: "elbow" }, props: { startCard: "one", endCard: "many" } });
    expect(() => registerLibrary({ id: "tz", name: "x", icon: "x", kinds: [] })).toThrow(/already/);
  });

  it("search: label start, then anywhere in the label, then keywords; over a prebuilt index", () => {
    const index = searchIndex([{ id: "tz", name: "Test shapes", icon: "boxes", kinds: Z }]);
    expect(index.map((e) => e.label)).toEqual(["zeta store", "big zeta", "gamma", "choice"]);
    const hits = searchShapes("Zeta", index);
    expect(hits.map((h) => [h.kind, h.at ?? h.keyword])).toEqual([["tz:alpha", [0, 4]], ["tz:beta", [4, 8]], ["tz:gamma", "zeta-ish"]]);
    expect(searchShapes("   ", index)).toEqual([]);
    expect(searchShapes("zzqq", index)).toEqual([]);
  });

  it("searches 200 tiles", () => {
    const kinds = Array.from({ length: 200 }, (_, i) => {
      const kind = `tmany:s${i}`;
      registerShape({ kind, base: "rect", version: 1, label: `Shape ${i}`, keywords: [`kw${i % 10}`] });
      return kind;
    });
    const index = searchIndex([{ id: "tmany", name: "Many", icon: "boxes", kinds }]);
    expect(index).toHaveLength(200);
    expect(searchShapes("shape 19", index).map((h) => h.kind)).toEqual(["tmany:s19", ...Array.from({ length: 10 }, (_, i) => `tmany:s${190 + i}`)]);
    expect(searchShapes("kw3", index)).toHaveLength(20);
    kinds.forEach((k) => unregisterShape(k));
  });
});

describe("shapes panel (S2)", { timeout: 60_000 }, () => {
  it("lists the libraries with counts, the first open; a tile adds its shape in the middle of the view", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id);
    const panel = panelOf(dg);
    // In this document (DGM-17 part 3) has its own header with Manage; the libraries follow it.
    const heads = [...panel.querySelectorAll('.ocdg-lib[data-library]:not([data-library="doc-icons"]) .ocdg-lh button')].map((b) => b.textContent);
    const expected = panelLibraries()
      .filter((l) => !l.flag)
      .map((l) => `${l.name}${l.kinds.length + (l.connectors?.length ?? 0) || l.count}`);
    // The Icons library and All icons (Lucide, DGM-17) sit above the shape libraries.
    expect(heads).toEqual(["Icons59", "All iconsLucide", ...expected]);
    expect(panel.querySelectorAll('[data-library="tz"] .ocdg-tile')).toHaveLength(4);
    act(() => btn(panel, "Add Big zeta")!.click());
    expect(all(doc, id)[0]).toMatchObject({ type: "rect", kind: "tz:beta", text: "Beta text", fill: "amber", w: 150, h: 70 });
    // Folding a library is remembered per person.
    act(() => (panel.querySelector('[data-library="tz"] .ocdg-lh button') as HTMLElement).click());
    expect(panel.querySelectorAll('[data-library="tz"] .ocdg-tile')).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem("oc-diagram-libraries-open")!)).toMatchObject({ tz: false });
  });

  it("search: Enter adds the best match; no results gives one plain way out", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id);
    const input = dg.querySelector<HTMLInputElement>('input[aria-label="Search shapes"]')!;
    type(input, "zetakw");
    expect(dg.querySelector<HTMLElement>('.ocdg-tile[data-kind="tz:alpha"]')!.textContent).toContain("zetakw");
    key(input, "Enter");
    expect(all(doc, id)[0]).toMatchObject({ kind: "tz:alpha", fill: "green", text: "Zeta store" });
    type(input, "zzqq");
    expect(dg.querySelector(".ocdg-none")!.textContent).toContain("No shapes match “zzqq”.");
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
    act(() => void dg.querySelector('.ocdg-tile[data-kind="tz:diamond"]')!.dispatchEvent(start));
    expect(data.get(KIND_MIME)).toBe("tz:diamond");
    dt.types = [KIND_MIME];
    // An empty board fits to the identity view; map board points through it anyway.
    const layer = dg.querySelector("svg.ocbd-svg > g[transform]")!;
    const [, tx, ty, z] = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(layer.getAttribute("transform")!)!.map(Number);
    for (const t of ["dragover", "drop"]) {
      const e = new Event(t, { bubbles: true, cancelable: true });
      Object.assign(e, { dataTransfer: dt, clientX: 500 * z + tx, clientY: 300 * z + ty });
      act(() => void dg.querySelector(".ocbd")!.dispatchEvent(e));
    }
    // 140 × 100 centred on (500, 300) is (430, 250): on the 20 grid (440, 260).
    expect(all(doc, id)[0]).toMatchObject({ type: "diamond", kind: "tz:diamond", x: 440, y: 260 });
  });

  it("draws a library shape with its outline", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const s = addShape(doc, id, makeNode("tz:alpha", { x: 0, y: 0, w: 120, h: 90, text: "orders-db" }));
    const dg = await open(doc, id);
    const g = dg.querySelector(`[data-s="${s}"]`)!;
    expect(g.getAttribute("data-kind")).toBe("tz:alpha");
    expect(g.querySelector("path")!.getAttribute("d")).toBe(descriptorOf({ type: "rect", kind: "tz:alpha" }).look!.path);
  });

  it("view-only people get no shapes panel (10c)", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id, env("view"));
    expect(dg.querySelector('aside[aria-label="Shapes"]')).toBeNull();
  });

  it("Recent keeps your last six, newest first, from any library (2a)", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id);
    expect(panelOf(dg).querySelector('[data-library="recent"]')).toBeNull();
    for (const name of ["Add Zeta store", "Add Big zeta", "Add Gamma", "Add Zeta store"]) act(() => btn(panelOf(dg).querySelector('[data-library="tz"]')!, name)!.click());
    const recent = () => [...panelOf(dg).querySelectorAll('[data-library="recent"] .ocdg-tile')].map((t) => t.getAttribute("data-kind"));
    expect(recent()).toEqual(["tz:alpha", "tz:gamma", "tz:beta"]);
    expect(JSON.parse(localStorage.getItem("oc-diagram-recent")!)).toEqual(["tz:alpha", "tz:gamma", "tz:beta"]);
  });

  it("the Libraries chooser shows or hides libraries per person", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id);
    const panel = panelOf(dg);
    const shown = () => [...panel.querySelectorAll(".ocdg-lib[data-library]")].map((s) => s.getAttribute("data-library")).filter((x) => x !== "recent");
    expect(shown()).toContain("tz");
    act(() => btn(panel, `Libraries${panelLibraries().filter((l) => !l.flag).length} on`)!.click());
    const chooser = panel.querySelector('[role="dialog"][aria-label="Libraries"]')!;
    const box = [...chooser.querySelectorAll("label")].find((l) => l.textContent === "Test shapes")!.querySelector("input")!;
    expect(box.checked).toBe(true);
    act(() => box.click());
    expect(shown()).not.toContain("tz");
    expect(JSON.parse(localStorage.getItem("oc-diagram-libraries-hidden")!)).toEqual(["tz"]);
    // Hidden libraries are not searched either.
    type(panel.querySelector<HTMLInputElement>('input[aria-label="Search shapes"]')!, "zetakw");
    expect(panel.querySelector(".ocdg-none")).toBeTruthy();
    type(panel.querySelector<HTMLInputElement>('input[aria-label="Search shapes"]')!, "");
    act(() => (panel.querySelector('[role="dialog"][aria-label="Libraries"] label input') as HTMLInputElement | null)?.closest("label") && box.click());
    expect(shown()).toContain("tz");
  });

  it("a library in its own chunk shows its count, and loads when opened", async () => {
    // Registered here, so no earlier search has loaded it.
    let loads = 0;
    registerLibrary({
      id: "tlazy",
      name: "Lazy shapes",
      icon: "shapes",
      kinds: [],
      count: 2,
      load: async () => {
        loads++;
        for (const n of ["one", "two"]) registerShape({ kind: `tlazy:${n}`, base: "rect", version: 1, label: `Lazy ${n}` });
        return ["tlazy:one", "tlazy:two"];
      },
    });
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id);
    const head = () => panelOf(dg).querySelector('[data-library="tlazy"] .ocdg-lh button') as HTMLElement;
    expect(head().textContent).toBe("Lazy shapes2");
    expect(loads).toBe(0);
    act(() => head().click());
    await until(() => expect(panelOf(dg).querySelectorAll('[data-library="tlazy"] .ocdg-tile')).toHaveLength(2));
    expect(loads).toBe(1);
    act(() => btn(panelOf(dg), "Add Lazy two")!.click());
    expect(all(doc, id)[0]).toMatchObject({ kind: "tlazy:two" });
  });

  it("BPMN shows with the host flag, marked Beta with an explanation (2f)", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const off = await open(doc, id);
    expect(off.querySelector('[data-library="tflag"]')).toBeNull();
    cleanups.forEach((c) => c());
    cleanups = [];
    document.body.innerHTML = "";
    const dg = await open(doc, id, env("edit", { diagram: { bpmn: true } }));
    const lib = dg.querySelector('[data-library="tflag"]')!;
    expect(lib.querySelector(".ocdg-lh button")!.textContent).toBe("Flagged1");
    const beta = lib.querySelector<HTMLElement>(".ocdg-beta")!;
    expect(beta.tabIndex).toBe(0);
    expect(document.getElementById(beta.getAttribute("aria-describedby")!)!.textContent).toMatch(/may still change/);
  });

  it("a connector preset with two shapes selected connects them in that style; otherwise it arms the connector tool", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const a = addShape(doc, id, { type: "rect", x: 0, y: 0, w: 100, h: 60, text: "Order" });
    const b = addShape(doc, id, { type: "rect", x: 300, y: 0, w: 100, h: 60, text: "LineItem" });
    const dg = await open(doc, id);
    const board = dg.querySelector<HTMLElement>(".ocbd")!;
    // Presets are tiles too; search reaches them.
    const input = dg.querySelector<HTMLInputElement>('input[aria-label="Search shapes"]')!;
    type(input, "composition");
    key(board, "a", { ctrlKey: true });
    act(() => btn(dg, "Connector: Composition")!.click());
    const c = all(doc, id).find((s) => s.type === "arrow")!;
    expect(c).toMatchObject({ start: { shapeId: a }, end: { shapeId: b }, props: { startArrow: "diamond-filled", endArrow: "none" } });
    const path = dg.querySelector(`[data-s="${c.id}"] path:nth-of-type(2)`)!;
    expect(path.getAttribute("marker-start")).toMatch(/-diamond-filled\)$/);
    expect(path.getAttribute("marker-end")).toBeNull();
    // Nothing selected: the tool is armed with the preset.
    key(board, "Escape");
    type(input, "dependency");
    act(() => btn(dg, "Connector: Dependency")!.click());
    expect(dg.querySelector('[aria-label="Arrow"][aria-pressed="true"]')).toBeTruthy();
  });

  it("ERD cardinality draws crow's feet; dashed connectors draw dashed", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const e = addShape(doc, id, { type: "arrow", pts: [[0, 0], [200, 0]], dashed: true, props: { startCard: "one", endCard: "zero-many" } });
    const dg = await open(doc, id);
    const path = dg.querySelector(`[data-s="${e}"] path:nth-of-type(2)`)!;
    expect(path.getAttribute("marker-start")).toMatch(/-one\)$/);
    expect(path.getAttribute("marker-end")).toMatch(/-zero-many\)$/);
    expect(path.getAttribute("stroke-dasharray")).toBe("6 5");
  });

  it("the panel folds to a rail; a library opens as a flyout that closes on add or Esc (2h)", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id);
    act(() => btn(dg, "Collapse shapes panel")!.click());
    const rail = dg.querySelector<HTMLElement>("aside.ocdg-rail")!;
    const names = [...rail.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(names.slice(0, 4)).toEqual(["Expand shapes panel", "Search shapes", "Recent", "Test shapes"]);
    expect(names.at(-1)).toBe("Outline");
    expect(JSON.parse(localStorage.getItem("oc-diagram-rail")!)).toBe(true);
    act(() => btn(rail, "Test shapes")!.click());
    const fly = () => dg.querySelector('[role="dialog"][aria-label="Test shapes"]');
    expect(fly()).toBeTruthy();
    act(() => btn(fly()!, "Add Gamma")!.click());
    expect(fly()).toBeNull();
    expect(all(doc, id)[0]).toMatchObject({ kind: "tz:gamma" });
    // Nothing selected, so an Esc that reached diagram mode would leave it.
    key(dg.querySelector(".ocbd")!, "Escape");
    act(() => btn(rail, "Test shapes")!.click());
    key(fly()!.querySelector(".ocdg-tile")!, "Escape");
    expect(fly()).toBeNull();
    expect(document.querySelector(".ocdg")).toBeTruthy(); // Esc closed the flyout, not diagram mode
    act(() => btn(rail, "Expand shapes panel")!.click());
    expect(dg.querySelector("aside.ocdg-rail")).toBeNull();
  });

  it("Shapes and Outline are tabs (arrow keys switch); view-only people get the outline only", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    addShape(doc, id, { type: "rect", x: 0, y: 0, w: 100, h: 60, text: "A" });
    const dg = await open(doc, id);
    const tabs = () => [...dg.querySelectorAll('[role="tab"]')].map((t) => `${t.textContent}:${t.getAttribute("aria-selected")}`);
    expect(tabs()).toEqual(["Shapes:true", "Outline:false"]);
    key(dg.querySelector('[role="tablist"]')!, "ArrowRight");
    expect(tabs()).toEqual(["Shapes:false", "Outline:true"]);
    expect(dg.querySelector('aside[aria-label="Outline"] [role="tree"]')).toBeTruthy();
    act(() => (dg.querySelector('[role="tab"]') as HTMLElement).click());
    expect(dg.querySelector('aside[aria-label="Shapes"] input[aria-label="Search shapes"]')).toBeTruthy();
  });
});
