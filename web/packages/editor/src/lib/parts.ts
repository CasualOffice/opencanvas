// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Partial sync, the editor side (PSYNC-03, ADR-076, docs/15 §3.2). A split room sends the
// main document over the ordinary messages and lists its heavy blocks (`{"t":"parts"}`); each
// database or board is a Y.Doc of its own, asked for over message type 101 when its block
// comes near the screen and released two minutes after it leaves it. A part is shaped like the
// whole canvas (root `databases` or `boards` with that one key), so the block views take it as
// their `doc` unchanged.
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";

export const MESSAGE_SUBDOC = 101;
/** A part out of view this long is released (docs/36 §2.2 point 8). */
export const RELEASE_MS = 120_000;

export interface PartHeader {
  id: string;
  kind: "database" | "board";
  name?: string | null;
  count?: number;
}

/** What the parts client needs from the socket. */
export interface PartsTransport {
  /** Sends a binary frame when the socket is open; false when it is not. */
  send(frame: Uint8Array): boolean;
  sendControl(msg: Record<string, unknown>): void;
}

interface Held {
  doc: Y.Doc;
  holders: number;
  /** Pinned (offline copy): never released. */
  pinned: boolean;
  synced: boolean;
  releaseTimer?: ReturnType<typeof setTimeout>;
  um?: Y.UndoManager;
  off(): void;
}

export const blockOf = (guid: string) => guid.slice(guid.indexOf("/block/") + 7);

/** One frame: `[101, guid, <y-protocols sync message>]`. */
export function subFrame(guid: string, inner: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SUBDOC);
  encoding.writeVarString(enc, guid);
  encoding.writeUint8Array(enc, inner);
  return encoding.toUint8Array(enc);
}

export class PartsClient {
  /** True once the room said it is split (a `parts` list arrived). */
  split = false;
  readonly headers = new Map<string, PartHeader>();
  private held = new Map<string, Held>();
  private listeners = new Set<() => void>();
  private undo: CrossDocUndo | null = null;
  private pinEverything = false;

  constructor(
    private fileId: string,
    private transport: PartsTransport,
    private releaseMs = RELEASE_MS,
  ) {}

  guid(blockId: string) {
    return `${this.fileId}/block/${blockId}`;
  }

  /** Is this block a part of the room (load it as one), or still in the main document? */
  isPart(blockId: string) {
    return this.split && this.headers.has(blockId);
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private changed() {
    this.listeners.forEach((f) => f());
  }

  /** The `{"t":"parts"}` control message. */
  setParts(list: PartHeader[]) {
    this.split = true;
    this.headers.clear();
    for (const h of list) this.headers.set(blockOf(h.id), h);
    if (this.pinEverything) this.pinAll();
    this.changed();
  }

  /** The block's document, loaded (or loading); call `release` when the view goes. */
  acquire(blockId: string): Y.Doc {
    let h = this.held.get(blockId);
    if (!h) {
      const doc = new Y.Doc({ guid: this.guid(blockId) });
      const onUpdate = (u: Uint8Array, origin: unknown) => {
        if (origin === this) return;
        const enc = encoding.createEncoder();
        syncProtocol.writeUpdate(enc, u);
        this.transport.send(subFrame(this.guid(blockId), encoding.toUint8Array(enc)));
      };
      doc.on("update", onUpdate);
      h = { doc, holders: 0, pinned: false, synced: false, off: () => doc.off("update", onUpdate) };
      this.held.set(blockId, h);
      this.undo?.attach(doc);
      this.request(blockId, h);
    }
    if (h.releaseTimer) clearTimeout(h.releaseTimer);
    h.releaseTimer = undefined;
    h.holders++;
    return h.doc;
  }

  release(blockId: string) {
    const h = this.held.get(blockId);
    if (!h) return;
    h.holders = Math.max(0, h.holders - 1);
    if (h.holders > 0 || h.pinned || h.releaseTimer) return;
    h.releaseTimer = setTimeout(() => this.drop(blockId), this.releaseMs);
  }

  /** Every part loaded and kept (an offline copy holds the whole canvas, ADR-063). */
  pinAll() {
    this.pinEverything = true;
    for (const id of this.headers.keys()) {
      if (this.held.get(id)?.pinned) continue;
      this.acquire(id);
      const h = this.held.get(id);
      if (h) h.pinned = true;
    }
  }

  doc(blockId: string) {
    return this.held.get(blockId)?.doc ?? null;
  }

  isSynced(blockId: string) {
    return !!this.held.get(blockId)?.synced;
  }

  loadedIds() {
    return [...this.held.keys()];
  }

  private drop(blockId: string) {
    const h = this.held.get(blockId);
    if (!h || h.holders > 0 || h.pinned) return;
    this.held.delete(blockId);
    h.off();
    this.undo?.detach(h.doc);
    this.transport.sendControl({ t: "sub-unload", id: this.guid(blockId) });
    h.doc.destroy();
    this.changed();
  }

  private request(blockId: string, h: Held) {
    const enc = encoding.createEncoder();
    syncProtocol.writeSyncStep1(enc, h.doc);
    this.transport.send(subFrame(this.guid(blockId), encoding.toUint8Array(enc)));
  }

  /** After a reconnect: ask again for everything held (the server forgot the holders). */
  resync() {
    for (const [id, h] of this.held) {
      h.synced = false;
      this.request(id, h);
    }
  }

  /** A type 101 frame from the server (the decoder is past the message type). */
  handle(dec: decoding.Decoder) {
    const guid = decoding.readVarString(dec);
    const id = blockOf(guid);
    const h = this.held.get(id);
    if (!h) return;
    const reply = encoding.createEncoder();
    const kind = syncProtocol.readSyncMessage(dec, reply, h.doc, this);
    if (encoding.length(reply) > 0) this.transport.send(subFrame(guid, encoding.toUint8Array(reply)));
    if (kind === syncProtocol.messageYjsSyncStep2 && !h.synced) {
      h.synced = true;
      this.changed();
    }
  }

  /** The canvas-wide undo, once linked (`null` before). */
  get crossUndo() {
    return this.undo;
  }

  /** The undo manager a part's block view joins (the canvas stack), once linked. */
  undoFor(doc: Y.Doc) {
    return this.undo?.managerFor(doc) ?? null;
  }

  /** Undo across the main document and every part (one stack, newest first). */
  linkUndo(main: Y.UndoManager) {
    this.undo = new CrossDocUndo(main);
    for (const h of this.held.values()) this.undo.attach(h.doc);
    return this.undo;
  }

  destroy() {
    for (const [, h] of this.held) {
      if (h.releaseTimer) clearTimeout(h.releaseTimer);
      h.off();
      h.doc.destroy();
    }
    this.held.clear();
  }
}

/** The block map of a part (its root holds one key). */
const scopeOf = (doc: Y.Doc) => [doc.getMap("databases"), doc.getMap("boards")];

/** One undo stack over several documents: each document keeps its own Y.UndoManager (Yjs
 *  undoes per document), and the main manager's `undo`/`redo` (what Ctrl+Z and the buttons
 *  call) go to whichever document has the newest step. The part managers track the same
 *  origins as the main one (its `trackedOrigins` set is shared). */
export class CrossDocUndo {
  private order: Y.UndoManager[] = [];
  private redoOrder: Y.UndoManager[] = [];
  private parts = new Map<Y.Doc, Y.UndoManager>();
  private own = new Map<Y.UndoManager, { undo: () => unknown; redo: () => unknown }>();
  private busy = false;
  private mainUndo: () => unknown;
  private mainRedo: () => unknown;

