// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Multi-shape operations for the board: align, distribute, snapping, copy / paste with
// remapped ids and bindings, z-order, groups and text wrapping. Pure helpers plus a few
// Yjs writers; every writer takes the caller's transaction origin (so per-view undo works).
import * as Y from "yjs";
import { addShape, bbox, getBoardMap, nid, type Pt, type Shape } from "./model";

export type Box = [number, number, number, number];
export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/** Union box of several shapes. */
export function unionBox(shapes: Shape[]): Box | null {
  if (!shapes.length) return null;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const s of shapes) {
    const [x0, y0, x1, y1] = bbox(s);
    a = Math.min(a, x0);
    b = Math.min(b, y0);
    c = Math.max(c, x1);
    d = Math.max(d, y1);
  }
  return [a, b, c, d];
}

/** Patch that moves a shape by (dx, dy): x/y for boxes and text, every point for lines. */
export function movePatch(s: Shape, dx: number, dy: number): Partial<Shape> {
  const shift = (list: Pt[]) => list.map((p) => [Math.round((p[0] + dx) * 10) / 10, Math.round((p[1] + dy) * 10) / 10] as Pt);
  if (s.pts) return s.via?.length ? { pts: shift(s.pts), via: shift(s.via) } : { pts: shift(s.pts) };
  return { x: Math.round(((s.x ?? 0) + dx) * 10) / 10, y: Math.round(((s.y ?? 0) + dy) * 10) / 10 };
}

/** Align shapes to the selection's edge or centre. Bound connectors are left to follow. */
export function alignMoves(shapes: Shape[], mode: AlignMode): { id: string; patch: Partial<Shape> }[] {
  const movable = shapes.filter((s) => !(s.type === "arrow" && (s.start || s.end)));
  const u = unionBox(movable);
  if (!u || movable.length < 2) return [];
  return movable.map((s) => {
    const [x0, y0, x1, y1] = bbox(s);
    let dx = 0, dy = 0;
    if (mode === "left") dx = u[0] - x0;
    else if (mode === "right") dx = u[2] - x1;
    else if (mode === "hcenter") dx = (u[0] + u[2]) / 2 - (x0 + x1) / 2;
    else if (mode === "top") dy = u[1] - y0;
    else if (mode === "bottom") dy = u[3] - y1;
    else dy = (u[1] + u[3]) / 2 - (y0 + y1) / 2;
    return { id: s.id, patch: movePatch(s, dx, dy) };
  });
}

/** Spread shapes so the gaps between them are equal (needs three or more). */
export function distributeMoves(shapes: Shape[], axis: "h" | "v"): { id: string; patch: Partial<Shape> }[] {
  const movable = shapes.filter((s) => !(s.type === "arrow" && (s.start || s.end)));
  if (movable.length < 3) return [];
  const i0 = axis === "h" ? 0 : 1, i1 = axis === "h" ? 2 : 3;
  const sorted = movable.map((s) => ({ s, b: bbox(s) })).sort((p, q) => p.b[i0] - q.b[i0]);
  const first = sorted[0].b, last = sorted[sorted.length - 1].b;
  const span = last[i1] - first[i0];
  const sizes = sorted.reduce((t, x) => t + (x.b[i1] - x.b[i0]), 0);
  const gap = (span - sizes) / (sorted.length - 1);
  let at = first[i0];
  return sorted.map(({ s, b }) => {
    const d = at - b[i0];
    at += b[i1] - b[i0] + gap;
    return { id: s.id, patch: axis === "h" ? movePatch(s, d, 0) : movePatch(s, 0, d) };
  });
}

/**
 * Snap a moving box to the edges and centres of other boxes. Returns the adjusted offset
 * and the guide lines (world x and y positions) to draw.
 */
