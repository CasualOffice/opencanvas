// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// PSYNC-01 spike: time to first screen for each approach under the docs/36 profile
// (Chromium, 4x CPU throttle, 40 Mbit/s, 40 ms RTT), median of 5 runs.
//   node spikes/psync/web/bench.mjs <split dir> <web/ dir with node_modules> <e2e/ dir with playwright>
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const [dir, webDir, e2eDir] = process.argv.slice(2)
const here = path.dirname(new URL(import.meta.url).pathname)
const req = createRequire(path.join(webDir, 'node_modules/.pnpm/node_modules/x.js'))
const esbuild = req('esbuild')
const { chromium } = createRequire(path.join(e2eDir, 'package.json'))('@playwright/test')

const js = esbuild.buildSync({
  entryPoints: [path.join(here, 'page.js')],
  bundle: true,
  minify: true,
  format: 'esm',
  write: false,
  alias: { yjs: fs.globSync(path.join(webDir, 'node_modules/.pnpm/yjs@*/node_modules/yjs/dist/yjs.mjs'))[0] },
}).outputFiles[0].contents

const files = new Map()
const add = (url, body, type) => files.set(url, { gz: zlib.gzipSync(body, { level: 6 }), type, raw: body.length })
add('/', Buffer.from('<!doctype html><meta charset=utf-8><div id=root></div><script type=module src=/page.js></script>'), 'text/html')
add('/page.js', Buffer.from(js), 'text/javascript')
for (const f of ['full.bin', 'main.bin', 'sub/db00.bin', 'proj.json', 'proj-db.json']) {
  add(`/d/${f}`, fs.readFileSync(path.join(dir, f)), f.endsWith('.json') ? 'application/json' : 'application/octet-stream')
}
const sizes = {}
for (const [u, f] of files) if (u.startsWith('/d/')) {
  const raw = fs.readFileSync(path.join(dir, u.slice(3)))
  sizes[u.slice(3)] = { raw: f.raw, gzip: f.gz.length, zstd: zlib.zstdCompressSync ? zlib.zstdCompressSync(raw).length : null }
}
console.log(JSON.stringify(sizes))

const server = http.createServer((q, res) => {
  const f = files.get(q.url.split('?')[0])
  if (!f) return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': f.type, 'content-encoding': 'gzip', 'cache-control': 'no-store' })
  res.end(f.gz)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] })
const modes = ['full', 'sub', 'proj', 'full-db', 'sub-db', 'proj-db']
const out = {}
for (const mode of modes) {
  const runs = []
  for (let i = 0; i < 5; i++) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 40,
      downloadThroughput: (40e6 / 8),
      uploadThroughput: (40e6 / 8),
    })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await page.goto(`http://127.0.0.1:${port}/?mode=${mode}`)
    await page.waitForFunction(() => window.__result, null, { timeout: 300_000, polling: 100 })
    const r = await page.evaluate(() => window.__result)
    if (r.error) throw new Error(`${mode}: ${r.error}`)
    await cdp.send('HeapProfiler.collectGarbage')
    r.heap = (await cdp.send('Runtime.getHeapUsage')).usedSize
    runs.push(r)
    await ctx.close()
  }
  const med = (k) => runs.map((r) => r[k]).sort((a, b) => a - b)[2]
  out[mode] = {
    first_ms_median: Math.round(med('first')),
    first_ms_worst: Math.round(Math.max(...runs.map((r) => r.first))),
    caret_ms_median: Math.round(med('caret')),
    bytes_before_first: med('bytes'),
    js_heap_mb_after: +(med('heap') / 1e6).toFixed(1),
  }
  console.log(mode, JSON.stringify(out[mode]))
}
await browser.close()
server.close()
