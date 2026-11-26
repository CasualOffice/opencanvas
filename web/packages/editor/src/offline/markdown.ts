// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// "Download my version" (frame 5a): the held copy as Markdown, made on the device (the server's
// exports read the room, which no longer has these changes). Text, headings, lists, tasks,
// quotes and code; other blocks keep their text.
import * as Y from "yjs";

const inline = (t: Y.XmlText) =>
  t
    .toDelta()
    .map((d: { insert?: unknown; attributes?: Record<string, unknown> }) => {
      if (typeof d.insert !== "string") return "";
      let s = d.insert;
      if (d.attributes?.bold) s = `**${s}**`;
      if (d.attributes?.italic) s = `*${s}*`;
      if (d.attributes?.code) s = "`" + s + "`";
      return s;
    })
    .join("");

function text(n: Y.XmlElement | Y.XmlText): string {
  if (n instanceof Y.XmlText) return inline(n);
  return n
    .toArray()
    .map((c) => text(c as Y.XmlElement))
    .join("");
}

function block(n: Y.XmlElement | Y.XmlText, indent: string, out: string[]) {
  if (n instanceof Y.XmlText) return void out.push(indent + inline(n));
  const kids = n.toArray() as (Y.XmlElement | Y.XmlText)[];
  switch (n.nodeName) {
    case "heading":
      out.push("#".repeat(Number(n.getAttribute("level")) || 1) + " " + text(n), "");
      return;
    case "paragraph":
      out.push(indent + text(n), "");
      return;
    case "bulletList":
    case "orderedList":
    case "taskList":
      kids.forEach((li, i) => {
        const mark = n.nodeName === "orderedList" ? `${i + 1}.` : n.nodeName === "taskList" ? (li instanceof Y.XmlElement && li.getAttribute("checked") ? "- [x]" : "- [ ]") : "-";
        const sub: string[] = [];
        if (li instanceof Y.XmlElement) for (const c of li.toArray() as Y.XmlElement[]) block(c, "", sub);
        const lines = sub.filter((l) => l !== "");
        out.push(indent + mark + " " + (lines[0] ?? ""), ...lines.slice(1).map((l) => indent + "  " + l));
      });
      out.push("");
      return;
    case "blockquote":
    case "callout": {
      const sub: string[] = [];
      for (const c of kids) block(c, "", sub);
      out.push(...sub.filter((l) => l !== "").map((l) => "> " + l), "");
      return;
    }
    case "codeBlock":
      out.push("```" + ((n.getAttribute("language") as string) ?? ""), text(n), "```", "");
      return;
    case "horizontalRule":
      out.push("---", "");
      return;
    default: {
      if (!kids.length) return;
      for (const c of kids) block(c, indent, out);
    }
  }
}

export function docToMarkdown(doc: Y.Doc): string {
  const title = doc.getMap("meta").get("title");
  const out: string[] = typeof title === "string" && title ? [`# ${title}`, ""] : [];
  for (const n of doc.getXmlFragment("content").toArray() as (Y.XmlElement | Y.XmlText)[]) block(n, "", out);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
