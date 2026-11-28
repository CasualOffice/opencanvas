// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { describe, expect, it } from "vitest";
import { headingAnchor, matchHostUrl, refWhere, sortGroups, visibleRefs, when, type Backlink } from "./model";

const P = ["https://docs.acme.test/f/{fileId}#{blockId}", "https://docs.acme.test/f/{fileId}"];

describe("host URLs", () => {
  it("match a canvas and a block, decoded", () => {
    expect(matchHostUrl(P, "https://docs.acme.test/f/doc%201#h2")).toEqual({ fileId: "doc 1", blockId: "h2" });
    expect(matchHostUrl(P, "https://docs.acme.test/f/doc_1?x=1")).toEqual({ fileId: "doc_1" });
  });
  it("refuse other hosts, more path and text", () => {
    expect(matchHostUrl(P, "https://docs.acme.test.evil/f/doc_1")).toBeNull();
    expect(matchHostUrl(P, "https://docs.acme.test/f/doc_1/more")).toBeNull();
    expect(matchHostUrl(P, "see https://docs.acme.test/f/doc_1")).toBeNull();
    expect(matchHostUrl([], "https://docs.acme.test/f/doc_1")).toBeNull();
  });
});

describe("heading anchors", () => {
  it("are the server's: lower case words joined by dashes", () => {
    expect(headingAnchor("  Phase 2: enforce   SSO! ")).toBe("h:phase-2-enforce-sso");
  });
});

describe("Linked from", () => {
  const b: Backlink = {
    fileId: "f1",
    title: "Q1 Platform roadmap",
    path: null,
    updatedAt: null,
    updatedBy: null,
    savedAt: 1,
    refs: [
      { block: "p", toBlock: "h2", toRow: null, kind: "link", section: "Identity", excerpt: null },
      { block: "q", toBlock: null, toRow: null, kind: "embed", section: null, excerpt: null },
    ],
  };
  it("filters by kind and block", () => {
    expect(visibleRefs(b, "all", null)).toHaveLength(2);
    expect(visibleRefs(b, "embed", null).map((r) => r.block)).toEqual(["q"]);
    expect(visibleRefs(b, "all", "h2").map((r) => r.block)).toEqual(["p"]);
  });
  it("says where a reference is and what it points at", () => {
    expect(refWhere(b.refs[0], (id) => (id === "h2" ? "Phase 2" : undefined))).toBe("in Identity · to Phase 2");
    expect(refWhere(b.refs[1], () => undefined)).toBe("live block");
  });
  it("sorts by title on request, else keeps the newest first", () => {
    const a = { ...b, fileId: "f2", title: "Alpha" };
    expect(sortGroups([b, a], "recent").map((x) => x.fileId)).toEqual(["f1", "f2"]);
    expect(sortGroups([b, a], "title").map((x) => x.fileId)).toEqual(["f2", "f1"]);
  });
  it("says when", () => {
    const now = Date.parse("2026-11-28T12:00:00Z");
    expect(when("2026-11-28T11:59:30Z", now)).toBe("now");
    expect(when("2026-11-28T10:00:00Z", now)).toBe("2 h ago");
    expect(when("2026-11-24T10:00:00Z", now)).toBe("Nov 24");
    expect(when(null, now)).toBe("");
  });
});
