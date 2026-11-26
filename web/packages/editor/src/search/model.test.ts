// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { describe, expect, it } from "vitest";
import { group, highlight, parseAnswer, recents, remember, savedLabel } from "./model";

describe("search all canvases", () => {
  it("groups hits by canvas in the host's order, with a flat index for the arrow keys", () => {
    const g = group([
      { fileId: "a", title: "Sprint 42", snippet: "one" },
      { fileId: "b", title: "Rollout", snippet: "two" },
      { fileId: "a", title: "Sprint 42", snippet: "three" },
    ]);
    expect(g.map((x) => x.fileId)).toEqual(["a", "b"]);
    expect(g[0].hits.map((h) => [h.snippet, h.index])).toEqual([["one", 0], ["three", 1]]);
    expect(g[1].hits[0].index).toBe(2);
  });

  it("marks the query's words in a plain snippet, never as HTML", () => {
    expect(highlight("Admins can sign in with SSO, then sso.", "sso")).toEqual([
      { text: "Admins can sign in with ", hit: false },
      { text: "SSO", hit: true },
      { text: ", then ", hit: false },
      { text: "sso", hit: true },
      { text: ".", hit: false },
    ]);
    expect(highlight("<b>x</b>", "b")[0]).toEqual({ text: "<", hit: false });
    expect(highlight("a.b", "(")).toEqual([{ text: "a.b", hit: false }]);
  });

  it("says when a canvas was saved", () => {
    const now = Date.parse("2026-11-26T10:00:00Z");
    expect(savedLabel("2026-11-26T09:56:00Z", now)).toBe("Saved 4 min ago");
    expect(savedLabel("2026-11-25T10:00:00Z", now)).toBe("Saved yesterday");
    expect(savedLabel("2026-11-20T10:00:00Z", now)).toBe("Saved Nov 20");
    expect(savedLabel(undefined, now)).toBe("");
  });

  it("keeps five recent searches in this browser", () => {
    for (const q of ["a", "b", "c", "d", "e", "f", "b"]) remember(q);
    expect(recents()).toEqual(["b", "f", "e", "d", "c"]);
  });

  it("reads an answer defensively", () => {
    expect(parseAnswer(null)).toEqual({ items: [], scopes: [], partial: false, next: null });
    expect(parseAnswer({ items: [{ fileId: "x", title: "T", snippet: "s" }, { nope: 1 }], partial: true }).items).toHaveLength(1);
  });
});
