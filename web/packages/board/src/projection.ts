// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Incremental projection of one board's Yjs state into `Shape[]` (DGM-05, ADR-045).
//
// v0.1.1 re-read the whole board on every change: `observeDeep` → `readShapes` (a `toJSON` of
// every shape) → `JSON.stringify` of every shape to keep unchanged ones. This class keeps the
// projected shapes and, from each transaction's events, re-reads only the shapes it touched.
// The result is always equal to `readShapes(board)` (same shapes, same paint order: `order`
// first, then shapes missing from it by id) and keeps unchanged shapes, and an unchanged list,
// as the same objects, so React skips them.
//
// It works like a `useSyncExternalStore` store: `subscribe` attaches the Yjs observers (the
// first subscriber) and detaches them (the last one leaves); `get` returns the current list.
// While nobody is subscribed nothing is tracked, so a new subscription re-checks every shape
// once (cheaply: unchanged shapes keep their objects).
import * as Y from "yjs";
import { boardsRoot, getBoardMap, type Shape } from "./model";

interface Entry {
  s: Shape;
  j: string;
}

export class BoardProjection {
  /** `reads`: shapes re-read from Yjs so far (for tests and benchmarks). */
  readonly stats = { reads: 0, rebuilds: 0 };
  private subs = new Set<() => void>();
  private board: Y.Map<unknown> | null = null;
  private attached = false;
  private cache = new Map<string, Entry>();
  private val: Shape[] | null = null;
  private built = false;
  /** Where each shape sits in `val`. */
  private pos = new Map<string, number>();
  private dirty = new Set<string>();
  /** Shape membership or `order` changed: the paint order is rebuilt. */
  private structural = false;
  /** Re-read everything (board replaced, `shapes`/`order` replaced, or re-subscribed). */
  private full = true;

  constructor(
    readonly doc: Y.Doc,
    readonly boardId: string,
  ) {}

  subscribe = (cb: () => void): (() => void) => {
    this.subs.add(cb);
    if (!this.attached) this.attach();
    return () => {
      this.subs.delete(cb);
      if (!this.subs.size) this.detach();
    };
  };

  get = (): Shape[] | null => {
    if (!this.built || this.full || this.structural || this.dirty.size) this.refresh();
    return this.val;
  };

  /* ------------------------------------------------------------ observers */

  private attach() {
    this.attached = true;
    boardsRoot(this.doc).observe(this.onRoot);
    this.bindBoard();
    this.full = true;
  }

  private detach() {
    this.attached = false;
    boardsRoot(this.doc).unobserve(this.onRoot);
    this.board?.unobserveDeep(this.onEvents);
    this.board = null;
  }

  private bindBoard() {
    const m = getBoardMap(this.doc, this.boardId);
    if (m === this.board) return;
    this.board?.unobserveDeep(this.onEvents);
    this.board = m;
    m?.observeDeep(this.onEvents);
  }

  private notify() {
    for (const cb of [...this.subs]) cb();
  }

  private onRoot = (e: Y.YMapEvent<Y.Map<unknown>>) => {
    if (!e.keysChanged.has(this.boardId)) return;
    this.bindBoard();
    this.full = true;
    this.notify();
  };

  private onEvents = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    const board = this.board;
    if (!board) return;
    const shapes = board.get("shapes");
    const order = board.get("order");
    let touched = false;
    for (const e of events) {
      const t = e.target;
      if (t === board) {
        // `shapes` or `order` replaced (other keys are not part of the projection).
        const keys = (e as Y.YMapEvent<unknown>).keysChanged;
        if (keys.has("shapes") || keys.has("order")) {
          this.full = true;
          touched = true;
        }
      } else if (t === shapes) {
        for (const k of (e as Y.YMapEvent<unknown>).keysChanged) this.dirty.add(k);
        this.structural = true;
        touched = true;
      } else if (t === order) {
        this.structural = true;
        touched = true;
      } else {
        // Inside a shape (or deeper): the path from the board starts with "shapes", <id>.
        const path = e.path;
        if (path[0] === "shapes" && path.length >= 2) {
          this.dirty.add(String(path[1]));
          touched = true;
        }
      }
    }
    if (touched) this.notify();
  };

  /* -------------------------------------------------------------- refresh */

  /** Reads one shape like `readShapes` does. `null` when it is not a shape (missing or not a map). */
  private readOne(shapes: Y.Map<unknown>, sid: string): Entry | null {
    const y = shapes.get(sid);
    if (!(y instanceof Y.Map)) return null;
    this.stats.reads++;
    const s = y.toJSON() as Shape;
    s.id = sid;
    const j = JSON.stringify(s);
    const old = this.cache.get(sid);
    return old && old.j === j ? old : { s, j };
  }

  private refresh() {
    const board = getBoardMap(this.doc, this.boardId);
    if (!this.attached) this.full = true;
    const shapes = board?.get("shapes");
    if (!board || !(shapes instanceof Y.Map)) {
      // readShapes gives [] for a board without a shapes map, null when there is no board.
      const next = board ? [] : null;
      const same = next === null ? this.val === null : !!this.val && this.val.length === 0;
      if (!same || !this.built) this.val = next;
      this.cache.clear();
      this.pos.clear();
      this.reset();
      return;
    }
    let changed = false;
    if (this.full) {
      this.stats.rebuilds++;
      const next = new Map<string, Entry>();
      for (const sid of shapes.keys()) {
        const e = this.readOne(shapes, sid);
        if (e) next.set(sid, e);
      }
      changed = next.size !== this.cache.size || [...next].some(([k, e]) => this.cache.get(k) !== e);
      this.cache = next;
      this.structural = true;
    } else {
      for (const sid of this.dirty) {
        const e = this.readOne(shapes, sid);
        const old = this.cache.get(sid);
        if (e === old) continue;
        changed = true;
        if (e) this.cache.set(sid, e);
        else this.cache.delete(sid);
        if (!e || !old) this.structural = true;
      }
    }
    const prev = this.val;
    if (this.structural || !prev) {
      const list = this.ordered(board);
      const same = !!prev && prev.length === list.length && list.every((s, i) => s === prev[i]);
      if (!same || !this.built) {
        this.val = list;
        this.pos = new Map(list.map((s, i) => [s.id, i]));
      }
    } else if (changed) {
      const list = prev.slice();
      for (const sid of this.dirty) {
        const i = this.pos.get(sid);
        const e = this.cache.get(sid);
        if (i !== undefined && e) list[i] = e.s;
      }
      this.val = list;
    }
    this.reset();
  }

  private reset() {
    this.dirty.clear();
    this.structural = false;
    this.full = false;
    this.built = true;
  }

  /** Paint order, exactly as `readShapes`: `order` (first occurrence), then the rest by id. */
  private ordered(board: Y.Map<unknown>): Shape[] {
    const order = board.get("order");
    const out: Shape[] = [];
    const seen = new Set<string>();
    const push = (sid: string) => {
      if (seen.has(sid)) return;
      const e = this.cache.get(sid);
      if (!e) return;
      seen.add(sid);
      out.push(e.s);
    };
    if (order instanceof Y.Array) for (const sid of order.toArray()) push(String(sid));
    if (seen.size < this.cache.size) [...this.cache.keys()].filter((k) => !seen.has(k)).sort().forEach(push);
    return out;
  }
}
