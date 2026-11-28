// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Auto-layout (DGM-14.6, S6, ADR-047 §5). Pure: shapes + options in, proposed moves out. Dagre is
// passed in (loaded lazily by `load.ts`), so this file adds nothing to any bundle by itself.
// Deterministic: nodes, parents and edges are given to Dagre sorted by id, so the same board and
// options give the same positions on every machine.
import { bbox, type Pt, type Shape } from "../../model";
import type { Anchor, Binding } from "../../connectors";
import { isContainer } from "../../kinds";

export type LayoutDirection = "down" | "right";
export type LayoutSpacing = "compact" | "normal" | "roomy";
export type LayoutScope = { kind: "all" } | { kind: "selection"; ids: string[] } | { kind: "container"; id: string };

export interface LayoutOptions {
  direction: LayoutDirection;
  spacing: LayoutSpacing;
  scope: LayoutScope;
  /** Keep shapes in their containers (containers are laid out around their children). */
  keepContainers: boolean;
  /** Keep connector waypoints (`via`). Off by default (6a): connectors are routed again. */
  keepBends: boolean;
}

export const DEFAULT_LAYOUT: LayoutOptions = { direction: "down", spacing: "normal", scope: { kind: "all" }, keepContainers: true, keepBends: false };

const GAPS: Record<LayoutSpacing, { node: number; rank: number }> = {
  compact: { node: 24, rank: 40 },
  normal: { node: 48, rank: 72 },
  roomy: { node: 80, rank: 120 },
};
/** Space between a container's edge and its children (room for its label at the top). */
const PAD = 24;

/** The parts of `@dagrejs/dagre` used here (its default export). */
export interface DagreLike {
  graphlib: { Graph: new (o?: { compound?: boolean; multigraph?: boolean }) => DagreGraph };
  layout: (g: DagreGraph) => void;
}
interface DagreGraph {
  setGraph(o: object): void;
  setDefaultEdgeLabel(f: () => object): void;
  setNode(id: string, o: object): void;
  setParent(id: string, parent: string): void;
  setEdge(v: string, w: string, o?: object, name?: string): void;
  node(id: string): { x: number; y: number; width: number; height: number };
}

export interface LayoutMove {
  id: string;
  /** Bounding boxes, x / y / width / height (what the preview draws). */
  from: [number, number, number, number];
  to: [number, number, number, number];
  /** The fields to write: x / y (and w / h for containers); text keeps its own size. */
  patch: Partial<Pick<Shape, "x" | "y" | "w" | "h">>;
}

export interface LayoutPlan {
  moves: LayoutMove[];
  /** Connectors between laid-out shapes (their `via` is cleared unless bends are kept). */
  connectors: string[];
  /** Shapes that moved (excluding containers) and containers that changed. */
  shapes: number;
  containers: number;
  /** BRD-09: shapes drawn inside a frame that did not name it yet; applying records `props.parent`. */
  parents: [string, string][];
  /** BRD-09: loose connector ends that touched a shape; applying binds them, so they follow. */
  binds: { id: string; start?: Binding; end?: Binding }[];
}

const NODE_TYPES = new Set(["sticky", "rect", "ellipse", "diamond", "text", "image", "swatch"]);
const isNode = (s: Shape) => NODE_TYPES.has(s.type) && typeof s.x === "number" && typeof s.y === "number";
const parentOf = (s: Shape) => (typeof s.props?.parent === "string" ? (s.props.parent as string) : null);
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const r = (n: number) => Math.round(n);
/** A drawn frame: a container kind, or a rectangle with a corner label or a dashed outline. */
const isFrame = (s: Shape) => isContainer(s) || (s.type === "rect" && (!!s.label || !!s.dashed));
/** x / y / width / height of what is drawn (text measures its own box). */
const boxOf = (s: Shape): [number, number, number, number] => {
  const [x0, y0, x1, y1] = bbox(s);
  return [x0, y0, x1 - x0, y1 - y0];
};
/** How far a connector end may be from a shape's outline and still count as touching it. */
const TOUCH = 12;

/** Shapes that are containers: anything another shape names as its `props.parent`. */
export function containerIds(shapes: Shape[]): Set<string> {
  const ids = new Set(shapes.map((s) => s.id));
  const out = new Set<string>();
  for (const s of shapes) {
    const p = parentOf(s);
    if (p && ids.has(p)) out.add(p);
  }
  return out;
}

