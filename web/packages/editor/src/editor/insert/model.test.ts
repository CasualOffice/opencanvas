// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// INS-01: the insert menu model against the approved prototype (docs/prototypes/insert-menu-approved):
// categories (1a-1e), variants (2a-2e), intent search (3a-3d), Recent (4a-4b), profiles (5a-5d),
// no results and the keyboard map (6a-6b), and the phone steps (7a-7f).
import { describe, expect, it } from "vitest";
import type { BlockPackage } from "../../ext/model";
import type { EditorProfile } from "../profile";
import { CORE_BLOCKS } from "../profile";
import {
  announce, autoClosed, catBlocks, cats, chips, didYouMean, flatRows, initialNav, isFlat, menuKey, nothingToInsert, offered, quickRows, recentRows, rootView,
  search, viewOf, activeItem, rowLabel, type Ctx, type Nav,
} from "./model";
import { clearRecent, emptyRec, loadRecent, recordUse, RECENT_CAP, saveRecent, storageKey, type RecentRec } from "./recent";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const ACT = ["core.import", "core.assistant"];
const MEETING: EditorProfile = { profile: "meeting", blocks: ["core.text", "core.heading", "core.checklist", "core.bulleted_list", "core.numbered_list", "core.callout", "core.divider", "core.table", "core.date", ...ACT] };
const FULL: EditorProfile = { profile: "full", blocks: [...CORE_BLOCKS] };

const pkg = (type: string, title: string, category?: string, keywords: string[] = [], profiles = ["full"]): BlockPackage =>
  ({ type, title, version: "1.0.0", v: 1, content: "none", attrs: {}, entry: null, integrity: "", publisher: "Acme", description: title + " block", keywords,
    discovery: category ? { label: title, category, keywords, profiles, complexity: "basic" } : undefined } as unknown as BlockPackage);
const OKR = pkg("acme.okr", "OKR", "data-planning", ["objective", "key result", "plan sprint", "set goals"], ["full", "meeting"]);
const TICKET = pkg("acme.ticket", "Ticket", undefined, ["tracker", "issue"]);

const ctx = (o: Partial<Ctx> = {}): Ctx => ({ profile: FULL, ai: false, imp: false, pkgs: [], rec: emptyRec(), now: NOW, ...o });
const keys = (c: Ctx) => offered(c).map((b) => b.key);
const first = (q: string, c = ctx()) => search(q, c).groups[0]?.rows[0];

describe("categories (1a-1e)", () => {
  it("files the built-in blocks in five categories, Media folded in", () => {
    const c = ctx();
    expect(catBlocks("content", c).own.map((b) => b.key)).toEqual(["text", "heading", "list", "quote", "callout", "code", "link", "file"]);
    expect(catBlocks("data", c).own.map((b) => b.key)).toEqual(["database", "spreadsheet", "chart", "table", "date", "csv"]);
    expect(catBlocks("visual", c).own.map((b) => b.key)).toEqual(["diagram", "board", "image", "embed"]);
    expect(catBlocks("layout", c).own.map((b) => b.key)).toEqual(["columns", "toggle", "divider"]);
    // Extensions is absent with no SDK blocks (1e).
    expect(cats(c).map((x) => x.title)).toEqual(["Content", "Data & planning", "Visual & diagrams", "Layout"]);
  });

  it("puts SDK blocks in their discovery.category and also under Extensions (1b, 1e)", () => {
    const c = ctx({ pkgs: [OKR, TICKET] });
    expect(catBlocks("data", c).org.map((b) => b.title)).toEqual(["OKR"]);
    expect(catBlocks("ext", c).org.map((b) => b.title)).toEqual(["OKR", "Ticket"]);
    expect(cats(c).map((x) => x.id)).toEqual(["content", "data", "visual", "layout", "ext"]);
  });

  it("root view: Quick insert, goals, Explore and the bar; no Recent on a first visit (1a, 4a)", () => {
    const v = rootView(ctx());
    expect(v.kind).toBe("root");
    expect(v.bands.map((b) => b.head ?? b.kind)).toEqual(["Quick insert", "Start from a goal", "Explore", "row", "row", "row", "bar"]);
    expect(quickRows(ctx()).map(rowLabel)).toEqual(["Text", "Heading, Heading 2", "List, Bulleted list", "Image", "Simple table"]);
  });
});

