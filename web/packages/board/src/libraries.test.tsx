// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-14.7: the shape libraries as registry data. Every kind is valid data with a parseable
// outline, sizes, keywords and a label box; every library renders; the exporters draw the base
// type (shared fixture with the Rust renderer); search finds shapes by synonym; BPMN stays behind
// its flag; container kinds behave as containers.
interface Fs { readFileSync(p: string, enc: "utf8"): string; writeFileSync(p: string, s: string): void }
const { readFileSync, writeFileSync } = (await import(/* @vite-ignore */ ["node", "fs"].join(":"))) as Fs;
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, type Shape } from "./model";
import { ALL_LIBRARIES, CONNECTOR_PRESETS, FLAGGED_LIBRARIES, LIBRARIES, setLibraryEnabled } from "./libraries";
import { descriptorOf, LEGACY_TYPES, makeNode, registerShape } from "./registry";
import { exportBoardSvg, shapesToSvg } from "./export";
import { searchShapes } from "./diagram/ShapesPanel";
import { isContainer } from "./kinds";
import { wrapText } from "./ops";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const proc = (globalThis as { process?: { cwd(): string; env: Record<string, string | undefined> } }).process;
// jsdom rewrites import.meta.url, so the fixtures are found from the package directory.
const FIX = proc!.cwd().replace(/\/web\/packages\/board$/, "") + "/crates/oc-model/tests/fixtures/";
const UPDATE = proc?.env.OC_UPDATE_FIXTURE;

const kindsOf = (id: string) => ALL_LIBRARIES.find((l) => l.id === id)!.items.map((i) => `${id}:${i.name}`);
const ALL_KINDS = ALL_LIBRARIES.flatMap((l) => kindsOf(l.id));
const desc = (k: string) => descriptorOf({ type: "rect", kind: k });

/** Arguments each path command takes (SVG 1.1). */
const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
/** Parses path data strictly: every command has whole groups of numbers, arcs have 0/1 flags. */
function parsePath(d: string): { cmds: number; nums: number[] } {
  const toks = d.match(/[A-Za-z]|-?\d*\.?\d+/g) ?? [];
  expect(toks.join("").length).toBe(d.replace(/[\s,]/g, "").length);
  let i = 0, cmds = 0;
  const nums: number[] = [];
  expect(toks[0]).toMatch(/^[Mm]$/);
  while (i < toks.length) {
    const c = toks[i++]!;
    expect(c).toMatch(/^[MLHVCSQTAZmlhvcsqtaz]$/);
    cmds++;
    const k = ARGS[c.toUpperCase()]!;
    const group: number[] = [];
    while (i < toks.length && !/[A-Za-z]/.test(toks[i]!)) group.push(Number(toks[i++]));
    if (k === 0) expect(group).toEqual([]);
    else {
      expect(group.length).toBeGreaterThan(0);
      expect(group.length % k).toBe(0);
      if (c.toUpperCase() === "A") for (let j = 0; j < group.length; j += 7) { expect([0, 1]).toContain(group[j + 3]); expect([0, 1]).toContain(group[j + 4]); }
    }
    group.forEach((v) => expect(Number.isFinite(v)).toBe(true));
    nums.push(...group);
  }
  return { cmds, nums };
}

