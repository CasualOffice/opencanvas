// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// "Search all canvases" (SRCH-04, ADR-065): the pieces of the dialog that are not UI. The host
// searches (its index, its permissions); OpenCanvas only shows the answer and keeps recent
// queries in this browser.

export interface Hit {
  fileId: string;
  title: string;
  path?: string;
  blockId?: string;
  snippet: string;
  updatedAt?: string;
}
export interface Answer {
  items: Hit[];
  scopes: { id: string; label: string }[];
  partial: boolean;
  next: string | null;
}
export interface Group {
  fileId: string;
  title: string;
  updatedAt?: string;
  hits: (Hit & { index: number })[];
}

/** Hits grouped by canvas, in the host's order of first appearance; `index` is the flat order. */
export function group(items: Hit[]): Group[] {
  const out: Group[] = [];
  const by = new Map<string, Group>();
  items.forEach((h, index) => {
    let g = by.get(h.fileId);
    if (!g) {
      g = { fileId: h.fileId, title: h.title || "Untitled", updatedAt: h.updatedAt, hits: [] };
      by.set(h.fileId, g);
      out.push(g);
    }
    g.hits.push({ ...h, index });
  });
  // The flat order (arrow keys) follows the groups as shown.
  let i = 0;
  for (const g of out) for (const h of g.hits) h.index = i++;
  return out;
}

/** The snippet as text runs, the query's words marked (the host may send plain snippets). */
export function highlight(snippet: string, q: string): { text: string; hit: boolean }[] {
  const words = q
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length);
  if (!words.length || !snippet) return [{ text: snippet, hit: false }];
  const re = new RegExp(`(${words.join("|")})`, "giu");
  const out: { text: string; hit: boolean }[] = [];
  let last = 0;
  for (const m of snippet.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: snippet.slice(last, at), hit: false });
    out.push({ text: m[0], hit: true });
    last = at + m[0].length;
  }
  if (last < snippet.length) out.push({ text: snippet.slice(last), hit: false });
  return out;
}

/** "Saved 4 min ago", "Saved yesterday", "Saved Nov 24". */
export function savedLabel(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "Saved just now";
  if (s < 3600) return `Saved ${Math.round(s / 60)} min ago`;
  const d = new Date(t);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `Saved ${Math.round(s / 3600)} h ago`;
  const y = new Date(now - 86_400_000);
  if (d.toDateString() === y.toDateString()) return "Saved yesterday";
  return `Saved ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

const RECENT = "oc:search:recent";
export function recents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT) || "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}
export function remember(q: string) {
  const t = q.trim();
  if (!t) return;
  try {
    localStorage.setItem(RECENT, JSON.stringify([t, ...recents().filter((r) => r !== t)].slice(0, 5)));
  } catch {
    /* private mode */
  }
}

/** Reads a server answer defensively (the server normalises the host's). */
export function parseAnswer(v: unknown): Answer {
  const o = (v ?? {}) as Partial<Answer>;
  return {
    items: Array.isArray(o.items) ? o.items.filter((h) => h && typeof h.fileId === "string") : [],
    scopes: Array.isArray(o.scopes) ? o.scopes : [],
    partial: o.partial === true,
    next: typeof o.next === "string" ? o.next : null,
  };
}
