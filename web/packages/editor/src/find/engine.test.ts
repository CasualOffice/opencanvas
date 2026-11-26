// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Find and replace (SRCH-01, ADR-066) on a real headless editor bound to a Y.Doc: what it
// finds, what replace may touch, and that replace all is one undo step (SRCH-A1).
import { afterEach, describe, expect, it } from "vitest";
import { Editor, Node } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { BASE_EXTENSIONS } from "../editor/base";
import { compile, counter, expand, findAll, keepCurrent, replaceMatches, TooSlow, where, DEFAULT_OPTIONS, type Match } from "./engine";

// The database and board blocks as atoms (their node views live in nodes.tsx).
const stub = (name: string, attr: string) =>
  Node.create({ name, group: "block", atom: true, addAttributes: () => ({ [attr]: { default: "" } }), parseHTML: () => [{ tag: `div[data-${name}]` }], renderHTML: ({ HTMLAttributes }) => ["div", { ...HTMLAttributes, [`data-${name}`]: "" }] });
const STUBS = [stub("database", "dbId"), stub("board", "boardId")];

let ed: Editor | null = null;
afterEach(() => {
  ed?.destroy();
  ed = null;
});

function make(html: string, setup?: (doc: Y.Doc) => void) {
  const doc = new Y.Doc();
  setup?.(doc);
  ed = new Editor({ extensions: [...BASE_EXTENSIONS, ...STUBS, Collaboration.configure({ document: doc, field: "content" })] });
  ed.commands.setContent(html);
  return { e: ed, doc };
}
const re = (q: string, o: Partial<typeof DEFAULT_OPTIONS> = {}) => {
  const c = compile(q, { ...DEFAULT_OPTIONS, ...o });
  if (!c.ok) throw new Error(c.error);
  return c.re;
};
const all = DEFAULT_OPTIONS.scope;

function withDb(doc: Y.Doc) {
  const db = new Y.Map<unknown>();
  doc.getMap("databases").set("db1", db);
  db.set("name", "Sprint 42 backlog");
  const fields = new Y.Array<Y.Map<unknown>>();
  for (const [id, name, type] of [["t", "Task", "title"], ["s", "Status", "status"], ["n", "Notes", "text"]]) {
    const f = new Y.Map<unknown>();
    f.set("id", id);
    f.set("name", name);
    f.set("type", type);
    fields.push([f]);
  }
  db.set("fields", fields);
  const order = new Y.Array<string>();
  order.push(["r1"]);
  db.set("order", order);
  const rows = new Y.Map<Y.Map<unknown>>();
  const r = new Y.Map<unknown>();
  r.set("t", "Ship SSO login");
  r.set("s", "SSO blocked");
  r.set("n", "Okta first, then SSO for Entra");
  rows.set("r1", r);
  db.set("rows", rows);
  const board = new Y.Map<unknown>();
  doc.getMap("boards").set("bd1", board);
  const shapes = new Y.Map<Y.Map<unknown>>();
  const s1 = new Y.Map<unknown>();
  s1.set("type", "sticky");
  s1.set("text", "SSO sandbox was blocked");
  s1.set("x", 0);
  s1.set("y", 0);
  shapes.set("s1", s1);
  board.set("shapes", shapes);
  const th = new Y.Map<unknown>();
  const msgs = new Y.Array<Y.Map<unknown>>();
  const m = new Y.Map<unknown>();
  m.set("text", "Ask about SSO");
  msgs.push([m]);
  th.set("messages", msgs);
  doc.getMap("comments").set("th1", th);
}

describe("compile", () => {
  it("escapes plain text, honours case and whole word, and explains a bad pattern", () => {
    expect(re("a.b").test("a.b")).toBe(true);
    expect(re("a.b").test("axb")).toBe(false);
    expect(re("sso").test("SSO")).toBe(true);
    expect(re("sso", { caseSensitive: true }).test("SSO")).toBe(false);
    const w = re("SSO", { wholeWord: true });
    expect("SSO, SSOs and xSSO".match(w)).toEqual(["SSO"]);
    const bad = compile("(SSO|", { ...DEFAULT_OPTIONS, regex: true });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.toLowerCase()).toContain("group");
  });
  it("counts like the prototype", () => {
    expect(counter(2, 12, false)).toBe("3 of 12");
    expect(counter(0, 10_000, true)).toBe("1 of 10,000+");
    expect(counter(-1, 0, false)).toBe("No results");
  });
});