describe("library registry data (DGM-14.7)", () => {
  it("has the libraries and counts the docs list (more than 350 kinds)", () => {
    const counts = Object.fromEntries(ALL_LIBRARIES.map((l) => [l.id, l.items.length]));
    expect(Object.keys(counts)).toEqual(["basic", "flowchart", "uml", "erd", "network", "bpmn", "mindmap", "org", "wireframe", "mockup", "arrows", "signs", "floorplan", "electrical", "rack", "charts"]);
    expect(ALL_KINDS.length).toBeGreaterThanOrEqual(350);
    expect(counts.basic).toBeGreaterThanOrEqual(35);
    expect(counts.flowchart).toBeGreaterThanOrEqual(28);
    expect(counts.uml).toBeGreaterThanOrEqual(25);
    expect(counts.network).toBeGreaterThanOrEqual(30);
    expect(counts.arrows).toBeGreaterThanOrEqual(40);
    expect(counts.signs).toBeGreaterThanOrEqual(30);
  });

  it("every kind is registered, unique and plain data on a legacy box base", () => {
    expect(new Set(ALL_KINDS).size).toBe(ALL_KINDS.length);
    expect(new Set(ALL_LIBRARIES.map((l) => l.id)).size).toBe(ALL_LIBRARIES.length);
    for (const k of ALL_KINDS) {
      const d = desc(k);
      expect(d.kind, k).toBe(k);
      expect(d.missing, k).toBeUndefined();
      expect(LEGACY_TYPES).toContain(d.base);
      expect(d.label, k).toBeTruthy();
      expect(d.library).toBe(k.split(":")[0]);
      expect(JSON.parse(JSON.stringify(d))).toEqual(d); // data only
      const n = makeNode(k, {});
      expect(n).toMatchObject({ type: d.base, kind: k, kindVersion: 1 });
    }
  });

  it("every outline is strict path data inside the 100 × 100 box, at least one command group", () => {
    for (const k of ALL_KINDS) {
      const p = desc(k).look?.path;
      if (!p) continue;
      expect(p, k).toMatch(/^[MLHVCSQTAZmlhvcsqtaz0-9 ,.\-]{1,2000}$/);
      const { nums } = parsePath(p);
      for (const v of nums) expect(Math.abs(v), `${k}: ${v}`).toBeLessThanOrEqual(110);
    }
  });

  it("sizes, keywords, tones and label boxes are sensible", () => {
    const TONES = ["gray", "blue", "green", "amber", "red", "purple", "pink"];
    for (const k of ALL_KINDS) {
      const d = desc(k);
      const w = d.look?.w ?? 140, h = d.look?.h ?? 70;
      expect(w, k).toBeGreaterThanOrEqual(10);
      expect(h, k).toBeGreaterThanOrEqual(10);
      expect(Math.max(w, h), k).toBeLessThanOrEqual(640);
      expect(d.keywords?.length ?? 0, k).toBeGreaterThanOrEqual(2);
      for (const kw of d.keywords!) expect(kw, k).toBe(kw.toLowerCase());
      if (d.look?.tone) expect(TONES, k).toContain(d.look.tone);
      const b = d.look?.box;
      if (b) {
        expect(b[0] + b[2], k).toBeLessThanOrEqual(100);
        expect(b[1] + b[3], k).toBeLessThanOrEqual(100);
      }
    }
  });

  it("the default text fits its label box at the default size and text size", () => {
    for (const k of ALL_KINDS) {
      const d = desc(k);
      const text = d.look?.text ?? d.label ?? "";
      if (!text) continue;
      const w = d.look?.w ?? 140, h = d.look?.h ?? 70;
      const [, , bw, bh] = d.look?.box ?? [0, 0, 100, 100];
      const size = 14, lh = Math.round(size * 1.3);
      // The canvas wraps to the box width (less padding), so only height can overflow.
      const lines = wrapText(text, Math.max(20, (w * bw) / 100 - 12), size);
      const longest = Math.max(...text.split("\n").map((l) => l.length));
      expect(lines.length * lh - (lh - size), `${k}: "${text}" in ${(h * bh) / 100}px`).toBeLessThanOrEqual((h * bh) / 100 + 4);
      expect(longest * size * 0.56, `${k}: "${text}" wider than the shape`).toBeLessThanOrEqual(Math.max(w, 200));
    }
  });

  it("rejects a label box outside the 100 × 100 box and a non-boolean container", () => {
    const base = { kind: "test:box", base: "rect" as const, version: 1 };
    expect(() => registerShape({ ...base, look: { box: [50, 0, 60, 10] } })).toThrow(/inside/);
    expect(() => registerShape({ ...base, look: { box: [0, 0, 10] as never } })).toThrow(/box/);
    expect(() => registerShape({ ...base, container: "yes" as never })).toThrow(/container/);
  });

  it("connector presets are data with ends, attached to their libraries", () => {
    expect(Object.keys(CONNECTOR_PRESETS).sort()).toEqual(["bpmn", "erd", "mindmap", "org"]);
    expect(CONNECTOR_PRESETS.erd!.map((p) => p.id)).toEqual(expect.arrayContaining(["one-to-many", "many-to-many", "zero-or-one", "chen"]));
    for (const list of Object.values(CONNECTOR_PRESETS)) for (const p of list) expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});

describe("panel list, flag and containers", () => {
  afterEach(() => setLibraryEnabled("bpmn", false));
  it("BPMN is off by default; its kinds still draw; the flag lists it", () => {
    expect(FLAGGED_LIBRARIES).toEqual(["bpmn"]);
    expect(LIBRARIES.map((l) => l.id)).not.toContain("bpmn");
    expect(desc("bpmn:task").missing).toBeUndefined();
    expect(searchShapes("gateway").some((h) => h.library === "bpmn")).toBe(false);
    setLibraryEnabled("bpmn", true);
    expect(LIBRARIES.map((l) => l.id)).toContain("bpmn");
    expect(searchShapes("exclusive gateway")[0]).toMatchObject({ kind: "bpmn:exclusive" });
    setLibraryEnabled("bpmn", false);
    expect(LIBRARIES.map((l) => l.id)).not.toContain("bpmn");
    setLibraryEnabled("basic", false); // not flagged: no effect
    expect(LIBRARIES.map((l) => l.id)).toContain("basic");
  });

  it("pool, lane, swimlane, frames, system boundary, browser window, room and cabinet are containers", () => {
    for (const k of ["bpmn:pool", "bpmn:lane", "uml:swimlane", "uml:frame", "uml:system-boundary", "wireframe:browser", "floorplan:room", "rack:cabinet", "org:department"]) {
      expect(isContainer({ type: "rect", kind: k }), k).toBe(true);
    }
    expect(isContainer({ type: "rect", kind: "flowchart:process" })).toBe(false);
    expect(isContainer({ type: "rect" })).toBe(false);
  });
});

describe("search by synonym", () => {
  const kinds = (q: string) => searchShapes(q).map((h) => h.kind);
  it.each([
    ["db", "network:database"], ["if", "flowchart:decision"], ["condition", "flowchart:decision"], ["start", "flowchart:terminator"],
    ["end", "flowchart:terminator"], ["person", "uml:actor"], ["person", "network:user"], ["enum", "uml:enumeration"], ["pk", "erd:key-attribute"],
    ["kubernetes", "network:pod"], ["wifi", "network:access-point"], ["tick", "signs:check"], ["couch", "floorplan:sofa"], ["xor", "electrical:xor"],
    ["kvm", "rack:console"], ["histogram", "charts:column"], ["speech", "basic:callout"], ["dropdown", "wireframe:dropdown"], ["snackbar", "mockup:toast"],
    ["u turn", "arrows:u-turn"], ["root", "mindmap:central"], ["employee", "org:person"],
  ])("“%s” finds %s", (q, k) => {
    expect(kinds(q)).toContain(k);
  });
});

/* ---- rendering ---- */

const env: BlockEnv = { role: "edit", compact: false, me: { id: "p", name: "P", color: "#2a5ad7" }, users: [], toast: () => {} };
let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  document.body.innerHTML = "";
});

