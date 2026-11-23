// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Benchmark fixtures for diagram-scale boards (DGM-01). Deterministic: the same options give
// the same document, shape ids included, on every machine.
//
//   nodes        number of box shapes (rect / ellipse / diamond / sticky, in turn)
//   edgeDensity  connectors per node (1.5 = the 1k nodes / 1.5k edges target in the design)
//   locality     share of edges between grid neighbours (the rest join random nodes)
//   elbowShare   share of connectors with `route: "elbow"`
//   seed         PRNG seed
import * as Y from "yjs";
import { boardsRoot, type Shape } from "../src/model";
import { ANCHORS, resolveArrow, type Anchor } from "../src/connectors";

export interface FixtureOptions {
  nodes: number;
  edgeDensity?: number;
  locality?: number;
  elbowShare?: number;
  seed?: number;
  boardId?: string;
}

export interface Fixture {
  doc: Y.Doc;
  boardId: string;
  nodeIds: string[];
  edgeIds: string[];
}

/** mulberry32: small, fast, deterministic. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = ["rect", "ellipse", "diamond", "sticky"] as const;
const GX = 220, GY = 160, W = 150, H = 90;

/** The fixture's shapes as plain objects, in paint order (nodes, then connectors). */
export function fixtureShapes(o: FixtureOptions): Shape[] {
  const { nodes, edgeDensity = 1.5, locality = 0.8, elbowShare = 0.5, seed = 1 } = o;
  const r = rng(seed);
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes)));
  const out: Shape[] = [];
  const pad = String(nodes).length;
  for (let i = 0; i < nodes; i++) {
    const type = KINDS[i % KINDS.length];
    const s: Shape = { id: "n" + String(i).padStart(pad, "0"), type, x: (i % cols) * GX, y: Math.floor(i / cols) * GY, w: W, h: H, text: `Node ${i}` };
    if (type === "sticky") s.fill = "ybpg"[i % 4];
    else if (i % 3 === 0) s.fill = "blue";
    out.push(s);
  }
  const byId = new Map(out.map((s) => [s.id, s]));
  const edges = Math.round(nodes * edgeDensity);
  const epad = String(edges).length;
  for (let k = 0; k < edges && nodes > 1; k++) {
    const a = Math.floor(r() * nodes);
    let b: number;
    if (r() < locality) {
      const near = [a + 1, a - 1, a + cols, a - cols].filter((x) => x >= 0 && x < nodes);
      b = near[Math.floor(r() * near.length)];
    } else {
      b = Math.floor(r() * nodes);
      if (b === a) b = (a + 1) % nodes;
    }
    const pick = (): Anchor => ANCHORS[Math.floor(r() * ANCHORS.length)];
    const s: Shape = {
      id: "e" + String(k).padStart(epad, "0"),
      type: "arrow",
      pts: [],
      start: { shapeId: out[a].id, anchor: pick() },
      end: { shapeId: out[b].id, anchor: pick() },
    };
    if (r() < elbowShare) s.route = "elbow";
    if (r() < 0.1) s.text = `edge ${k}`;
    s.pts = resolveArrow(s, byId);
    out.push(s);
  }
  return out;
}

/** A Y.Doc with one board holding the fixture (one transaction). */
export function makeFixture(o: FixtureOptions): Fixture {
  const doc = new Y.Doc();
  const boardId = o.boardId ?? "bench";
  const list = fixtureShapes(o);
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    boardsRoot(doc).set(boardId, m);
    const shapes = new Y.Map<Y.Map<unknown>>();
    const order = new Y.Array<string>();
    m.set("shapes", shapes);
    m.set("order", order);
    for (const s of list) {
      const y = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(s)) if (k !== "id" && v !== undefined) y.set(k, v);
      shapes.set(s.id, y);
    }
    order.push(list.map((s) => s.id));
  });
  return {
    doc,
    boardId,
    nodeIds: list.filter((s) => s.type !== "arrow").map((s) => s.id),
    edgeIds: list.filter((s) => s.type === "arrow").map((s) => s.id),
  };
}
