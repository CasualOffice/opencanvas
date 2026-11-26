// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The formula engine in the editor (ADR-078): the same Rust crate as the server
// (crates/oc-formula), built to WASM by scripts/build-formula-wasm.sh and fetched lazily, only
// when a database has formula or rollup fields. JSON in, JSON out through linear memory.

export interface FormulaError {
  code: "#TYPE" | "#REF" | "#DIV/0" | "#CYCLE" | "#LIMIT";
  msg: string;
  /** UTF-16 offset in the formula. */
  pos: number;
}

/** A computed value: number, text, boolean, `YYYY-MM-DD`, list, null (empty) or an error. */
export type FValue = number | string | boolean | null | FValue[] | { err: FormulaError["code"]; msg: string };

export interface ComputeOut {
  fields: Record<string, { type?: string; error?: FormulaError }>;
  rows: Record<string, Record<string, FValue>>;
}

export interface CheckOut {
  ok: boolean;
  type?: string;
  error?: FormulaError;
  normalized: string;
}

export interface FuncDoc {
  name: string;
  sig: string;
  doc: string;
}

export interface Engine {
  compute(input: unknown): ComputeOut;
  check(input: { fields: unknown[]; id?: string; formula: string }): CheckOut;
  functions(): FuncDoc[];
  normalize(src: string): string;
  rename(src: string, old: string, next: string): string;
  vectors(v: unknown): unknown[];
}

interface Exports {
  memory: WebAssembly.Memory;
  oc_alloc(len: number): number;
  oc_free(ptr: number, len: number): void;
  oc_call(op: number, ptr: number, len: number): bigint;
}

export async function instantiate(bytes: BufferSource): Promise<Engine> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports as unknown as Exports;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const call = (op: number, input: unknown): unknown => {
    const inb = enc.encode(JSON.stringify(input ?? null));
    const p = x.oc_alloc(inb.length);
    new Uint8Array(x.memory.buffer, p, inb.length).set(inb);
    const r = x.oc_call(op, p, inb.length);
    x.oc_free(p, inb.length);
    const optr = Number(r >> 32n);
    const olen = Number(r & 0xffffffffn);
    const text = dec.decode(new Uint8Array(x.memory.buffer, optr, olen));
    x.oc_free(optr, olen);
    return JSON.parse(text);
  };
  return {
    compute: (i) => call(0, i) as ComputeOut,
    check: (i) => call(1, i) as CheckOut,
    functions: () => call(2, null) as FuncDoc[],
    normalize: (src) => call(3, { src }) as string,
    rename: (src, old, next) => call(4, { src, old, new: next }) as string,
    vectors: (v) => call(5, v) as unknown[],
  };
}

let loading: Promise<Engine> | null = null;

/** Loads the engine once; a failed load can be retried (the promise is dropped). */
export function loadEngine(): Promise<Engine> {
  if (!loading) {
    loading = fetch(new URL("./oc_formula.wasm", import.meta.url))
      .then((r) => {
        if (!r.ok) throw new Error(`formula engine: HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then(instantiate)
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}

export const isErr = (v: FValue | undefined): v is { err: FormulaError["code"]; msg: string } =>
  !!v && typeof v === "object" && !Array.isArray(v) && "err" in v;
