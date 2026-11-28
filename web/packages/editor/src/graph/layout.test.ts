// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// GRAPH-02: the force layout (plain JS, runs in a Web Worker): it settles and stops, pulls linked
// canvases together, keeps pins, never overlaps circles and keeps known positions on a change.
import { describe, expect, it } from "vitest";
import { createSim, seed, settle, tick, type LayoutInput } from "./layout";

function ring(n: number, extra: [number, number][] = []): LayoutInput {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: "n" + i, r: 6 }));
  const edges: [number, number, number][] = [];
  for (let i = 0; i < n; i++) edges.push([i, (i + 1) % n, 0]);
  for (const [a, b] of extra) edges.push([a, b, 0]);
  return { nodes, edges, w: 800, h: 600 };
}

const dist = (s: ReturnType<typeof createSim>, a: number, b: number) => Math.hypot(s.x[a] - s.x[b], s.y[a] - s.y[b]);

describe("layout", () => {
  it("settles and stops", () => {
    const s = createSim(ring(40), seed(ring(40), new Map(), 7));
    const ticks = settle(s, 2000);
    expect(ticks).toBeLessThan(2000);
    expect(s.alpha).toBeLessThan(0.005);
    expect(tick(s)).toBe(false);
  });

  it("pulls linked canvases closer than unlinked ones", () => {
    const input = ring(30);
    const s = createSim(input, seed(input, new Map(), 3));
    settle(s, 3000);
    let linked = 0;
    for (const [a, b] of input.edges) linked += dist(s, a, b);
    linked /= input.edges.length;
    let all = 0,
      n = 0;
    for (let i = 0; i < 30; i++) for (let j = i + 1; j < 30; j++) (all += dist(s, i, j)), n++;
    expect(linked).toBeLessThan(all / n);
  });

  it("keeps pinned nodes where they were put", () => {
    const input = ring(12);
    const start = seed(input, new Map(), 5);
    const s = createSim(input, start, new Map([["n3", [111, 222]]]));
    settle(s, 3000);
    expect([s.x[3], s.y[3]]).toEqual([111, 222]);
  });

  it("does not overlap circles", () => {
    const input = { nodes: Array.from({ length: 60 }, (_, i) => ({ id: "n" + i, r: 5 + (i % 4) * 3 })), edges: [] as [number, number, number][], w: 600, h: 400 };
    const s = createSim(input, seed(input, new Map(), 9));
    settle(s, 3000);
    let min = Infinity;
    for (let i = 0; i < 60; i++) for (let j = i + 1; j < 60; j++) min = Math.min(min, dist(s, i, j) - input.nodes[i].r - input.nodes[j].r);
    expect(min).toBeGreaterThan(0);
  });

  it("keeps known positions and places new nodes next to a neighbour", () => {
    const input = ring(6);
    const known = new Map<string, [number, number]>([["n0", [10, 20]], ["n1", [400, 300]]]);
    const p = seed(input, known, 1);
    expect([p.x[0], p.y[0]]).toEqual([10, 20]);
    expect([p.x[1], p.y[1]]).toEqual([400, 300]);
    // n2 is linked to n1: it starts near it.
    expect(Math.hypot(p.x[2] - 400, p.y[2] - 300)).toBeLessThan(60);
  });

  it("is the same for the same seed", () => {
    const input = ring(20, [[0, 10]]);
    const a = createSim(input, seed(input, new Map(), 4));
    const b = createSim(input, seed(input, new Map(), 4));
    settle(a, 500);
    settle(b, 500);
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
  });

  it("lays out 2,000 canvases and 6,000 links in bounded work", () => {
    const n = 2000;
    const nodes = Array.from({ length: n }, (_, i) => ({ id: "n" + i, r: 5 }));
    const edges: [number, number, number][] = [];
    let r = 1;
    const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 6000; i++) edges.push([Math.floor(rand() * n), Math.floor(rand() * n), 0]);
    const input = { nodes, edges, w: 1600, h: 1000 };
    const s = createSim(input, seed(input, new Map(), 2));
    const ticks = settle(s, 400);
    expect(ticks).toBeLessThanOrEqual(400);
    expect(Number.isFinite(s.x[0]) && Number.isFinite(s.y[n - 1])).toBe(true);
  });
});
