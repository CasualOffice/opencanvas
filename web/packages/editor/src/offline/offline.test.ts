// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
// @vitest-environment node

// OFF-02/04/05 units: the unsent log and its frames, the encrypted device copy (in memory),
// the offline grant check, and the merge summary's two cases.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Device } from "./copy";
import { verifyGrant } from "./crypto";
import { memKv } from "./kv";
import { analyze, removeBlock, restoreBlock, track, useMine } from "./merge";
import { fileDb, hostDb, keyDb } from "./names";
import { chunks, CHECKPOINT_CHANGES, MAX_CHUNK, needsCheckpoint, PendingLog } from "./pending";
import { docToMarkdown } from "./markdown";

describe("the unsent log", () => {
  it("frames stay under the limit and keep the order", () => {
    const u = (n: number) => new Uint8Array(n);
    const f = chunks([u(400_000), u(400_000), u(400_000), u(2_000_000), u(10)]);
    expect(f.map((c) => c.length)).toEqual([2, 1, 1, 1]);
    for (const c of f.slice(0, 2)) expect(c.reduce((n, x) => n + x.length, 0)).toBeLessThanOrEqual(MAX_CHUNK);
    expect(chunks([])).toEqual([]);
  });

  it("asks for a checkpoint past 10 minutes or 200 changes", () => {
    const now = 1_000_000_000;
    expect(needsCheckpoint([], now)).toBe(false);
    expect(needsCheckpoint([{ at: now - 60_000 }], now)).toBe(false);
    expect(needsCheckpoint([{ at: now - 11 * 60_000 }], now)).toBe(true);
    expect(needsCheckpoint(Array.from({ length: CHECKPOINT_CHANGES + 1 }, () => ({ at: now })), now)).toBe(true);
  });

  it("a save that started after a change went out confirms it; unsent changes stay", () => {
    const log = new PendingLog();
    const confirmed: number[] = [];
    log.onConfirm = (n) => confirmed.push(n);
    log.add(new Uint8Array([1]), 10, 11);
    log.add(new Uint8Array([2]), 20, 21);
    log.add(new Uint8Array([3]), 30); // made offline: not sent
    log.confirmBefore(25);
    expect(log.size).toBe(1);
    expect(confirmed).toEqual([2]);
    log.confirmBefore(1e12);
    expect(log.size).toBe(1);
    log.markSent(3, 40);
    log.confirmBefore(41);
    expect(log.size).toBe(0);
  });
});

async function es256() {
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", k.publicKey);
  const b64 = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
  const sign = async (claims: object, typ = "oc-offline+jwt") => {
    const input = b64(JSON.stringify({ alg: "ES256", typ })) + "." + b64(JSON.stringify(claims));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, new TextEncoder().encode(input)));
    return input + "." + b64(sig);
  };
  return { jwk, sign, b64 };
}

describe("the offline grant", () => {
  it("verifies with the server's key; a changed claim, another key or typ fails", async () => {
    const { jwk, sign, b64 } = await es256();
    const claims = { host: "acme", sub: "u_1", file: "doc_1", role: "edit", exp: 99, gen: 4 };
    const jws = await sign(claims);
    expect((await verifyGrant(jws, jwk))?.gen).toBe(4);
    const [h, , s] = jws.split(".");
    expect(await verifyGrant([h, b64(JSON.stringify({ ...claims, exp: 9e9 })), s].join("."), jwk)).toBeNull();
    expect(await verifyGrant(jws, (await es256()).jwk)).toBeNull();
    expect(await verifyGrant(await sign(claims, "JWT"), jwk)).toBeNull();
    expect(await verifyGrant("not.a.grant", jwk)).toBeNull();
  });
});