/** BRD-09: for shapes inside a drawn frame without a `props.parent`, the smallest frame around them. */
export function framedBy(shapes: Shape[]): Map<string, string> {
  const nodes = shapes.filter(isNode);
  const frames = nodes.filter(isFrame).map((f) => [f, bbox(f)] as const);
  const out = new Map<string, string>();
  for (const s of nodes) {
    if (parentOf(s)) continue;
    const [x0, y0, x1, y1] = bbox(s);
    let best: [string, number] | null = null;
    for (const [f, b] of frames) {
      if (f.id === s.id || !(x0 >= b[0] && y0 >= b[1] && x1 <= b[2] && y1 <= b[3])) continue;
      const area = (b[2] - b[0]) * (b[3] - b[1]);
      if (!best || area < best[1]) best = [f.id, area];
    }
    if (best) out.set(s.id, best[0]);
  }
  // A frame can't sit inside a shape that sits inside it (equal boxes): drop such cycles.
  for (const [c, p] of out) if (out.get(p) === c) out.delete(c);
  return out;
}

/** BRD-09: the shape a loose connector end touches (on or just off its outline), and the side. */
function touching(p: Pt, nodes: Shape[]): Binding | undefined {
  let best: [Shape, Anchor, number] | null = null;
  for (const s of nodes) {
    const [x0, y0, x1, y1] = bbox(s);
    if (p[0] < x0 - TOUCH || p[0] > x1 + TOUCH || p[1] < y0 - TOUCH || p[1] > y1 + TOUCH) continue;
    const sides: [Anchor, number][] = [["left", Math.abs(p[0] - x0)], ["right", Math.abs(p[0] - x1)], ["top", Math.abs(p[1] - y0)], ["bottom", Math.abs(p[1] - y1)]];
    const [side, d] = sides.reduce((a, b) => (b[1] < a[1] ? b : a));
    if (d > TOUCH) continue;
    if (!best || d < best[2]) best = [s, side, d];
  }
  return best ? { shapeId: best[0].id, anchor: best[1] } : undefined;
}

/** Which shapes the layout arranges for `scope`. */
function scoped(shapes: Shape[], scope: LayoutScope, parent: (s: Shape) => string | null): Shape[] {
  const nodes = shapes.filter(isNode);
  if (scope.kind === "all") return nodes;
  if (scope.kind === "selection") {
    const want = new Set(scope.ids);
    return nodes.filter((s) => want.has(s.id));
  }
  // Inside a container: its descendants (not the container itself).
  const map = new Map(nodes.map((s) => [s.id, s]));
  const inside = (s: Shape) => {
    const seen = new Set<string>();
    for (let p = parent(s); p && !seen.has(p); p = parent(map.get(p) ?? ({} as Shape))) {
      if (p === scope.id) return true;
      seen.add(p);
    }
    return false;
  };
  return nodes.filter(inside);
}

/**
 * Proposed positions for `opts`. Shapes keep their sizes; containers (with `keepContainers`)
 * are resized around their children. The result is placed so its top-left is where the
 * arranged shapes' top-left was, so the diagram does not jump.
 */
