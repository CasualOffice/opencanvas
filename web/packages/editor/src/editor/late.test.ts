// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The late plugins (slash, @mentions, links) load after first paint. Someone who types "@Ra"
// before they arrive must still get the mention menu once they do. p-people failed on CI: the
// menu was opened by the collaboration plugin's re-render, closed again when the next late plugin
// was registered (every reconfigure destroys the plugin views), and never reopened, because the
// suggestion stayed active with the same query.
import { afterEach, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import * as Y from "yjs";
import { BASE_EXTENSIONS } from "./base";
import { mentionNode } from "./link";
import { installLate } from "./late";
import { suggestStore } from "./suggest";

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  suggestStore.set(null);
});

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

it("an @query typed before the late plugins load opens the mention menu once they are installed", async () => {
  const doc = new Y.Doc();
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...BASE_EXTENSIONS, mentionNode(() => "#888"), Collaboration.configure({ document: doc, field: "content" })],
  });
  editors.push(editor);
  editor.commands.insertContent("Owner @Ra");
  expect(editor.state.doc.textContent).toBe("Owner @Ra");
  installLate(editor, async () => [{ id: "u_ravi", label: "Ravi Menon", color: "#888" }]);
  await settle();
  await settle();
  const s = suggestStore.get();
  expect(s?.kind).toBe("mention");
  expect(s?.query).toBe("Ra");
  expect((s?.items as { id: string }[]).map((u) => u.id)).toContain("u_ravi");
});
