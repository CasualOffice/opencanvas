// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The insert menu model (INS-01, ADR-062, docs/prototypes/insert-menu-approved): what the "/"
// menu, the phone sheet and the gallery offer, in which bands, and how keys move through it.
// Pure: no editor, no DOM. One engine for every surface; the host's editor profile (EDP-01,
// profile.ts) decides what is offered, through the shared filter `blockAllowed`.
import type { BlockPackage } from "../../ext/model";
import { blockVisibleInMenus } from "../../ext/discovery";
import { blockAllowed, type EditorProfile } from "../profile";
import { BLOCKS, CATS, CORE_TO_ENTRY, DEFAULT_CHIPS, DEFAULT_QUICK, ORG_HEAD, PROFILE_DEFAULTS, STOP, type BlockDef, type Cat, type CatId, type Variant } from "./catalogue";
import { RECENT_SHOWN, ranked, type RecentRec } from "./recent";

export interface Ctx {
  profile: EditorProfile | null;
  /** The assistant is on for this person (docs/24). */
  ai: boolean;
  /** The host lets this person import. */
  imp: boolean;
  /** The SDK blocks this host enables (the session's `blocks`). */
  pkgs: BlockPackage[];
  rec: RecentRec;
  now: number;
}

/** A profile with this many blocks or fewer gets one flat list (5a). */
export const FLAT_MAX = 8;
export const QUICK_MAX = 5;

// ---------- what this profile offers ----------

/** An SDK block as a catalogue entry: in its `discovery.category`, and always under Extensions. */
export function sdkBlock(pkg: BlockPackage): BlockDef & { ext: BlockPackage } {
  const d = pkg.discovery;
  const cat = CATS.find((c) => c.disc === d?.category && c.id !== "ext")?.id ?? "ext";
  const kw = [...new Set([...(d?.keywords ?? []), ...(pkg.keywords ?? [])].map((k) => k.toLowerCase()))];
  return {
    key: "ext:" + pkg.type,
    icon: "puzzle",
    title: d?.label ?? pkg.title,
    desc: [pkg.publisher, pkg.description].filter(Boolean).join(" · "),
    cat,
    // The manifest's keywords double as its intent phrases ("plan sprint"): no second field.
    names: [pkg.type.toLowerCase(), ...(pkg.publisher ? [pkg.publisher.toLowerCase()] : []), ...kw],
    intents: kw,
    why: pkg.description ?? pkg.title,
    needs: [],
    ext: pkg,
  };
}

export type Block = BlockDef & { ext?: BlockPackage };

function sdkAllowed(pkg: BlockPackage, p: EditorProfile | null): boolean {
  if (!p) return blockVisibleInMenus(pkg);
  if (p.blocks.includes(pkg.type)) return true;
  if (p.blocks.some((b) => !b.startsWith("core."))) return false;
  return blockVisibleInMenus({ discovery: pkg.discovery && Array.isArray(pkg.discovery.profiles) ? pkg.discovery : null }, p.profile);
}

const needOk = (needs: string[], p: EditorProfile | null) => needs.some((b) => blockAllowed(b, p));

export function variantsOf(b: Block, ctx: Ctx): Variant[] {
  return (b.variants ?? []).filter((v) => needOk(v.needs, ctx.profile));
}

/** Every block (and action) this person may insert, in catalogue order, SDK blocks last. */
export function offered(ctx: Ctx): Block[] {
  const own = BLOCKS.filter((b) => {
    if (b.action === "assistant" && !ctx.ai) return false;
    if (b.action === "import" && !ctx.imp) return false;
    if (b.variants) return variantsOf(b, ctx).length > 0;
    return needOk(b.needs, ctx.profile);
  });
  return [...own, ...ctx.pkgs.filter((p) => sdkAllowed(p, ctx.profile)).map(sdkBlock)];
}

/** Blocks, not actions: what the flat-list rule and the category counts count. */
export const blocksOnly = (ctx: Ctx) => offered(ctx).filter((b) => !b.action);

