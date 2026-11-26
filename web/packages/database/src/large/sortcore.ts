// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Stable multi-key sort over plain key columns, as bottom-up merge passes so a worker can report
// progress between passes (prototype 1c). Shared by the worker and the in-thread fallback.

/** One key column: numbers (NaN = empty, always last) or lower-case text ("" = empty, last). */
export type KeyCol = Float64Array | string[];

export interface SortJob {
  keys: KeyCol[];
  dirs: (1 | -1)[];
  n: number;
}

function cmp(job: SortJob, a: number, b: number): number {
  for (let k = 0; k < job.keys.length; k++) {
    const col = job.keys[k];
    const x = col[a], y = col[b];
    const ex = typeof x === "number" ? Number.isNaN(x) : x === "";
    const ey = typeof y === "number" ? Number.isNaN(y) : y === "";
    if (ex || ey) {
      if (ex && ey) continue;
      return ex ? 1 : -1; // empty cells last in either direction
    }
    const d = x < y ? -1 : x > y ? 1 : 0;
    if (d) return d * job.dirs[k];
  }
  return a - b;
}

/** Row indexes in sorted order; `progress(0..1)` after every merge pass. */
export function sortOrder(job: SortJob, progress?: (p: number) => void): Int32Array {
  let src = new Int32Array(job.n);
  for (let i = 0; i < job.n; i++) src[i] = i;
  let dst = new Int32Array(job.n);
  const passes = Math.max(1, Math.ceil(Math.log2(Math.max(2, job.n))));
  let pass = 0;
  for (let w = 1; w < job.n; w *= 2) {
    for (let lo = 0; lo < job.n; lo += 2 * w) {
      const mid = Math.min(lo + w, job.n), hi = Math.min(lo + 2 * w, job.n);
      let i = lo, j = mid, o = lo;
      while (i < mid && j < hi) dst[o++] = cmp(job, src[i], src[j]) <= 0 ? src[i++] : src[j++];
      while (i < mid) dst[o++] = src[i++];
      while (j < hi) dst[o++] = src[j++];
    }
    [src, dst] = [dst, src];
    progress?.(++pass / passes);
  }
  return src;
}
