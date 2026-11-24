// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Level of detail for a zoomed-out board (DGM-19, ADR-046). Below `LOD.z` a board of more than
// `LOD.min` shapes is drawn as one `<path>` per style group instead of one React view per
// shape: boxes as plain rects (ellipses and diamonds keep their outline), no text, labels,
// icons, shadows or arrow heads, connectors and pen strokes as single polylines, and shapes
// smaller than `LOD.tiny` screen pixels collapsed into one path of dots. The groups depend on
// the shapes and a zoom bucket only, so panning re-renders nothing: the board draws them in
// their own SVG under the board SVG, moved by a CSS transform the compositor applies without
// rastering them again (BoardBlock `LodLayer`). At `LOD.z` and above nothing changes: the board
// draws its full views (render identity test, `lod.test.tsx`).
import { bbox, type Shape } from "./model";

/** Zoom below which big boards draw simplified; `min`: shape count above which LOD applies; `tiny`: px. */
export const LOD = { z: 0.4, min: 300, tiny: 2 };

export const lodOn = (z: number, n: number) => z < LOD.z && n > LOD.min;

/** Zoom rounded to quarter octaves: the tiny-shape cut moves in steps, not on every wheel event. */
export const lodBucket = (z: number) => 2 ** (Math.round(Math.log2(z) * 4) / 4);

export interface LodGroup {
  /** Style key: `f|<fill>|<stroke>` for boxes, `l|<stroke>|<width>` for lines, `t` for tiny shapes. */
  key: string;
  fill: string;
  stroke: string;
  width: number;
  d: string;
}

const TONES = new Set(["gray", "blue", "green", "amber", "red", "purple", "pink"]);
const n = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);

/**
 * The simplified groups for `shapes` at zoom bucket `zb`, in the order they are drawn: lines
 * first (under the boxes, as connectors mostly run between them), then box groups in order of
 * first appearance, then the tiny dots. `sticky` / `swatch`: the board's fill tables.
 */
export function lodGroups(shapes: readonly Shape[], zb: number, sticky: Record<string, string>, swatch: Record<string, string>): LodGroup[] {
  const lines = new Map<string, LodGroup>();
  const boxes = new Map<string, LodGroup>();
  const parts = new Map<LodGroup, string[]>();
  const tiny: string[] = [];
  const cut = LOD.tiny / zb;
  const group = (m: Map<string, LodGroup>, key: string, fill: string, stroke: string, width: number) => {
    let g = m.get(key);
    if (!g) {
      g = { key, fill, stroke, width, d: "" };
      m.set(key, g);
      parts.set(g, []);
    }
    return parts.get(g)!;
  };
  for (const s of shapes) {
    if (s.type === "arrow" || s.type === "pen") {
      const p = s.pts;
      if (!p || p.length < 2) continue;
      const stroke = s.type === "pen" ? (s.stroke === "accent" ? "var(--accent)" : "var(--fg-2)") : "var(--fg-2)";
      const w = s.type === "pen" ? 3 : 1.6;
      let d = "M" + n(p[0][0]) + " " + n(p[0][1]);
      for (let i = 1; i < p.length; i++) d += "L" + n(p[i][0]) + " " + n(p[i][1]);
      group(lines, "l|" + stroke + "|" + w, "none", stroke, w).push(d);
      continue;
    }
    const b = bbox(s);
    const x = n(Math.min(b[0], b[2])), y = n(Math.min(b[1], b[3]));
    const w = n(Math.abs(b[2] - b[0])), h = n(Math.abs(b[3] - b[1]));
    if (!(w || h)) continue;
    if (w < cut && h < cut) {
      const c = n(cut);
      tiny.push(`M${n(x + w / 2 - c / 2)} ${n(y + h / 2 - c / 2)}h${c}v${c}h${-c}z`);
      continue;
    }
    const tone = s.fill && TONES.has(s.fill) ? s.fill : null;
    const line = s.stroke === "accent" ? "var(--accent)" : "var(--fg-2)";
    let fill: string, stroke: string;
    if (s.type === "sticky") (fill = sticky[s.fill ?? "y"] ?? sticky.y), (stroke = "none");
    else if (s.type === "swatch") (fill = swatch[s.fill ?? "accent"] ?? swatch.accent), (stroke = "none");
    else if (s.type === "image") (fill = "var(--sunk)"), (stroke = "var(--line-2)");
    else if (s.type === "text") (fill = "var(--line-2)"), (stroke = "none");
    else if (s.dashed) (fill = "none"), (stroke = "var(--fg-3)");
    else (fill = tone ? `var(--${tone}-bg)` : "var(--app)"), (stroke = tone ? `var(--${tone}-fg)` : line);
    let d: string;
    if (s.type === "ellipse" && !s.kind) {
      const rx = w / 2, ry = h / 2;
      d = `M${x} ${n(y + ry)}a${n(rx)} ${n(ry)} 0 1 0 ${w} 0a${n(rx)} ${n(ry)} 0 1 0 ${-w} 0z`;
    } else if (s.type === "diamond" && !s.kind) {
      d = `M${n(x + w / 2)} ${y}l${n(w / 2)} ${n(h / 2)}l${n(-w / 2)} ${n(h / 2)}l${n(-w / 2)} ${n(-h / 2)}z`;
    } else d = `M${x} ${y}h${w}v${h}h${-w}z`;
    group(boxes, "f|" + fill + "|" + stroke, fill, stroke, 1.5).push(d);
  }
  const out: LodGroup[] = [];
  for (const g of [...lines.values(), ...boxes.values()]) {
    g.d = parts.get(g)!.join("");
    out.push(g);
  }
  if (tiny.length) out.push({ key: "t", fill: "var(--fg-3)", stroke: "none", width: 0, d: tiny.join("") });
  return out;
}
