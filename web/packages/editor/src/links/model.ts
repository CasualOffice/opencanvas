// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Links and backlinks (LINK-04, ADR-081): the pure parts of the editor side. The server's
// answers, URL patterns for pasted host links, the links a document holds, and the grouping
// the "Linked from" panel shows (prototype docs/prototypes/v05-approved/links-backlinks.html).

export interface Excerpt {
  before: string;
  link: string;
  after: string;
}

export interface BacklinkRef {
  block: string;
  toBlock: string | null;
  toRow: string | null;
  kind: "link" | "embed" | "relation";
  section: string | null;
  excerpt: Excerpt | null;
}

export interface Backlink {
  fileId: string;
  title: string;
  path: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  savedAt: number | null;
  refs: BacklinkRef[];
}

export interface Backlinks {
  fileId: string;
  items: Backlink[];
  total: number;
  /** Per block id (or `h:` anchor) of this canvas: linking canvases the reader can open. */
  blocks: Record<string, number>;
  next: string | null;
}

export interface Mention {
  fileId: string;
  title: string;
  path?: string | null;
  blockId?: string | null;
  snippet?: string | null;
  name: string;
}

export interface Target {
  id: string;
  kind: string;
  text: string;
  level?: number;
  db?: string;
}

export interface Preview {
  fileId: string;
  state: "ok" | "none" | "gone" | "missing";
  title?: string;
  path?: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
  block?: string | null;
  lines?: string[];
}

/** A host URL template (`https://host/f/{fileId}#{blockId}`) as a matcher. */
export function matchHostUrl(patterns: readonly string[], url: string): { fileId: string; blockId?: string } | null {
  const u = url.trim();
  if (!/^https?:\/\//.test(u) || u.length > 4096 || /\s/.test(u)) return null;
  for (const p of patterns) {
    const parts = p.split(/(\{fileId\}|\{blockId\})/);
    let re = "^";
    const names: string[] = [];
    parts.forEach((part, i) => {
      if (part === "{fileId}" || part === "{blockId}") {
        names.push(part === "{fileId}" ? "fileId" : "blockId");
        re += i === parts.length - 2 && parts[i + 1] === "" ? "([^/?#]+)" : "([^/?#]+?)";
      } else re += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });
    re += "(?:[?#].*)?$";
    const m = new RegExp(re).exec(u);
    if (!m) continue;
    const out: { fileId: string; blockId?: string } = { fileId: "" };
    names.forEach((n, i) => {
      let v = m[i + 1];
      try {
        v = decodeURIComponent(v);
      } catch {
        /* keep as is */
      }
      if (n === "fileId") out.fileId = v;
      else out.blockId = v;
    });
    if (out.fileId) return out;
  }
  return null;
}

/** The heading anchor the server uses for a heading without an id (`h:phase-2-enforce-sso`). */
export function headingAnchor(text: string): string {
  const words = text.toLowerCase().trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return ("h:" + words.join("-")).slice(0, 124);
}

interface PMLike {
  type: { name: string };
  attrs: Record<string, unknown>;
  textContent: string;
  descendants(f: (n: PMLike, pos: number) => boolean | void): void;
}

/** The link targets in a ProseMirror document: `fileId` and the block (or row) each points at. */
export function linksIn(doc: PMLike): { fileId: string; block?: string }[] {
  const out: { fileId: string; block?: string }[] = [];
  const seen = new Set<string>();
  doc.descendants((n) => {
    if (n.type.name !== "canvasLink") return;
    const fileId = String(n.attrs.fileId || "");
    if (!fileId) return false;
    const block = (n.attrs.targetBlockId || n.attrs.rowId || undefined) as string | undefined;
    const k = block ? `${fileId}#${block}` : fileId;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(block ? { fileId, block } : { fileId });
    }
    return false;
  });
  return out;
}

/** The ids a block of this canvas answers to in `Backlinks.blocks`: its id and, for a heading,
 *  its anchor. */
export function blockKeys(node: { type: { name: string }; attrs: Record<string, unknown>; textContent: string }): string[] {
  const keys: string[] = [];
  const id = node.attrs.blockId;
  if (typeof id === "string" && id) keys.push(id);
  if (node.type.name === "heading" && node.textContent.trim()) keys.push(headingAnchor(node.textContent));
  return keys;
}

/** "now", "2 h ago", "Nov 24": when a canvas was last edited, from an RFC 3339 time or ms. */
export function when(at: string | number | null | undefined, now = Date.now()): string {
  if (at == null || at === "") return "";
  const t = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 90) return "now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = new Date(t);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-US", opts);
}

export type KindFilter = "all" | "link" | "embed" | "relation";

/** The refs of a group that the filters keep (kind and, when set, the target block). */
export function visibleRefs(b: Backlink, kind: KindFilter, block: string | null): BacklinkRef[] {
  return b.refs.filter((r) => (kind === "all" || r.kind === kind) && (!block || r.toBlock === block));
}

/** "in Identity · to Phase 2" for a reference. `blockName` names this canvas's blocks. */
export function refWhere(r: BacklinkRef, blockName: (id: string) => string | undefined): string {
  const parts: string[] = [];
  if (r.section) parts.push(`in ${r.section}`);
  if (r.toBlock) {
    const n = blockName(r.toBlock);
    if (n) parts.push(`to ${n}`);
  }
  if (r.kind === "embed") parts.push("live block");
  if (r.kind === "relation") parts.push("relation");
  return parts.join(" · ");
}

/** Sorted groups: newest save first (the server's order), or by title. */
export function sortGroups(items: Backlink[], by: "recent" | "title"): Backlink[] {
  if (by === "recent") return items;
  return [...items].sort((a, b) => a.title.localeCompare(b.title));
}
