// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// docs/21 revision 2 (ADR-026): telling people apart, and the canvas member list.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { duplicateNames, foldName, initialsById, nameWithDetail, accessNote, secondLine, type OcUser } from "@opencanvas/ui";
import { People, type PeopleConfig } from "./people";
import { viewMentions } from "./comments";

const me: OcUser = { id: "u_me", name: "Lin Zhou", color: "#2a5ad7" };

function cfg(over: Partial<PeopleConfig> = {}): PeopleConfig {
  return { ticket: "t", me, ...over };
}

/** Answers `/v1/members` like the server would (filtered by `q`). */
function mockFetch(members: { id: string; name: string; detail?: string; email?: string }[]) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const q = new URL(url, "http://x").searchParams.get("q")?.toLowerCase() ?? "";
      const list = members.filter((m) => !q || m.name.toLowerCase().includes(q));
      return { ok: true, json: async () => ({ members: list }) } as Response;
    }),
  );
  return calls;
}

const settle = () => new Promise((r) => setTimeout(r, 80));

afterEach(() => vi.unstubAllGlobals());

describe("telling people apart", () => {
  it("matches names case- and accent-insensitively", () => {
    expect(foldName("  Ásha   RAO ")).toBe("asha rao");
    const d = duplicateNames([
      { id: "a", name: "Asha Rao" },
      { id: "b", name: "ásha rao" },
      { id: "c", name: "Ravi" },
    ]);
    expect([...d]).toEqual(["asha rao"]);
  });

  it("falls back through the second line: detail, last seen, id (never e-mail)", () => {
    const now = Date.UTC(2026, 10, 21);
    expect(secondLine({ id: "u_1", name: "A", detail: "Design" })).toBe("Design");
    expect(secondLine({ id: "u_1", name: "A" })).toBe("ID …u_1");
    expect(secondLine({ id: "u_1", name: "A", lastSeen: now - 3 * 86400_000 }, { now })).toBe("Last here 3 days ago");
    expect(secondLine({ id: "usr_x7Q2", name: "A" })).toBe("ID …x7Q2");
  });

  it("adds the detail only when the name is shared, and notes lost access", () => {
    const d = new Set(["asha rao"]);
    expect(nameWithDetail({ id: "a", name: "Asha Rao", detail: "Design" }, d)).toBe("Asha Rao · Design");
    expect(nameWithDetail({ id: "r", name: "Ravi", detail: "Ops" }, d)).toBe("Ravi");
    expect(accessNote({ id: "x", name: "P" })).toBeNull();
    expect(accessNote({ id: "x", name: "P", deactivated: true })).toBe("No longer has access");
  });

  it("puts a subscript on colliding initials, the same for everyone", () => {
    const m = initialsById([
      { id: "u_b", name: "Asha Rao" },
      { id: "u_a", name: "Arjun Reddy" },
      { id: "u_c", name: "Ravi Menon" },
    ]);
    expect(m.get("u_a")).toBe("AR");
    expect(m.get("u_b")).toBe("AR₂");
    expect(m.get("u_c")).toBe("RM");
  });
});

describe("People: the canvas's members", () => {
  it("shows members' current names and marks non-members with their snapshot", async () => {
    mockFetch([
      { id: "u_a", name: "Asha Rao-Iyer", detail: "Design", email: "asha@acme.example" },
      { id: "u_me", name: "Lin Zhou" },
    ]);
    const p = new People(cfg());
    await settle();
    expect(p.get("u_a", "Asha Rao").name).toBe("Asha Rao-Iyer");
    expect(p.get("u_a").deactivated).toBeUndefined();
    expect(JSON.stringify(p.get("u_a"))).not.toContain("@");
    const gone = p.get("u_gone", "Ravi Menon");
    expect(gone.name).toBe("Ravi Menon");
    expect(gone.deactivated).toBe(true);
  });

  it("lists exactly the members, never someone else in the document", async () => {
    mockFetch([{ id: "u_a", name: "Asha Rao" }, { id: "u_m", name: "Mira (never opened)" }]);
    const doc = new Y.Doc();
    doc.getMap("people").set("u_x", { id: "u_x", name: "Xavier (removed)" });
    const p = new People(cfg(), doc);
    await settle();
    const ids = p.pickable().map((u) => u.id).sort();
    expect(ids).toEqual(["u_a", "u_m", "u_me"]);
    expect((await p.search("xav")).map((u) => u.id)).toEqual([]);
  });

  it("groups same-name results together", async () => {
    mockFetch([
      { id: "u_a2", name: "Asha Rao", detail: "Finance" },
      { id: "u_r", name: "Ravi" },
      { id: "u_a1", name: "Asha Rao", detail: "Design" },
    ]);
    const p = new People(cfg());
    await settle();
    const list = await p.search("a");
    expect(list.map((u) => u.id)).toEqual(["u_a1", "u_a2", "u_r"]);
    expect(p.isDuplicate("asha rao")).toBe(true);
  });
});

describe("comment mentions", () => {
  it("shows the current name for a mentioned id", () => {
    const runs = viewMentions("Ask @Ravi Menon and @Asha Rao", { u_r: "Ravi Menon", u_a: "Asha Rao" }, (id) => (id === "u_r" ? "Ravi M." : "Asha R."));
    expect(runs.map((r) => r.text).join("")).toBe("Ask @Ravi M. and @Asha R.");
    expect(runs.filter((r) => r.mention)).toHaveLength(2);
  });
});
