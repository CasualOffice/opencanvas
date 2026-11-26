// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Launch flow (docs/15 §2) and the collaboration socket (docs/15 §3).
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { Awareness } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { Role } from "@opencanvas/ui";
import { setInstalledBlocks, type BlockPackage } from "../ext/model";
import { setEditorProfile, setInsertScope, type EditorProfile } from "../editor/profile";
import { setLiveCfg, type LiveCfg } from "../live/state";
import { FROM_DEVICE, PendingLog, REPLAY_PER_SEC, replayFrames, type PendingEntry } from "../offline/pending";
import { MESSAGE_SUBDOC, PartsClient, type PartHeader } from "./parts";
import { fetchBusy } from "./busy";

/** The session answer's `offline` member (OFF-01, docs/15 §6). */
export interface OfflineInfo {
  enabled: boolean;
  allowed: boolean;
  gen?: number;
  reason?: string;
  maxDays?: number;
  autoRecent?: number;
  limits?: { maxCanvases: number; maxMb: number; uploadsMb: number; uploadsFiles: number; unsentMb: number };
  key?: JsonWebKey;
  role?: Role;
  exp?: number;
  grant?: string;
}

export interface Session {
  ticket: string;
  room: string;
  role: Role;
  user: { id: string; name: string; color: string; avatar: string | null; detail?: string };
  file: { id: string; name: string };
  host: { id: string; name: string };
  perms: { export?: boolean; download?: boolean; comment?: boolean; commitMessage?: boolean; mention?: boolean; history?: boolean; restore?: boolean };
  /** docs/30 §3, ADR-055: version history here: `full` (listed in the editor), `link` (the host's own page), `none`. */
  history?: "full" | "link" | "none";
  /** The list shown first: the host's versions or the in-file history. */
  historySource?: "host" | "file";
  /** The panel footer's "Kept by <name>". */
  historyHostName?: string;
  /** `link` mode: the host's version page, or post `UI_FileVersions` to the host when `historyPostMessage`. */
  historyUrl?: string | null;
  historyPostMessage?: boolean;
  isNew: boolean;
  /** docs/05 §8a: "ephemeral" = a temporary canvas (no host storage, deleted when the room closes). */
  storage?: "host" | "ephemeral";
  /** ADR-049: wording of a temporary canvas, from `[host.flags] temporary_wording`. */
  wording?: "meeting" | "room";
  /** ADR-078: `[host.flags] formulas`, adding formula, relation and rollup fields. */
  formulas?: boolean;
  /** `[rooms] max_doc_bytes`: the document size limit (DGM-14 S9 size budget). */
  maxDocBytes?: number;
  wsUrl: string;
  /** Local-only review mode (`#demo`). No server, no host. */
  demo?: boolean;
  /** docs/24 §10: the host's AI flag for this session, when the server sends it. */
  ai?: { enabled?: boolean; modes?: string[] } | null;
  /** docs/23 PERM-07: when the session ends (seconds since the epoch). */
  exp?: number | null;
  /** docs/23 FC-10: what the host lets this person import (empty or absent: no import). */
  import?: { formats?: string[] } | null;
  /** UNF-01: link cards may ask the server for previews. */
  unfurl?: boolean;
  /** TPL-01: the host's `team_templates` flag (the gallery's "From your team" section). */
  templates?: { team?: boolean } | null;
  /** SRCH-04 (ADR-065): "Search all canvases" only when the host answers `GET /search`. */
  search?: { enabled?: boolean } | null;
  /** AUTO-06 (ADR-067): the automation panel; `canEdit` = edit access and perms.automate. */
  automation?: { enabled?: boolean; canEdit?: boolean; history?: boolean; limits?: import("../automation/model").Limits } | null;
  /** BSDK-01: the SDK block packages this host enables (docs/15 §2). */
  blocks?: BlockPackage[];
  /** EDP-01: the host's editor profile, insertable blocks and feature switches (docs/15 §2). */
  editor?: EditorProfile | null;
  /** LIVE-03: live blocks here (`enabled`), "Make live" and the host picker (docs/15 §2). */
  live?: Partial<LiveCfg> | null;
  /** OFF-01: offline copies for this host and launch. */
  offline?: OfflineInfo;
  /** OFF-03: opened from the device copy, without a launch (no ticket yet). */
  openedOffline?: boolean;
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
  // RLB-01b: a server recovering rooms answers 503 + Retry-After; wait it out (the loading
  // screen stays), never an error screen for that.
  const r = await fetchBusy(`/v1/sessions/${encodeURIComponent(ticket)}`, { headers: { Accept: "application/json" } });
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
  const s = (await r.json()) as Session;
  setInstalledBlocks(s.blocks);
  setEditorProfile(s.editor);
  setLiveCfg(s.live);
  // INS-01: Recent is kept per host and person, in this browser only.
  setInsertScope(`${s.host?.id ?? "host"}:${s.user?.id ?? "me"}`);
  return s;
}