describe("variants (2a-2e)", () => {
  it("Enter inserts the shown variant; Tab cycles an inline one and wraps", () => {
    const c = ctx();
    let nav: Nav = initialNav("heading");
    expect(rowLabel(first("heading")!)).toBe("Heading, Heading 2");
    let r = menuKey(nav, "Tab", {}, c);
    expect(r.action).toEqual({ t: "announce", text: "Heading 3." });
    nav = r.nav;
    nav = menuKey(nav, "Tab", {}, c).nav;
    r = menuKey(nav, "Enter", {}, c);
    expect(r.action?.t === "insert" && r.action.row.variant?.label).toBe("Heading 1");
    expect(menuKey(nav, "Tab", { shift: true }, c).action).toEqual({ t: "announce", text: "Heading 3." });
  });

  it("arrows never change a variant; → opens a step block's second step and Enter inserts the card", () => {
    const c = ctx();
    let nav = initialNav("database");
    expect(menuKey(nav, "ArrowDown", {}, c).nav.vsel).toEqual({});
    nav = menuKey(nav, "ArrowRight", {}, c).nav;
    const v = viewOf(nav, c);
    expect(v.kind).toBe("step");
    expect(v.bands.map((b) => b.items.map((i) => ("row" in i ? i.row.variant!.short : "")))).toEqual([["Table", "Board"], ["Calendar", "Gallery"]]);
    nav = menuKey(nav, "ArrowRight", {}, c).nav;
    nav = menuKey(nav, "ArrowDown", {}, c).nav;
    const r = menuKey(nav, "Enter", {}, c);
    expect(r.action?.t === "insert" && r.action.row.variant?.label).toBe("Gallery view");
    // Backspace in a step goes back without deleting the query.
    expect(menuKey(nav, "Backspace", {}, c)).toMatchObject({ handled: true, nav: { stack: [] } });
  });

  it("/h2, /todo, /board and the old ids land on the variant", () => {
    expect(rowLabel(first("h2")!)).toBe("Heading, Heading 2");
    expect(search("h2", ctx()).groups.flatMap((g) => g.rows)).toHaveLength(1);
    expect(rowLabel(first("todo")!)).toBe("List, Checklist");
    expect(rowLabel(first("check")!)).toBe("List, Checklist");
    const board = search("board", ctx()).groups.flatMap((g) => g.rows).map(rowLabel);
    expect(board.slice(0, 2)).toEqual(["Database, Board view", "Whiteboard"]);
    for (const [q, want] of [["bul", "List, Bulleted list"], ["num", "List, Numbered list"], ["cols3", "Columns, 3 columns"], ["kanban", "Database, Board view"], ["uml", "Diagram, UML class"], ["decision", "Callout, Decision"], ["sidebar", "Columns, Sidebar and main"]])
      expect(rowLabel(first(q)!), q).toBe(want);
    // Names beat variants: "/table" offers Simple table first.
    expect(rowLabel(first("table")!)).toBe("Simple table");
    expect(rowLabel(first("whiteboard")!)).toBe("Whiteboard");
  });
});

