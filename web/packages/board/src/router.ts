// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Obstacle-aware orthogonal routing (DGM-13, ADR-047). Pure and deterministic: the same ends and
// the same obstacle boxes give the same points, whatever order the boxes come in. No dependency.
//
// A route leaves each bound end along its side for `CLEARANCE` (a stub), then runs on a sparse
// orthogonal grid between the stubs: the grid lines are the stubs' coordinates, the search
// region's border and every obstacle edge (obstacles grown by `CLEARANCE`). A* over (grid node,
// heading) with cost = length + `BEND` per turn, Manhattan heuristic, and a fixed tie-break
// (lowest f, then lowest h, then lowest state number, which follows the sorted grid), so equal
// routes are always chosen the same way. All arithmetic is on integers (tenths of a unit).
//
// The search region starts as the stubs' box grown by `PADS[0]` and grows to `PADS[1]` when no
// route exists. Too many obstacles in a region (`MAX_OBSTACLES`), or no route in the last one,
// gives `null`: the caller draws the plain elbow (the fallback every reader shares). The region
// the result depended on is returned: the route can only change when an obstacle meeting that
// region changes, or the ends do (routing.ts invalidates on exactly that).
import type { Pt } from "./model";
import type { Box } from "./ops";

export type Side = "top" | "right" | "bottom" | "left";
export interface RouteEnd {
  p: Pt;
  /** The side the end leaves its shape from; none for a free end (no stub, any heading). */
  side?: Side;
}

export const CLEARANCE = 16;
export const BEND = 30;
export const PADS = [160, 640] as const;
export const MAX_OBSTACLES = 160;

export interface RouteResult {
  /** The route, ends included; `null` = use the plain elbow. */
  pts: Pt[] | null;
  /** The region whose obstacles the result depends on. */
  region: Box;
}

/** Obstacle boxes meeting a region (touching counts), in any order. */
export type ObstacleQuery = (region: Box) => readonly Box[];

// Headings: 0 east, 1 south, 2 west, 3 north.
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const HEADING: Record<Side, number> = { right: 0, bottom: 1, left: 2, top: 3 };
const T = (v: number) => Math.round(v * 10);

/** The stub end (in tenths) and the heading a route must start (or, for `b`, end) with. */
function stubOf(e: RouteEnd): { x: number; y: number; h: number } {
  const x = T(e.p[0]), y = T(e.p[1]);
  if (!e.side) return { x, y, h: -1 };
  const h = HEADING[e.side];
  return { x: x + DX[h] * CLEARANCE * 10, y: y + DY[h] * CLEARANCE * 10, h };
}

/** The search region for level `k` (world units). */
export function regionAt(a: RouteEnd, b: RouteEnd, k: number): Box {
  const sa = stubOf(a), sb = stubOf(b);
  const pad = PADS[k] * 10;
  return [(Math.min(sa.x, sb.x) - pad) / 10, (Math.min(sa.y, sb.y) - pad) / 10, (Math.max(sa.x, sb.x) + pad) / 10, (Math.max(sa.y, sb.y) + pad) / 10];
}

