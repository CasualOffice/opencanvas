// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Bound connectors: arrows whose ends attach to an anchor of another shape.
//
// An arrow keeps `pts` (the last known geometry, so readers that ignore bindings still draw
// something sensible) plus optional `start` / `end` bindings `{ shapeId, anchor, port? }` and
// `route`. A `port` the bound shape stores is where the end attaches; else `anchor` (ports.ts).
// The rendered geometry is always derived from the bound shapes, so a shape moved by one peer
// and an arrow re-bound by another converge without anyone rewriting the other's data.
import * as Y from "yjs";
import { bbox, getBoardMap, moveShapes, readShapes, type Pt, type Shape, type ShapeType } from "./model";
import { portEnd } from "./ports";

export type Anchor = "top" | "right" | "bottom" | "left" | "center";
export const ANCHORS: Anchor[] = ["top", "right", "bottom", "left", "center"];
export interface Binding {
  shapeId: string;
  /** Always set, also next to `port`: 0.1.x clients and the Rust exporter draw the end here. */
  anchor: Anchor;
  /** Optional named port (ADR-045). A legacy anchor id is never written here. */
  port?: string;
}
export type ArrowRoute = "straight" | "elbow";

/** Shapes an arrow end can attach to. */
export const BINDABLE: ShapeType[] = ["sticky", "rect", "ellipse", "diamond", "text", "swatch", "image"];

export function isBinding(b: unknown): b is Binding {
  return !!b && typeof b === "object" && typeof (b as Binding).shapeId === "string" && ANCHORS.includes((b as Binding).anchor);
}

export function anchorPoint(s: Shape, a: Anchor): Pt {
  const [x0, y0, x1, y1] = bbox(s);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const p: Pt = a === "top" ? [cx, y0] : a === "bottom" ? [cx, y1] : a === "left" ? [x0, cy] : a === "right" ? [x1, cy] : [cx, cy];
  return turned(s, p);
}

/** The shape's rotation in degrees (BRD-22), 0 when it has none. */
const degOf = (s: Shape) => (typeof s.rot === "number" && Number.isFinite(s.rot) && !s.pts?.length ? s.rot : 0);
/** Point `p`, given in the shape's own (unturned) frame, turned with the shape about its centre (BRD-35). */
export function turned(s: Shape, p: Pt, sign = 1): Pt {
  const deg = degOf(s) * sign;
  if (!deg) return p;
  const [x0, y0, x1, y1] = bbox(s);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const r = (deg * Math.PI) / 180, co = Math.cos(r), si = Math.sin(r);
  const dx = p[0] - cx, dy = p[1] - cy;
  return [cx + dx * co - dy * si, cy + dx * si + dy * co];
}

/** Point where the ray from the shape's centre towards `to` leaves its outline. */
export function boundaryToward(s: Shape, to: Pt): Pt {
  // A turned shape: find the point in its own frame, then turn it back (BRD-35).
  if (degOf(s)) return turned(s, boundaryToward({ ...s, rot: undefined }, turned(s, to, -1)));
  const [x0, y0, x1, y1] = bbox(s);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const hw = Math.max(1, (x1 - x0) / 2), hh = Math.max(1, (y1 - y0) / 2);
  const dx = to[0] - cx, dy = to[1] - cy;
  if (!dx && !dy) return [cx, cy];
  let t: number;
  if (s.type === "ellipse") t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  else if (s.type === "diamond") t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(Math.abs(dx) ? hw / Math.abs(dx) : Infinity, Math.abs(dy) ? hh / Math.abs(dy) : Infinity);
  t = Math.min(1, t);
  return [cx + dx * t, cy + dy * t];
}

/**
 * The binding an arrow end dragged to `p` would make with shape `s`: its anchor closest to `p`,
 * when `s` is bindable and its box (grown by `pad`) contains `p`; else `null`.
 */
