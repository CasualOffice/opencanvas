// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DB100K (docs/36 §6.1, DB-A4/DB-A5): frame times of the real editor bundle on a database of
// 100,000 rows × 30 fields, in Playwright Chromium. Not part of the e2e suite (perf config, no
// server stack): the production build is served statically and opened at `/app/#demo&sim=quiet`
// (the same bundle a host loads, with a local Y.Doc).
//
//   cd e2e && npx playwright test -c perf/playwright.config.ts db100k
//
//   E2E_SKIP_BUILD=1   reuse web/packages/editor/dist
//   PERF_ROWS=100000   row count (30 fields)
//   PERF_LABEL=<name>  results/db100k-<name>.json
//
// Load mix, stated with every result: one browser, one tab, no peers; the fixture is written in
// one local transaction. Scenarios (each 10 s, a rAF frame recorder and a long-task observer):
//
//   table        scripted scroll of the table, 90 px per frame down then up, with a cell edit
//                (a local transaction on a visible row) every 500 ms
//   tableSide    the same with a sideways scroll across the 30 fields
//   board        100,000 cards in 6 lanes: the first lane scrolled the same way, edits every 500 ms
//
// Gate (DB-A4/A5): p95 frame ≤ 16.7 ms. Results always name the machine and the load mix.
import { execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ROOT } from "../env";

const ROWS = Number(process.env.PERF_ROWS ?? 100_000);
const FIELDS = 30;
const LABEL = process.env.PERF_LABEL ?? "run";
const DIST = path.join(ROOT, "web/packages/editor/dist");
const OUT = path.join(ROOT, "e2e/perf/results");
const SECONDS = 10;
const GATE_P95 = 16.7;

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json" };

function serve(dir: string): Promise<{ url: string; close(): void }> {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    let rel = decodeURIComponent(u.pathname.replace(/^\/app\/?/, ""));
    if (!rel || rel.endsWith("/")) rel += "index.html";
    let file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dir, "index.html");
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() })));
}

const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0);
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Fills the demo's first database with the fixture in one transaction; returns its id. */
async function fill(page: Page, rows: number, fields: number) {
  return page.evaluate(({ rows, fields }) => {
    type YM = { get(k: string): unknown; set(k: string, v: unknown): void; keys(): IterableIterator<string> };
    const ed = (window as unknown as { __ocEditor: { extensionManager: { extensions: { name: string; options: { document: unknown } }[] } } }).__ocEditor;
    const doc = ed.extensionManager.extensions.find((e) => e.name === "collaboration")!.options.document as { getMap(n: string): YM; transact(f: () => void, o?: unknown): void };
    const dbs = doc.getMap("databases");
    const id = [...dbs.keys()][0];
    const db = dbs.get(id) as YM;
    const YMap = (dbs as unknown as { constructor: new () => YM }).constructor;
    const YArray = (db.get("order") as { constructor: new () => { push(v: unknown[]): void } }).constructor;
    const lanes = ["Not started", "In progress", "In review", "Blocked", "Done", "Won't do"];
    const tones = ["gray", "blue", "purple", "red", "green", "amber"];
    const words = ["Migrate", "Review", "Test", "Document", "Refactor", "Measure", "Fix", "Add"];
    const things = ["CSV export", "onboarding email", "mobile toolbar", "SSO callback", "invoice PDF", "audit log", "billing webhook", "team settings"];
    const kinds = ["status", "select", "number", "date", "text", "checkbox"];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    const t0 = performance.now();
    doc.transact(() => {
      const fs = new YArray();
      const defs: { id: string; type: string }[] = [{ id: "t", type: "title" }];
      for (let i = 1; i < fields; i++) defs.push({ id: "f" + i, type: i === 1 ? "status" : kinds[i % kinds.length] });
      fs.push(defs.map((d, i) => {
        const m = new YMap();
        m.set("id", d.id);
        m.set("name", i === 0 ? "Task" : i === 1 ? "Status" : `Field ${i}`);
        m.set("type", d.type);
        m.set("options", d.type === "status" || d.type === "select" ? lanes.map((v, k) => ({ v, c: tones[k] })) : null);
        return m;
      }));
      db.set("fields", fs);
      const rm = new YMap();
      const order = new YArray();
      const ids: string[] = [];
      for (let r = 0; r < rows; r++) {
        const row = new YMap();
        for (const d of defs) {
          const v = d.type === "title" ? `${words[r % 8]} ${things[(r >> 3) % 8]}`
            : d.type === "status" || d.type === "select" ? lanes[Math.floor(rnd() * 6)]
            : d.type === "number" ? Math.floor(rnd() * 40)
            : d.type === "date" ? `2026-${String(1 + (r % 12)).padStart(2, "0")}-${String(1 + (r % 28)).padStart(2, "0")}`
            : d.type === "checkbox" ? rnd() > 0.5
            : `S${40 + (r % 9)}`;
          row.set(d.id, v);
        }
        rm.set("r" + r, row);
        ids.push("r" + r);
      }
      db.set("rows", rm);
      order.push(ids);
      db.set("order", order);
      db.set("view", "table");
    });
    (window as unknown as { __db: unknown }).__db = { doc, id, db };
    return { id, ms: Math.round(performance.now() - t0) };
  }, { rows, fields });
}

