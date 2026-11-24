// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Declarative block migrations (BSDK-05, docs/15 §4.2), as `oc_model::ext::migrate` in Rust:
// steps from each data version to the next over `{attrs, data}` with JSON-pointer paths
// (`/attrs/title`, `/data/score`). Ops: set, default, remove, move, copy, map, scale. A step
// whose source is missing does nothing. Shared cases: crates/oc-model/tests/fixtures/ext.json.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

export type Step =
  | { op: "set" | "default"; path: string; value: Json }
  | { op: "remove"; path: string }
  | { op: "move" | "copy"; from: string; path: string }
  | { op: "map"; path: string; values: Obj }
  | { op: "scale"; path: string; by: number };

/** `migrations` of a manifest: steps per version, or a script for the sandbox (BSDK-03). */
export type Migrations = Record<string, Step[]> | string | null | undefined;

const OPS = ["set", "default", "remove", "move", "copy", "map", "scale"];

function pointer(p: unknown, what: string): string[] {
  if (typeof p !== "string" || !p.startsWith("/")) throw new Error(`${what} must start with /attrs/ or /data/`);
  const segs = p.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segs.length < 2 || (segs[0] !== "attrs" && segs[0] !== "data") || segs.some((s) => !s)) throw new Error(`${what} ${JSON.stringify(p)} must name a field under /attrs/ or /data/`);
  return segs;
}

/** Throws on a step the Rust parser would refuse. */
export function checkStep(s: Step): void {
  if (!OPS.includes(s.op)) throw new Error(`unknown op ${JSON.stringify(s.op)}`);
  pointer(s.path, "path");
  if (s.op === "move" || s.op === "copy") pointer(s.from, "from");
  if (s.op === "map" && (!s.values || typeof s.values !== "object" || Array.isArray(s.values))) throw new Error("map needs a values object");
  if (s.op === "scale" && !Number.isFinite(s.by)) throw new Error("scale needs a number by");
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function get(doc: Obj, path: string[]): Json | undefined {
  let v: Json | undefined = doc;
  for (const k of path) {
    if (!isObj(v) || !Object.prototype.hasOwnProperty.call(v, k)) return undefined;
    v = v[k];
  }
  return v;
}

function take(doc: Obj, path: string[]): Json | undefined {
  const parent = get(doc, path.slice(0, -1));
  const last = path[path.length - 1];
  if (!isObj(parent) || !Object.prototype.hasOwnProperty.call(parent, last)) return undefined;
  const v = parent[last];
  delete parent[last];
  return v;
}

function put(doc: Obj, path: string[], value: Json): void {
  let v: Obj = doc;
  for (const k of path.slice(0, -1)) {
    if (!isObj(v[k])) v[k] = {};
    v = v[k] as Obj;
  }
  v[path[path.length - 1]] = value;
}

function apply(doc: Obj, s: Step): void {
  const p = pointer(s.path, "path");
  switch (s.op) {
    case "set":
      put(doc, p, structuredClone(s.value));
      break;
    case "default": {
      const cur = get(doc, p);
      if (cur === undefined || cur === null) put(doc, p, structuredClone(s.value));
      break;
    }
    case "remove":
      take(doc, p);
      break;
    case "move": {
      const v = take(doc, pointer(s.from, "from"));
      if (v !== undefined) put(doc, p, v);
      break;
    }
    case "copy": {
      const v = get(doc, pointer(s.from, "from"));
      if (v !== undefined) put(doc, p, structuredClone(v));
      break;
    }
    case "map": {
      const cur = get(doc, p);
      if (typeof cur === "string" && Object.prototype.hasOwnProperty.call(s.values, cur)) put(doc, p, structuredClone(s.values[cur]));
      break;
    }
    case "scale": {
      const cur = get(doc, p);
      if (typeof cur === "number") put(doc, p, cur * s.by);
      break;
    }
  }
}

/** True when every step from `from` to `to` is declared, or a script covers them. */
export function covers(m: Migrations, from: number, to: number): boolean {
  if (typeof m === "string") return true;
  if (!m) return from >= to;
  for (let v = from; v < to; v++) if (!Array.isArray(m[String(v)])) return false;
  return true;
}

/** Runs the steps from `from` to `to`; throws when a step is missing or the migrations are
 *  a script (those run in the block's sandbox, BSDK-03). */
export function migrate(m: Migrations, from: number, to: number, attrs: unknown, data: unknown): { attrs: Obj; data: Obj } {
  const doc: Obj = { attrs: isObj(attrs) ? structuredClone(attrs) : {}, data: isObj(data) ? structuredClone(data) : {} };
  if (from < to) {
    if (typeof m === "string") throw new Error("this block migrates in its sandbox");
    for (let v = from; v < to; v++) {
      const steps = m?.[String(v)];
      if (!Array.isArray(steps)) throw new Error(`no migration from version ${v}`);
      for (const s of steps) apply(doc, s);
    }
  }
  return { attrs: doc.attrs as Obj, data: doc.data as Obj };
}
