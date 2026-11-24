// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import * as Y from "yjs";
import type { ArrowRoute, Binding } from "./connectors";
import type { Port } from "./ports";

export type ShapeType = "sticky" | "rect" | "ellipse" | "diamond" | "text" | "arrow" | "pen" | "swatch" | "image";
export type StickyFill = "y" | "p" | "b" | "g";
export type Pt = [number, number];

/** One board shape. Stored as a Y.Map with these keys under `boards/<id>/shapes/<shapeId>`. */
export interface Shape {
  id: string;
  type: ShapeType;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** sticky: y|p|b|g; swatch: accent|amber|green|pink|purple; rect/ellipse/diamond: a tone (blue, green, …) */
  fill?: string;
  /** text; arrow: label shown at the middle of the connector */
  text?: string;
  /** Shapes with the same group id select and move together. */
  group?: string;
  /** rect: small uppercase label in the corner (frames) */
  label?: string;
  dashed?: boolean;
  /** text: font size; sticky/rect/ellipse/diamond: text size (default 14) */
  size?: number;
  /** arrow / pen points */
  pts?: Pt[];
  /** "accent" for pen strokes */
  stroke?: string;
  /** arrow: shape + anchor the tail / head is attached to (see connectors.ts) */
  start?: Binding;
  end?: Binding;
  /** arrow: "elbow" for an orthogonal route; "straight" (or unset with a binding) for a line */
  route?: ArrowRoute;
  /**
   * arrow with `route: "elbow"`: "avoid" routes around other shapes (ADR-047, router.ts). Stored
   * intent only; the route is derived. Older clients and the exporters draw the plain elbow (the
   * exporters use the stored `pts` while their ends still match).
   */
  routing?: "avoid";
  /**
   * arrow: manual waypoints `[[x,y],…]` the connector passes through, in order. Ends still come
   * from bindings or `pts`; `pts` keeps the resolved path for readers that ignore `via`.
   */
  via?: Pt[];
  /** image: URL (host asset or data: URL) */
  src?: string;
  /** image: alt text / file name */
  alt?: string;
  /*
   * Diagram fields (ADR-045, Proposed). All optional and additive: 0.1.x clients ignore them and
   * keep them when they edit the shape (compat.test.ts). `type` stays one of the nine legacy
   * types (the kind's base), so older clients and the Rust exporter draw the base shape.
   */
  /** Namespaced shape kind refining `type`, e.g. `uml:class` (see registry.ts). */
  kind?: string;
  /** Schema version of `kind`'s `props`. */
  kindVersion?: number;
  /**
   * Kind-specific properties. Stored as a nested Y.Map, one key per property, so concurrent edits
   * of different properties merge (ADR-045); read as a plain object (`toJSON`). `updateShape` with
   * `props` merges per field (`undefined` removes one). The plain-object form that 0.1.x copies
   * write reads the same and is converted on the next edit.
   */
  props?: Record<string, unknown>;
  /** Named connection points in addition to the five legacy anchors (see ports.ts). */
  ports?: Port[];
}

export type BoardPreset = "blank" | "flow" | "brainstorm" | "mindmap" | "journey" | "moodboard" | "flowchart";
export const BOARD_PRESETS: BoardPreset[] = ["blank", "flow", "brainstorm", "mindmap", "journey", "moodboard", "flowchart"];

/** Transaction origin for local board mutations without a per-view undo origin. */
export const BOARD_ORIGIN = { source: "@opencanvas/board" };

export const nid = (p: string) => p + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 8);

export function boardsRoot(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap("boards") as Y.Map<Y.Map<unknown>>;
}

export function getBoardMap(doc: Y.Doc, boardId: string): Y.Map<unknown> | null {
  const m = boardsRoot(doc).get(boardId);
  return m instanceof Y.Map ? m : null;
}

