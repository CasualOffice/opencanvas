// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// BRD-22: the style keys in the SVG / PNG export (export.ts). Keep in step with the Rust port
// (`crates/oc-model/src/board.rs`, `style_*`): both must give `board-style.web.svg` byte for byte.
// A shape without style keys exports exactly as before.
import type { Shape } from "../model";
import { dashOf, fontOf, opOf, rotOf, swOf, TONES } from "./style";

export const EXPORT_FONTS = {
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
  mono: "'Geist Mono', ui-monospace, Menlo, monospace",
};

export interface InkPalette {
  fg: string;
  fg2: string;
  app: string;
  accent: string;
  tone: Record<string, [string, string]>;
}

/** The colour `stroke` names (ink or a tone), or null for the default (legacy "accent" included). */
export function inkHex(s: Shape, P: InkPalette): string | null {
  const k = s.stroke;
  if (k === "ink") return P.fg;
  return k && (TONES as readonly string[]).includes(k) ? P.tone[k][1] : null;
}
/** Width attribute value: `sw` when valid, else the shape's default. */
export const swAttr = (s: Shape, dflt: number, n: (v: number) => string) => n(swOf(s) ?? dflt);
/** ` stroke-dasharray="…"` (and round caps for dots), or "". */
export function dashAttr(s: Shape, w: number, n: (v: number) => string): string {
  const d = dashOf(s, w);
  if (!d) return "";
  const [a, b] = d.split(" ").map(Number);
  return ` stroke-dasharray="${a === 0.01 ? "0.01" : n(a)} ${n(b)}"${s.dash === "dotted" ? ` stroke-linecap="round"` : ""}`;
}

/** Wraps a shape's markup in a group that turns, fades and sets its font, when its style says so. */
export function wrapStyled(s: Shape, inner: string, box: [number, number, number, number], n: (v: number) => string): string {
  if (!inner) return inner;
  const r = rotOf(s), o = opOf(s), f = fontOf(s);
  if (!r && o === undefined && !f) return inner;
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  return `<g${r ? ` transform="rotate(${n(r)} ${n(cx)} ${n(cy)})"` : ""}${o !== undefined ? ` opacity="${n(o)}"` : ""}${f ? ` font-family="${EXPORT_FONTS[f]}"` : ""}>${inner}</g>`;
}

/**
 * The bounds a rotated shape can reach: the circle around its box (centre ± half the diagonal),
 * so both exporters agree without trigonometry. Unrotated shapes keep their box.
 */
export function reach(s: Shape, b: [number, number, number, number]): [number, number, number, number] {
  if (!rotOf(s)) return b;
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  const r = Math.sqrt((b[2] - b[0]) * (b[2] - b[0]) + (b[3] - b[1]) * (b[3] - b[1])) / 2;
  return [cx - r, cy - r, cx + r, cy + r];
}

const HEAD_KINDS = new Set(["arrow", "triangle", "circle", "diamond", "diamond-filled"]);
const HEAD_PATH: Record<string, string> = {
  triangle: "M3 3 L19 10 L3 17 Z",
  circle: "M8 10A5 5 0 1 1 18 10A5 5 0 1 1 8 10Z",
  diamond: "M1 10 L10 4 L19 10 L10 16 Z",
  "diamond-filled": "M1 10 L10 4 L19 10 L10 16 Z",
};

/**
 * Marker attributes for a connector's ends, adding the markers it needs to `defs` (by id, in the
 * order first used). The plain grey end arrow keeps the shared `<prefix>ah` marker, so connectors
 * without style keys export exactly as before.
 */
export function arrowEnds(s: Shape, col: string, colKey: string, prefix: string, defs: Map<string, string>, P: InkPalette): string {
  const p = (s.props ?? {}) as Record<string, unknown>;
  const at = (v: unknown, dflt: string) => (typeof v === "string" && (v === "none" || HEAD_KINDS.has(v)) ? v : dflt);
  const start = at(p.startArrow, "none"), end = at(p.endArrow, "arrow");
  const url = (head: string) => {
    if (head === "arrow" && colKey === "d") return `url(#${prefix}ah)`;
    const id = `${prefix}ah-${colKey}-${head}`;
    if (!defs.has(id)) {
      defs.set(
        id,
        head === "arrow"
          ? `<marker id="${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1.5 L9 5 L1 8.5" fill="none" stroke="${col}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>`
          : `<marker id="${id}" viewBox="0 0 20 20" refX="19" refY="10" markerWidth="18" markerHeight="18" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="${HEAD_PATH[head]}" fill="${head === "diamond-filled" ? col : P.app}" stroke="${col}" stroke-width="1.4" stroke-linejoin="round"/></marker>`,
      );
    }
    return `url(#${id})`;
  };
  return `${start !== "none" ? ` marker-start="${url(start)}"` : ""}${end !== "none" ? ` marker-end="${url(end)}"` : ""}`;
}