describe("render smoke per library", { timeout: 60_000 }, () => {
  it.each(ALL_LIBRARIES.map((l) => [l.id]))("%s: every kind draws its outline and default text", async (lib) => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const ids = new Map<string, string>();
    let x = 0;
    for (const k of kindsOf(lib)) {
      const d = desc(k);
      const w = d.look?.w ?? 140, h = d.look?.h ?? 70;
      ids.set(k, addShape(doc, id, makeNode(k, { x, y: 0, w, h, text: d.look?.text || d.label || "" })));
      x += w + 20;
    }
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    act(() => root.render(<BoardBlock doc={doc} boardId={id} env={env} />));
    cleanups.push(() => act(() => root.unmount()));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(el.querySelectorAll("[data-s]").length).toBeGreaterThanOrEqual(ids.size);
    });
    for (const [k, sid] of ids) {
      const g = el.querySelector(`[data-s="${sid}"]`)!;
      expect(g, k).toBeTruthy();
      const d = desc(k);
      if (d.look?.path) {
        expect(g.getAttribute("data-kind"), k).toBe(k);
        expect(g.querySelector("path")!.getAttribute("d"), k).toBe(d.look.path);
      }
      const text = d.look?.text || d.label || "";
      if (text) expect(g.textContent!.replace(/\s/g, ""), k).toBe(text.replace(/\s/g, ""));
    }
  });
});

