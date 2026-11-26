// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// LIVE-03 (docs/prototypes/v03-approved/live-blocks.html): paste-as links (1d), the host picker
// entry (1e), the limits of frame 5g and the first-edit hint wording (2b).
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { BASE_EXTENSIONS } from "../editor/base";
import { BlockId } from "../editor/blockId";
import { ExtBlock } from "../ext/node";
import { BlockRef, LiveBlock } from "./node";
import { countRefs, linkHtml, MAX_REFS, parseBlockLink, setLiveCfg, liveCfg } from "./state";
import { offered, type Ctx } from "../editor/insert/model";
import { emptyRec } from "../editor/insert/recent";
import { CORE_BLOCKS } from "../editor/profile";

describe("paste a block link (1d)", () => {
  it("reads the editor's own clipboard marker", () => {
    const html = linkHtml("https://acme.example/f/8812", { fileId: "doc_8812", live: true });
    expect(parseBlockLink("https://acme.example/f/8812", html, null)).toEqual({ fileId: "doc_8812", blockId: undefined, live: true });
    const b = linkHtml("#block=b_1", { fileId: "doc_1", blockId: "b_1" });
    expect(parseBlockLink("#block=b_1", b, null)).toEqual({ fileId: "doc_1", blockId: "b_1", live: false });
  });

  it("matches the host's [host.live] link pattern, with a block or #live", () => {
    const pat = "https://acme.example/docs/f/{fileId}";
    expect(parseBlockLink("https://acme.example/docs/f/8812#live", null, pat)).toEqual({ fileId: "8812", blockId: undefined, live: true });
    expect(parseBlockLink("https://acme.example/docs/f/8812#block=b_9", null, pat)).toEqual({ fileId: "8812", blockId: "b_9", live: undefined });
    expect(parseBlockLink("https://acme.example/docs/f/8812", null, pat)?.fileId).toBe("8812");
  });

  it("ignores other links and hostile markers", () => {
    expect(parseBlockLink("https://example.com/x", null, "https://acme.example/f/{fileId}")).toBeNull();
    expect(parseBlockLink("https://acme.example/f/a/b", null, "https://acme.example/f/{fileId}")).toBeNull();
    expect(parseBlockLink("x", '<a data-oc-file="a b<script>">x</a>', null)).toBeNull();
    expect(parseBlockLink("x", null, null)).toBeNull();
  });
});

describe("the host picker entry (1e)", () => {
  const ctx = (o: Partial<Ctx> = {}): Ctx => ({ profile: { profile: "full", blocks: [...CORE_BLOCKS] }, ai: false, imp: false, pkgs: [], rec: emptyRec(), now: 0, ...o });
  it("shows only with live.insert", () => {
    expect(offered(ctx()).some((b) => b.key === "live")).toBe(false);
    expect(offered(ctx({ live: true })).some((b) => b.key === "live")).toBe(true);
  });
});

describe("limits (5g)", () => {
  it("counts live blocks and references anywhere in the canvas", () => {
    const schema = getSchema([...BASE_EXTENSIONS, BlockId, ExtBlock, LiveBlock, BlockRef]);
    const content = [
      { type: "liveBlock", attrs: { fileId: "L1", title: "A" } },
      { type: "blockRef", attrs: { fileId: "F", refBlockId: "b", title: "B" } },
      { type: "paragraph", content: [{ type: "text", text: "x" }] },
    ];
    const state = EditorState.create({ schema, doc: schema.nodeFromJSON({ type: "doc", content }) });
    expect(countRefs(state)).toBe(2);
    expect(MAX_REFS).toBe(50);
  });
});

describe("session config", () => {
  it("clamps maxOpen and defaults to off", () => {
    setLiveCfg(null);
    expect(liveCfg.get().enabled).toBe(false);
    setLiveCfg({ enabled: true, maxOpen: 99 });
    expect(liveCfg.get().maxOpen).toBe(8);
    setLiveCfg(null);
  });
});
