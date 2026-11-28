// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// VH-00: stable block ids (docs/15 §4, docs/30 §6.1). Every block an editor can edit gets a
// `blockId`, ids stay unique, and they round-trip through Yjs. The Yjs state read at the end is
// also the shared fixture `crates/oc-model/tests/fixtures/blockids.ydoc.bin` (written by
// scripts/blockids-fixture.mjs), which the Rust side reads into `document.json` and `.ocanvas`
// (crates/oc-model/tests/roundtrip.rs).
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Editor, Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import * as Y from "yjs";
import { BASE_EXTENSIONS } from "./base";
import { BLOCK_ID_TYPES, BlockId } from "./blockId";

// vitest runs from the package directory.
const FIXTURE = resolve(process.cwd(), "../../../crates/oc-model/tests/fixtures/blockids.ydoc.bin");
const ID = /^b_[0-9a-hjkmnp-tv-z]{26}$/;

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

/** Lets the editor's queued id assignment run: when the browser is idle after load or a remote
 *  change (PSYNC-BUG-3: not inside the first screen's frame; jsdom has no requestIdleCallback,
 *  so a 16 ms timer). */
const settle = () => new Promise<void>((r) => setTimeout(r, 40));

function mount(doc: Y.Doc, opts: { editable?: boolean; ext?: Extension } = {}) {
  const e = new Editor({
    editable: opts.editable ?? true,
    extensions: [...BASE_EXTENSIONS, opts.ext ?? BlockId, Collaboration.configure({ document: doc, field: "content" })],
  });
  editors.push(e);
  return e;
}

/** `blockId`s of the top-level XML elements as Yjs stores them. */
function yIds(doc: Y.Doc): (string | undefined)[] {
  return doc
    .getXmlFragment("content")
    .toArray()
    .map((n) => (n instanceof Y.XmlElement ? (n.getAttribute("blockId") as string | undefined) : undefined));
}

/** A Y.Doc with blocks written by a client that never assigned ids (0.1.x). */
function legacyDoc(): Y.Doc {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment("content");
  const para = (t: string) => {
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText(t)]);
    return p;
  };
  const list = new Y.XmlElement("bulletList");
  const li = new Y.XmlElement("listItem");
  li.insert(0, [para("item")]);
  list.insert(0, [li]);
  frag.insert(0, [para("one"), para("two"), list]);
  return doc;
}

/** The 0.1.x BlockId: declares the attribute (so it round-trips) but never invents ids. */
const OldBlockId = Extension.create({
  name: "blockId",
  addGlobalAttributes: () => [{ types: BLOCK_ID_TYPES, attributes: { blockId: { default: null, keepOnSplit: false } } }],
});