describe("intent search (3a-3d)", () => {
  it("a chip phrase gives one “Good for” group, best first, each with a why line", () => {
    const g = search("track tasks", ctx({ pkgs: [TICKET] })).groups[0];
    expect(g.head).toBe("Good for “track tasks”");
    expect(g.rows.map(rowLabel).slice(0, 3)).toEqual(["List, Checklist", "Database, Table view", "Database, Board view"]);
    expect(g.rows[0].why).toBe("tick tasks off as you go");
    expect(g.rows[0].matched).toEqual(["track", "tasks"]);
  });

  it("ignores stop words and matches stems; SDK keyword phrases are intents", () => {
    const rows = search("plan a sprint", ctx({ pkgs: [OKR] })).groups[0].rows;
    expect(rows.map(rowLabel)).toContain("Database, Board view");
    expect(rows.map(rowLabel)).toContain("OKR");
    expect(search("planning sprints", ctx()).groups[0].rows.map(rowLabel)[0]).toBe("Database, Board view");
  });

  it("“draw architecture” offers diagram types first, set on the type", () => {
    const rows = search("draw architecture", ctx()).groups[0].rows.map(rowLabel);
    expect(rows.slice(0, 3)).toEqual(["Diagram, UML class", "Diagram, Entity relationship", "Diagram, Network and cloud"]);
    expect(rows).toContain("Whiteboard");
  });

  it("no results: Did you mean within two letters, only among offered blocks (6a, 5c)", () => {
    const r = search("kanbna", ctx());
    expect(r.groups).toEqual([]);
    expect(rowLabel(r.didYouMean!)).toBe("Database, Board view");
    expect(didYouMean("databse", ctx({ profile: MEETING }))).toBeUndefined();
    expect(search("database", ctx({ profile: MEETING })).groups).toEqual([]);
    expect(autoClosed("kanbna", ctx())).toBe(false);
    expect(autoClosed("kanbzzzz", ctx())).toBe(true);
  });
});

describe("Recent (4a-4b)", () => {
  const rec = (...uses: [string, string | undefined, number, string][]): RecentRec => ({ recent: uses.map(([block, variant, n, last]) => ({ block, ...(variant ? { variant } : {}), uses: n, last })), variant: {} });

  it("variant level, ranked by uses with older ones counting half, at most four, skipping quick tiles", () => {
    const r = rec(["database", "board", 9, "2026-11-24"], ["diagram", "flowchart", 6, "2026-11-25"], ["callout", "decision", 3, "2026-11-20"], ["text", undefined, 20, "2026-11-25"], ["code", undefined, 10, "2026-10-01"], ["toggle", undefined, 2, "2026-11-25"]);
    // Text is a quick tile; Code's 10 uses are old (5).
    expect(recentRows(ctx({ rec: r })).map(rowLabel)).toEqual(["Database, Board view", "Diagram, Flowchart", "Code", "Callout, Decision"]);
  });

  it("records uses, remembers the variant, caps at 24, clears at once", () => {
    let r = emptyRec();
    for (let i = 0; i < 30; i++) r = recordUse(r, "b" + i, undefined, NOW);
    expect(r.recent).toHaveLength(RECENT_CAP);
    r = recordUse(r, "heading", "3", NOW);
    expect(r.variant.heading).toBe("3");
    expect(quickRows(ctx({ rec: r })).map(rowLabel)[1]).toBe("Heading, Heading 3");
    expect(clearRecent(r).recent).toEqual([]);
  });

  it("filters by the profile: a hidden block never shows in Recent", () => {
    const r = rec(["database", "board", 9, "2026-11-24"], ["date", undefined, 2, "2026-11-24"]);
    const many: EditorProfile = { ...MEETING, blocks: [...MEETING.blocks, "core.quote", "core.code", "core.image"] };
    expect(recentRows(ctx({ profile: many, rec: r })).map(rowLabel)).toEqual(["Date"]);
  });

  it("localStorage: per host and person, every access survives a throwing storage", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    saveRecent("acme:amara", recordUse(emptyRec(), "list", "checklist", NOW), store);
    expect(mem.has(storageKey("acme:amara"))).toBe(true);
    expect(loadRecent("acme:amara", store).variant).toEqual({ list: "checklist" });
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadRecent("x", bad)).toEqual(emptyRec());
    expect(() => saveRecent("x", emptyRec(), bad)).not.toThrow();
    mem.set(storageKey("junk"), "{not json");
    expect(loadRecent("junk", store)).toEqual(emptyRec());
  });
});

