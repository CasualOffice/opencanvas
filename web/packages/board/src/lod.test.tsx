// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-19: level of detail when zoomed out. At 100 % and above the board draws exactly what it
// drew without LOD (render identity); below `LOD.z` a big board draws a few grouped paths with
// no text, selection still works by position, and text comes back on zoom-in.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock } from "./index";
import { LOD, lodGroups } from "./lod";
import { getBoardMap, readShapes, type Shape } from "./model";
import { SceneIndex } from "./scene";
import { makeFixture } from "../bench/fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env: BlockEnv = { role: "edit", compact: false, me: { id: "u", name: "U", color: "#2a5ad7" }, users: [], toast: () => {} };
const LOD0 = { ...LOD };

beforeEach(() => {
  Object.defineProperty(SVGElement.prototype, "clientWidth", { configurable: true, get() { return (this as Element).classList.contains("ocbd-svg") ? 900 : 0; } });
  Object.defineProperty(SVGElement.prototype, "clientHeight", { configurable: true, get() { return (this as Element).classList.contains("ocbd-svg") ? 700 : 0; } });
});
afterEach(() => {
  Object.assign(LOD, LOD0);
  delete (SVGElement.prototype as { clientWidth?: number }).clientWidth;
  delete (SVGElement.prototype as { clientHeight?: number }).clientHeight;
  document.body.innerHTML = "";
});

async function mount(doc: Y.Doc, boardId: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<BoardBlock doc={doc} boardId={boardId} env={env} />));
  await act(async () => void (await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))));
  return { host, root };
}

