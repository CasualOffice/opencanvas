// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Product screenshots for the website: the real OpenCanvas editor in its demo mode
// (`#demo`: a local Yjs document seeded with the "Sprint 42 planning" canvas and
// simulated collaborators, no server), driven by Playwright, in light and dark, at device
// scale 2 so they stay sharp on high-density screens. Raw PNGs go to an output
// directory; then tools/build-site.py --screens turns them into
// site/assets/screens/*.webp and .png. No mock-ups: every image is the editor itself.
//
// Ported from OpenSeal's tools/capture-site-screens.mjs (same flow and options).
//
//   cd web && OC_EDITOR_BASE=./ pnpm --filter @opencanvas/editor build && cd ..
//   python3 -I tools/serve-site.py 8700 &               # the published tree, editor at /app/
//   node tools/capture-site-screens.mjs [--only a,b] [OUT] [BASE]
//   python3 tools/build-site.py --screens OUT && python3 tools/build-site.py
//
// OUT defaults to target/site-screens, BASE to http://127.0.0.1:8700/app/.
// Scenes (the name is the file the site uses, site/assets/screens/NAME-{light,dark}.*):
//   canvas      the demo canvas at the top: callout, decisions with live cursors, the backlog
//   database    the backlog database in its board (kanban) view
//   whiteboard  the whiteboard block "How a session flows"
//   templates   the template gallery
//   comments    the canvas with the comments panel open
//   phone       the demo canvas at 390 x 844
//   assistant-plan          the assistant's plan card for the selected meeting notes (the
//                           demo's scripted run: "Demo: a scripted run, no AI server")
//   assistant-review        after Run: the new Tasks database, inline suggestions, review bar
//   assistant-phone-plan    the same plan in the phone sheet, 390 x 844
//   assistant-phone-review  the same review on a phone
// A scene that fails is named and the run exits non-zero; the others are still written.
// Uses the e2e harness's Playwright (`cd e2e && npm ci`). Headless only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argv = process.argv.slice(2);
let only = null;
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--only") only = new Set((argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean));
  else pos.push(argv[i]);
}
const OUT = path.resolve(pos[0] || path.join(ROOT, "target/site-screens"));
const BASE = pos[1] || "http://127.0.0.1:8700/app/";
const PW = path.join(ROOT, "e2e/node_modules/playwright/index.mjs");
if (!fs.existsSync(PW)) {
  console.error("capture-site-screens: Playwright is not installed; run `npm ci` in e2e/");
  process.exit(1);
}
const { chromium } = await import(pathToFileURL(PW).href);

const SCENES = ["canvas", "database", "whiteboard", "templates", "comments", "phone",
  "assistant-plan", "assistant-review", "assistant-phone-plan", "assistant-phone-review"];
if (only) {
  const unknown = [...only].filter((s) => !SCENES.includes(s));
  if (unknown.length) { console.error(`capture-site-screens: unknown scene(s) ${unknown.join(", ")}; known: ${SCENES.join(", ")}`); process.exit(2); }
}
const want = (s) => !only || only.has(s);

fs.mkdirSync(OUT, { recursive: true });
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function settle(page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity), null, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