export function snapOn(s: Shape, p: Pt, pad = 18): Binding | null {
  if (!BINDABLE.includes(s.type)) return null;
  const [x0, y0, x1, y1] = bbox(s);
  if (p[0] < x0 - pad || p[0] > x1 + pad || p[1] < y0 - pad || p[1] > y1 + pad) return null;
  let best: Anchor = "center", bd = Infinity;
  for (const a of ANCHORS) {
    const q = anchorPoint(s, a);
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  return { shapeId: s.id, anchor: best };
}

/**
 * The binding an arrow end dragged to `p` should snap to: the topmost bindable shape whose box
 * (grown by `pad`) contains `p`, and its anchor closest to `p`. `null` when nothing is near.
 * (`SceneIndex.snap` gives the same through the spatial index.)
 */
export function snapTarget(shapes: Shape[], p: Pt, pad = 18, exclude?: string): Binding | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (shapes[i].id === exclude) continue;
    const b = snapOn(shapes[i], p, pad);
    if (b) return b;
  }
  return null;
}

const horiz = (a: Anchor) => a === "left" || a === "right";
function facing(s: Shape, other: Pt): Anchor {
  const [x0, y0, x1, y1] = bbox(s);
  const dx = other[0] - (x0 + x1) / 2, dy = other[1] - (y0 + y1) / 2;
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "right" : "left") : dy >= 0 ? "bottom" : "top";
}

/** Orthogonal route from `a` to `b`. Sides say which way each end leaves its shape. */
export function elbow(a: Pt, b: Pt, sa?: Anchor, sb?: Anchor): Pt[] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const hA = sa && sa !== "center" ? horiz(sa) : Math.abs(dx) >= Math.abs(dy);
  const hB = sb && sb !== "center" ? horiz(sb) : hA;
  let out: Pt[];
  if (hA && hB) {
    const mx = (a[0] + b[0]) / 2;
    out = [a, [mx, a[1]], [mx, b[1]], b];
  } else if (!hA && !hB) {
    const my = (a[1] + b[1]) / 2;
    out = [a, [a[0], my], [b[0], my], b];
  } else if (hA) out = [a, [b[0], a[1]], b];
  else out = [a, [a[0], b[1]], b];
  return tidy(out);
}

const eq = (u: number, v: number) => Math.abs(u - v) < 0.01;

/** Drop repeated points, then middle points on a straight run. */
function tidy(out: Pt[]): Pt[] {
  const dedup = out.filter((p, i) => i === 0 || !eq(p[0], out[i - 1][0]) || !eq(p[1], out[i - 1][1]));
  return dedup.filter((p, i) => {
    if (i === 0 || i === dedup.length - 1) return true;
    const [u, w] = [dedup[i - 1], dedup[i + 1]];
    return !((eq(u[0], p[0]) && eq(p[0], w[0])) || (eq(u[1], p[1]) && eq(p[1], w[1])));
  });
}

/**
 * Orthogonal route through `pts` (ends and waypoints). Each leg is an L with one corner: the
 * first leaves along the start side's axis (else its longer axis), each next leg leaves at a
 * right angle to how the previous one arrived, and the last enters along the end side's axis.
 */
export function elbowVia(pts: Pt[], sa?: Anchor, sb?: Anchor): Pt[] {
  if (pts.length < 2) return pts;
  const n = pts.length;
  let h = sa && sa !== "center" ? horiz(sa) : Math.abs(pts[1][0] - pts[0][0]) >= Math.abs(pts[1][1] - pts[0][1]);
  const out: Pt[] = [pts[0]];
  for (let i = 0; i < n - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    if (i === n - 2 && sb && sb !== "center" && h === horiz(sb)) {
      // The last leg must leave and arrive along the same axis: two corners at the midpoint.
      if (h) out.push([(p[0] + q[0]) / 2, p[1]], [(p[0] + q[0]) / 2, q[1]], q);
      else out.push([p[0], (p[1] + q[1]) / 2], [q[0], (p[1] + q[1]) / 2], q);
      break;
    }
    out.push(h ? [q[0], p[1]] : [p[0], q[1]], q);
    h = h ? !eq(q[1], p[1]) : eq(q[0], p[0]);
  }
  return tidy(out);
}

/** An arrow's manual waypoints (`via`): pairs of numbers, anything else read as 0 (as the Rust reader does). */
export function viaOf(s: Shape): Pt[] {
  if (!Array.isArray(s.via)) return [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return s.via.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [num(p[0]), num(p[1])] as Pt);
}

const r1 = (p: Pt): Pt => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];