  constructor(private main: Y.UndoManager) {
    this.mainUndo = main.undo.bind(main);
    this.mainRedo = main.redo.bind(main);
    this.watch(main);
    main.undo = () => (this.undo(), null);
    main.redo = () => (this.redo(), null);
  }

  private watch(um: Y.UndoManager) {
    um.on("stack-item-added", (e: { type: "undo" | "redo" }) => {
      if (this.busy) return;
      if (e.type === "undo") {
        this.order.push(um);
        this.redoOrder = [];
      }
    });
  }

  attach(doc: Y.Doc) {
    if (this.parts.has(doc)) return;
    const um = new Y.UndoManager(scopeOf(doc), {
      trackedOrigins: this.main.trackedOrigins,
      captureTimeout: this.main.captureTimeout,
    });
    this.parts.set(doc, um);
    this.own.set(um, { undo: um.undo.bind(um), redo: um.redo.bind(um) });
    // A block's own Ctrl+Z (focus inside a database or board) steps the canvas stack too.
    um.undo = () => (this.undo(), null);
    um.redo = () => (this.redo(), null);
    this.watch(um);
  }

  /** The manager a part's block view joins. */
  managerFor(doc: Y.Doc) {
    return this.parts.get(doc) ?? null;
  }

  detach(doc: Y.Doc) {
    const um = this.parts.get(doc);
    if (!um) return;
    this.parts.delete(doc);
    this.own.delete(um);
    this.order = this.order.filter((m) => m !== um);
    this.redoOrder = this.redoOrder.filter((m) => m !== um);
    um.destroy();
  }

  private step(from: Y.UndoManager[], to: Y.UndoManager[], redo: boolean) {
    while (from.length) {
      const um = from.pop()!;
      const stack = redo ? um.redoStack : um.undoStack;
      if (!stack.length) continue;
      this.busy = true;
      try {
        if (um === this.main) (redo ? this.mainRedo : this.mainUndo)();
        else {
          const o = this.own.get(um);
          if (redo) o?.redo();
          else o?.undo();
        }
      } finally {
        this.busy = false;
      }
      to.push(um);
      return true;
    }
    // Nothing recorded here (steps from before the link): the main document's own stack.
    if (!redo && this.main.undoStack.length) return this.mainUndo(), true;
    if (redo && this.main.redoStack.length) return this.mainRedo(), true;
    return false;
  }

  /** Whether the next step (undo, or redo) is the main document's: the editor's own command
   *  then runs it (it restores the selection). */
  nextIsMain(redo: boolean) {
    const order = redo ? this.redoOrder : this.order;
    for (let i = order.length - 1; i >= 0; i--) {
      const m = order[i];
      if ((redo ? m.redoStack : m.undoStack).length) return m === this.main;
    }
    return true;
  }

  canUndo() {
    return this.order.some((m) => m.undoStack.length > 0) || this.main.undoStack.length > 0;
  }

  canRedo() {
    return this.redoOrder.some((m) => m.redoStack.length > 0) || this.main.redoStack.length > 0;
  }

  undo() {
    return this.step(this.order, this.redoOrder, false);
  }

  redo() {
    return this.step(this.redoOrder, this.order, true);
  }
}
