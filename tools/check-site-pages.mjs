// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Look at every page of the website: full-page screenshots at 1440 and 390 px, in light
// and dark; axe (WCAG 2.0, 2.1 and 2.2, levels A and AA) with zero violations of any
// impact; no horizontal overflow; no console errors; and the bytes each page transfers
// before scrolling (budget 1.5 MB; lazy screenshots load only when scrolled to).
// Ported from OpenSeal's tools/check-site-pages.mjs, with zero findings required, not
// only zero serious ones.
//
//   python3 -I tools/serve-site.py 8700 &
//   node tools/check-site-pages.mjs [BASE] [OUT]     # OUT default target/site-qa
//
// Uses the e2e harness's Playwright and axe (`cd e2e && npm ci`). Exits non-zero listing
// every problem. Screenshots use reduced motion so scroll reveals are visible.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const BASE = process.argv[2] || "http://127.0.0.1:8700/opencanvas";
const OUT = path.resolve(process.argv[3] || path.join(ROOT, "target/site-qa"));
const NM = path.join(ROOT, "e2e/node_modules");
if (!fs.existsSync(path.join(NM, "@axe-core/playwright"))) { console.error("check-site-pages: run `npm ci` in e2e/ first"); process.exit(1); }
const { chromium } = await import(pathToFileURL(path.join(NM, "playwright/index.mjs")).href);
const AxeBuilder = (await import(pathToFileURL(path.join(NM, "@axe-core/playwright/dist/index.mjs")).href)).default;

const BUDGET = 1.5 * 1024 * 1024;
const pages = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith("_")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".html")) pages.push(path.relative(path.join(ROOT, "site"), p).split(path.sep).join("/"));
  }
})(path.join(ROOT, "site"));
pages.sort();
const only = process.env.PAGES ? process.env.PAGES.split(",") : null;
const SHOTS = process.env.SHOTS !== "0";

const VIEWS = [
  ["1440", { viewport: { width: 1440, height: 900 } }],
  ["390", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }],
];

fs.mkdirSync(OUT, { recursive: true });
const problems = [];
let checks = 0;
const browser = await chromium.launch({ headless: true });
for (const scheme of ["light", "dark"]) {
  for (const [vname, opts] of VIEWS) {
    const ctx = await browser.newContext({ ...opts, colorScheme: scheme, reducedMotion: "reduce" });
    for (const rel of pages) {
      if (only && !only.includes(rel)) continue;
      const page = await ctx.newPage();
      let bytes = 0;
      const errors = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("response", async (r) => { try { bytes += (await r.body()).length; } catch { /* redirects */ } });
      const res = await page.goto(`${BASE}/${rel}`, { waitUntil: "networkidle" });
      if (!res || (res.status() !== 200 && !(rel === "404.html"))) problems.push(`${rel}: HTTP ${res?.status()}`);
      const name = `${rel.replace(/\//g, "_").replace(/\.html$/, "")}-${vname}-${scheme}`;
      if (vname === "1440" && bytes > BUDGET) problems.push(`${rel}: ${(bytes / 1024).toFixed(0)} KiB before scrolling (budget ${BUDGET / 1024} KiB)`);
      if (vname === "1440" && scheme === "light") console.log(`${rel}: ${(bytes / 1024).toFixed(0)} KiB before scrolling`);
      for (const e of errors) problems.push(`${rel} ${vname} ${scheme}: console: ${e}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) problems.push(`${rel} ${vname} ${scheme}: horizontal overflow ${overflow}px`);
      // Scroll through so lazy images and scroll reveals are in their final state.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += innerHeight / 2) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
        scrollTo(0, 0);
      });
      await page.waitForLoadState("networkidle");
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze();
      checks++;
      for (const v of axe.violations) {
        problems.push(`${rel} ${vname} ${scheme}: axe ${v.id} (${v.impact}) × ${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ") + " — " + (n.failureSummary || "").split("\n").slice(1, 2).join("")).join(" | ")}`);
      }
      if (SHOTS) await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
if (problems.length) {
  console.error(`check-site-pages: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-site-pages: ${checks} axe runs (${pages.length} pages × ${VIEWS.length} widths × 2 themes), zero violations; screenshots in ${path.relative(ROOT, OUT)}`);
