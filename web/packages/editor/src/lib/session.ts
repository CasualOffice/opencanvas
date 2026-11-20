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
  user: { id: string; name: string; color: string; avatar: string | null };
  file: { id: string; name: string };
  host: { id: string; name: string };
  perms: { export?: boolean; download?: boolean; comment?: boolean; commitMessage?: boolean; mention?: boolean };
  isNew: boolean;
  wsUrl: string;
  /** Local-only review mode (`#demo`). No server, no host. */
  demo?: boolean;
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
  | { t: "saved"; at: number; version?: string }
  | { t: "save_error"; retryInMs?: number; message?: string }
  | { t: "conflict" }
  | { t: "role"; role: Role }
  | { t: "closed"; reason?: string };

export const MESSAGE_CONTROL = 100;
// y-protocols auth message (docs/15 §3): [2, 0 = permission denied, reason]
const MESSAGE_AUTH = 2;

export type ConnState = "connecting" | "connected" | "reconnecting" | "offline";

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

/** Connects the Y.Doc to the room over the stock y-websocket protocol. */
export function connectCollab(s: Session): Collab {
  const doc = new Y.Doc();
  const control = new Emitter<Control>();
  const conn = new Emitter<ConnState>();
  const denied = new Emitter<string>();
  const provider = new WebsocketProvider(s.wsUrl, s.room, doc, {
    params: { ticket: s.ticket },
    maxBackoffTime: 10000,
  });
  // The server rewrites `user` from the grant (id, name, color, avatar), so the role travels beside it.
  provider.awareness.setLocalState({ user: { id: s.user.id, name: s.user.name, color: s.user.color }, role: s.role });

  provider.messageHandlers[MESSAGE_CONTROL] = (_enc, dec) => {
    try {
      control.emit(JSON.parse(decoding.readVarString(dec)) as Control);
    } catch (e) {
      console.warn("bad control frame", e);
    }
  };
  provider.messageHandlers[MESSAGE_AUTH] = (_enc, dec) => {
    // [2, 0 = permission denied, reason]
    const kind = decoding.readVarUint(dec);
    if (kind === 0) denied.emit(decoding.readVarString(dec));
  };

  let downSince: number | null = null;
  let offlineTimer: number | undefined;
  provider.on("status", ({ status }: { status: string }) => {
    if (status === "connected") {
      downSince = null;
      window.clearTimeout(offlineTimer);
      conn.emit("connected");
    } else if (status === "disconnected" || status === "connecting") {
      if (downSince === null) {
        downSince = Date.now();
        conn.emit(provider.synced ? "reconnecting" : "connecting");
        offlineTimer = window.setTimeout(() => conn.emit("offline"), 30000);
      }
    }
  });

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
    destroy() {
      window.clearTimeout(offlineTimer);
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
    destroy() {
      awareness.destroy();
      doc.destroy();
    },
    // exposed for the demo simulator
    ...({ _emitControl: (c: Control) => control.emit(c), _emitConn: (c: ConnState) => conn.emit(c) } as object),
  };
}
