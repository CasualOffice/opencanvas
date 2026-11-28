// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The layout runs in a Web Worker; where workers are missing (tests, old embeds) the same loop
// runs on the main thread in short slices.
import { run, type Cmd, type Frame } from "./runner-core";

export interface Runner {
  send(c: Cmd): void;
  stop(): void;
}

export function runner(onFrame: Frame): Runner {
  let w: Worker | null = null;
  try {
    w = typeof Worker === "undefined" ? null : new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
  } catch {
    w = null;
  }
  if (w) {
    const worker = w;
    worker.onmessage = (e: MessageEvent<{ gen: number; x: Float32Array; y: Float32Array; done: boolean }>) => onFrame(e.data.x, e.data.y, e.data.done, e.data.gen);
    let failed = false;
    let inline: ((c: Cmd) => void) | null = null;
    let last: Cmd | null = null;
    // A worker that cannot load (a strict CSP, a blocked URL) falls back to the main thread.
    worker.onerror = () => {
      if (failed) return;
      failed = true;
      inline = run(onFrame);
      if (last) inline(last);
    };
    return {
      send: (c) => {
        if (c.t === "start") last = c;
        if (inline) inline(c);
        else worker.postMessage(c);
      },
      stop: () => {
        inline?.({ t: "stop" });
        worker.terminate();
      },
    };
  }
  const h = run(onFrame);
  return { send: h, stop: () => h({ t: "stop" }) };
}
