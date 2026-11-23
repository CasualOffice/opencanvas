// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Incremental obstacle routing for the board view (DGM-13, ADR-047). `AvoidRouter` takes the
// resolved shapes (arrow resolver output) and replaces the points of each connector stored with
// `routing: "avoid"` by its route around the other shapes (router.ts). Routes are derived, never
// a source of truth; the commit-time sync writes them into `pts` for readers that don't route.
//
// Invalidation, per update (shapes compared by object identity, as the projection keeps them):
//   - an avoid connector that changed, or whose bound shapes changed (its ends may move);
//   - an avoid connector whose route region (router.ts: the obstacles it depended on) meets the
//     old or new box of a shape that changed, appeared or went away.
// Anything else keeps its cached route, so the result equals routing every connector from
// scratch (routing.test.ts, randomised).
//
// Work: `apply` routes up to `budget` connectors at once; the rest (and everything while a drag
// is in progress, budget 0) are drawn as the plain elbow and left pending. `RouteScheduler`
// routes pending connectors later in small main-thread chunks (no worker yet); a newer batch
// cancels an older one. Every job has a version; a result for a connector that changed since is
// dropped.
import { bbox, type Pt, type Shape } from "./model";
import type { Box } from "./ops";
import { SpatialIndex } from "./spatial";
import { EdgeIndex } from "./edges";
import { isAvoid, resolveArrow, type RouteHook, type ShapeLookup } from "./connectors";
import { MAX_OBSTACLES, PADS, meets, regionAt, routeOrthogonal, runJob, type RouteDone, type RouteEnd, type RouteJob, type RouteResult } from "./router";

export type { RouteDone, RouteJob } from "./router";

/** Shapes a route keeps clear of: every box shape (connectors and drawings are not obstacles). */
export const isObstacle = (s: Shape) => s.type !== "arrow" && s.type !== "pen";

