// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// GRAPH-02/03: what the graph and the list draw from the API's answer (ADR-082).
import { describe, expect, it } from "vitest";
import { around, ago, bucket, colourOf, csv, defaults, describeNode, listRows, loadPins, pickDirection, savePins, sortRows, spaceTones, view, type GraphData } from "./model";

const NOW = Date.parse("2026-11-28T12:00:00Z");
const h = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();

const node = (id: string, title: string, space: string | null, hours: number, by?: string) => ({
  id, kind: "canvas" as const, fileId: id, title, path: space ? `${space}/${title}` : null, space, updatedAt: h(hours), in: 0, out: 0, updatedBy: by ?? null,
});

// a → b (link), a → c#h1 (link to a heading), d → a (embed), e → b (relation), o is an orphan.
const DATA: GraphData = {
  nodes: [
    node("a", "SSO rollout plan", "Engineering", 2, "Jonas Weber"),
    node("b", "Security review", "Engineering", 100),
    node("c", "Admin console spec", "Product", 30 * 24 + 5),
    node("d", "Release checklist", "Ops", 10),
    node("e", "Sprint planning", "Product", 1),
    node("o", "Team offsite notes", "Ops", 3000),
    { id: "c#h1", kind: "block", fileId: "c", blockId: "h1", title: "Rollout phases", path: "Product/Admin console spec", space: "Product", updatedAt: h(5), in: 1, out: 0 },
  ],
  edges: [
    { from: "a", to: "b", kind: "link" },
    { from: "a", to: "c#h1", kind: "link" },
    { from: "c#h1", to: "c", kind: "in" },
    { from: "d", to: "a", kind: "embed" },
    { from: "e", to: "b", kind: "relation" },
  ],
  truncated: false,
};

