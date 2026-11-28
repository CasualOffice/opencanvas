// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// BRD-22: the shape style keys (decisions 4 and 5 of docs/prototypes/board-ux-approved). All are
// additive and optional; 0.1.x clients ignore them and keep them when they edit a shape:
//   stroke  "ink" or a tone (gray, blue, …) for the outline / text colour ("accent": legacy pen,
//           not an ink: a box with a tone fill keeps the tone's outline, as before)
//   sw      stroke width (1 thin, 2 medium, 4 bold)
//   dash    "dashed" | "dotted" (solid when unset)
//   op      opacity in percent, 10..90 (100 when unset)
//   font    "serif" | "mono" (sans when unset)
//   rot     rotation in degrees about the shape's centre, (-180, 180] (0 when unset)
// Arrowheads are the existing `props.startArrow` / `props.endArrow` (heads.ts), so the diagram
// presets and the style panel write the same keys.
import * as Y from "yjs";
import { updateShape, type Shape, type ShapeType } from "../model";

export const TONES = ["gray", "blue", "green", "amber", "red", "purple", "pink"] as const;
export const STROKES = ["ink", ...TONES] as const;
export const STICKY_FILLS = ["y", "p", "b", "g"] as const;
export const WIDTHS = [1, 2, 4] as const;
export const SIZE_NAMES = ["Small", "Medium", "Large", "Extra large"] as const;
/** Text sizes behind S, M, L, XL: text shapes, and labels inside boxes. */
export const TEXT_SIZES = [14, 18, 24, 32];
export const SHAPE_SIZES = [13, 14, 16, 20];

export type StyleKey = "stroke" | "fill" | "sticky" | "sw" | "dash" | "op" | "font" | "size" | "rot" | "ah";
/** Which style keys a shape type takes. */
export const APPLIES: Partial<Record<ShapeType, StyleKey[]>> = {
  rect: ["stroke", "fill", "sw", "dash", "op", "font", "size", "rot"],
  ellipse: ["stroke", "fill", "sw", "dash", "op", "font", "size", "rot"],
  diamond: ["stroke", "fill", "sw", "dash", "op", "font", "size", "rot"],
  sticky: ["sticky", "op", "font", "rot"],
  text: ["stroke", "op", "font", "size", "rot"],
  arrow: ["stroke", "sw", "dash", "ah", "op"],
  pen: ["stroke", "sw", "op"],
  image: ["op", "rot"],
  swatch: ["op", "rot"],
};
export const applies = (s: Shape, k: StyleKey) => !!APPLIES[s.type]?.includes(k);
export const styled = (s: Shape) => !!APPLIES[s.type]?.length;
export const rotates = (s: Shape) => applies(s, "rot");

/** The colour a shape's outline (or text) is drawn in, when its `stroke` says so; else null. */
export function inkOf(s: Shape): string | null {
  const k = s.stroke;
  if (k === "ink") return "var(--fg)";
  // "accent" is the legacy pen colour: it never overrides a tone (drawn by the pen's own code).
  return k && (TONES as readonly string[]).includes(k) ? `var(--${k}-fg)` : null;
}
/** A stroke width that is safe to draw, or undefined. */
export const swOf = (s: Shape): number | undefined => (typeof s.sw === "number" && s.sw > 0 && s.sw <= 12 ? s.sw : undefined);
/** `stroke-dasharray` for `dash`, scaled with the width. */
export function dashOf(s: Shape, w: number): string | undefined {
  if (s.dash === "dashed") return `${w * 3} ${w * 2.5}`;
  if (s.dash === "dotted") return `0.01 ${w * 2.4}`;
  return undefined;
}
/** Opacity 0.1..0.9 when set, else undefined. */
export const opOf = (s: Shape): number | undefined => (typeof s.op === "number" && s.op >= 10 && s.op < 100 ? Math.round(s.op) / 100 : undefined);
export const rotOf = (s: Shape): number => (typeof s.rot === "number" && Number.isFinite(s.rot) ? s.rot : 0);
export const fontOf = (s: Shape): "serif" | "mono" | undefined => (s.font === "serif" || s.font === "mono" ? s.font : undefined);

