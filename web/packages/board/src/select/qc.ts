// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Quick-connect (decision 10 of docs/prototypes/board-ux-approved): the four + handles of one
// selected shape. Where the new shape goes and what it copies; pure functions.
import { turned, type Anchor } from "../connectors";
import { bbox, type Shape, type ShapeType } from "../model";
import { intersects, type Box } from "../ops";

export type Side = "n" | "e" | "s" | "w";
export const SIDES: Side[] = ["n", "e", "s", "w"];
export const SIDE_ANCHOR: Record<Side, Anchor> = { n: "top", e: "right", s: "bottom", w: "left" };
export const OPPOSITE: Record<Side, Side> = { n: "s", e: "w", s: "n", w: "e" };
export const SIDE_NAME: Record<Side, string> = { n: "above", e: "to the right", s: "below", w: "to the left" };
/** Shapes that get the handles. */
export const QC_TYPES: ShapeType[] = ["rect", "ellipse", "diamond", "sticky"];
export const quickConnects = (s: Shape) => QC_TYPES.includes(s.type) && !s.locked;

/** The new shape's fields: the same kind, size and style, no text. */
export function cloneFields(s: Shape): Omit<Shape, "id"> {
  const out: Omit<Shape, "id"> = { type: s.type, w: s.w, h: s.h, text: "" };
  for (const k of ["fill", "kind", "kindVersion", "stroke", "sw", "dash", "op", "font", "size"] as const) if (s[k] !== undefined) (out as Record<string, unknown>)[k] = s[k];
  return out;
}

/**
 * Top-left corner for the new shape on `side` of `s`, `gap` away; when that spot is taken by a
 * shape in `others`, it steps further out (up to eight times).
 */
export function qcSpot(s: Shape, side: Side, others: Box[], gap = 70): [number, number] {
  const w = s.w ?? 0, h = s.h ?? 0;
  const [dx, dy] = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] }[side];
  const stepX = dx * (w + gap), stepY = dy * (h + gap);
  let x = (s.x ?? 0) + stepX, y = (s.y ?? 0) + stepY;
  for (let i = 0; i < 8; i++) {
    const b: Box = [x, y, x + w, y + h];
    if (!others.some((o) => intersects(b, o))) break;
    x += stepX;
    y += stepY;
  }
  return [x, y];
}

/**
 * The four handle positions, `d` outside the shape's box; the top one sits right of the rotation
 * handle. A turned shape turns them too, so they stay off its sides and its corner handles (BRD-35).
 */
export function qcHandles(s: Shape, d: number): Record<Side, [number, number]> {
  const [x0, y0, x1, y1] = bbox(s);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const t = (p: [number, number]) => turned(s, p) as [number, number];
  return { n: t([cx + 2 * d, y0 - d]), e: t([x1 + d, cy]), s: t([cx, y1 + d]), w: t([x0 - d, cy]) };
}