/** For surfaces outside the menu (gutter "+", phone "+"): what the profile alone allows. */
export const profileCtx = (profile: EditorProfile | null, pkgs: BlockPackage[]): Ctx => ({ profile, ai: false, imp: false, pkgs, rec: { recent: [], variant: {} }, now: 0 });

/** "Nothing to insert" (5d): only Text. No menu, no gutter "+", no phone "+". */
export const nothingToInsert = (ctx: Ctx) => blocksOnly(ctx).every((b) => b.key === "text");

export const isFlat = (ctx: Ctx) => blocksOnly(ctx).length <= FLAT_MAX;

/** The variant a row shows: remembered, else the profile's default, else the block's. */
export function currentVariant(b: Block, ctx: Ctx): Variant | undefined {
  const vs = variantsOf(b, ctx);
  if (!vs.length) return undefined;
  const pick = (id?: string) => (id ? vs.find((v) => v.id === id) : undefined);
  return pick(ctx.rec.variant[b.key]) ?? pick(ctx.profile ? PROFILE_DEFAULTS[ctx.profile.profile]?.[b.key] : undefined) ?? pick(b.def) ?? vs[0];
}

// ---------- rows ----------

export interface Row {
  /** Unique within a view. */
  key: string;
  block: Block;
  variant?: Variant;
  /** A variant fixed by the host's quick_insert ("list:checklist"): Tab does not change it. */
  fixed?: boolean;
  /** The intent result's "why" line, and the query words it matched (bold). */
  why?: string;
  matched?: string[];
  /** A note after the variant ("matches “task”"). */
  note?: string;
}

const rowOf = (b: Block, ctx: Ctx, variant?: Variant, more: Partial<Row> = {}): Row => {
  const v = variant ?? currentVariant(b, ctx);
  return { key: b.key + (v ? ":" + v.id : ""), block: b, variant: v, ...more };
};

/** Label for screen readers and tests: "Heading, Heading 2". */
export const rowLabel = (r: Row) => (r.variant ? `${r.block.title}, ${r.variant.label}` : r.block.title);

/** Quick insert tiles (1a): the host's `quick_insert`, else the defaults, filled to five. */
export function quickRows(ctx: Ctx): Row[] {
  const all = offered(ctx);
  const byKey = new Map(all.map((b) => [b.key, b]));
  const out: Row[] = [];
  const add = (key: string, variant?: string) => {
    const b = byKey.get(key);
    if (!b || b.action || out.length >= QUICK_MAX) return;
    const v = variant ? variantsOf(b, ctx).find((x) => x.id === variant) : undefined;
    if (variant && !v) return;
    const r = rowOf(b, ctx, v, { fixed: !!v });
    if (!out.some((o) => o.key === r.key)) out.push(r);
  };
  const host = ctx.profile?.quickInsert ?? [];
  if (host.length) {
    for (const id of host) {
      const e = CORE_TO_ENTRY[id];
      if (e) add(e[0], e[1]);
      else add("ext:" + id);
    }
    return out;
  }
  for (const k of DEFAULT_QUICK) add(k);
  for (const b of all) add(b.key);
  return out;
}

/** Recent (4a): variant level, at most four, nothing that is already a quick tile. */
export function recentRows(ctx: Ctx, quick = quickRows(ctx)): Row[] {
  const byKey = new Map(offered(ctx).map((b) => [b.key, b]));
  const out: Row[] = [];
  for (const e of ranked(ctx.rec.recent, ctx.now)) {
    const b = byKey.get(e.block);
    if (!b || b.action) continue;
    const vs = variantsOf(b, ctx);
    const v = e.variant ? vs.find((x) => x.id === e.variant) : undefined;
    if (e.variant && !v) continue;
    if (!e.variant && vs.length) continue;
    const key = b.key + (v ? ":" + v.id : "");
    if (quick.some((q) => q.key === key) || out.some((o) => o.key === key)) continue;
    out.push({ key, block: b, variant: v, fixed: !!v });
    if (out.length >= RECENT_SHOWN) break;
  }
  return out;
}

