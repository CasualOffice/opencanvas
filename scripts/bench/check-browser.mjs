#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Nightly browser gate (ADR-079 MEM, PSYNC50): a browser result
// (bench/results/<date>-browser-<machine>.json, e2e/perf/first-screen.bench.ts) against
// bench/budgets.toml [heap_mb] and [first_screen_ms]. A budget of 0 is not set yet. Exits 1 on a
// breach or a fixture that failed to open. A table [first_screen_ms.<machine>] (the result's
// `machine`, e.g. ci-ubuntu-latest) overrides the reference machine's budgets for that machine
// only, each set from a baseline measured on that machine (docs/36 §3.5).
//
//   node scripts/bench/check-browser.mjs bench/results/2026-11-26-browser-local.json
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const file = process.argv[2];
if (!file) {
  console.error("usage: check-browser.mjs <browser result json>");
  process.exit(2);
}
// The [heap_mb] and [first_screen_ms] tables: plain `key = number` lines.
const budgets = {};
let table = "";
for (const line of readFileSync(resolve(root, "bench/budgets.toml"), "utf8").split("\n")) {
  const t = line.match(/^\[([\w.-]+)\]/);
  if (t) table = t[1];
  const kv = line.match(/^\s*([\w-]+)\s*=\s*([\d_.]+)\s*(#.*)?$/);
  if (kv && /^(heap_mb|first_screen_ms)(\.[\w-]+)?$/.test(table)) (budgets[table] ??= {})[kv[1]] = Number(kv[2].replace(/_/g, ""));
}
const result = JSON.parse(readFileSync(file, "utf8"));
for (const t of ["heap_mb", "first_screen_ms"]) {
  const own = budgets[`${t}.${result.machine}`];
  if (own) {
    budgets[t] = { ...budgets[t], ...own };
    console.log(`${t}: ${result.machine} budgets ${JSON.stringify(own)}`);
  }
}
const fails = [];
for (const [fx, r] of Object.entries(result.fixtures ?? {})) {
  if (r.errors) fails.push(`${fx}: ${r.errors} run(s) failed to open`);
  const heap = budgets.heap_mb?.[fx];
  if (heap && r.heapMb > heap) fails.push(`${fx}: heap ${r.heapMb} MB > ${heap} MB`);
  const fs = budgets.first_screen_ms?.[fx];
  const med = r.firstScreenMs?.median;
  if (fs && (med === null || med > fs)) fails.push(`${fx}: first screen ${med} ms > ${fs} ms`);
  console.log(`${fx}: first screen ${med} ms (budget ${fs || "-"}), heap ${r.heapMb} MB (budget ${heap || "-"})`);
}
if (fails.length) {
  console.error(`check-browser: over budget:\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
console.log("check-browser: within budgets");
