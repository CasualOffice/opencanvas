// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
// A block whose package loads asynchronously lands where the "/" was, even when the selection
// moves meanwhile (a collaborator, or the block's own Y.Doc write syncing back).

import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { BASE_EXTENSIONS } from "../base";
import { later } from "./run";

let ed: Editor | null = null;
afterEach(() => { ed?.destroy(); ed = null; });

describe("later()", () => {
  it("inserts at the slash position, not where the selection moved during the load", async () => {
    ed = new Editor({ extensions: BASE_EXTENSIONS, content: "<p>one</p><p>two</p><p>three</p>" });
    const end = ed.state.doc.content.size - 1; // inside "three", at its end
    ed.commands.setTextSelection(end);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const done = later(ed, null, async () => { await gate; return [{ type: "paragraph", content: [{ type: "text", text: "INSERTED" }] }]; });
    ed.commands.setTextSelection(1); // the selection jumps to the start meanwhile
    ed.commands.insertContentAt(1, "x"); // and someone types at the start
    release();
    await done;
    const texts: string[] = [];
    ed.state.doc.forEach((n) => texts.push(n.textContent));
    expect(texts.indexOf("INSERTED")).toBeGreaterThan(texts.findIndex((t) => t.includes("three")) - 1);
    expect(texts[0]).toBe("xone");
  });
});
