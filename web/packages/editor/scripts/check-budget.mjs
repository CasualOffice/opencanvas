#!/usr/bin/env node
// Initial-JS budget (docs/02 §7): the entry chunk plus every chunk it imports
// statically (what index.html loads and modulepreloads) must stay ≤ 300 KB gzip.
// Reads the Vite manifest written by `vite build`; exits 1 when over budget.
//
//   node scripts/check-budget.mjs [distDir] [--limit=KB]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const dist = resolve(args.find((a) => !a.startsWith("--")) ?? "dist");
const limitKb = Number(args.find((a) => a.startsWith("--limit="))?.slice(8) ?? 300);

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(dist, ".vite", "manifest.json"), "utf8"));
} catch (e) {
  console.error(`check-budget: no manifest in ${dist}/.vite (build.manifest must be on): ${e.message}`);
  process.exit(2);
}

const entries = Object.entries(manifest).filter(([, c]) => c.isEntry);
if (!entries.length) {
  console.error("check-budget: the manifest has no entry chunk");
  process.exit(2);
}

// Walk static imports only; dynamicImports are lazy by definition.
const seen = new Set();
const files = [];
const walk = (key) => {
  if (seen.has(key)) return;
  seen.add(key);
  const c = manifest[key];
  if (!c) return;
  if (c.file.endsWith(".js")) files.push(c.file);
  for (const k of c.imports ?? []) walk(k);
};
for (const [key] of entries) walk(key);

// The HTML must not modulepreload anything outside that set (a lazy chunk preloaded
// eagerly costs the same as a static import).
const html = readFileSync(join(dist, "index.html"), "utf8");
const preloaded = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="[^"]*?assets\/([^"]+)"/g)].map((m) => "assets/" + m[1]);
const stray = preloaded.filter((f) => !files.includes(f));

let total = 0;
const rows = files.map((f) => {
  const gz = gzipSync(readFileSync(join(dist, f))).length;
  total += gz;
  return [f, gz];
});
rows.sort((a, b) => b[1] - a[1]);
const kb = (n) => (n / 1000).toFixed(1).padStart(7) + " KB";
console.log("Initial JS (entry + static imports, gzip):");
for (const [f, gz] of rows) console.log(`${kb(gz)}  ${f}`);
console.log(`${kb(total)}  total (budget ${limitKb} KB, headroom ${((limitKb * 1000 - total) / 1000).toFixed(1)} KB)`);

if (stray.length) {
  console.error(`check-budget: index.html modulepreloads lazy chunks: ${stray.join(", ")}`);
  process.exit(1);
}
if (total > limitKb * 1000) {
  console.error(`check-budget: initial JS ${(total / 1000).toFixed(1)} KB gzip is over the ${limitKb} KB budget (docs/02 §7)`);
  process.exit(1);
}
