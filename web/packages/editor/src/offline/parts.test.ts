// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// PSYNC-03: an offline copy of a split room keeps every part and sends its offline edits back.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import { Device } from "./copy";
import { memKv } from "./kv";
import { PartsClient, subFrame } from "../lib/parts";

function database(title: string) {
  const d = new Y.Doc();
  const db = new Y.Map<unknown>();
  d.getMap("databases").set("d1", db);
  const r = new Y.Map<unknown>();
  db.set("r1", r);
  r.set("title", title);
  return d;
}
const titleOf = (d: Y.Doc) => ((d.getMap("databases").get("d1") as Y.Map<unknown>).get("r1") as Y.Map<unknown>).get("title");

describe("offline copy of a split room (PSYNC-03)", () => {
  it("keeps every part encrypted on the device, reopens with them, and replays their edits on reconnect", async () => {
    const kv = memKv();
    const copy = new Device(kv, "acme", "u_1").copy("doc_1");
    const server = database("One");
    await copy.savePartList([{ id: "doc_1/block/d1", kind: "database", name: "Tasks" }]);
    await copy.savePart("d1", Y.encodeStateAsUpdate(server));
    const raw = JSON.stringify([...kv.dbs.values()].map((st) => [...st.values()].map((m) => [...m.keys()])));
    expect(raw).not.toContain("Tasks");

    // Reopened offline: the part is there, shown, and edited without a connection.
    const kept = await copy.loadParts();
    expect(kept?.list.map((h) => h.id)).toEqual(["doc_1/block/d1"]);
    let online = false;
    const client: PartsClient = new PartsClient("doc_1", {
      send(frame) {
        if (!online) return false;
        const dec = decoding.createDecoder(frame);
        decoding.readVarUint(dec);
        const guid = decoding.readVarString(dec);
        const reply = encoding.createEncoder();
        syncProtocol.readSyncMessage(dec, reply, server, "room");
        if (encoding.length(reply) > 0) {
          const back = decoding.createDecoder(subFrame(guid, encoding.toUint8Array(reply)));
          decoding.readVarUint(back);
          client.handle(back);
        }
        return true;
      },
      sendControl: () => undefined,
    });
    client.restore(kept!.list, kept!.states);
    const part = client.doc("d1")!;
    expect(client.isSynced("d1")).toBe(true);
    expect(titleOf(part)).toBe("One");
    ((part.getMap("databases").get("d1") as Y.Map<unknown>).get("r1") as Y.Map<unknown>).set("title", "Offline edit");
    expect(titleOf(server)).toBe("One");

    // Back online: the handshake sends the room what it lacks.
    online = true;
    client.resync();
    // The room's step 1 asks the client for its edits (as the server does after its step 2).
    const step1 = encoding.createEncoder();
    syncProtocol.writeSyncStep1(step1, server);
    const dec = decoding.createDecoder(subFrame("doc_1/block/d1", encoding.toUint8Array(step1)));
    decoding.readVarUint(dec);
    client.handle(dec);
    expect(titleOf(server)).toBe("Offline edit");
  });
});
