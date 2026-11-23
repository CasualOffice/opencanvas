// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Semantic edges (DGM-04, ADR-045): a connector read as `source → target` between node ports,
// written back as the legacy arrow fields (`start`/`end` bindings, `route`, `via`, `text`), so
// the stored document stays readable by 0.1.x clients and the Rust exporter.
//
// Geometry is derived, never the source of truth: `pts` keeps the last resolved path for readers
// that ignore bindings. `createArrowResolver` re-resolves only connectors whose own shape or
// bound shapes changed (by object identity, which `BoardProjection` keeps for unchanged shapes).
//
// Orphan policy: an end bound to a node that is gone (deleted, possibly concurrently with the
// bind) keeps its binding, so undo or a late sync can restore the link, and draws from its
// stored `pts` end, as `resolveArrow` always has. `orphanEnds` lists such ends.
import type { Pt, Shape } from "./model";
import { isBinding, resolveArrow, viaOf, type Binding } from "./connectors";
import { bindingPort, isLegacyPort, anchorFor } from "./ports";

export interface EdgeEnd {
  nodeId: string;
  portId: string;
}

export interface DiagramEdge {
  id: string;
  source?: EdgeEnd;
  target?: EdgeEnd;
  /** `orthogonal` is stored as `route: "elbow"`. */
  route: "straight" | "orthogonal";
  /** User waypoints (`via`); generated bends are never stored here. */
  waypoints: Pt[];
  label?: string;
}

const endOf = (b: unknown): EdgeEnd | undefined => (isBinding(b) ? { nodeId: b.shapeId, portId: bindingPort(b) } : undefined);

/** A connector as a semantic edge; `null` for any other shape. */
export function edgeOf(s: Shape): DiagramEdge | null {
  if (s.type !== "arrow") return null;
  const e: DiagramEdge = { id: s.id, route: s.route === "elbow" ? "orthogonal" : "straight", waypoints: viaOf(s) };
  const source = endOf(s.start), target = endOf(s.end);
  if (source) e.source = source;
  if (target) e.target = target;
  if (typeof s.text === "string" && s.text) e.label = s.text;
  return e;
}

function bindingFor(end: EdgeEnd, byId: Map<string, Shape>): Binding {
  const node = byId.get(end.nodeId);
  if (isLegacyPort(end.portId)) return { shapeId: end.nodeId, anchor: end.portId };
  return { shapeId: end.nodeId, anchor: node ? anchorFor(node, end.portId) : "center", port: end.portId };
}

/**
 * Legacy arrow fields for (part of) an edge, for `updateShape`. Only the given fields are
 * written; `source: undefined` or `target: undefined` present as keys unbind that end.
 */
export function edgePatch(e: Partial<Omit<DiagramEdge, "id">>, byId: Map<string, Shape>): Partial<Shape> {
  const out: Partial<Shape> = {};
  if ("source" in e) out.start = e.source ? bindingFor(e.source, byId) : undefined;
  if ("target" in e) out.end = e.target ? bindingFor(e.target, byId) : undefined;
  if (e.route) out.route = e.route === "orthogonal" ? "elbow" : "straight";
  if (e.waypoints) out.via = e.waypoints.length ? e.waypoints.map((p) => [p[0], p[1]] as Pt) : undefined;
  if ("label" in e) out.text = e.label || undefined;
  return out;
}

/** Ends bound to a node that isn't on the board. */
export function orphanEnds(shapes: Shape[]): { edgeId: string; end: "start" | "end"; nodeId: string }[] {
  const ids = new Set(shapes.map((s) => s.id));
  const out: { edgeId: string; end: "start" | "end"; nodeId: string }[] = [];
  for (const s of shapes) {
    if (s.type !== "arrow") continue;
    for (const end of ["start", "end"] as const) {
      const b = s[end];
      if (isBinding(b) && !ids.has(b.shapeId)) out.push({ edgeId: s.id, end, nodeId: b.shapeId });
    }
  }
  return out;
}

/** Node id → ids of the connectors bound to it, kept up to date shape by shape. */
export class EdgeIndex {
  private byNode = new Map<string, Set<string>>();
  private ends = new Map<string, string[]>();

  load(shapes: Iterable<Shape>) {
    this.byNode.clear();
    this.ends.clear();
    for (const s of shapes) this.set(s);
  }

