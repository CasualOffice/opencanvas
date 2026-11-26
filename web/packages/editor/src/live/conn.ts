// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Live block rooms (LIVE-02/03): one derived session and socket per live file on the page,
// shared by every block that shows it, opened when a block scrolls into view, at most
// `maxOpen` (8) at once. Others show their projection until a slot frees (frame 5a: no message).
import type { Role } from "@opencanvas/ui";
import { bridge } from "../lib/bridge";
import { connectCollab, type Collab, type Session } from "../lib/session";
import { LiveError, openSession } from "./api";
import { liveCfg } from "./state";

/** `queued`: waiting for a slot; `stale`: could not reach the room (5b); `revoked`: access
 *  removed while open (5f). */
export type LiveState = "queued" | "connecting" | "connected" | "stale" | "noaccess" | "gone" | "revoked";

export interface LiveRoom {
  fileId: string;
  state: LiveState;
  role: Role;
  name: string;
  /** Where the source lives in the host ("Leadership weekly › Q1"), from `/access`, else "". */
  path: string;
  collab: Collab | null;
  session: Session | null;
  /** When the room was last in sync (ms), for "the copy from 10:42". */
  syncedAt: number | null;
}

interface Entry extends LiveRoom {
  users: number;
  visible: number;
  subs: Set<() => void>;
  retry?: number;
  tries: number;
  gen: number;
}

const rooms = new Map<string, Entry>();

const emit = (e: Entry) => e.subs.forEach((f) => f());
const active = () => [...rooms.values()].filter((e) => e.state === "connecting" || e.state === "connected").length;

function set(e: Entry, patch: Partial<LiveRoom>) {
  Object.assign(e, patch);
  emit(e);
}

function close(e: Entry) {
  window.clearTimeout(e.retry);
  e.gen++;
  e.collab?.destroy();
  e.collab = null;
  e.session = null;
}

/** Fills free slots with visible rooms that wait. */
function pump() {
  const max = liveCfg.get().maxOpen;
  for (const e of rooms.values()) {
    if (active() >= max) return;
    if (e.state === "queued" && e.visible > 0) void connect(e);
  }
}

const backoff = (tries: number) => Math.min(30_000, 2000 * 2 ** Math.min(tries, 4));

async function connect(e: Entry) {
  window.clearTimeout(e.retry);
  const gen = ++e.gen;
  set(e, { state: "connecting" });
  try {
    const s = await openSession(e.fileId);
    if (gen !== e.gen) return;
    const parent = bridge.session;
    const session: Session = { ...parent, ticket: s.ticket, room: s.room, role: s.role, file: { id: s.fileId, name: s.name }, wsUrl: s.wsUrl, isNew: false, exp: s.exp };
    const collab = connectCollab(session);
    e.collab = collab;
    e.session = session;
    e.role = s.role;
    e.name = s.name;
    e.path = typeof s.path === "string" ? s.path.slice(0, 200) : "";
    collab.onControl((c) => {
      if (c.t === "role") set(e, { role: c.role });
    });
    collab.onConn((st) => {
      if (gen !== e.gen) return;
      if (st === "connected") set(e, { state: "connected", syncedAt: Date.now() });
      else if (st === "offline") set(e, { state: "stale" });
    });
    collab.onTerminal((t) => {
      if (gen !== e.gen) return;
      // 1008: the host's role API took access away (frame 5f); anything else is "not up to date".
      const revoked = t.code === 1008;
      close(e);
      set(e, { state: revoked ? "revoked" : "stale" });
      if (!revoked) schedule(e);
      pump();
    });
    const ok = await Promise.race([collab.synced.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]);
    if (gen !== e.gen) return;
    if (!ok) throw new LiveError("network", "SYNC_TIMEOUT");
    e.tries = 0;
    set(e, { state: "connected", syncedAt: Date.now() });
  } catch (err) {
    if (gen !== e.gen) return;
    close(e);
    const k = err instanceof LiveError ? err.kind : "network";
    if (k === "noaccess") set(e, { state: "noaccess" });
    else if (k === "gone") set(e, { state: "gone" });
    else {
      // Just inserted: the node reaches the server with the next frame. Limits and outages: later.
      set(e, { state: k === "notembedded" && e.tries < 5 ? "connecting" : "stale" });
      schedule(e, k === "notembedded" && e.tries < 5 ? 600 : undefined);
    }
    pump();
  }
}

function schedule(e: Entry, ms?: number) {
  window.clearTimeout(e.retry);
  const wait = ms ?? backoff(e.tries);
  e.tries++;
  e.retry = window.setTimeout(() => {
    if (e.users > 0 && e.visible > 0 && active() < liveCfg.get().maxOpen) void connect(e);
    else if (e.users > 0) set(e, { state: "queued" });
  }, wait);
}

/** A block shows `fileId`: shared entry, released with the returned function. */
export function useRoomEntry(fileId: string): { room: LiveRoom; sub(f: () => void): () => void; release(): void; visible(v: boolean): void } {
  let e = rooms.get(fileId);
  if (!e) {
    e = { fileId, state: "queued", role: "view", name: "", path: "", collab: null, session: null, syncedAt: null, users: 0, visible: 0, subs: new Set(), tries: 0, gen: 0 };
    rooms.set(fileId, e);
  }
  const entry = e;
  entry.users++;
  let seen = false;
  return {
    room: entry,
    sub(f) {
      entry.subs.add(f);
      return () => void entry.subs.delete(f);
    },
    visible(v) {
      if (v === seen) return;
      seen = v;
      entry.visible += v ? 1 : -1;
      if (v) pump();
    },
    release() {
      if (seen) entry.visible--;
      seen = false;
      entry.users--;
      // Keep the room a moment: an undo or a move re-creates the node view.
      window.setTimeout(() => {
        if (entry.users > 0) return;
        close(entry);
        rooms.delete(fileId);
        pump();
      }, 1500);
    },
  };
}

/** "Retry" and "Refresh": reconnect now. */
export function retryRoom(fileId: string) {
  const e = rooms.get(fileId);
  if (!e) return;
  close(e);
  e.tries = 0;
  set(e, { state: "queued" });
  if (active() < liveCfg.get().maxOpen) void connect(e);
}

/** Test and debug view: the rooms this page holds. */
export const roomStates = () => [...rooms.values()].map((e) => ({ fileId: e.fileId, state: e.state, role: e.role }));
