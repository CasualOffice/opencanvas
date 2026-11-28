// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { useEffect, useState } from "react";
import type * as Y from "yjs";
import type { Tone } from "@opencanvas/ui";

export interface Meta {
  title: string;
  icon: string;
  tone: Tone;
  template: string;
  /** LINK-05: the canvas's other names (unlinked mentions, the `[[` picker through search). */
  aliases?: string[];
  /** FTY-02 (docs/05 §2f): the file's type when it is a spreadsheet, whiteboard or database. */
  app?: string;
}

export const metaMap = (doc: Y.Doc) => doc.getMap<unknown>("meta");

const aliasesOf = (v: unknown): string[] | undefined => {
  const list = Array.isArray(v) ? v : v && typeof (v as { toArray?: unknown }).toArray === "function" ? (v as { toArray(): unknown[] }).toArray() : null;
  if (!list) return undefined;
  const out = [...new Set(list.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 100)).filter(Boolean))].slice(0, 8);
  return out.length ? out : undefined;
};

function read(doc: Y.Doc): Meta {
  const m = metaMap(doc);
  return {
    title: String(m.get("title") ?? ""),
    app: typeof m.get("app") === "string" ? (m.get("app") as string) : undefined,
    icon: String(m.get("icon") ?? "file-text"),
    tone: (m.get("tone") as Tone) ?? "gray",
    template: String(m.get("template") ?? ""),
    aliases: aliasesOf(m.get("aliases")),
  };
}

export function useMeta(doc: Y.Doc): Meta {
  const [meta, setMeta] = useState(() => read(doc));
  useEffect(() => {
    const m = metaMap(doc);
    const f = () => setMeta(read(doc));
    m.observe(f);
    f();
    return () => m.unobserve(f);
  }, [doc]);
  return meta;
}

/** Origin of title / icon / colour changes a person makes: the editor's undo tracks it. */
export const META_ORIGIN = { source: "opencanvas-meta" };

/** `origin` null = a change the app makes on its own (first-open title), which undo must not revert. */
export function setMeta(doc: Y.Doc, patch: Partial<Meta>, origin: unknown = META_ORIGIN) {
  const m = metaMap(doc);
  doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) if (m.get(k) !== v) m.set(k, v);
  }, origin);
}

/** Last time the content changed (any author), for the header meta row. */
export function useLastEdit(doc: Y.Doc): number | null {
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    let t = 0;
    const f = () => {
      const now = Date.now();
      if (now - t > 5000) {
        t = now;
        setAt(now);
      }
    };
    doc.on("update", f);
    return () => doc.off("update", f);
  }, [doc]);
  return at;
}

export function rel(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "";
  const s = Math.round((now - ms) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useTick(ms = 15000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setN((x) => x + 1), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return n;
}