export function snapOffset(moving: Box, others: Box[], dx: number, dy: number, tol: number): { dx: number; dy: number; gx: number[]; gy: number[] } {
  const xs = [moving[0] + dx, (moving[0] + moving[2]) / 2 + dx, moving[2] + dx];
  const ys = [moving[1] + dy, (moving[1] + moving[3]) / 2 + dy, moving[3] + dy];
  let bx: number | null = null, by: number | null = null, ex = tol + 1, ey = tol + 1;
  for (const o of others) {
    const ox = [o[0], (o[0] + o[2]) / 2, o[2]];
    const oy = [o[1], (o[1] + o[3]) / 2, o[3]];
    for (const a of xs) for (const t of ox) if (Math.abs(t - a) < ex) (ex = Math.abs(t - a)), (bx = t - a);
    for (const a of ys) for (const t of oy) if (Math.abs(t - a) < ey) (ey = Math.abs(t - a)), (by = t - a);
  }
  const ndx = dx + (bx !== null && ex <= tol ? bx : 0);
  const ndy = dy + (by !== null && ey <= tol ? by : 0);
  const gx: number[] = [], gy: number[] = [];
  if (bx !== null && ex <= tol) {
    const mx = [moving[0] + ndx, (moving[0] + moving[2]) / 2 + ndx, moving[2] + ndx];
    for (const o of others) for (const t of [o[0], (o[0] + o[2]) / 2, o[2]]) if (mx.some((m) => Math.abs(m - t) < 0.5) && !gx.includes(t)) gx.push(t);
  }
  if (by !== null && ey <= tol) {
    const my = [moving[1] + ndy, (moving[1] + moving[3]) / 2 + ndy, moving[3] + ndy];
    for (const o of others) for (const t of [o[1], (o[1] + o[3]) / 2, o[3]]) if (my.some((m) => Math.abs(m - t) < 0.5) && !gy.includes(t)) gy.push(t);
  }
  return { dx: ndx, dy: ndy, gx, gy };
}

/**
 * Copies of `shapes` offset by (dx, dy) with fresh ids. Connector bindings to shapes inside
 * the set are re-pointed at the copies; bindings to shapes outside are dropped (the copy is a
 * free arrow at the same place). Groups get fresh group ids.
 */
export function cloneShapes(shapes: Shape[], dx: number, dy: number): Shape[] {
  const ids = new Map(shapes.map((s) => [s.id, nid("s")]));
  const groups = new Map<string, string>();
  return shapes.map((s) => {
    const n: Shape = JSON.parse(JSON.stringify(s));
    n.id = ids.get(s.id)!;
    if (n.group) n.group = groups.get(n.group) ?? (groups.set(n.group, nid("g")), groups.get(n.group)!);
    for (const k of ["start", "end"] as const) {
      const b = n[k];
      // Keep every field of the binding (a `port`, or one a newer client added); only re-point it.
      if (b && ids.has(b.shapeId)) n[k] = { ...b, shapeId: ids.get(b.shapeId)! };
      else delete n[k];
    }
    return { ...n, ...movePatch(n, dx, dy) };
  });
}

/** Insert shapes (already with ids) at the top of the z-order, in one transaction. */
export function insertShapes(doc: Y.Doc, boardId: string, shapes: Shape[], origin?: unknown): string[] {
  doc.transact(() => shapes.forEach((s) => addShape(doc, boardId, s, origin)), origin);
  return shapes.map((s) => s.id);
}

export type ZMove = "front" | "back" | "forward" | "backward";

/** New z-order after moving `ids` (keeping their relative order). Pure. */
export function reorderIds(order: string[], ids: string[], how: ZMove): string[] {
  const set = new Set(ids);
  const picked = order.filter((x) => set.has(x));
  const rest = order.filter((x) => !set.has(x));
  if (!picked.length) return order;
  if (how === "front") return [...rest, ...picked];
  if (how === "back") return [...picked, ...rest];
  const out = order.slice();
  if (how === "forward") {
    for (let i = out.length - 2; i >= 0; i--) if (set.has(out[i]) && !set.has(out[i + 1])) [out[i], out[i + 1]] = [out[i + 1], out[i]];
  } else {
    for (let i = 1; i < out.length; i++) if (set.has(out[i]) && !set.has(out[i - 1])) [out[i], out[i - 1]] = [out[i - 1], out[i]];
  }
  return out;
}

