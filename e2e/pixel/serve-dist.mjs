#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Serves a built editor (`web/packages/editor/dist`, or a saved copy) at /app/ for the pixel
// suite (pixel.config.ts). `#demo` needs no server, so a static copy is enough.
//
//   node e2e/pixel/serve-dist.mjs <distDir> [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? "web/packages/editor/dist");
const port = Number(process.argv[3] ?? 4290);
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".map": "application/json",
};

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/healthz") return res.end("ok");
    let rel = url.pathname.replace(/^\/app\/?/, "");
    if (!rel) rel = "index.html";
    const file = path.join(dir, path.normalize(rel));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("content-type", TYPES[path.extname(file)] ?? "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, "127.0.0.1", () => console.log(`[pixel] serving ${dir} on :${port}`));