describe("stable block ids (VH-00)", () => {
  it("gives every block of an older document an id on load, and writes them to Yjs", async () => {
    const doc = legacyDoc();
    const e = mount(doc);
    await settle();
    const ids: string[] = [];
    e.state.doc.descendants((n) => {
      if (BLOCK_ID_TYPES.includes(n.type.name)) ids.push(n.attrs.blockId as string);
    });
    // two paragraphs, the list, its item, the item's paragraph, and the trailing paragraph
    expect(ids).toHaveLength(6);
    for (const id of ids) expect(id).toMatch(ID);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of yIds(doc)) expect(id).toMatch(ID);
  });

  it("keeps ids already in the document", async () => {
    const doc = legacyDoc();
    (doc.getXmlFragment("content").get(0) as Y.XmlElement).setAttribute("blockId", "b_keepkeepkeepkeepkeepkeepke");
    mount(doc);
    await settle();
    expect(yIds(doc)[0]).toBe("b_keepkeepkeepkeepkeepkeepke");
  });

  it("gives a block split off with Enter its own id; the first half keeps the old one", async () => {
    const doc = legacyDoc();
    const e = mount(doc);
    await settle();
    const before = e.state.doc.child(0).attrs.blockId as string;
    e.commands.setTextSelection(3); // "on|e"
    e.commands.splitBlock();
    const a = e.state.doc.child(0).attrs.blockId as string;
    const b = e.state.doc.child(1).attrs.blockId as string;
    expect(a).toBe(before);
    expect(b).toMatch(ID);
    expect(b).not.toBe(a);
    expect(yIds(doc).slice(0, 2)).toEqual([a, b]);
  });

  it("re-ids a pasted copy of a block that is still in the document, not the original", async () => {
    const doc = legacyDoc();
    const e = mount(doc);
    await settle();
    const id = e.state.doc.child(0).attrs.blockId as string;
    // Paste two copies of block 0 into an empty line above it (the copies come first in document order).
    e.commands.insertContentAt(0, "<p></p>");
    e.commands.setTextSelection(1);
    // jsdom has no ClipboardEvent; ProseMirror only needs an Event to hand to the paste handlers.
    const g = globalThis as { ClipboardEvent?: unknown };
    g.ClipboardEvent ??= class extends Event {
      clipboardData = null;
    };
    e.view.pasteHTML(`<p data-block-id="${id}">copy</p><p data-block-id="${id}">copy 2</p>`);
    const all: string[] = [];
    e.state.doc.forEach((n) => all.push(n.attrs.blockId as string));
    expect(new Set(all).size).toBe(all.length);
    let orig: string | undefined;
    e.state.doc.forEach((n) => {
      if (n.textContent === "one") orig = n.attrs.blockId as string;
    });
    expect(orig).toBe(id);
  });

  it("never writes from a read-only editor", async () => {
    const doc = legacyDoc();
    const seen: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => seen.push(u));
    mount(doc, { editable: false });
    await settle();
    expect(seen).toHaveLength(0);
    expect(yIds(doc)).toEqual([undefined, undefined, undefined]);
  });

  it("does not write into an empty, not yet loaded document", async () => {
    const doc = new Y.Doc();
    const seen: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => seen.push(u));
    mount(doc);
    await settle();
    expect(seen).toHaveLength(0);
  });

  it("converges when two editors assign ids to the same legacy blocks at once", async () => {
    const a = legacyDoc();
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    mount(a);
    mount(b);
    await settle();
    expect(yIds(a)).not.toEqual(yIds(b)); // each chose its own ids
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    await settle();
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(yIds(a)).toEqual(yIds(b));
    for (const id of yIds(a)) expect(id).toMatch(ID);
  });

  it("an older client keeps ids when it edits the block (the attribute round-trips)", async () => {
    const doc = legacyDoc();
    mount(doc);
    await settle();
    const ids = yIds(doc);
    for (const id of ids) expect(id).toMatch(ID);
    const old = mount(doc, { ext: OldBlockId });
    old.commands.setTextSelection(2);
    old.commands.insertContent("X");
    expect(old.state.doc.child(0).textContent).toBe("oXne");
    expect(yIds(doc)).toEqual(ids);
  });

  it("reads the shared fixture: ids survive Yjs exactly as the Rust side expects", async () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(readFileSync(FIXTURE)));
    const e = mount(doc);
    await settle();
    const ids: string[] = [];
    e.state.doc.descendants((n) => {
      if (n.attrs.blockId) ids.push(n.attrs.blockId as string);
    });
    // The fixture's ids are kept; only the trailing paragraph the editor adds after the list is new.
    expect(ids.slice(0, 5)).toEqual(["b_0000000000000000000000000a", "b_0000000000000000000000000b", "b_0000000000000000000000000c", "b_0000000000000000000000000d", "b_0000000000000000000000000e"]);
  });
});

describe("ids for a large document (PSYNC-A1)", () => {
  it("are assigned in chunks of at most ID_CHUNK blocks, the rest when idle", async () => {
    const { ID_CHUNK } = await import("./blockId");
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment("content");
    const blocks = Array.from({ length: ID_CHUNK * 3 + 7 }, (_, i) => {
      const p = new Y.XmlElement("paragraph");
      p.insert(0, [new Y.XmlText(`p${i}`)]);
      return p;
    });
    frag.insert(0, blocks);
    const e = mount(doc);
    const steps: number[] = [];
    e.on("transaction", ({ transaction }) => {
      if (transaction.steps.length) steps.push(transaction.steps.length);
    });
    await settle();
    expect(yIds(doc).filter(Boolean).length).toBe(ID_CHUNK);
    const until = Date.now() + 5000;
    while (yIds(doc).some((id) => !id) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    const ids = yIds(doc);
    expect(ids.every((id) => !!id && ID.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.max(...steps)).toBeLessThanOrEqual(ID_CHUNK);
  });
});
