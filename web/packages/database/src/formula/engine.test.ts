// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DB-A1: the WASM engine gives exactly the native results on the shared vectors
// (crates/oc-formula/tests/vectors.json, checked natively by tests/vectors.rs).

import { describe, expect, it } from "vitest";
import { instantiate } from "./engine";

// node:fs through a computed specifier: this package has no Node typings.
interface Fs { readFileSync(p: URL, enc?: "utf8"): Uint8Array<ArrayBuffer> & string }
const { readFileSync } = (await import(/* @vite-ignore */ ["node", "fs"].join(":"))) as Fs;

const root = new URL("../../../../../", import.meta.url);
const wasm = readFileSync(new URL("web/packages/database/src/formula/oc_formula.wasm", root));
const vectors = JSON.parse(readFileSync(new URL("crates/oc-formula/tests/vectors.json", root), "utf8"));

describe("formula engine (WASM)", () => {
  it("matches the native engine on every shared vector", async () => {
    const e = await instantiate(wasm);
    const out = e.vectors(vectors);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(500);
    const bad = vectors.cases.map((c: { src: string; out: unknown }, i: number) => ({ src: c.src, want: c.out, got: out[i] })).filter((x: { want: unknown; got: unknown }) => JSON.stringify(x.want) !== JSON.stringify(x.got));
    expect(bad).toEqual([]);
  });

  it("checks as you type, normalises names, computes a cycle as #CYCLE", async () => {
    const e = await instantiate(wasm);
    const fields = [
      { id: "p", name: "Price", type: "number" },
      { id: "a", name: "A", type: "formula", formula: 'prop("B")' },
      { id: "b", name: "B", type: "formula", formula: 'prop("A")' },
    ];
    expect(e.check({ fields, formula: 'round(prop("Price"), 1)' })).toEqual({ ok: true, type: "number", normalized: 'ROUND(prop("Price"), 1)' });
    const bad = e.check({ fields, formula: 'IF(TRUE, 1, "x")' });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("#TYPE");
    expect(bad.error?.pos).toBe(12);
    const out = e.compute({ fields, rows: [{ id: "r", v: { p: 2 } }] });
    expect(out.fields.a.error?.code).toBe("#CYCLE");
    expect(e.functions().some((f) => f.name === "DATEADD")).toBe(true);
    expect(e.rename('prop("Price") * 2', "Price", "Cost")).toBe('prop("Cost") * 2');
  });
});
