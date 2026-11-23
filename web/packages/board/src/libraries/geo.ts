// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Outline helpers for the shape libraries (DGM-14.7). They only build SVG path *strings* when a
// library module loads; the registry still receives plain data (ADR-045 §3). Every shape is our
// own drawing from first principles (owner policy: no vendor, brand or third-party stencil
// geometry).
//
// `at(w, h)` gives helpers that take board units of a shape drawn at its default size `w × h` and
// write path data in the registry's 100 × 100 box, so circles stay round and corners stay even at
// the default size. `G` is `at(100, 100)`.
import type { ShapeDescriptor } from "../registry";

/** One entry of a library: a descriptor without kind/version/library, plus its local name. */
export type Item = Omit<ShapeDescriptor, "kind" | "version" | "library"> & { name: string };

/**
 * A connector preset (crow's foot, Chen, BPMN message flow, mind-map branch…): the fields a new
 * connector gets. `ends` names the end markers `[start, end]`, kept in the connector's `props`;
 * a client that doesn't draw a marker draws the plain connector with the same route and dash
 * (ADR-045 §5).
 */
export interface ConnectorPreset {
  id: string;
  label: string;
  keywords?: string[];
  route?: "straight" | "elbow";
  dashed?: boolean;
  ends?: [string, string];
}

export interface LibraryData {
  id: string;
  name: string;
  /** Lucide icon name for the panel header. */
  icon: string;
  items: Item[];
  /** Off by default: listed in the panel only after `setLibraryEnabled(id, true)` (BPMN). */
  flag?: boolean;
  connectors?: ConnectorPreset[];
}

/** A number for path data: at most two decimals, never exponent notation. */
export const n = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
};

function pairs(a: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + 1 < a.length; i += 2) out.push([a[i]!, a[i + 1]!]);
  return out;
}

