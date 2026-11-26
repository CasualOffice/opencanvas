// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
// @vitest-environment node

// OFF-08 (docs/34 §3.7, OFF-A1): a simulated day offline. Three clients edit the same canvas
// (text, lists, database cells, board objects, block deletes and moves, comments). Each spends
// most of a simulated day offline in long stretches, with short spells online between them. A
// reconnect goes the way the editor does it (lib/session.ts, offline/controller.ts): the unsent
// log (`PendingLog`) is replayed in the real frames (`replayFrames`: at most MAX_CHUNK each,
// REPLAY_PER_SEC a second), sometimes cut off half way and sent again; a save then confirms the
// log; the merge summary is worked out (`track` + `analyze`) and every "deleted" item is
// restored, as the person would. Checked after every run:
//  - every document and the server converge (same content, same state vector);
//  - no text that only one side wrote is lost: every token survives unless the person who
//    deleted its block had it in front of them (on their screen or already on the server);
//  - the merge summary lists exactly the blocks and cells it should;
//  - every frame stays under MAX_CHUNK and the frames are packed (at most 2 × bytes / MAX + 1).
// Seeds 1, 7 and 42, plus OC_FUZZ_SEED (random when unset; printed on failure).
// OC_FUZZ_LONG=1 runs a long day (60,000 steps) for each seed.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addMessage, commentsRoot, createThread } from "../lib/comments";
import { analyze, restoreBlock, track, type MergeItem } from "./merge";
import { CHECKPOINT_CHANGES, MAX_CHUNK, needsCheckpoint, PendingLog, replayFrames, REPLAY_PER_SEC } from "./pending";

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return (n: number) => {
    // xorshift32: better spread than an LCG's low bits for small `n`.
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s % n;
  };
}

const LONG = process.env.OC_FUZZ_LONG === "1";
const SERVER = Symbol("server");
const TOKEN = /⟦[a-z]\d+⟧/g;
const tokensIn = (s: string) => s.match(TOKEN) ?? [];

/** Every string ever written into a type, deleted or not (the server keeps them: gc off). */
function rawText(t: Y.AbstractType<unknown>): string {
  let out = "";
  for (let it = t._start; it; it = it.right) {
    const c = it.content as unknown as { str?: string; type?: Y.AbstractType<unknown> };
    if (typeof c.str === "string") out += c.str;
    else if (c.type) out += rawText(c.type);
  }
  return out;
}

interface Stats {
  frames: number;
  maxFrame: number;
  multiFrame: number;
  cuts: number;
  reconnects: number;
  checkpoints: number;
  summaries: { deleted: number; moved: number; cells: number };
  replayMs: number;
}

class World {
  server = new Y.Doc({ gc: false });
  /** Server clock: bumped on every update the server applies. */
  tick = 0;
  /** Tokens on the server when their block was deleted there: a live delete, seen by everyone. */
  liveDeleted = new Set<string>();
  /** Tokens that were on the deleter's screen when they deleted the block. */
  seenDeleted = new Set<string>();
  /** Every token written, and by whom. */
  written = new Map<string, string>();
  stats: Stats = { frames: 0, maxFrame: 0, multiFrame: 0, cuts: 0, reconnects: 0, checkpoints: 0, summaries: { deleted: 0, moved: 0, cells: 0 }, replayMs: 0 };
  now = Date.UTC(2026, 10, 26, 7, 0);
  seq = 0;

  constructor() {
    this.server.on("update", () => this.tick++);
    this.server.getXmlFragment("content").observe((ev) => {
      for (const item of ev.changes.deleted) {
        const t = (item.content as unknown as { type?: Y.AbstractType<unknown> }).type;
        if (t) for (const k of tokensIn(rawText(t))) this.liveDeleted.add(k);
      }
    });
  }

  token(c: Client) {
    const k = `⟦${c.name[0]}${++this.seq}⟧`;
    this.written.set(k, c.name);
    return k;
  }
}