describe("view", () => {
  it("collapses block targets onto their canvas when blocks are off", () => {
    const v = view(DATA, defaults(), NOW);
    expect(v.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "d", "e", "o"]);
    expect(v.edges.map((e) => `${e.s}>${e.t}:${e.k}`).sort()).toEqual(["a>b:link", "a>c:link", "d>a:embed", "e>b:relation"]);
    const a = v.byId.get("a")!;
    expect([a.in, a.out]).toEqual([1, 2]);
  });

  it("draws block nodes tied to their canvas when blocks are on", () => {
    const v = view(DATA, { ...defaults(), blocks: true }, NOW);
    expect(v.byId.get("c#h1")?.kind).toBe("block");
    expect(v.edges.map((e) => `${e.s}>${e.t}:${e.k}`)).toContain("a>c#h1:link");
    expect(v.edges.map((e) => `${e.s}>${e.t}:${e.k}`)).toContain("c#h1>c:in");
    // Degrees count canvases: a still links to c once.
    expect(v.byId.get("c")!.in).toBe(1);
  });

  it("filters spaces, kinds, orphans and the update window, keeping the current canvas", () => {
    const f = defaults();
    expect(view(DATA, { ...f, spaces: new Set(["Engineering"]) }, NOW).nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    const noEmbed = view(DATA, { ...f, kinds: new Set(["link", "relation"]) }, NOW);
    expect(noEmbed.edges.some((e) => e.k === "embed")).toBe(false);
    expect(view(DATA, { ...f, orphans: false }, NOW).byId.has("o")).toBe(false);
    expect(view(DATA, { ...f, orphans: false }, NOW, { current: "o" }).byId.has("o")).toBe(true);
    // 7 days: c (31 days) and o drop; the current canvas never does.
    expect(view(DATA, { ...f, within: 7 }, NOW).nodes.map((n) => n.id).sort()).toEqual(["a", "b", "d", "e"]);
    expect(view(DATA, { ...f, within: 7 }, NOW, { current: "o" }).byId.has("o")).toBe(true);
  });

  it("an orphan by filter is one with no visible link", () => {
    // Without relations e has no link left.
    const v = view(DATA, { ...defaults(), kinds: new Set(["link", "embed"]), orphans: false }, NOW);
    expect(v.byId.has("e")).toBe(false);
  });

  it("around() keeps what is within depth links of a root, both ways", () => {
    const v = view(DATA, defaults(), NOW);
    expect([...around(v.edges, "a", 1)].sort()).toEqual(["a", "b", "c", "d"]);
    expect([...around(v.edges, "a", 2)].sort()).toEqual(["a", "b", "c", "d", "e"]);
    const local = view(DATA, defaults(), NOW, { root: "a", depth: 1 });
    expect(local.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(local.edges.every((e) => local.byId.has(e.s) && local.byId.has(e.t))).toBe(true);
  });

  it("search matches titles without removing anything", () => {
    const v = view(DATA, { ...defaults(), search: "sso" }, NOW);
    expect(v.nodes.length).toBe(6);
    expect([...v.matches!]).toEqual(["a"]);
    expect(view(DATA, defaults(), NOW).matches).toBeNull();
  });
});

describe("colours and words", () => {
  it("gives every space its own tone, most canvases first, stable under filters", () => {
    const t = spaceTones(DATA.nodes);
    expect(t.get("Engineering")).toBe("blue");
    expect(new Set(t.values()).size).toBe(3);
    expect(colourOf(view(DATA, defaults(), NOW).byId.get("a")!, "space", t, NOW)).toBe("var(--blue-fg)");
  });
  it("buckets updates: today, this week, this month, older", () => {
    expect([bucket(h(2), NOW), bucket(h(100), NOW), bucket(h(400), NOW), bucket(h(3000), NOW), bucket(null, NOW)]).toEqual(["today", "week", "month", "older", "older"]);
    expect(ago(h(2), NOW)).toBe("2 h ago");
    expect(ago(h(30), NOW)).toBe("yesterday");
    expect(ago(h(100), NOW)).toBe("4 days ago");
    expect(ago(null, NOW)).toBe("");
  });
  it("colours by owner from who changed the canvas last", () => {
    const v = view(DATA, defaults(), NOW);
    expect(colourOf(v.byId.get("a")!, "owner", new Map(), NOW)).toMatch(/^var\(--u[0-4]\)$/);
    expect(colourOf(v.byId.get("b")!, "owner", new Map(), NOW)).toBe("var(--fg-4)");
  });
  it("announces a canvas with its space, links and neighbours", () => {
    const v = view(DATA, defaults(), NOW);
    expect(describeNode(v, "a")).toBe("SSO rollout plan, Engineering, 1 link in, 2 out, 3 neighbours");
  });
});

describe("keyboard moves", () => {
  const pts = [
    { id: "c", x: 0, y: 0 },
    { id: "r", x: 100, y: 10 },
    { id: "far", x: 300, y: 0 },
    { id: "u", x: 5, y: -80 },
  ];
  it("goes to the nearest point in that direction", () => {
    expect(pickDirection(pts[0], [1, 0], pts)?.id).toBe("r");
    expect(pickDirection(pts[0], [0, -1], pts)?.id).toBe("u");
    expect(pickDirection(pts[0], [-1, 0], pts)).toBeNull();
  });
});

describe("list", () => {
  it("has one row per canvas with its neighbours, sortable", () => {
    const v = view(DATA, defaults(), NOW);
    const rows = listRows(v);
    expect(rows.length).toBe(6);
    const a = rows.find((r) => r.id === "a")!;
    expect(a.from).toEqual(["d"]);
    expect(a.to.sort()).toEqual(["b", "c"]);
    expect(sortRows(rows, "in", "desc")[0].id).toBe("b");
    expect(sortRows(rows, "title", "asc").map((r) => r.title)[0]).toBe("Admin console spec");
    expect(sortRows(rows, "updated", "desc")[0].id).toBe("e");
    expect(sortRows(rows, "from", "desc")[0].id).toBe("b");
    // Search narrows the list.
    expect(listRows(view(DATA, { ...defaults(), search: "review" }, NOW)).map((r) => r.id)).toEqual(["b"]);
  });
  it("writes CSV with quotes where needed", () => {
    const rows = sortRows(listRows(view(DATA, defaults(), NOW)), "title", "asc").slice(0, 1);
    rows[0].title = 'Admin, "console"';
    expect(csv(rows).split("\n")).toEqual(["Canvas,Space,Links in,Links out,Updated", `"Admin, ""console""",Product,1,0,${h(30 * 24 + 5)}`]);
  });
});

describe("pins", () => {
  it("are kept per person and surface in this browser only", () => {
    localStorage.clear();
    savePins("u1", "full", new Map([["a", [1, 2]]]));
    expect([...loadPins("u1", "full")]).toEqual([["a", [1, 2]]]);
    expect(loadPins("u2", "full").size).toBe(0);
    expect(loadPins("u1", "local").size).toBe(0);
    localStorage.setItem("oc.graph.pins.u1.full", "not json");
    expect(loadPins("u1", "full").size).toBe(0);
  });
});