/** Change the z-order of shapes. Only the moved ids are deleted and re-inserted in `order`. */
export function reorderShapes(doc: Y.Doc, boardId: string, ids: string[], how: ZMove, origin?: unknown) {
  const m = getBoardMap(doc, boardId);
  const order = m?.get("order");
  if (!(order instanceof Y.Array)) return;
  doc.transact(() => {
    const cur = (order.toArray() as string[]).filter((x, i, a) => a.indexOf(x) === i);
    const next = reorderIds(cur, ids, how);
    const set = new Set(ids);
    const arr = order.toArray() as string[];
    for (let i = arr.length - 1; i >= 0; i--) if (set.has(arr[i])) order.delete(i, 1);
    // Re-insert each moved id before the first following non-moved id of the target order.
    for (let i = 0; i < next.length; i++) {
      if (!set.has(next[i])) continue;
      const after = next.slice(i + 1).find((x) => !set.has(x));
      const now = order.toArray() as string[];
      const at = after ? now.indexOf(after) : now.length;
      order.insert(at < 0 ? now.length : at, [next[i]]);
    }
  }, origin);
}

/** Put shapes in one new group (or out of any group with `null`). Returns the group id. */
export function setGroup(doc: Y.Doc, boardId: string, ids: string[], group: string | null, origin?: unknown): string | null {
  const m = getBoardMap(doc, boardId);
  const shapes = m?.get("shapes");
  if (!(shapes instanceof Y.Map)) return null;
  const g = group === null ? null : group || nid("g");
  doc.transact(() => {
    for (const id of ids) {
      const s = shapes.get(id);
      if (!(s instanceof Y.Map)) continue;
      if (g) s.set("group", g);
      else s.delete("group");
    }
  }, origin);
  return g;
}

/** Every id in the same group as any of `ids` (ungrouped shapes stand alone). */
export function withGroups(shapes: Shape[], ids: string[]): string[] {
  const groups = new Set(shapes.filter((s) => ids.includes(s.id) && s.group).map((s) => s.group!));
  if (!groups.size) return ids;
  const out = new Set(ids);
  for (const s of shapes) if (s.group && groups.has(s.group)) out.add(s.id);
  return [...out];
}

/** Approximate width of text in Geist at `size` px (used for wrapping and text boxes). */
export const textWidth = (t: string, size: number) => t.length * size * 0.56;

/** Greedy word wrap to `max` px (long words are broken). Keeps explicit line breaks. */
export function wrapText(text: string, max: number, size: number): string[] {
  const out: string[] = [];
  const per = Math.max(1, Math.floor(max / (size * 0.56)));
  for (const para of String(text ?? "").split("\n")) {
    if (para.length <= per) {
      out.push(para);
      continue;
    }
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      if ((line + word).length <= per) {
        line += word;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = word.trimStart();
      while (line.length > per) {
        out.push(line.slice(0, per));
        line = line.slice(per);
      }
    }
    out.push(line);
  }
  return out;
}

/** Sticky geometry: 14 px text, 20 px lines, 30 px to the first baseline, 14 px side padding. */
export const STICKY_TEXT = { size: 14, lh: 20, top: 30, pad: 14, bottom: 22 };

/** Height a sticky of width `w` needs to show all of `text` (never less than `min`). */
export function stickyHeight(text: string, w: number, min: number): number {
  const lines = wrapText(text, w - STICKY_TEXT.pad * 2, STICKY_TEXT.size).length;
  return Math.max(min, Math.ceil(STICKY_TEXT.top + (lines - 1) * STICKY_TEXT.lh + STICKY_TEXT.bottom));
}

/** Point halfway along a polyline (where a connector's label sits). */
export function midPoint(pts: Pt[]): Pt {
  if (pts.length < 2) return pts[0] ?? [0, 0];
  const seg = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  let half = seg.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < seg.length; i++) {
    if (half <= seg[i] || i === seg.length - 1) {
      const t = seg[i] ? Math.min(1, half / seg[i]) : 0;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
    }
    half -= seg[i];
  }
  return pts[0];
}

