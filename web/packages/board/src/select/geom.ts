// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Selection geometry (decision 13 of docs/prototypes/board-ux-approved): eight handles on one
// shape (in its own, rotated, frame), corner handles and rotation on several. Pure functions; the
// board turns their results into one transaction per frame.
import { bbox, type Pt, type Shape } from "../model";
import { normDeg, rotOf } from "../style/style";

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
export const CORNERS: Handle[] = ["nw", "ne", "se", "sw"];
export const CURSOR: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };
const sx = (h: Handle) => (h.includes("e") ? 1 : h.includes("w") ? -1 : 0);
const sy = (h: Handle) => (h.includes("s") ? 1 : h.includes("n") ? -1 : 0);
const r1 = (v: number) => Math.round(v * 10) / 10;

/** `p` turned by `deg` about `c` (screen coordinates: positive is clockwise). */
export function turn(p: Pt, c: Pt, deg: number): Pt {
  if (!deg) return p;
  const a = (deg * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
  const dx = p[0] - c[0], dy = p[1] - c[1];
  return [c[0] + dx * co - dy * si, c[1] + dx * si + dy * co];
}
/** Where handle `h` of box `b` is, turned by `rot` about the box's centre. */
export function handleAt(b: [number, number, number, number], h: Handle, rot = 0): Pt {
  const c: Pt = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const p: Pt = [sx(h) < 0 ? b[0] : sx(h) > 0 ? b[2] : c[0], sy(h) < 0 ? b[1] : sy(h) > 0 ? b[3] : c[1]];
  return turn(p, c, rot);
}

/**
 * One shape resized by handle `h`, the pointer having moved `d` (board units) since the press.
 * The move is read in the shape's own frame, so a rotated shape resizes along its sides and the
 * opposite side stays put. Shift (or `ratio`) keeps the proportions on a corner; Alt grows from
 * the centre. Never smaller than `min`.
 */
export function resizeOne(o: Shape, h: Handle, d: Pt, opt: { ratio?: boolean; centre?: boolean; min?: Pt } = {}): Pick<Shape, "x" | "y" | "w" | "h"> {
  const w0 = o.w ?? 0, h0 = o.h ?? 0, rot = rotOf(o);
  const [mw, mh] = opt.min ?? [10, 10];
  const [lx, ly] = turn(d, [0, 0], -rot);
  let l = -w0 / 2, r = w0 / 2, t = -h0 / 2, b = h0 / 2;
  const hx = sx(h), hy = sy(h);
  if (opt.centre) {
    if (hx) (r += hx * lx), (l -= hx * lx);
    if (hy) (b += hy * ly), (t -= hy * ly);
  } else {
    if (hx > 0) r += lx;
    if (hx < 0) l += lx;
    if (hy > 0) b += ly;
    if (hy < 0) t += ly;
  }
  if (opt.ratio && hx && hy && w0 > 0 && h0 > 0) {
    const s = Math.max(Math.abs(r - l) / w0, Math.abs(b - t) / h0);
    const w = w0 * s, hh = h0 * s;
    if (opt.centre) (l = -w / 2), (r = w / 2), (t = -hh / 2), (b = hh / 2);
    else {
      if (hx > 0) r = l + w;
      else l = r - w;
      if (hy > 0) b = t + hh;
      else t = b - hh;
    }
  }
  if (r - l < mw) {
    if (hx < 0) l = r - mw;
    else if (opt.centre) (l = -mw / 2), (r = mw / 2);
    else r = l + mw;
  }
  if (b - t < mh) {
    if (hy < 0) t = b - mh;
    else if (opt.centre) (t = -mh / 2), (b = mh / 2);
    else b = t + mh;
  }
  const c0: Pt = [(o.x ?? 0) + w0 / 2, (o.y ?? 0) + h0 / 2];
  const m = turn([(l + r) / 2, (t + b) / 2], [0, 0], rot);
  const w = r - l, hh = b - t;
  return { x: r1(c0[0] + m[0] - w / 2), y: r1(c0[1] + m[1] - hh / 2), w: r1(w), h: r1(hh) };
}

const mapPts = (pts: Pt[] | undefined, f: (p: Pt) => Pt) => pts?.map((p) => f(p).map(r1) as Pt);

/**
 * Several shapes scaled by a corner handle of their common box `u`, the pointer having moved `d`.
 * Positions, sizes and free points scale with the box; Shift scales evenly.
 */
export function scaleMany(list: Shape[], u: [number, number, number, number], h: Handle, d: Pt, even = false): { id: string; patch: Partial<Shape> }[] {
  let [L, T, R, B] = u;
  const W0 = Math.max(1e-9, R - L), H0 = Math.max(1e-9, B - T);
  if (h.includes("e")) R = Math.max(L + 20, R + d[0]);
  if (h.includes("w")) L = Math.min(R - 20, L + d[0]);
  if (h.includes("s")) B = Math.max(T + 20, B + d[1]);
  if (h.includes("n")) T = Math.min(B - 20, T + d[1]);
  let kx = (R - L) / W0, ky = (B - T) / H0;
  if (even) {
    const k = Math.max(kx, ky);
    kx = ky = k;
    if (h.includes("w")) L = u[2] - W0 * k;
    else R = L + W0 * k;
    if (h.includes("n")) T = u[3] - H0 * k;
    else B = T + H0 * k;
  }
  const f = (p: Pt): Pt => [L + (p[0] - u[0]) * kx, T + (p[1] - u[1]) * ky];
  return list.map((s) => {
    if (s.pts && (s.type === "arrow" || s.type === "pen")) return { id: s.id, patch: { pts: mapPts(s.pts, f), ...(s.via ? { via: mapPts(s.via, f) } : {}) } };
    if (s.w === undefined || s.h === undefined) {
      const [x, y] = f([s.x ?? 0, s.y ?? 0]);
      return { id: s.id, patch: { x: r1(x), y: r1(y) } };
    }
    // The centre moves with the box; the size scales (a rotated shape is treated by its centre).
    const c = f([(s.x ?? 0) + s.w / 2, (s.y ?? 0) + s.h / 2]);
    const w = s.w * kx, hh = s.h * ky;
    return { id: s.id, patch: { x: r1(c[0] - w / 2), y: r1(c[1] - hh / 2), w: r1(w), h: r1(hh) } };
  });
}

/** Several shapes turned by `deg` about `c`: centres orbit, rotations add, free points turn. */
export function rotateMany(list: Shape[], c: Pt, deg: number): { id: string; patch: Partial<Shape> }[] {
  return list.map((s) => {
    if (s.pts && (s.type === "arrow" || s.type === "pen")) return { id: s.id, patch: { pts: mapPts(s.pts, (p) => turn(p, c, deg)), ...(s.via ? { via: mapPts(s.via, (p) => turn(p, c, deg)) } : {}) } };
    const b = bbox(s);
    const m: Pt = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const n = turn(m, c, deg);
    const r = normDeg(rotOf(s) + deg);
    return { id: s.id, patch: { x: r1((s.x ?? 0) + n[0] - m[0]), y: r1((s.y ?? 0) + n[1] - m[1]), rot: r ? r : undefined } };
  });
}
