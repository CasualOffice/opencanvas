// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The layout loop shared by the worker and the main-thread fallback: commands in, frames out.
import { createSim, pin, reheat, seed, settle, tick, type LayoutInput, type Sim } from "./layout";

export type Cmd =
  | { t: "start"; gen: number; input: LayoutInput; known: [string, [number, number]][]; pins: [string, [number, number]][]; alpha: number; still: boolean; seed: number }
  | { t: "pin"; i: number; x: number | null; y: number | null; heat: number }
  | { t: "reheat"; heat: number }
  | { t: "stop" };

export type Frame = (x: Float32Array, y: Float32Array, done: boolean, gen: number) => void;

/** Ticks per frame while it moves, and the frame interval. */
const PER_FRAME = 2;
const FRAME_MS = 16;

export function run(out: Frame): (c: Cmd) => void {
  let sim: Sim | null = null,
    gen = 0,
    timer: ReturnType<typeof setTimeout> | null = null,
    still = false;
  const send = (done: boolean) => {
    if (!sim) return;
    out(Float32Array.from(sim.x), Float32Array.from(sim.y), done, gen);
  };
  const loop = () => {
    timer = null;
    if (!sim) return;
    if (still) {
      settle(sim, 1000);
      return send(true);
    }
    let moved = false;
    for (let i = 0; i < PER_FRAME; i++) moved = tick(sim) || moved;
    if (moved) {
      send(false);
      timer = setTimeout(loop, FRAME_MS);
    } else send(true);
  };
  const kick = () => timer ?? (timer = setTimeout(loop, 0));
  return (c) => {
    if (c.t === "start") {
      if (timer) clearTimeout(timer), (timer = null);
      gen = c.gen;
      still = c.still;
      sim = createSim(c.input, seed(c.input, new Map(c.known), c.seed), new Map(c.pins), c.alpha);
      kick();
    } else if (c.t === "stop") {
      if (timer) clearTimeout(timer), (timer = null);
      sim = null;
    } else if (sim) {
      if (c.t === "pin") pin(sim, c.i, c.x, c.y);
      reheat(sim, c.heat);
      kick();
    }
  };
}