/** Boxes intersect (touching counts). */
export const intersects = (a: Box, b: Box) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** A gap mark drawn while snapping to equal spacing: a segment and the gap's length. */
export interface GapMark {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  gap: number;
}

/**
 * Equal spacing (diagram mode, 3a): when the moving box sits between two neighbours on an axis
 * (overlapping on the other axis) and the two gaps differ by at most twice `tol`, centre it so both
 * gaps are equal. Axes in `skip` are left alone (an alignment snap there wins). Returns the extra
 * offset and the marks for both gaps.
 */
export function equalGapOffset(m: Box, others: Box[], tol: number, skip: { x?: boolean; y?: boolean } = {}): { dx: number; dy: number; marks: GapMark[] } {
  const marks: GapMark[] = [];
  let dx = 0, dy = 0;
  const near = (axis: 0 | 1) => {
    const o0 = axis === 0 ? 1 : 0; // the other axis: neighbours overlap the box on it
    let lo: Box | null = null, hi: Box | null = null;
    for (const o of others) {
      if (o[o0] >= m[o0 + 2] || o[o0 + 2] <= m[o0]) continue;
      if (o[axis + 2] <= m[axis] + tol && (!lo || o[axis + 2] > lo[axis + 2])) lo = o;
      if (o[axis] >= m[axis + 2] - tol && (!hi || o[axis] < hi[axis])) hi = o;
    }
    if (!lo || !hi) return;
    const g1 = m[axis] - lo[axis + 2], g2 = hi[axis] - m[axis + 2];
    if (g1 < 0 || g2 < 0 || Math.abs(g1 - g2) > tol * 2) return;
    const shift = (g2 - g1) / 2;
    const gap = Math.round((g1 + g2) / 2);
    const c = (Math.max(m[o0], lo[o0], hi[o0]) + Math.min(m[o0 + 2], lo[o0 + 2], hi[o0 + 2])) / 2;
    const seg = (a: number, b: number): GapMark => (axis === 0 ? { x1: a, y1: c, x2: b, y2: c, gap } : { x1: c, y1: a, x2: c, y2: b, gap });
    marks.push(seg(lo[axis + 2], m[axis] + shift), seg(m[axis + 2] + shift, hi[axis]));
    if (axis === 0) dx = shift;
    else dy = shift;
  };
  if (!skip.x) near(0);
  if (!skip.y) near(1);
  return { dx, dy, marks };
}

/**
 * What a container holds (3g): every shape other than a connector or drawing whose box lies fully
 * inside one of `containers`, and, through nested containers, what those hold. Membership is
 * geometric, so it needs no stored field and older clients agree with what they see.
 */
export function containedIn(shapes: Shape[], containers: Shape[]): string[] {
  const out = new Set<string>();
  const skip = new Set(containers.map((c) => c.id));
  const boxes = containers.map((c) => bbox(c));
  for (const s of shapes) {
    if (skip.has(s.id) || s.type === "arrow" || s.type === "pen") continue;
    const b = bbox(s);
    if (boxes.some((c) => b[0] >= c[0] && b[1] >= c[1] && b[2] <= c[2] && b[3] <= c[3])) out.add(s.id);
  }
  return [...out];
}

/** The box of a new container around `shapes`: a margin all round, more on top for its title. */
export function containerBox(shapes: Shape[], pad = 24, title = 36): Box | null {
  const u = unionBox(shapes.filter((s) => s.type !== "arrow" && s.type !== "pen"));
  return u ? [u[0] - pad, u[1] - title, u[2] + pad, u[3] + pad] : null;
}

/** Offset that puts the box's top-left corner on the grid (diagram mode "Snap to grid"). */
export function gridOffset(m: Box, size: number): [number, number] {
  if (!(size > 0)) return [0, 0];
  return [Math.round(m[0] / size) * size - m[0], Math.round(m[1] / size) * size - m[1]];
}
