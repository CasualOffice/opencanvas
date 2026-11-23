// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Ports (DGM-04, ADR-045): named connection points on a shape. The five legacy anchors are
// ports `top right bottom left center` at exactly the points `anchorPoint` gives, so every
// existing binding is a port binding already. Custom ports sit at a fraction of the shape's box
// (`x`, `y` in 0..1) and may say which `side` they leave from.
//
// A binding to a custom port is written `{shapeId, anchor, port}`: `anchor` is the legacy anchor
// the port degrades to (its side, else the nearest side), which is where 0.1.x clients draw the
// end. The web and Rust renderers draw it at the port itself when the shape stores that port
// (`portEnd`, DGM-12, shared fixture `board-ports.json`), else at `anchor`.
import { bbox, type Pt, type Shape } from "./model";
import { anchorPoint, ANCHORS, type Anchor, type Binding } from "./connectors";
import { descriptorOf } from "./registry";

export type Side = "top" | "right" | "bottom" | "left";
export interface Port {
  id: string;
  side?: Side;
  /** Position as a fraction of the box width (0 = left edge, 1 = right edge). */
  x?: number;
  /** Position as a fraction of the box height (0 = top edge, 1 = bottom edge). */
  y?: number;
  /** Free-form role, e.g. `input` / `output`; not interpreted by the board. */
  kind?: string;
}

const SIDES: Side[] = ["top", "right", "bottom", "left"];

export const LEGACY_PORTS: readonly Readonly<Port>[] = Object.freeze([
  { id: "top", side: "top", x: 0.5, y: 0 },
  { id: "right", side: "right", x: 1, y: 0.5 },
  { id: "bottom", side: "bottom", x: 0.5, y: 1 },
  { id: "left", side: "left", x: 0, y: 0.5 },
  { id: "center", x: 0.5, y: 0.5 },
] as Port[]).map((p) => Object.freeze(p));

export const isLegacyPort = (id: unknown): id is Anchor => typeof id === "string" && (ANCHORS as string[]).includes(id);

const clamp01 = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined);

/** Custom ports from stored data: entries with a fresh string id (not a legacy anchor), clamped. Bad entries are skipped. */
export function readPorts(v: unknown): Port[] {
  if (!Array.isArray(v)) return [];
  const out: Port[] = [];
  const seen = new Set<string>();
  for (const p of v) {
    if (!p || typeof p !== "object") continue;
    const q = p as Record<string, unknown>;
    if (typeof q.id !== "string" || !q.id || q.id.length > 64 || isLegacyPort(q.id) || seen.has(q.id)) continue;
    seen.add(q.id);
    const port: Port = { id: q.id };
    if (SIDES.includes(q.side as Side)) port.side = q.side as Side;
    const x = clamp01(q.x), y = clamp01(q.y);
    if (x !== undefined) port.x = x;
    if (y !== undefined) port.y = y;
    if (typeof q.kind === "string") port.kind = q.kind;
    out.push(port);
  }
  return out;
}

/** Every port of a shape: the five legacy anchors, the kind's default ports, then the shape's own. */
export function portsOf(s: Shape): Port[] {
  const own = readPorts(s.ports);
  const ids = new Set(own.map((p) => p.id));
  const defaults = (descriptorOf(s).ports ?? []).filter((p) => !ids.has(p.id));
  return [...LEGACY_PORTS, ...defaults, ...own];
}

const findPort = (s: Shape, id: string) => portsOf(s).find((p) => p.id === id);

/** Where a port is, in board coordinates. Legacy anchors use `anchorPoint` exactly. */
export function portPoint(s: Shape, id: string): Pt | null {
  if (isLegacyPort(id)) return anchorPoint(s, id);
  const p = findPort(s, id);
  if (!p) return null;
  const [x0, y0, x1, y1] = bbox(s);
  return [x0 + (x1 - x0) * (p.x ?? 0.5), y0 + (y1 - y0) * (p.y ?? 0.5)];
}

/** The edge of box `b` nearest to point (x, y) (ties: top, right, bottom, left). */
function nearestSide(b: [number, number, number, number], x: number, y: number): Side {
  const [x0, y0, x1, y1] = b;
  const dist: Record<Side, number> = { top: y - y0, right: x1 - x, bottom: y1 - y, left: x - x0 };
  let best: Side = "top";
  for (const a of SIDES) if (dist[a] < dist[best]) best = a;
  return best;
}

/** The legacy anchor a port degrades to: itself, its side, else the side nearest to it. */
export function anchorFor(s: Shape, id: string): Anchor {
  if (isLegacyPort(id)) return id;
  const p = findPort(s, id);
  if (!p) return "center";
  if (p.side) return p.side;
  const [x, y] = portPoint(s, id)!;
  return nearestSide(bbox(s), x, y);
}

/**
 * Where a connector end bound with `b` attaches to `s` and which side it leaves from, when the
 * binding names a custom port stored on the shape itself (`s.ports`; DGM-12). `null` otherwise
 * (no `port`, a legacy id in it, or a port the shape doesn't store), and the end is drawn at
 * `anchor` as before. Only stored ports count, not a kind's registry defaults, because the Rust
 * renderer has no registry: both renderers must agree (`board-ports.json`). `makeNode` stores a
 * kind's default ports on the shape for that reason.
 */
export function portEnd(s: Shape, b: { port?: unknown }): { p: Pt; side: Side } | null {
  const id = b.port;
  if (typeof id !== "string" || !id || isLegacyPort(id)) return null;
  const port = readPorts(s.ports).find((q) => q.id === id);
  if (!port) return null;
  const box = bbox(s);
  const [x0, y0, x1, y1] = box;
  const p: Pt = [x0 + (x1 - x0) * (port.x ?? 0.5), y0 + (y1 - y0) * (port.y ?? 0.5)];
  return { p, side: port.side ?? nearestSide(box, p[0], p[1]) };
}

/** A binding to a port, with the legacy anchor older readers draw. */
export function bindingTo(s: Shape, portId: string): Binding {
  return isLegacyPort(portId) ? { shapeId: s.id, anchor: portId } : { shapeId: s.id, anchor: anchorFor(s, portId), port: portId };
}

/** The port a binding refers to: its `port` when set, else its legacy anchor. */
export function bindingPort(b: Binding): string {
  return typeof b.port === "string" && b.port ? b.port : b.anchor;
}

/** The port nearest to a point (ties go to the earlier port: legacy anchors first). */
export function nearestPort(s: Shape, p: Pt): Port {
  let best: Port = LEGACY_PORTS[4], bd = Infinity;
  for (const q of portsOf(s)) {
    const at = portPoint(s, q.id)!;
    const d = Math.hypot(at[0] - p[0], at[1] - p[1]);
    if (d < bd) (bd = d), (best = q);
  }
  return best;
}