describe("findAll", () => {
  it("finds text, cells, board text and (when asked) comments in document order, never inside a chip", () => {
    const { e, doc } = make("<h2>Risks</h2><p>Sign in with SSO, then SSO again.</p><p>Last SSO</p>", withDb);
    const at = e.state.doc.child(0).nodeSize + e.state.doc.child(1).nodeSize;
    e.commands.insertContentAt(at, [{ type: "database", attrs: { dbId: "db1" } }, { type: "board", attrs: { boardId: "bd1" } }]);
    const dbNode = true;
    const r1 = findAll(e.state.doc, doc, re("SSO"), all);
    const kinds = r1.matches.map((m) => m.kind);
    expect(kinds.filter((k) => k === "text")).toHaveLength(3);
    if (dbNode) {
      expect(kinds).toContain("cell");
      expect(kinds).toContain("shape");
      // In document order: two in the paragraph, then the database and board, then "Last SSO".
      expect(kinds.slice(0, 2)).toEqual(["text", "text"]);
      expect(kinds[kinds.length - 1]).toBe("text");
      const cell = r1.matches.find((m) => m.kind === "cell" && m.fieldId === "s")!;
      expect(cell.kind === "cell" && cell.editable).toBe(false);
      expect(where(cell)).toBe("In Sprint 42 backlog · column Status");
    }
    expect(kinds).not.toContain("comment");
    const r2 = findAll(e.state.doc, doc, re("SSO"), { ...all, comments: true });
    expect(r2.matches[r2.matches.length - 1].kind).toBe("comment");
    const textOnly = findAll(e.state.doc, doc, re("SSO"), { text: true, cells: false, board: false, comments: false });
    expect(textOnly.matches.every((m) => m.kind === "text")).toBe(true);
  });

  it("stops at 10,000 and says so", () => {
    const { e, doc } = make(`<p>${"a ".repeat(10_050)}</p>`);
    const r = findAll(e.state.doc, doc, re("a"), all, 5_000);
    expect(r.matches).toHaveLength(10_000);
    expect(r.capped).toBe(true);
  });

  it("gives up on a pattern past its time budget instead of freezing", () => {
    const { e, doc } = make(`<p>${"x".repeat(3000)}</p>`.repeat(30));
    expect(() => findAll(e.state.doc, doc, re("x", { regex: true }), all, 0)).toThrow(TooSlow);
  });
});

describe("replace", () => {
  it("replace all of 500 matches is one undo step, keeps formatting, skips read-only cells and comments", () => {
    const html = Array.from({ length: 250 }, (_, i) => `<p>SSO <strong>SSO</strong> ${i}</p>`).join("");
    const { e, doc } = make(html, withDb);
    const um = yUndoPluginKey.getState(e.state)!.undoManager;
    e.commands.insertContentAt(e.state.doc.content.size, [
      { type: "database", attrs: { dbId: "db1" } },
      { type: "board", attrs: { boardId: "bd1" } },
    ]);
    um.stopCapturing();
    const before = e.getHTML();
    const r = findAll(e.state.doc, doc, re("SSO"), { ...all, comments: true });
    const text = r.matches.filter((m) => m.kind === "text");
    expect(text).toHaveLength(500);
    const sum = replaceMatches(e, doc, r.matches, "single sign-on", false, um);
    expect(sum.replaced).toBe(500 + 2 + 1); // text, title + notes cells, the sticky
    expect(sum.skipped).toBe(1); // the Status option
    expect(e.getHTML()).toContain("<strong>single sign-on</strong>");
    expect(findAll(e.state.doc, doc, re("SSO"), { ...all, comments: false }).matches.filter((m) => m.kind !== "cell")).toHaveLength(0);
    const row = (doc.getMap("databases").get("db1") as Y.Map<Y.Map<Y.Map<unknown>>>).get("rows")!.get("r1")!;
    expect(row.get("n")).toBe("Okta first, then single sign-on for Entra");
    expect(row.get("s")).toBe("SSO blocked");
    expect((doc.getMap("comments").get("th1") as Y.Map<Y.Array<Y.Map<unknown>>>).get("messages")!.get(0).get("text")).toBe("Ask about SSO");
    // One undo step restores everything.
    um.undo();
    expect(e.getHTML()).toBe(before);
    expect(row.get("n")).toBe("Okta first, then SSO for Entra");
    expect(row.get("t")).toBe("Ship SSO login");
  });

  it("expands groups for patterns only", () => {
    const m = { kind: "text", from: 1, to: 4, start: 0, end: 3, groups: ["SSO", "S"] } as Match;
    expect(expand("[$&/$1]", m, true)).toBe("[SSO/S]");
    expect(expand("[$&]", m, false)).toBe("[$&]");
  });

  it("keeps the current match while others type", () => {
    const { e, doc } = make("<p>SSO one</p><p>SSO two</p><p>SSO three</p>");
    const r = findAll(e.state.doc, doc, re("SSO"), all);
    const cur = r.matches[1];
    // Someone deletes the first match: the current one is still "SSO two".
    const tr = e.state.tr.delete(1, 4);
    e.view.dispatch(tr);
    const r2 = findAll(e.state.doc, doc, re("SSO"), all);
    const i = keepCurrent({ ...cur, from: cur.kind === "text" ? cur.from - 3 : 0 } as Match, r2.matches);
    expect(r2.matches).toHaveLength(2);
    expect(i).toBe(0);
  });
});
