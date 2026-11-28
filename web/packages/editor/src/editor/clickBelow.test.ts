// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
// @vitest-environment jsdom
// A press below the last block puts the caret at the end, not at the start (live demo bug).

import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { BASE_EXTENSIONS } from "./base";
import { focusEndOnClickBelow } from "./clickBelow";

let ed: Editor | null = null;
afterEach(() => { ed?.destroy(); ed = null; document.body.innerHTML = ""; });

function setup(html: string) {
  const page = document.createElement("div");
  page.className = "scroll";
  const host = document.createElement("div");
  page.appendChild(host);
  document.body.appendChild(page);
  ed = new Editor({ element: host, extensions: BASE_EXTENSIONS, content: html });
  ed.commands.setTextSelection(1);
  return page;
}

describe("click below the last block", () => {
  it("moves the caret to the end of an empty last paragraph", () => {
    const page = setup("<p>one</p><p>two</p><p></p>");
    expect(focusEndOnClickBelow(ed, page, 10_000)).toBe(true);
    expect(ed!.state.selection.from).toBe(ed!.state.doc.content.size - 1);
    ed!.commands.insertContent("/");
    expect(ed!.state.doc.lastChild!.textContent).toBe("/");
    expect(ed!.state.doc.firstChild!.textContent).toBe("one");
  });
  it("adds an empty paragraph when the last block has text", () => {
    const page = setup("<p>one</p><p>two</p>");
    focusEndOnClickBelow(ed, page, 10_000);
    expect(ed!.state.doc.childCount).toBe(3);
    expect(ed!.state.doc.lastChild!.content.size).toBe(0);
  });
  it("ignores presses on the editor itself or on buttons", () => {
    const page = setup("<p>one</p>");
    expect(focusEndOnClickBelow(ed, ed!.view.dom, 10_000)).toBe(false);
    const b = document.createElement("button");
    page.appendChild(b);
    expect(focusEndOnClickBelow(ed, b, 10_000)).toBe(false);
  });
});