const normal = (b: Box): Box | null => {
  const n: Box = [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
  return n.every(Number.isFinite) ? n : null;
};

/** The ends the router joins for an avoid connector (where its plain elbow starts and ends), else `null`. */
export function avoidEnds(s: Shape, byId: ShapeLookup): { a: RouteEnd; b: RouteEnd } | null {
  if (!isAvoid(s)) return null;
  let out: { a: RouteEnd; b: RouteEnd } | null = null;
  resolveArrow(s, byId, (a, sa, b, sb) => {
    out = { a: { p: a, side: sa }, b: { p: b, side: sb } };
    return null;
  });
  return out;
}

interface Entry {
  key: string;
  ver: number;
  ends: { a: RouteEnd; b: RouteEnd } | null;
  /** `undefined` while pending. */
  res?: RouteResult;
  src?: Shape;
  out?: Shape;
}

export class AvoidRouter {
  /** `routed`: routes computed here (not in a worker); `reused`: cache hits; `deferred`: left pending. */
  readonly stats = { routed: 0, reused: 0, deferred: 0, accepted: 0, dropped: 0 };
  private list: Shape[] = [];
  private byId = new Map<string, Shape>();
  private obstacles = new SpatialIndex();
  private regions = new SpatialIndex();
  private edges = new EdgeIndex();
  private avoid = new Set<string>();
  private entries = new Map<string, Entry>();
  /** Re-check (ends may have moved). */
  private dirty = new Set<string>();
  /** Re-route (an obstacle in its region changed). */
  private hit = new Set<string>();
  private waiting = new Set<string>();
  private subs = new Set<() => void>();

  /** Avoid connectors drawn as the plain elbow until routed. */
  get pending(): ReadonlySet<string> {
    return this.waiting;
  }

  /** Avoid connectors on the board. */
  get connectors(): ReadonlySet<string> {
    return this.avoid;
  }

  /** The route a connector is drawn with now (`null`: plain elbow). */
  routed(id: string): Pt[] | null {
    return this.entries.get(id)?.res?.pts ?? null;
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => void this.subs.delete(cb);
  }

  /* ------------------------------------------------------------ input */

  private ingest(shapes: Shape[]) {
    const prev = this.list;
    if (shapes === prev) return;
    this.list = shapes;
    let same = prev.length === shapes.length;
    const changed: Shape[] = [];
    if (same) {
      for (let i = 0; i < shapes.length; i++) {
        if (shapes[i] === prev[i]) continue;
        if (shapes[i].id !== prev[i].id) {
          same = false;
          break;
        }
        changed.push(shapes[i]);
      }
    }
    if (same) {
      for (const s of changed) this.touch(s.id, s);
      return;
    }
    const live = new Set<string>();
    for (const s of shapes) {
      live.add(s.id);
      if (this.byId.get(s.id) !== s) this.touch(s.id, s);
    }
    for (const id of [...this.byId.keys()]) if (!live.has(id)) this.touch(id, undefined);
  }

  private hitRegions(b: Box) {
    for (const id of this.regions.search(b)) this.hit.add(id);
  }

  private touch(id: string, s: Shape | undefined) {
    if (s) this.byId.set(id, s);
    else this.byId.delete(id);
    const old = this.obstacles.get(id);
    if (old) this.hitRegions(old);
    const nb = s && isObstacle(s) ? normal(bbox(s)) : null;
    if (nb) {
      this.obstacles.set(id, nb);
      this.hitRegions(nb);
    } else this.obstacles.delete(id);
    for (const e of this.edges.edgesAt(id)) if (this.avoid.has(e)) this.dirty.add(e);
    if (s) this.edges.set(s);
    else this.edges.delete(id);
    if (s && isAvoid(s)) {
      this.avoid.add(id);
      this.dirty.add(id);
    } else if (this.avoid.delete(id)) {
      this.entries.delete(id);
      this.regions.delete(id);
      this.waiting.delete(id);
      this.dirty.delete(id);
      this.hit.delete(id);
    }
  }

  /* ----------------------------------------------------------- routing */

  /** Obstacle boxes meeting `R`; `fresh` overrides the indexed boxes of the shapes it holds. */
  private query(R: Box, fresh?: Map<string, Shape | undefined>): Box[] {
    const out: Box[] = [];
    for (const id of this.obstacles.search(R)) if (!fresh?.has(id)) out.push(this.obstacles.get(id)!);
    if (fresh)
      for (const s of fresh.values()) {
        const b = s && isObstacle(s) ? normal(bbox(s)) : null;
        if (b && meets(b, R)) out.push(b);
      }
    return out;
  }

  private routeNow(e: Entry, id: string) {
    this.stats.routed++;
    e.res = e.ends ? routeOrthogonal(e.ends.a, e.ends.b, (R) => this.query(R)) : { pts: null, region: [0, 0, 0, 0] };
    if (e.ends) this.regions.set(id, e.res.region);
    else this.regions.delete(id);
    this.waiting.delete(id);
  }

  /**
   * The resolved shapes with each avoid connector's points replaced by its route. Routes at most
   * `budget` connectors now; others stay pending (drawn as the plain elbow) for the scheduler.
   * Unchanged shapes, and unchanged routed connectors, keep their objects.
   */
  apply(shapes: Shape[], budget = Infinity): Shape[] {
    this.ingest(shapes);
    if (!this.avoid.size) return shapes;
    const todo = [...new Set([...this.dirty, ...this.hit, ...this.waiting])].sort();
    let n = 0;
    for (const id of todo) {
      const s = this.byId.get(id);
      if (!s || !this.avoid.has(id)) continue;
      const ends = avoidEnds(s, this.byId);
      const key = JSON.stringify(ends);
      let e = this.entries.get(id);
      if (e && e.key === key && e.res && !this.hit.has(id)) {
        this.stats.reused++;
        continue;
      }
      if (!e) this.entries.set(id, (e = { key, ver: 0, ends }));
      if (e.key !== key || !this.waiting.has(id) || this.hit.has(id)) e.ver++;
      e.key = key;
      e.ends = ends;
      if (n < budget) {
        n++;
        this.routeNow(e, id);
      } else {
        this.stats.deferred++;
        e.res = undefined;
        this.waiting.add(id);
        // While pending, any change in the largest region it could use re-versions it.
        if (ends) this.regions.set(id, regionAt(ends.a, ends.b, PADS.length - 1));
      }
    }
    this.dirty.clear();
    this.hit.clear();
    return shapes.map((s) => (this.avoid.has(s.id) ? this.outOf(s) : s));
  }

  private outOf(s: Shape): Shape {
    const e = this.entries.get(s.id);
    const pts = e?.res?.pts;
    if (!e || !pts) return s;
    if (e.out && e.src === s && e.out.pts === pts) return e.out;
    e.src = s;
    e.out = { ...s, pts };
    return e.out;
  }

  /** Route every pending connector now (the full pass at drag end). */
  flush(): boolean {
    if (!this.waiting.size) return false;
    for (const id of [...this.waiting].sort()) {
      const e = this.entries.get(id);
      if (e) this.routeNow(e, id);
    }
    this.notify();
    return true;
  }

  /** Jobs for the pending connectors, with the obstacles each may need. */
  jobs(): RouteJob[] {
    const out: RouteJob[] = [];
    for (const id of [...this.waiting].sort()) {
      const e = this.entries.get(id);
      if (!e?.ends) continue;
      let levels = 0;
      let obstacles: Box[] = [];
      for (let k = 0; k < PADS.length; k++) {
        const o = this.query(regionAt(e.ends.a, e.ends.b, k));
        if (o.length > MAX_OBSTACLES) break;
        levels = k + 1;
        obstacles = o;
      }
      out.push({ id, ver: e.ver, a: e.ends.a, b: e.ends.b, obstacles, levels });
    }
    return out;
  }

  /** Results from the scheduler; stale versions are dropped. Re-renders subscribers if any landed. */
  accept(done: RouteDone[]): number {
    let n = 0;
    for (const d of done) {
      const e = this.entries.get(d.id);
      if (!e || e.ver !== d.ver || !this.waiting.has(d.id)) {
        this.stats.dropped++;
        continue;
      }
      e.res = d.res;
      this.regions.set(d.id, d.res.region);
      this.waiting.delete(d.id);
      this.stats.accepted++;
      n++;
    }
    if (n) this.notify();
    return n;
  }

  private notify() {
    for (const cb of [...this.subs]) cb();
  }

  /* ------------------------------------------------------- commit sync */

  /**
   * Avoid connectors a commit changing `fresh` (id → its new state, `undefined` if deleted) can
   * re-route: those whose region meets the shape's old or new box.
   */
  affected(fresh: Map<string, Shape | undefined>): Set<string> {
    const out = new Set<string>();
    if (!this.avoid.size) return out;
    for (const [id, s] of fresh) {
      const boxes = [this.obstacles.get(id), s && isObstacle(s) ? normal(bbox(s)) : null];
      for (const b of boxes) if (b) for (const e of this.regions.search(b)) out.add(e);
    }
    return out;
  }

  /**
   * A `syncArrows` hook that routes avoid connectors against the indexed obstacles with the
   * shapes in `fresh` at their committed state, so the stored `pts` is the route the next
   * render draws.
   */
  hook(fresh: Map<string, Shape | undefined>): RouteHook {
    return (s, lookup) => {
      const ends = avoidEnds(s, lookup);
      if (!ends) return null;
      return routeOrthogonal(ends.a, ends.b, (R) => this.query(R, fresh)).pts;
    };
  }
}

/* ------------------------------------------------------------ scheduler */

/**
 * Routes pending connectors off the critical path, on the main thread, `CHUNK` jobs per task.
 * `schedule(delay)` runs one batch after `delay` ms (coalesced: the throttle while dragging); a
 * new batch cancels the one before. A worker is not used yet (Phase 3, if measured cost needs it):
 * jobs are already self-contained (`runJob`), so moving them is a transport change only.
 */
export class RouteScheduler {
  static CHUNK = 8;
  private batch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private router: AvoidRouter) {}

  schedule(delay = 0) {
    if (this.timer || !this.router.pending.size) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, delay);
  }

  /** Start a batch now with the current pending jobs (cancels any running batch). */
  run() {
    const jobs = this.router.jobs();
    if (!jobs.length) return;
    const b = ++this.batch;
    let i = 0;
    const step = () => {
      if (b !== this.batch) return; // cancelled by a newer batch
      const done = jobs.slice(i, i + RouteScheduler.CHUNK).map(runJob);
      i += RouteScheduler.CHUNK;
      this.router.accept(done);
      if (i < jobs.length) setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  /** Drop the running batch and any scheduled one. */
  cancel() {
    this.batch++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