export function computeLayout(dagre: DagreLike, shapes: Shape[], opts: LayoutOptions): LayoutPlan {
  // Drawn frames hold what is drawn inside them (only when containers are kept).
  const framed = opts.keepContainers ? framedBy(shapes) : new Map<string, string>();
  const parent = (s: Shape) => parentOf(s) ?? framed.get(s.id) ?? null;
  const containers = containerIds(shapes);
  for (const p of framed.values()) containers.add(p);
  const nodes = scoped(shapes, opts.scope, parent).sort(byId);
  const inScope = new Set(nodes.map((s) => s.id));
  const gaps = GAPS[opts.spacing];
  const g = new dagre.graphlib.Graph({ compound: opts.keepContainers, multigraph: true });
  g.setGraph({ rankdir: opts.direction === "right" ? "LR" : "TB", nodesep: gaps.node, ranksep: gaps.rank, edgesep: 16, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const compound = (s: Shape) => opts.keepContainers && containers.has(s.id);
  for (const s of nodes) {
    if (compound(s)) g.setNode(s.id, { paddingTop: PAD + 16, paddingBottom: PAD, paddingLeft: PAD, paddingRight: PAD });
    else {
      const [, , w, h] = boxOf(s);
      g.setNode(s.id, { width: w || 40, height: h || 40 });
    }
  }
  const parents: [string, string][] = [];
  if (opts.keepContainers)
    for (const s of nodes) {
      const p = parent(s);
      if (p && inScope.has(p) && containers.has(p)) {
        g.setParent(s.id, p);
        if (!parentOf(s)) parents.push([s.id, p]);
      }
    }
  // Loose connector ends that touch a laid-out shape become bound, so they follow it.
  const binds: LayoutPlan["binds"] = [];
  const scopeNodes = nodes;
  const ends = new Map<string, { start?: Binding; end?: Binding }>();
  for (const a of shapes.filter((s) => s.type === "arrow" && (s.pts?.length ?? 0) >= 2)) {
    const pts = a.pts!;
    const start = a.start?.shapeId ? undefined : touching(pts[0], scopeNodes);
    const end = a.end?.shapeId ? undefined : touching(pts[pts.length - 1], scopeNodes);
    if ((start || end) && (start?.shapeId ?? a.start?.shapeId) !== (end?.shapeId ?? a.end?.shapeId)) {
      binds.push({ id: a.id, ...(start ? { start } : {}), ...(end ? { end } : {}) });
      ends.set(a.id, { start, end });
    }
  }
  const connectors: string[] = [];
  const edges = shapes
    .filter((s) => s.type === "arrow")
    .map((a) => ({ id: a.id, v: a.start?.shapeId ?? ends.get(a.id)?.start?.shapeId, w: a.end?.shapeId ?? ends.get(a.id)?.end?.shapeId }))
    .filter((e): e is { id: string; v: string; w: string } => !!e.v && !!e.w)
    .sort(byId);
  for (const { id, v, w } of edges) {
    if (!inScope.has(v) || !inScope.has(w)) continue;
    connectors.push(id);
    // Dagre can't rank edges that touch a compound node; such connectors are kept but not ranked.
    if (v === w || compound(nodes.find((n) => n.id === v)!) || compound(nodes.find((n) => n.id === w)!)) continue;
    g.setEdge(v, w, {}, id);
  }
  dagre.layout(g);

  const from = new Map(nodes.map((s) => [s.id, boxOf(s)]));
  const raw = new Map<string, [number, number, number, number]>();
  for (const s of nodes) {
    const n = g.node(s.id);
    const [, , bw, bh] = from.get(s.id)!;
    const w = compound(s) ? n.width : bw;
    const h = compound(s) ? n.height : bh;
    raw.set(s.id, [n.x - w / 2, n.y - h / 2, w, h]);
  }
  // Keep the top-left of what was arranged.
  const minOf = (m: Map<string, [number, number, number, number]>, i: 0 | 1) => Math.min(...[...m.values()].map((b) => b[i]));
  const dx = nodes.length ? minOf(from, 0) - minOf(raw, 0) : 0;
  const dy = nodes.length ? minOf(from, 1) - minOf(raw, 1) : 0;
  const moves: LayoutMove[] = [];
  let moved = 0;
  let resized = 0;
  for (const s of nodes) {
    const b = raw.get(s.id)!;
    const to: [number, number, number, number] = [r(b[0] + dx), r(b[1] + dy), r(b[2]), r(b[3])];
    const f = from.get(s.id)!;
    const fr: [number, number, number, number] = [r(f[0]), r(f[1]), r(f[2]), r(f[3])];
    if (to.every((v, i) => v === fr[i])) continue;
    // x / y move by as much as the drawn box did (text's x / y is not its box corner).
    const patch: LayoutMove["patch"] = { x: r((s.x ?? 0) + to[0] - f[0]), y: r((s.y ?? 0) + to[1] - f[1]) };
    if (typeof s.w === "number") patch.w = to[2];
    if (typeof s.h === "number") patch.h = to[3];
    moves.push({ id: s.id, from: fr, to, patch });
    if (compound(s)) resized++;
    else moved++;
  }
  return { moves, connectors, shapes: moved, containers: resized, parents, binds };
}