describe("profiles (5a-5e, EDP-01)", () => {
  it("meeting: seven blocks, one flat list in order, with the meeting variants", () => {
    const c = ctx({ profile: MEETING });
    expect(isFlat(c)).toBe(true);
    expect(rootView(c).kind).toBe("flat");
    expect(flatRows(c).map(rowLabel)).toEqual(["Text", "Heading, Heading 2", "List, Checklist", "Callout, Decision", "Simple table", "Date", "Divider"]);
  });

  it("the host's quick_insert sets the flat order and the tiles; block:variant is fixed", () => {
    const c = ctx({ profile: { ...MEETING, quickInsert: ["core.checklist", "core.date", "core.text"] } });
    expect(flatRows(c).map(rowLabel).slice(0, 3)).toEqual(["List, Checklist", "Date", "Text"]);
    const full = ctx({ profile: { ...FULL, quickInsert: ["core.kanban", "core.text"] } });
    expect(quickRows(full).map((r) => [rowLabel(r), !!r.fixed])).toEqual([["Database, Board view", true], ["Text", false]]);
  });

  it("hidden blocks are never offered; the full profile gets the banded menu", () => {
    const c = ctx({ profile: MEETING });
    for (const k of ["database", "board", "diagram", "code", "quote", "image"]) expect(keys(c)).not.toContain(k);
    expect(isFlat(ctx())).toBe(false);
    // A view variant follows its own core id.
    const proj = ctx({ profile: { profile: "project", blocks: ["core.text", "core.kanban"] } });
    expect(rowLabel(search("database", proj).groups[0].rows[0])).toBe("Database, Board view");
  });

  it("goal chips: built in, replaced by the host's chips, off with intents = false", () => {
    expect(chips(ctx())).toEqual(["Track tasks", "Draw architecture", "Write notes"]);
    expect(chips(ctx({ profile: { ...FULL, chips: ["Plan a sprint"] } }))).toEqual(["Plan a sprint"]);
    expect(chips(ctx({ profile: { ...FULL, intents: false } }))).toEqual([]);
    expect(rootView(ctx({ profile: { ...FULL, intents: false } })).bands.some((b) => b.head === "Start from a goal")).toBe(false);
  });

  it("Browse all blocks only in the full profile (5a)", () => {
    const many: EditorProfile = { profile: "project", blocks: [...CORE_BLOCKS] };
    expect(rootView(ctx()).bands.at(-1)!.items.map((i) => i.kind)).toEqual(["browse"]);
    expect(rootView(ctx({ profile: many })).bands.some((b) => b.kind === "bar")).toBe(false);
    expect(rootView(ctx({ ai: true, profile: many })).bands.at(-1)!.items.map((i) => i.kind)).toEqual(["ask"]);
  });

  it("only Text: nothing to insert (5d); SDK blocks follow discovery.profiles", () => {
    expect(nothingToInsert(ctx({ profile: { profile: "notes", blocks: ["core.text", ...ACT] } }))).toBe(true);
    expect(nothingToInsert(ctx({ profile: MEETING }))).toBe(false);
    expect(keys(ctx({ profile: MEETING, pkgs: [OKR, TICKET] }))).toContain("ext:acme.okr");
    expect(keys(ctx({ profile: MEETING, pkgs: [OKR, TICKET] }))).not.toContain("ext:acme.ticket");
  });

  it("actions follow their switches and stay out of the counts", () => {
    expect(keys(ctx())).not.toContain("assistant");
    expect(keys(ctx({ ai: true, imp: true }))).toEqual(expect.arrayContaining(["assistant", "import"]));
    expect(rowLabel(first("import", ctx({ imp: true }))!)).toBe("Import CSV");
    expect(search("import", ctx({ imp: true })).groups[0].rows.map(rowLabel)).toContain("Import…");
  });
});