function presetShapes(kind: BoardPreset): Omit<Shape, "id">[] {
  const sh: Omit<Shape, "id">[] = [];
  const st = (x: number, y: number, text: string, fill: StickyFill = "y", w = 150, h = 110) => sh.push({ type: "sticky", x, y, w, h, fill, text });
  const rc = (x: number, y: number, w: number, h: number, label = "", dashed = false, text = "") => sh.push({ type: "rect", x, y, w, h, label, dashed, text });
  const el = (x: number, y: number, w: number, h: number, text = "") => sh.push({ type: "ellipse", x, y, w, h, text });
  const dm = (x: number, y: number, w: number, h: number, text = "") => sh.push({ type: "diamond", x, y, w, h, text });
  const tx = (x: number, y: number, text: string, size = 18) => sh.push({ type: "text", x, y, text, size });
  const ar = (pts: Pt[]) => sh.push({ type: "arrow", pts });
  if (kind === "flow") {
    rc(30, 40, 250, 170, "Host app", true);
    st(56, 84, "Signs launch\ntoken (JWT)", "y", 190, 96);
    ar([[280, 132], [340, 132]]);
    st(340, 84, "Room on owner\nnode + WAL", "b");
    ar([[490, 132], [550, 132]]);
    st(550, 84, "Autosave →\nPUT /files/:id", "p");
    ar([[625, 194], [625, 250], [160, 250], [160, 214]]);
    tx(300, 284, "Every edit merges live. Saves go back to the host.", 14);
  } else if (kind === "brainstorm") {
    tx(30, 40, "Went well", 20);
    tx(270, 40, "To improve", 20);
    tx(510, 40, "Ideas", 20);
    st(30, 62, "Shipped the\nembed SDK beta", "g");
    st(30, 184, "Pairing on\nthe WAL", "g");
    st(270, 62, "Too many\nmeetings", "p");
    st(270, 184, "Flaky e2e\non Safari", "p");
    st(510, 62, "Demo day\nevery Friday", "b");
    st(510, 184, "Templates for\nretros", "y");
  } else if (kind === "mindmap") {
    const nodes: [number, number, string][] = [[60, 40, "Audience"], [60, 300, "Pricing"], [560, 40, "Channels"], [560, 300, "Metrics"], [310, 10, "Messaging"], [310, 330, "Timeline"]];
    nodes.forEach(([x, y]) => ar([[375, 207], [x + 65, y + 24]]));
    el(290, 170, 170, 74, "Launch plan");
    nodes.forEach(([x, y, t]) => rc(x, y, 130, 48, "", false, t));
  } else if (kind === "journey") {
    const a = ["Sees a shared\nlink in chat", "Lands in the\nhost app", "Picks a\ntemplate", "Mentions a\nteammate", "Opens it in\nevery standup"];
    const b = ["Unclear what\nit is", "No account\nneeded", "Too many\nchoices?", "Needs mobile", "Wants\nreminders"];
    const fills: StickyFill[] = ["b", "y", "g", "p", "g"];
    ["Discover", "Sign up", "First canvas", "Invite team", "Habit"].forEach((t, i) => {
      rc(20 + i * 150, 30, 136, 44, "", false, t);
      st(20 + i * 150, 92, a[i], fills[i], 136, 96);
      st(20 + i * 150, 200, b[i], "p", 136, 90);
    });
  } else if (kind === "moodboard") {
    ([[30, 30, 200, 150, "accent"], [250, 30, 150, 150, "amber"], [420, 30, 240, 100, "green"], [420, 150, 110, 130, "pink"], [550, 150, 110, 130, "purple"]] as const).forEach(([x, y, w, h, fill]) =>
      sh.push({ type: "swatch", x, y, w, h, fill }),
    );
    tx(30, 222, "Calm, precise, quietly confident", 20);
    st(30, 250, "Soft hairlines,\nno heavy borders", "y", 190, 90);
    st(250, 200, "Motion: springy,\nnever bouncy", "b", 150, 90);
  } else if (kind === "flowchart") {
    el(270, 20, 160, 56, "Start");
    ar([[350, 76], [350, 110]]);
    rc(260, 110, 180, 60, "", false, "User opens link");
    ar([[350, 170], [350, 200]]);
    dm(270, 200, 160, 100, "Has access?");
    ar([[430, 250], [540, 250]]);
    rc(540, 222, 150, 56, "", false, "Open editor");
    ar([[270, 250], [160, 250]]);
    rc(10, 222, 150, 56, "", false, "Ask the host");
    tx(470, 240, "yes", 13);
    tx(200, 240, "no", 13);
  }
  return sh;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Y.AbstractType);

/** `props` as stored: a nested Y.Map, one key per property, so edits merge per field (ADR-045). */
function propsToY(v: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, x] of Object.entries(v)) if (x !== undefined) m.set(k, x);
  return m;
}

/**
 * Merge a `props` patch into a shape field by field: `undefined` removes a property, anything
 * else replaces that one property (its value is plain JSON). A plain-object `props` (written by
 * a 0.1.x client's copy) is converted to the nested map first, keeping its properties.
 * A patch that is not an object (`undefined`, `null`) removes `props`.
 */
function mergeProps(s: Y.Map<unknown>, patch: unknown) {
  if (!isPlainObject(patch)) return void s.delete("props");
  let cur = s.get("props");
  if (!(cur instanceof Y.Map)) {
    const plain = isPlainObject(cur) ? { ...cur } : {};
    const next = propsToY(plain);
    s.set("props", next);
    cur = next;
    if (s.doc) watchProps(s.doc, s, next, plain);
  }
  const m = cur as Y.Map<unknown>;
  const mine = created.get(m);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) m.delete(k);
    else m.set(k, v);
    if (mine) {
      if (v === undefined) delete mine.vals[k];
      else mine.vals[k] = v;
    }
  }
}

