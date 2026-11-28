// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Serves the production editor build for the demo-mode browser specs.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { ROOT } from "../env";

const DIST = path.join(ROOT, "web/packages/editor/dist");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

export function serve(dir = DIST): Promise<{ url: string; close(): void }> {
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

/** Opens the demo document and returns its first board block. */
export async function openDemo(page: Page, url: string) {
  await page.goto(`${url}/app/#demo&sim=quiet`);
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 30_000 });
  const board = page.locator(".ocbd").first();
  await expect(board).toBeVisible({ timeout: 30_000 });
  await board.scrollIntoViewIfNeeded();
  return board;
}
