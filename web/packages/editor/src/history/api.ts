// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The SPA's history calls (docs/15 §6, VH-01b). The editor never calls the host.
import type { Diff } from "./changes";
import type { Version } from "./group";

export interface HistoryList {
  source: "host" | "file" | null;
  versions: Version[];
  next?: string;
  recent?: Version[];
  hostName?: string;
}

export class HistoryError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

const q = (ticket: string, extra: Record<string, string> = {}) => new URLSearchParams({ ticket, ...extra }).toString();

async function call(url: string, init?: RequestInit): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch {
    throw new HistoryError("NETWORK", "We couldn't reach the canvas server. Check your connection and try again.");
  }
  if (r.ok) return r;
  let code = "HTTP_" + r.status;
  let msg = "";
  try {
    const j = await r.json();
    code = j?.error?.code ?? code;
    msg = j?.error?.message ?? "";
  } catch {
    /* not json */
  }
  throw new HistoryError(code, MESSAGES[code] ?? (msg ? msg.charAt(0).toUpperCase() + msg.slice(1) + "." : "Something went wrong. Try again."), r.status);
}

/** Plain words for the server's codes (docs/15 §6). */
const MESSAGES: Record<string, string> = {
  VERSION_GONE: "This version is no longer kept.",
  VERSION_TOO_LARGE: "This version is too large to open here.",
  DIFF_TOO_LARGE: "These versions differ too much to show the changes.",
  NOTHING_TO_UNDO: "This restore can't be undone any more: someone has edited the restored parts.",
  UNDO_EXPIRED: "The time to undo this restore has passed.",
  HISTORY_FORBIDDEN: "You can't see this canvas's history.",
  HISTORY_OFF: "This canvas keeps no history here.",
  NAME_INVALID: "A name is 1 to 120 characters.",
  CONFLICT: "The canvas is handling a save conflict. Try again in a moment.",
};

/** `known`: the newest save this editor was told about; a list the server cached before it is fetched again. */
export async function listVersions(ticket: string, cursor?: string, known?: string | null): Promise<HistoryList> {
  return (await call(`/v1/history?${q(ticket, { ...(cursor ? { cursor } : {}), ...(known ? { known } : {}) })}`, { headers: { Accept: "application/json" } })).json();
}

/** The version's Yjs state (a v1 update), for the read-only preview. */
export async function versionState(ticket: string, v: string): Promise<Uint8Array> {
  return new Uint8Array(await (await call(`/v1/history/${encodeURIComponent(v)}?${q(ticket)}`)).arrayBuffer());
}

export async function diff(ticket: string, from: string, to: string): Promise<Diff> {
  return (await call(`/v1/history/diff?${q(ticket, { from, to })}`, { headers: { Accept: "application/json" } })).json();
}

const post = (url: string, body?: unknown) => call(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body ?? {}) });

export async function nameVersion(ticket: string, name: string): Promise<{ name: string; version?: string | null }> {
  return (await post(`/v1/history/name?${q(ticket)}`, { name })).json();
}

export async function restoreVersion(ticket: string, v: string, label: string): Promise<{ restoreId: string; name: string; version?: string | null; changed?: number }> {
  return (await post(`/v1/history/${encodeURIComponent(v)}/restore?${q(ticket)}`, { label })).json();
}

export async function undoRestore(ticket: string, restoreId: string): Promise<void> {
  await post(`/v1/history/restore/undo?${q(ticket, { restoreId })}`);
}
