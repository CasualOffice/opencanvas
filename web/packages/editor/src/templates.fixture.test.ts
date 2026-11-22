// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
//
// FC-07: every built-in template loads. This builds each template exactly as the gallery
// does (buildDoc + the database/board presets) and compares the result with the committed
// fixture crates/oc-model/tests/fixtures/templates.json, which the Rust test
// `templates.rs` passes through oc_model::validate and the .ocanvas round trip.
// Ids and dates are made deterministic. After changing a template, regenerate with
//   OC_UPDATE_FIXTURES=1 pnpm --filter @opencanvas/editor test templates.fixture
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Y from "yjs";
import { TPL } from "./templates";
import { buildDoc } from "./editor/content";

// Tests run from the package directory (web/packages/editor).
const FIXTURE = resolve(process.cwd(), "../../../crates/oc-model/tests/fixtures/templates.json");

let seed = 1;
beforeAll(() => {
  vi.useFakeTimers({ now: new Date("2026-11-23T09:00:00Z"), toFake: ["Date"] });
  vi.spyOn(Math, "random").mockImplementation(() => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  });
});
afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function build(t: (typeof TPL)[number]) {
  seed = 1;
  const doc = new Y.Doc();
  const content = await buildDoc(t.blocks, { doc, me: { id: "u_me", name: "Template User" } });
  return {
    type: "doc",
    content: content.content,
    meta: { title: t.name, icon: t.icon, tone: t.tone, template: t.id },
    databases: doc.getMap("databases").toJSON(),
    boards: doc.getMap("boards").toJSON(),
    comments: {},
  };
}

describe("FC-07: built-in templates", () => {
  it("builds all 40 templates and matches the fixture the Rust validator reads", async () => {
    expect(TPL).toHaveLength(40);
    const out: Record<string, unknown> = {};
    for (const t of TPL) out[t.id] = await build(t);
    const json = JSON.stringify(out, null, 1) + "\n";
    if (process.env.OC_UPDATE_FIXTURES || !existsSync(FIXTURE)) writeFileSync(FIXTURE, json);
    // Stale fixture: rerun with OC_UPDATE_FIXTURES=1 (see the top of this file).
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(JSON.parse(json));
  });
});