/** First index with xs[i] >= v. */
function lower(xs: number[], v: number): number {
  let lo = 0, hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Binary min-heap of [f, h, state] compared in that order. */
class Heap {
  private f: number[] = [];
  private h: number[] = [];
  private s: number[] = [];
  get size() {
    return this.s.length;
  }
  private less(i: number, j: number) {
    return this.f[i] !== this.f[j] ? this.f[i] < this.f[j] : this.h[i] !== this.h[j] ? this.h[i] < this.h[j] : this.s[i] < this.s[j];
  }
  private swap(i: number, j: number) {
    [this.f[i], this.f[j]] = [this.f[j], this.f[i]];
    [this.h[i], this.h[j]] = [this.h[j], this.h[i]];
    [this.s[i], this.s[j]] = [this.s[j], this.s[i]];
  }
  push(f: number, h: number, s: number) {
    this.f.push(f);
    this.h.push(h);
    this.s.push(s);
    let i = this.s.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const out: [number, number] = [this.f[0], this.s[0]];
    const n = this.s.length - 1;
    this.swap(0, n);
    this.f.pop();
    this.h.pop();
    this.s.pop();
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return out;
  }
}

const uniq = (v: number[]) => [...new Set(v)].sort((p, q) => p - q);

/** One search in one region; `null` when the stubs can't be joined there. */
function search(sa: { x: number; y: number; h: number }, sb: { x: number; y: number; h: number }, R: number[], obs: number[][]): number[][] | null {
  const xs = uniq([R[0], R[2], sa.x, sb.x, ...obs.flatMap((o) => [o[0], o[2]]).filter((v) => v >= R[0] && v <= R[2])]);
  const ys = uniq([R[1], R[3], sa.y, sb.y, ...obs.flatMap((o) => [o[1], o[3]]).filter((v) => v >= R[1] && v <= R[3])]);
  const nx = xs.length, ny = ys.length;
  const blocked = new Uint8Array(nx * ny);
  const hBlocked = new Uint8Array(nx * ny); // edge (i,j)-(i+1,j) at j*nx+i
  const vBlocked = new Uint8Array(nx * ny); // edge (i,j)-(i,j+1) at j*nx+i
  for (const [x0, y0, x1, y1] of obs) {
    const ilo = lower(xs, x0), ihi = lower(xs, x1 + 1) - 1; // xs within [x0, x1]
    const jlo = lower(ys, y0), jhi = lower(ys, y1 + 1) - 1;
    const is = xs[ilo] === x0 ? ilo + 1 : ilo, ie = xs[ihi] === x1 ? ihi - 1 : ihi; // strictly inside
    const js = ys[jlo] === y0 ? jlo + 1 : jlo, je = ys[jhi] === y1 ? jhi - 1 : jhi;
    for (let j = js; j <= je; j++) {
      for (let i = is; i <= ie; i++) blocked[j * nx + i] = 1;
      for (let i = ilo; i < ihi; i++) hBlocked[j * nx + i] = 1;
    }
    for (let i = is; i <= ie; i++) for (let j = jlo; j < jhi; j++) vBlocked[j * nx + i] = 1;
  }
  const ia = lower(xs, sa.x), ja = lower(ys, sa.y), ib = lower(xs, sb.x), jb = lower(ys, sb.y);
  const goal = jb * nx + ib;
  const N = nx * ny * 4;
  const GOAL = N;
  const g = new Float64Array(N + 1).fill(Infinity);
  const from = new Int32Array(N + 1).fill(-1);
  const heap = new Heap();
  const hOf = (n: number) => Math.abs(xs[n % nx] - sb.x) + Math.abs(ys[Math.floor(n / nx)] - sb.y);
  const start = ja * nx + ia;
  for (let d = 0; d < 4; d++) {
    if (sa.h >= 0 && d !== sa.h) continue;
    const st = start * 4 + d;
    g[st] = 0;
    heap.push(hOf(start), hOf(start), st);
  }
  const bend = BEND * 10;
  // Arriving at b's stub, the route must head into b: opposite to b's side.
  const need = sb.h >= 0 ? (sb.h + 2) % 4 : -1;
  while (heap.size) {
    const [f, st] = heap.pop();
    if (st === GOAL) break;
    if (f - hOf(Math.floor(st / 4)) > g[st]) continue; // stale entry
    const n = Math.floor(st / 4), d = st % 4;
    const gs = g[st];
    if (n === goal) {
      const turn = need < 0 || d === need ? 0 : d === (need + 2) % 4 ? 2 * bend : bend;
      if (gs + turn < g[GOAL]) {
        g[GOAL] = gs + turn;
        from[GOAL] = st;
        heap.push(gs + turn, 0, GOAL);
      }
    }
    const i = n % nx, j = Math.floor(n / nx);
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue;
      const ni = i + DX[nd], nj = j + DY[nd];
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const m = nj * nx + ni;
      if (blocked[m]) continue;
      if (nd === 0 ? hBlocked[j * nx + i] : nd === 2 ? hBlocked[j * nx + ni] : nd === 1 ? vBlocked[j * nx + i] : vBlocked[nj * nx + i]) continue;
      const cost = gs + Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]) + (nd === d ? 0 : bend);
      const ns = m * 4 + nd;
      if (cost < g[ns]) {
        g[ns] = cost;
        from[ns] = st;
        const h = hOf(m);
        heap.push(cost + h, h, ns);
      }
    }
  }
  if (from[GOAL] < 0) return null;
  const out: number[][] = [];
  for (let st = from[GOAL]; st >= 0; st = from[st]) {
    const n = Math.floor(st / 4);
    out.push([xs[n % nx], ys[Math.floor(n / nx)]]);
  }
  return out.reverse();
}

