// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Mixed-version concurrent collaboration (DGM-18, ADR-045). Deployed 0.1.1 clients (the v0.1.1
// model, ops and connectors code, vendored unchanged in test-fixtures/v011) and current clients
// edit the same board concurrently on separate Y.Docs. Updates are exchanged in a random order
// (each peer receives every other peer's updates, shuffled and interleaved with edits), then:
//   1. every document converges to the same state;
//   2. no field a current client wrote (kind, kindVersion, each props key, ports, routing, a
//      binding's port, the board name) is lost, unless a 0.1.1 client deleted that shape;
//   3. every binding keeps a valid legacy anchor;
//   4. the 0.1.1 reader returns every shape with a base type it draws, and resolves every
//      connector to finite points;
//   5. the current BoardProjection equals readShapes on every peer.
// Deterministic: a seeded PRNG drives the edits and the delivery order, and Math.random /
// Date.now (used by both versions' id generator) are replaced by seeded stand-ins. No timers.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { addShape, getBoardMap, moveShapes, readShapes, updateShape, type Shape } from "./model";
import { ANCHORS, syncBoundArrows } from "./connectors";
import { bindingTo } from "./ports";
import { BoardProjection } from "./projection";
import { containedIn } from "./ops";
import { CONTAINER } from "./kinds";
import { GENERIC_ICONS, iconNodeFields } from "./icons";
import { boardName, setBoardName } from "./diagram/mode";
import * as old from "../test-fixtures/v011/model";
import * as oldOps from "../test-fixtures/v011/ops";
import * as oldConn from "../test-fixtures/v011/connectors";

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
const EDITS = 160;
const OLD_TYPES = new Set(["sticky", "rect", "ellipse", "diamond", "text", "arrow", "pen", "swatch", "image"]);

function prng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** JSON with sorted keys: Y.Map iteration order may differ between peers. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v);
}

interface Peer {
  doc: Y.Doc;
  isOld: boolean;
  proj: BoardProjection;
  got: Set<number>;
}

afterEach(() => vi.restoreAllMocks());