// ---------- control channel (message type 100) ----------

export type Control =
  | { t: "saving" }
  /** AUTO-06 frame 3a: a rule ran because of this person's change (`automation-undo` reverts it). */
  | { t: "automation-ran"; runId: string; ruleId: string; text: string }
  /** docs/21 revision 2: the canvas's member list changed (someone's access was revoked). */
  | { t: "members" }
  | { t: "saved"; at: number; version?: string }
  | { t: "save_error"; retryInMs?: number; message?: string }
  /** docs/15 §3: `copy` → a copy was saved to the host (`fileId`, `url`) and the room is read-only;
   *  `reload` → `closed` and close 1012 follow, and the client must start over from the server. */
  | { t: "conflict"; policy?: "copy" | "reload"; fileId?: string; url?: string }
  | { t: "role"; role: Role }
  /** VH-01b: someone restored a version (docs/15 §3). */
  | { t: "restored"; by: string; byName?: string; from: string; name?: string; at: number; restoreId: string }
  | { t: "closed"; reason?: string }
  /** Heartbeat, every 10 s (docs/15 §3). Nothing to do: any frame resets the silence timer. */
  | { t: "ping" }
  /** OFF-04 (ADR-064): the checkpoint before an offline merge was saved (or refused). */
  | { t: "offline_checkpoint"; version?: string; error?: string }
  /** OFF-07: a collaborator's long offline session is arriving (the toast, frame 4e). */
  | { t: "offline_arrived"; by: string; byName?: string; changes?: number }
  /** PSYNC-02/03: the room is split; these blocks are subdocuments (docs/15 §3.2). */
  | { t: "parts"; parts: PartHeader[] }
  /** PSYNC-02: a subdocument request was refused. */
  | { t: "sub-denied"; id: string; reason?: string };

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
  /** PSYNC-03: the room's parts (databases and boards as subdocuments); `null` in the demo. */
  parts: PartsClient | null;
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
  /** OFF-02/04: the local changes the server may not have yet. */
  pending: PendingLog;
  /** OFF-04: stop reconnecting on our own (every reconnect is a fresh launch, ADR-064). */
  pause(): void;
  /** OFF-04: connect with `ticket` and replay the unsent changes in frames. */
  resume(ticket: string, replay?: ReplayOpts): Promise<ReplayResult>;
  destroy(): void;
}

export interface ReplayOpts {
  /** Ask for a checkpoint version first (over 10 minutes or 200 changes). */
  checkpoint?: { changes: number; since: number } | null;
  onProgress?(sent: number, total: number): void;
}