/** Records frames for `SECONDS` while scrolling `sel` by `dy`/`dx` per frame and editing a row every 500 ms. */
async function run(page: Page, sel: string, dx: number, dy: number) {
  return page.evaluate(({ sel, dx, dy, seconds }) => new Promise<{ frames: number[]; lt: number[]; edits: number }>((res) => {
    const el = document.querySelector<HTMLElement>(sel)!;
    const frames: number[] = [];
    const lt: number[] = [];
    const obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => lt.push(e.duration)));
    obs.observe({ type: "longtask" });
    const { doc, db } = (window as unknown as { __db: { doc: { transact(f: () => void): void }; db: { get(k: string): { get(k: string): { set(k: string, v: unknown): void } } } } }).__db;
    let edits = 0;
    const edit = setInterval(() => {
      const r = document.querySelector<HTMLElement>(`${sel} [data-row]`)?.dataset.row;
      if (r) doc.transact(() => db.get("rows").get(r).set("f4", `Edited ${++edits}`));
    }, 500);
    let last = 0, dirY = 1, dirX = 1;
    const end = performance.now() + seconds * 1000;
    const loop = (t: number) => {
      if (last) frames.push(t - last);
      last = t;
      if (dy) {
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) dirY = -1;
        else if (el.scrollTop <= 0) dirY = 1;
        el.scrollTop += dy * dirY;
      }
      if (dx) {
        if (el.scrollLeft + el.clientWidth >= el.scrollWidth - 2) dirX = -1;
        else if (el.scrollLeft <= 0) dirX = 1;
        el.scrollLeft += dx * dirX;
      }
      if (t < end) requestAnimationFrame(loop);
      else {
        clearInterval(edit);
        obs.disconnect();
        res({ frames, lt, edits });
      }
    };
    requestAnimationFrame(loop);
  }), { sel, dx, dy, seconds: SECONDS });
}

const sum = (r: { frames: number[]; lt: number[]; edits: number }) => ({
  frames: r.frames.length,
  p50: r2(q(r.frames, 50)),
  p95: r2(q(r.frames, 95)),
  p99: r2(q(r.frames, 99)),
  max: r2(Math.max(0, ...r.frames)),
  over25: r.frames.filter((x) => x > 25).length,
  longTasks: r.lt.length,
  longTaskMax: r2(Math.max(0, ...r.lt)),
  edits: r.edits,
});

test("DB100K table and board frame times", async ({ browser }) => {
  if (process.env.E2E_SKIP_BUILD !== "1") execSync("pnpm --filter @opencanvas/editor build", { cwd: path.join(ROOT, "web"), stdio: "inherit" });
  const srv = await serve(DIST);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${srv.url}/app/#demo&sim=quiet`);
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".ocdb").first()).toBeVisible({ timeout: 30_000 });
    const filled = await fill(page, ROWS, FIELDS);
    const sc = page.locator(".ocdb-lt-sc").first();
    await expect(sc).toBeVisible({ timeout: 60_000 });
    await sc.scrollIntoViewIfNeeded();
    await expect(page.locator(".ocdb-hcb").first()).toHaveText(`${ROWS.toLocaleString("en-US")} rows`);
    const table = sum(await run(page, ".ocdb-lt-sc", 0, 90));
    const tableSide = sum(await run(page, ".ocdb-lt-sc", 40, 60));
    const domRows = await page.locator(".ocdb-lt-r").count();
    await page.evaluate(() => {
      const { db } = (window as unknown as { __db: { db: { set(k: string, v: unknown): void } } }).__db;
      db.set("view", "board");
    });
    const lane = page.locator(".ocdb-lb-sc").first();
    await expect(lane).toBeVisible({ timeout: 60_000 });
    const lanes = await page.locator(".ocdb-lb-lane").count();
    const board = sum(await run(page, ".ocdb-lb-sc", 0, 90));
    const result = {
      scenario: "DB100K",
      at: new Date().toISOString(),
      label: LABEL,
      machine: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), os: `${os.type()} ${os.release()}`, chromium: browser.version(), viewport: "1280x900, headless", loadBefore: os.loadavg().map(r2) },
      mix: `one tab, no peers, ${ROWS} rows × ${FIELDS} fields written in one local transaction; scripted scroll ${SECONDS} s per scenario with a local cell edit every 500 ms`,
      fixtureMs: filled.ms,
      domRowsInTable: domRows,
      lanes,
      table,
      tableSide,
      board,
      gate: { p95MaxMs: GATE_P95 },
    };
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `db100k-${LABEL}.json`), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
    expect(domRows).toBeLessThan(300);
    for (const [k, v] of Object.entries({ table, tableSide, board })) expect(v.p95, `${k} p95 frame (ms)`).toBeLessThanOrEqual(GATE_P95);
  } finally {
    await ctx.close();
    srv.close();
  }
});
