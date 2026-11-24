// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// VH-02b (frames 4a-4c, 9c): the server's structural diff (ADR-052) turned into the list of
// changes the preview steps through, and inline runs mapped onto the block's text. Reads the
// fixtures shared with oc-model (crates/oc-model/tests/fixtures/diff), so the two sides agree.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { changeList, mapRuns, wordPairs, type Diff } from "./changes";

const fixture = (n: string) => JSON.parse(readFileSync(resolve(process.cwd(), `../../../crates/oc-model/tests/fixtures/diff/${n}.json`), "utf8")).expected as Diff;
const none = () => "";

describe("changeList", () => {
  it("lists text changes in order with plain words, never colour alone", () => {
    const c = changeList(fixture("text"), { blockText: (b) => (b.blockId === "b_p1" ? "Admins can sign in with SSO from the settings page." : "Block " + (b.blockId ?? b.path)) });
    expect(c.map((x) => [x.kind, x.detail])).toEqual([
      ["chg", "SSO rollout → SSO rollout plan"],
      ["move", "Moved"],
      ["chg", "SAML → SSO"],
      ["chg", "Formatting"],
      ["rem", "Removed"],
      ["chg", "+ admin"],
      ["add", "Added"],
      ["add", "Added"],
    ]);
    expect(c[0].title).toBe("Title");
    expect(c[2].title).toBe("Admins can sign in with SSO from the settings…");
    expect(c[4].title).toBe("Legacy passwords stay for one release.");
    expect(c[4].target).toEqual({ t: "removed", key: "b_gone" });
  });

  it("lists database rows, cells and fields under the database's name", () => {
    const c = changeList(fixture("database"), { blockText: none, rowTitle: (_db, r) => (r === "r_1" ? "Write release notes" : r) });
    expect(c.map((x) => `${x.kind} ${x.title} · ${x.detail}`)).toEqual([
      "chg Tasks: Assignee · Renamed from Owner",
      "add Tasks: Due · Field added",
      "rem Tasks: Old checklist · Row removed",
      "add Tasks: Brief support · Row added",
      "chg Tasks: Write release notes · Status, Due",
      "chg Tasks: Write release notes · Notes",
    ]);
    expect(c[4].target).toEqual({ t: "row", dbId: "db_tasks", rowId: "r_1" });
  });

  it("lists board shapes: changed, moved, re-bound, removed, added", () => {
    const c = changeList(fixture("board"), { blockText: none, shapeText: (_b, s) => (s === "s_login" ? "Single sign-on" : s === "s_done" ? "Done" : "") });
    expect(c.map((x) => `${x.kind} ${x.title} · ${x.detail}`)).toEqual([
      "chg Board: Single sign-on · Resized, text, style",
      "move Board: Diamond · Moved",
      "chg Board: Arrow · Reconnected",
      "rem Board: Ask security · Removed",
      "add Board: Done · Added",
    ]);
  });
});

describe("inline runs", () => {
  it("pairs removed and added words for the change list", () => {
    expect(wordPairs([["eq", "Admins can sign in with "], ["del", "SAML"], ["ins", "SSO"], ["eq", " and "], ["del", "100,000"], ["ins", "50,000"]])).toBe("SAML → SSO, 100,000 → 50,000");
    expect(wordPairs([["eq", "a "], ["del", "gone"]])).toBe("− gone");
  });

  it("maps runs onto the newer text: added ranges, removed text with its offset", () => {
    const runs: [string, string][] = [["eq", "Admins can sign in with "], ["del", "SAML"], ["ins", "SSO"], ["eq", " now."]];
    expect(mapRuns("Admins can sign in with SSO now.", runs)).toEqual({ ins: [[24, 27]], del: [{ at: 24, text: "SAML" }] });
    // The block's text no longer matches (edited again since): no inline marks, the bar stays.
    expect(mapRuns("Something else", runs)).toBeNull();
  });
});