it("text sits in the kind's label box (class name in the top compartment)", async () => {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  const sid = addShape(doc, id, makeNode("uml:class", { x: 0, y: 0, w: 180, h: 120, text: "Order" }));
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(<BoardBlock doc={doc} boardId={id} env={env} />));
  cleanups.push(() => act(() => root.unmount()));
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(el.querySelector(`[data-s="${sid}"] text`)).toBeTruthy();
  });
  const t = el.querySelector(`[data-s="${sid}"] text`)!;
  // Box [0, 0, 100, 30] of 120 high: centre 18, baseline 18 + 14 * 0.36.
  expect(Number(t.getAttribute("y"))).toBeCloseTo(18 + 14 * 0.36, 1);
  expect(Number(t.getAttribute("x"))).toBe(90);
});

/* ---- exporter fallback (ADR-045 §5), shared with crates/oc-model/tests/diagram.rs ---- */

function sampleBoard() {
  const shapes: Record<string, Record<string, unknown>> = {};
  const order: string[] = [];
  let y = 0;
  for (const l of ALL_LIBRARIES) {
    let x = 0;
    for (const it of [l.items[0]!, l.items[Math.floor(l.items.length / 2)]!]) {
      const k = `${l.id}:${it.name}`, d = desc(k), id = k.replace(":", "-");
      const w = d.look?.w ?? 140, h = d.look?.h ?? 70;
      shapes[id] = { ...makeNode(k, { x, y, w, h, text: d.look?.text || d.label || "" }), ...(d.look?.tone ? { fill: d.look.tone } : {}) };
      order.push(id);
      x += Math.min(w, 400) + 40;
    }
    y += 200;
  }
  return { order, shapes };
}
function docOf(board: { order: string[]; shapes: Record<string, Record<string, unknown>> }) {
  const doc = new Y.Doc();
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    doc.getMap("boards").set("b1", m);
    const shapes = new Y.Map<Y.Map<unknown>>();
    for (const [id, s] of Object.entries(board.shapes)) {
      const y = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(s)) y.set(k, v);
      shapes.set(id, y);
    }
    m.set("shapes", shapes);
    const order = new Y.Array<string>();
    order.push(board.order);
    m.set("order", order);
  });
  return doc;
}

describe("exporters draw library kinds as their base type plus text", () => {
  it("matches the shared fixture the Rust renderer is checked against", () => {
    const board = sampleBoard();
    const json = JSON.stringify(board, null, 1) + "\n";
    const svg = exportBoardSvg(docOf(board), "b1").replace(/ocbd-x-clip-\d+/g, "ocbd-x-clip-1");
    if (UPDATE) {
      writeFileSync(FIX + "board-libraries.json", json);
      writeFileSync(FIX + "board-libraries.web.svg", svg);
    }
    expect(json).toBe(readFileSync(FIX + "board-libraries.json", "utf8"));
    expect(svg).toBe(readFileSync(FIX + "board-libraries.web.svg", "utf8"));
  });

  it("a kind exports exactly as its base type, with its text", () => {
    const board = sampleBoard();
    const plain = { order: board.order, shapes: Object.fromEntries(Object.entries(board.shapes).map(([id, s]) => {
      const { kind: _k, kindVersion: _v, ports: _p, ...rest } = s;
      return [id, rest];
    })) };
    const strip = (s: string) => s.replace(/ocbd-x-clip-\d+/g, "c");
    expect(strip(exportBoardSvg(docOf(board), "b1"))).toBe(strip(exportBoardSvg(docOf(plain), "b1")));
    const svg = shapesToSvg([{ id: "a", ...(board.shapes["flowchart-process"] as Omit<Shape, "id">) } as Shape]);
    expect(svg).toContain(">Process</text>");
  });
});
