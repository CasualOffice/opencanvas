// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSession } from "./session";

const busy = () => new Response(JSON.stringify({ error: { code: "BUSY" } }), { status: 503, headers: { "retry-after": "1" } });
const ok = () =>
  new Response(JSON.stringify({ ticket: "t", user: { id: "u" }, host: { id: "h" }, blocks: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("a busy server (503 + Retry-After) while rooms recover (RLB-01b)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("opening the canvas waits and asks again instead of showing an error", async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(busy()).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", f);
    const p = fetchSession("t");
    await vi.runAllTimersAsync();
    const s = await p;
    expect(s.ticket).toBe("t");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("gives up after the 60 s budget with the server's answer", async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockImplementation(async () => busy());
    vi.stubGlobal("fetch", f);
    const p = fetchSession("t").catch((e: Error) => e);
    await vi.runAllTimersAsync();
    expect(await p).toBeInstanceOf(Error);
    expect(f.mock.calls.length).toBeGreaterThan(5);
    expect(f.mock.calls.length).toBeLessThan(62);
  });
});