  /** Add or update one shape (non-connectors are ignored). */
  set(s: Shape) {
    this.delete(s.id);
    if (s.type !== "arrow") return;
    const nodes = [s.start, s.end].filter(isBinding).map((b) => b.shapeId);
    if (!nodes.length) return;
    this.ends.set(s.id, nodes);
    for (const n of nodes) {
      let set = this.byNode.get(n);
      if (!set) this.byNode.set(n, (set = new Set()));
      set.add(s.id);
    }
  }

  delete(id: string) {
    const nodes = this.ends.get(id);
    if (!nodes) return;
    this.ends.delete(id);
    for (const n of nodes) {
      const set = this.byNode.get(n);
      set?.delete(id);
      if (set && !set.size) this.byNode.delete(n);
    }
  }

  edgesAt(nodeId: string): ReadonlySet<string> {
    return this.byNode.get(nodeId) ?? new Set();
  }

  /** Connectors whose geometry depends on any of `ids` (the connectors themselves included). */
  affectedBy(ids: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const id of ids) {
      if (this.ends.has(id)) out.add(id);
      for (const e of this.byNode.get(id) ?? []) out.add(e);
    }
    return out;
  }
}

export interface ArrowResolver {
  (raw: Shape[]): Shape[];
  /** `resolved`: connectors resolved so far (re-used ones are not counted). */
  readonly stats: { resolved: number };
}

/**
 * `withResolvedArrows` that remembers its last result: a connector is resolved again only when
 * it, or a shape it is bound to, is a different object than last time. Equal output, and
 * unchanged connectors keep their objects (so their views skip re-rendering).
 */
export function createArrowResolver(): ArrowResolver {
  type Entry = { s: Shape; a?: Shape; b?: Shape; out: Shape };
  let cache = new Map<string, Entry>();
  let byId = new Map<string, Shape>();
  let pos = new Map<string, number>();
  const edges = new EdgeIndex();
  let prevIn: Shape[] | null = null;
  let prevOut: Shape[] = [];
  const stats = { resolved: 0 };
  const needs = (s: Shape) => s.type === "arrow" && !!(s.start || s.end || s.route || s.via);
  /** The resolved form of `s`: the cached one while it and its bound shapes are unchanged. */
  const one = (s: Shape): Shape => {
    const a = isBinding(s.start) ? byId.get(s.start.shapeId) : undefined;
    const b = isBinding(s.end) ? byId.get(s.end.shapeId) : undefined;
    const c = cache.get(s.id);
    if (c && c.s === s && c.a === a && c.b === b) return c.out;
    stats.resolved++;
    const out = { ...s, pts: resolveArrow(s, byId) };
    cache.set(s.id, { s, a, b, out });
    return out;
  };
  const full = (raw: Shape[]): Shape[] => {
    byId = new Map(raw.map((s) => [s.id, s]));
    pos = new Map(raw.map((s, i) => [s.id, i]));
    edges.load(raw);
    const live = new Set<string>();
    const out = raw.map((s) => {
      if (!needs(s)) return s;
      live.add(s.id);
      return one(s);
    });
    for (const k of cache.keys()) if (!live.has(k)) cache.delete(k);
    return out;
  };
  /** Same ids in the same places, some shapes replaced: touch only those and their connectors. */
  const patch = (raw: Shape[], prev: Shape[]): Shape[] | null => {
    const changed: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === prev[i]) continue;
      if (raw[i].id !== prev[i].id) return null;
      changed.push(i);
    }
    const ids: string[] = [];
    for (const i of changed) {
      byId.set(raw[i].id, raw[i]);
      edges.set(raw[i]);
      ids.push(raw[i].id);
    }
    const out = prevOut.slice();
    for (const i of changed) out[i] = raw[i];
    for (const id of edges.affectedBy(ids)) {
      const i = pos.get(id)!;
      const s = raw[i];
      if (!needs(s)) {
        cache.delete(id);
        continue;
      }
      out[i] = one(s);
    }
    for (const i of changed) if (!needs(raw[i])) cache.delete(raw[i].id);
    // Connectors that just stopped needing resolution are plain again; ones that started are new.
    for (const i of changed) if (needs(raw[i])) out[i] = one(raw[i]);
    return out;
  };
  const run = (raw: Shape[]): Shape[] => {
    if (raw === prevIn) return prevOut;
    const out = (prevIn && raw.length === prevIn.length && patch(raw, prevIn)) || full(raw);
    prevIn = raw;
    if (out.length === prevOut.length && out.every((s, i) => s === prevOut[i])) return prevOut;
    prevOut = out;
    return out;
  };
  return Object.assign(run, { stats });
}
