// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Editor profiles (EDP-01, ADR-061): the shared insertion filter, intent keywords, SDK blocks by
// `discovery.profiles`, markdown shortcuts, and HIDE, NEVER DELETE: a document holding every
// block type opens unchanged, stays editable and round-trips in every profile.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Y from "yjs";
import { Editor } from "@tiptap/core";
import { Schema, type MarkSpec, type Node as PMNode, type NodeSpec } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON, ySyncPlugin } from "@tiptap/y-tiptap";
import { BASE_EXTENSIONS } from "./base";
import { filterSlash, SLASH } from "./slash";
import { CORE_BLOCKS, insertable, profileStore, setEditorProfile, SLASH_BLOCKS, withInputRules, type EditorProfile } from "./profile";
import { aiStore } from "../lib/assistant";
import { importStore } from "../lib/importflag";

// The profile sets as the server sends them (crates/oc-server/src/editor.rs `profile_blocks`).
const ACT = ["core.import", "core.assistant"];
const PROFILES: Record<string, string[]> = {
  notebook: ["core.text", "core.heading", "core.bulleted_list", "core.numbered_list", "core.checklist", "core.image", "core.link_preview", "core.callout", ...ACT],
  meeting: ["core.text", "core.heading", "core.checklist", "core.bulleted_list", "core.numbered_list", "core.callout", "core.divider", "core.table", "core.date", ...ACT],
  project: ["core.text", "core.heading", "core.database", "core.kanban", "core.calendar", "core.checklist", "core.date", ...ACT],
  diagramming: ["core.text", "core.heading", "core.whiteboard", "core.diagram", "core.shapes", ...ACT],
  document: ["core.text", "core.heading", "core.table", "core.image", "core.bulleted_list", "core.numbered_list", "core.divider", ...ACT],
  full: [...CORE_BLOCKS],
};
const prof = (profile: string, blocks = PROFILES[profile]): EditorProfile => ({ profile, blocks });

afterEach(() => {
  setEditorProfile(null);
  aiStore.set({ on: false, modes: [] });
  importStore.set({ formats: [] });
});

const ids = (q = "") => filterSlash(q).map((x) => x.id);

describe("core block ids", () => {
  it("match the server's list and cover every / menu entry", () => {
    const rs = readFileSync(resolve(process.cwd(), "../../../crates/oc-server/src/editor.rs"), "utf8");
    const server = [...rs.slice(rs.indexOf("CORE_BLOCKS"), rs.indexOf("];")).matchAll(/"(core\.[a-z_]+)"/g)].map((m) => m[1]);
    expect(server).toEqual([...CORE_BLOCKS]);
    for (const x of SLASH) expect(SLASH_BLOCKS[x.id], x.id).toBeTruthy();
  });
});

describe("the shared insertion filter", () => {
  it("offers everything without a profile (older server, demo) and in full", () => {
    const all = ids();
    setEditorProfile(prof("full"));
    expect(ids()).toEqual(all);
  });

  it("meeting shows only its blocks in the / menu", () => {
    setEditorProfile(prof("meeting"));
    expect(ids()).toEqual(["p", "h1", "h2", "h3", "todo", "bul", "num", "callout", "divider", "table", "date"]);
  });

  it("each profile hides what it does not list; text always stays", () => {
    for (const [name, blocks] of Object.entries(PROFILES)) {
      setEditorProfile(prof(name));
      const shown = ids();
      expect(shown, name).toContain("p");
      for (const id of shown) expect(SLASH_BLOCKS[id].some((b) => blocks.includes(b)), `${name}: ${id}`).toBe(true);
    }
    setEditorProfile(prof("project"));
    expect(ids()).toEqual(expect.arrayContaining(["db", "todo"]));
    expect(ids()).not.toContain("board");
    setEditorProfile(prof("diagramming"));
    expect(ids()).toContain("board");
    expect(ids()).not.toContain("db");
  });

  it("an explicit list without text still offers text", () => {
    setEditorProfile({ profile: "meeting", blocks: ["core.checklist"] });
    expect(ids()).toEqual(["p", "todo"]);
  });

  it("features still gate the assistant and import entries", () => {
    setEditorProfile(prof("meeting"));
    expect(ids()).not.toContain("assistant");
    aiStore.set({ on: true, modes: ["edit"] });
    importStore.set({ formats: ["md"] });
    expect(ids()).toEqual(expect.arrayContaining(["assistant", "import"]));
  });

  it("SDK blocks follow their manifest discovery.profiles, read defensively", () => {
    const okr = { type: "acme.okr", discovery: { profiles: ["project"] } };
    const plain = { type: "acme.plain" };
    const odd = { type: "acme.odd", discovery: { profiles: "project" } };
    expect(insertable(okr, prof("project"))).toBe(true);
    expect(insertable(okr, prof("meeting"))).toBe(false);
    expect(insertable(okr, prof("full"))).toBe(true);
    expect(insertable(plain, prof("meeting"))).toBe(true);
    expect(insertable(odd, prof("meeting"))).toBe(true);
    // An explicit block list names SDK types itself.
    expect(insertable(okr, { profile: "meeting", blocks: ["core.text", "acme.okr"] })).toBe(true);
    expect(insertable(plain, { profile: "meeting", blocks: ["core.text", "acme.okr"] })).toBe(false);
  });
});

