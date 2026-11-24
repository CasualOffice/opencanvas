// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Scene index for the board view (DGM-11): the drawn shapes (connectors resolved) in a
// `SpatialIndex`, kept up to date from one `shapes` array to the next by object identity (the
// projection and the arrow resolver keep unchanged shapes as the same objects), so a move
// costs one index update instead of a pass over the board.
//
// Every query gives exactly what the linear scan it replaces gave, in paint order:
//   `inBox`   ids whose box meets a box: viewport culling and marquee (`intersects(bbox(s), q)`)
//   `snap`    the binding an arrow end snaps to (`snapTarget`)
//   `hitAt`   the topmost shape at a point (DGM-19: the zoomed-out LOD layer has no per-shape DOM)
// The index stores normalised finite boxes and is only a pre-filter: candidates are checked
// with the original predicate on the shape's own `bbox`, so inverted boxes behave as before,
// and shapes whose box isn't finite (bad remote data) are kept in a side list checked on
// every query.
import { bbox, type Pt, type Shape } from "./model";
import { intersects, type Box } from "./ops";
import { SpatialIndex } from "./spatial";
import { snapOn, type Binding } from "./connectors";

/** Distance from `p` to the segment `a`-`b`. */
const segDist = (p: Pt, a: Pt, b: Pt) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

const finite = (b: Box) => Number.isFinite(b[0]) && Number.isFinite(b[1]) && Number.isFinite(b[2]) && Number.isFinite(b[3]);

export class SceneIndex {
  /** `tested`: shapes checked against a query so far (a linear scan tests every shape). */
  readonly stats = { tested: 0, updated: 0, structural: 0 };
  /** Id → drawn shape, updated in place. */
  readonly byId = new Map<string, Shape>();
  private list: Shape[] = [];
  private pos = new Map<string, number>();
  private boxes = new Map<string, Box>();
  private idx = new SpatialIndex();
  private odd = new Set<string>();

  get shapes(): readonly Shape[] {
    return this.list;
  }

  /** Paint position of a shape (its index in the last `update`). */
  posOf(id: string): number | undefined {
    return this.pos.get(id);
  }

  /** Take the next `shapes` array: only shapes that are new objects are re-indexed. */
  update(shapes: Shape[]): void {
    const prev = this.list;
    if (shapes === prev) return;
    this.list = shapes;
    let same = prev.length === shapes.length;
    if (same) {
      for (let i = 0; i < shapes.length; i++) {
        const s = shapes[i];
        if (s === prev[i]) continue;
        if (s.id !== prev[i].id) {
          same = false;
          break;
        }
        this.put(s);
      }
    }
    if (same) return;
    // Membership or order changed: diff by id, rebuild positions.
    this.stats.structural++;
    const live = new Set<string>();
    this.pos = new Map();
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      live.add(s.id);
      this.pos.set(s.id, i);
      if (this.byId.get(s.id) !== s) this.put(s);
    }
    for (const id of [...this.byId.keys()]) if (!live.has(id)) this.remove(id);
  }

  private put(s: Shape) {
    this.stats.updated++;
    this.byId.set(s.id, s);
    const b = bbox(s);
    this.boxes.set(s.id, b);
    if (finite(b)) {
      this.idx.set(s.id, b);
      this.odd.delete(s.id);
    } else {
      this.idx.delete(s.id);
      this.odd.add(s.id);
    }
  }

  private remove(id: string) {
    this.byId.delete(id);
    this.boxes.delete(id);
    this.idx.delete(id);
    this.odd.delete(id);
  }

  /** Candidate ids for a box (index hits plus the odd ones), unordered. */
  private candidates(q: Box): string[] {
    const out = this.idx.search([Math.min(q[0], q[2]), Math.min(q[1], q[3]), Math.max(q[0], q[2]), Math.max(q[1], q[3])]);
    for (const id of this.odd) out.push(id);
    this.stats.tested += out.length;
    return out;
  }

  /** Ids in paint order. Sorting a few is cheaper than a pass; for many, mark and scan. */
  private ordered(ids: Iterable<string>, n: number): string[] {
    if (n * 8 < this.list.length) {
      return [...ids].sort((a, b) => this.pos.get(a)! - this.pos.get(b)!);
    }
    const mark = new Uint8Array(this.list.length);
    for (const id of ids) mark[this.pos.get(id)!] = 1;
    const out: string[] = [];
    for (let i = 0; i < mark.length; i++) if (mark[i]) out.push(this.list[i].id);
    return out;
  }

  /** Ids whose box meets `q` (as `intersects(bbox(s), q)`), in paint order. */
  inBox(q: Box): string[] {
    const hit: string[] = [];
    for (const id of this.candidates(q)) if (intersects(this.boxes.get(id)!, q)) hit.push(id);
    return this.ordered(hit, hit.length);
  }

  /**
   * Shapes to draw for the viewport box `vb`: those meeting it, plus `keep` (selected, being
   * edited) wherever they are, in paint order. Equal to
   * `shapes.filter((s) => intersects(bbox(s), vb) || keep.has(s.id))`.
   */
  visible(vb: Box, keep: Iterable<string> = []): Shape[] {
    const ids = new Set<string>();
    for (const id of this.candidates(vb)) if (intersects(this.boxes.get(id)!, vb)) ids.add(id);
    for (const id of keep) if (this.pos.has(id)) ids.add(id);
    return this.ordered(ids, ids.size).map((id) => this.byId.get(id)!);
  }

  /** `snapTarget(shapes, p, pad, exclude)` through the index: the topmost match wins. */
  snap(p: Pt, pad = 18, exclude?: string): Binding | null {
    let best: Binding | null = null;
    let bp = -1;
    for (const id of this.candidates([p[0] - pad, p[1] - pad, p[0] + pad, p[1] + pad])) {
      const i = this.pos.get(id)!;
      if (i <= bp || id === exclude) continue;
      const b = snapOn(this.byId.get(id)!, p, pad);
      if (b) {
        best = b;
        bp = i;
      }
    }
    return best;
  }

  /**
   * The shape at `p` (DGM-19: the zoomed-out LOD layer has no per-shape elements to hit): the
   * topmost box containing `p`, else the topmost connector or pen stroke within `tol` of it
   * (zoomed out a line is a hair wide and runs over the boxes it joins, so boxes win).
   */
  hitAt(p: Pt, tol: number): string | null {
    let box: string | null = null, line: string | null = null;
    let bp = -1, lp = -1;
    for (const id of this.candidates([p[0] - tol, p[1] - tol, p[0] + tol, p[1] + tol])) {
      const i = this.pos.get(id)!;
      const s = this.byId.get(id)!;
      if (s.type === "arrow" || s.type === "pen") {
        if (i <= lp || !s.pts) continue;
        for (let k = 1; k < s.pts.length; k++)
          if (segDist(p, s.pts[k - 1], s.pts[k]) <= tol) {
            line = id;
            lp = i;
            break;
          }
      } else if (i > bp) {
        const b = this.boxes.get(id)!;
        if (p[0] >= Math.min(b[0], b[2]) && p[0] <= Math.max(b[0], b[2]) && p[1] >= Math.min(b[1], b[3]) && p[1] <= Math.max(b[1], b[3])) {
          box = id;
          bp = i;
        }
      }
    }
    return box ?? line;
  }
}
