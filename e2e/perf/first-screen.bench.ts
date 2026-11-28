// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// BENCH-03 (docs/36 §3.2, §3.3 PSYNC50 / MEM / START): browser benchmarks on the seeded fixtures
// (bench/fixtures/canvas-{s,m,l,50mb}.ocanvas, `scripts/bench/run fixtures`), through the real
// stack: the release server (SQLite, OC_WEB_DIR = the production build) and the oc-bench mock
// host, which serves the fixture as the file. Each run mints a launch token for a fresh file id
// (the room loads from the host every time), opens it in Chromium with a 4× CPU throttle and
// 40 Mbit/s, 40 ms RTT (CDP network emulation; it shapes HTTP, not WebSocket frames), and records:
//
//   firstScreenMs  navigation start → the editor is editable with the first heading painted
//                  (polled every animation frame: the caret can be placed)
//   heapMb         JS heap after a forced GC (HeapProfiler.collectGarbage, Runtime.getHeapUsage)
//   domNodes       elements in the document after load
//   js             script requests before the first screen: count, transferred and decoded bytes
//   longFrames     long animation frames (> 50 ms) during load, and while scrolling 30 wheel
//                  steps of 600 px through the page (databases and boards included);
//                  scrolledPx says how far it got
//
//   cd e2e && npx playwright test -c perf/bench.config.ts
//   BENCH_FIXTURES=s,m   BENCH_RUNS=3   BENCH_MACHINE=local   E2E_SKIP_BUILD=1   E2E_PORT_SHIFT=500
//   BENCH_PROFILE=1   CPU profile of the first run up to the first screen: the 40 functions with
//                     the most self time, printed (an unminified build makes them readable)
//   BENCH_PARTIAL=0   the host turns `[host.flags] partial_sync` off (whole rooms; on by default
//                     since 0.4, so unset measures what a host gets)
//   BENCH_REOPEN=1    one file id per fixture: run 1 opens it cold, every later run opens it
//                     again after the room has closed (OC_ROOM_IDLE_MS 1500 unless set), the
//                     way a person reopens a canvas (PSYNC-BUG-2: the kept split)
//   BENCH_PARTIAL=1   the host has `[host.flags] partial_sync` (PSYNC-02/03): databases and
//                     boards load as subdocuments when scrolled near; `parts` counts the
//                     database and board views showing content (not the placeholder) after
//                     the scroll
//
// Writes bench/results/<date>-browser-<machine>.json (hardware, profile, medians and every run).
import { execFileSync, execSync, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "@playwright/test";
import { ROOT } from "../env";

const SHIFT = Number(process.env.E2E_PORT_SHIFT ?? 0) || 0;
const PORT = 9211 + SHIFT;
const HOST_PORT = 9212 + SHIFT;
const OC = `http://127.0.0.1:${PORT}`;
const FIXTURES = (process.env.BENCH_FIXTURES ?? "s,m,l,50mb").split(",").filter(Boolean);
const RUNS = Number(process.env.BENCH_RUNS ?? 3);
const MACHINE = process.env.BENCH_MACHINE ?? "local";
const PARTIAL = !!process.env.BENCH_PARTIAL && process.env.BENCH_PARTIAL !== "0";
const WHOLE = process.env.BENCH_PARTIAL === "0";
const REOPEN = !!process.env.BENCH_REOPEN;
const SECRET = "bench-secret-0123456789abcdef0123456789";
const TGT = path.resolve(ROOT, process.env.CARGO_TARGET_DIR ?? "target");
const DIST = path.join(ROOT, "web/packages/editor/dist");
const PROFILE = { cpuThrottle: 4, downMbit: 40, upMbit: 40, rttMs: 40, viewport: { width: 1280, height: 900 } };

const children: ChildProcess[] = [];
let work = "";

async function ready(url: string, ms: number) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} not ready in ${ms} ms`);
}

function jwt(fileId: string, i: number) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = b64({
    iss: "bench", aud: "opencanvas", iat: now, exp: now + 3600, jti: `${fileId}-${i}`,
    file: { id: fileId, name: `Bench ${fileId}` }, user: { id: `u${i}`, name: `Bench user ${i}` },
    role: "edit", callbackToken: "bench",
  });
  const head = b64({ alg: "HS256", typ: "JWT" });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const STAMP = Date.now() % 1e8;

const median = (v: number[]) => {
  const s = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

test.beforeAll(async () => {
  test.setTimeout(15 * 60_000);
  if (!process.env.E2E_SKIP_BUILD) {
    execSync("cargo build -q --release -p oc-server --bin opencanvas -p oc-bench --bin oc-bench", { cwd: ROOT, stdio: "inherit" });
    execSync("pnpm --filter @opencanvas/editor build", { cwd: path.join(ROOT, "web"), stdio: "inherit" });
  }
  for (const f of FIXTURES) {
    if (!fs.existsSync(path.join(ROOT, `bench/fixtures/canvas-${f}.ocanvas`))) {
      execFileSync(path.join(TGT, "release/oc-bench"), ["fixture", f, "--out-dir", "bench/fixtures"], { cwd: ROOT, stdio: "inherit" });
    }
  }
  work = fs.mkdtempSync(path.join(os.tmpdir(), "oc-browser-bench-"));
  fs.writeFileSync(
    path.join(work, "hosts.toml"),
    `[[host]]\nid = "bench"\nname = "Bench host"\nmode = "jwt"\njwt_alg = "HS256"\njwt_secret = "${SECRET}"\napi_key = "bench-api-key"\ncallback_base = "http://127.0.0.1:${HOST_PORT}/api"\n${PARTIAL || WHOLE ? `\n[host.flags]\npartial_sync = ${PARTIAL}\n` : ""}`,
  );
  const log = fs.openSync(path.join(work, "logs.txt"), "a");
  children.push(
    spawn(path.join(TGT, "release/oc-bench"), ["host", "--host-port", String(HOST_PORT), ...(REOPEN ? ["--keep-saves"] : [])], {
      cwd: ROOT, env: { ...process.env, OC_BENCH_FIXTURES: path.join(ROOT, "bench/fixtures") }, stdio: ["ignore", log, log],
    }),
  );
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DATABASE_URL: `sqlite://${work}/bench.db?mode=rwc`,
    OC_KEK: crypto.randomBytes(32).toString("base64"),
    OC_HOSTS_FILE: path.join(work, "hosts.toml"),
    OC_BIND: `127.0.0.1:${PORT}`,
    OC_PUBLIC_URL: OC,
    OC_WEB_DIR: DIST,
    // The 50 MB fixture is over the 20 MB default document limit.
    OC_MAX_DOC_MB: "128",
    ...(REOPEN ? { OC_ROOM_IDLE_MS: process.env.OC_ROOM_IDLE_MS ?? "1500" } : {}),
    OC_LOG: process.env.OC_LOG ?? "warn",
  };
  delete env.OC_DEV;
  // OC_BIN: a server binary kept aside (a shared CARGO_TARGET_DIR can be rebuilt by another tree).
  children.push(spawn(process.env.OC_BIN ?? path.join(TGT, "release/opencanvas"), [], { cwd: ROOT, env, stdio: ["ignore", log, log] }));
  await ready(`${OC}/readyz`, 30_000);
});

