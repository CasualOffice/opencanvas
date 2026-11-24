// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The sandbox's editor side (BSDK-03): the JSON Schema checks match the Rust validator on the
// shared cases; every write from a block is checked for role, rate and schema; the crash-loop
// guard (decision 4); a new block's attrs start valid; the saved copy never renders HTML.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Schema } from "./schema";
import { Bucket, initialAttrs, merge, WriteGate, WRITE_RATE } from "./runtime";
import { crashLoop, canDo, noteCrash } from "./Chrome";
import { SavedCopy } from "./SavedCopy";

const FIX = JSON.parse(readFileSync(resolve(__dirname, "../../../../../crates/oc-model/tests/fixtures/ext.json"), "utf8"));

describe("schema checks (same results as oc_model::ext::schema)", () => {
  it("gives the shared findings", () => {
    for (const c of FIX.schemas) {
      const got = Schema.compile(c.schema).validate(c.value).map(([p, m]) => `${p}: ${m}`);
      expect(got, JSON.stringify(c.schema)).toEqual(c.errors);
    }
  });
  it("refuses what the server refuses", () => {
    for (const s of FIX.schemas_refused) expect(() => Schema.compile(s), JSON.stringify(s)).toThrow();
  });
});

const PKG = {
  attrs: { type: "object", additionalProperties: false, properties: { objective: { type: "string", maxLength: 20, default: "New" }, progress: { type: "number", minimum: 0, maximum: 1 } }, required: ["objective"] },
  data: { type: "object", properties: { score: { type: "integer" } }, additionalProperties: false },
};

describe("writes from a block", () => {
  it("checks the role, the schema and merges patches (null removes)", () => {
    const g = new WriteGate(PKG, () => 0);
    expect(() => g.attrsWrite("view", { objective: "a" }, { objective: "b" })).toThrow(/read only/);
    expect(() => g.attrsWrite("comment", { objective: "a" }, { objective: "b" })).toThrow(/read only/);
    expect(g.attrsWrite("edit", { objective: "a", progress: 0.2 }, { progress: null })).toEqual({ objective: "a" });
    expect(() => g.attrsWrite("edit", { objective: "a" }, { progress: 3 })).toThrow(/\/progress must be at most 1/);
    expect(() => g.attrsWrite("edit", { objective: "a" }, { evil: "<script>" })).toThrow(/\/evil is not an allowed property/);
    expect(() => g.attrsWrite("edit", { objective: "a" }, "x")).toThrow(/takes an object/);
    expect(g.dataWrite("edit", { score: 1 }, { score: 2 })).toEqual({ score: 2 });
    expect(() => g.dataWrite("edit", {}, { score: "lots" })).toThrow(/data doesn't match/);
    expect(() => new WriteGate({ attrs: PKG.attrs }).dataWrite("edit", {}, { a: 1 })).toThrow(/declares no data/);
    expect(merge({ a: 1, b: 2 }, { b: null, c: 3 })).toEqual({ a: 1, c: 3 });
  });

  it("allows 60 writes a second, then refuses until the bucket refills", () => {
    let now = 0;
    const g = new WriteGate(PKG, () => now);
    let ok = 0;
    for (let i = 0; i < 100; i++) {
      try {
        g.attrsWrite("edit", { objective: "a" }, { progress: 0 });
        ok++;
      } catch (e) {
        expect(String(e)).toMatch(/rate limited/);
      }
    }
    expect(ok).toBe(WRITE_RATE);
    now = 500; // half a second later: half the bucket
    const b = new Bucket(WRITE_RATE, () => now);
    for (let i = 0; i < WRITE_RATE; i++) b.take();
    expect(b.take()).toBe(false);
    now = 1000;
    expect(b.take()).toBe(true);
  });

  it("starts a new block from the schema's defaults so its first write is valid", () => {
    const a = initialAttrs(PKG.attrs);
    expect(a).toEqual({ objective: "New" });
    expect(Schema.compile(PKG.attrs).validate(a)).toEqual([]);
    expect(initialAttrs({ type: "object", required: ["n", "s", "b", "l"], properties: { n: { type: "integer", minimum: 1 }, s: { type: "string" }, b: { type: "boolean" }, l: { type: "array" } } })).toEqual({ n: 1, s: "", b: false, l: [] });
  });
});

describe("chrome rules", () => {
  it("decision 4: three crashes in a minute lock Reload block for 30 s", () => {
    const id = "b_loop";
    expect(crashLoop(id, 0).locked).toBe(false);
    noteCrash(id, 1_000);
    noteCrash(id, 2_000);
    expect(crashLoop(id, 2_500).locked).toBe(false);
    noteCrash(id, 3_000);
    expect(crashLoop(id, 3_500)).toEqual({ locked: true, until: 33_000 });
    expect(crashLoop(id, 33_001).locked).toBe(false);
    // Crashes older than a minute no longer count.
    noteCrash(id, 100_000);
    expect(crashLoop(id, 100_500).locked).toBe(false);
  });
  it("says what a block can do in plain words (3a)", () => {
    expect(canDo({ type: "a.b", version: "1.0.0", v: 1, title: "T", content: "none", attrs: {}, entry: null, integrity: "", permissions: { network: ["https://okr.acme.example"], members: "read" } })).toEqual([
      "Connect to okr.acme.example",
      "See the names and pictures of people in this canvas, not their e-mail",
    ]);
    expect(canDo({ type: "a.b", version: "1.0.0", v: 1, title: "T", content: "none", attrs: {}, entry: null, integrity: "" })).toEqual([]);
  });
  it("draws the saved copy as text: no HTML from the document reaches the DOM", () => {
    const html = renderToStaticMarkup(createElement(SavedCopy, { md: "**Ship** <img src=x onerror=alert(1)> [x](javascript:alert(1))\n\n- one\n- two\n\n# Head\n\\*not bold\\*" }));
    expect(html).toContain("<b>Ship</b>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain('<p class="h">Head</p>');
    expect(html).toContain("*not bold*");
  });
});