describe("keyboard map and announcements (6b)", () => {
  it("↓ moves between bands, ← → inside a band, → opens a category and ← returns", () => {
    const c = ctx();
    let nav = initialNav();
    nav = menuKey(nav, "ArrowRight", {}, c).nav;
    expect(announce(nav, c)).toBe("Quick insert, Heading, Heading 2. 2 of 5. Tab changes level.");
    nav = menuKey(nav, "ArrowDown", {}, c).nav;
    expect(activeItem(nav, viewOf(nav, c))?.kind).toBe("chip");
    const r = menuKey(nav, "Enter", {}, c);
    expect(r.action).toEqual({ t: "fill", text: "track tasks" });
    nav = menuKey(nav, "ArrowDown", {}, c).nav;
    expect(announce(nav, c)).toBe("Explore, Content, 8 blocks.");
    nav = menuKey(nav, "ArrowRight", {}, c).nav;
    expect(viewOf(nav, c).kind).toBe("cat");
    nav = menuKey(nav, "ArrowLeft", {}, c).nav;
    expect(nav.stack).toEqual([]);
    expect(announce(nav, c)).toBe("Explore, Content, 8 blocks.");
    expect(menuKey(nav, "Escape", {}, c).action).toEqual({ t: "close" });
    expect(menuKey(initialNav("h2"), "Enter", { mod: true }, c).action).toMatchObject({ t: "insert", keep: true });
  });

  it("phone: variants are a second step from a category; a search result inserts its variant (7c, 7e)", () => {
    const c = ctx();
    expect(menuKey(initialNav("h2"), "Enter", {}, c, true).action).toMatchObject({ t: "insert", row: { variant: { id: "2" } } });
    const inContent: Nav = { ...initialNav(), stack: [{ kind: "cat", cat: "content" }], saved: [{ b: 3, i: 0 }], b: 2, i: 0 };
    let nav = menuKey(inContent, "Enter", {}, c, true).nav;
    const v = viewOf(nav, c, true);
    expect(v.kind).toBe("step");
    expect(v.bands.map((b) => ("row" in b.items[0] ? b.items[0].row.variant!.label : ""))).toEqual(["Bulleted list", "Numbered list", "Checklist"]);
    nav = menuKey(nav, "ArrowDown", {}, c, true).nav;
    expect(menuKey(nav, "Enter", {}, c, true).action).toMatchObject({ t: "insert", row: { variant: { id: "numbered" } } });
  });
});

describe("inside a live block's own editor (LIVE-03, depth rule)", () => {
  // The nested editor gets the same categorised menu, filtered by the host profile, minus what
  // would act on the embedding canvas or break the depth rule.
  const nested = (o: Partial<Ctx> = {}) => ctx({ ai: true, imp: true, live: true, pkgs: [OKR], nested: true, ...o });
  it("never offers a live block, whatever the host allows", () => {
    expect(keys(ctx({ live: true }))).toContain("live");
    expect(keys(nested())).not.toContain("live");
    expect(search("live block", nested()).groups.flatMap((g) => g.rows).map((r) => r.block.key)).not.toContain("live");
  });
  it("keeps the categories and the host profile's filter", () => {
    const c = nested();
    expect(cats(c).map((x) => x.title)).toEqual(["Content", "Data & planning", "Visual & diagrams", "Layout"]);
    expect(catBlocks("data", c).own.map((b) => b.key)).toEqual(["database", "spreadsheet", "chart", "table", "date"]);
    expect(keys(nested({ profile: MEETING }))).toEqual(["text", "heading", "list", "callout", "table", "date", "divider"]);
  });
  it("leaves out what acts on the embedding canvas: assistant, import, uploads, SDK blocks, the gallery", () => {
    const k = keys(nested());
    for (const x of ["assistant", "import", "csv", "file", "image", "ext:acme.okr"]) expect(k).not.toContain(x);
    expect(rootView(nested(), false).bands.some((b) => b.kind === "bar")).toBe(false);
    expect(rootView(ctx({ ai: true }), false).bands.some((b) => b.kind === "bar")).toBe(true);
  });
});