class Client {
  doc = new Y.Doc();
  log = new PendingLog();
  online = true;
  touched: ReturnType<typeof track> | null = null;
  /** Top-level blocks whose text this client changed while offline. */
  editedOffline = new Set<Y.XmlElement>();
  /** Cells this client set while offline. */
  cellsOffline = new Set<string>();
  /** Steps left in the current online or offline stretch. */
  left = 0;
  ops = 0;
  constructor(
    readonly name: string,
    readonly w: World,
  ) {
    this.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === SERVER) return;
      if (this.online) Y.applyUpdate(w.server, u, this.name);
      else this.log.add(u, w.now);
    });
    w.server.on("update", (u: Uint8Array, origin: unknown) => {
      if (this.online && origin !== this.name) Y.applyUpdate(this.doc, u, SERVER);
    });
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(w.server), SERVER);
  }

  goOffline() {
    this.online = false;
    this.touched = track(this.doc, (o) => o !== SERVER);
    this.editedOffline.clear();
    this.cellsOffline.clear();
  }

  /** The editor's reconnect: replay, save, merge summary, restore. */
  reconnect(r: (n: number) => number) {
    const w = this.w;
    const s = w.stats;
    const entries = this.log.entries.slice();
    s.reconnects++;
    if (entries.length && needsCheckpoint(entries, w.now)) s.checkpoints++;
    if (entries.length > CHECKPOINT_CHANGES) expect(needsCheckpoint(entries, w.now)).toBe(true);
    const before = Y.encodeStateAsUpdate(this.doc);
    const rows = this.cellValues();
    const edited = this.editedBlocks();
    // A save that started before the replay must not confirm it.
    const savingBefore = w.now;
    const frames = replayFrames(Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(w.server)), entries);
    const bytes = entries.reduce((n, e) => n + e.update.length, 0);
    if (frames.length > 1) {
      s.multiFrame++;
      expect(frames.length).toBeLessThanOrEqual(Math.ceil((2 * bytes) / MAX_CHUNK) + 1);
    }
    // Sometimes the connection drops half way: nothing is marked sent, the next try sends all.
    const cut = frames.length > 1 && r(3) === 0 ? 1 + r(frames.length - 1) : frames.length;
    for (let pass = 0; pass < (cut < frames.length ? 2 : 1); pass++) {
      const upTo = pass === 0 ? cut : frames.length;
      for (let i = 0; i < upTo; i++) {
        const u = frames[i];
        // The server's frame check (OC_MAX_FRAME_KB): every frame is under MAX_CHUNK.
        expect(u.length).toBeLessThanOrEqual(MAX_CHUNK);
        s.frames++;
        s.maxFrame = Math.max(s.maxFrame, u.length);
        Y.applyUpdate(w.server, u, this.name);
        if (i + 1 < upTo) w.now += 1000 / REPLAY_PER_SEC;
      }
      if (pass === 0 && cut < frames.length) {
        s.cuts++;
        expect(this.log.size).toBe(entries.length);
      }
    }
    s.replayMs += Math.max(0, frames.length - 1) * (1000 / REPLAY_PER_SEC);
    if (entries.length) this.log.markSent(entries[entries.length - 1].id, w.now);
    this.log.confirmBefore(savingBefore);
    expect(this.log.size).toBe(entries.length);
    w.now += 1;
    this.log.confirmBefore(w.now);
    expect(this.log.size).toBe(0);
    // Back online: take what the server has (SyncStep2), then the merge summary.
    this.online = true;
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(w.server, Y.encodeStateVector(this.doc)), SERVER);
    const touched = this.touched!;
    touched.stop();
    this.touched = null;
    const items = analyze(before, this.doc, touched);
    this.checkSummary(items, rows, edited);
    for (const it of items) {
      if (it.kind !== "deleted") continue;
      if (it.moved) s.summaries.moved++;
      else s.summaries.deleted++;
      // "Restore my text as a new block".
      expect(restoreBlock(before, this.doc, it, `b_r_${this.name}_${++w.seq}`, this.name)).toBeTruthy();
    }
    s.summaries.cells += items.filter((i) => i.kind === "cell").length;
  }

  private cellValues() {
    const out = new Map<string, unknown>();
    for (const key of this.cellsOffline) {
      const [, row, field] = key.split("/");
      out.set(key, rowsOf(this.doc).get(row)?.get(field));
    }
    return out;
  }

  /** The blocks this client edited offline that are still on the device, with text. */
  private editedBlocks() {
    return [...this.editedOffline].filter((el) => !el._item!.deleted && el.toString().replace(/<[^>]+>/g, "").trim()).map((el) => ({ el, blockId: el.getAttribute("blockId") as string }));
  }

  /** What the summary must list, worked out from what this client did (not from `track`). */
  private checkSummary(items: MergeItem[], cells: Map<string, unknown>, edited: { el: Y.XmlElement; blockId: string }[]) {
    const want: string[] = [];
    for (const e of edited) if (e.el._item!.deleted) want.push("deleted " + e.blockId);
    for (const [key, mine] of cells) {
      const [, row, field] = key.split("/");
      if (JSON.stringify(rowsOf(this.doc).get(row)?.get(field)) !== JSON.stringify(mine)) want.push("cell " + key);
    }
    const got = items.map((i) => (i.kind === "deleted" ? "deleted " + i.blockId : `cell ${i.db}/${i.row}/${i.field}`));
    expect(got.sort()).toEqual(want.sort());
  }
}