/** Drop repeated points and middle points of straight runs (integer coordinates). */
function simplify(p: number[][]): number[][] {
  const d = p.filter((q, i) => i === 0 || q[0] !== p[i - 1][0] || q[1] !== p[i - 1][1]);
  return d.filter((q, i) => i === 0 || i === d.length - 1 || !((d[i - 1][0] === q[0] && q[0] === d[i + 1][0]) || (d[i - 1][1] === q[1] && q[1] === d[i + 1][1])));
}

/**
 * Route from `a` to `b` around the obstacles `query` returns (obstacles holding either stub are
 * ignored: the route can't avoid them). `levels` limits how many of `PADS` are tried (the worker
 * gets only the obstacles of the levels the caller checked).
 */
export function routeOrthogonal(a: RouteEnd, b: RouteEnd, query: ObstacleQuery, levels: number = PADS.length): RouteResult {
  const sa = stubOf(a), sb = stubOf(b);
  const c = CLEARANCE * 10;
  let region: Box = regionAt(a, b, 0);
  for (let k = 0; k < PADS.length; k++) {
    region = regionAt(a, b, k);
    if (k >= levels) break;
    const R = region.map(T);
    const obs: number[][] = [];
    for (const o of query(region)) {
      const x0 = Math.min(T(o[0]), T(o[2])) - c, y0 = Math.min(T(o[1]), T(o[3])) - c;
      const x1 = Math.max(T(o[0]), T(o[2])) + c, y1 = Math.max(T(o[1]), T(o[3])) + c;
      if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
      const holds = (s: { x: number; y: number }) => s.x > x0 && s.x < x1 && s.y > y0 && s.y < y1;
      if (holds(sa) || holds(sb)) continue;
      obs.push([x0, y0, x1, y1]);
    }
    if (obs.length > MAX_OBSTACLES) break;
    const path = search(sa, sb, R, obs);
    if (!path) continue;
    const ends = [[T(a.p[0]), T(a.p[1])], ...path, [T(b.p[0]), T(b.p[1])]];
    return { pts: simplify(ends).map((q) => [q[0] / 10, q[1] / 10] as Pt), region };
  }
  return { pts: null, region };
}

export const meets = (a: Box, b: Box) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** One connector to route off the main thread (routing.ts `RouteScheduler`, route.worker.ts). */
export interface RouteJob {
  id: string;
  ver: number;
  a: RouteEnd;
  b: RouteEnd;
  /** Obstacles meeting the largest region the job may use. */
  obstacles: Box[];
  /** How many of `PADS` the job may try (the rest have too many obstacles). */
  levels: number;
}
export interface RouteDone {
  id: string;
  ver: number;
  res: RouteResult;
}

/** Run one job: the same result as routing against the live obstacle index. */
export function runJob(j: RouteJob): RouteDone {
  return { id: j.id, ver: j.ver, res: routeOrthogonal(j.a, j.b, (R) => j.obstacles.filter((o) => meets(o, R)), j.levels) };
}