export interface ReplayResult {
  frames: number;
  /** The server refused a frame (role, validation, limits). */
  refused: boolean;
  checkpoint?: string | null;
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

/** ADR-077: presence goes out at most every 100 ms (latest state wins). */
export const PRESENCE_MS = 100;

/**
 * PERF-11 (STORM, docs/36 §4.1): full jitter before each reconnect, 0–5 s at first, the
 * ceiling doubling to 60 s, so a restarted server is not hit by every client at once.
 */
export function reconnectDelay(attempt: number, r = Math.random()): number {
  return r * Math.min(60000, 5000 * 2 ** Math.min(attempt, 4));
}

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

/**
 * Coalesces outgoing frames. y-websocket sends one frame per Yjs transaction and
 * one per awareness change, so a fast typist or a held key (doc update + caret
 * per keystroke) can pass the server's 60 frames/s limit and get disconnected
 * (docs/15 §3). Awareness is meant to stay ≤ 20 Hz anyway (docs/06 §2).
 * The first change in a quiet period goes out at once (no added latency);
 * changes inside the next `ms` are merged into one frame at its end.
 */
export function throttleOutgoing(provider: WebsocketProvider, ms = 50, presenceMs = PRESENCE_MS) {
  const p = provider as unknown as {
    _updateHandler: (u: Uint8Array, origin: unknown) => void;
    _awarenessUpdateHandler: (c: AwarenessChange, origin: unknown) => void;
  };
  const sendDoc = p._updateHandler;
  const sendAwareness = p._awarenessUpdateHandler;
  provider.doc.off("update", sendDoc);
  provider.awareness.off("update", sendAwareness);

  const lane = (send: () => void, ms: number) => {
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
  }, ms);
  const clients = new Set<number>();
  const awLane = lane(() => {
    if (!clients.size) return;
    const changed = [...clients];
    clients.clear();
    sendAwareness({ added: [], updated: changed, removed: [] }, null);
  }, presenceMs);

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

const EMPTY_UPDATE = Y.encodeStateAsUpdate(new Y.Doc());
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** Connects the Y.Doc to the room over the stock y-websocket protocol. `doc`: an existing
 *  document (an offline copy); `connect: false` waits for `resume` (opened offline). */
export function connectCollab(s: Session, opts: { doc?: Y.Doc; connect?: boolean } = {}): Collab {
  const doc = opts.doc ?? new Y.Doc();
  const control = new Emitter<Control>();
  const conn = new Emitter<ConnState>();
  const denied = new Emitter<string>();
  const terminal = new Emitter<{ code: number; reason: string }>();
  // After a `reload` conflict the room holds the host's version: reconnecting this Y.Doc would
  // merge stale local state back in, so the 1012 that follows is terminal too.
  let reloading = false;
  const provider = new WebsocketProvider(s.wsUrl, s.room, doc, {
    // `caps=ext`: this editor keeps SDK blocks (BSDK-02); the server refuses an update that
    // removes one from a connection without it (an editor older than 0.2).
    // `caps=live`: it keeps `liveBlock` and `blockRef` too (LIVE-02, an editor older than 0.3).
    // `caps=subdoc`: it loads databases and boards as subdocuments (PSYNC-03, docs/15 §3.2); a
    // split room closes editors without it with 4426.
    params: { ticket: s.ticket, caps: "ext,live,subdoc" },
    maxBackoffTime: 10000,
    connect: opts.connect !== false,
    shouldReconnect: (e: CloseEvent) => {
      if (isTerminalClose(e.code, e.reason, reloading)) return false;
      // y-websocket would retry after 100 ms with no jitter: hold it and come back after a
      // full-jitter delay instead (STORM).
      holdReconnect();
      return true;
    },
  });
  let reconnectTimer: number | undefined;
  let reconnects = 0;
  function holdReconnect() {
    provider.shouldConnect = false;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      provider.connect();
    }, reconnectDelay(reconnects++));
  }
  const resumeNow = () => {
    if (reconnectTimer === undefined) return false;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    provider.connect();
    return true;
  };
  const disconnectProvider = provider.disconnect.bind(provider);
  provider.disconnect = () => {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    disconnectProvider();
  };
  provider.on("sync", (ok: boolean) => {
    if (ok) reconnects = 0;
  });
  throttleOutgoing(provider);
  // OFF-02: every local change waits in the unsent log until a save that started after it
  // went out confirms it.
  const pending = new PendingLog();
  type Run = { opts: ReplayOpts; answered: boolean; done(r: ReplayResult): void; fail(e: Error): void; refused: boolean };
  let replay: Run | null = null;
  doc.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin === provider || origin === FROM_DEVICE) return;
    const live = provider.wsconnected && provider.synced && !replay;
    pending.add(u, Date.now(), live ? Date.now() + 60 : undefined);
  });
  let savingAt: number | null = null;
  // OFF-04: the first SyncStep1 after `resume` is answered with an empty step 2; the unsent
  // changes then go out in frames of at most MAX_CHUNK, REPLAY_PER_SEC a second, each checked
  // by the server like typing.
  const syncHandler = provider.messageHandlers[0];
  provider.messageHandlers[0] = (encoder, decoder, prov, emitSynced, mt) => {
    if (replay && !replay.answered) {
      const peek = decoding.clone(decoder);
      if (decoding.readVarUint(peek) === 0) {
        const sv = decoding.readVarUint8Array(peek);
        decoder.pos = peek.pos;
        replay.answered = true;
        encoding.writeVarUint(encoder, 0);
        encoding.writeVarUint(encoder, 1);
        encoding.writeVarUint8Array(encoder, EMPTY_UPDATE);
        void runReplay(replay, sv);
        return;
      }
    }
    syncHandler(encoder, decoder, prov, emitSynced, mt);
  };
  const sendUpdate = (u: Uint8Array) => {
    const ws = provider.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("closed");
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    encoding.writeVarUint(enc, 2);
    encoding.writeVarUint8Array(enc, u);
    ws.send(encoding.toUint8Array(enc));
  };
  const waitControl = (t: string, ms: number) =>
    new Promise<Control | null>((resolve) => {
      const off = control.on((c) => {
        if (c.t !== t) return;
        window.clearTimeout(timer);
        off();
        resolve(c);
      });
      const timer = window.setTimeout(() => (off(), resolve(null)), ms);
    });
  async function runReplay(r: Run, sv: Uint8Array) {
    try {
      const entries: PendingEntry[] = pending.entries.slice();
      let checkpoint: string | null = null;
      if (r.opts.checkpoint) {
        sendControlRaw({ t: "offline_merge", changes: r.opts.checkpoint.changes, since: r.opts.checkpoint.since });
        const c = (await waitControl("offline_checkpoint", 20_000)) as { version?: string } | null;
        checkpoint = c?.version ?? null;
      }
      const diff = Y.encodeStateAsUpdate(doc, sv);
      const frames = replayFrames(diff, entries);
      for (let i = 0; i < frames.length; i++) {
        sendUpdate(frames[i]);
        r.opts.onProgress?.(i + 1, frames.length);
        if (i + 1 < frames.length) await sleep(1000 / REPLAY_PER_SEC);
      }
      if (entries.length) pending.markSent(entries[entries.length - 1].id);
      replay = null;
      r.done({ frames: frames.length, refused: r.refused, checkpoint });
    } catch (e) {
      replay = null;
      r.fail(e as Error);
    }
  }
  provider.on("closed", (e: { code: number; reason: string }) => {
    if (isTerminalClose(e.code, e.reason, reloading)) terminal.emit(e);
  });
  // The server rewrites `user` from the grant (id, name, color, avatar), so the role travels beside it.
  provider.awareness.setLocalState({ user: { id: s.user.id, name: s.user.name, color: s.user.color }, role: s.role });

  // PSYNC-03: the room's parts, over type 101 on this socket.
  const parts = new PartsClient(s.file.id, {
    send(frame) {
      const ws = provider.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(frame);
      return true;
    },
    sendControl: (m) => sendControlRaw(m),
  });
  provider.messageHandlers[MESSAGE_SUBDOC] = (_enc, dec) => {
    try {
      parts.handle(dec);
    } catch (e) {
      console.warn("bad subdocument frame", e);
    }
  };
  provider.on("sync", (ok: boolean) => {
    if (ok) parts.resync();
  });

  provider.messageHandlers[MESSAGE_CONTROL] = (_enc, dec) => {
    try {
      const c = JSON.parse(decoding.readVarString(dec)) as Control;
      if (c.t === "parts") parts.setParts(c.parts);
      if (c.t === "conflict" && c.policy === "reload") reloading = true;
      if (c.t === "saving") savingAt = Date.now();
      else if (c.t === "saved" && savingAt !== null) pending.confirmBefore(savingAt);
      control.emit(c);
    } catch (e) {
      console.warn("bad control frame", e);
    }
  };
  provider.messageHandlers[MESSAGE_AUTH] = (_enc, dec) => {
    // [2, 0 = permission denied, reason]
    const kind = decoding.readVarUint(dec);
    if (kind === 0) {
      const reason = decoding.readVarString(dec);
      // During a replay the offline controller reports it (merge summary) instead.
      if (replay) replay.refused = true;
      else denied.emit(reason);
    }
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
    if (status !== "connected") savingAt = null;
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
    if (resumeNow()) return;
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

  function sendControlRaw(msg: Record<string, unknown>) {
    const ws = provider.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_CONTROL);
    encoding.writeVarString(enc, JSON.stringify(msg));
    ws.send(encoding.toUint8Array(enc));
  }

  return {
    doc,
    awareness: provider.awareness,
    provider,
    parts,
    synced,
    pending,
    sendControl: sendControlRaw,
    pause() {
      provider.disconnect();
    },
    resume(ticket, ropts = {}) {
      provider.params.ticket = ticket;
      const p = new Promise<ReplayResult>((done, fail) => {
        replay = { opts: ropts, answered: false, done, fail, refused: false };
      });
      if (provider.wsconnected || provider.wsconnecting) provider.disconnect();
      provider.connect();
      return p;
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
      parts.destroy();
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
    parts: null,
    synced: Promise.resolve(),
    pending: new PendingLog(),
    pause: () => undefined,
    resume: () => Promise.resolve({ frames: 0, refused: false }),
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
