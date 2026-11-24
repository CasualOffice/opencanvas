// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DGM-10: frame times of the real editor bundle on boards of 1k / 5k / 10k nodes (edges 1.5 ×
// nodes, the deterministic `bench/fixtures.ts` boards), in Playwright Chromium.
//
// The production build (`web/packages/editor/dist`) is served statically and opened at
// `/app/#demo&sim=quiet`: the same bundle a host loads, with a local Y.Doc instead of the
// server (no network in the numbers). The demo's board gets the fixture in one transaction and
// opens full screen (1280 × 900). Scenarios, each with a rAF frame recorder and a long-task
// observer running:
//
//   pan      120 wheel events (8 ms apart) at 100 % zoom, centred on the board
//   zoom     30 Ctrl+wheel steps out (to ~25 %) and 30 back in, at the board centre
//   drag1    one node dragged 240 px in 120 pointer moves (8 ms apart), then released
//   drag20   20 nodes selected (Shift+click), dragged the same way, then released
//   remote   another peer's transactions every 16 ms for 2 s, each moving 5 random nodes
//            (applied to the same Y.Doc with a foreign origin, as the demo's simulated
//            collaborators do; the network path is not part of the number)
//   panFit   the pan again with the whole board on screen (Shift+1 fit, zoom floor 10 %)
//   drag1Fit one node dragged 120 px in 120 pointer moves at the fit view, then released
//
// Frame time is the interval between consecutive requestAnimationFrame callbacks (16.7 ms at
// 60 Hz when nothing is late). Latency (`lat*`) is each pointermove / wheel event (from its
// timeStamp) or remote transaction to the first task after the next frame: the work it caused
// plus the wait for that frame; Chromium aligns pointer input to frames, so a move whose work
// overruns a frame shows here even when rAF keeps its 60 Hz cadence. `release` is pointerup (capture phase) to the first task after
// the next frame: the commit (`syncBoundArrows`) and its render. Heap is `Runtime.getHeapUsage`
// after a forced GC. See playwright.config.ts here for the variables.
import { execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { ROOT } from "../env";
import { fixtureShapes } from "../../web/packages/board/bench/fixtures";

const SIZES = (process.env.PERF_SIZES ?? "1000,5000,10000").split(",").map(Number).filter((n) => n > 0);
const LABEL = process.env.PERF_LABEL ?? "run";
const DIST = path.resolve(process.env.PERF_DIST ?? path.join(ROOT, "web/packages/editor/dist"));
const OUT = path.join(ROOT, "e2e/perf/results");
const TRACE = process.env.PERF_TRACE === "1";
const PACE = 8;
/** PERF_ONLY=fit runs only the fit-view scenarios (panFit, zoomFit, drag1Fit): the LOD numbers (DGM-19). */
const ONLY_FIT = process.env.PERF_ONLY === "fit";

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json", ".webmanifest": "application/manifest+json" };

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

const q = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const r2 = (v: number) => Math.round(v * 100) / 100;

interface Rec {
  frames: number[];
  lt: number[];
  release: number[];
  lat: number[];
}
function summary(r: Rec, ms: number) {
  const f = r.frames;
  return {
    frames: f.length,
    p50: r2(q(f, 50)),
    p95: r2(q(f, 95)),
    p99: r2(q(f, 99)),
    max: r2(Math.max(0, ...f)),
    over25: f.filter((x) => x > 25).length,
    longTasks: r.lt.length,
    longTaskMs: r2(r.lt.reduce((a, b) => a + b, 0)),
    longTaskMax: r2(Math.max(0, ...r.lt)),
    release: r.release.map(r2),
    inputs: r.lat.length,
    lat50: r2(q(r.lat, 50)),
    lat95: r2(q(r.lat, 95)),
    lat99: r2(q(r.lat, 99)),
    ms: Math.round(ms),
  };
}

/* ------------------------------------------------------------------ in-page helpers */

const RECORDER = () => {
  type St = { frames: number[]; lt: number[]; release: number[]; lat: number[]; run: boolean; obs?: PerformanceObserver };
  const w = window as unknown as { __perf: { start(): void; stop(): Rec; mark(t0: number): void }; __perfSt?: St };
  /** Input (or remote transaction) to the first task after the next frame: its work plus one frame. */
  const mark = (t0: number) => {
    const st = w.__perfSt;
    if (!st?.run) return;
    requestAnimationFrame(() => setTimeout(() => st.lat.push(performance.now() - t0)));
  };
  for (const type of ["pointermove", "wheel"]) window.addEventListener(type, (e) => mark(e.timeStamp), { capture: true, passive: true });
  const onUp = () => {
    const st = w.__perfSt;
    if (!st?.run) return;
    const t0 = performance.now();
    requestAnimationFrame(() => setTimeout(() => st.release.push(performance.now() - t0)));
  };
  window.addEventListener("pointerup", onUp, { capture: true });
  w.__perf = {
    start() {
      const st: St = { frames: [], lt: [], release: [], lat: [], run: true };
      w.__perfSt = st;
      let last = 0;
      const loop = (t: number) => {
        if (!st.run) return;
        if (last) st.frames.push(t - last);
        last = t;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      st.obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => st.lt.push(e.duration)));
      st.obs.observe({ type: "longtask" });
    },
    stop() {
      const st = w.__perfSt!;
      st.run = false;
      st.obs?.disconnect();
      return { frames: st.frames, lt: st.lt, release: st.release, lat: st.lat };
    },
    mark,
  };
};
type Rec2 = Rec;
declare global {
  interface Window {
    __perf: { start(): void; stop(): Rec2; mark(t0: number): void };
  }
}

