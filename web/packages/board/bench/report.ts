// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Shared helpers for the board measurements: environment line, percentiles, result files.
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function env() {
  return {
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    memGB: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.platform()} ${os.release()}`,
    node: process.version,
    date: new Date().toISOString().slice(0, 10),
  };
}

export function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
  const f = (v: number) => +v.toFixed(3);
  return { mean: f(mean), p50: f(q(0.5)), p95: f(q(0.95)), max: f(s[s.length - 1] ?? 0) };
}

export function heapMB(): number {
  (globalThis as { gc?: () => void }).gc?.();
  (globalThis as { gc?: () => void }).gc?.();
  return +(process.memoryUsage().heapUsed / 2 ** 20).toFixed(1);
}

/** Writes `bench/results/<name>-<BENCH_LABEL or "latest">.json`. */
export function save(name: string, data: unknown) {
  // Run from the package directory (the bench config sets it as the root).
  const dir = path.join(process.cwd(), "bench", "results") + path.sep;
  mkdirSync(dir, { recursive: true });
  const label = process.env.BENCH_LABEL ?? "latest";
  writeFileSync(dir + `${name}-${label}.json`, JSON.stringify(data, null, 2) + "\n");
}
