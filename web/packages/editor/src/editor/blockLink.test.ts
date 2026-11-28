// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// BRD-21 leftovers (board UX decision 1): "Copy link to shape" is "Copy link to block" with the
// shape named, `#block=<id>&shape=<shapeId>`, in the editor's own link, the host's `[host.live]
// link` and the deep link the editor opens.
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { blockLinkText, linkTarget } from "./blockLink";
import { linkFor, setLiveCfg } from "../live/state";

describe("links to a shape on a board", () => {
  it("adds &shape= to the block link (demo, in-app and the host's pattern)", () => {
    expect(blockLinkText({ demo: true, href: "https://x.example/app#demo", blockId: "b_1", shapeId: "s9" })).toBe("https://x.example/app#demo&block=b_1&shape=s9");
    expect(blockLinkText({ demo: false, href: "https://x.example/app#t=1", blockId: "b_1", shapeId: "s9" })).toBe("#block=b_1&shape=s9");
    expect(blockLinkText({ demo: false, href: "https://x.example/app", blockId: "b_1" })).toBe("#block=b_1");
    setLiveCfg({ link: "https://acme.example/f/{fileId}" });
    expect(linkFor({ fileId: "doc_1", blockId: "b_1", shapeId: "s9" })).toBe("https://acme.example/f/doc_1#block=b_1&shape=s9");
    expect(linkFor({ fileId: "doc_1", blockId: "b_1" })).toBe("https://acme.example/f/doc_1#block=b_1");
  });
  it("reads the block and shape from a deep link; refuses odd ids", () => {
    expect(linkTarget("#t=abc&block=b_1&shape=s9")).toEqual({ blockId: "b_1", shapeId: "s9" });
    expect(linkTarget("#block=b_1")).toEqual({ blockId: "b_1", shapeId: null });
    expect(linkTarget("#block=b_1&shape=<x>")).toEqual({ blockId: "b_1", shapeId: null });
    expect(linkTarget("#t=abc")).toEqual({ blockId: null, shapeId: null });
  });
});
