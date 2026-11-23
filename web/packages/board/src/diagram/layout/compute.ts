// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Auto-layout (DGM-14.6, S6, ADR-047 §5). Pure: shapes + options in, proposed moves out. Dagre is
// passed in (loaded lazily by `load.ts`), so this file adds nothing to any bundle by itself.
// Deterministic: nodes, parents and edges are given to Dagre sorted by id, so the same board and
// options give the same positions on every machine.
import type { Shape } from "../../model";

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
  from: [number, number, number, number];
  to: [number, number, number, number];
}

export interface LayoutPlan {
  moves: LayoutMove[];
  /** Connectors between laid-out shapes (their `via` is cleared unless bends are kept). */
  connectors: string[];
  /** Shapes that moved (excluding containers) and containers that changed. */
  shapes: number;
  containers: number;
}

const NODE_TYPES = new Set(["sticky", "rect", "ellipse", "diamond", "text", "image", "swatch"]);
const isNode = (s: Shape) => NODE_TYPES.has(s.type) && typeof s.x === "number" && typeof s.y === "number";
const parentOf = (s: Shape) => (typeof s.props?.parent === "string" ? (s.props.parent as string) : null);
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const r = (n: number) => Math.round(n);

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

/** Which shapes the layout arranges for `scope`. */
function scoped(shapes: Shape[], scope: LayoutScope): Shape[] {
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
    for (let p = parentOf(s); p && !seen.has(p); p = parentOf(map.get(p) ?? ({} as Shape))) {
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
  const containers = containerIds(shapes);
  const nodes = scoped(shapes, opts.scope).sort(byId);
  const inScope = new Set(nodes.map((s) => s.id));
  const gaps = GAPS[opts.spacing];
  const g = new dagre.graphlib.Graph({ compound: opts.keepContainers, multigraph: true });
  g.setGraph({ rankdir: opts.direction === "right" ? "LR" : "TB", nodesep: gaps.node, ranksep: gaps.rank, edgesep: 16, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const compound = (s: Shape) => opts.keepContainers && containers.has(s.id);
  for (const s of nodes) {
    if (compound(s)) g.setNode(s.id, { paddingTop: PAD + 16, paddingBottom: PAD, paddingLeft: PAD, paddingRight: PAD });
    else g.setNode(s.id, { width: s.w ?? 40, height: s.h ?? 40 });
  }
  if (opts.keepContainers)
    for (const s of nodes) {
      const p = parentOf(s);
      if (p && inScope.has(p) && containers.has(p)) g.setParent(s.id, p);
    }
  const connectors: string[] = [];
  const edges = shapes
    .filter((s) => s.type === "arrow" && s.start?.shapeId && s.end?.shapeId)
    .sort(byId);
  for (const a of edges) {
    const v = a.start!.shapeId;
    const w = a.end!.shapeId;
    if (!inScope.has(v) || !inScope.has(w)) continue;
    connectors.push(a.id);
    // Dagre can't rank edges that touch a compound node; such connectors are kept but not ranked.
    if (v === w || compound(nodes.find((n) => n.id === v)!) || compound(nodes.find((n) => n.id === w)!)) continue;
    g.setEdge(v, w, {}, a.id);
  }
  dagre.layout(g);

  const from = new Map(nodes.map((s) => [s.id, [s.x!, s.y!, s.w ?? 40, s.h ?? 40] as [number, number, number, number]]));
  const raw = new Map<string, [number, number, number, number]>();
  for (const s of nodes) {
    const n = g.node(s.id);
    const w = compound(s) ? n.width : (s.w ?? 40);
    const h = compound(s) ? n.height : (s.h ?? 40);
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
    if (to.every((v, i) => v === f[i])) continue;
    moves.push({ id: s.id, from: f, to });
    if (compound(s)) resized++;
    else moved++;
  }
  return { moves, connectors, shapes: moved, containers: resized };
}