/*
 * Concurrent creation of the nested `props` map (DGM-18). Two clients giving a shape its first
 * property at the same time (or both converting a 0.1.1 plain-object `props`) each set the key
 * `props` to a new Y.Map; Yjs keeps one of two concurrent values of a key, so the other client's
 * fields would be lost. The client whose map lost copies the fields it wrote into the winning map
 * when the remote update arrives (keys the winner already has keep their value), so the fields
 * merge as ADR-045 requires. Only maps this client created are watched, until the shape goes.
 */
interface Created {
  shape: Y.Map<unknown>;
  map: Y.Map<unknown>;
  vals: Record<string, unknown>;
}
/** Transaction origin of the repair writes (not a user edit: no undo entry). */
export const PROPS_MERGE_ORIGIN = { source: "@opencanvas/board", propsMerge: true };
const created = new WeakMap<Y.Map<unknown>, Created>();
const watching = new WeakMap<Y.Doc, Set<Created>>();

function watchProps(doc: Y.Doc, shape: Y.Map<unknown>, map: Y.Map<unknown>, vals: Record<string, unknown>) {
  const c: Created = { shape, map, vals };
  created.set(map, c);
  let set = watching.get(doc);
  if (!set) {
    const all = new Set<Created>();
    watching.set(doc, (set = all));
    doc.on("afterTransaction", (tr: Y.Transaction) => {
      if (tr.local || !all.size) return;
      for (const e of all) {
        if (e.shape._item?.deleted) {
          all.delete(e);
          continue;
        }
        if (!e.map._item?.deleted) continue;
        all.delete(e);
        const win = e.shape.get("props");
        if (!(win instanceof Y.Map)) continue;
        const missing = Object.entries(e.vals).filter(([k]) => !win.has(k));
        if (missing.length) doc.transact(() => missing.forEach(([k, v]) => win.set(k, v)), PROPS_MERGE_ORIGIN);
      }
    });
  }
  set.add(c);
}

function shapeToY(s: Shape): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined) continue;
    if (k === "props" && isPlainObject(v)) m.set(k, propsToY(v));
    else m.set(k, Array.isArray(v) ? v.map((p) => (Array.isArray(p) ? [p[0], p[1]] : p)) : v);
  }
  return m;
}

/** Create a board (default `blank`). Returns the new boardId. */
export function createBoard(doc: Y.Doc, preset: BoardPreset = "blank"): string {
  const id = nid("bd");
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    boardsRoot(doc).set(id, m);
    const shapes = new Y.Map<Y.Map<unknown>>();
    const order = new Y.Array<string>();
    m.set("shapes", shapes);
    m.set("order", order);
    const ids: string[] = [];
    for (const s of presetShapes(BOARD_PRESETS.includes(preset) ? preset : "blank")) {
      const sid = nid("s");
      shapes.set(sid, shapeToY({ ...s, id: sid }));
      ids.push(sid);
    }
    order.push(ids);
  }, BOARD_ORIGIN);
  return id;
}

/* ------------------------------------------------------------------ read */

export function readShapes(m: Y.Map<unknown>): Shape[] {
  const shapes = m.get("shapes");
  const order = m.get("order");
  if (!(shapes instanceof Y.Map)) return [];
  const out: Shape[] = [];
  const seen = new Set<string>();
  const push = (sid: string) => {
    if (seen.has(sid)) return;
    const s = shapes.get(sid);
    if (!(s instanceof Y.Map)) return;
    seen.add(sid);
    const j = s.toJSON() as Shape;
    j.id = sid;
    out.push(j);
  };
  if (order instanceof Y.Array) for (const sid of order.toArray()) push(String(sid));
  [...shapes.keys()].sort().forEach(push);
  return out;
}

/* ------------------------------------------------------------- mutations */

function ensure<T>(m: Y.Map<unknown>, key: string, make: () => T): T {
  const cur = m.get(key);
  if (cur instanceof Y.AbstractType) return cur as T;
  const n = make();
  m.set(key, n);
  return n;
}
const shapesOf = (m: Y.Map<unknown>) => ensure(m, "shapes", () => new Y.Map<Y.Map<unknown>>()) as Y.Map<Y.Map<unknown>>;
const orderOf = (m: Y.Map<unknown>) => ensure(m, "order", () => new Y.Array<string>()) as Y.Array<string>;

function tx(doc: Y.Doc, boardId: string, fn: (m: Y.Map<unknown>) => void, origin: unknown = BOARD_ORIGIN) {
  const m = getBoardMap(doc, boardId);
  if (!m) return;
  doc.transact(() => fn(m), origin);
}

