// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
// @vitest-environment node

// OFF-08 (docs/34 §3.7, OFF-A1): a simulated day offline. Three clients edit the same canvas
// (text, lists, database cells, board shapes); one goes offline for 2,000 transactions, another
// for a shorter while, then each reconnects and replays its unsent log in frames of at most
// MAX_CHUNK, every frame passing the "server" check. All documents converge to the same state.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { chunks, MAX_CHUNK, PendingLog } from "./pending";

function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s % n;
  };
}

const SERVER = Symbol("server");

class Client {
  doc = new Y.Doc();
  log = new PendingLog();
  online = true;
  constructor(readonly name: string, readonly server: Y.Doc) {
    this.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === SERVER) return;
      if (this.online) Y.applyUpdate(server, u, this.name);
      else this.log.add(u);
    });
    server.on("update", (u: Uint8Array, origin: unknown) => {
      if (this.online && origin !== this.name) Y.applyUpdate(this.doc, u, SERVER);
    });
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(server), SERVER);
  }

  /** Reconnect: replay the log in frames, then take what the server has. */
  reconnect(frames: { n: number; max: number }) {
    for (const f of chunks(this.log.entries.map((e) => e.update))) {
      const u = f.length === 1 ? f[0] : Y.mergeUpdates(f);
      frames.n++;
      frames.max = Math.max(frames.max, u.length);
      Y.applyUpdate(this.server, u, this.name);
    }
    this.log.clear();
    this.online = true;
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(this.server, Y.encodeStateVector(this.doc)), SERVER);
  }
}

function op(c: Client, r: (n: number) => number) {
  const d = c.doc;
  const content = d.getXmlFragment("content");
  const db = (d.getMap("databases").get("db") as Y.Map<unknown>).get("rows") as Y.Map<Y.Map<unknown>>;
  const shapes = (d.getMap("boards").get("bd") as Y.Map<unknown>).get("shapes") as Y.Map<Y.Map<unknown>>;
  const k = r(10);
  d.transact(() => {
    if (k < 4 || content.length === 0) {
      // Text: type into a paragraph, or add one.
      const i = content.length ? r(content.length) : 0;
      const p = content.get(i) as Y.XmlElement | undefined;
      const t0 = p?.get(0);
      const t = t0 instanceof Y.XmlText ? t0 : undefined;
      if (t && r(5)) t.insert(r(t.length + 1), c.name[0] + r(100));
      else {
        const np = new Y.XmlElement("paragraph");
        np.setAttribute("blockId", `b_${c.name}_${r(1e9)}`);
        np.insert(0, [new Y.XmlText(`${c.name} ${r(1000)}`)]);
        content.insert(Math.min(i, content.length), [np]);
      }
    } else if (k === 4) {
      // A list item, or delete a block.
      if (content.length > 3 && r(3) === 0) content.delete(r(content.length), 1);
      else {
        const ul = new Y.XmlElement("bulletList");
        const li = new Y.XmlElement("listItem");
        const p = new Y.XmlElement("paragraph");
        p.insert(0, [new Y.XmlText("item " + r(99))]);
        li.insert(0, [p]);
        ul.insert(0, [li]);
        content.insert(r(content.length + 1), [ul]);
      }
    } else if (k < 8) {
      // Database cells (the same few cells, so both sides collide).
      const row = db.get("r" + r(4));
      row?.set("f" + r(3), `${c.name}-${r(50)}`);
    } else {
      // Board shapes.
      const id = "s" + r(6);
      let s = shapes.get(id);
      if (!s) {
        s = new Y.Map<unknown>();
        shapes.set(id, s);
        s.set("type", "sticky");
      }
      s.set("x", r(800));
      s.set("text", `${c.name} ${r(10)}`);
    }
  });
}

function seed(server: Y.Doc) {
  server.transact(() => {
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText("Sprint goal")]);
    server.getXmlFragment("content").insert(0, [p]);
    const db = new Y.Map<unknown>();
    server.getMap("databases").set("db", db);
    const rows = new Y.Map<Y.Map<unknown>>();
    db.set("rows", rows);
    for (let i = 0; i < 4; i++) rows.set("r" + i, new Y.Map());
    const bd = new Y.Map<unknown>();
    server.getMap("boards").set("bd", bd);
    bd.set("shapes", new Y.Map());
  });
}

// Y.Map key order follows local insertion, so compare with sorted keys.
const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;
const json = (d: Y.Doc) =>
  JSON.stringify(
    sorted({
      content: d.getXmlFragment("content").toString(),
      databases: d.getMap("databases").toJSON(),
      boards: d.getMap("boards").toJSON(),
    }),
  );

describe("a simulated day offline", () => {
  for (const s of [1, 7, 42]) {
    it(`three clients converge after 2,000 offline transactions (seed ${s})`, () => {
      const r = rng(s);
      const server = new Y.Doc();
      seed(server);
      const [a, b, c] = ["priya", "jonas", "marco"].map((n) => new Client(n, server));
      const frames = { n: 0, max: 0 };
      a.online = false;
      let offlineA = 0;
      for (let step = 0; offlineA < 2000 || step < 2600; step++) {
        const who = r(3);
        if (who === 0 || offlineA < 2000) {
          op(a, r);
          offlineA++;
        }
        if (who === 1) op(b, r);
        if (who === 2) op(c, r);
        // Marco drops off for a while in the middle of the day.
        if (step === 300) c.online = false;
        if (step === 900) c.reconnect(frames);
      }
      a.reconnect(frames);
      // Everyone catches up with the server.
      for (const x of [b, c]) Y.applyUpdate(x.doc, Y.encodeStateAsUpdate(server, Y.encodeStateVector(x.doc)), SERVER);
      const want = json(server);
      for (const x of [a, b, c]) {
        expect(json(x.doc)).toBe(want);
        expect(Y.encodeStateVector(x.doc)).toEqual(Y.encodeStateVector(server));
      }
      expect(frames.n).toBeGreaterThan(0);
      expect(frames.max).toBeLessThanOrEqual(MAX_CHUNK);
      expect(want).toContain("priya");
    });
  }
});
