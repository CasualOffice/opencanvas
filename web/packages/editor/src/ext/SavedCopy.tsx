// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The "last saved copy" of an SDK block (its fallback Markdown), drawn in our type (frames 2a-2c).
// A small reader for the Markdown the templates write: paragraphs, headings, lists, quotes, bold,
// italic and code. Everything becomes React text: no HTML from the document ever reaches the DOM,
// and links show as their text (the saved copy is read only).
import type { ReactNode } from "react";

/** Inline Markdown → React nodes (escapes `\x` → `x`). */
export function inline(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = "";
  let k = 0;
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    const mark = src.startsWith("**", i) ? "**" : c === "*" || c === "_" ? c : c === "`" ? "`" : null;
    if (mark) {
      const end = src.indexOf(mark, i + mark.length);
      if (end > i + mark.length) {
        flush();
        const inner = src.slice(i + mark.length, end);
        out.push(mark === "**" ? <b key={k++}>{inline(inner)}</b> : mark === "`" ? <code key={k++}>{inner}</code> : <em key={k++}>{inline(inner)}</em>);
        i = end + mark.length;
        continue;
      }
    }
    if (c === "[") {
      const m = /^\[([^\]]*)\]\([^)]*\)/.exec(src.slice(i));
      if (m) {
        flush();
        out.push(<span key={k++}>{inline(m[1])}</span>);
        i += m[0].length;
        continue;
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

export function SavedCopy({ md }: { md: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  let k = 0;
  const endPara = () => {
    if (para.length) blocks.push(<p key={k++}>{inline(para.join(" "))}</p>);
    para = [];
  };
  const endList = () => {
    if (list) {
      const items = list.items.map((t, i) => <li key={i}>{inline(t)}</li>);
      blocks.push(list.ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>);
    }
    list = null;
  };
  for (const raw of md.split("\n").slice(0, 400)) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (!line.trim()) {
      endPara();
      endList();
    } else if (bullet || num) {
      endPara();
      const ordered = !!num;
      if (!list || list.ordered !== ordered) {
        endList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? num)![1]);
    } else if (head) {
      endPara();
      endList();
      blocks.push(<p key={k++} className="h">{inline(head[2])}</p>);
    } else if (quote) {
      endPara();
      endList();
      blocks.push(<blockquote key={k++}>{inline(quote[1])}</blockquote>);
    } else {
      endList();
      para.push(line.trim());
    }
  }
  endPara();
  endList();
  return <div className="oc-ext-copy">{blocks}</div>;
}