/** The goal chips: the host's, the built-in ones, or none (`intents = false`). */
export function chips(ctx: Ctx): string[] {
  if (ctx.profile?.intents === false) return [];
  return ctx.profile?.chips?.length ? ctx.profile.chips : DEFAULT_CHIPS;
}

/** The blocks of a category, in catalogue order; SDK blocks after the built-in ones. */
export function catBlocks(cat: CatId, ctx: Ctx): { own: Block[]; org: Block[] } {
  const all = offered(ctx).filter((b) => b.action !== "assistant");
  if (cat === "ext") return { own: [], org: all.filter((b) => b.ext) };
  return { own: all.filter((b) => !b.ext && b.cat === cat), org: all.filter((b) => b.ext && b.cat === cat) };
}

export function catCount(cat: CatId, ctx: Ctx): number {
  const { own, org } = catBlocks(cat, ctx);
  return own.filter((b) => !b.action).length + org.length;
}

/** The five categories with what this person can insert; empty ones are absent (1e). */
export const cats = (ctx: Ctx): Cat[] => CATS.filter((c) => catCount(c.id, ctx) > 0);

/** The flat list (5a): the host's order (`quick_insert`), then the rest in catalogue order. */
export function flatRows(ctx: Ctx): Row[] {
  const blocks = blocksOnly(ctx);
  const out: Row[] = [];
  for (const id of ctx.profile?.quickInsert ?? []) {
    const e = CORE_TO_ENTRY[id];
    const b = blocks.find((x) => x.key === (e ? e[0] : "ext:" + id));
    if (b && !out.some((o) => o.block === b)) out.push(rowOf(b, ctx, e?.[1] ? variantsOf(b, ctx).find((v) => v.id === e[1]) : undefined));
  }
  for (const b of blocks) if (!out.some((o) => o.block === b)) out.push(rowOf(b, ctx));
  return out;
}

