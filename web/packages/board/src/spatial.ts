// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Spatial index for viewport queries and hit tests (DGM-06). A uniform grid hash: O(1) updates
// when one shape moves (the common case while editing, where an R-tree would rebalance), and
// queries that only visit the cells they cover. No dependency (ADR-045). Boxes spanning more
// than `MAX_CELLS` cells (huge frames) live in a small list checked on every query.
import { bbox, type Pt, type Shape } from "./model";
import type { Box } from "./ops";

const MAX_CELLS = 256;
/** Cell coordinates are clamped to ±2^20, so a key fits a double exactly. */
const LIM = 2 ** 20;
const key = (cx: number, cy: number) => (cx + LIM) * 2 ** 21 + (cy + LIM);
const clampCell = (v: number) => Math.max(-LIM, Math.min(LIM - 1, v));

const hits = (a: Box, b: Box) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

export class SpatialIndex {
  private boxes = new Map<string, Box>();
  private cells = new Map<number, Set<string>>();
  private large = new Set<string>();

  constructor(readonly cell = 256) {}

  static ofShapes(shapes: Iterable<Shape>, cell?: number): SpatialIndex {
    const idx = new SpatialIndex(cell);
    for (const s of shapes) idx.set(s.id, bbox(s));
    return idx;
  }

  get size() {
    return this.boxes.size;
  }

  get(id: string): Box | undefined {
    return this.boxes.get(id);
  }

  private span(b: Box): [number, number, number, number] {
    const c = this.cell;
    return [clampCell(Math.floor(b[0] / c)), clampCell(Math.floor(b[1] / c)), clampCell(Math.floor(b[2] / c)), clampCell(Math.floor(b[3] / c))];
  }

  private isLarge(b: Box) {
    const [x0, y0, x1, y1] = this.span(b);
    return (x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS;
  }

  set(id: string, b: Box) {
    const old = this.boxes.get(id);
    if (old && old[0] === b[0] && old[1] === b[1] && old[2] === b[2] && old[3] === b[3]) return;
    if (old) this.unlink(id, old);
    const box: Box = [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
    if (!box.every(Number.isFinite)) return void this.boxes.delete(id);
    this.boxes.set(id, box);
    if (this.isLarge(box)) return void this.large.add(id);
    const [x0, y0, x1, y1] = this.span(box);
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy);
        let set = this.cells.get(k);
        if (!set) this.cells.set(k, (set = new Set()));
        set.add(id);
      }
  }

  delete(id: string) {
    const old = this.boxes.get(id);
    if (!old) return;
    this.unlink(id, old);
    this.boxes.delete(id);
  }

  private unlink(id: string, b: Box) {
    if (this.large.delete(id)) return;
    const [x0, y0, x1, y1] = this.span(b);
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy);
        const set = this.cells.get(k);
        set?.delete(id);
        if (set && !set.size) this.cells.delete(k);
      }
  }

  /** Ids whose box intersects `q` (touching counts), in no particular order. */
  search(q: Box): string[] {
    const out: string[] = [];
    const [x0, y0, x1, y1] = this.span(q);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.cells.size) {
      for (const [id, b] of this.boxes) if (hits(b, q)) out.push(id);
      return out;
    }
    const seen = new Set<string>();
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const set = this.cells.get(key(cx, cy));
        if (!set) continue;
        for (const id of set) {
          if (seen.has(id)) continue;
          seen.add(id);
          if (hits(this.boxes.get(id)!, q)) out.push(id);
        }
      }
    for (const id of this.large) if (hits(this.boxes.get(id)!, q)) out.push(id);
    return out;
  }

  /** Ids whose box (grown by `pad`) contains `p`. */
  hit(p: Pt, pad = 0): string[] {
    return this.search([p[0] - pad, p[1] - pad, p[0] + pad, p[1] + pad]);
  }
}