test.afterAll(() => {
  for (const c of children) c.kill();
  if (process.env.OC_LOG) console.log(`server log: ${path.join(work, "logs.txt")}`);
});

test("first screen, heap, initial JS and long frames per fixture", async ({ browser }) => {
  test.setTimeout(60 * 60_000);
  const results: Record<string, unknown> = {};
  for (const fx of FIXTURES) {
    const runs: Record<string, unknown>[] = [];
    for (let i = 0; i < RUNS; i++) {
      const fileId = REOPEN ? `${fx}_r${STAMP}` : `${fx}_b${Date.now() % 1e8}_${i}`;
      const ctx = await browser.newContext({ viewport: PROFILE.viewport });
      const page = await ctx.newPage();
      await page.addInitScript(() => {
        const w = window as unknown as { __loaf: { start: number; duration: number; blocking: number }[] };
        w.__loaf = [];
        try {
          new PerformanceObserver((l) => {
            for (const e of l.getEntries()) w.__loaf.push({ start: e.startTime, duration: e.duration, blocking: (e as unknown as { blockingDuration?: number }).blockingDuration ?? 0 });
          }).observe({ type: "long-animation-frame", buffered: true });
        } catch {
          /* no LoAF in this browser */
        }
      });
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: PROFILE.cpuThrottle });
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false, latency: PROFILE.rttMs,
        downloadThroughput: (PROFILE.downMbit * 1e6) / 8, uploadThroughput: (PROFILE.upMbit * 1e6) / 8,
      });
      const scripts: { url: string; transfer: number; decoded: number }[] = [];
      let painted = false;
      // PSYNC-03: subdocument frames (type 101) and the parts list, before the first screen.
      const ws = { sub: 0, parts: -1, openAt: 0, firstAt: 0, step2At: 0 };
      page.on("websocket", (w) => {
        ws.openAt ||= Date.now();
        w.on("framereceived", (f) => {
          const b = f.payload;
          if (typeof b === "string" || !b.length) return;
          ws.firstAt ||= Date.now();
          // [0 sync, 1 step 2]: the main document has arrived.
          if (b[0] === 0 && b[1] === 1) ws.step2At ||= Date.now();
          if (b[0] === 101 && !painted) ws.sub++;
          if (b[0] === 100 && ws.parts < 0 && Buffer.from(b).includes(Buffer.from('"t":"parts"'))) ws.parts = (Buffer.from(b).toString("latin1").match(/block\//g) ?? []).length;
        });
      });
      page.on("requestfinished", async (req) => {
        if (painted || req.resourceType() !== "script") return;
        const s = await req.sizes().catch(() => null);
        const r = await req.response();
        const decoded = r ? (await r.body().catch(() => Buffer.alloc(0))).length : 0;
        scripts.push({ url: req.url().replace(OC, ""), transfer: s ? s.responseBodySize + s.responseHeadersSize : 0, decoded });
      });
      const res = await page.request.post(`${OC}/v1/launch`, { form: { token: jwt(fileId, i) }, maxRedirects: 0 });
      const loc = res.headers()["location"];
      const run: Record<string, unknown> = { fileId };
      try {
        if (!loc) throw new Error(`launch ${res.status()}: ${(await res.text()).slice(0, 200)}`);
        const profiling = !!process.env.BENCH_PROFILE && i === 0;
        if (profiling) {
          await cdp.send("Profiler.enable");
          await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
          await cdp.send("Profiler.start");
        }
        const navAt = Date.now();
        await page.goto(loc.startsWith("http") ? loc : `${OC}${loc}`, { waitUntil: "commit" });
        const h = await page.waitForFunction(
          () => {
            const pm = document.querySelector('.ProseMirror[contenteditable="true"]');
            const first = pm?.querySelector("h1, h2, h3, p");
            return pm && first && first.textContent && first.getBoundingClientRect().height > 0 ? performance.now() : false;
          },
          undefined,
          { polling: "raf", timeout: 240_000 },
        );
        painted = true;
        run.firstScreenMs = Math.round((await h.jsonValue()) as number);
        if (profiling) {
          type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number };
          const { profile } = (await cdp.send("Profiler.stop")) as { profile: { nodes: Node[]; samples: number[]; timeDeltas: number[] } };
          const self = new Map<number, number>();
          profile.samples.forEach((id, k) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[k] ?? 0)));
          const byFn = new Map<string, number>();
          for (const n of profile.nodes) {
            const f = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`;
            byFn.set(f, (byFn.get(f) ?? 0) + (self.get(n.id) ?? 0));
          }
          const top = [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 40);
          for (const [f, us] of top) console.log(`profile ${Math.round(us / 1000)} ms  ${f}`);
        }
        // Settle: let the rest of the document arrive and render before measuring memory.
        await page.waitForTimeout(0);
        await page.evaluate(() => new Promise((r) => requestIdleCallback(() => r(null), { timeout: 30_000 })));
        await cdp.send("HeapProfiler.collectGarbage");
        const heap = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number; totalSize: number };
        run.heapMb = Math.round((heap.usedSize / 1048576) * 10) / 10;
        run.domNodes = await page.evaluate(() => document.getElementsByTagName("*").length);
        run.partsBeforeScroll = await page.evaluate(() => {
          const views = [...document.querySelectorAll("[data-db], [data-board]")];
          return { views: views.length, shown: views.filter((v) => !v.querySelector(".bskel")).length };
        });
        run.subFramesBeforeFirstScreen = ws.sub;
        // Where the time goes: socket open, first frame (the room is loaded), main document in.
        run.wsMs = { open: ws.openAt - navAt, firstFrame: ws.firstAt - navAt, mainSynced: ws.step2At - navAt };
        run.partsListed = ws.parts;
        const loadLoaf = await page.evaluate(() => (window as unknown as { __loaf: { duration: number }[] }).__loaf.length);
        // Scroll through the document with the wheel over the editor.
        await page.mouse.move(640, 500);
        const t0 = await page.evaluate(() => performance.now());
        for (let k = 0; k < 30; k++) {
          await page.mouse.wheel(0, 600);
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
        }
        // How far the page scrolled (the editor may scroll inside a container).
        run.scrolledPx = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll("*")].map((e) => e.scrollTop)));
        const loaf = await page.evaluate(() => (window as unknown as { __loaf: { start: number; duration: number; blocking: number }[] }).__loaf);
        const summary = (l: { duration: number; blocking: number }[]) => ({
          count: l.length,
          totalMs: Math.round(l.reduce((a, b) => a + b.duration, 0)),
          blockingMs: Math.round(l.reduce((a, b) => a + b.blocking, 0)),
          worstMs: Math.round(Math.max(0, ...l.map((e) => e.duration))),
        });
        run.longFrames = { load: summary(loaf.slice(0, loadLoaf)), scroll: summary(loaf.filter((e) => e.start >= t0)) };
        run.parts = await page.evaluate(() => {
          const views = [...document.querySelectorAll("[data-db], [data-board]")];
          return { views: views.length, shown: views.filter((v) => !v.querySelector(".bskel")).length };
        });
        run.js = {
          requests: scripts.length,
          transferKb: Math.round(scripts.reduce((a, b) => a + b.transfer, 0) / 100) / 10,
          decodedKb: Math.round(scripts.reduce((a, b) => a + b.decoded, 0) / 100) / 10,
        };
      } catch (e) {
        run.error = String(e).slice(0, 300);
      }
      console.log(`${fx} #${i + 1}: ${JSON.stringify(run)}`);
      runs.push(run);
      await ctx.close();
      // A reopen starts once the room has closed (the server lists no live room).
      if (REOPEN) {
        const t = Date.now();
        while (Date.now() - t < 180_000) {
          const r = (await (await fetch(`${OC}/readyz`)).json().catch(() => ({}))) as { rooms?: number };
          if (r.rooms === 0) break;
          await new Promise((res) => setTimeout(res, 250));
        }
      }
    }
    const num = (k: string) => runs.map((r) => r[k] as number);
    results[fx] = {
      firstScreenMs: { median: median(num("firstScreenMs")), worst: Math.max(...num("firstScreenMs").filter(Number.isFinite)) },
      heapMb: median(num("heapMb")),
      domNodes: median(num("domNodes")),
      errors: runs.filter((r) => r.error).length,
      runs,
    };
  }
  let initialJs: unknown = null;
  try {
    initialJs = JSON.parse(execFileSync("node", [path.join(ROOT, "web/packages/editor/scripts/check-budget.mjs"), DIST, "--json"], { encoding: "utf8" }));
  } catch (e) {
    initialJs = { error: String(e).slice(0, 200) };
  }
  const hardware = JSON.parse(execFileSync(path.join(TGT, "release/oc-bench"), ["hardware"], { encoding: "utf8" }));
  const commit = execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  const date = new Date().toISOString().slice(0, 10);
  const browserVersion = browser.version();
  const out = path.join(ROOT, `bench/results/${date}-browser-${MACHINE}${PARTIAL ? "-partial" : WHOLE ? "-whole" : ""}${REOPEN ? "-reopen" : ""}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        scenario: "BROWSER", date, commit, machine: MACHINE, hardware, browser: `Chromium ${browserVersion}`,
        profile: { ...PROFILE, note: "CDP network emulation shapes HTTP; WebSocket frames are not throttled" },
        serverEnv: { OC_MAX_DOC_MB: "128" }, store: "sqlite", runsPerFixture: RUNS,
        load: "one editor per run, a fresh file id each run (the room loads the fixture from the host)",
        initialJs, fixtures: results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`result: ${out}`);
});