describe("the device copy", () => {
  it("stores the document and unsent changes encrypted, per host, person and file", async () => {
    const kv = memKv();
    const dev = new Device(kv, "acme", "u_1");
    const copy = dev.copy("doc_1");
    const doc = new Y.Doc();
    doc.getXmlFragment("content").insert(0, [new Y.XmlText("Sprint goal: SSO")]);
    await copy.snapshot(doc);
    await copy.setMeta({ file: "doc_1", title: "Sprint 42 planning", bytes: 10, pending: 0, lastSent: 1, exp: 99, gen: 0, role: "edit", keptAt: 1, grant: "g", jwk: {} });
    await copy.addPending({ id: 1, at: 5, update: new Uint8Array([7, 7]) });
    // Nothing readable at rest: no title, no text.
    const raw = JSON.stringify([...kv.dbs.entries()].map(([n, st]) => [n, [...st.entries()].map(([s, m]) => [s, [...m.values()].map((v) => (v instanceof Object && "ct" in (v as object) ? Buffer.from((v as { ct: ArrayBuffer }).ct).toString("latin1") : String(v)))])]));
    expect(raw).not.toContain("Sprint");
    expect(raw).not.toContain("SSO");
    expect([...kv.dbs.keys()]).toEqual(expect.arrayContaining([keyDb("acme", "u_1"), fileDb("acme", "u_1", "doc_1"), hostDb("acme")]));
    // Read back.
    const again = new Y.Doc();
    expect(await copy.loadInto(again)).toBe(true);
    expect(again.getXmlFragment("content").toString()).toContain("SSO");
    expect((await copy.pending()).map((e) => e.id)).toEqual([1]);
    expect((await dev.list()).map((e) => e.title)).toEqual(["Sprint 42 planning"]);
    // Another person on the same browser sees nothing.
    expect(await new Device(kv, "acme", "u_2").list()).toEqual([]);
  });

  it("removing all deletes the key first, then every database of that person", async () => {
    const kv = memKv();
    const dev = new Device(kv, "acme", "u_1");
    for (const f of ["a", "b"]) {
      const c = dev.copy(f);
      await c.snapshot(new Y.Doc());
      await c.setMeta({ file: f, title: f, bytes: 1, pending: f === "b" ? 3 : 0, lastSent: 1, exp: 99, gen: 0, role: "edit", keptAt: 1, grant: "g", jwk: {} });
    }
    await new Device(kv, "acme", "u_2").copy("c").snapshot(new Y.Doc());
    const r = await dev.removeAll();
    expect(r).toMatchObject({ removed: 2, pending: 3 });
    expect([...kv.dbs.keys()].filter((n) => n.includes("/u_1/"))).toEqual([]);
    expect([...kv.dbs.keys()].some((n) => n.includes("/u_2/"))).toBe(true);
    // Without the key, nothing opens.
    expect(await dev.copy("a").meta()).toBeNull();
  });

  it("reserved file ids get their own database", () => {
    expect(fileDb("acme", "u_1", "key")).not.toBe(keyDb("acme", "u_1"));
    expect(fileDb("a/b", "u 1", "doc/1")).toBe("oc-offline/a%2Fb/u%201/doc%2F1");
  });
});

const para = (doc: Y.Doc, id: string, text: string, at?: number) => {
  const p = new Y.XmlElement("paragraph");
  p.setAttribute("blockId", id);
  p.insert(0, [new Y.XmlText(text)]);
  const f = doc.getXmlFragment("content");
  f.insert(at ?? f.length, [p]);
  return p;
};

function dbDoc(doc: Y.Doc) {
  doc.transact(() => {
    const db = new Y.Map<unknown>();
    doc.getMap("databases").set("db_1", db);
    const fields = new Y.Array<Y.Map<unknown>>();
    db.set("fields", fields);
    const t = new Y.Map<unknown>();
    t.set("id", "f_t");
    t.set("name", "Task");
    t.set("type", "title");
    const s = new Y.Map<unknown>();
    s.set("id", "f_s");
    s.set("name", "Status");
    s.set("type", "select");
    fields.push([t, s]);
    const rows = new Y.Map<Y.Map<unknown>>();
    db.set("rows", rows);
    const r = new Y.Map<unknown>();
    rows.set("r_1", r);
    r.set("f_t", "Fix CSV export timeout");
    r.set("f_s", "In review");
  });
}

