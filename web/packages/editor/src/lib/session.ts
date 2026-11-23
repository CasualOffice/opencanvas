// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Launch flow (docs/15 §2) and the collaboration socket (docs/15 §3).
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { Awareness } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { Role } from "@opencanvas/ui";

export interface Session {
  ticket: string;
  room: string;
  role: Role;
  user: { id: string; name: string; color: string; avatar: string | null; detail?: string };
  file: { id: string; name: string };
  host: { id: string; name: string };
  perms: { export?: boolean; download?: boolean; comment?: boolean; commitMessage?: boolean; mention?: boolean };
  isNew: boolean;
  /** docs/05 §8a: "ephemeral" = a temporary canvas (no host storage, deleted when the room closes). */
  storage?: "host" | "ephemeral";
  wsUrl: string;
  /** Local-only review mode (`#demo`). No server, no host. */
  demo?: boolean;
  /** docs/24 §10: the host's AI flag for this session, when the server sends it. */
  ai?: { enabled?: boolean; modes?: string[] } | null;
  /** docs/23 PERM-07: when the session ends (seconds since the epoch). */
  exp?: number | null;
  /** docs/23 FC-10: what the host lets this person import (empty or absent: no import). */
  import?: { formats?: string[] } | null;
}

export class SessionError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** Reads `#t=<ticket>` (or `#demo`) from the URL fragment. */
export function readLaunch(): { ticket: string | null; demo: boolean } {
  const h = window.location.hash.replace(/^#/, "");
  const p = new URLSearchParams(h);
  return { ticket: p.get("t"), demo: h === "demo" || p.has("demo") };
}

export async function fetchSession(ticket: string): Promise<Session> {
  const r = await fetch(`/v1/sessions/${encodeURIComponent(ticket)}`, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    let code = "HTTP_" + r.status;
    try {
      const j = await r.json();
      code = j?.error?.code ?? code;
    } catch {
      /* not json */
    }
    throw new SessionError(code, code === "TICKET_INVALID" ? "This link has expired. Open the canvas again from your app." : "We couldn't open this canvas.");
  }
  return (await r.json()) as Session;
}

// ---------- control channel (message type 100) ----------

export type Control =
  | { t: "saving" }
  /** docs/21 revision 2: the canvas's member list changed (someone's access was revoked). */
  | { t: "members" }
  | { t: "saved"; at: number; version?: string }
  | { t: "save_error"; retryInMs?: number; message?: string }
  /** docs/15 §3: `copy` → a copy was saved to the host (`fileId`, `url`) and the room is read-only;
   *  `reload` → `closed` and close 1012 follow, and the client must start over from the server. */
  | { t: "conflict"; policy?: "copy" | "reload"; fileId?: string; url?: string }
  | { t: "role"; role: Role }
  | { t: "closed"; reason?: string }
  /** Heartbeat, every 10 s (docs/15 §3). Nothing to do: any frame resets the silence timer. */
  | { t: "ping" };

export const MESSAGE_CONTROL = 100;
// y-protocols auth message (docs/15 §3): [2, 0 = permission denied, reason]
const MESSAGE_AUTH = 2;

export type ConnState = "connecting" | "connected" | "reconnecting" | "offline";

/** No frame for this long means the connection is gone (the server pings every 10 s). */
export const SILENCE_MS = 15_000;
/** "Reconnecting" → "Offline" after a silent drop or a browser offline event. */
export const OFFLINE_FAST_MS = 3_000;
/** "Reconnecting" → "Offline" for any other outage (server restart, failed reconnects). */
export const OFFLINE_SLOW_MS = 20_000;

export interface Collab {
  doc: Y.Doc;
  awareness: Awareness;
  provider: WebsocketProvider | null;
  /** Resolves when the first sync handshake has completed. */
  synced: Promise<void>;
  sendControl(msg: Record<string, unknown>): void;
  onControl(fn: (c: Control) => void): () => void;
  onConn(fn: (s: ConnState) => void): () => void;
  onDenied(fn: (reason: string) => void): () => void;
  /** The server ended the session for good (close 1000 host closed, 1008 access revoked, or
   *  1012 after a `reload` conflict). The provider does not reconnect. */
  onTerminal(fn: (e: { code: number; reason: string }) => void): () => void;
  /** docs/23 PERM-07: carry on with a renewed ticket (reconnects; local edits stay in the doc). */
  retarget(ticket: string): void;
  destroy(): void;
}

class Emitter<T> {
  private fns = new Set<(v: T) => void>();
  on(fn: (v: T) => void) {
    this.fns.add(fn);
    return () => void this.fns.delete(fn);
  }
  emit(v: T) {
    this.fns.forEach((f) => f(v));
  }
}

/** 1008 closes that are not about access: reconnect instead of ending the session. */
const TRANSIENT_1008 = /rate limit/i;
/** 4429 is the server's rate-limit close (docs/15 §3): always reconnect. */
const RATE_LIMITED = 4429;
const isTerminalClose = (code: number, reason: string, reloading: boolean) =>
  code !== RATE_LIMITED &&
  (code === 1000 || (code === 1008 && !TRANSIENT_1008.test(reason)) || (code === 1012 && reloading) || (code >= 4400 && code < 4500));

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

/**
 * Coalesces outgoing frames. y-websocket sends one frame per Yjs transaction and
 * one per awareness change, so a fast typist or a held key (doc update + caret
 * per keystroke) can pass the server's 60 frames/s limit and get disconnected
 * (docs/15 §3). Awareness is meant to stay ≤ 20 Hz anyway (docs/06 §2).
 * The first change in a quiet period goes out at once (no added latency);
 * changes inside the next `ms` are merged into one frame at its end.
 */
export function throttleOutgoing(provider: WebsocketProvider, ms = 50) {
  const p = provider as unknown as {
    _updateHandler: (u: Uint8Array, origin: unknown) => void;
    _awarenessUpdateHandler: (c: AwarenessChange, origin: unknown) => void;
  };
  const sendDoc = p._updateHandler;
  const sendAwareness = p._awarenessUpdateHandler;
  provider.doc.off("update", sendDoc);
  provider.awareness.off("update", sendAwareness);

  const lane = (send: () => void) => {
    let timer: number | undefined;
    let last = -Infinity;
    const flush = () => {
      window.clearTimeout(timer);
      timer = undefined;
      last = performance.now();
      send();
    };
    return {
      kick() {
        if (timer !== undefined) return;
        const wait = last + ms - performance.now();
        if (wait <= 0) flush();
        else timer = window.setTimeout(flush, wait);
      },
      flushNow() {
        if (timer !== undefined) flush();
      },
    };
  };

  let updates: Uint8Array[] = [];
  const docLane = lane(() => {
    if (!updates.length) return;
    const u = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
    updates = [];
    sendDoc(u, null);
  });
  const clients = new Set<number>();
  const awLane = lane(() => {
    if (!clients.size) return;
    const changed = [...clients];
    clients.clear();
    sendAwareness({ added: [], updated: changed, removed: [] }, null);
  });

  p._updateHandler = (u, origin) => {
    if (origin === provider) return; // came from the server
    updates.push(u);
    docLane.kick();
  };
  p._awarenessUpdateHandler = ({ added, updated, removed }) => {
    for (const c of added.concat(updated, removed)) clients.add(c);
    awLane.kick();
  };
  provider.doc.on("update", p._updateHandler);
  provider.awareness.on("update", p._awarenessUpdateHandler);
  // Don't hold back the last keystrokes when the tab goes away.
  window.addEventListener("pagehide", () => {
    docLane.flushNow();
    awLane.flushNow();
  });
}

/** Connects the Y.Doc to the room over the stock y-websocket protocol. */
export function connectCollab(s: Session): Collab {
  const doc = new Y.Doc();
  const control = new Emitter<Control>();
  const conn = new Emitter<ConnState>();
  const denied = new Emitter<string>();
  const terminal = new Emitter<{ code: number; reason: string }>();
  // After a `reload` conflict the room holds the host's version: reconnecting this Y.Doc would
  // merge stale local state back in, so the 1012 that follows is terminal too.
  let reloading = false;
  const provider = new WebsocketProvider(s.wsUrl, s.room, doc, {
    params: { ticket: s.ticket },
    maxBackoffTime: 10000,
    shouldReconnect: (e: CloseEvent) => !isTerminalClose(e.code, e.reason, reloading),
  });
  throttleOutgoing(provider);
  provider.on("closed", (e: { code: number; reason: string }) => {
    if (isTerminalClose(e.code, e.reason, reloading)) terminal.emit(e);
  });
  // The server rewrites `user` from the grant (id, name, color, avatar), so the role travels beside it.
  provider.awareness.setLocalState({ user: { id: s.user.id, name: s.user.name, color: s.user.color }, role: s.role });

  provider.messageHandlers[MESSAGE_CONTROL] = (_enc, dec) => {
    try {
      const c = JSON.parse(decoding.readVarString(dec)) as Control;
      if (c.t === "conflict" && c.policy === "reload") reloading = true;
      control.emit(c);
    } catch (e) {
      console.warn("bad control frame", e);
    }
  };
  provider.messageHandlers[MESSAGE_AUTH] = (_enc, dec) => {
    // [2, 0 = permission denied, reason]
    const kind = decoding.readVarUint(dec);
    if (kind === 0) denied.emit(decoding.readVarString(dec));
  };

  // ---------- connection state (docs/06 §5) ----------
  // A clean close shows "Reconnecting" at once. A silent drop (Wi-Fi gone, laptop lid, a
  // proxy that stops forwarding) closes nothing, so the server pings every 10 s (docs/15 §3)
  // and SILENCE_MS without any frame counts as a lost connection. After a silent drop or a
  // browser "offline" event, "Offline" follows within OFFLINE_FAST_MS; any other outage
  // shows it after OFFLINE_SLOW_MS.
  let downSince: number | null = null;
  let offlineTimer: number | undefined;
  const goDown = (offlineIn: number) => {
    if (downSince === null) {
      downSince = Date.now();
      conn.emit(provider.synced ? "reconnecting" : "connecting");
    }
    const left = Math.max(0, downSince + offlineIn - Date.now());
    window.clearTimeout(offlineTimer);
    offlineTimer = window.setTimeout(() => downSince !== null && conn.emit("offline"), left);
  };
  provider.on("status", ({ status }: { status: string }) => {
    if (status === "connected") {
      downSince = null;
      window.clearTimeout(offlineTimer);
      conn.emit("connected");
    } else if ((status === "disconnected" || status === "connecting") && downSince === null) {
      goDown(navigator.onLine === false ? OFFLINE_FAST_MS : OFFLINE_SLOW_MS);
    }
  });
  // Drops the socket without waiting for TCP: y-websocket reconnects with backoff.
  const drop = () => {
    goDown(OFFLINE_FAST_MS);
    try {
      provider.ws?.close();
    } catch {
      /* already closing */
    }
  };
  const watchdog = window.setInterval(() => {
    const last = provider.wsLastMessageReceived;
    if (provider.wsconnected && downSince === null && last > 0 && Date.now() - last > SILENCE_MS) drop();
  }, 1000);
  const onOffline = () => provider.wsconnected && drop();
  // Back online: try now instead of waiting out the backoff.
  const onOnline = () => {
    if (!provider.wsconnected && provider.shouldConnect && !provider.ws) provider.connect();
  };
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);

  // Re-announce presence once the handshake completes: an awareness frame sent
  // on socket open can reach the room before this connection is registered.
  provider.on("sync", (ok: boolean) => {
    const st = provider.awareness.getLocalState();
    if (ok && st) provider.awareness.setLocalState({ ...st });
  });

  const synced = new Promise<void>((resolve) => {
    if (provider.synced) resolve();
    else provider.once("sync", (ok: boolean) => ok && resolve());
  });

  return {
    doc,
    awareness: provider.awareness,
    provider,
    synced,
    sendControl(msg) {
      const ws = provider.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_CONTROL);
      encoding.writeVarString(enc, JSON.stringify(msg));
      ws.send(encoding.toUint8Array(enc));
    },
    onControl: (f) => control.on(f),
    onConn: (f) => conn.on(f),
    onDenied: (f) => denied.on(f),
    onTerminal: (f) => terminal.on(f),
    retarget(ticket) {
      provider.params.ticket = ticket;
      provider.disconnect();
      provider.connect();
    },
    destroy() {
      window.clearTimeout(offlineTimer);
      window.clearInterval(watchdog);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      provider.destroy();
      doc.destroy();
    },
  };
}

/** A local-only Collab for `#demo`: same surface, no network. */
export function localCollab(user: Session["user"], role: Role): Collab {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalStateField("user", { id: user.id, name: user.name, color: user.color, role });
  const control = new Emitter<Control>();
  const conn = new Emitter<ConnState>();
  const denied = new Emitter<string>();
  return {
    doc,
    awareness,
    provider: null,
    synced: Promise.resolve(),
    sendControl(msg) {
      // Demo autosave: pretend the server saved shortly after a commit request.
      if (msg.t === "commit") window.setTimeout(() => control.emit({ t: "saved", at: Date.now() }), 400);
    },
    onControl: (f) => control.on(f),
    onConn: (f) => conn.on(f),
    onDenied: (f) => denied.on(f),
    onTerminal: () => () => undefined,
    retarget: () => undefined,
    destroy() {
      awareness.destroy();
      doc.destroy();
    },
    // exposed for the demo simulator
    ...({ _emitControl: (c: Control) => control.emit(c), _emitConn: (c: ConnState) => conn.emit(c) } as object),
  };
}
