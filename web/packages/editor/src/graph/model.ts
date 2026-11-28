// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The knowledge graph's data (GRAPH-02/03, ADR-082): what the graph and the list draw from the
// answer of `GET /v1/graph`. Everything here is what the server already checked for this person;
// a canvas they cannot open was never sent, so nothing here can count or bridge one.

export type LinkKind = "link" | "embed" | "relation";
export interface ApiNode {
  id: string;
  kind: "canvas" | "block";
  fileId: string;
  blockId?: string;
  title: string | null;
  path: string | null;
  space: string | null;
  updatedAt: string | null;
  in: number;
  out: number;
  /** Who changed it last, when the host says (colour by owner). */
  updatedBy?: string | null;
}
export interface ApiEdge {
  from: string;
  to: string;
  /** `in` ties a block node to its canvas. */
  kind: LinkKind | "in";
}
export interface GraphData {
  nodes: ApiNode[];
  edges: ApiEdge[];
  truncated: boolean;
  total?: number;
}

export type Colour = "space" | "updated" | "owner";
export interface Filters {
  /** null: every space. */
  spaces: Set<string> | null;
  kinds: Set<LinkKind>;
  blocks: boolean;
  orphans: boolean;
  /** Days; 0 is any time. */
  within: number;
  search: string;
  colour: Colour;
}
export const defaults = (): Filters => ({ spaces: null, kinds: new Set(["link", "embed", "relation"]), blocks: false, orphans: true, within: 0, search: "", colour: "space" });

export interface VNode extends ApiNode {
  title: string;
  /** Links in and out among the canvases drawn (unique canvas pairs). */
  in: number;
  out: number;
}
export interface VEdge {
  s: string;
  t: string;
  k: LinkKind | "in";
}
export interface View {
  nodes: VNode[];
  edges: VEdge[];
  byId: Map<string, VNode>;
  /** Neighbours, both ways (block ties included). */
  nb: Map<string, Set<string>>;
  /** Search matches, or null without a search. */
  matches: Set<string> | null;
}

export const NO_SPACE = "No space";
export const spaceOf = (n: ApiNode) => n.space || NO_SPACE;
export const canvasOf = (id: string) => {
  const i = id.indexOf("#");
  return i < 0 ? id : id.slice(0, i);
};
const titleOf = (n: ApiNode) => n.title?.trim() || (n.kind === "block" ? "Untitled block" : "Untitled");