/** Shapes by id: a `Map`, or anything with its `get`. */
export type ShapeLookup = { get(id: string): Shape | undefined };

/**
 * Draws an elbow connector without waypoints between ends `a` and `b` (rounded, as the elbow
 * gets them) leaving from sides `sa`/`sb` (none for a free end); `null` = the plain elbow.
 * The obstacle router plugs in here (routing.ts).
 */
export type ElbowHook = (a: Pt, sa: Exclude<Anchor, "center"> | undefined, b: Pt, sb: Exclude<Anchor, "center"> | undefined) => Pt[] | null;

/** A connector stored as obstacle-avoiding (ADR-047: `route: "elbow"` + `routing: "avoid"`). */
export const isAvoid = (s: Shape) => s.type === "arrow" && s.route === "elbow" && s.routing === "avoid";

/** The points an arrow is drawn with, following any bound shapes. */
export function resolveArrow(s: Shape, byId: ShapeLookup, onElbow?: ElbowHook): Pt[] {
  const pts = s.pts ?? [];
  if (pts.length < 2 && !(s.start && s.end)) return pts;
  const bs = isBinding(s.start) ? byId.get(s.start.shapeId) : undefined;
  const be = isBinding(s.end) ? byId.get(s.end.shapeId) : undefined;
  const route = s.route;
  const via = viaOf(s);
  if (!bs && !be && !route && !via.length) return pts;
  let a: Pt = pts[0] ?? [0, 0];
  let b: Pt = pts[pts.length - 1] ?? a;
  let aa: Anchor | undefined = bs ? (s.start as Binding).anchor : undefined;
  let ab: Anchor | undefined = be ? (s.end as Binding).anchor : undefined;
  // A stored custom port (DGM-12): its point, leaving from its side, like a side anchor.
  const pa = bs ? portEnd(bs, s.start as Binding) : null;
  const pb = be ? portEnd(be, s.end as Binding) : null;
  if (pa) [a, aa] = [pa.p, pa.side];
  else if (bs && aa !== "center") a = anchorPoint(bs, aa!);
  if (pb) [b, ab] = [pb.p, pb.side];
  else if (be && ab !== "center") b = anchorPoint(be, ab!);
  const rawA = bs && aa === "center" ? anchorPoint(bs, "center") : a;
  const rawB = be && ab === "center" ? anchorPoint(be, "center") : b;
  if (via.length) {
    // Centre-bound ends aim at the nearest waypoint instead of the other end.
    const fa = via[0], fb = via[via.length - 1];
    if (route === "elbow") {
      if (bs && aa === "center") {
        aa = facing(bs, fa);
        a = anchorPoint(bs, aa);
      }
      if (be && ab === "center") {
        ab = facing(be, fb);
        b = anchorPoint(be, ab);
      }
      return elbowVia([r1(a), ...via.map(r1), r1(b)], aa, ab);
    }
    if (bs && aa === "center") a = boundaryToward(bs, fa);
    if (be && ab === "center") b = boundaryToward(be, fb);
    return [r1(a), ...via.map(r1), r1(b)];
  }
  if (route === "elbow") {
    if (bs && aa === "center") {
      aa = facing(bs, rawB);
      a = anchorPoint(bs, aa);
    }
    if (be && ab === "center") {
      ab = facing(be, a);
      b = anchorPoint(be, ab);
    }
    const ra = r1(a), rb = r1(b);
    return onElbow?.(ra, aa as Exclude<Anchor, "center"> | undefined, rb, ab as Exclude<Anchor, "center"> | undefined) ?? elbow(ra, rb, aa, ab);
  }
  if (bs && aa === "center") a = boundaryToward(bs, rawB);
  if (be && ab === "center") b = boundaryToward(be, rawA);
  return [r1(a), r1(b)];
}

/** Shapes with every arrow's `pts` replaced by its resolved geometry (for bounds, export, hit boxes). */
export function withResolvedArrows(shapes: Shape[]): Shape[] {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  return shapes.map((s) => (s.type === "arrow" && (s.start || s.end || s.route || s.via) ? { ...s, pts: resolveArrow(s, byId) } : s));
}

