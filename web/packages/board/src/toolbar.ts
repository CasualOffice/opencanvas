// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SCALE-02 / UX4-01, option A: how many tools fit in the bottom row of a board of a given width.
// All sizes are in rem and mirror styles.ts, so the answer holds at any root font size.

/** The personal "Tools on the left" setting (option B as a rail), kept per device. */
export const TOOLS_LEFT_KEY = "oc.board.toolsLeft";

const EDGE = 0.75 * 2; // the dock's inset on both sides
const PAD = 0.25 * 2; // the bar's padding
const GAP = 0.125; // between buttons
const SEP = 0.4375; // the separator after Pen (1px + its margins)
const BETWEEN = 0.5; // tools to zoom pill
const SEP_AFTER = 3; // Select, Sticky note, Pen | the rest
const tb = (compact: boolean) => (compact ? 2.75 : 2.125);
// The full pill: padding, zoom out, the % label, zoom in, a separator and the minimap.
const zoomFull = (compact: boolean) => 0.375 + 3 * (compact ? 2.375 : 1.75) + 2.75 + SEP;
const ZOOM_SHORT = 0.375 + 2.75;

/** The bar's length (rem) with `n` tools plus More, and `extra` buttons after a separator (the tool lock, BRD-19). */
const barLen = (n: number, compact: boolean, extra = 0) => PAD + (n + 1) * tb(compact) + n * GAP + (n > SEP_AFTER ? SEP : 0) + (extra ? SEP + extra * (tb(compact) + GAP) : 0);

/**
 * Tools shown (from the start of the priority order) and whether the zoom pill is full, for a board
 * `boardRem` wide. Tools leave from the end first, down to three; only then does the pill shrink to
 * its 100% button (and the tools it frees come back). A board not yet measured shows everything.
 */
export function fitTools(boardRem: number, count: number, compact: boolean, extra = 0): { shown: number; zoomFull: boolean } {
  if (!(boardRem > 0)) return { shown: count, zoomFull: true };
  const min = Math.min(3, count);
  const most = (zoom: number) => {
    for (let n = count; n >= min; n--) if (EDGE + barLen(n, compact, extra) + BETWEEN + zoom <= boardRem + 1e-6) return n;
    return 0;
  };
  const full = most(zoomFull(compact));
  if (full) return { shown: full, zoomFull: true };
  return { shown: Math.max(min, most(ZOOM_SHORT)), zoomFull: false };
}

/** Tools shown in the left rail of a board `boardRem` tall (the bottom-right pill is not in its way). */
export function fitRail(boardRem: number, count: number, compact: boolean, extra = 0): number {
  if (!(boardRem > 0)) return count;
  const min = Math.min(3, count);
  for (let n = count; n > min; n--) if (EDGE + barLen(n, compact, extra) <= boardRem + 1e-6) return n;
  return min;
}

export function readToolsLeft(): boolean {
  try {
    return localStorage.getItem(TOOLS_LEFT_KEY) === "1";
  } catch {
    return false;
  }
}
export function writeToolsLeft(on: boolean) {
  try {
    if (on) localStorage.setItem(TOOLS_LEFT_KEY, "1");
    else localStorage.removeItem(TOOLS_LEFT_KEY);
  } catch {
    /* private window: the setting lasts for this page */
  }
}
