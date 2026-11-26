// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

/** How long the editor waits out a busy server before it shows the server's answer. */
export const BUSY_BUDGET_MS = 60_000;

/**
 * RLB-01b: `fetch` that waits out `503` + `Retry-After` (the server is recovering rooms after a
 * restart, or its database pool is saturated). It retries after the server's delay plus up to
 * 1 s of spread, for at most {@link BUSY_BUDGET_MS}; any other answer is returned as it is.
 * `onWait(seconds)` runs before each wait, for a "Reconnecting" state.
 */
export async function fetchBusy(input: RequestInfo | URL, init?: RequestInit, onWait?: (secs: number) => void): Promise<Response> {
  const start = Date.now();
  for (;;) {
    const r = await fetch(input, init);
    const ra = Number(r.headers.get("retry-after"));
    if (r.status !== 503 || !r.headers.has("retry-after") || !Number.isFinite(ra)) return r;
    const wait = Math.min(Math.max(ra, 1), 30) * 1000 + Math.floor(Math.random() * 1000);
    if (Date.now() - start + wait > BUSY_BUDGET_MS) return r;
    onWait?.(ra);
    await new Promise((res) => setTimeout(res, wait));
  }
}
