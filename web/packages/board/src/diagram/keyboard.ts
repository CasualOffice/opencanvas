// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Diagram keyboard and outline logic (DGM-14 S5, prototype 5a-5d). Pure, no rendering.
import { bbox, type Shape } from "../model";
import { BINDABLE, type Binding } from "../connectors";
import { isContainer } from "../kinds";

const TYPE: Record<string, string> = { sticky: "Sticky note", rect: "Rectangle", ellipse: "Ellipse", diamond: "Diamond", text: "Text", arrow: "Connector", pen: "Drawing", swatch: "Colour swatch", image: "Image" };

export const shapeName = (s: Shape) => {
  const t = (s.text ?? s.label ?? s.alt ?? "").replace(/\s+/g, " ").trim();
  return t || TYPE[s.type] || "Shape";
};
export const kindName = (s: Shape) => TYPE[s.type] ?? "Shape";

/** A container is a frame-like rectangle (has a corner label, or is dashed) that holds other shapes. */
const isFrame = (s: Shape) => isContainer(s) || (s.type === "rect" && (!!s.label || !!s.dashed));
const inside = (a: Shape, b: Shape) => {
  const [ax0, ay0, ax1, ay1] = bbox(a), [bx0, by0, bx1, by1] = bbox(b);
  return a !== b && ax0 >= bx0 && ay0 >= by0 && ax1 <= bx1 && ay1 <= by1;
};
const area = (s: Shape) => {
  const [x0, y0, x1, y1] = bbox(s);
  return (x1 - x0) * (y1 - y0);
};

export interface OutlineNode {
  id: string;
  name: string;
  kind: string;
  depth: number;
  parent: string | null;
  children: string[];
  connector: boolean;
}

/**
 * The outline (5a): containers and their shapes as a tree in board order, then connectors.
 * A shape's parent is the smallest frame that holds it entirely.
 */