const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
};

describe("the merge summary", () => {
  it("offers back text edited inside a block someone deleted, and lists both-sides cell changes", () => {
    const me = new Y.Doc();
    const them = new Y.Doc();
    para(me, "b_goal", "Sprint goal");
    const h = new Y.XmlElement("heading");
    h.setAttribute("blockId", "b_h");
    h.insert(0, [new Y.XmlText("Risks")]);
    me.getXmlFragment("content").insert(1, [h]);
    para(me, "b_risk", "The sandbox is shared");
    dbDoc(me);
    sync(me, them);
    // Offline on my side.
    const t = track(me, () => true);
    const risk = me.getXmlFragment("content").get(2) as Y.XmlElement;
    (risk.get(0) as Y.XmlText).insert(21, ". Noor confirmed our own tenant");
    (((me.getMap("databases").get("db_1") as Y.Map<unknown>).get("rows") as Y.Map<Y.Map<unknown>>).get("r_1")!).set("f_s", "Done");
    t.stop();
    const before = Y.encodeStateAsUpdate(me);
    // Meanwhile, them: delete the block, change the same cell.
    them.getXmlFragment("content").delete(2, 1);
    (((them.getMap("databases").get("db_1") as Y.Map<unknown>).get("rows") as Y.Map<Y.Map<unknown>>).get("r_1")!).set("f_s", "Blocked");
    sync(me, them);
    const items = analyze(before, me, t);
    const del = items.find((i) => i.kind === "deleted");
    expect(del).toMatchObject({ blockId: "b_risk", title: "Risks", prevId: "b_h" });
    expect(del && "text" in del && del.text).toContain("Noor confirmed");
    const cell = items.find((i) => i.kind === "cell");
    expect(cell).toMatchObject({ rowTitle: "Fix CSV export timeout", fieldName: "Status", mine: "Done" });
    // Restore: back where it was, labelled, one undoable edit.
    if (del?.kind !== "deleted" || cell?.kind !== "cell") throw new Error("both cases");
    restoreBlock(before, me, del, "b_new", "Priya");
    const back = me.getXmlFragment("content").get(2) as Y.XmlElement;
    expect(back.getAttribute("blockId")).toBe("b_new");
    expect(back.getAttribute("restoredBy")).toBe("Priya");
    expect(back.toString()).toContain("Noor confirmed");
    expect(removeBlock(me, "b_new")).toBe(true);
    useMine(me, cell);
    sync(me, them);
    expect((((them.getMap("databases").get("db_1") as Y.Map<unknown>).get("rows") as Y.Map<Y.Map<unknown>>).get("r_1")!).get("f_s")).toBe("Done");
  });

  it("stays quiet for text in the same paragraph and different cells", () => {
    const me = new Y.Doc();
    const them = new Y.Doc();
    para(me, "b_1", "Hello world");
    dbDoc(me);
    sync(me, them);
    const t = track(me, () => true);
    ((me.getXmlFragment("content").get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(5, " there");
    t.stop();
    const before = Y.encodeStateAsUpdate(me);
    ((them.getXmlFragment("content").get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, "Oh. ");
    (((them.getMap("databases").get("db_1") as Y.Map<unknown>).get("rows") as Y.Map<Y.Map<unknown>>).get("r_1")!).set("f_t", "Renamed");
    sync(me, them);
    expect(analyze(before, me, t)).toEqual([]);
  });
});

describe("download my version", () => {
  it("writes the held copy as Markdown", () => {
    const d = new Y.Doc();
    d.getMap("meta").set("title", "Sprint 42");
    const h = new Y.XmlElement("heading");
    h.setAttribute("level", 2 as unknown as string);
    h.insert(0, [new Y.XmlText("Goal")]);
    d.getXmlFragment("content").insert(0, [h]);
    para(d, "b", "Ship SSO");
    expect(docToMarkdown(d)).toBe("# Sprint 42\n\n## Goal\n\nShip SSO\n");
  });
});