// ---------- search (2d, 3a-3d, 6a) ----------

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const words = (s: string) => norm(s).split(/[^a-z0-9#\-[\].`>]+/).filter(Boolean);

/** A crude stem: "tasks" → "task", "planning" → "plan". */
export function stem(w: string): string {
  let s = w.toLowerCase();
  for (const suf of ["ing", "ies", "es", "ed", "s"]) {
    if (s.length > suf.length + 2 && s.endsWith(suf)) {
      s = s.slice(0, -suf.length) + (suf === "ies" ? "y" : "");
      break;
    }
  }
  if (/(.)\1$/.test(s) && s.length > 3) s = s.slice(0, -1);
  return s;
}

export const queryWords = (q: string) => words(q).filter((w) => !STOP.has(w));

const wordMatches = (q: string, w: string) => w === q || stem(w) === stem(q) || (q.length >= 3 && w.startsWith(q));

/** Name tiers, best first: title prefix, title word prefix, alias or variant, title contains. */
function nameTier(q: string, b: Block, v?: Variant): number {
  const t = b.title.toLowerCase();
  if (t.startsWith(q)) return 0;
  if (t.split(/\s+/).some((w) => w.startsWith(q))) return 1;
  const names = v ? [...v.names, v.label.toLowerCase()] : b.names;
  if (names.some((n) => n.startsWith(q))) return 2;
  if (v && b.names.some((n) => n.startsWith(q))) return 2;
  if (t.includes(q)) return 3;
  return -1;
}

const INTENT_FULL = 4;
const INTENT_PART = 5;
const DESC = 6;

/** Intent words: every non-stop word matches a word (or stem) of one entry (3d). */
function intentMatch(qw: string[], b: Block, v?: Variant): { tier: number; matched: string[] } | null {
  if (!qw.length) return null;
  const phrases = [...(v?.intents ?? []), ...b.intents];
  let best: string[] = [];
  for (const p of phrases) {
    const pw = words(p);
    const m = qw.filter((q) => pw.some((w) => wordMatches(q, w)));
    if (m.length > best.length) best = m;
    if (best.length === qw.length) break;
  }
  if (best.length === qw.length) return { tier: INTENT_FULL, matched: best };
  if (best.length && qw.length > 1) return { tier: INTENT_PART, matched: best };
  return null;
}

interface Hit {
  row: Row;
  tier: number;
  order: number;
  n: number;
}

export interface Group {
  head: string;
  icon?: string;
  /** "Good for “…”" (intent results) rather than a category. */
  intent?: boolean;
  rows: Row[];
}

export interface Results {
  groups: Group[];
  /** No match: the closest name within two letters (6a). */
  didYouMean?: Row;
}

/** Matches for a typed query. Name matches are grouped by category; intent matches come in one
 *  "Good for" group, first, for a phrase or when nothing matches by name. */
export function search(query: string, ctx: Ctx): Results {
  const q = norm(query);
  const qw = queryWords(q);
  const hits: Hit[] = [];
  offered(ctx).forEach((b, order) => {
    const vs = variantsOf(b, ctx);
    // Names: one row per block, on its best-matching variant.
    let best: { tier: number; v?: Variant } | null = null;
    const bt = nameTier(q, b);
    if (bt >= 0) best = { tier: bt, v: currentVariant(b, ctx) };
    for (const v of vs) {
      const t = nameTier(q, b, v);
      // A variant's own name beats the block's title only when it is a better tier.
      if (t >= 0 && v.names.concat(v.label.toLowerCase()).some((n) => n.startsWith(q)) && (!best || t < best.tier)) best = { tier: t, v };
    }
    if (best) {
      const v = best.v;
      const note = v && best.tier === 2 && !v.names.some((n) => n === q) && !v.label.toLowerCase().startsWith(q) ? alias(q, v) : undefined;
      hits.push({ row: rowOf(b, ctx, v, note ? { note } : {}), tier: best.tier, order, n: 0 });
      return;
    }
    // Intents: a row per matching variant (3c: Diagram three times, each on its type).
    const targets: (Variant | undefined)[] = vs.length ? vs : [undefined];
    const found: Hit[] = [];
    for (const v of targets) {
      const m = intentMatch(qw, b, v);
      if (m) found.push({ row: rowOf(b, ctx, v, { why: v?.why ?? b.why, matched: m.matched }), tier: m.tier, order, n: m.matched.length });
    }
    if (found.length) {
      found.sort((a, c) => a.tier - c.tier || c.n - a.n);
      hits.push(...found.slice(0, 3));
      return;
    }
    if (q.length >= 3 && (b.desc.toLowerCase().includes(q) || (b.md ?? "") === q)) hits.push({ row: rowOf(b, ctx), tier: DESC, order, n: 0 });
  });
  hits.sort((a, b) => a.tier - b.tier || b.n - a.n || a.order - b.order);
  const named = hits.filter((h) => h.tier < INTENT_FULL || h.tier === DESC);
  const intent = hits.filter((h) => h.tier === INTENT_FULL || h.tier === INTENT_PART);
  const groups: Group[] = [];
  const phrase = qw.length > 1;
  if (intent.length && (phrase || !named.length)) groups.push({ head: `Good for “${query.trim()}”`, icon: "lightbulb", intent: true, rows: intent.slice(0, 6).map((h) => h.row) });
  const rest = phrase || !named.length ? named : [...named, ...intent];
  const byCat = new Map<string, Row[]>();
  for (const h of rest) {
    const c = h.row.block.ext && h.row.block.cat === "ext" ? "ext" : h.row.block.cat;
    if (!byCat.has(c)) byCat.set(c, []);
    if (!byCat.get(c)!.some((r) => r.key === h.row.key)) byCat.get(c)!.push(h.row);
  }
  for (const [c, rows] of byCat) {
    const cat = CATS.find((x) => x.id === c)!;
    groups.push({ head: c === "ext" ? ORG_HEAD : cat.title, icon: c === "ext" ? "building-2" : undefined, rows });
  }
  if (groups.length) return { groups };
  return { groups, didYouMean: didYouMean(q, ctx) };
}

const alias = (q: string, v: Variant) => {
  const n = v.names.find((x) => x.startsWith(q));
  return n ? `matches “${n}”` : undefined;
};

export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/** The closest block or variant name within two letters, among what this profile offers. */
export function didYouMean(q: string, ctx: Ctx): Row | undefined {
  if (q.length < 3) return undefined;
  let best: { d: number; row: Row } | undefined;
  for (const b of offered(ctx)) {
    const cands: [string, Variant | undefined][] = [[b.title.toLowerCase(), undefined], ...b.names.map((n) => [n, undefined] as [string, undefined])];
    for (const v of variantsOf(b, ctx)) for (const n of [v.label.toLowerCase(), ...v.names]) cands.push([n, v]);
    for (const [n, v] of cands) {
      if (n.length < 3) continue;
      const d = editDistance(q, n);
      if (d <= 2 && (!best || d < best.d)) best = { d, row: rowOf(b, ctx, v, { note: `“${n}”` }) };
    }
  }
  return best?.row;
}

const hasResults = (q: string, ctx: Ctx) => search(q, ctx).groups.length > 0;

/** After four more letters with no match the menu closes by itself (6a). */
export function autoClosed(query: string, ctx: Ctx): boolean {
  if (!query || hasResults(query, ctx)) return false;
  let n = query.length - 1;
  while (n > 0 && !hasResults(query.slice(0, n), ctx)) n--;
  return query.length - n >= 4;
}

// ---------- views and bands (keyboard model, 6b) ----------

export type Item =
  | { kind: "quick" | "recent" | "row" | "card"; id: string; row: Row }
  | { kind: "chip"; id: string; text: string }
  | { kind: "cat"; id: string; cat: Cat; count: number }
  | { kind: "browse" | "ask" | "back"; id: string };

export interface Band {
  /** Heading before the band. */
  head?: string;
  headIcon?: string;
  kind: "tiles" | "chips" | "row" | "cards" | "bar";
  /** For screen readers: "Quick insert", "Recent". */
  label?: string;
  items: Item[];
}

export type Frame = { kind: "cat"; cat: CatId } | { kind: "step"; block: string; variant?: string };

export interface View {
  kind: "root" | "flat" | "search" | "cat" | "step";
  bands: Band[];
  title?: string;
  cat?: Cat;
  block?: Block;
  results?: Results;
}

const slug = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

/** "Browse all blocks" (the gallery) is for the full workspace only (5a). */
export const browseAll = (ctx: Ctx) => (ctx.profile?.profile ?? "full") === "full";

export function rootView(ctx: Ctx, compact = false): View {
  if (isFlat(ctx)) return { kind: "flat", bands: flatRows(ctx).map((r) => ({ kind: "row", items: [{ kind: "row", id: "oci-f-" + slug(r.key), row: r }] })) };
  const quick = quickRows(ctx);
  const bands: Band[] = [{ head: "Quick insert", label: "Quick insert", kind: "tiles", items: quick.map((r) => ({ kind: "quick", id: "oci-q-" + slug(r.key), row: r })) }];
  const recent = recentRows(ctx, quick);
  if (recent.length) bands.push({ head: "Recent", headIcon: "history", label: "Recent", kind: "chips", items: recent.map((r) => ({ kind: "recent", id: "oci-r-" + slug(r.key), row: r })) });
  const ch = chips(ctx);
  if (ch.length) bands.push({ head: "Start from a goal", headIcon: "lightbulb", label: "Start from a goal", kind: "chips", items: ch.map((t, i) => ({ kind: "chip", id: "oci-c-" + i, text: t })) });
  cats(ctx).forEach((c, i) => bands.push({ head: i === 0 ? "Explore" : undefined, label: "Explore", kind: "row", items: [{ kind: "cat", id: "oci-k-" + c.id, cat: c, count: catCount(c.id, ctx) }] }));
  const bar: Item[] = browseAll(ctx) ? [{ kind: "browse", id: "oci-browse" }] : [];
  if (ctx.ai && !compact) bar.push({ kind: "ask", id: "oci-ask" });
  if (bar.length) bands.push({ kind: "bar", items: bar });
  return { kind: "root", bands };
}

export function searchView(query: string, ctx: Ctx): View {
  const res = search(query, ctx);
  const bands: Band[] = [];
  for (const g of res.groups)
    g.rows.forEach((r, i) => bands.push({ head: i === 0 ? g.head : undefined, headIcon: i === 0 ? g.icon : undefined, label: g.head, kind: "row", items: [{ kind: "row", id: "oci-s-" + slug(r.key) + "-" + bands.length, row: r }] }));
  if (!res.groups.length) {
    if (res.didYouMean) bands.push({ head: "Did you mean", label: "Did you mean", kind: "row", items: [{ kind: "row", id: "oci-dym", row: res.didYouMean }] });
    const ch = isFlat(ctx) ? [] : chips(ctx);
    if (ch.length) bands.push({ head: "Start from a goal", headIcon: "lightbulb", label: "Start from a goal", kind: "chips", items: ch.map((t, i) => ({ kind: "chip", id: "oci-c-" + i, text: t })) });
    const bar: Item[] = [...(browseAll(ctx) ? [{ kind: "browse" as const, id: "oci-browse" }] : []), ...(ctx.ai ? [{ kind: "ask" as const, id: "oci-ask" }] : [])];
    if (!isFlat(ctx) && bar.length) bands.push({ kind: "bar", items: bar });
  }
  return { kind: "search", bands, results: res };
}

export function catView(id: CatId, ctx: Ctx): View {
  const cat = CATS.find((c) => c.id === id)!;
  const { own, org } = catBlocks(id, ctx);
  const bands: Band[] = own.map((b) => ({ label: cat.title, kind: "row" as const, items: [{ kind: "row" as const, id: "oci-x-" + slug(b.key), row: rowOf(b, ctx) }] }));
  org.forEach((b, i) => bands.push({ head: i === 0 ? ORG_HEAD : undefined, headIcon: i === 0 ? "building-2" : undefined, label: ORG_HEAD, kind: "row", items: [{ kind: "row", id: "oci-x-" + slug(b.key), row: rowOf(b, ctx) }] }));
  return { kind: "cat", bands, cat, title: cat.title };
}

/** A block's variants: cards two to a row (desktop step, phone step), or a list (phone, seg). */
export function stepView(b: Block, ctx: Ctx, compact = false): View {
  const vs = variantsOf(b, ctx);
  const card = (v: Variant): Item => ({ kind: "card", id: "oci-v-" + slug(b.key) + "-" + v.id, row: { key: b.key + ":" + v.id, block: b, variant: v, fixed: true } });
  const bands: Band[] = [];
  if (b.mode === "step") for (let i = 0; i < vs.length; i += 2) bands.push({ kind: "cards", label: b.title, items: vs.slice(i, i + 2).map(card) });
  else if (compact) for (const v of vs) bands.push({ kind: "row", label: b.title, items: [card(v)] });
  return { kind: "step", bands, block: b, title: b.title };
}

export interface Nav {
  query: string;
  stack: Frame[];
  /** Saved positions, one per open frame. */
  saved: { b: number; i: number }[];
  b: number;
  i: number;
  /** Variants changed with Tab, by item id. */
  vsel: Record<string, string>;
}

export const initialNav = (query = ""): Nav => ({ query, stack: [], saved: [], b: 0, i: 0, vsel: {} });

export function viewOf(nav: Nav, ctx: Ctx, compact = false, depth = nav.stack.length): View {
  const f = nav.stack[depth - 1];
  if (!f) return nav.query ? searchView(nav.query, ctx) : rootView(ctx, compact);
  if (f.kind === "cat") return catView(f.cat, ctx);
  const b = offered(ctx).find((x) => x.key === f.block)!;
  return stepView(b, ctx, compact);
}

export function activeItem(nav: Nav, view: View): Item | undefined {
  const band = view.bands[Math.min(nav.b, view.bands.length - 1)];
  return band?.items[Math.min(nav.i, band.items.length - 1)];
}

/** The row an item inserts, with any Tab change applied. */
export function rowFor(item: Item, nav: Nav, ctx: Ctx): Row | undefined {
  if (!("row" in item)) return undefined;
  const r = item.row;
  const id = nav.vsel[item.id];
  if (!id || r.fixed) return r;
  const v = variantsOf(r.block, ctx).find((x) => x.id === id);
  return v ? { ...r, variant: v } : r;
}

export type Action =
  | { t: "insert"; row: Row; keep?: boolean }
  | { t: "fill"; text: string }
  | { t: "browse" }
  | { t: "ask" }
  | { t: "close" }
  | { t: "announce"; text: string };

export interface KeyResult {
  nav: Nav;
  handled: boolean;
  action?: Action;
}

const clampNav = (nav: Nav, view: View): Nav => {
  const b = Math.max(0, Math.min(nav.b, view.bands.length - 1));
  const i = Math.max(0, Math.min(nav.i, (view.bands[b]?.items.length ?? 1) - 1));
  return b === nav.b && i === nav.i ? nav : { ...nav, b, i };
};

/** Whether the item has more behind it (→ goes deeper): a category, or a step block. */
export function deeper(item: Item | undefined, compact = false): Frame | null {
  if (!item) return null;
  if (item.kind === "cat") return { kind: "cat", cat: item.cat.id };
  if ((item.kind === "row" || item.kind === "quick") && item.row.block.mode === "step" && !item.row.fixed) return { kind: "step", block: item.row.block.key, variant: item.row.variant?.id };
  if (compact && item.kind === "row" && item.row.block.mode === "seg" && !item.row.fixed) return { kind: "step", block: item.row.block.key, variant: item.row.variant?.id };
  return null;
}

function open(nav: Nav, f: Frame, ctx: Ctx, compact: boolean): Nav {
  const next: Nav = { ...nav, stack: [...nav.stack, f], saved: [...nav.saved, { b: nav.b, i: nav.i }], b: 0, i: 0 };
  if (f.kind === "step" && f.variant) {
    const v = viewOf(next, ctx, compact);
    v.bands.forEach((band, b) => band.items.forEach((it, i) => {
      if ("row" in it && it.row.variant?.id === f.variant) {
        next.b = b;
        next.i = i;
      }
    }));
  }
  return next;
}

export function back(nav: Nav): Nav {
  if (!nav.stack.length) return nav;
  const s = nav.saved[nav.saved.length - 1];
  return { ...nav, stack: nav.stack.slice(0, -1), saved: nav.saved.slice(0, -1), b: s.b, i: s.i };
}

/** The keyboard map (6b). `key` is a KeyboardEvent key. */
export function menuKey(nav: Nav, key: string, mods: { shift?: boolean; mod?: boolean }, ctx: Ctx, compact = false): KeyResult {
  const view = viewOf(nav, ctx, compact);
  nav = clampNav(nav, view);
  const item = activeItem(nav, view);
  const band = view.bands[nav.b];
  const nb = view.bands.length;
  const at = (b: number, i: number): Nav => ({ ...nav, b, i: Math.max(0, Math.min(i, (view.bands[b]?.items.length ?? 1) - 1)) });
  switch (key) {
    case "ArrowDown":
      return { nav: nb ? at((nav.b + 1) % nb, band?.kind === "cards" ? nav.i : 0) : nav, handled: true };
    case "ArrowUp":
      return { nav: nb ? at((nav.b - 1 + nb) % nb, band?.kind === "cards" ? nav.i : 0) : nav, handled: true };
    case "ArrowRight": {
      if (band && band.items.length > 1 && nav.i < band.items.length - 1) return { nav: at(nav.b, nav.i + 1), handled: true };
      const f = deeper(item, compact);
      if (f) return { nav: open(nav, f, ctx, compact), handled: true };
      return { nav, handled: true };
    }
    case "ArrowLeft":
      if (band && band.items.length > 1 && nav.i > 0) return { nav: at(nav.b, nav.i - 1), handled: true };
      if (nav.stack.length) return { nav: back(nav), handled: true };
      return { nav, handled: true };
    case "Backspace":
      if (nav.stack.length && nav.stack[nav.stack.length - 1].kind === "step") return { nav: back(nav), handled: true };
      return { nav, handled: false };
    case "Tab": {
      if (!item || !("row" in item) || item.row.fixed || item.row.block.mode !== "seg" || compact) return { nav, handled: true };
      const vs = variantsOf(item.row.block, ctx);
      const cur = rowFor(item, nav, ctx)?.variant?.id;
      const i = vs.findIndex((v) => v.id === cur);
      const v = vs[(i + (mods.shift ? -1 : 1) + vs.length) % vs.length];
      return { nav: { ...nav, vsel: { ...nav.vsel, [item.id]: v.id } }, handled: true, action: { t: "announce", text: v.label + "." } };
    }
    case "Enter": {
      if (!item) return { nav, handled: false };
      if (item.kind === "cat") return { nav: open(nav, deeper(item)!, ctx, compact), handled: true };
      if (item.kind === "chip") return { nav, handled: true, action: { t: "fill", text: item.text.toLowerCase() } };
      if (item.kind === "browse") return { nav, handled: true, action: { t: "browse" } };
      if (item.kind === "ask") return { nav, handled: true, action: { t: "ask" } };
      if (item.kind === "back") return { nav: back(nav), handled: true };
      // Phone: a block with variants opens them as a step (7c), but a search result already
      // shows the variant it matched, and a tap inserts it (7e).
      if (compact && view.kind !== "search" && deeper(item, compact) && item.kind === "row") return { nav: open(nav, deeper(item, compact)!, ctx, compact), handled: true };
      const row = rowFor(item, nav, ctx);
      return row ? { nav, handled: true, action: { t: "insert", row, keep: !!mods.mod } } : { nav, handled: false };
    }
    case "Escape":
      return { nav, handled: true, action: { t: "close" } };
  }
  return { nav, handled: false };
}

/** What a screen reader hears for the active item: "Quick insert, Heading, Heading 2. 2 of 5." */
export function announce(nav: Nav, ctx: Ctx, compact = false): string {
  const view = viewOf(nav, ctx, compact);
  const n = clampNav(nav, view);
  const item = activeItem(n, view);
  if (!item) return "";
  const band = view.bands[n.b];
  const label = itemLabel(item, n, ctx);
  const within = band.items.length > 1 ? ` ${n.i + 1} of ${band.items.length}.` : "";
  const extra = "row" in item && item.row.block.mode === "seg" && !item.row.fixed && !compact ? ` Tab changes ${item.row.block.segLabel}.` : "";
  return `${band.label ? band.label + ", " : ""}${label}.${within}${extra}`;
}

export function itemLabel(item: Item, nav: Nav, ctx: Ctx): string {
  switch (item.kind) {
    case "chip":
      return item.text;
    case "cat":
      return `${item.cat.title}, ${item.count} blocks`;
    case "browse":
      return "Browse all blocks";
    case "ask":
      return "Ask the assistant";
    case "back":
      return "Back";
    default: {
      const r = rowFor(item, nav, ctx)!;
      return item.kind === "card" ? r.variant!.label : rowLabel(r);
    }
  }
}
