// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The Spreadsheet block's engine in the editor (ADR-080): crates/oc-sheet on opencalc, built to
// WASM by scripts/build-sheet-wasm.sh and fetched only when a spreadsheet block comes within a
// screen. JSON in, JSON out through linear memory, as the formula engine (ADR-078). One instance
// serves every spreadsheet block; each open block keeps its workbook in it, by block id.

/** A sheet as the block stores it: ids in order, cells keyed `rowId:colId` → stored input. */
export interface EngineSheet {
  id: string;
  name: string;
  rows: string[];
  cols: string[];
  cells: Record<string, string>;
}

/** `[sheetId, rowId, colId, display text]`. */
export type Shown = [string, string, string, string];

export interface SheetEngine {
  /** Builds and keeps a block's workbook; every cell's display. */
  open(block: string, sheets: EngineSheet[]): Shown[];
  /** Sets one stored input (empty clears); the cells whose display changed. */
  set(block: string, sheet: string, row: string, col: string, stored: string): Shown[];
  close(block: string): void;
  /** One-off compute (no kept workbook). */
  compute(sheets: EngineSheet[]): Shown[];
  /** A stored formula as A1, from the current order. */
  toA1(src: string, here: string, sheets: EngineSheet[]): string;
  /** A typed formula as stored (references as ids). */
  toIds(src: string, here: string, sheets: EngineSheet[]): string;
  /** A formula copied `dr` rows and `dc` columns away (fill, paste). */
  shift(src: string, dr: number, dc: number): string;
}

interface Exports {
  memory: WebAssembly.Memory;
  oc_alloc(len: number): number;
  oc_free(ptr: number, len: number): void;
  oc_call(op: number, ptr: number, len: number): bigint;
}

export class EngineError extends Error {}

/**
 * wasm-bindgen's placeholder imports, linked in by zip's wasm32 dependencies (getrandom, time) and
 * normally rewritten by the wasm-bindgen CLI. Nothing the engine runs calls them; if anything
 * ever does, the call fails loudly instead of returning a wrong value.
 */
const unused = (name: string) => () => {
  throw new EngineError(`sheet engine called ${name}`);
};
const BINDGEN_STUBS: WebAssembly.Imports = {
  __wbindgen_placeholder__: { __wbindgen_describe: unused("__wbindgen_describe") },
  __wbindgen_externref_xform__: {
    __wbindgen_externref_table_grow: unused("__wbindgen_externref_table_grow"),
    __wbindgen_externref_table_set_null: unused("__wbindgen_externref_table_set_null"),
    __wbindgen_externref_statics_end: unused("__wbindgen_externref_statics_end"),
  },
};

export async function instantiate(bytes: BufferSource): Promise<SheetEngine> {
  const { instance } = await WebAssembly.instantiate(bytes, BINDGEN_STUBS);
  const x = instance.exports as unknown as Exports;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const call = (op: number, input: unknown): Record<string, unknown> => {
    const inb = enc.encode(JSON.stringify(input ?? null));
    const p = x.oc_alloc(inb.length);
    new Uint8Array(x.memory.buffer, p, inb.length).set(inb);
    const r = x.oc_call(op, p, inb.length);
    x.oc_free(p, inb.length);
    const optr = Number(r >> 32n);
    const olen = Number(r & 0xffffffffn);
    const out = JSON.parse(dec.decode(new Uint8Array(x.memory.buffer, optr, olen))) as Record<string, unknown>;
    x.oc_free(optr, olen);
    if (typeof out.error === "string") throw new EngineError(out.error);
    return out;
  };
  const values = (o: Record<string, unknown>) => (o.values ?? []) as Shown[];
  return {
    compute: (sheets) => values(call(1, { sheets })),
    toA1: (src, here, sheets) => call(2, { src, here, sheets }).a1 as string,
    toIds: (src, here, sheets) => call(3, { src, here, sheets }).stored as string,
    shift: (src, dr, dc) => call(4, { src, dr, dc }).a1 as string,
    open: (block, sheets) => values(call(5, { block, sheets })),
    set: (block, sheet, row, col, stored) => values(call(6, { block, sheet, row, col, stored })),
    close: (block) => void call(7, { block }),
  };
}

let loading: Promise<SheetEngine> | null = null;

/** Where the WASM bytes come from; tests (no fetch of file URLs) set their own. */
let source = (): Promise<ArrayBuffer> =>
  fetch(new URL("./oc_sheet.wasm", import.meta.url)).then((r) => {
    if (!r.ok) throw new Error(`sheet engine: HTTP ${r.status}`);
    return r.arrayBuffer();
  });
export function setEngineSource(fn: () => Promise<ArrayBuffer>) {
  source = fn;
  loading = null;
}

/** Loads the engine once; a failed load can be retried (the promise is dropped). */
export function loadSheetEngine(): Promise<SheetEngine> {
  if (!loading) {
    loading = source()
      .then(instantiate)
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}