/// The demo canvas, loaded, with its first simulated edits and the autosave settled and
/// the "is typing" toast gone, so the shot shows a calm, real state.
async function openDemo(page, scheme) {
  await page.goto(`${BASE}#demo&theme=${scheme}`);
  await page.getByText("Sprint goal").first().waitFor({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Board" }).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(6500);
  await page.getByText(/is typing in/).first().waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
}

/// The assistant scenes: the demo with its meeting-notes list selected, as the browser
/// suite does (e2e/assistant-helpers.ts); `#demo` exposes the editor as __ocEditor.
async function selectNotes(page) {
  await page.locator(".ProseMirror li", { hasText: "Ravi to finish the embed SDK docs" }).first().waitFor({ timeout: 30_000 });
  await page.evaluate(() => {
    const ed = window.__ocEditor;
    let r = { from: 0, to: 0 };
    ed.state.doc.descendants((n, pos) => {
      if (n.type.name === "bulletList" && n.textContent.includes("Ravi to finish")) {
        r = { from: pos + 1, to: pos + n.nodeSize - 1 };
        return false;
      }
      return true;
    });
    ed.chain().focus().setTextSelection(r).run();
  });
  await page.waitForTimeout(500);
}

const failures = [];

async function run(scheme) {
  const browser = await chromium.launch({ headless: true });
  const shot = async (page, name) => {
    const vp = page.viewportSize();
    await page.mouse.move(vp.width - 2, Math.round(vp.height * 0.6));
    await settle(page);
    await page.screenshot({ path: path.join(OUT, `${scheme}-${name}.png`), animations: "disabled" });
    console.log(`  ${scheme}-${name}`);
  };
  const scene = async (name, viewport, fn) => {
    if (!want(name)) return;
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: scheme, locale: "en-US",
      timezoneId: "Europe/Amsterdam", isMobile: viewport === PHONE, hasTouch: viewport === PHONE });
    try {
      const page = await ctx.newPage();
      await openDemo(page, scheme);
      await fn(page);
    } catch (err) {
      failures.push(`${scheme} ${name}: ${String(err.message || err).split("\n")[0]}`);
      console.error(`  ${scheme}-${name}: FAILED`);
    } finally {
      await ctx.close();
    }
  };
  /// Scroll so `locator` sits `top` px below the editor's top bar.
  const scrollTo = async (page, locator, top = 120) => {
    await locator.evaluate((el, t) => {
      let s = el.parentElement;
      while (s && !(s.scrollHeight > s.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
      const box = el.getBoundingClientRect();
      if (s) s.scrollBy(0, box.top - t);
      else window.scrollBy(0, box.top - t);
    }, top);
    await page.waitForTimeout(500);
  };

  await scene("canvas", DESK, async (page) => {
    await shot(page, "canvas");
  });

  await scene("database", DESK, async (page) => {
    const tab = page.getByRole("tab", { name: "Board", exact: true }).first();
    await scrollTo(page, tab, 150);
    await tab.click();
    await page.waitForTimeout(800);
    await shot(page, "database");
  });

  await scene("whiteboard", DESK, async (page) => {
    await scrollTo(page, page.getByRole("heading", { name: "How a session flows" }).first(), 90);
    await page.getByRole("button", { name: "Pen" }).first().waitFor();
    await page.waitForTimeout(800);
    await shot(page, "whiteboard");
  });

  await scene("templates", DESK, async (page) => {
    await page.getByRole("button", { name: "Templates" }).first().click();
    await page.getByText(/blank/i).first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1200);
    await shot(page, "templates");
  });

  await scene("comments", DESK, async (page) => {
    await page.getByRole("button", { name: "Comments" }).first().click();
    await page.waitForTimeout(1200);
    await shot(page, "comments");
  });

  await scene("phone", PHONE, async (page) => {
    await shot(page, "phone");
  });

  /// Desktop: Ask Assistant on the selection, the first action, then the plan card.
  const desktopPlan = async (page) => {
    await selectNotes(page);
    await page.getByRole("button", { name: "Ask Assistant" }).first().click();
    const bar = page.getByRole("dialog", { name: "Ask the assistant about the selection" });
    await bar.getByRole("option").first().click();
    const plan = page.getByRole("dialog", { name: "The assistant's plan" });
    await plan.getByText("Here's the plan").waitFor({ timeout: 15_000 });
    await scrollTo(page, page.locator(".ProseMirror li", { hasText: "Ravi to finish the embed SDK docs" }).first(), 260);
    await page.waitForTimeout(600);
    return plan;
  };
  /// Phone: the bottom toolbar's Ask Assistant, the sheet, "Make a task database", the plan.
  const phonePlan = async (page) => {
    await selectNotes(page);
    await page.getByRole("toolbar", { name: "Editing tools" }).getByRole("button", { name: "Ask Assistant" }).click();
    const sheet = page.getByRole("dialog", { name: "Assistant" });
    await sheet.getByRole("button", { name: "Make a task database" }).click();
    await sheet.getByText("Here's the plan").waitFor({ timeout: 15_000 });
    await page.waitForTimeout(600);
    return sheet;
  };
  const review = async (page) => {
    const r = page.getByRole("region", { name: "Review the assistant's changes" });
    await r.getByText(/suggestions to review/).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(800);
    return r;
  };

  await scene("assistant-plan", DESK, async (page) => {
    await desktopPlan(page);
    await shot(page, "assistant-plan");
  });

  await scene("assistant-review", DESK, async (page) => {
    const plan = await desktopPlan(page);
    await plan.getByRole("button", { name: /^Run/ }).click();
    await review(page);
    await scrollTo(page, page.getByRole("heading", { name: "Notes from Monday" }).first(), 100);
    await shot(page, "assistant-review");
  });

  await scene("assistant-phone-plan", PHONE, async (page) => {
    await phonePlan(page);
    await shot(page, "assistant-phone-plan");
  });

  await scene("assistant-phone-review", PHONE, async (page) => {
    const sheet = await phonePlan(page);
    await sheet.getByRole("button", { name: "Run", exact: true }).click();
    await review(page);
    await scrollTo(page, page.getByRole("heading", { name: "Notes from Monday" }).first(), 70);
    await shot(page, "assistant-phone-review");
  });

  await browser.close();
}

for (const scheme of ["light", "dark"]) {
  console.log(`capturing ${scheme}`);
  await run(scheme);
}
if (failures.length) {
  console.error(`capture-site-screens: ${failures.length} scene(s) failed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`capture-site-screens: done; raw PNGs in ${OUT}`);