describe("intent keywords", () => {
  it.each([
    ["track tasks", ["todo", "db"]],
    ["draw architecture", ["board"]],
    ["write notes", ["p"]],
    ["plan sprint", ["db"]],
    ["schedule", ["db"]],
    ["kanban", ["db"]],
    ["flowchart", ["board"]],
    ["action items", ["todo"]],
  ])("%s finds %j", (q, want) => {
    const got = ids(q);
    for (const w of want) expect(got, q).toContain(w);
  });

  it("intent search respects the profile", () => {
    setEditorProfile(prof("meeting"));
    expect(ids("track tasks")).toEqual(["todo"]);
    expect(ids("draw architecture")).toEqual([]);
  });
});

describe("markdown shortcuts", () => {
  let ed: Editor | null = null;
  afterEach(() => {
    ed?.destroy();
    ed = null;
  });
  const typed = (profile: EditorProfile | null, text: string) => {
    setEditorProfile(profile);
    ed = new Editor({ ...withInputRules([...BASE_EXTENSIONS]), content: "<p></p>" });
    const view = ed.view;
    for (const ch of text) {
      const { from, to } = view.state.selection;
      if (!view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)))) view.dispatch(view.state.tr.insertText(ch, from, to));
    }
    return ed.state.doc.firstChild!.type.name;
  };

  it("create a hidden type only when the profile offers it", () => {
    expect(typed(null, "> ")).toBe("blockquote");
    expect(typed(prof("meeting"), "> ")).toBe("paragraph");
    expect(typed(prof("meeting"), "- ")).toBe("bulletList");
    expect(typed(prof("diagramming"), "- ")).toBe("paragraph");
    expect(typed(prof("diagramming"), "## ")).toBe("heading");
  });

  it("never change the extension list (the schema)", () => {
    setEditorProfile(prof("diagramming"));
    const exts = [...BASE_EXTENSIONS];
    expect(withInputRules(exts).extensions).toBe(exts);
  });
});

// ---------- hide, never delete ----------

const V011 = JSON.parse(readFileSync(resolve(process.cwd(), "test-fixtures/v011/schema.json"), "utf8")) as {
  topNode: string;
  nodes: [string, NodeSpec][];
  marks: [string, MarkSpec][];
};
/** Every node type the editor stores (the schema-defining extensions; profiles never change it). */
const schema = new Schema({
  topNode: V011.topNode,
  nodes: Object.fromEntries(
    V011.nodes.map(([name, spec]) => {
      const tag = spec.inline ? "span" : "div";
      return [name, name === "text" ? spec : { ...spec, toDOM: () => (spec.content ? [tag, 0] : [tag]) }];
    }),
  ),
  marks: Object.fromEntries(V011.marks.map(([name, spec]) => [name, { ...spec, toDOM: () => ["span", 0] }])),
});