const frames = (page: Page, n = 2) => page.evaluate((k) => new Promise<void>((res) => {
  const step = (i: number) => (i ? requestAnimationFrame(() => step(i - 1)) : res());
  step(k);
}), n);

async function view(page: Page) {
  const t = await page.locator(".ocbd-full svg.ocbd-svg > g[transform]").first().getAttribute("transform");
  const m = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(t ?? "");
  if (!m) throw new Error("no view transform: " + t);
  return { tx: Number(m[1]), ty: Number(m[2]), z: Number(m[3]) };
}

/** A screen point inside node `id` where the topmost board element is that node. */
async function grab(page: Page, id: string) {
  return page.evaluate((sid) => {
    const g = document.querySelector(`.ocbd-full g[data-s="${sid}"]`);
    if (!g) return null;
    const b = g.getBoundingClientRect();
    for (const fy of [0.5, 0.3, 0.7, 0.2, 0.8])
      for (const fx of [0.5, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9]) {
        const x = b.left + b.width * fx, y = b.top + b.height * fy;
        if (document.elementFromPoint(x, y)?.closest("[data-s]")?.getAttribute("data-s") === sid) return { x, y };
      }
    return null;
  }, id);
}

async function measure(browser: Browser, page: Page, name: string, n: number, run: () => Promise<void>) {
  if (TRACE) {
    fs.mkdirSync(path.join(OUT, "traces"), { recursive: true });
    await browser.startTracing(page, { path: path.join(OUT, "traces", `${LABEL}-${n}-${name}.json`), screenshots: false });
  }
  await frames(page, 3);
  await page.evaluate(() => window.__perf.start());
  const t0 = Date.now();
  await run();
  await frames(page, 3);
  const rec = await page.evaluate(() => window.__perf.stop());
  const ms = Date.now() - t0;
  if (TRACE) await browser.stopTracing();
  return summary(rec, ms);
}

/* ------------------------------------------------------------------------------ test */