function run(seed: number) {
  const rnd = prng(seed);
  const idRnd = prng(seed * 7919 + 1);
  let clock = 1_700_000_000_000;
  vi.spyOn(Math, "random").mockImplementation(idRnd);
  vi.spyOn(Date, "now").mockImplementation(() => (clock += 17));
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const int = (n: number) => Math.floor(rnd() * n);

  // Network: a log of every local update; each peer has received a subset.
  const log: { from: number; u: Uint8Array }[] = [];
  const peers: Peer[] = [];
  const mk = (isOld: boolean) => {
    const doc = new Y.Doc();
    const i = peers.length;
    doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin !== "net") log.push({ from: i, u });
    });
    peers.push({ doc, isOld, proj: null as unknown as BoardProjection, got: new Set() });
  };
  mk(false);
  mk(true);
  mk(false);
  mk(true);
  const deliver = (p: number, k: number) => {
    if (peers[p].got.has(k) || log[k].from === p) return;
    peers[p].got.add(k);
    Y.applyUpdate(peers[p].doc, log[k].u, "net");
  };
  const deliverAll = () => {
    for (;;) {
      const todo: [number, number][] = [];
      peers.forEach((_, p) => log.forEach((e, k) => e.from !== p && !peers[p].got.has(k) && todo.push([p, k])));
      if (!todo.length) return;
      for (let i = todo.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [todo[i], todo[j]] = [todo[j], todo[i]];
      }
      for (const [p, k] of todo) deliver(p, k);
    }
  };

  // A current client creates the board with some nodes and connectors; everyone syncs.
  const d0 = peers[0].doc;
  const bid = old.createBoard(d0, "flowchart");
  for (let i = 0; i < 8; i++) addShape(d0, bid, { id: `n${i}`, type: pick(["rect", "ellipse", "diamond", "sticky"] as const), x: (i % 4) * 220, y: Math.floor(i / 4) * 180, w: 140, h: 90, text: `N${i}` });
  for (let i = 0; i < 6; i++) addShape(d0, bid, { id: `e${i}`, type: "arrow", pts: [[0, 0], [1, 1]], start: { shapeId: `n${i}`, anchor: "right" }, end: { shapeId: `n${i + 1}`, anchor: "left" }, route: i % 2 ? "elbow" : undefined });
  deliverAll();
  for (const p of peers) {
    p.proj = new BoardProjection(p.doc, bid);
    p.proj.subscribe(() => {});
  }

  // What current clients wrote, per shape and field (values as canonical JSON).
  const wrote = new Map<string, Map<string, Set<string>>>();
  const names = new Set<string>();
  const deletedByOld = new Set<string>();
  const note = (sid: string, field: string, v: unknown) => {
    if (v === undefined) return;
    const m = wrote.get(sid) ?? new Map<string, Set<string>>();
    wrote.set(sid, m);
    const s = m.get(field) ?? new Set<string>();
    m.set(field, s);
    s.add(canon(v));
  };
  const noteShape = (sid: string, s: Partial<Shape>) => {
    for (const k of ["kind", "kindVersion", "ports", "routing"] as const) note(sid, k, s[k]);
    for (const [k, v] of Object.entries(s.props ?? {})) note(sid, "props." + k, v);
    for (const end of ["start", "end"] as const) if (s[end]?.port) note(sid, end + ".port", s[end]!.port);
  };
  const used = new Map<string, number>();
  const counted = (k: string) => used.set(k, (used.get(k) ?? 0) + 1);

  let fresh = 0;
  const newId = (p: number, pre: string) => `${pre}${p}x${fresh++}`;
  const nodes = (doc: Y.Doc) => readShapes(getBoardMap(doc, bid)!).filter((s) => s.type !== "arrow" && s.type !== "pen");
  const arrows = (doc: Y.Doc) => readShapes(getBoardMap(doc, bid)!).filter((s) => s.type === "arrow");

  const oldEdit = (p: number) => {
    const doc = peers[p].doc;
    const all = old.readShapes(old.getBoardMap(doc, bid)!);
    const ns = all.filter((s) => s.type !== "arrow" && s.type !== "pen");
    if (!all.length) return;
    const op = pick(["move", "move", "resize", "text", "delete", "paste", "zorder", "sync", "sync"]);
    counted("old:" + op);
    if (op === "move" && ns.length) {
      const sel = Array.from({ length: 1 + int(3) }, () => pick(ns));
      old.moveShapes(doc, bid, sel.map((s) => ({ id: s.id, patch: oldOps.movePatch(s, int(41) - 20, int(41) - 20) })));
      oldConn.syncBoundArrows(doc, bid);
    } else if (op === "resize" && ns.length) {
      const s = pick(ns);
      old.updateShape(doc, bid, s.id, { w: 40 + int(200), h: 30 + int(150) });
    } else if (op === "text") {
      const s = pick(all);
      old.updateShape(doc, bid, s.id, { text: `old ${p} ${int(1000)}` });
    } else if (op === "delete") {
      const s = pick(all);
      deletedByOld.add(s.id);
      old.deleteShape(doc, bid, s.id);
    } else if (op === "paste") {
      const sel = Array.from({ length: 1 + int(4) }, () => pick(all)).filter((s, i, a) => a.indexOf(s) === i);
      oldOps.insertShapes(doc, bid, oldOps.cloneShapes(sel, 24, 24));
    } else if (op === "zorder") {
      oldOps.reorderShapes(doc, bid, [pick(all).id, pick(all).id], pick(["front", "back", "forward", "backward"] as const));
    } else {
      oldConn.syncBoundArrows(doc, bid);
    }
  };

  const newEdit = (p: number) => {
    const doc = peers[p].doc;
    const ns = nodes(doc);
    const as = arrows(doc);
    const op = pick(["kind", "props", "props", "ports", "bindPort", "avoid", "container", "icon", "name", "sync"]);
    counted("new:" + op);
    if (op === "kind" && ns.length) {
      const s = pick(ns);
      const patch = { kind: pick(["uml:class", "flow:process", "net:server"]), kindVersion: 1 + int(3) };
      updateShape(doc, bid, s.id, patch);
      noteShape(s.id, patch);
    } else if (op === "props" && ns.length) {
      const s = pick(ns);
      const props = { [pick(["stereotype", "color", "owner", "note"])]: `v${p}-${int(1000)}`, ...(rnd() < 0.3 ? { [`k${int(5)}`]: { deep: [int(9), "x"] } } : {}) };
      updateShape(doc, bid, s.id, { props });
      noteShape(s.id, { props });
    } else if (op === "ports" && ns.length) {
      const s = pick(ns);
      const ports = [
        { id: "in", side: "left" as const, x: 0, y: 0.25 + int(3) / 10 },
        { id: "out", side: "right" as const, x: 1, y: 0.75 },
      ];
      updateShape(doc, bid, s.id, { ports });
      noteShape(s.id, { ports });
    } else if (op === "bindPort" && ns.length >= 2) {
      const a = pick(ns), b = pick(ns.filter((s) => s !== a));
      const ports = [
        { id: "in", side: "left" as const, x: 0, y: 0.5 },
        { id: "out", side: "right" as const, x: 1, y: 0.5 },
      ];
      for (const s of [a, b]) if (!s.ports?.length) {
        updateShape(doc, bid, s.id, { ports });
        noteShape(s.id, { ports });
        s.ports = ports;
      }
      const pa = a.ports!.find((x) => x.id === "out") ?? a.ports![0];
      const pb = b.ports!.find((x) => x.id === "in") ?? b.ports![0];
      const e: Partial<Shape> = { type: "arrow", pts: [[0, 0], [1, 1]], start: bindingTo(a, pa.id), end: bindingTo(b, pb.id), route: "elbow" };
      const id = newId(p, "pe");
      addShape(doc, bid, { ...e, id } as Shape);
      noteShape(id, e);
      syncBoundArrows(doc, bid);
    } else if (op === "avoid" && as.length) {
      const s = pick(as);
      updateShape(doc, bid, s.id, { route: "elbow", routing: "avoid" });
      noteShape(s.id, { routing: "avoid" });
    } else if (op === "container") {
      const cs = ns.filter((s) => s.kind === CONTAINER);
      if (cs.length && rnd() < 0.5) {
        const c = pick(cs);
        const inner = containedIn(readShapes(getBoardMap(doc, bid)!), [c]);
        const dx = int(41) - 20, dy = int(41) - 20;
        const byId = new Map(ns.map((s) => [s.id, s]));
        moveShapes(doc, bid, [c.id, ...inner].filter((id) => byId.has(id)).map((id) => ({ id, patch: { x: (byId.get(id)!.x ?? 0) + dx, y: (byId.get(id)!.y ?? 0) + dy } })));
      } else {
        const id = newId(p, "c");
        const c: Omit<Shape, "id"> = { type: "rect", kind: CONTAINER, kindVersion: 1, x: int(600) - 40, y: int(400) - 40, w: 300, h: 220, label: "Pool", props: { title: `pool ${p}` } };
        addShape(doc, bid, { ...c, id });
        noteShape(id, c);
      }
    } else if (op === "icon") {
      const f = iconNodeFields(pick([...GENERIC_ICONS]).id, [int(800), int(600)]);
      if (f) {
        const id = newId(p, "i");
        addShape(doc, bid, { ...f, id });
        noteShape(id, f);
      }
    } else if (op === "name") {
      const n = `Board ${p}-${int(1000)}`;
      setBoardName(doc, bid, n);
      names.add(n);
    } else {
      syncBoundArrows(doc, bid);
    }
  };

  const checkProjections = () => {
    for (const p of peers) expect(p.proj.get(), `projection seed ${seed}`).toEqual(readShapes(getBoardMap(p.doc, bid)!));
  };

  for (let step = 0; step < EDITS; step++) {
    const p = int(peers.length);
    if (peers[p].isOld) oldEdit(p);
    else newEdit(p);
    // Deliver a few random pending updates to random peers (any order, gaps allowed).
    const n = int(4);
    for (let i = 0; i < n && log.length; i++) deliver(int(peers.length), int(log.length));
    if (step % 40 === 39) checkProjections();
  }
  deliverAll();

  // 1. Convergence.
  const states = peers.map((p) => canon(p.doc.getMap("boards").toJSON()));
  for (const s of states) expect(s, `converged seed ${seed}`).toBe(states[0]);
  const orders = peers.map((p) => readShapes(getBoardMap(p.doc, bid)!).map((s) => s.id).join(","));
  for (const o of orders) expect(o).toBe(orders[0]);

  const final = readShapes(getBoardMap(d0, bid)!);
  const byId = new Map(final.map((s) => [s.id, s as Shape & Record<string, unknown>]));

  // 2. No field a current client wrote is lost unless a 0.1.1 client deleted the shape.
  let checked = 0;
  for (const [sid, fields] of wrote) {
    const s = byId.get(sid);
    if (!s) {
      expect(deletedByOld.has(sid), `shape ${sid} vanished without an old-client delete (seed ${seed})`).toBe(true);
      continue;
    }
    for (const [f, vals] of fields) {
      const [a, b] = f.split(".");
      const v = b === undefined ? s[a] : a === "props" ? (s.props as Record<string, unknown> | undefined)?.[b] : (s[a] as Record<string, unknown> | undefined)?.[b];
      expect(v, `seed ${seed}: ${sid}.${f} lost`).not.toBeUndefined();
      expect(vals.has(canon(v)), `seed ${seed}: ${sid}.${f} = ${canon(v)} not written by a current client`).toBe(true);
      checked++;
    }
  }
  if (names.size) expect(names.has(boardName(d0, bid)), `seed ${seed}: board name`).toBe(true);

  // 3. Bindings keep a valid legacy anchor.
  for (const s of final) for (const end of ["start", "end"] as const) {
    const b = s[end];
    if (b) expect(ANCHORS, `seed ${seed}: ${s.id}.${end}.anchor`).toContain(b.anchor);
  }

  for (const p of peers) {
    const board = getBoardMap(p.doc, bid)!;
    // 4. The 0.1.1 reader draws every shape with a base type, connectors to finite points.
    const o = old.readShapes(board);
    expect(o.map((s) => s.id).sort()).toEqual([...(board.get("shapes") as Y.Map<unknown>).keys()].sort());
    for (const s of o) expect(OLD_TYPES.has(s.type), `seed ${seed}: ${s.id} type ${s.type}`).toBe(true);
    for (const s of oldConn.withResolvedArrows(o)) if (s.type === "arrow") for (const q of s.pts ?? []) expect(Number.isFinite(q[0]) && Number.isFinite(q[1])).toBe(true);
  }
  // 5. Projection equals readShapes.
  checkProjections();
  return { checked, used };
}