/** A document with one of every block type, each holding some text where it can. */
function everyBlock(): PMNode {
  const blocks: PMNode[] = [];
  for (const t of Object.values(schema.nodes)) {
    if (!(t.spec.group ?? "").split(" ").includes("block")) continue;
    const n = t.createAndFill();
    if (n) blocks.push(n);
  }
  const filled = blocks.map((b) => {
    let at = -1;
    b.descendants((n, pos) => {
      if (at < 0 && n.isTextblock && n.type.name !== "codeBlock") at = pos + 1;
    });
    if (at < 0) return b;
    const st = EditorState.create({ schema, doc: schema.topNodeType.create(null, [b]) });
    return st.apply(st.tr.insertText("kept", at + 1)).doc.firstChild!;
  });
  return schema.topNodeType.create(null, filled);
}

const names = (d: PMNode) => {
  const s = new Set<string>();
  d.descendants((n) => void s.add(n.type.name));
  return s;
};

describe("hide, never delete", () => {
  const doc = everyBlock();

  it("the test document holds every block type the editor knows", () => {
    const want = Object.values(schema.nodes).filter((t) => (t.spec.group ?? "").includes("block")).map((t) => t.name);
    expect(want.length).toBeGreaterThan(15);
    for (const n of want) expect(names(doc), n).toContain(n);
  });

  it.each(Object.keys(PROFILES))("%s: opens unchanged, stays editable, round-trips losslessly", (p) => {
    setEditorProfile(prof(p));
    const room = new Y.Doc();
    prosemirrorJSONToYXmlFragment(schema, doc.toJSON(), room.getXmlFragment("content"));
    const before = yXmlFragmentToProsemirrorJSON(room.getXmlFragment("content"));

    // Open it as the editor does (y-prosemirror binding), with this profile in force.
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(room));
    const view = new EditorView(document.createElement("div"), {
      state: EditorState.create({ schema, plugins: [ySyncPlugin(client.getXmlFragment("content"))] }),
    });
    expect(view.state.doc.toJSON()).toEqual(doc.toJSON());
    expect(yXmlFragmentToProsemirrorJSON(client.getXmlFragment("content"))).toEqual(before);

    // Edit inside every top-level block that holds text, hidden types included.
    const firstText = (b: PMNode, off: number) => {
      if (b.isTextblock) return off + 1;
      let at = -1;
      b.descendants((n, pos) => {
        if (at < 0 && n.isTextblock) at = off + 1 + pos + 1;
      });
      return at;
    };
    const targets: { at: number; type: string }[] = [];
    view.state.doc.forEach((b, off) => {
      const at = firstText(b, off);
      if (at >= 0) targets.push({ at, type: b.type.name });
    });
    // Back to front, so earlier positions stay valid.
    for (const t of [...targets].reverse()) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, t.at)).insertText("+"));
    const edited = targets.map((t) => t.type);
    let plus = 0;
    view.state.doc.descendants((n) => void (n.isText && (plus += (n.text!.match(/\+/g) ?? []).length)));
    expect(plus).toBe(edited.length);
    expect(edited).toEqual(expect.arrayContaining(["heading", "codeBlock", "toggle", "callout", "columns", "taskList", "blockquote"]));

    // Round trip: the edited room has every type, and nothing else changed.
    Y.applyUpdate(room, Y.encodeStateAsUpdate(client));
    const after = schema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(room.getXmlFragment("content")));
    expect(names(after)).toEqual(names(doc));
    // Our "+" removed (and the text nodes that held only it), the rest must be identical.
    type J = { text?: string; content?: J[] };
    const strip = (j: J): J => {
      const out: J = { ...j };
      if (out.text) out.text = out.text.replace(/\+/g, "");
      if (out.content) {
        const c = out.content.map(strip).filter((x) => x.text !== "");
        if (c.length) out.content = c;
        else delete out.content;
      }
      return out;
    };
    expect(strip(after.toJSON())).toEqual(strip(doc.toJSON()));
    view.destroy();
    expect(profileStore.get()?.profile).toBe(p);
  });
});