export function addShape(doc: Y.Doc, boardId: string, s: Omit<Shape, "id"> & { id?: string }, origin?: unknown): string {
  const sid = s.id ?? nid("s");
  tx(doc, boardId, (m) => {
    shapesOf(m).set(sid, shapeToY({ ...s, id: sid } as Shape));
    orderOf(m).push([sid]);
  }, origin);
  return sid;
}

export function updateShape(doc: Y.Doc, boardId: string, sid: string, patch: Partial<Shape>, origin?: unknown) {
  tx(doc, boardId, (m) => {
    const s = shapesOf(m).get(sid);
    if (!(s instanceof Y.Map)) return;
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id") continue;
      if (k === "props") mergeProps(s, v);
      else if (v === undefined) s.delete(k);
      else if (s.get(k) !== v || Array.isArray(v)) s.set(k, Array.isArray(v) ? v.map((p) => (Array.isArray(p) ? [p[0], p[1]] : p)) : v);
    }
  }, origin);
}

/** Move many shapes at once (one transaction). */
export function moveShapes(doc: Y.Doc, boardId: string, moves: { id: string; patch: Partial<Shape> }[], origin?: unknown) {
  tx(doc, boardId, (m) => {
    const shapes = shapesOf(m);
    for (const { id, patch } of moves) {
      const s = shapes.get(id);
      if (!(s instanceof Y.Map)) continue;
      for (const [k, v] of Object.entries(patch)) {
        if (k === "props") mergeProps(s, v);
        else if (v !== undefined) s.set(k, v);
      }
    }
  }, origin);
}

export function deleteShape(doc: Y.Doc, boardId: string, sid: string, origin?: unknown) {
  tx(doc, boardId, (m) => {
    shapesOf(m).delete(sid);
    const order = orderOf(m);
    const arr = order.toArray();
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] === sid) order.delete(i, 1);
  }, origin);
}

export function duplicateShape(doc: Y.Doc, boardId: string, s: Shape, dx = 24, dy = 24, origin?: unknown): string {
  const n: Shape = JSON.parse(JSON.stringify(s));
  n.id = nid("s");
  // A copy of a bound connector is a free arrow at the same (offset) place.
  delete n.start;
  delete n.end;
  if (n.pts) n.pts = n.pts.map((p) => [p[0] + dx, p[1] + dy]);
  else {
    n.x = (n.x ?? 0) + dx;
    n.y = (n.y ?? 0) + dy;
  }
  return addShape(doc, boardId, n, origin);
}

/** Bring a shape to the front (end of `order`). */
export function bringToFront(doc: Y.Doc, boardId: string, sid: string, origin?: unknown) {
  tx(doc, boardId, (m) => {
    const order = orderOf(m);
    const arr = order.toArray();
    if (arr[arr.length - 1] === sid) return;
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] === sid) order.delete(i, 1);
    order.push([sid]);
  }, origin);
}

/* -------------------------------------------------------------- geometry */

export function bbox(s: Shape): [number, number, number, number] {
  if (s.pts && s.pts.length) {
    const xs = s.pts.map((p) => p[0]);
    const ys = s.pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  const x = s.x ?? 0, y = s.y ?? 0;
  if (s.type === "text") {
    const size = s.size || 18;
    const lines = String(s.text ?? "").split("\n");
    const w = Math.max(1, ...lines.map((l) => l.length)) * size * 0.56;
    return [x, y - size, x + w, y + 5 + (lines.length - 1) * size * 1.3];
  }
  return [x, y, x + (s.w ?? 0), y + (s.h ?? 0)];
}

export function contentBounds(shapes: Shape[]): [number, number, number, number] | null {
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

export function smooth(p: Pt[]): string {
  if (!p.length) return "";
  if (p.length < 3) return "M" + p.map((q) => q.map((n) => n.toFixed(1)).join(" ")).join(" L");
  let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
  for (let i = 1; i < p.length - 1; i++) {
    const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
    d += ` Q${p[i][0].toFixed(1)} ${p[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const l = p[p.length - 1];
  d += ` L${l[0].toFixed(1)} ${l[1].toFixed(1)}`;
  return d;
}

/** Drop points closer than `min` to the previous kept point. */
export function simplify(p: Pt[], min = 1.5): Pt[] {
  if (p.length < 3) return p;
  const out: Pt[] = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const l = out[out.length - 1];
    if (Math.hypot(p[i][0] - l[0], p[i][1] - l[1]) >= min) out.push([Math.round(p[i][0] * 10) / 10, Math.round(p[i][1] * 10) / 10]);
  }
  out.push(p[p.length - 1]);
  return out;
}
