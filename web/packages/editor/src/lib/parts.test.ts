// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import { CrossDocUndo, MESSAGE_SUBDOC, PartsClient, readSubFrame, subFrame } from "./parts";

/** A room that holds one part per block and answers type 101 frames like the server. */
function fakeRoom(parts: Record<string, Y.Doc>) {
  const sent: Uint8Array[] = [];
  const controls: Record<string, unknown>[] = [];
  let client: PartsClient;
  let open = true;
  const transport = {
    send(frame: Uint8Array) {
      if (!open) return false;
      sent.push(frame);
      const outer = decoding.createDecoder(frame);
      expect(decoding.readVarUint(outer)).toBe(MESSAGE_SUBDOC);
      const { guid, inner: dec } = readSubFrame(outer);
      const server = parts[guid.split("/block/")[1]];
      expect(decoding.readVarUint(dec)).toBe(0);
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, 0);
      syncProtocol.readSyncMessage(dec, reply, server, "client");
      if (encoding.length(reply) > 1) {
        const back = decoding.createDecoder(subFrame(guid, encoding.toUint8Array(reply)));
        decoding.readVarUint(back);
        client.handle(back);
      }
      return true;
    },
    sendControl(m: Record<string, unknown>) {
      controls.push(m);
    },
  };
  client = new PartsClient("doc_1", transport, 1000);
  return { client, sent, controls, close: () => (open = false), open: () => (open = true) };
}

function database(name: string, title: string) {
  const d = new Y.Doc();
  const db = new Y.Map<unknown>();
  d.getMap("databases").set("d1", db);
  db.set("name", name);
  const rows = new Y.Map<unknown>();
  db.set("rows", rows);
  const r = new Y.Map<unknown>();
  rows.set("r1", r);
  r.set("title", title);
  return d;
}

const title = (d: Y.Doc) =>
  (((d.getMap("databases").get("d1") as Y.Map<unknown>).get("rows") as Y.Map<unknown>).get("r1") as Y.Map<unknown>).get("title");

afterEach(() => vi.useRealTimers());

describe("PartsClient (PSYNC-03)", () => {
  it("loads a block's part on acquire, sends its edits and releases it after the delay", () => {
    vi.useFakeTimers();
    const server = database("Tasks", "One");
    const room = fakeRoom({ d1: server });
    room.client.setParts([{ id: "doc_1/block/d1", kind: "database", name: "Tasks", count: 1 }]);
    expect(room.client.isPart("d1")).toBe(true);
    expect(room.client.isPart("d9")).toBe(false);
    const doc = room.client.acquire("d1");
    expect(room.client.isSynced("d1")).toBe(true);
    expect(title(doc)).toBe("One");
    // A local edit reaches the room's part.
    ((((doc.getMap("databases").get("d1") as Y.Map<unknown>).get("rows") as Y.Map<unknown>).get("r1")) as Y.Map<unknown>).set("title", "Uno");
    expect(title(server)).toBe("Uno");
    // Released two minutes (here 1 s) after the last holder goes, not before.
    room.client.release("d1");
    vi.advanceTimersByTime(500);
    expect(room.client.doc("d1")).not.toBeNull();
    room.client.acquire("d1");
    room.client.release("d1");
    vi.advanceTimersByTime(1000);
    expect(room.client.doc("d1")).toBeNull();
    expect(room.controls).toContainEqual({ t: "sub-unload", id: "doc_1/block/d1" });
  });

  it("asks again for held parts after a reconnect and pins every part for an offline copy", () => {
    vi.useFakeTimers();
    const room = fakeRoom({ d1: database("Tasks", "One"), d2: database("Bugs", "Two") });
    room.client.setParts([
      { id: "doc_1/block/d1", kind: "database" },
      { id: "doc_1/block/d2", kind: "database" },
    ]);
    room.close();
    const d1 = room.client.acquire("d1");
    expect(d1.getMap("databases").size).toBe(0);
    room.open();
    room.client.resync();
    expect(title(d1)).toBe("One");
    room.client.pinAll();
    room.client.release("d1");
    room.client.release("d1");
    vi.advanceTimersByTime(10_000);
    expect(room.client.loadedIds().sort()).toEqual(["d1", "d2"]);
  });
});

describe("CrossDocUndo (PSYNC-03)", () => {
  it("undoes and redoes across the main document and parts, newest first", () => {
    const origin = { me: true };
    const main = new Y.Doc();
    const text = main.getText("t");
    const um = new Y.UndoManager(text, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
    const undo = new CrossDocUndo(um);
    const part = database("Tasks", "One");
    undo.attach(part);
    const r1 = () => ((part.getMap("databases").get("d1") as Y.Map<unknown>).get("rows") as Y.Map<unknown>).get("r1") as Y.Map<unknown>;
    main.transact(() => text.insert(0, "a"), origin);
    part.transact(() => r1().set("title", "Uno"), origin);
    main.transact(() => text.insert(1, "b"), origin);
    um.undo();
    expect(text.toString()).toBe("a");
    expect(title(part)).toBe("Uno");
    um.undo();
    expect(title(part)).toBe("One");
    expect(text.toString()).toBe("a");
    um.undo();
    expect(text.toString()).toBe("");
    um.redo();
    expect(text.toString()).toBe("a");
    um.redo();
    expect(title(part)).toBe("Uno");
  });
});
