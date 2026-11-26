// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The unsent-change log (OFF-02/04, ADR-064, docs/34 §3.3). Every local Yjs transaction goes in
// with its time; a save that started after it was sent confirms it. Session resilience keeps it
// in memory (this tab); an offline copy also writes it to IndexedDB (offline/copy.ts). On a
// reconnect it is replayed in frames of at most `MAX_CHUNK` bytes (`chunks`), within the rate
// limit, each checked by the server like typing.
import * as Y from "yjs";
import { createStore } from "../lib/store";

/** Largest replay frame: under the server's 1 MB `OC_MAX_FRAME_KB`, with room for framing. */
export const MAX_CHUNK = 900 * 1024;
/** Frames a second during a replay (the server allows 60 a second, typing and presence included). */
export const REPLAY_PER_SEC = 20;
/** A merge over this long or this many changes gets a checkpoint version first (ADR-064). */
export const CHECKPOINT_MS = 10 * 60_000;
export const CHECKPOINT_CHANGES = 200;

/** Origin of updates applied from the device copy: they are not new local edits. */
export const FROM_DEVICE = Symbol.for("oc-offline-device");

export interface PendingEntry {
  /** Position in the log (IndexedDB key for an offline copy). */
  id: number;
  /** When the change was made (ms). */
  at: number;
  update: Uint8Array;
  /** When it went out on a connected socket (ms); a save that starts later confirms it. */
  sent?: number;
}

/** Groups updates into frames of at most `max` bytes, in order. One update bigger than `max`
 *  gets a frame of its own (the server will refuse it, as it would online). */
export function chunks(updates: Uint8Array[], max = MAX_CHUNK): Uint8Array[][] {
  const out: Uint8Array[][] = [];
  let cur: Uint8Array[] = [];
  let size = 0;
  for (const u of updates) {
    if (cur.length && size + u.length > max) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(u);
    size += u.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The frames a replay sends (lib/session.ts): `diff` (what the server lacks, from its state
 *  vector) in one frame when it fits, else the unsent updates in frames of at most `max`. Each
 *  frame is one update (several are merged). */
export function replayFrames(diff: Uint8Array, entries: { update: Uint8Array }[], max = MAX_CHUNK): Uint8Array[] {
  if (diff.length <= max) return [diff];
  return chunks(
    entries.map((e) => e.update),
    max,
  ).map((f) => (f.length === 1 ? f[0] : Y.mergeUpdates(f)));
}

/** Whether a merge of these entries needs a checkpoint version first. */
export function needsCheckpoint(entries: { at: number }[], now = Date.now()): boolean {
  if (entries.length > CHECKPOINT_CHANGES) return true;
  return entries.length > 0 && now - entries[0].at > CHECKPOINT_MS;
}

export class PendingLog {
  entries: PendingEntry[] = [];
  bytes = 0;
  private next = 1;
  /** Bumped on every change, for the save pill. */
  readonly version = createStore(0);
  /** Called for every entry added (an offline copy persists it). */
  onAdd: ((e: PendingEntry) => void) | null = null;
  /** Called with the highest id confirmed. */
  onConfirm: ((upTo: number) => void) | null = null;

  add(update: Uint8Array, at = Date.now(), sent?: number): PendingEntry {
    const e: PendingEntry = { id: this.next++, at, update, sent };
    this.entries.push(e);
    this.bytes += update.length;
    this.onAdd?.(e);
    this.version.set(this.version.get() + 1);
    return e;
  }

  /** Restores entries read back from an offline copy. */
  restore(list: PendingEntry[]) {
    for (const e of list) {
      this.entries.push(e);
      this.bytes += e.update.length;
      this.next = Math.max(this.next, e.id + 1);
    }
    this.version.set(this.version.get() + 1);
  }

  /** Marks every entry up to `upTo` as sent at `at` (a replay finished). */
  markSent(upTo: number, at = Date.now()) {
    for (const e of this.entries) if (e.id <= upTo && e.sent === undefined) e.sent = at;
  }

  /** Drops the entries sent before `before` (ms): a save that started then has them. */
  confirmBefore(before: number) {
    let upTo = 0;
    while (this.entries.length && this.entries[0].sent !== undefined && this.entries[0].sent < before) {
      const e = this.entries.shift()!;
      this.bytes -= e.update.length;
      upTo = e.id;
    }
    if (upTo) {
      this.onConfirm?.(upTo);
      this.version.set(this.version.get() + 1);
    }
  }

  clear() {
    const last = this.entries[this.entries.length - 1];
    this.entries = [];
    this.bytes = 0;
    if (last) this.onConfirm?.(last.id);
    this.version.set(this.version.get() + 1);
  }

  get size() {
    return this.entries.length;
  }
}
