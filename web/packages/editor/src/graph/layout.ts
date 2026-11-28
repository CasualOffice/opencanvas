// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The knowledge graph's force layout (GRAPH-02, docs/38 §3.2): plain JavaScript, no library,
// run in a Web Worker (layout.worker.ts) or, without workers, in slices on the main thread.
// Repulsion between nearby nodes (a grid, so 2,000 nodes cost about as much per node as 50),
// springs along links, a weak pull to the middle, and circles that never overlap. The heat
// (alpha) cools every tick and the layout stops when it settles (about 175 ticks).

export interface LayoutInput {
  nodes: { id: string; r: number }[];
  /** [source index, target index, 1 for a block tied to its canvas else 0]. */
  edges: [number, number, number][];
  w: number;
  h: number;
  /** A node held in the middle (the local graph's canvas) unless pinned. */
  center?: number;
  charge?: number;
  len?: number;
}
export interface Sim {
  n: number;
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  r: Float64Array;
  /** NaN when free. */
  fx: Float64Array;
  fy: Float64Array;
  e: Int32Array;
  ek: Uint8Array;
  alpha: number;
  w: number;
  h: number;
  center: number;
  charge: number;
  len: number;
  rand: () => number;
}

export const ALPHA_MIN = 0.005;
const DECAY = 0.03;
const PAD = 7;
/** Beyond this distance nodes do not push each other (the middle pull keeps parts together). */
const CUTOFF = 260;

/** A small seeded random number generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Start positions: known ones kept, a new node next to a placed neighbour, others on a ring. */
export function seed(input: LayoutInput, known: Map<string, [number, number]>, s = 1): { x: Float64Array; y: Float64Array } {
  const n = input.nodes.length,
    x = new Float64Array(n),
    y = new Float64Array(n),
    placed = new Uint8Array(n),
    rand = rng(s);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of input.edges) if (a !== b && a < n && b < n) (adj[a].push(b), adj[b].push(a));
  const cx = input.w / 2,
    cy = input.h / 2;
  input.nodes.forEach((nd, i) => {
    const k = known.get(nd.id);
    if (k) (x[i] = k[0]), (y[i] = k[1]), (placed[i] = 1);
  });
  if (input.center != null && !placed[input.center]) (x[input.center] = cx), (y[input.center] = cy), (placed[input.center] = 1);
  for (let i = 0; i < n; i++) {
    if (placed[i]) continue;
    const near = adj[i].find((j) => placed[j]);
    const ang = rand() * Math.PI * 2;
    if (near != null) {
      const d = 18 + rand() * 24;
      x[i] = x[near] + Math.cos(ang) * d;
      y[i] = y[near] + Math.sin(ang) * d;
    } else {
      const rad = Math.min(input.w, input.h) * (0.12 + rand() * 0.3) + Math.sqrt(n) * 2;
      x[i] = cx + Math.cos(ang) * rad * (input.w / input.h > 1.2 ? 1.35 : 1);
      y[i] = cy + Math.sin(ang) * rad;
    }
    placed[i] = 1;
  }
  return { x, y };
}

export function createSim(input: LayoutInput, start: { x: Float64Array; y: Float64Array }, pins: Map<string, [number, number]> = new Map(), alpha = 1): Sim {
  const n = input.nodes.length;
  const fx = new Float64Array(n).fill(NaN),
    fy = new Float64Array(n).fill(NaN);
  input.nodes.forEach((nd, i) => {
    const p = pins.get(nd.id);
    if (p) (fx[i] = p[0]), (fy[i] = p[1]);
  });
  const es = input.edges.filter(([a, b]) => a !== b && a < n && b < n);
  const e = new Int32Array(es.length * 2),
    ek = new Uint8Array(es.length);
  es.forEach(([a, b, k], i) => ((e[2 * i] = a), (e[2 * i + 1] = b), (ek[i] = k)));
  const s: Sim = {
    n,
    x: Float64Array.from(start.x),
    y: Float64Array.from(start.y),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
    r: Float64Array.from(input.nodes, (nd) => nd.r),
    fx,
    fy,
    e,
    ek,
    alpha,
    w: input.w,
    h: input.h,
    center: input.center ?? -1,
    charge: input.charge ?? 480,
    len: input.len ?? 70,
    rand: rng(n * 7919 + es.length),
  };
  for (let i = 0; i < n; i++) if (!Number.isNaN(fx[i])) (s.x[i] = fx[i]), (s.y[i] = fy[i]);
  return s;
}