/** An angle in (-180, 180], to a tenth of a degree. */
export function normDeg(a: number): number {
  let r = Math.round(a * 10) / 10;
  r = ((r % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return r === -0 ? 0 : r;
}
export const sizesFor = (s: Shape) => (s.type === "text" ? TEXT_SIZES : SHAPE_SIZES);
export const sizeOf = (s: Shape) => s.size ?? (s.type === "text" ? 18 : s.type === "ellipse" ? 15 : 14);

/** The patch one control writes to one shape (or null when the key does not apply to it). */
export function patchFor(s: Shape, k: StyleKey, v: string | number | null): Partial<Shape> | null {
  if (k === "sticky") return s.type === "sticky" ? { fill: String(v) } : null;
  if (!applies(s, k)) return null;
  switch (k) {
    case "stroke":
      return { stroke: v ? String(v) : undefined };
    case "fill":
      return { fill: v && v !== "none" ? String(v) : undefined };
    case "sw":
      return { sw: Number(v) || undefined };
    case "dash": {
      const d = v === "dashed" || v === "dotted" ? v : undefined;
      // Connectors also keep the legacy `dashed` flag for readers that know only it.
      return s.type === "arrow" ? { dash: d, dashed: d === "dashed" ? true : undefined } : { dash: d };
    }
    case "op": {
      const n = Math.round(Number(v));
      return { op: n >= 10 && n < 100 ? n : undefined };
    }
    case "font":
      return { font: v === "serif" || v === "mono" ? v : undefined };
    case "size": {
      const i = Number(v);
      const list = sizesFor(s);
      return i >= 0 && i < list.length ? { size: list[i] } : null;
    }
    case "rot": {
      const r = normDeg(Number(v) || 0);
      return { rot: r ? r : undefined };
    }
    default:
      return null;
  }
}

/** Writes one style control to every shape it applies to, in one transaction (one Undo step). */
export function applyStyle(doc: Y.Doc, boardId: string, list: Shape[], k: StyleKey | "ah0" | "ah1", v: string | number | null, origin: unknown) {
  doc.transact(() => {
    for (const s of list) {
      if (s.locked) continue;
      if (k === "ah0" || k === "ah1") {
        if (s.type !== "arrow") continue;
        updateShape(doc, boardId, s.id, { props: { [k === "ah0" ? "startArrow" : "endArrow"]: String(v) } }, origin);
        continue;
      }
      const p = patchFor(s, k, v);
      if (p) updateShape(doc, boardId, s.id, p, origin);
    }
  }, origin);
}

/* ------------------------------------------------- the last style picked */

/** The last style each person picked (decision 4): kept on this device, never in the board. */
export const LAST_KEY = "oc.board.style";
export type LastStyle = Partial<{ stroke: string; fill: string; sticky: string; sw: number; dash: string; op: number; font: string }>;
export function readLast(): LastStyle {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as LastStyle) : {};
  } catch {
    return {};
  }
}
export function rememberLast(k: StyleKey, v: string | number | null) {
  if (k === "size" || k === "rot" || k === "ah") return;
  const cur = readLast() as Record<string, unknown>;
  if (v === null || v === "" || v === "none" || (k === "op" && Number(v) >= 100) || (k === "dash" && v === "solid")) delete cur[k];
  else cur[k] = v;
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(cur));
  } catch {
    /* private window: the style lasts for this page */
  }
}
/** The last style's keys that apply to a new shape of type `t`. */
export function lastFor(t: ShapeType): Partial<Shape> {
  const L = readLast();
  const probe = { id: "", type: t } as Shape;
  const out: Partial<Shape> = {};
  if (L.stroke && applies(probe, "stroke") && (STROKES as readonly string[]).includes(L.stroke)) out.stroke = L.stroke;
  if (L.fill && applies(probe, "fill") && (TONES as readonly string[]).includes(L.fill)) out.fill = L.fill;
  if (L.sticky && t === "sticky" && (STICKY_FILLS as readonly string[]).includes(L.sticky)) out.fill = L.sticky;
  if (L.sw && applies(probe, "sw") && (WIDTHS as readonly number[]).includes(L.sw)) out.sw = L.sw;
  if ((L.dash === "dashed" || L.dash === "dotted") && applies(probe, "dash")) out.dash = L.dash;
  if (typeof L.op === "number" && L.op >= 10 && L.op < 100 && applies(probe, "op")) out.op = L.op;
  if ((L.font === "serif" || L.font === "mono") && applies(probe, "font")) out.font = L.font;
  return out;
}
