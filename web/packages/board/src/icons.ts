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
import type * as Y from "yjs";
import type { Shape } from "./model";
import { kindOf, registerShape, registeredKinds } from "./registry";
import { LUCIDE_PREFIX, lucideLabel, readPaths } from "./lucide";

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

/**
 * Fields of a new icon shape centred on `at`. A built-in id, or `lucide:<name>` with its path data
 * (`paths`), which is embedded in the shape so every renderer draws it without the Lucide data.
 */
export function iconNodeFields(id: string, at: [number, number], paths?: readonly string[]): Omit<Shape, "id"> | null {
  const w = ICON_SIZE, h = ICON_SIZE;
  const box = { type: "rect" as const, kind: ICON_KIND, kindVersion: 1, x: Math.round(at[0] - w / 2), y: Math.round(at[1] - h / 2), w, h };
  const i = BY_ID.get(id);
  if (i) return { ...box, text: i.name, fill: toneOf(i), props: { icon: i.id, labelPos: "below" } };
  const name = id.startsWith(LUCIDE_PREFIX) ? id.slice(LUCIDE_PREFIX.length) : "";
  const ok = readPaths(paths);
  if (!/^[a-z0-9-]{1,64}$/.test(name) || !ok) return null;
  return { ...box, text: lucideLabel(name), fill: "gray", props: { icon: id, labelPos: "below", paths: [...ok] } };
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

/** Drag payload of an icon tile (`ICON_MIME`): a built-in id, or JSON `{id, paths}` for a Lucide icon. */
export const iconDragData = (id: string, paths?: readonly string[]) => (paths ? JSON.stringify({ id, paths }) : id);

/** Reads an icon drag payload; anything malformed gives undefined (paths are checked when placed). */
export function readIconDrag(v: string): { id: string; paths?: string[] } | undefined {
  if (!v) return undefined;
  if (!v.startsWith("{")) return { id: v };
  try {
    const o = JSON.parse(v) as { id?: unknown; paths?: unknown };
    const paths = readPaths(o.paths);
    return typeof o.id === "string" && paths ? { id: o.id, paths } : undefined;
  } catch {
    return undefined;
  }
}

/** Path data an icon shape draws, or null (not an icon shape, or an icon this build doesn't have). */
export function iconPathsOf(s: Partial<Shape> & Pick<Shape, "type">): readonly string[] | null {
  if (s.type !== "rect" || kindOf(s) !== ICON_KIND) return null;
  const id = iconProps(s).icon;
  const builtIn = iconById(id)?.paths;
  if (builtIn) return builtIn;
  // A Lucide icon carries its own path data (checked: path syntax only, at most 32 paths).
  if (id?.startsWith(LUCIDE_PREFIX)) return readPaths((s.props as Record<string, unknown> | undefined)?.paths);
  return null;
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

/* ---------------------------------------------------------------- icons added to the document */

/** Limits of the `icons` root (enforced by the server, `oc_model::doc_icons`). */
export const MAX_DOC_ICONS = 200;
export const MAX_DOC_ICON_BYTES = 1024 * 1024;

/** `props.icon` prefix of an icon added to the document (DGM-17 part 3, ADR-057). */
export const DOC_PREFIX = "doc:";

/** One icon in the server-written `icons` root. */
export interface DocIcon {
  id: string;
  name: string;
  keywords: string[];
  format: "svg" | "png";
  /** The cleaned file, base64. */
  data: string;
  width: number;
  height: number;
  bytes: number;
  by: string;
  byName: string;
  at: string;
}

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** The icons people added to this document, newest first. Malformed entries are skipped. */
export function readDocIcons(doc: Y.Doc): DocIcon[] {
  const root = doc.share.get("icons") ? (doc.getMap("icons") as Y.Map<unknown>) : null;
  if (!root) return [];
  const out: DocIcon[] = [];
  root.forEach((v, id) => {
    const o = v && typeof (v as { toJSON?: unknown }).toJSON === "function" ? ((v as Y.Map<unknown>).toJSON() as Record<string, unknown>) : (v as Record<string, unknown>);
    if (!o || typeof o !== "object") return;
    const format = o.format === "svg" || o.format === "png" ? o.format : null;
    if (!format || typeof o.data !== "string" || !B64_RE.test(o.data)) return;
    out.push({
      id,
      name: typeof o.name === "string" ? o.name : id,
      keywords: Array.isArray(o.keywords) ? o.keywords.filter((k): k is string => typeof k === "string") : [],
      format,
      data: o.data,
      width: Number(o.width) || 0,
      height: Number(o.height) || 0,
      bytes: Number(o.bytes) || 0,
      by: typeof o.by === "string" ? o.by : "",
      byName: typeof o.byName === "string" ? o.byName : "",
      at: typeof o.at === "string" ? o.at : "",
    });
  });
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id.localeCompare(b.id)));
}

/** A document icon as a `data:` URL; a PNG must carry the PNG signature. */
export function docIconUrl(i: Pick<DocIcon, "format" | "data">): string | null {
  if (i.format === "png") return i.data.startsWith("iVBORw0KGgo") ? `data:image/png;base64,${i.data}` : null;
  return `data:image/svg+xml;base64,${i.data}`;
}

/** Every document icon's `data:` URL, by id. */
export function docIconUrls(doc: Y.Doc): Map<string, string> {
  const m = new Map<string, string>();
  for (const i of readDocIcons(doc)) {
    const u = docIconUrl(i);
    if (u) m.set(i.id, u);
  }
  return m;
}

/** Fields of a new shape for a document icon centred on `at`. */
export function docIconNodeFields(i: DocIcon, at: [number, number]): Omit<Shape, "id"> {
  const w = ICON_SIZE, h = ICON_SIZE;
  return { type: "rect", kind: ICON_KIND, kindVersion: 1, x: Math.round(at[0] - w / 2), y: Math.round(at[1] - h / 2), w, h, text: i.name, props: { icon: DOC_PREFIX + i.id, labelPos: "below" } };
}

/** Search the document's icons by name and keywords (1f). */
export function searchDocIcons(list: readonly DocIcon[], q: string): { icon: DocIcon; at?: [number, number]; keyword?: string }[] {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const out: { icon: DocIcon; at?: [number, number]; keyword?: string; s: number }[] = [];
  for (const icon of list) {
    const i = icon.name.toLowerCase().indexOf(t);
    if (i >= 0) out.push({ icon, at: [i, i + t.length], s: i === 0 ? 0 : 1 });
    else {
      const k = icon.keywords.find((w) => w.includes(t));
      if (k) out.push({ icon, keyword: k, s: 2 });
    }
  }
  return out.sort((a, b) => a.s - b.s).map(({ s: _s, ...h }) => h);
}
