// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SDK blocks in the editor (BSDK-02): the shared template cases (the Rust engine runs the same
// file), the `ext` root's per-field merge, version status and
// fallbacks, and that the current schema loads and saves `extBlock`s untouched.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { ySyncPlugin, ySyncPluginKey } from "@tiptap/y-tiptap";
import { parseTemplate, renderTemplate } from "./template";
import { deriveFallback } from "./derive";
import { fallbackText, readExtData, setInstalledBlocks, statusOf, writeExtData, type BlockPackage } from "./model";
import { ExtBlock } from "./node";
import { seedDoc, snapshot } from "./testdoc";
import { BASE_EXTENSIONS } from "../editor/base";
import { BlockId } from "../editor/blockId";

const FIX = JSON.parse(readFileSync(resolve(__dirname, "../../../../../crates/oc-model/tests/fixtures/ext.json"), "utf8"));

describe("shared fixtures (same results as oc_model::ext)", () => {
  it("renders every template case", () => {
    for (const c of FIX.templates) {
      const t = parseTemplate(c.template);
      expect(renderTemplate(t, c.ctx, "markdown"), c.template).toBe(c.markdown);
      expect(renderTemplate(t, c.ctx, "text"), c.template).toBe(c.text);
    }
  });
  it("refuses code-like templates", () => {
    for (const t of FIX.refused) expect(() => parseTemplate(t), t).toThrow();
  });
});

const OKR: BlockPackage = {
  type: "acme.okr", version: "2.0.0", v: 2, title: "OKR", content: "blocks", attrs: {}, entry: null, integrity: "",
  export: { markdown: "**{{objective}}** ({{progress|percent}})", text: "{{objective}}" },
};

describe("versions, data and fallbacks", () => {
  it("classifies stored versions against the installed package", () => {
    setInstalledBlocks([OKR]);
    expect(statusOf({ type: "acme.okr", v: 2 })).toBe("current");
    expect(statusOf({ type: "acme.okr", v: 1 })).toBe("older");
    expect(statusOf({ type: "acme.okr", v: 3 })).toBe("newer");
    expect(statusOf({ type: "acme.other", v: 1 })).toBe("missing");
    expect(deriveFallback(OKR, { objective: "Ship <it>", progress: 0.5 }, {})).toEqual({ markdown: "**Ship \\<it\\>** (50%)", text: "Ship <it>" });
    expect(fallbackText({ type: "acme.other", fallback: { markdown: "**x**", text: "X text" } })).toBe("X text");
    expect(fallbackText({ type: "acme.okr", fallback: null })).toBe("Block: OKR");
    setInstalledBlocks([]);
  });

  it("merges concurrent edits of different data fields (per-field LWW)", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    writeExtData(a, "d1", { score: 1, owner: "Asha" });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    writeExtData(a, "d1", { score: 5 });
    writeExtData(b, "d1", { owner: "Ravi" });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(readExtData(a, "d1")).toEqual({ score: 5, owner: "Ravi" });
    expect(readExtData(b, "d1")).toEqual(readExtData(a, "d1"));
  });
});

describe("the current schema keeps SDK blocks", () => {
  it("loads, edits around and saves a document with extBlocks without changing them", () => {
    const schema = getSchema([...BASE_EXTENSIONS, BlockId, ExtBlock]);
    const doc = seedDoc(schema);
    const before = snapshot(doc);
    const el = document.createElement("div");
    const view = new EditorView(el, { state: EditorState.create({ schema, plugins: [ySyncPlugin(doc.getXmlFragment("content"))] }) });
    // The binding renders the Y content; the extBlock is a real node with its attributes.
    const pm = view.state.doc;
    expect(pm.child(1).type.name).toBe("extBlock");
    expect(pm.child(1).attrs.attrs).toEqual({ objective: "Ship v0.2", progress: 0.4, krs: [{ title: "API", done: true }] });
    expect(ySyncPluginKey.getState(view.state)).toBeTruthy();
    expect(snapshot(doc)).toEqual(before);
    // An edit elsewhere saves without touching the block.
    view.dispatch(view.state.tr.insertText("!", pm.child(0).nodeSize - 1));
    const after = snapshot(doc);
    expect(after.ext).toEqual(before.ext);
    expect(after.content).toContain("Before!");
    expect(after.content.replace("Before!", "Before")).toEqual(before.content);
    view.destroy();
  });
});