export interface Geo {
  /** Rectangle. */
  R(x: number, y: number, w: number, h: number): string;
  /** Rounded rectangle. */
  RR(x: number, y: number, w: number, h: number, r: number): string;
  /** Ellipse; `rev` runs the other way round, which cuts a hole in a filled outline. */
  E(cx: number, cy: number, rx: number, ry?: number, rev?: boolean): string;
  /** Closed polygon. */
  P(...p: number[]): string;
  /** Open polyline (filled like a closed one: use `T` for a bare line). */
  PL(...p: number[]): string;
  /** A bare line through the points: out and back, so it encloses no area and draws no fill. */
  T(...p: number[]): string;
  /** Straight segment. */
  L(x1: number, y1: number, x2: number, y2: number): string;
  /** Bare circular arc from a0 to a1 (degrees, 0 = east, clockwise), out and back (no fill). */
  A(cx: number, cy: number, r: number, a0: number, a1: number): string;
  /** Pie slice from a0 to a1 (degrees). */
  PIE(cx: number, cy: number, r: number, a0: number, a1: number): string;
  /** Ring sector between radii r0 < r1 from a0 to a1. */
  BAND(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string;
  /** Regular polygon with k corners, the first at `rot` degrees (-90 = up). */
  REG(k: number, cx: number, cy: number, r: number, rot?: number): string;
  /** Star with k points. */
  STAR(k: number, cx: number, cy: number, r: number, inner?: number): string;
  /** Dashed straight line (separate dashes). */
  DL(x1: number, y1: number, x2: number, y2: number, dash?: number, gap?: number): string;
  /** Dashed rectangle outline. */
  DR(x: number, y: number, w: number, h: number, dash?: number, gap?: number): string;
  /** Dashed ellipse outline (bare arcs). */
  DE(cx: number, cy: number, rx: number, ry?: number, k?: number): string;
  /** Label box `[x, y, w, h]` in the 100 × 100 box, from board units. */
  box(x: number, y: number, w: number, h: number): [number, number, number, number];
}

export function at(W: number, H: number): Geo {
  const sx = 100 / W, sy = 100 / H;
  const pt = (x: number, y: number) => `${n(x * sx)} ${n(y * sy)}`;
  const pts = (p: number[]) => pairs(p).map(([x, y]) => pt(x!, y!));
  const rad = (a: number) => (a * Math.PI) / 180;
  const on = (cx: number, cy: number, r: number, a: number, ry = r) => [cx + r * Math.cos(rad(a)), cy + ry * Math.sin(rad(a))] as const;
  const arcTo = (rx: number, ry: number, large: number, sweep: number, x: number, y: number) => `A${n(rx * sx)} ${n(ry * sy)} 0 ${large} ${sweep} ${pt(x, y)}`;
  const g: Geo = {
    R: (x, y, w, h) => `M${pt(x, y)}H${n((x + w) * sx)}V${n((y + h) * sy)}H${n(x * sx)}Z`,
    RR: (x, y, w, h, r) => {
      r = Math.min(r, w / 2, h / 2);
      const a = (px: number, py: number) => arcTo(r, r, 0, 1, px, py);
      return `M${pt(x + r, y)}L${pt(x + w - r, y)}${a(x + w, y + r)}L${pt(x + w, y + h - r)}${a(x + w - r, y + h)}L${pt(x + r, y + h)}${a(x, y + h - r)}L${pt(x, y + r)}${a(x + r, y)}Z`;
    },
    E: (cx, cy, rx, ry = rx, rev = false) => {
      const s = rev ? 0 : 1;
      return `M${pt(cx - rx, cy)}${arcTo(rx, ry, 1, s, cx + rx, cy)}${arcTo(rx, ry, 1, s, cx - rx, cy)}Z`;
    },
    P: (...p) => `M${pts(p).join("L")}Z`,
    PL: (...p) => `M${pts(p).join("L")}`,
    T: (...p) => {
      const back = pairs(p).reverse().slice(1).flat();
      return `M${pts([...p, ...back]).join("L")}`;
    },
    L: (x1, y1, x2, y2) => `M${pt(x1, y1)}L${pt(x2, y2)}`,
    A: (cx, cy, r, a0, a1) => {
      const [x0, y0] = on(cx, cy, r, a0), [x1, y1] = on(cx, cy, r, a1);
      const large = Math.abs(a1 - a0) > 180 ? 1 : 0, sweep = a1 > a0 ? 1 : 0;
      return `M${pt(x0, y0)}${arcTo(r, r, large, sweep, x1, y1)}${arcTo(r, r, large, 1 - sweep, x0, y0)}`;
    },
    PIE: (cx, cy, r, a0, a1) => {
      const [x0, y0] = on(cx, cy, r, a0), [x1, y1] = on(cx, cy, r, a1);
      return `M${pt(cx, cy)}L${pt(x0, y0)}${arcTo(r, r, a1 - a0 > 180 ? 1 : 0, 1, x1, y1)}Z`;
    },
    BAND: (cx, cy, r0, r1, a0, a1) => {
      const [ox0, oy0] = on(cx, cy, r1, a0), [ox1, oy1] = on(cx, cy, r1, a1);
      const [ix1, iy1] = on(cx, cy, r0, a1), [ix0, iy0] = on(cx, cy, r0, a0);
      const large = a1 - a0 > 180 ? 1 : 0;
      return `M${pt(ox0, oy0)}${arcTo(r1, r1, large, 1, ox1, oy1)}L${pt(ix1, iy1)}${arcTo(r0, r0, large, 0, ix0, iy0)}Z`;
    },
    REG: (k, cx, cy, r, rot = -90) => g.P(...Array.from({ length: k }, (_, i) => on(cx, cy, r, rot + (360 * i) / k)).flat()),
    STAR: (k, cx, cy, r, inner = 0.45) => g.P(...Array.from({ length: 2 * k }, (_, i) => on(cx, cy, i % 2 ? r * inner : r, -90 + (180 * i) / k)).flat()),
    DL: (x1, y1, x2, y2, dash = 6, gap = 5) => {
      const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      const out: string[] = [];
      for (let d = 0; d < len - 0.5; d += dash + gap) {
        const e = Math.min(len, d + dash);
        out.push(g.L(x1 + ux * d, y1 + uy * d, x1 + ux * e, y1 + uy * e));
      }
      return out.join(" ");
    },
    DR: (x, y, w, h, dash, gap) => [g.DL(x, y, x + w, y, dash, gap), g.DL(x + w, y, x + w, y + h, dash, gap), g.DL(x + w, y + h, x, y + h, dash, gap), g.DL(x, y + h, x, y, dash, gap)].join(" "),
    DE: (cx, cy, rx, ry = rx, k = 16) => {
      const out: string[] = [];
      for (let i = 0; i < k; i++) {
        const a0 = (360 * i) / k, a1 = a0 + (360 / k) * 0.6;
        const [x0, y0] = on(cx, cy, rx, a0, ry), [x1, y1] = on(cx, cy, rx, a1, ry);
        out.push(`M${pt(x0, y0)}${arcTo(rx, ry, 0, 1, x1, y1)}${arcTo(rx, ry, 0, 0, x0, y0)}`);
      }
      return out.join(" ");
    },
    box: (x, y, w, h) => {
      const r = (v: number) => Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;
      const bx = r(x * sx), by = r(y * sy);
      return [bx, by, Math.min(r(w * sx), 100 - bx), Math.min(r(h * sy), 100 - by)];
    },
  };
  return g;
}

/** Helpers in the 100 × 100 box itself. */
export const G = at(100, 100);

/** Joins outline parts. */
export const join = (...parts: string[]) => parts.join(" ");

/** Maps a polygon's points for another direction: right-pointing data to left, up or down. */
export function turn(dir: "right" | "left" | "up" | "down", ...p: number[]): number[] {
  return pairs(p).flatMap(([x, y]) =>
    dir === "left" ? [100 - x!, y!] : dir === "up" ? [y!, 100 - x!] : dir === "down" ? [100 - y!, x!] : [x!, y!],
  );
}
