// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { WebsocketProvider } from "y-websocket";
import { reconnectDelay, throttleOutgoing } from "./session";

describe("reconnect storm control (PERF-11, docs/36 §4.1)", () => {
  it("uses full jitter: 0–5 s first, doubling to at most 60 s", () => {
    expect(reconnectDelay(0, 0)).toBe(0);
    expect(reconnectDelay(0, 0.999)).toBeLessThan(5000);
    expect(reconnectDelay(1, 0.999)).toBeGreaterThan(5000);
    expect(reconnectDelay(1, 0.999)).toBeLessThan(10000);
    expect(reconnectDelay(20, 0.999)).toBeLessThan(60000);
    expect(reconnectDelay(20, 0.999)).toBeGreaterThan(59000);
  });
});

describe("presence throttle (ADR-077)", () => {
  afterEach(() => vi.useRealTimers());

  it("sends awareness at most every 100 ms, latest wins", () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const sent: number[] = [];
    const provider = {
      doc,
      awareness,
      _updateHandler: () => {},
      _awarenessUpdateHandler: () => sent.push(Date.now()),
    } as unknown as WebsocketProvider;
    throttleOutgoing(provider);
    const t0 = Date.now();
    awareness.setLocalStateField("cursor", 1);
    for (let i = 2; i < 10; i++) {
      vi.advanceTimersByTime(20);
      awareness.setLocalStateField("cursor", i);
    }
    vi.advanceTimersByTime(500);
    const gaps = sent.map((t) => t - t0);
    expect(gaps[0]).toBe(0);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i] - gaps[i - 1]).toBeGreaterThanOrEqual(100);
  });
});