export function outlineTree(shapes: Shape[]): OutlineNode[] {
  const nodes = shapes.filter((s) => s.type !== "arrow" && s.type !== "pen");
  const frames = nodes.filter(isFrame);
  const parentOf = new Map<string, string | null>();
  for (const s of nodes) {
    let best: Shape | null = null;
    for (const f of frames) if (inside(s, f) && (!best || area(f) < area(best))) best = f;
    parentOf.set(s.id, best?.id ?? null);
  }
  const kids = new Map<string | null, Shape[]>();
  for (const s of nodes) {
    const p = parentOf.get(s.id) ?? null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(s);
  }
  const out: OutlineNode[] = [];
  const walk = (p: string | null, depth: number) => {
    for (const s of kids.get(p) ?? []) {
      out.push({ id: s.id, name: shapeName(s), kind: kindName(s), depth, parent: p, children: (kids.get(s.id) ?? []).map((c) => c.id), connector: false });
      walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  const byId = new Map(shapes.map((s) => [s.id, s]));
  for (const s of shapes) {
    if (s.type !== "arrow") continue;
    const a = s.start && byId.get(s.start.shapeId), b = s.end && byId.get(s.end.shapeId);
    const name = s.text?.trim() ? `“${s.text.trim()}”` : a && b ? `${shapeName(a)} → ${shapeName(b)}` : "Connector";
    out.push({ id: s.id, name, kind: "Connector", depth: 0, parent: null, children: [], connector: true });
  }
  return out;
}

/** Rows shown when only `open` containers are expanded. */
export function visibleRows(tree: OutlineNode[], open: Set<string>): OutlineNode[] {
  const byId = new Map(tree.map((n) => [n.id, n]));
  const shown = (n: OutlineNode): boolean => !n.parent || (open.has(n.parent) && shown(byId.get(n.parent)!));
  return tree.filter(shown);
}

/** What a screen reader hears for a shape (5a): name, kind, container, connections, position. */
export function announce(shapes: Shape[], id: string, selected: boolean): string {
  const tree = outlineTree(shapes);
  const n = tree.find((x) => x.id === id);
  if (!n) return "";
  const parent = n.parent ? tree.find((x) => x.id === n.parent) : null;
  const links = shapes.filter((s) => s.type === "arrow" && (s.start?.shapeId === id || s.end?.shapeId === id)).length;
  const parts = [n.name, n.kind];
  if (parent) parts.push(`in ${parent.name}`);
  if (!n.connector) parts.push(`${links} ${links === 1 ? "connection" : "connections"}`);
  if (selected) parts.push("selected");
  return `${parts.join(", ")}. ${tree.indexOf(n) + 1} of ${tree.length}.`;
}

/** ⌥↑ / ⌥↓ in the outline: the previous / next sibling of `id` (same container), or null. */
export function siblingOf(shapes: Shape[], id: string, dir: -1 | 1): string | null {
  const tree = outlineTree(shapes);
  const n = tree.find((x) => x.id === id);
  if (!n) return null;
  const sibs = tree.filter((x) => x.parent === n.parent && x.connector === n.connector);
  return sibs[sibs.indexOf(n) + dir]?.id ?? null;
}

/* ---- keyboard connector (5c) ---- */

export type Side = "top" | "right" | "bottom" | "left";
export interface Connecting {
  from: string;
  to: string | null;
  side: Side;
}

const centre = (s: Shape): [number, number] => {
  const [x0, y0, x1, y1] = bbox(s);
  return [(x0 + x1) / 2, (y0 + y1) / 2];
};
const bindable = (s: Shape) => BINDABLE.includes(s.type);

/** The side of `to` that faces `from`. */
export function facingSide(from: Shape, to: Shape): Side {
  const [ax, ay] = centre(from), [bx, by] = centre(to);
  const dx = ax - bx, dy = ay - by;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top";
}

/** C: starts at `from`, first target the nearest other shape. */
export function startConnect(shapes: Shape[], from: string): Connecting | null {
  const a = shapes.find((s) => s.id === from);
  if (!a || !bindable(a)) return null;
  const c = centre(a);
  const others = shapes.filter((s) => s.id !== from && bindable(s)).sort((p, q) => dist(centre(p), c) - dist(centre(q), c));
  const to = others[0] ?? null;
  return { from, to: to?.id ?? null, side: to ? facingSide(a, to) : "left" };
}
const dist = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** Tab / Shift+Tab: the next or previous target, in order of distance from the start. */
export function nextTarget(shapes: Shape[], st: Connecting, dir: 1 | -1 = 1): Connecting {
  const a = shapes.find((s) => s.id === st.from);
  if (!a) return st;
  const c = centre(a);
  const others = shapes.filter((s) => s.id !== st.from && bindable(s)).sort((p, q) => dist(centre(p), c) - dist(centre(q), c));
  if (!others.length) return st;
  const i = others.findIndex((s) => s.id === st.to);
  const to = others[(i + dir + others.length) % others.length];
  return { ...st, to: to.id, side: facingSide(a, to) };
}

export const SIDE_KEYS: Record<string, Side> = { ArrowUp: "top", ArrowRight: "right", ArrowDown: "bottom", ArrowLeft: "left" };

/** The connector the state describes: start leaves the side facing the target. */
export function connectorFor(shapes: Shape[], st: Connecting): { start: Binding; end: Binding } | null {
  const a = shapes.find((s) => s.id === st.from), b = st.to ? shapes.find((s) => s.id === st.to) : null;
  if (!a || !b) return null;
  return { start: { shapeId: a.id, anchor: facingSide(b, a) }, end: { shapeId: b.id, anchor: st.side } };
}

export function connectAnnouncement(shapes: Shape[], st: Connecting): string {
  const b = st.to ? shapes.find((s) => s.id === st.to) : null;
  return b ? `To ${shapeName(b)}, ${st.side} side. Press Enter to connect.` : "No other shape to connect to.";
}

/* ---- commands (5b) ---- */

export interface Command {
  id: string;
  label: string;
  group: "Commands" | "Go to" | "Help";
  keys?: string[];
  /** Shown only when this is true for the selection. */
  when?: (ctx: CommandContext) => boolean;
  hint?: string;
}
export interface CommandContext {
  sel: Shape[];
  edit: boolean;
}

/** Case-insensitive subsequence-free match: every word of the query starts a word, or is in the label. */
export function matches(label: string, q: string): number {
  const l = label.toLowerCase(), t = q.trim().toLowerCase();
  if (!t) return 1;
  if (l.startsWith(t)) return 3;
  if (l.split(/[^a-z0-9]+/).some((w) => w.startsWith(t))) return 2;
  return l.includes(t) ? 1 : 0;
}

/** Commands plus the shapes whose names match (Go to), ranked; the best first. */
export function filterCommands(cmds: Command[], shapes: Shape[], ctx: CommandContext, q: string): Command[] {
  const avail = cmds.filter((c) => !c.when || c.when(ctx));
  const scored = avail.map((c) => [c, matches(c.label, q)] as const).filter(([, s]) => s > 0);
  const go: (readonly [Command, number])[] = q.trim()
    ? shapes
        .filter((s) => s.type !== "pen")
        .map((s) => [{ id: `go:${s.id}`, label: s.type === "arrow" ? (s.text?.trim() ? `“${s.text.trim()}”` : "Connector") : shapeName(s), group: "Go to" as const, hint: kindName(s) }, matches(shapeName(s), q)] as const)
        .filter(([, s]) => s > 0)
        .slice(0, 8)
    : ctx.sel.map((s) => [{ id: `go:${s.id}`, label: shapeName(s), group: "Go to" as const, hint: kindName(s) }, 1] as const);
  const all = [...scored, ...go];
  const order = { Commands: 0, "Go to": 1, Help: 2 };
  // Best score wins first place (typing a shape name jumps to it); groups keep their order after it.
  const best = all.reduce<(typeof all)[number] | null>((b, x) => (!b || x[1] > b[1] ? x : b), null);
  const rest = all.filter((x) => x !== best).sort((a, b) => order[a[0].group] - order[b[0].group] || b[1] - a[1]);
  return best ? [best[0], ...rest.map((x) => x[0])] : [];
}

export const SHORTCUTS: [string, [string, string[]][]][] = [
  ["Move around", [["Next or previous shape", ["Tab"]], ["Zoom to fit", ["⇧", "1"]], ["Zoom in or out", ["⌘", "+"]], ["Commands", ["⌘", "K"]], ["Outline", ["⌥", "O"]]]],
  ["View", [["Minimap", ["M"]], ["Back to document", ["Esc"]], ["Keyboard shortcuts", ["?"]]]],
  ["Edit", [["Rename", ["F2"]], ["Move 1 px", ["←"]], ["Move 10 px", ["⇧", "←"]], ["Duplicate", ["⌘", "D"]], ["Group", ["⌘", "G"]]]],
  ["Connect", [["Start a connector", ["C"]], ["Pick a side", ["←", "↑"]], ["Next target", ["Tab"]], ["Connect", ["↵"]]]],
];

export function boxOf(s: Shape) {
  return bbox(s);
}
export { isFrame };