// Regression (found by the fuzz below): two clients each give a shape its first `props` field at
// the same time. Each created the nested `props` Y.Map; Yjs keeps one of two concurrent values
// of a map key, so the other client's fields were dropped. The same happened when two clients
// converted a plain-object `props` (written by a 0.1.1 copy) concurrently.
describe("concurrent first props fields merge (DGM-18 regression)", () => {
  const sync = (a: Y.Doc, b: Y.Doc) => {
    for (let i = 0; i < 3; i++) {
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    }
  };
  for (const start of [{}, { props: { legacy: 1 } }]) {
    it(`both fields survive (${Object.keys(start).length ? "plain props from 0.1.1" : "no props yet"})`, () => {
      const a = new Y.Doc(), b = new Y.Doc();
      const bid = old.createBoard(a, "blank");
      addShape(a, bid, { id: "n", type: "rect", x: 0, y: 0, w: 10, h: 10, ...start } as Shape);
      if ("props" in start) old.updateShape(a, bid, "n", { props: { legacy: 1 } } as Partial<Shape>);
      sync(a, b);
      updateShape(a, bid, "n", { props: { color: "red" } });
      updateShape(b, bid, "n", { props: { owner: "bo" } });
      sync(a, b);
      for (const d of [a, b]) {
        const p = readShapes(getBoardMap(d, bid)!)[0].props;
        expect(p).toEqual({ color: "red", owner: "bo", ...("props" in start ? { legacy: 1 } : {}) });
      }
    });
  }
});

describe("mixed-version concurrent collaboration (DGM-18)", () => {
  const total = new Map<string, number>();
  it.each(SEEDS)("seed %i: 0.1.1 and current clients converge without losing diagram fields", (seed) => {
    const { checked, used } = run(seed);
    expect(checked).toBeGreaterThan(0);
    for (const [k, v] of used) total.set(k, (total.get(k) ?? 0) + v);
  });
  it("every edit kind ran across the seeds", () => {
    const kinds = ["old:move", "old:resize", "old:text", "old:delete", "old:paste", "old:zorder", "old:sync", "new:kind", "new:props", "new:ports", "new:bindPort", "new:avoid", "new:container", "new:icon", "new:name", "new:sync"];
    for (const k of kinds) expect(total.get(k) ?? 0, k).toBeGreaterThan(10);
  });
});
