// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Block operations on a real (headless) editor: the phone "+" must never type
// "/" into existing text, moves keep the block whole, duplicates drop blockId.
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { BASE_EXTENSIONS } from "./base";
import { BlockId } from "./blockId";
import { duplicateBlock, insertBelowCaret, moveBlock, topBlockAt } from "./blockops";
import { applyLink, linkAt, removeLink } from "./linkstate";

let ed: Editor | null = null;
afterEach(() => {
  ed?.destroy();
  ed = null;
});

function make(html: string) {
  ed = new Editor({ extensions: [...BASE_EXTENSIONS, BlockId], content: html });
  return ed;
}
const texts = (e: Editor) => {
  const out: string[] = [];
  e.state.doc.forEach((n) => out.push(n.textContent));
  return out;
};

describe("insertBelowCaret (phone +)", () => {
  it("opens the slash menu on a new line instead of typing into a word", () => {
    const e = make("<p>The file stays</p><p>next</p>");
    e.commands.setTextSelection(6); // inside "file"
    insertBelowCaret(e);
    expect(texts(e).slice(0, 3)).toEqual(["The file stays", "/", "next"]);
    expect(e.state.selection.$from.parent.textContent).toBe("/");
  });
  it("uses the current line when it is empty", () => {
    const e = make("<p>a</p><p></p>");
    e.commands.setTextSelection(4);
    insertBelowCaret(e);
    expect(texts(e)).toEqual(["a", "/"]);
  });
});

describe("move and duplicate", () => {
  it("moves a block down and keeps the caret in it", () => {
    const e = make("<p>one</p><p>two</p><p>three</p>");
    e.commands.setTextSelection(2);
    const b = topBlockAt(e.state, 2)!;
    moveBlock(e, b.pos, b.node, 1);
    expect(texts(e).slice(0, 3)).toEqual(["two", "one", "three"]);
    expect(e.state.selection.$from.parent.textContent).toBe("one");
  });
  it("duplicates without copying the block id (ids are unique per document)", () => {
    const e = make("<p>x</p>");
    e.view.dispatch(e.state.tr.setNodeMarkup(0, undefined, { blockId: "b_aaaaaaaaaaaaaaaaaaaaaaaaaa" }));
    expect(e.state.doc.child(0).attrs.blockId).toBe("b_aaaaaaaaaaaaaaaaaaaaaaaaaa");
    const b = topBlockAt(e.state, 1)!;
    duplicateBlock(e, b.pos, b.node);
    const ids: unknown[] = [];
    e.state.doc.forEach((n) => ids.push(n.attrs.blockId));
    // The copy gets its own fresh id (VH-00), never the original's.
    expect(ids[0]).toBe("b_aaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(ids[1]).toMatch(/^b_[0-9a-z]{26}$/);
    expect(ids[1]).not.toBe(ids[0]);
  });
});

describe("links", () => {
  it("links a selection, edits it, and removes it", () => {
    const e = make("<p>hello world</p>");
    applyLink(e, { from: 1, to: 6, href: "" }, "example.com");
    expect(linkAt(e, 2)).toEqual({ from: 1, to: 6, href: "https://example.com" });
    applyLink(e, { from: 1, to: 6, href: "https://example.com" }, "https://other.org");
    expect(linkAt(e, 2)?.href).toBe("https://other.org");
    removeLink(e, { from: 1, to: 6 });
    expect(linkAt(e, 2)).toBeNull();
  });
  it("inserts the address as text when nothing was selected", () => {
    const e = make("<p>see</p>");
    applyLink(e, { from: 4, to: 4, href: "" }, "a@b.co");
    expect(texts(e)[0]).toBe("seea@b.co");
    expect(linkAt(e, 7)?.href).toBe("mailto:a@b.co");
  });
  it("does nothing for a javascript: address", () => {
    const e = make("<p>hello</p>");
    expect(applyLink(e, { from: 1, to: 6, href: "" }, "javascript:alert(1)")).toBe(false);
    expect(linkAt(e, 2)).toBeNull();
  });
});