const svgOf = (h: HTMLElement) => h.querySelector("svg.ocbd-svg")!;
const markup = (h: HTMLElement) => svgOf(h).outerHTML.replace(/ocbd-(ah|dots)-[^"#)\s]+/g, "ocbd-$1-X");
const zoomOf = (h: HTMLElement) => Number(/scale\(([-\d.e]+)\)/.exec(svgOf(h).querySelector(":scope > g[transform]")!.getAttribute("transform")!)![1]);
const wheel = (h: HTMLElement, deltaY: number) => act(async () => void svgOf(h).dispatchEvent(new WheelEvent("wheel", { deltaY, ctrlKey: true, clientX: 450, clientY: 350, bubbles: true, cancelable: true })));
const fit = (h: HTMLElement) => act(async () => void h.querySelector(".ocbd")!.dispatchEvent(new KeyboardEvent("keydown", { key: "!", code: "Digit1", shiftKey: true, bubbles: true, cancelable: true })));
/** Ctrl+wheel to zoom `z` (the board zooms by exp(-deltaY × 0.0025)). */
const zoomTo = async (h: HTMLElement, z: number) => {
  await wheel(h, -Math.log(z / zoomOf(h)) / 0.0025);
  expect(zoomOf(h)).toBeCloseTo(z, 3);
};

describe("level of detail (DGM-19)", { timeout: 240_000 }, () => {
  it("draws exactly the same at 100 % and above as without LOD", async () => {
    const fx = makeFixture({ nodes: 1200, seed: 7 });
    for (const z of [1, 1.5, 2]) {
      const on = await mount(fx.doc, fx.boardId);
      await fit(on.host);
      await zoomTo(on.host, z);
      const a = markup(on.host);
      Object.assign(LOD, { z: 0 });
      const off = await mount(fx.doc, fx.boardId);
      await fit(off.host);
      await zoomTo(off.host, z);
      const b = markup(off.host);
      Object.assign(LOD, LOD0);
      expect(a).toContain("<text");
      expect(on.host.querySelector("[data-lod]")).toBeNull();
      expect(a).toBe(b);
      await act(async () => {
        on.root.unmount();
        off.root.unmount();
      });
    }
  });

  it("zoomed out: grouped paths, no text or per-shape views; text comes back on zoom-in", async () => {
    const fx = makeFixture({ nodes: 1200, seed: 7 });
    const live = await mount(fx.doc, fx.boardId);
    await fit(live.host);
    expect(zoomOf(live.host)).toBeLessThan(LOD.z);
    const svg = svgOf(live.host);
    expect(svg.querySelectorAll("g[data-s]").length).toBe(0);
    expect(svg.querySelectorAll("text").length).toBe(0);
    const paths = live.host.querySelectorAll("svg[data-lod] path");
    // The layer is outside the board SVG (its own composited layer), with nothing but paths.
    expect(svg.querySelector("[data-lod]")).toBeNull();
    expect(live.host.querySelectorAll("svg[data-lod] *").length).toBe(paths.length + 1);
    expect(paths.length).toBeGreaterThan(1);
    expect(svg.querySelectorAll("*").length).toBeLessThan(60);
    // Every node and connector is in the layer: one subpath each (M ... z or M ... L ...).
    const subpaths = [...paths].reduce((k, p) => k + (p.getAttribute("d")!.match(/M/g)?.length ?? 0), 0);
    expect(subpaths).toBe(fx.nodeIds.length + fx.edgeIds.length);
    // Zoom back in past the threshold: full views with their text, as a fresh board at that view.
    await zoomTo(live.host, 0.5);
    expect(svgOf(live.host).querySelectorAll("text").length).toBeGreaterThan(10);
    expect(live.host.querySelector("[data-lod]")).toBeNull();
    const fresh = await mount(fx.doc, fx.boardId);
    await fit(fresh.host);
    await zoomTo(fresh.host, 0.5);
    expect(markup(live.host)).toBe(markup(fresh.host));
  });

  it("zoomed out: a click selects the shape under the pointer by position", async () => {
    const fx = makeFixture({ nodes: 1200, seed: 7 });
    const { host } = await mount(fx.doc, fx.boardId);
    await fit(host);
    const g = svgOf(host).querySelector(":scope > g[transform]")!;
    const [tx, ty, z] = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(g.getAttribute("transform")!)!.slice(1).map(Number);
    const id = fx.nodeIds[600];
    const s = readShapes(getBoardMap(fx.doc, fx.boardId)!).find((q) => q.id === id)!;
    const cx = ((s.x ?? 0) + (s.w ?? 0) / 2) * z + tx, cy = ((s.y ?? 0) + (s.h ?? 0) / 2) * z + ty;
    const e = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 });
    Object.defineProperty(e, "pointerId", { value: 1 });
    Object.defineProperty(e, "pointerType", { value: "mouse" });
    await act(async () => void svgOf(host).dispatchEvent(e));
    await act(async () => void svgOf(host).dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: cx, clientY: cy })));
    // The selected shape draws as its full view above the LOD layer.
    expect(svgOf(host).querySelectorAll("g[data-s]").length).toBe(1);
    expect(svgOf(host).querySelector(`g[data-s="${id}"]`)).not.toBeNull();
  });

  it("collapses shapes under LOD.tiny screen pixels into one dot path", () => {
    const shapes = [
      { id: "a", type: "rect" as const, x: 0, y: 0, w: 100, h: 60 },
      { id: "b", type: "rect" as const, x: 200, y: 0, w: 8, h: 6 },
      { id: "c", type: "ellipse" as const, x: 300, y: 0, w: 10, h: 10 },
    ];
    const g = lodGroups(shapes, 0.1, { y: "#ff0" }, { accent: "#00f" });
    const tiny = g.find((x) => x.key === "t")!;
    expect(tiny.d.match(/M/g)!.length).toBe(2);
    expect(g.filter((x) => x.key !== "t").map((x) => x.d.match(/M/g)!.length)).toEqual([1]);
  });

  it("hit-tests by position: the topmost box wins over a line, a line within the tolerance otherwise", () => {
    const sc = new SceneIndex();
    const shapes: Shape[] = [
      { id: "a", type: "rect", x: 0, y: 0, w: 100, h: 100 },
      { id: "b", type: "ellipse", x: 50, y: 50, w: 100, h: 100 },
      { id: "e", type: "arrow", pts: [[0, 50], [300, 50]] },
    ];
    sc.update(shapes);
    expect(sc.hitAt([75, 75], 10)).toBe("b");
    expect(sc.hitAt([10, 10], 10)).toBe("a");
    expect(sc.hitAt([250, 55], 10)).toBe("e");
    expect(sc.hitAt([250, 70], 10)).toBeNull();
  });
});