/** Canvases within `depth` links of `root`, both directions. */
export function around(edges: VEdge[], root: string, depth: number): Set<string> {
  const adj = new Map<string, string[]>();
  const add = (a: string, b: string) => (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
  for (const e of edges) {
    if (e.k === "in") continue;
    const s = canvasOf(e.s),
      t = canvasOf(e.t);
    add(s, t);
    add(t, s);
  }
  const d = new Map([[root, 0]]);
  const q = [root];
  while (q.length) {
    const x = q.shift()!;
    if (d.get(x)! >= depth) continue;
    for (const y of adj.get(x) ?? []) if (!d.has(y)) (d.set(y, d.get(x)! + 1), q.push(y));
  }
  return new Set(d.keys());
}

/** What to draw for these filters. `current` is never filtered out; `root` narrows to a local graph. */
export function view(data: GraphData, f: Filters, now: number, o: { current?: string | null; root?: string | null; depth?: number } = {}): View {
  const keep = (id: string) => id === o.current || id === o.root;
  const all = new Map(data.nodes.map((n) => [n.id, n]));
  const canv = new Set<string>();
  for (const n of data.nodes) {
    if (n.kind !== "canvas") continue;
    if (!keep(n.id)) {
      if (f.spaces && !f.spaces.has(spaceOf(n))) continue;
      if (f.within && !(n.updatedAt && now - Date.parse(n.updatedAt) <= f.within * 86400_000)) continue;
    }
    canv.add(n.id);
  }
  let edges: VEdge[] = [];
  const seen = new Set<string>();
  for (const e of data.edges) {
    if (e.kind === "in" || !f.kinds.has(e.kind)) continue;
    const tc = canvasOf(e.to);
    if (!canv.has(e.from) || !canv.has(tc) || e.from === tc) continue;
    const t = f.blocks && all.has(e.to) ? e.to : tc;
    const key = `${e.from}>${t}:${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ s: e.from, t, k: e.kind });
  }
  let ids = canv;
  if (o.root && canv.has(o.root)) {
    ids = around(edges, o.root, o.depth ?? 1);
    edges = edges.filter((e) => ids.has(e.s) && ids.has(canvasOf(e.t)));
  }
  const ins = new Map<string, number>(),
    outs = new Map<string, number>(),
    pairs = new Set<string>();
  for (const e of edges) {
    const tc = canvasOf(e.t);
    if (pairs.has(e.s + ">" + tc)) continue;
    pairs.add(e.s + ">" + tc);
    outs.set(e.s, (outs.get(e.s) ?? 0) + 1);
    ins.set(tc, (ins.get(tc) ?? 0) + 1);
  }
  const nodes: VNode[] = [];
  for (const id of ids) {
    const n = all.get(id)!;
    const i = ins.get(id) ?? 0,
      out = outs.get(id) ?? 0;
    if (!f.orphans && !i && !out && !keep(id)) continue;
    nodes.push({ ...n, title: titleOf(n), in: i, out });
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (f.blocks) {
    const bin = new Map<string, number>();
    for (const e of edges) if (e.t.includes("#")) bin.set(e.t, (bin.get(e.t) ?? 0) + 1);
    for (const [b, k] of bin) {
      const n = all.get(b);
      if (!n || !byId.has(n.fileId)) continue;
      const v: VNode = { ...n, title: titleOf(n), in: k, out: 0 };
      nodes.push(v);
      byId.set(b, v);
      edges.push({ s: b, t: n.fileId, k: "in" });
    }
  }
  edges = edges.filter((e) => byId.has(e.s) && byId.has(e.t));
  const nb = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]));
  for (const e of edges) (nb.get(e.s)!.add(e.t), nb.get(e.t)!.add(e.s));
  const q = f.search.trim().toLowerCase();
  const matches = q ? new Set(nodes.filter((n) => n.title.toLowerCase().includes(q)).map((n) => n.id)) : null;
  return { nodes, edges, byId, nb, matches };
}

// ---------- colours and words ----------

const TONES = ["blue", "purple", "pink", "green", "amber", "teal", "red", "gray"];
/** A tone per space, most canvases first, from the whole answer (stable while filtering). */
export function spaceTones(nodes: ApiNode[]): Map<string, string> {
  const n = new Map<string, number>();
  for (const x of nodes) if (x.kind === "canvas") n.set(spaceOf(x), (n.get(spaceOf(x)) ?? 0) + 1);
  const order = [...n.keys()].sort((a, b) => (a === NO_SPACE ? 1 : b === NO_SPACE ? -1 : n.get(b)! - n.get(a)! || a.localeCompare(b)));
  return new Map(order.map((s, i) => [s, s === NO_SPACE ? "gray" : TONES[i % (TONES.length - 1)]]));
}

export type Bucket = "today" | "week" | "month" | "older";
export function bucket(at: string | null | undefined, now: number): Bucket {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return "older";
  const hrs = (now - t) / 3600_000;
  return hrs < 24 ? "today" : hrs < 168 ? "week" : hrs < 720 ? "month" : "older";
}
export const BUCKETS: [Bucket, string, string][] = [
  ["today", "Today", "var(--accent)"],
  ["week", "This week", "color-mix(in srgb,var(--accent) 62%,var(--app))"],
  ["month", "This month", "color-mix(in srgb,var(--accent) 30%,var(--app))"],
  ["older", "Older", "var(--fg-4)"],
];
export function ownerColour(name: string | null | undefined): string {
  if (!name) return "var(--fg-4)";
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `var(--u${Math.abs(h) % 5})`;
}
export function colourOf(n: ApiNode, mode: Colour, tones: Map<string, string>, now: number): string {
  if (mode === "updated") return BUCKETS.find((b) => b[0] === bucket(n.updatedAt, now))![2];
  if (mode === "owner") return ownerColour(n.updatedBy);
  return `var(--${tones.get(spaceOf(n)) ?? "gray"}-fg)`;
}

export function ago(at: string | null | undefined, now: number): string {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return "";
  const h = Math.max(0, Math.round((now - t) / 3600_000));
  if (h < 1) return "just now";
  if (h < 24) return `${h} h ago`;
  if (h < 48) return "yesterday";
  if (h < 720) return `${Math.round(h / 24)} days ago`;
  const m = Math.round(h / 720);
  return m === 1 ? "1 month ago" : `${m} months ago`;
}
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
export const linksIn = (n: number) => `${plural(n, "link")} in`;

/** Who links here and where this links to, by title (cards, announcements). */
export function neighbours(v: View, id: string): { from: string[]; to: string[] } {
  const from: string[] = [],
    to: string[] = [];
  const isC = v.byId.get(id)?.kind === "canvas";
  for (const e of v.edges) {
    if (e.k === "in") continue;
    if (e.t === id || (isC && canvasOf(e.t) === id)) from.includes(e.s) || from.push(e.s);
    if (e.s === id) {
      const t = canvasOf(e.t);
      to.includes(t) || to.push(t);
    }
  }
  return { from, to };
}

export function describeNode(v: View, id: string, pinned = false): string {
  const n = v.byId.get(id);
  if (!n) return "";
  if (n.kind === "block") return `${n.title}, block in ${v.byId.get(n.fileId)?.title ?? "a canvas"}, ${linksIn(n.in)}`;
  return `${n.title}, ${spaceOf(n)}, ${linksIn(n.in)}, ${n.out} out, ${plural(v.nb.get(id)?.size ?? 0, "neighbour")}${pinned ? ", pinned" : ""}`;
}

// ---------- keyboard ----------

export interface Pt {
  id: string;
  x: number;
  y: number;
}
/** The nearest point in direction `dir` (within about 70° of it), favouring straight ahead. */
export function pickDirection<T extends Pt>(cur: Pt, dir: [number, number], cands: T[]): T | null {
  let best: T | null = null,
    bs = Infinity;
  for (const n of cands) {
    if (n.id === cur.id) continue;
    const dx = n.x - cur.x,
      dy = n.y - cur.y,
      d = Math.hypot(dx, dy) || 1,
      c = (dx * dir[0] + dy * dir[1]) / d;
    if (c < 0.35) continue;
    const s = d * (2.2 - c);
    if (s < bs) (bs = s), (best = n);
  }
  return best;
}

// ---------- the list ----------

export interface Row {
  id: string;
  title: string;
  space: string;
  in: number;
  out: number;
  from: string[];
  to: string[];
  updatedAt: string | null;
  updatedBy: string | null;
}
export type SortKey = "title" | "space" | "in" | "out" | "from" | "updated";
export function listRows(v: View): Row[] {
  return v.nodes
    .filter((n) => n.kind === "canvas" && (!v.matches || v.matches.has(n.id)))
    .map((n) => {
      const x = neighbours(v, n.id);
      return { id: n.id, title: n.title, space: spaceOf(n), in: n.in, out: n.out, from: x.from, to: x.to, updatedAt: n.updatedAt, updatedBy: n.updatedBy ?? null };
    });
}
export function sortRows(rows: Row[], key: SortKey, dir: "asc" | "desc"): Row[] {
  const val = (r: Row): number | string =>
    key === "title" ? r.title.toLowerCase() : key === "space" ? r.space.toLowerCase() : key === "from" ? r.from.length : key === "updated" ? (r.updatedAt ? Date.parse(r.updatedAt) : 0) : r[key];
  const s = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = val(a),
      y = val(b);
    return (x > y ? 1 : x < y ? -1 : 0) * s || a.title.localeCompare(b.title);
  });
}
const cell = (s: string | number) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
export function csv(rows: Row[]): string {
  return [["Canvas", "Space", "Links in", "Links out", "Updated"], ...rows.map((r) => [r.title, r.space, r.in, r.out, r.updatedAt ?? ""])].map((l) => l.map(cell).join(",")).join("\n");
}

// ---------- pins: per person, in this browser only (decision 7) ----------

const pinKey = (user: string, surface: string) => `oc.graph.pins.${user}.${surface}`;
export function loadPins(user: string, surface: string): Map<string, [number, number]> {
  try {
    const v = JSON.parse(localStorage.getItem(pinKey(user, surface)) || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return new Map();
    return new Map(Object.entries(v).filter((e): e is [string, [number, number]] => Array.isArray(e[1]) && e[1].length === 2 && e[1].every(Number.isFinite)));
  } catch {
    return new Map();
  }
}
export function savePins(user: string, surface: string, pins: Map<string, [number, number]>) {
  try {
    if (pins.size) localStorage.setItem(pinKey(user, surface), JSON.stringify(Object.fromEntries([...pins].slice(-2000))));
    else localStorage.removeItem(pinKey(user, surface));
  } catch {
    /* storage off: pins last for this view */
  }
}