const rowsOf = (d: Y.Doc) => (d.getMap("databases").get("db") as Y.Map<unknown>).get("rows") as Y.Map<Y.Map<unknown>>;

function paragraph(blockId: string, text: string) {
  const p = new Y.XmlElement("paragraph");
  p.setAttribute("blockId", blockId);
  p.insert(0, [new Y.XmlText(text)]);
  return p;
}

/** Where a whole token can go: the start, the end, or just after another token. */
function boundaries(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s[i] === "⟧") out.push(i + 1);
  if (out[out.length - 1] !== s.length) out.push(s.length);
  return out;
}

function op(c: Client, r: (n: number) => number) {
  const w = c.w;
  const d = c.doc;
  const content = d.getXmlFragment("content");
  const shapes = (d.getMap("boards").get("bd") as Y.Map<unknown>).get("shapes") as Y.Map<Y.Map<unknown>>;
  const k = r(100);
  c.ops++;
  d.transact(() => {
    const paras = content.toArray().filter((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === "paragraph");
    if (k < 40 && paras.length) {
      // Type a word into a paragraph.
      const p = paras[r(paras.length)];
      const t = p.get(0);
      if (!(t instanceof Y.XmlText)) return;
      const b = boundaries(t.toString());
      t.insert(b[r(b.length)], w.token(c));
      if (!c.online) c.editedOffline.add(p);
    } else if (k < 45 || !paras.length) {
      content.insert(r(content.length + 1), [paragraph(`b_${c.name}_${++w.seq}`, w.token(c))]);
    } else if (k < 47 && (!LONG || r(8) === 0)) {
      // A paste: a long paragraph (fills the log, so the replay needs several frames). Rarer on
      // the long run, whose longer stretches offline fill the log anyway.
      content.insert(r(content.length + 1), [paragraph(`b_${c.name}_${++w.seq}`, "lorem ipsum ".repeat(4_000 + r(16_000)))]);
    } else if (k < 50) {
      const ul = new Y.XmlElement("bulletList");
      const li = new Y.XmlElement("listItem");
      const p = new Y.XmlElement("paragraph");
      p.insert(0, [new Y.XmlText("item " + r(99))]);
      li.insert(0, [p]);
      ul.insert(0, [li]);
      content.insert(r(content.length + 1), [ul]);
    } else if (k < 54 && content.length > 4) {
      // Delete a block: what was on screen in it is gone on purpose.
      const i = r(content.length);
      for (const t of tokensIn(content.get(i).toString())) w.seenDeleted.add(t);
      content.delete(i, 1);
    } else if (k < 58 && content.length > 2) {
      // Move a block (ProseMirror through y-prosemirror: delete it, insert a copy elsewhere).
      const i = r(content.length);
      const n = content.get(i);
      if (!(n instanceof Y.XmlElement)) return;
      const copy = n.clone();
      content.delete(i, 1);
      content.insert(r(content.length + 1), [copy]);
    } else if (k < 76) {
      // Database cells: few of them, so both sides collide.
      const row = "r" + r(4);
      const field = "f" + r(3);
      rowsOf(d).get(row)?.set(field, `${c.name}-${++w.seq}`);
      if (!c.online) c.cellsOffline.add(`db/${row}/${field}`);
    } else if (k < 90) {
      // Board objects.
      const id = "s" + r(8);
      let s = shapes.get(id);
      if (!s || r(10) === 0) {
        s = new Y.Map<unknown>();
        shapes.set(id, s);
        s.set("type", r(2) ? "sticky" : "rect");
      }
      s.set("x", r(800));
      s.set("y", r(600));
      s.set("text", `${c.name} ${r(10)}`);
    } else {
      // Comments: a new thread, or a reply in one.
      const threads = [...commentsRoot(d).keys()].sort();
      if (!threads.length || r(3) === 0) createThread(d, `t_${c.name}_${++w.seq}`, "quote", paras[0]?.getAttribute("blockId") as string | undefined);
      else addMessage(d, threads[r(threads.length)], { user: c.name, name: c.name, color: "#000", text: w.token(c) });
    }
  });
}

function seed(server: Y.Doc) {
  server.transact(() => {
    const frag = server.getXmlFragment("content");
    frag.insert(0, [paragraph("b_goal", "Sprint goal"), paragraph("b_notes", "Notes"), paragraph("b_risks", "Risks")]);
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
      comments: d.getMap("comments").toJSON(),
    }),
  );

function day(s: number, steps: number): Stats {
  const r = rng(s);
  const w = new World();
  seed(w.server);
  const people = ["priya", "jonas", "marco"].map((n) => new Client(n, w));
  // Mostly offline: long stretches away, short spells online.
  for (const c of people) {
    c.goOffline();
    c.left = 100 + r(steps / 3);
  }
  for (let step = 0; step < steps; step++) {
    w.now += 10_000 + r(20_000);
    const c = people[r(3)];
    op(c, r);
    if (--c.left <= 0) {
      if (c.online) {
        c.goOffline();
        c.left = 300 + r(steps / 2);
      } else {
        c.reconnect(r);
        c.left = 10 + r(60);
      }
    }
  }
  for (const c of people) if (!c.online) c.reconnect(r);

  // Converged: every document is the server's.
  const want = json(w.server);
  for (const c of people) {
    expect(json(c.doc)).toBe(want);
    expect(Y.encodeStateVector(c.doc)).toEqual(Y.encodeStateVector(w.server));
  }
  // No text lost that only one side wrote.
  const present = new Set(tokensIn(want));
  const lost = [...w.written.keys()].filter((t) => !present.has(t) && !w.seenDeleted.has(t) && !w.liveDeleted.has(t));
  expect(lost).toEqual([]);
  expect(w.stats.maxFrame).toBeLessThanOrEqual(MAX_CHUNK);
  expect(people.reduce((n, c) => n + c.ops, 0)).toBe(steps);
  return w.stats;
}

const STEPS = LONG ? 60_000 : 4_000;
const envSeed = Number(process.env.OC_FUZZ_SEED) || (Math.random() * 2 ** 31) >>> 0;

describe("a simulated day offline (three clients)", () => {
  for (const [s, fixed] of [
    [1, true],
    [7, true],
    [42, true],
    [envSeed, false],
  ] as const) {
    it(`${STEPS.toLocaleString("en-US")} transactions converge, lose nothing and summarise the merge (seed ${s}${fixed ? "" : ", OC_FUZZ_SEED"})`, { timeout: LONG ? 1_800_000 : 30_000 }, () => {
      let st: Stats;
      try {
        st = day(s, STEPS);
      } catch (e) {
        console.error(`offline fuzz failed with seed ${s}: rerun with OC_FUZZ_SEED=${s}`);
        throw e;
      }
      if (fixed) {
        // The day exercised what it is for.
        expect(st.multiFrame).toBeGreaterThan(0);
        expect(st.checkpoints).toBeGreaterThan(0);
        expect(st.summaries.deleted + st.summaries.moved).toBeGreaterThan(0);
        expect(st.summaries.cells).toBeGreaterThan(0);
      }
      if (LONG || process.env.OC_FUZZ_VERBOSE) console.log(`seed ${s}`, JSON.stringify(st));
    });
  }
});