test("DGM-10 board frame times", async ({ browser }) => {
  if (process.env.E2E_SKIP_BUILD !== "1" && !process.env.PERF_DIST) execSync("pnpm --filter @opencanvas/editor build", { cwd: path.join(ROOT, "web"), stdio: "inherit" });
  expect(fs.existsSync(path.join(DIST, "index.html")), `${DIST}/index.html`).toBe(true);
  const srv = await serve(DIST);
  const machine = {
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    memGB: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.type()} ${os.release()}`,
    node: process.version,
    chromium: browser.version(),
    viewport: "1280x900, deviceScaleFactor 1, headless",
    loadBefore: os.loadavg().map(r2),
  };
  const results: Record<string, unknown>[] = [];
  try {
    for (const nodes of SIZES) {
      const list = fixtureShapes({ nodes });
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      await page.addInitScript(RECORDER);
      await page.goto(`${srv.url}/app/#demo&sim=quiet`);
      await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(".ocbd").first()).toBeVisible({ timeout: 30_000 });

      // Fill the demo's board with the fixture: one local transaction, like an import.
      const fill = await page.evaluate((shapes) => {
        type YM = { get(k: string): unknown; set(k: string, v: unknown): void; keys(): IterableIterator<string> };
        const ed = (window as unknown as { __ocEditor: { extensionManager: { extensions: { name: string; options: { document: unknown } }[] } } }).__ocEditor;
        const doc = ed.extensionManager.extensions.find((e) => e.name === "collaboration")!.options.document as {
          getMap(n: string): YM;
          getArray(n: string): unknown;
          transact(f: () => void, o?: unknown): void;
        };
        const boards = doc.getMap("boards");
        const id = [...boards.keys()][0];
        const board = boards.get(id) as YM;
        const YMap = (boards as unknown as { constructor: new () => YM }).constructor;
        const YArray = (board.get("order") as { constructor: new () => { push(v: string[]): void } }).constructor;
        const t0 = performance.now();
        doc.transact(() => {
          const m = new YMap();
          const order = new YArray();
          board.set("shapes", m);
          board.set("order", order);
          for (const s of shapes) {
            const y = new YMap();
            for (const [k, v] of Object.entries(s)) if (k !== "id" && v !== undefined) y.set(k, v);
            m.set(s.id, y);
          }
          order.push(shapes.map((s) => s.id));
        });
        const ms = performance.now() - t0;
        (window as unknown as { __perfDoc: unknown }).__perfDoc = { doc, id };
        return { ms };
      }, list);

      // Full screen; the board fits its content (zoom floor 10 %).
      const board = page.locator(".ocbd").first();
      await board.scrollIntoViewIfNeeded();
      const tOpen = Date.now();
      await board.getByRole("button", { name: "Full screen" }).click();
      await expect(page.locator(".ocbd-full")).toBeVisible();
      await frames(page, 6);
      const openMs = Date.now() - tOpen;
      const cdp = await ctx.newCDPSession(page);
      const heap = async () => {
        await cdp.send("HeapProfiler.collectGarbage");
        return r2((await cdp.send("Runtime.getHeapUsage")).usedSize / 2 ** 20);
      };
      const heapLoaded = await heap();
      const fitView = await view(page);
      const svg = (await page.locator(".ocbd-full svg.ocbd-svg").boundingBox())!;
      const cx = svg.x + svg.width / 2, cy = svg.y + svg.height / 2;
      const domFit = await page.locator(".ocbd-full g[data-s]").count();

      const panBy = async () => {
        for (let i = 0; i < 120; i++) {
          const s = i < 60 ? 1 : -1;
          await page.mouse.wheel(10 * s, 6 * s);
          await page.waitForTimeout(PACE);
        }
      };
      const drag = async (from: { x: number; y: number }, step = 2) => {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        for (let i = 1; i <= 120; i++) {
          await page.mouse.move(from.x + i * step, from.y + (i * step) / 2);
          await page.waitForTimeout(PACE);
        }
        await page.mouse.up();
      };

      // 100 % at the centre of the board.
      for (let k = 0; k < 5; k++) {
        const z = (await view(page)).z;
        if (Math.abs(z - 1) < 0.005) break;
        await page.mouse.move(cx, cy);
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, -Math.log(1 / z) / 0.0025);
        await page.keyboard.up("Control");
        await frames(page, 4);
      }
      const v1 = await view(page);
      expect(Math.abs(v1.z - 1)).toBeLessThan(0.01);
      const dom100 = await page.locator(".ocbd-full g[data-s]").count();

      const domNodes = () => page.evaluate(() => document.querySelectorAll(".ocbd-full svg.ocbd-svg *").length);
      const row: Record<string, unknown> = { nodes, edges: list.length - nodes, fillMs: r2(fill.ms), openMs, heapLoadedMB: heapLoaded, fitZoom: r2(fitView.z), domShapesFit: domFit, domShapes100: dom100, domNodes100: await domNodes() };

      if (!ONLY_FIT) {
      row.pan = await measure(browser, page, "pan", nodes, panBy);

      row.zoom = await measure(browser, page, "zoom", nodes, async () => {
        await page.mouse.move(cx, cy);
        await page.keyboard.down("Control");
        for (let i = 0; i < 60; i++) {
          await page.mouse.wheel(0, i < 30 ? 18.5 : -18.5);
          await page.waitForTimeout(PACE);
        }
        await page.keyboard.up("Control");
      });
      expect(Math.abs((await view(page)).z - 1)).toBeLessThan(0.02);

      // Nodes around the centre of the grid (the view is centred on it).
      const cols = Math.ceil(Math.sqrt(nodes));
      const pad = String(nodes).length;
      const nid = (r: number, c: number) => "n" + String(r * cols + c).padStart(pad, "0");
      const rows = Math.ceil(nodes / cols);
      const r0 = Math.floor(rows / 2), c0 = Math.floor(cols / 2);
      const centre = async () => {
        for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [-1, 0], [0, -1], [1, 1]]) {
          const p = await grab(page, nid(r0 + dr, c0 + dc));
          if (p) return p;
        }
        throw new Error("no grabbable node near the centre");
      };

      const p1 = await centre();
      row.drag1 = await measure(browser, page, "drag1", nodes, () => drag(p1));

      // 20 nodes around the centre (not the one just dragged), as many as fit on screen; the first click
      // replaces the selection, Shift+click adds the others. Escape is not used: with nothing
      // selected it leaves full screen.
      let picked = 0;
      let first: { x: number; y: number } | null = null;
      for (let dr = -2; dr <= 2 && picked < 20; dr++)
        for (let dc = -3; dc <= 3 && picked < 20; dc++) {
          if (!dr && !dc) continue;
          const p = await grab(page, nid(r0 + dr, c0 + dc));
          if (!p) continue;
          if (first) await page.keyboard.down("Shift");
          await page.mouse.click(p.x, p.y);
          if (first) await page.keyboard.up("Shift");
          first ??= p;
          picked++;
        }
      expect(picked).toBe(20);
      await expect(page.locator('.ocbd-full [aria-label="20 shapes"]')).toHaveCount(1);
      row.drag20 = await measure(browser, page, "drag20", nodes, () => drag(first!));

      row.remote = await measure(browser, page, "remote", nodes, () =>
        page.evaluate(
          ({ n, pad }) =>
            new Promise<void>((res) => {
              const { doc, id } = (window as unknown as { __perfDoc: { doc: { getMap(n: string): { get(k: string): { get(k: string): unknown } }; transact(f: () => void, o?: unknown): void }; id: string } }).__perfDoc;
              const shapes = doc.getMap("boards").get(id).get("shapes") as { get(k: string): { get(k: string): number; set(k: string, v: number): void } };
              let a = 12345;
              const rnd = () => ((a = (a * 1103515245 + 12345) % 2147483648), a / 2147483648);
              const origin = { remote: "perf" };
              const t0 = performance.now();
              const tick = setInterval(() => {
                window.__perf.mark(performance.now());
                doc.transact(() => {
                  for (let k = 0; k < 5; k++) {
                    const y = shapes.get("n" + String(Math.floor(rnd() * n)).padStart(pad, "0"));
                    y.set("x", y.get("x") + (rnd() < 0.5 ? -10 : 10));
                  }
                }, origin);
                if (performance.now() - t0 > 2000) {
                  clearInterval(tick);
                  res();
                }
              }, 16);
            }),
          { n: nodes, pad },
        ),
      );
      }
      // The whole board on screen (fit view): every shape in the viewport is drawn.
      // Shift+1 fits the board again (focus the board first: with PERF_ONLY=fit nothing clicked it).
      await page.locator(".ocbd.ocbd-full").focus();
      await page.keyboard.press("Shift+Digit1");
      await frames(page, 4);
      expect(Math.abs((await view(page)).z - fitView.z)).toBeLessThan(0.01);
      if (process.env.PERF_SHOT === "1") {
        fs.mkdirSync(path.join(OUT, "shots"), { recursive: true });
        await page.screenshot({ path: path.join(OUT, "shots", `${LABEL}-${nodes}-fit.png`) });
      }
      const rowFit: Record<string, unknown> = { domNodesFit: await domNodes() };
      rowFit.panFit = await measure(browser, page, "panFit", nodes, panBy);
      // Zoom at the fit view: 20 Ctrl+wheel steps in (to ~2.5 × the fit zoom) and back out.
      rowFit.zoomFit = await measure(browser, page, "zoomFit", nodes, async () => {
        await page.mouse.move(cx, cy);
        await page.keyboard.down("Control");
        for (let i = 0; i < 40; i++) {
          await page.mouse.wheel(0, i < 20 ? -18.5 : 18.5);
          await page.waitForTimeout(PACE);
        }
        await page.keyboard.up("Control");
      });
      await page.keyboard.press("Shift+Digit1");
      await frames(page, 4);
      {
        const cols = Math.ceil(Math.sqrt(nodes)), pad = String(nodes).length;
        const mid = "n" + String(Math.floor(Math.ceil(nodes / cols) / 2) * cols + Math.floor(cols / 2) - 1).padStart(pad, "0");
        // Zoomed out the board draws level of detail (DGM-19): no element per shape, so the
        // node's centre comes from its geometry and the view transform.
        let p = await grab(page, mid);
        if (!p) {
          const sh = list.find((q) => q.id === mid)!, v = await view(page);
          p = { x: svg.x + v.tx + ((sh.x ?? 0) + (sh.w ?? 0) / 2) * v.z, y: svg.y + v.ty + ((sh.y ?? 0) + (sh.h ?? 0) / 2) * v.z };
        }
        rowFit.drag1Fit = await measure(browser, page, "drag1Fit", nodes, () => drag(p, 1));
      }

      Object.assign(row, rowFit);
      row.heapAfterMB = await heap();
      results.push(row);
      console.log(`[perf] ${nodes}: ${JSON.stringify(row)}`);
      await ctx.close();
    }
  } finally {
    srv.close();
  }
  fs.mkdirSync(OUT, { recursive: true });
  const out = { label: LABEL, dist: path.relative(ROOT, DIST), when: new Date().toISOString(), machine: { ...machine, loadAfter: os.loadavg().map(r2) }, results };
  fs.writeFileSync(path.join(OUT, `frames-${LABEL}.json`), JSON.stringify(out, null, 2) + "\n");
  console.log(`[perf] wrote ${path.join(OUT, `frames-${LABEL}.json`)}`);
});
