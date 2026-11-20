// A compact block vocabulary used by templates and the demo document. It is
// turned into Tiptap JSON (node names per docs/15 §4) when applied to a Y.Doc,
// and rendered as skeleton thumbnails in the template gallery.
import type { JSONContent } from "@tiptap/core";
import type * as Y from "yjs";
import { createDatabase, type DbPreset as DatabasePreset } from "@opencanvas/database";
import { createBoard, type BoardPreset } from "@opencanvas/board";
import type { Tone } from "@opencanvas/ui";

export type DbPreset = DatabasePreset;
export type BdPreset = BoardPreset;

export type TB =
  | { k: "p" | "h1" | "h2" | "h3" | "quote"; html: string }
  | { k: "bul" | "num"; items: string[] }
  | { k: "todo"; items: { t: string; done?: boolean; who?: string; due?: string }[] }
  | { k: "callout"; tone: Tone; icon: string; html: string }
  | { k: "divider" }
  | { k: "code"; lang: string; text: string }
  | { k: "toggle"; title: string; body: string[]; open?: boolean }
  | { k: "db"; preset: DbPreset; view?: string }
  | { k: "board"; preset: BdPreset }
  | { k: "image"; caption: string; art?: "flow" | "ui" }
  | { k: "link"; url: string; title: string; desc: string; site: string }
  | { k: "embed"; provider: string; url: string; title: string }
  | { k: "file"; name: string; size: number; mime: string }
  | { k: "cols"; cols: { h: string; items: string[] }[] }
  | { k: "table"; rows: string[][] };

export const P = (html = ""): TB => ({ k: "p", html });
export const H1 = (html = ""): TB => ({ k: "h1", html });
export const H2 = (html = ""): TB => ({ k: "h2", html });
export const H3 = (html = ""): TB => ({ k: "h3", html });
export const QUOTE = (html = ""): TB => ({ k: "quote", html });
export const BUL = (items: string[]): TB => ({ k: "bul", items });
export const NUM = (items: string[]): TB => ({ k: "num", items });
export const TODO = (items: (string | [string, boolean?, (string | null)?, (string | null)?])[]): TB => ({
  k: "todo",
  items: items.map((x) => (typeof x === "string" ? { t: x } : { t: x[0], done: !!x[1], who: x[2] ?? undefined, due: x[3] ?? undefined })),
});
export const CALL = (tone: Tone, icon: string, html: string): TB => ({ k: "callout", tone, icon, html });
export const DIV = (): TB => ({ k: "divider" });
export const CODE = (lang: string, text: string): TB => ({ k: "code", lang, text });
export const TOG = (title: string, body: string[]): TB => ({ k: "toggle", title, body });
export const DB = (preset: DbPreset, view?: string): TB => ({ k: "db", preset, view });
export const BOARD = (preset: BdPreset): TB => ({ k: "board", preset });
export const IMG = (caption: string, art: "flow" | "ui" = "flow"): TB => ({ k: "image", caption, art });
export const LINK = (url: string, title: string, desc: string, site: string): TB => ({ k: "link", url, title, desc, site });
export const EMBED = (provider: string, url: string, title: string): TB => ({ k: "embed", provider, url, title });
export const FILE = (name: string, size: number, mime: string): TB => ({ k: "file", name, size, mime });
export const COLS = (...cols: { h: string; items: string[] }[]): TB => ({ k: "cols", cols });
export const TABLE = (rows: string[][]): TB => ({ k: "table", rows });

// ---------- inline html → Tiptap JSON ----------

type Mark = { type: string; attrs?: Record<string, unknown> };
const TAG_MARK: Record<string, string> = { b: "bold", strong: "bold", i: "italic", em: "italic", code: "code", mark: "highlight", u: "underline", s: "strike" };

/** Parses the tiny inline markup used by templates: b, i, code, mark, u, s, a, c (comment), @mention. */
export function inline(html: string, people: Record<string, string> = {}): JSONContent[] {
  if (!html) return [];
  const out: JSONContent[] = [];
  const dom = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
  const walk = (n: Node, marks: Mark[]) => {
    if (n.nodeType === 3) {
      const text = n.textContent ?? "";
      if (text) out.push(marks.length ? { type: "text", text, marks: marks.map((m) => ({ ...m })) } : { type: "text", text });
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === "at") {
      const id = el.getAttribute("id") ?? "";
      out.push({ type: "mention", attrs: { id, label: people[id] ?? el.textContent ?? id } });
      return;
    }
    let next = marks;
    if (TAG_MARK[tag]) next = [...marks, { type: TAG_MARK[tag] }];
    else if (tag === "a") next = [...marks, { type: "link", attrs: { href: el.getAttribute("href") } }];
    else if (tag === "c") next = [...marks, { type: "commentMark", attrs: { threadId: el.getAttribute("id") } }];
    el.childNodes.forEach((c) => walk(c, next));
  };
  dom.childNodes.forEach((c) => walk(c, []));
  return out;
}

const para = (html: string, people?: Record<string, string>): JSONContent => {
  const c = inline(html, people);
  return c.length ? { type: "paragraph", content: c } : { type: "paragraph" };
};

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDate(s: string): string {
  const [y, m, d] = s.split("-").map(Number);
  const now = new Date().getFullYear();
  return `${MON[m - 1]} ${d}${y !== now ? ", " + y : ""}`;
}

export interface BuildCtx {
  doc: Y.Doc;
  /** user key → display name, for template mentions */
  people?: Record<string, string>;
  /** who "me" refers to in templates */
  me?: { id: string; name: string };
}

