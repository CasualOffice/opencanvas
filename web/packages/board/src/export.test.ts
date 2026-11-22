// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// node:fs through a computed specifier: this package has no Node typings.
interface Fs { readFileSync(p: string, enc: "utf8"): string; writeFileSync(p: string, s: string): void }
const { readFileSync, writeFileSync } = (await import(/* @vite-ignore */ ["node", "fs"].join(":"))) as Fs;
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { exportBoardSvg, shapesToSvg } from "./export";
import type { Shape } from "./model";

// Shared with the Rust renderer (`crates/oc-model/tests/board.rs`): both must produce
// `board.web.svg` byte for byte from `board.json`. Regenerate with OC_UPDATE_FIXTURE=1.
const FIX = decodeURIComponent(new URL("../../../../crates/oc-model/tests/fixtures/", import.meta.url).pathname);
const UPDATE = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.OC_UPDATE_FIXTURE;

function fixtureDoc(): Y.Doc {
  const board = JSON.parse(readFileSync(FIX + "board.json", "utf8")) as { order: string[]; shapes: Record<string, Record<string, unknown>> };
  const doc = new Y.Doc();
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    doc.getMap("boards").set("b1", m);
    const shapes = new Y.Map<Y.Map<unknown>>();
    for (const [id, s] of Object.entries(board.shapes)) {
      const y = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(s)) y.set(k, v);
      shapes.set(id, y);
    }
    m.set("shapes", shapes);
    const order = new Y.Array<string>();
    order.push(board.order);
    m.set("order", order);
  });
  return doc;
}

const svgOf = (...shapes: Omit<Shape, "id">[]) => shapesToSvg(shapes.map((s, i) => ({ id: "s" + i, ...s }) as Shape));
const texts = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

describe("board export: shared fixture", () => {
  it("matches the fixture the Rust renderer is checked against, byte for byte", () => {
    const svg = exportBoardSvg(fixtureDoc(), "b1").replace(/ocbd-x-clip-\d+/g, "ocbd-x-clip-1");
    if (UPDATE) writeFileSync(FIX + "board.web.svg", svg);
    expect(svg).toBe(readFileSync(FIX + "board.web.svg", "utf8"));
  });
});

