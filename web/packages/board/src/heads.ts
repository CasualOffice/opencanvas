// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Connector ends (DGM-14): the glyphs for `props.startArrow`/`endArrow` and ERD cardinality
// (`props.startCard`/`endCard`), shared by the canvas and the shapes panel's preset tiles.
import type { Shape } from "./model";

/** Connector end glyphs (20 × 20, the tip at 19,10), drawn by markers named after them. */
export const HEADS: Record<string, { d: string; fill?: string }> = {
  triangle: { d: "M3 3 L19 10 L3 17 Z", fill: "var(--app)" },
  diamond: { d: "M1 10 L10 4 L19 10 L10 16 Z", fill: "var(--app)" },
  "diamond-filled": { d: "M1 10 L10 4 L19 10 L10 16 Z", fill: "var(--fg-2)" },
  circle: { d: "M8 10A5 5 0 1 1 18 10A5 5 0 1 1 8 10Z", fill: "var(--app)" },
  one: { d: "M0 10H19 M11 3V17 M15 3V17" },
  "zero-one": { d: "M0 10H19 M15 3V17 M3 10A4 4 0 1 1 11 10A4 4 0 1 1 3 10Z" },
  many: { d: "M0 10H19 M8 10L19 3 M8 10L19 17 M5 3V17" },
  "zero-many": { d: "M0 10H19 M8 10L19 3 M8 10L19 17 M-4 10A4 4 0 1 1 4 10A4 4 0 1 1 -4 10Z" },
};
const CARDS = new Set(["one", "zero-one", "many", "zero-many"]);
/**
 * Marker attributes for a connector's ends: ERD cardinality (`props.startCard`/`endCard`) wins,
 * else `props.startArrow`/`endArrow` (none, arrow, triangle, diamond, diamond-filled, circle);
 * without props the end has the plain arrow, as always.
 */
export function ends(s: Shape, ah: string): { markerStart?: string; markerEnd?: string } {
  const p = (s.props ?? {}) as Record<string, unknown>;
  const pick = (card: unknown, arrow: unknown, dflt: string) => {
    if (typeof card === "string" && CARDS.has(card)) return `url(#${ah}-${card})`;
    const a = typeof arrow === "string" ? arrow : dflt;
    if (a === "none") return undefined;
    if (a === "arrow") return `url(#${ah})`;
    return HEADS[a] ? `url(#${ah}-${a})` : `url(#${ah})`;
  };
  const out: { markerStart?: string; markerEnd?: string } = {};
  const st = pick(p.startCard, p.startArrow, "none"), en = pick(p.endCard, p.endArrow, "arrow");
  if (st) out.markerStart = st;
  if (en) out.markerEnd = en;
  return out;
}

