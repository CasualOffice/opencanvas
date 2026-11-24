// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Add your own icon (DGM-17, ADR-057): the editor's side of `POST /v1/icons`. The server cleans
// every file and writes the document's `icons` root; the editor never writes that root itself.
import * as Y from "yjs";
import { IconError, type IconApi, type IconCheck } from "@opencanvas/ui";

const enc = encodeURIComponent;

async function call<T>(url: string, init: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch {
    throw new IconError("network", "The server could not be reached. Check the connection and try again.");
  }
  const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  if (!r.ok) {
    const err = (j?.error ?? {}) as { code?: string; message?: string };
    throw new IconError(String(j?.code ?? err.code ?? r.status), String(j?.message ?? err.message ?? "The server refused the file."));
  }
  return j as T;
}

const file = (f: Blob): RequestInit => ({ method: "POST", body: f, headers: { "Content-Type": "application/octet-stream" } });
const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

/** Icons through the server for a session ticket. */
export function serverIcons(ticket: string): IconApi {
  const up = (q: string) => `/v1/icons?ticket=${enc(ticket)}${q}`;
  return {
    check: (f) => call<IconCheck>(up("&dryRun=1"), file(f)),
    add: (f, name, keywords) => call<{ id: string }>(up(`&name=${enc(name)}&keywords=${enc(keywords.join(","))}`), file(f)),
    replace: async (id, f) => void (await call(up(`&replace=${enc(id)}`), file(f))),
    rename: async (id, name, keywords) => void (await call(`/v1/icons/${enc(id)}?ticket=${enc(ticket)}`, json({ name, keywords }))),
    remove: async (id) => void (await call(`/v1/icons/${enc(id)}?ticket=${enc(ticket)}`, json({ remove: true }))),
  };
}

/**
 * The demo document (`#demo`) has no room server: the file is still checked by `/v1/icons`
 * (refused with a plain message when there is no server), and the local document stands in for
 * the room the server would write to.
 */
export function demoIcons(doc: Y.Doc, me: { id: string; name: string }): IconApi {
  const check = (f: Blob) => call<IconCheck>("/v1/icons?dryRun=1", file(f)).catch((e) => {
    throw e instanceof IconError && e.code === "network" ? new IconError("no_server", "Adding icons needs the OpenCanvas server.") : e;
  });
  const write = (id: string, fields: Record<string, unknown>) =>
    doc.transact(() => {
      const root = doc.getMap<Y.Map<unknown>>("icons");
      const m = root.get(id) ?? new Y.Map<unknown>();
      for (const [k, v] of Object.entries(fields)) m.set(k, v);
      if (!root.has(id)) root.set(id, m);
    }, "server");
  const data = (c: IconCheck) => c.dataUrl.slice(c.dataUrl.indexOf(",") + 1);
  return {
    check,
    add: async (f, name, keywords) => {
      const c = await check(f);
      const id = `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      write(id, { name, keywords, format: c.format, data: data(c), width: c.width, height: c.height, bytes: c.bytes, by: me.id, byName: me.name, at: new Date().toISOString() });
      return { id };
    },
    replace: async (id, f) => {
      const c = await check(f);
      write(id, { format: c.format, data: data(c), width: c.width, height: c.height, bytes: c.bytes });
    },
    rename: async (id, name, keywords) => write(id, { name, keywords }),
    remove: async (id) => void doc.getMap("icons").delete(id),
  };
}
