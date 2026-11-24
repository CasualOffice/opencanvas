// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @opencanvas/block-sdk (BSDK-04): defineBlock reaches the frame runtime, the harness behaves like
// it, and the two samples work: edits, read only, members, the stored overall progress. The
// committed sample packages match a fresh build (scripts/build-samples.mjs --check).
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { defineBlock, defineMigrations, h } from "./index";
import { createHarness } from "./harness";
import { progress } from "../samples/progress/block";
import { okr, overall } from "../samples/okr/block";

const ROOT = resolve(__dirname, "../../../..");

afterEach(() => {
  delete (globalThis as { OpenCanvasBlock?: unknown }).OpenCanvasBlock;
  document.body.replaceChildren();
});

describe("defineBlock", () => {
  it("hands the definition to the frame runtime, and says so outside one", () => {
    const got: unknown[] = [];
    (globalThis as { OpenCanvasBlock?: unknown }).OpenCanvasBlock = { define: (d: unknown) => got.push(d), defineMigrations: (m: unknown) => got.push(m) };
    const def = { render() {} };
    expect(defineBlock(def)).toBe(def);
    const m = { 1: (attrs: Record<string, unknown>, data: Record<string, unknown>) => ({ attrs, data }) };
    defineMigrations(m);
    expect(got).toEqual([def, m]);
    delete (globalThis as { OpenCanvasBlock?: unknown }).OpenCanvasBlock;
    expect(() => defineBlock(def)).toThrow(/not running in an OpenCanvas block frame/);
  });
  it("h builds elements without HTML parsing", () => {
    const el = h("p", { className: "x", attrs: { "aria-label": "L" } }, "<b>not bold</b>", null, h("i"));
    expect(el.outerHTML).toBe('<p class="x" aria-label="L">&lt;b&gt;not bold&lt;/b&gt;<i></i></p>');
  });
});

describe("oc.progress", () => {
  it("edits its value and hides the slider for viewers", async () => {
    const t = createHarness(progress, { attrs: { label: "Launch", value: 0.25 } });
    expect(t.el.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("25");
    const slider = t.el.querySelector<HTMLInputElement>('input[type="range"]')!;
    slider.value = "60";
    slider.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(t.attrs()).toEqual({ label: "Launch", value: 0.6 });
    t.change({ attrs: t.attrs(), role: "view" });
    expect(slider.hidden).toBe(true);
    expect(t.el.querySelector<HTMLInputElement>('input[type="text"]')!.readOnly).toBe(true);
  });
});

describe("acme.okr", () => {
  const members = [
    { id: "u_jw", name: "Jonas Weber", avatar: null },
    { id: "u_lf", name: "Lea Fischer", avatar: null },
  ];

  it("adds a key result, stores the overall progress and assigns owners from the members", async () => {
    const t = createHarness(okr, { attrs: { objective: "Make admin sign-in fast", progress: 0, krs: [] }, permissions: { network: [], members: "read" }, members });
    await new Promise((r) => setTimeout(r, 0));
    t.el.querySelector<HTMLButtonElement>("button")!.click();
    await Promise.resolve();
    expect(t.attrs().krs).toEqual([{ title: "New key result", progress: 0 }]);
    t.change({ attrs: t.attrs() });
    const range = t.el.querySelector<HTMLInputElement>('input[aria-label="Progress of key result 1"]')!;
    range.value = "60";
    range.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(t.attrs().progress).toBe(0.6);
    t.change({ attrs: t.attrs() });
    const owner = t.el.querySelector<HTMLSelectElement>('select[aria-label="Owner of key result 1"]')!;
    expect([...owner.options].map((o) => o.textContent)).toEqual(["No owner", "Jonas Weber", "Lea Fischer"]);
    owner.value = "u_lf";
    owner.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect((t.attrs().krs as { owner?: string }[])[0].owner).toBe("u_lf");
    expect(overall([{ title: "a", progress: 0.62 }, { title: "b", progress: 0.4 }, { title: "c", progress: 0.85 }])).toBe(0.62);
  });

  it("has no controls for viewers and no member list without the permission", async () => {
    const t = createHarness(okr, { role: "view", attrs: { objective: "Read only", progress: 0.5, krs: [{ title: "KR", progress: 0.5 }] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.el.querySelector<HTMLButtonElement>("button")!.hidden).toBe(true);
    expect(t.el.querySelector("select")).toBeNull();
    await expect(t.ctx.setAttrs({ objective: "x" })).rejects.toThrow(/read only/);
    await expect(t.ctx.members.list()).rejects.toThrow(/may not see the member list/);
  });
});

describe("the committed sample packages", () => {
  it("match a fresh build, with the bundle's sha384 in block.json", () => {
    execFileSync(process.execPath, [resolve(__dirname, "../scripts/build-samples.mjs"), "--check"], { stdio: "pipe" });
    for (const dir of ["crates/oc-server/blocks/oc.progress", "examples/blocks/acme.okr"]) {
      const m = JSON.parse(readFileSync(resolve(ROOT, dir, "block.json"), "utf8"));
      const sri = "sha384-" + createHash("sha384").update(readFileSync(resolve(ROOT, dir, m.entry))).digest("base64");
      expect(m.integrity).toBe(sri);
    }
  });
});
