// The initial-JS budget swapped StarterKit, @tiptap/extension-link and
// @tiptap/extension-mention for leaner definitions (base.ts, link.ts) whose
// runtime plugins load after first paint (late.ts). The schema must stay
// exactly what those packages produced, or a Y.Doc written by an older client
// would meet unknown or different nodes. This compares the two.
import { describe, expect, it } from "vitest";
import { generateHTML, generateJSON, getSchema, mergeAttributes, type Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import type { Schema } from "@tiptap/pm/model";
import { BASE_EXTENSIONS } from "./base";
import { mentionNode } from "./link";
import { readableOn } from "../lib/color";

const colorFor = () => "#2a5ad7";

// Same options the editor passed before the change.
const reference: Extensions = [
  StarterKit.configure({
    undoRedo: false,
    codeBlock: false,
    heading: { levels: [1, 2, 3] },
    link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" } },
    dropcursor: { width: 3, class: "ProseMirror-dropcursor" },
  }),
  Mention.configure({
    HTMLAttributes: { class: "mention" },
    renderHTML: ({ node }) => {
      const id = String(node.attrs.id ?? "");
      const label = String(node.attrs.label ?? id);
      const p = label.trim().split(/\s+/);
      const ini = ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
      return ["span", mergeAttributes({ class: "mention", "data-type": "mention", "data-id": id, "data-label": label }), ["span", { class: "av", style: `background:${colorFor()};color:${readableOn(colorFor())}`, "aria-hidden": "true" }, ini], label];
    },
    renderText: ({ node }) => "@" + (node.attrs.label ?? node.attrs.id),
  }),
];
const ours: Extensions = [...BASE_EXTENSIONS, mentionNode(colorFor)];

/** Spec without functions' bodies; `allowGapCursor: null` only comes from the Gapcursor extension and means "default". */
function describeSchema(s: Schema) {
  const spec = (x: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) {
      if (k === "allowGapCursor" && v == null) continue;
      if (k === "attrs") out[k] = Object.fromEntries(Object.entries(v as Record<string, { default?: unknown }>).map(([a, d]) => [a, { default: d.default }]));
      else if (k === "parseDOM") out[k] = (v as { tag?: string; style?: string; priority?: number }[]).map((r) => ({ tag: r.tag, style: r.style, priority: r.priority }));
      else if (typeof v === "function") out[k] = "fn";
      else out[k] = v;
    }
    return out;
  };
  return {
    nodes: Object.values(s.nodes).map((n) => ({ name: n.name, spec: spec(n.spec as Record<string, unknown>) })),
    marks: Object.values(s.marks).map((m) => ({ name: m.name, spec: spec(m.spec as Record<string, unknown>) })),
  };
}

const HTML = [
  "<h2>Title</h2>",
  '<p>See <a href="https://example.com/x" title="t">a link</a>, <a href="javascript:alert(1)">bad</a>, <a href="mailto:a@b.c">mail</a>',
  ' and <span data-type="mention" data-id="u1" data-label="Priya Shah">@Priya Shah</span> <strong>bold</strong> <em>i</em> <u>u</u> <s>s</s> <code>c</code></p>',
  "<ul><li><p>one</p></li></ul><ol start=\"3\"><li><p>three</p></li></ol><blockquote><p>q</p></blockquote><hr><p>a<br>b</p>",
].join("");

describe("schema stays identical to StarterKit + extension-link + extension-mention", () => {
  it("has the same node and mark types, order and specs", () => {
    expect(describeSchema(getSchema(ours))).toEqual(describeSchema(getSchema(reference)));
  });

  it("parses and renders HTML the same way", () => {
    const a = generateJSON(HTML, reference);
    const b = generateJSON(HTML, ours);
    expect(b).toEqual(a);
    expect(JSON.stringify(a)).toContain('"href":"https://example.com/x"');
    expect(JSON.stringify(a)).not.toContain("javascript:");
    expect(generateHTML(b, ours)).toEqual(generateHTML(a, reference));
  });
});