/**
 * ADR-047 point 3: an `avoid` connector's stored route (`pts`, written by the commit-time sync)
 * while it still starts and ends where its plain elbow would and every leg is axis-aligned;
 * otherwise `null` (the plain elbow). Exporters only: the screen routes live (routing.ts).
 */
export function storedRoute(s: Shape): ElbowHook | undefined {
  if (!isAvoid(s)) return undefined;
  return (a, _sa, b) => {
    const p = s.pts;
    if (!p || p.length < 2) return null;
    const at = (q: Pt, r: Pt) => q[0] === r[0] && q[1] === r[1];
    if (!at(p[0], a) || !at(p[p.length - 1], b)) return null;
    for (let i = 1; i < p.length; i++) if (p[i][0] !== p[i - 1][0] && p[i][1] !== p[i - 1][1]) return null;
    return p.map((q): Pt => [q[0], q[1]]);
  };
}

/** `withResolvedArrows` for exporters: `avoid` connectors keep a current stored route (`storedRoute`). */
export function exportResolvedArrows(shapes: Shape[]): Shape[] {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  return shapes.map((s) => (s.type === "arrow" && (s.start || s.end || s.route || s.via) ? { ...s, pts: resolveArrow(s, byId, storedRoute(s)) } : s));
}

export const samePts = (a: Pt[] | undefined, b: Pt[]) => !!a && a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);

/** A connector whose stored `pts` the commit-time sync keeps in step with its shapes. */
export const syncsPts = (s: Shape) => s.type === "arrow" && (isBinding(s.start) || isBinding(s.end) || viaOf(s).length > 0);

/**
 * Rewrite the stored `pts` of bound arrows to match their shapes, so readers that ignore bindings
 * (server export, previews) stay close. Only arrows whose geometry changed are written.
 * Reads the whole board; the editor uses `syncArrows` with the connectors a change can affect.
 */
export function syncBoundArrows(doc: Y.Doc, boardId: string, origin?: unknown) {
  const m = getBoardMap(doc, boardId);
  if (!m) return;
  const shapes = readShapes(m);
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const moves: { id: string; patch: Partial<Shape> }[] = [];
  for (const s of shapes) {
    if (!syncsPts(s)) continue;
    const pts = resolveArrow(s, byId);
    if (pts.length >= 2 && !samePts(s.pts, pts)) moves.push({ id: s.id, patch: { pts } });
  }
  if (moves.length) moveShapes(doc, boardId, moves, origin);
}

/** Optional router for connectors with `routing: "avoid"` (routing.ts); `null` falls back to `resolveArrow`. */
export type RouteHook = (s: Shape, byId: ShapeLookup) => Pt[] | null;

/**
 * `syncBoundArrows` for the given shapes only (DGM-11): each id that is a connector is resolved
 * from the current Yjs state (it and the shapes it is bound to are read, nothing else) and its
 * `pts` rewritten when they differ. Ids of other shapes are ignored, so callers can pass the
 * changed shapes plus the connectors bound to them (`EdgeIndex.affectedBy`). Returns the number
 * of shapes read.
 */
export function syncArrows(doc: Y.Doc, boardId: string, ids: Iterable<string>, origin?: unknown, route?: RouteHook): number {
  const m = getBoardMap(doc, boardId);
  const ys = m?.get("shapes");
  if (!(ys instanceof Y.Map)) return 0;
  const read = new Map<string, Shape | undefined>();
  const get = (id: string): Shape | undefined => {
    if (read.has(id)) return read.get(id);
    const y = ys.get(id);
    const s = y instanceof Y.Map ? ({ ...(y.toJSON() as Shape), id } as Shape) : undefined;
    read.set(id, s);
    return s;
  };
  const lookup: ShapeLookup = { get };
  const moves: { id: string; patch: Partial<Shape> }[] = [];
  const done = new Set<string>();
  for (const id of ids) {
    if (done.has(id)) continue;
    done.add(id);
    const s = get(id);
    if (!s || !syncsPts(s)) continue;
    const pts = route?.(s, lookup) ?? resolveArrow(s, lookup);
    if (pts.length >= 2 && !samePts(s.pts, pts)) moves.push({ id: s.id, patch: { pts } });
  }
  if (moves.length) moveShapes(doc, boardId, moves, origin);
  return read.size;
}