describe("board export: UX pass keys", () => {
  it("fills rect / ellipse / diamond with a tone (outline follows the tone)", () => {
    const svg = svgOf(
      { type: "rect", x: 0, y: 0, w: 100, h: 50, fill: "blue" },
      { type: "ellipse", x: 0, y: 60, w: 100, h: 50, fill: "green" },
      { type: "diamond", x: 0, y: 120, w: 100, h: 50, fill: "amber" },
    );
    expect(svg).toContain(`fill="#e6eefd" stroke="#2350c8"`);
    expect(svg).toContain(`fill="#e2f3e8" stroke="#17703f"`);
    expect(svg).toContain(`fill="#fcf0d9" stroke="#8f5300"`);
  });

  it("maps every tone, ignores unknown ones and keeps frames unfilled", () => {
    const tones: Record<string, [string, string]> = {
      gray: ["#efefed", "#55555c"], blue: ["#e6eefd", "#2350c8"], green: ["#e2f3e8", "#17703f"], amber: ["#fcf0d9", "#8f5300"],
      red: ["#fde6e6", "#b12424"], purple: ["#efe8fd", "#6538c4"], pink: ["#fce6f0", "#ad2c66"],
    };
    for (const [t, [bg, fg]] of Object.entries(tones)) expect(svgOf({ type: "rect", x: 0, y: 0, w: 10, h: 10, fill: t })).toContain(`fill="${bg}" stroke="${fg}"`);
    expect(svgOf({ type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "zz", stroke: "accent" })).toContain(`fill="#ffffff" stroke="#2a5ad7"`);
    expect(svgOf({ type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "blue", dashed: true })).toContain(`fill="none" stroke="#8b8b95"`);
    const odd = svgOf({ type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "constructor" }, { type: "sticky", x: 0, y: 0, w: 10, h: 10, fill: "toString" });
    expect(odd).toContain(`fill="#ffffff" stroke="#55555e"`);
    expect(odd).toContain(`fill="#fdeaa0"`);
  });

  it("uses the shape's text size and its line height", () => {
    const svg = svgOf({ type: "rect", x: 0, y: 0, w: 300, h: 100, size: 20, text: "a\nb" }, { type: "ellipse", x: 0, y: 200, w: 300, h: 100, text: "c" });
    expect(svg).toContain(`font-size="20"`);
    // lh = round(20 * 1.3) = 26; first baseline = 50 + 20 * 0.36 - 13
    expect(svg).toContain(`<text x="150" y="44.2" font-size="20" text-anchor="middle" fill="#18181b">a</text><text x="150" y="70.2"`);
    expect(svg).toContain(`font-size="15" font-weight="600"`);
  });

  it("wraps shape and sticky text to the shape width", () => {
    const svg = svgOf({ type: "rect", x: 0, y: 0, w: 100, h: 100, text: "one two three four five six" });
    expect(texts(svg)).toEqual(["one two", "three four", "five six"]);
    const st = svgOf({ type: "sticky", x: 0, y: 0, w: 150, h: 300, text: "Wrap this fairly long sticky note text please" });
    // (150 - 2 * 14) / (14 * 0.56) → 15 characters a line
    expect(texts(st)).toEqual(["Wrap this", "fairly long", "sticky note", "text please"]);
  });

  it("grows a sticky to fit its text", () => {
    const svg = svgOf({ type: "sticky", x: 0, y: 0, w: 150, h: 60, text: "a\nb\nc\nd" });
    // 30 + 3 * 20 + 22 = 112
    expect(svg).toContain(`<rect x="0" y="0" width="150" height="112" rx="6" fill="#fdeaa0"/>`);
    expect(svg).toContain(`height="176"`); // picture: 112 + 4 (shadow excluded) + 2 * 32 pad
  });

  it("draws a connector label in a pill at the path midpoint", () => {
    const svg = svgOf({ type: "arrow", pts: [[0, 0], [100, 0], [100, 100]], text: " yes <ok> " });
    // midpoint of a 200-long path = (100, 0); one line of 8 chars: 8 * 7 + 14 = 70 wide, 22 high
    expect(svg).toContain(`<rect x="65" y="-11" width="70" height="22" rx="6" fill="#fbfbfa" stroke="#181820" stroke-opacity="0.15"/><text x="100" y="4" font-size="12.5" font-weight="500" text-anchor="middle" fill="#55555e">yes &lt;ok&gt;</text>`);
    expect(svgOf({ type: "arrow", pts: [[0, 0], [10, 0]], text: "  " })).not.toContain("#fbfbfa");
  });

  it("paints shapes in layer order", () => {
    const doc = fixtureDoc();
    const svg = exportBoardSvg(doc, "b1");
    expect(svg.indexOf(">Below<")).toBeLessThan(svg.indexOf(">On top<"));
  });

  it("routes elbow connectors orthogonally", () => {
    const svg = svgOf(
      { type: "rect", x: 0, y: 0, w: 100, h: 50 },
      { type: "rect", x: 300, y: 200, w: 100, h: 50 },
      { type: "arrow", pts: [[0, 0], [1, 1]], route: "elbow", start: { shapeId: "s0", anchor: "right" }, end: { shapeId: "s1", anchor: "left" } },
    );
    expect(svg).toContain(`d="M100 25 L200 25 L200 225 L300 225"`);
  });

  it("escapes text and drops characters XML can't carry", () => {
    const svg = svgOf({ type: "arrow", pts: [[0, 0], [100, 0]], text: `a&"\u0007` }, { type: "rect", x: 0, y: 0, w: 300, h: 40, text: "<b>" });
    expect(svg).toContain(">a&amp;&quot;</text>");
    expect(svg).toContain(">&lt;b&gt;</text>");
  });
});
