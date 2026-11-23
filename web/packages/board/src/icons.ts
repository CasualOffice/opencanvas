// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Built-in diagram icons (DGM-17, approved prototype docs/prototypes/icons-approved, frames 1a-1f).
// Generic only: Lucide (ISC) or drawn by OpenCanvas in Lucide's style. No vendor or product logo
// ships; product names are search keywords on generic icons, and people add real logos themselves.
//
// The data (`icons/generic.json` at the repo root) is shared with `oc-model`, which draws the same
// paths in exports. An icon on a board is one registry kind, `icon:node` on the `rect` base
// (ADR-045): `props.icon` names the icon, `props.labelPos` puts the label below (default), to the
// right or hides it. The four side ports are the legacy anchors. Older clients and exporters
// without icon support draw the rect with its text.
import data from "../../../../icons/generic.json";
import type { Shape } from "./model";
import { kindOf, registerShape, registeredKinds } from "./registry";

export const ICON_KIND = "icon:node";
/** Drag data type of an icon tile (the icon id); dropped with `KIND_MIME` = `icon:node`. */
export const ICON_MIME = "application/x-opencanvas-icon";
/** Default box of a new icon shape (the tile; the label sits outside it). */
export const ICON_SIZE = 52;

export interface IconCategory {
  id: string;
  name: string;
  /** Board tone of the category's tiles and shapes. */
  tone: string;
}

export interface GenericIcon {
  id: string;
  name: string;
  category: string;
  keywords: string[];
  /** SVG path data in a 24 × 24 box, stroked 2, round caps and joins. */
  paths: string[];
  source: "lucide" | "opencanvas";
}

export type LabelPos = "below" | "right" | "hidden";

const D = data as unknown as { categories: IconCategory[]; icons: GenericIcon[]; suggest: Record<string, string[]> };

export const ICON_CATEGORIES: readonly IconCategory[] = Object.freeze(D.categories.map((c) => Object.freeze({ ...c })));
export const GENERIC_ICONS: readonly GenericIcon[] = Object.freeze(D.icons.map((i) => Object.freeze({ ...i })));
const BY_ID = new Map(GENERIC_ICONS.map((i) => [i.id, i]));
const TONE = new Map(ICON_CATEGORIES.map((c) => [c.id, c.tone]));

export const iconById = (id: unknown): GenericIcon | undefined => (typeof id === "string" ? BY_ID.get(id) : undefined);
export const toneOf = (i: GenericIcon): string => TONE.get(i.category) ?? "gray";

if (!registeredKinds().includes(ICON_KIND)) {
  registerShape({ kind: ICON_KIND, base: "rect", version: 1, label: "Icon", bindable: true, library: "icons", look: { w: ICON_SIZE, h: ICON_SIZE } });
}

export const isIconNode = (s: Pick<Shape, "type"> & Partial<Shape>) => kindOf(s) === ICON_KIND;

/** The icon shape's props, read defensively (any writer may have put anything there). */
export function iconProps(s: Partial<Shape>): { icon?: string; labelPos: LabelPos } {
  const p = s.props && typeof s.props === "object" ? (s.props as Record<string, unknown>) : {};
  const labelPos: LabelPos = p.labelPos === "right" || p.labelPos === "hidden" ? p.labelPos : "below";
  return { icon: typeof p.icon === "string" ? p.icon : undefined, labelPos };
}

/** Fields of a new icon shape centred on `at`. */
export function iconNodeFields(id: string, at: [number, number]): Omit<Shape, "id"> | null {
  const i = BY_ID.get(id);
  if (!i) return null;
  const w = ICON_SIZE, h = ICON_SIZE;
  return { type: "rect", kind: ICON_KIND, kindVersion: 1, x: Math.round(at[0] - w / 2), y: Math.round(at[1] - h / 2), w, h, text: i.name, fill: toneOf(i), props: { icon: i.id, labelPos: "below" } };
}

export interface IconHit {
  id: string;
  /** Where the name matched ([start, end)), or the keyword that matched. */
  at?: [number, number];
  keyword?: string;
  score: number;
}

/** Search the built-in icons: name prefix, then anywhere in the name, then keywords. */
export function searchIcons(q: string): IconHit[] {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const out: IconHit[] = [];
  GENERIC_ICONS.forEach((icon, n) => {
    const name = icon.name.toLowerCase();
    const i = name.indexOf(t);
    let hit: IconHit | null = null;
    if (i === 0) hit = { id: icon.id, at: [0, t.length], score: 0 };
    else if (i > 0) hit = { id: icon.id, at: [i, i + t.length], score: 1 };
    else {
      const k = icon.keywords.find((w) => w.toLowerCase().includes(t));
      if (k) hit = { id: icon.id, keyword: k, score: k.toLowerCase().startsWith(t) ? 2 : 3 };
    }
    if (hit) out.push({ ...hit, score: hit.score * 10_000 + n });
  });
  return out.sort((a, b) => a.score - b.score);
}

/**
 * Generic icons that fit a product we don't ship a logo for (1e: "jitsi" → video bridge, video
 * call, relay). Empty when we know nothing about the word.
 */
export function suggestIcons(q: string): GenericIcon[] {
  const t = q.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const ids = D.suggest[t] ?? [];
  return ids.map((id) => BY_ID.get(id)).filter((i): i is GenericIcon => !!i);
}

/** Path data an icon shape draws, or null (not an icon shape, or an icon this build doesn't have). */
export function iconPathsOf(s: Partial<Shape> & Pick<Shape, "type">): readonly string[] | null {
  if (s.type !== "rect" || kindOf(s) !== ICON_KIND) return null;
  return iconById(iconProps(s).icon)?.paths ?? null;
}

/** The glyph's square inside the box: half the shorter side, centred. Same in every renderer. */
export function iconGlyphBox(s: Partial<Shape>): { x: number; y: number; size: number } {
  const x = s.x ?? 0, y = s.y ?? 0, w = s.w ?? 0, h = s.h ?? 0;
  const size = Math.min(w, h) * 0.5;
  return { x: x + (w - size) / 2, y: y + (h - size) / 2, size };
}

/** Icon labels: 13 px semibold, 17 px lines, below the box or 10 px to its right. */
export const ICON_LABEL = { size: 13, lh: 17, gap: 10 };

/** Where an icon shape's label goes (lines, first baseline, anchor) and its box; null when hidden or empty. */
export function iconLabelLayout(s: Partial<Shape>): { lines: string[]; x: number; y: number; middle: boolean; box: [number, number, number, number] } | null {
  const { labelPos } = iconProps(s);
  const text = String(s.text ?? "");
  if (labelPos === "hidden" || !text.trim()) return null;
  const x = s.x ?? 0, y = s.y ?? 0, w = s.w ?? 0, h = s.h ?? 0;
  const { size, lh, gap } = ICON_LABEL;
  const lines = text.split("\n");
  const lw = Math.max(...lines.map((l) => l.length)) * size * 0.56;
  if (labelPos === "right") {
    const y0 = y + h / 2 + size * 0.36 - ((lines.length - 1) * lh) / 2;
    return { lines, x: x + w + gap, y: y0, middle: false, box: [x + w, y + h / 2 - (lines.length * lh) / 2, x + w + gap + lw, y + h / 2 + (lines.length * lh) / 2] };
  }
  return { lines, x: x + w / 2, y: y + h + lh, middle: true, box: [x + w / 2 - lw / 2, y + h, x + w / 2 + lw / 2, y + h + 6 + lines.length * lh] };
}
