// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The editor's link routes (LINK-03/04/05, ADR-081): every answer is what this session's person
// may see; nothing here is cached beyond the session's memory.
import type { Backlinks, Mention, Preview, Target } from "./model";
import type { LinkInfo } from "../editor/canvaslink";

export interface Hit {
  fileId: string;
  title: string;
  path?: string | null;
  updatedAt?: string | null;
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let code = "";
    try {
      code = ((await r.json()) as { code?: string }).code ?? "";
    } catch {
      /* no body */
    }
    throw Object.assign(new Error(code || `HTTP ${r.status}`), { status: r.status, code });
  }
  return (await r.json()) as T;
}

const q = (o: Record<string, string | number | undefined | null>) =>
  Object.entries(o)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

export const api = (ticket: string) => ({
  backlinks: (o: { block?: string | null; kind?: string; cursor?: string | null } = {}) =>
    fetch(`/v1/backlinks?${q({ ticket, block: o.block, kind: o.kind === "all" ? undefined : o.kind, cursor: o.cursor })}`).then((r) => json<Backlinks>(r)),
  mentions: (names: string[]) =>
    fetch(`/v1/backlinks/mentions?${q({ ticket, names: names.join("|") })}`).then((r) => json<{ available: boolean; items: Mention[] }>(r)),
  resolve: (targets: { fileId: string; block?: string }[]) =>
    fetch("/v1/links/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket, targets: targets.map((t) => ({ fileId: t.fileId, blockId: t.block })) }),
    }).then((r) => json<{ items: (LinkInfo & { fileId: string; blockId: string | null })[] }>(r)),
  targets: (fileId: string) => fetch(`/v1/links/targets?${q({ ticket, fileId })}`).then((r) => json<{ fileId: string; title: string; path: string | null; items: Target[] }>(r)),
  preview: (fileId: string, block?: string | null) => fetch(`/v1/links/preview?${q({ ticket, fileId, block })}`).then((r) => json<Preview>(r)),
  search: (text: string) =>
    fetch(`/v1/search?${q({ ticket, q: text, limit: 8 })}`).then((r) => json<{ items: (Hit & { blockId?: string })[] }>(r)),
  link: (m: Mention) =>
    fetch("/v1/backlinks/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket, fileId: m.fileId, blockId: m.blockId ?? undefined, name: m.name }),
    }).then((r) => json<{ fileId: string; blockId: string }>(r)),
  unlink: (fileId: string, blockId: string) =>
    fetch("/v1/backlinks/unlink", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket, fileId, blockId }),
    }).then((r) => json<{ fileId: string }>(r)),
});

export type Api = ReturnType<typeof api>;

/** Canvases opened recently in this browser (the `[[` picker's "Recent", no server state). */
const RECENT = "oc.links.recent";
export function recentCanvases(): Hit[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT) || "[]");
    return Array.isArray(v) ? v.filter((h) => h && typeof h.fileId === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}
export function rememberCanvas(h: Hit) {
  try {
    const list = [h, ...recentCanvases().filter((x) => x.fileId !== h.fileId)].slice(0, 6);
    localStorage.setItem(RECENT, JSON.stringify(list.map(({ fileId, title, path }) => ({ fileId, title, path }))));
  } catch {
    /* storage off */
  }
}