/** One step. False when the layout has settled (nothing moved). */
export function tick(s: Sim): boolean {
  if (s.alpha < ALPHA_MIN) return false;
  const { n, x, y, vx, vy, r } = s,
    a = s.alpha,
    cx = s.w / 2,
    cy = s.h / 2;
  // Repulsion and collision between nodes in neighbouring grid cells.
  const cell = CUTOFF,
    cols = new Map<number, number[]>();
  const key = (gx: number, gy: number) => (gx + 32768) * 65536 + (gy + 32768);
  const gxs = new Int32Array(n),
    gys = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const gx = Math.floor(x[i] / cell),
      gy = Math.floor(y[i] / cell);
    gxs[i] = gx;
    gys[i] = gy;
    const k = key(gx, gy);
    const b = cols.get(k);
    if (b) b.push(i);
    else cols.set(k, [i]);
  }
  const c2 = CUTOFF * CUTOFF;
  for (let i = 0; i < n; i++) {
    for (let ox = -1; ox <= 1; ox++)
      for (let oy = -1; oy <= 1; oy++) {
        const b = cols.get(key(gxs[i] + ox, gys[i] + oy));
        if (!b) continue;
        for (const j of b) {
          if (j <= i) continue;
          let dx = x[j] - x[i],
            dy = y[j] - y[i],
            d2 = dx * dx + dy * dy;
          if (d2 < 1) (dx = s.rand() - 0.5), (dy = s.rand() - 0.5), (d2 = dx * dx + dy * dy + 0.01);
          if (d2 < c2) {
            const f = (s.charge * a) / d2;
            vx[i] -= dx * f;
            vy[i] -= dy * f;
            vx[j] += dx * f;
            vy[j] += dy * f;
          }
          const m = r[i] + r[j] + PAD;
          if (d2 < m * m) {
            const d = Math.sqrt(d2),
              k = ((m - d) / d) * 0.3;
            x[i] -= dx * k;
            y[i] -= dy * k;
            x[j] += dx * k;
            y[j] += dy * k;
          }
        }
      }
  }
  // Springs along links; a block sits close to its canvas.
  const e = s.e;
  for (let i = 0; i < s.ek.length; i++) {
    const p = e[2 * i],
      q = e[2 * i + 1];
    let dx = x[q] + vx[q] - x[p] - vx[p],
      dy = y[q] + vy[q] - y[p] - vy[p];
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const blk = s.ek[i] === 1,
      L = blk ? r[q] + 15 : s.len,
      l = ((d - L) / d) * a * (blk ? 0.6 : 0.22);
    dx *= l;
    dy *= l;
    vx[q] -= dx * 0.5;
    vy[q] -= dy * 0.5;
    vx[p] += dx * 0.5;
    vy[p] += dy * 0.5;
  }
  const gx = 0.016 * (s.h / s.w) * 1.3,
    gy = 0.024;
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(s.fx[i])) {
      x[i] = s.fx[i];
      y[i] = s.fy[i];
      vx[i] = vy[i] = 0;
    } else if (i === s.center) {
      x[i] = cx;
      y[i] = cy;
      vx[i] = vy[i] = 0;
    } else {
      vx[i] = (vx[i] + (cx - x[i]) * gx * a) * 0.6;
      vy[i] = (vy[i] + (cy - y[i]) * gy * a) * 0.6;
      x[i] += vx[i];
      y[i] += vy[i];
    }
  }
  s.alpha += (0 - s.alpha) * DECAY;
  return true;
}

/** Runs to rest (reduced motion: drawn once). Returns the ticks it took. */
export function settle(s: Sim, max = 600): number {
  let t = 0;
  while (t < max && tick(s)) t++;
  return t;
}

export function reheat(s: Sim, a: number) {
  s.alpha = Math.max(s.alpha, a);
}

export function pin(s: Sim, i: number, px: number | null, py: number | null) {
  if (i < 0 || i >= s.n) return;
  s.fx[i] = px ?? NaN;
  s.fy[i] = py ?? NaN;
  if (px != null && py != null) (s.x[i] = px), (s.y[i] = py);
}
