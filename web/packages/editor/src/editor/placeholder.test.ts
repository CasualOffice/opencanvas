// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// Partial-sync placeholders (prototype large-tables 2a-2d): sized from the header, no shimmer,
// "Loading" only after 400 ms, failed loads retried with a countdown, offline wording.

import { act, createElement as h, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffS, BlockPlaceholder, MAX_TRIES, useRetryingLazy } from "./placeholder";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.useRealTimers();
  document.body.innerHTML = "";
});
function mount(node: ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  cleanup = () => act(() => root.unmount());
  return el;
}

describe("block placeholder", () => {
  it("names the block and its size from the header, says Loading only after 400 ms", () => {
    const el = mount(h(BlockPlaceholder, { info: { kind: "db", name: "Support tickets", count: 100_000, fields: 30, view: "table" } }));
    expect(el.textContent).toContain("Support tickets");
    expect(el.textContent).toContain("100,000 rows · 30 fields");
    expect(el.textContent).not.toContain("Loading");
    act(() => vi.advanceTimersByTime(399));
    expect(el.textContent).not.toContain("Loading");
    act(() => vi.advanceTimersByTime(2));
    expect(el.textContent).toContain("Loading table…");
    // Capped at the view height: never 100,000 skeleton rows.
    expect(el.querySelectorAll(".bst .r").length).toBeLessThan(40);
  });

  it("offline: a block never loaded is not on this device", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const el = mount(h(BlockPlaceholder, { info: { kind: "board", name: "Escalations", count: 1240 } }));
    expect(el.textContent).toContain("1,240 cards");
    expect(el.textContent).toContain("Not on this device. Escalations wasn’t opened before you went offline");
    vi.restoreAllMocks();
  });

  it("backs off 2, 4, 8 … 60 s", () => {
    expect([1, 2, 3, 6, 9].map(backoffS)).toEqual([2, 4, 8, 60, 60]);
  });

  it("a failed load counts down and retries; Retry now skips the wait; five failures stop the countdown", async () => {
    let calls = 0;
    const load = () => {
      calls++;
      return Promise.reject(new Error("offline chunk"));
    };
    function Host() {
      const { Comp, failed, wrap } = useRetryingLazy(load as () => Promise<{ default: () => null }>);
      const ph = h(BlockPlaceholder, { info: { kind: "db", name: "Support tickets", count: 10 }, failed });
      return wrap(h(Suspense, { fallback: ph }, h(Comp)), ph);
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    const el = mount(h(Host));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(calls).toBe(1);
    expect(el.textContent).toContain("Couldn’t load Support tickets. The rest of the canvas works. Trying again in 2 s.");
    await act(async () => void (await vi.advanceTimersByTimeAsync(2100)));
    expect(calls).toBe(2);
    expect(el.textContent).toContain("Trying again in 4 s.");
    const btn = [...el.querySelectorAll("button")].find((b) => b.textContent === "Retry now")!;
    await act(async () => {
      btn.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toBe(3);
    for (let i = calls; i < MAX_TRIES; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(61_000)));
    expect(calls).toBe(MAX_TRIES);
    expect(el.textContent).toContain("Couldn’t load Support tickets. The rest of the canvas works.");
    expect(el.textContent).not.toContain("Trying again");
    await act(async () => void (await vi.advanceTimersByTimeAsync(120_000)));
    expect(calls).toBe(MAX_TRIES);
    vi.restoreAllMocks();
  });
});
