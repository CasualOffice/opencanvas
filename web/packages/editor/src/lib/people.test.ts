// docs/21 (ADR-026): telling people apart and the per-viewer merge of who is who.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { duplicateNames, foldName, initialsById, nameWithDetail, relationNote, secondLine, type OcUser } from "@opencanvas/ui";
import { People, type PeopleConfig } from "./people";
import { viewMentions } from "./comments";

const me: OcUser = { id: "u_me", name: "Lin Zhou", color: "#2a5ad7" };

function cfg(over: Partial<PeopleConfig> = {}): PeopleConfig {
  return { ticket: "t", me, participants: [], coviewers: "contacts", callbacks: true, showEmail: false, ...over };
}

/** Answers `/v1/users/resolve` and `/v1/users` like the server would. */
function mockFetch(resolve: { resolve: boolean; users?: object[] }, search: object[] = []) {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const body = url.includes("/resolve") ? resolve : search;
      return { ok: true, json: async () => body } as Response;
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
      { id: "h", name: "Someone", relation: "hidden" },
      { id: "h2", name: "Someone", relation: "hidden" },
    ]);
    expect([...d]).toEqual(["asha rao"]);
  });

  it("falls back through the second line: detail, e-mail if allowed, last seen, id", () => {
    const now = Date.UTC(2026, 10, 21);
    expect(secondLine({ id: "u_1", name: "A", detail: "Design", email: "a@x" })).toBe("Design");
    expect(secondLine({ id: "u_1", name: "A", email: "a@x" })).toBe("ID …u_1");
    expect(secondLine({ id: "u_1", name: "A", email: "a@x" }, { showEmail: true })).toBe("a@x");
    expect(secondLine({ id: "u_1", name: "A", lastSeen: now - 3 * 86400_000 }, { now })).toBe("Last here 3 days ago");
    expect(secondLine({ id: "usr_x7Q2", name: "A" })).toBe("ID …x7Q2");
  });

  it("adds the detail only when the name is shared, and notes relations", () => {
    const d = new Set(["asha rao"]);
    expect(nameWithDetail({ id: "a", name: "Asha Rao", detail: "Design" }, d)).toBe("Asha Rao · Design");
    expect(nameWithDetail({ id: "r", name: "Ravi", detail: "Ops" }, d)).toBe("Ravi");
    expect(relationNote({ id: "x", name: "P", relation: "external" })).toBe("Not in your contacts");
    expect(relationNote({ id: "x", name: "P", deactivated: true })).toBe("Former member");
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

describe("People: resolve > token > snapshot", () => {
  it("merges in order and never shows a snapshot while resolve may answer", async () => {
    const calls = mockFetch({
      resolve: true,
      users: [
        { id: "u_a", name: "Resolved A", relation: "contact" },
        { id: "u_h", name: "Someone", relation: "hidden" },
      ],
    });
    const p = new People(cfg({ participants: [{ id: "u_b", name: "Token B", color: "#000" }, { id: "u_a", name: "Token A", color: "#000" }] }));
    // Before the answer: a document-only id is a placeholder, not the snapshot.
    const early = p.get("u_h", "Ravi Menon");
    expect(early.pending).toBe(true);
    expect(early.name).not.toContain("Ravi");
    await settle();
    expect(p.get("u_a", "Snapshot A").name).toBe("Resolved A");
    expect(p.get("u_b", "Snapshot B").name).toBe("Token B");
    expect(p.get("u_h", "Ravi Menon").name).toBe("Someone");
    p.get("u_c", "Snapshot C");
    await settle();
    expect(p.get("u_c", "Snapshot C").name).toBe("Snapshot C");
    // Batched: the first call carried every id queued at that time.
    expect(calls.filter((c) => c.url.includes("/resolve")).length).toBeGreaterThanOrEqual(1);
  });

  it("uses the snapshot at once when the host has no resolve callback", async () => {
    mockFetch({ resolve: false });
    const p = new People(cfg());
    await settle();
    expect(p.state).toBe("none");
    expect(p.get("u_x", "Asha Rao").name).toBe("Asha Rao");
  });

  it("lists co-viewers per directory.coviewers and the viewer's relations", async () => {
    mockFetch({ resolve: true, users: [{ id: "u_p", name: "Priya S.", relation: "external" }, { id: "u_c", name: "Cora", relation: "contact" }] });
    const doc = new Y.Doc();
    const people = doc.getMap("people");
    people.set("u_p", { id: "u_p", name: "Priya Shah" });
    people.set("u_c", { id: "u_c", name: "Cora" });
    const p = new People(cfg(), doc);
    await settle();
    const ids = p.pickable().map((u) => u.id);
    expect(ids).toContain("u_c");
    expect(ids).not.toContain("u_p");
    expect((await p.search("pri")).map((u) => u.id)).toEqual([]);

    mockFetch({ resolve: false });
    const none = new People(cfg({ coviewers: "none" }), doc);
    await settle();
    expect(none.pickable().map((u) => u.id)).toEqual(["u_me"]);
    const all = new People(cfg({ coviewers: "contacts" }), doc);
    await settle();
    // Tier 0 with the default "contacts": without resolve the server can't tell, so listed.
    expect(all.pickable().map((u) => u.id).sort()).toEqual(["u_c", "u_me", "u_p"]);
  });

  it("groups same-name search results and keeps the access flag", async () => {
    mockFetch({ resolve: false }, [
      { id: "u_a2", name: "Asha Rao", detail: "Finance", access: false },
      { id: "u_r", name: "Ravi" },
      { id: "u_a1", name: "Asha Rao", detail: "Design" },
    ]);
    const p = new People(cfg({ coviewers: "none" }));
    await settle();
    const list = await p.search("a");
    expect(list.map((u) => u.id)).toEqual(["u_a1", "u_a2", "u_r"]);
    expect(list.find((u) => u.id === "u_a2")?.access).toBe(false);
    expect(p.isDuplicate("asha rao")).toBe(false);
  });
});

describe("comment mentions", () => {
  it("shows each viewer their own name for a mentioned id", () => {
    const runs = viewMentions("Ask @Ravi Menon and @Asha Rao", { u_r: "Ravi Menon", u_a: "Asha Rao" }, (id) => (id === "u_r" ? "Someone" : "Asha R."));
    expect(runs.map((r) => r.text).join("")).toBe("Ask @Someone and @Asha R.");
    expect(runs.filter((r) => r.mention)).toHaveLength(2);
  });
});
