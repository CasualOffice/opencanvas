#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Initial-JS budget (docs/02 §7, ADR-079 START): the entry chunk plus every chunk it imports
// statically (what index.html loads and modulepreloads) must stay within
// `[start] initial_js_kb` of bench/budgets.toml (gzip), and no advanced module (`[start] forbid`,
// matched against the sources in each initial chunk's source map) may be in that graph.
// Reads the Vite manifest written by `vite build`; exits 1 on a breach.
//
//   node scripts/check-budget.mjs [distDir] [--limit=KB] [--forbid=re,re] [--json]
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** The subset of TOML bench/budgets.toml uses: [tables], numbers, strings and arrays. */
export function parseToml(text) {
  const out = {};
  let cur = out;
  let pending = null;
  const value = (v) => {
    v = v.trim();
    if (v.startsWith("[")) return JSON.parse(v.replace(/,\s*]$/, "]"));
    if (v.startsWith('"')) return JSON.parse(v);
    if (v === "true" || v === "false") return v === "true";
    return Number(v.replace(/_/g, ""));
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    if (pending) {
      pending.buf += " " + line.trim();
      if (line.includes("]")) {
        cur[pending.key] = value(pending.buf);
        pending = null;
      }
      continue;
    }
    if (!line.trim()) continue;
    const t = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (t) {
      cur = out;
      for (const k of t[1].split(".")) cur = cur[k.replace(/"/g, "")] ??= {};
      continue;
    }
    const kv = line.match(/^\s*("?[\w.-]+"?)\s*=\s*(.*)$/);
    if (!kv) throw new Error(`budgets.toml: cannot read line: ${raw}`);
    const key = kv[1].replace(/"/g, "");
    if (kv[2].trim().startsWith("[") && !kv[2].includes("]")) pending = { key, buf: kv[2].trim() };
    else cur[key] = value(kv[2]);
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const budgetsPath = join(repoRoot, "bench/budgets.toml");
const budgets = existsSync(budgetsPath) ? parseToml(readFileSync(budgetsPath, "utf8")) : {};

const args = process.argv.slice(2);
const dist = resolve(args.find((a) => !a.startsWith("--")) ?? "dist");
const limitKb = Number(args.find((a) => a.startsWith("--limit="))?.slice(8) ?? budgets.start?.initial_js_kb ?? 300);
const forbidArg = args.find((a) => a.startsWith("--forbid="))?.slice(9);
const forbid = (forbidArg !== undefined ? forbidArg.split(",").filter(Boolean) : (budgets.start?.forbid ?? [])).map((r) => new RegExp(r));
const asJson = args.includes("--json");

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

// Advanced modules in the initial graph: the sources of each initial chunk (its source map).
const forbidden = [];
for (const f of files) {
  if (!forbid.length) break;
  let sources = [];
  try {
    sources = JSON.parse(readFileSync(join(dist, f + ".map"), "utf8")).sources ?? [];
  } catch {
    console.error(`check-budget: no source map for ${f} (build.sourcemap must be on for --forbid)`);
    process.exit(2);
  }
  for (const s of sources) {
    // Map sources are relative to the chunk: match on the path from the repository root.
    const src = relative(repoRoot, resolve(dist, dirname(f), s));
    const re = forbid.find((r) => r.test(src));
    if (re) forbidden.push(`${f}: ${src} (${re.source})`);
  }
}

if (asJson) {
  console.log(JSON.stringify({ gzipBytes: total, budgetKb: limitKb, files: rows.map(([f, gz]) => ({ file: f, gzipBytes: gz })), forbidden, strayPreloads: stray }));
} else {
  const kb = (n) => (n / 1000).toFixed(1).padStart(7) + " KB";
  console.log("Initial JS (entry + static imports, gzip):");
  for (const [f, gz] of rows) console.log(`${kb(gz)}  ${f}`);
  console.log(`${kb(total)}  total (budget ${limitKb} KB, headroom ${((limitKb * 1000 - total) / 1000).toFixed(1)} KB)`);
}

if (forbidden.length) {
  console.error(`check-budget: advanced modules in the initial JS (bench/budgets.toml [start] forbid):\n  ${forbidden.slice(0, 20).join("\n  ")}${forbidden.length > 20 ? `\n  … ${forbidden.length - 20} more` : ""}`);
  process.exit(1);
}

if (stray.length) {
  console.error(`check-budget: index.html modulepreloads lazy chunks: ${stray.join(", ")}`);
  process.exit(1);
}
if (total > limitKb * 1000) {
  console.error(`check-budget: initial JS ${(total / 1000).toFixed(1)} KB gzip is over the ${limitKb} KB budget (docs/02 §7)`);
  process.exit(1);
}
