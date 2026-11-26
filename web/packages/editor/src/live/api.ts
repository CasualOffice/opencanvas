// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The live block routes (docs/15 §6, ADR-070/072): derived sessions, projections, refresh,
// "Make live" and "Who can see this". Every call carries the parent canvas's ticket.
import { bridge } from "../lib/bridge";
import type { Role } from "@opencanvas/ui";

export type Fail = "noaccess" | "gone" | "notembedded" | "limit" | "depth" | "off" | "unsupported" | "network" | "error";

export class LiveError extends Error {
  constructor(public kind: Fail, public code: string, message = code) {
    super(message);
  }
}

const KINDS: Record<string, Fail> = {
  LIVE_NO_ACCESS: "noaccess",
  LIVE_GONE: "gone",
  LIVE_NOT_EMBEDDED: "notembedded",
  LIVE_LIMIT: "limit",
  RATE_LIMITED: "limit",
  LIVE_DEPTH: "depth",
  LIVE_OFF: "off",
  LIVE_CREATE_UNSUPPORTED: "unsupported",
  BLOCK_NOT_FOUND: "gone",
};

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(path, { ...init, headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) } });
  } catch {
    throw new LiveError("network", "NETWORK");
  }
  if (r.ok || r.status === 304) return r;
  let code = "HTTP_" + r.status;
  let message = code;
  try {
    const j = await r.json();
    code = j?.error?.code ?? code;
    message = j?.error?.message ?? code;
  } catch {
    /* not json */
  }
  throw new LiveError(KINDS[code] ?? (r.status >= 500 ? "network" : "error"), code, message);
}

const ticket = () => bridge.session?.ticket ?? "";
const post = (path: string, body: object, headers: Record<string, string> = {}) => call(path, { method: "POST", body: JSON.stringify({ ticket: ticket(), ...body }), headers });

export interface LiveSession {
  ticket: string;
  room: string;
  fileId: string;
  role: Role;
  name: string;
  exp: number;
  wsUrl: string;
  maxOpen: number;
}

export async function openSession(fileId: string): Promise<LiveSession> {
  return (await post("/v1/live/session", { fileId })).json();
}

export interface Projection {
  access: Role;
  name: string;
  fileId: string;
  blockId: string | null;
  rev: string;
  doc: { type: "doc"; content?: unknown[]; databases?: Record<string, unknown>; boards?: Record<string, unknown> };
  markdown: string;
  live: boolean;
  /** When this copy was fetched (ms). */
  at: number;
}

const projections = new Map<string, Projection>();
const pkey = (fileId: string, blockId?: string | null) => fileId + "\u0000" + (blockId ?? "");

/** The last projection this page saw (the "copy from 10:42" of frame 5b). */
export const lastProjection = (fileId: string, blockId?: string | null) => projections.get(pkey(fileId, blockId));

/** `GET /v1/live/projection`: `changed` false when the ETag still matches (304). */
export async function projection(fileId: string, blockId?: string | null): Promise<{ p: Projection; changed: boolean }> {
  const prev = projections.get(pkey(fileId, blockId));
  const q = new URLSearchParams({ ticket: ticket(), fileId });
  if (blockId) q.set("blockId", blockId);
  const r = await call(`/v1/live/projection?${q}`, { headers: prev ? { "If-None-Match": `"${prev.rev}"` } : {} });
  if (r.status === 304 && prev) {
    prev.at = Date.now();
    return { p: prev, changed: false };
  }
  const p = { ...(await r.json()), at: Date.now() } as Projection;
  projections.set(pkey(fileId, blockId), p);
  return { p, changed: !prev || prev.rev !== p.rev };
}

/** `POST /v1/live/refresh {blockId}` (edit role): the server writes what the snapshot policy
 *  keeps (the title, or the content) into the node, for this person. Errors are quiet. */
export async function refreshNode(blockId: string): Promise<void> {
  if (bridge.session?.role !== "edit") return;
  // The node reaches the server with the next frame; give it a moment, then try twice.
  for (const wait of [400, 1500]) {
    await new Promise((r) => setTimeout(r, wait));
    try {
      await post("/v1/live/refresh", { blockId });
      return;
    } catch (e) {
      if (!(e instanceof LiveError) || e.code !== "BLOCK_NOT_FOUND") return;
    }
  }
}

export async function makeLive(blockIds: string[], name: string, key: string): Promise<{ liveFileId: string; blockId: string; kind: string }> {
  return (await post("/v1/live/make", { blockIds, name }, { "Idempotency-Key": key })).json();
}

export interface Audience {
  role: Role | "none";
  cannotOpen: number | null;
  members: number;
}

export async function audience(fileId: string): Promise<Audience> {
  const q = new URLSearchParams({ ticket: ticket(), fileId });
  return (await call(`/v1/live/audience?${q}`)).json();
}