function setView(doc: Y.Doc, id: string, view?: string) {
  if (!view) return;
  const m = doc.getMap("databases").get(id) as Y.Map<unknown> | undefined;
  m?.set("view", view);
}

export function toJSON(b: TB, ctx: BuildCtx): JSONContent {
  const ppl = ctx.people;
  switch (b.k) {
    case "p":
      return para(b.html, ppl);
    case "h1":
    case "h2":
    case "h3":
      return { type: "heading", attrs: { level: Number(b.k[1]) }, content: inline(b.html, ppl) };
    case "quote":
      return { type: "blockquote", content: [para(b.html, ppl)] };
    case "bul":
    case "num":
      return {
        type: b.k === "bul" ? "bulletList" : "orderedList",
        content: (b.items.length ? b.items : [""]).map((i) => ({ type: "listItem", content: [para(i, ppl)] })),
      };
    case "todo":
      return {
        type: "taskList",
        content: (b.items.length ? b.items : [{ t: "" }]).map((it) => {
          const c = inline(it.t, ppl);
          if (it.who) {
            const who = it.who === "me" && ctx.me ? ctx.me : { id: it.who, name: ppl?.[it.who] ?? it.who };
            c.push({ type: "text", text: " " }, { type: "mention", attrs: { id: who.id, label: who.name } });
          }
          if (it.due) c.push({ type: "text", text: (it.who ? " · " : " · ") + "due " + fmtDate(it.due) });
          return { type: "taskItem", attrs: { checked: !!it.done }, content: [c.length ? { type: "paragraph", content: c } : { type: "paragraph" }] };
        }),
      };
    case "callout":
      return { type: "callout", attrs: { tone: b.tone, icon: b.icon }, content: [para(b.html, ppl)] };
    case "divider":
      return { type: "horizontalRule" };
    case "code":
      return { type: "codeBlock", attrs: { language: b.lang }, content: b.text ? [{ type: "text", text: b.text }] : [] };
    case "toggle":
      return {
        type: "toggle",
        attrs: { open: !!b.open },
        content: [
          { type: "toggleSummary", content: inline(b.title, ppl) },
          { type: "toggleContent", content: (b.body.length ? b.body : [""]).map((x) => para(x, ppl)) },
        ],
      };
    case "db": {
      const id = createDatabase(ctx.doc, b.preset);
      setView(ctx.doc, id, b.view);
      return { type: "database", attrs: { dbId: id } };
    }
    case "board":
      return { type: "board", attrs: { boardId: createBoard(ctx.doc, b.preset) } };
    case "image":
      return { type: "image", attrs: { src: artDataUri(b.art ?? "flow"), alt: b.caption, caption: b.caption } };
    case "link":
      return { type: "bookmark", attrs: { url: b.url, title: b.title, description: b.desc, site: b.site } };
    case "embed":
      return { type: "embed", attrs: { provider: b.provider, url: b.url, title: b.title } };
    case "file":
      return { type: "fileAttachment", attrs: { name: b.name, size: b.size, url: "", mime: b.mime } };
    case "cols":
      return {
        type: "columns",
        content: b.cols.map((c) => ({
          type: "column",
          content: [
            { type: "heading", attrs: { level: 3 }, content: inline(c.h, ppl) },
            { type: "bulletList", content: (c.items.length ? c.items : [""]).map((i) => ({ type: "listItem", content: [para(i, ppl)] })) },
          ],
        })),
      };
    case "table":
      return {
        type: "table",
        content: b.rows.map((r, ri) => ({
          type: "tableRow",
          content: r.map((c) => ({ type: ri === 0 ? "tableHeader" : "tableCell", content: [para(c, ppl)] })),
        })),
      };
  }
}

export function buildDoc(blocks: TB[], ctx: BuildCtx): JSONContent {
  const content = blocks.map((b) => toJSON(b, ctx));
  if (!content.length || content[content.length - 1].type !== "paragraph") content.push({ type: "paragraph" });
  return { type: "doc", content };
}

/** Illustrations used by template images, as self-contained SVG data URIs. */
export function artDataUri(kind: "flow" | "ui"): string {
  const bg = "#eef0f4", card = "#ffffff", line = "#d5d8e0", fg = "#9aa0ad";
  let svg: string;
  if (kind === "ui") {
    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400"><rect width="800" height="400" fill="${bg}"/><rect x="120" y="50" width="560" height="300" rx="16" fill="${card}" stroke="${line}"/><rect x="150" y="84" width="200" height="16" rx="8" fill="${fg}" opacity=".6"/><rect x="150" y="116" width="320" height="10" rx="5" fill="${line}"/><rect x="150" y="136" width="280" height="10" rx="5" fill="${line}"/><rect x="150" y="180" width="500" height="130" rx="10" fill="#e6edfd"/><circle cx="400" cy="245" r="26" fill="#2a5ad7" opacity=".7"/></svg>`;
  } else {
    const xs = [60, 215, 370, 525, 680];
    const cs = ["#2a5ad7", "#7a45f0", "#0e9a78", "#e5602a", "#d63f78"];
    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400"><rect width="800" height="400" fill="${bg}"/><path d="M110 200 H700" stroke="${line}" stroke-width="2" stroke-dasharray="4 6"/>${xs
      .map(
        (x, i) =>
          `<g transform="translate(${x} 130)"><rect width="100" height="140" rx="16" fill="${card}" stroke="${line}"/><circle cx="50" cy="52" r="20" fill="${cs[i]}" opacity=".9"/><rect x="22" y="90" width="56" height="8" rx="4" fill="${fg}" opacity=".55"/><rect x="30" y="106" width="40" height="6" rx="3" fill="${line}"/></g>`,
      )
      .join("")}</svg>`;
  }
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
