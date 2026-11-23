// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Arrows (DGM-14.7): block arrows in every common form, drawn by us. Right-pointing outlines are
// turned for the other directions (`turn`), so each family stays consistent.
import { G, join, turn, type Item, type LibraryData } from "./geo";

const { P, L } = G;
type Dir = "right" | "left" | "up" | "down";
const DIRS: Dir[] = ["right", "left", "up", "down"];
const WORD: Record<Dir, string> = { right: "right", left: "left", up: "up", down: "down" };
const SYN: Record<Dir, string[]> = { right: ["next", "forward", "east"], left: ["back", "previous", "west"], up: ["increase", "north", "raise"], down: ["decrease", "south", "lower"] };
const wide = (d: Dir) => (d === "right" || d === "left" ? { w: 140, h: 80 } : { w: 80, h: 140 });

/** A block arrow family in four directions from right-pointing points. */
function family(id: string, label: string, kw: string[], right: number[], rightBox?: [number, number, number, number]): Item[] {
  return DIRS.map((d) => ({
    name: `${id}-${d}`, label: `${label} ${WORD[d]}`, base: "rect" as const, keywords: [...kw, ...SYN[d], "arrow"],
    look: { path: P(...turn(d, ...right)), ...wide(d), text: "", ...(rightBox ? { box: boxTurn(d, rightBox) } : {}) },
  }));
}

function boxTurn(d: Dir, [x, y, w, h]: [number, number, number, number]): [number, number, number, number] {
  if (d === "right") return [x, y, w, h];
  if (d === "left") return [100 - x - w, y, w, h];
  if (d === "up") return [y, 100 - x - w, h, w];
  return [100 - y - h, x, h, w];
}

const one = (name: string, label: string, keywords: string[], path: string, w: number, h: number, box?: [number, number, number, number]): Item => ({
  name, label, base: "rect", keywords: [...keywords, "arrow"], look: { path, w, h, text: "", ...(box ? { box } : {}) },
});

const STRAIGHT = [0, 30, 60, 30, 60, 4, 100, 50, 60, 96, 60, 70, 0, 70];
const SLIM = [0, 42, 78, 42, 78, 22, 100, 50, 78, 78, 78, 58, 0, 58];
const NOTCHED = [0, 30, 60, 30, 60, 4, 100, 50, 60, 96, 60, 70, 0, 70, 14, 50];
const CHEVRON = [0, 0, 70, 0, 100, 50, 70, 100, 0, 100, 30, 50];
const HOME = [0, 0, 76, 0, 100, 50, 76, 100, 0, 100];
const CALLOUT = [0, 0, 58, 0, 58, 32, 76, 32, 76, 16, 100, 50, 76, 84, 76, 68, 58, 68, 58, 100, 0, 100];
const TRIANGLE = [0, 0, 100, 50, 0, 100];

const striped = (d: Dir) => {
  const bars = [P(...turn(d, 0, 30, 6, 30, 6, 70, 0, 70)), P(...turn(d, 11, 30, 17, 30, 17, 70, 11, 70))];
  return join(P(...turn(d, 24, 30, 60, 30, 60, 4, 100, 50, 60, 96, 60, 70, 24, 70)), ...bars);
};

export const ARROWS: LibraryData = {
  id: "arrows",
  name: "Arrows",
  icon: "move-right",
  items: [
    ...family("block", "Arrow", ["block arrow", "direction", "pointer"], STRAIGHT, [0, 30, 64, 40]),
    ...family("slim", "Slim arrow", ["thin arrow", "line arrow", "pointer"], SLIM),
    ...family("notched", "Notched arrow", ["notch", "tail", "process"], NOTCHED, [16, 30, 48, 40]),
    ...DIRS.map((d) => one(`striped-${d}`, `Striped arrow ${d}`, ["stripes", "speed", "motion", "fast", ...SYN[d]], striped(d), wide(d).w, wide(d).h)),
    ...family("chevron", "Chevron", ["chevron", "stage", "step", "phase"], CHEVRON, [26, 0, 50, 100]),
    ...family("callout", "Callout arrow", ["callout", "label arrow", "pointer"], CALLOUT, [0, 0, 58, 100]),
    ...family("triangle", "Triangle arrow", ["triangle", "play", "pointer", "caret"], TRIANGLE),
    one("pentagon", "Pentagon arrow", ["home plate", "step", "milestone", "tag"], P(...HOME), 150, 70, [0, 0, 82, 100]),
    one("left-right", "Left and right arrow", ["double", "both ways", "exchange", "horizontal", "swap"], P(0, 50, 24, 8, 24, 32, 76, 32, 76, 8, 100, 50, 76, 92, 76, 68, 24, 68, 24, 92), 160, 70, [22, 32, 56, 36]),
    one("up-down", "Up and down arrow", ["double", "both ways", "vertical", "scroll"], P(50, 0, 92, 24, 68, 24, 68, 76, 92, 76, 50, 100, 8, 76, 32, 76, 32, 24, 8, 24), 70, 160),
    one("quad", "Four-way arrow", ["quad", "move", "all directions", "cross", "pan"], P(50, 0, 66, 18, 57, 18, 57, 43, 82, 43, 82, 34, 100, 50, 82, 66, 82, 57, 57, 57, 57, 82, 66, 82, 50, 100, 34, 82, 43, 82, 43, 57, 18, 57, 18, 66, 0, 50, 18, 34, 18, 43, 43, 43, 43, 18, 34, 18), 110, 110),
    one("tri", "Three-way arrow", ["split", "fork", "branch", "three ways"], P(0, 62, 18, 46, 18, 55, 43, 55, 43, 18, 34, 18, 50, 0, 66, 18, 57, 18, 57, 55, 82, 55, 82, 46, 100, 62, 82, 78, 82, 69, 18, 69, 18, 78), 120, 100),
    one("bent-right", "Bent arrow", ["bent", "turn", "corner", "elbow"], P(0, 100, 0, 40, 64, 40, 64, 16, 100, 52, 64, 88, 64, 64, 24, 64, 24, 100), 110, 100),
    one("bent-up", "Bent-up arrow", ["bent", "turn up", "corner", "elbow"], P(0, 64, 60, 64, 60, 30, 40, 30, 72, 0, 100, 30, 84, 30, 84, 88, 0, 88), 110, 100),
    one("u-turn", "U-turn arrow", ["u turn", "return", "reverse", "back"], "M0 100V40A40 40 0 0 1 80 40V58H100L70 92L40 58H58V40A18 18 0 0 0 22 40V100Z", 110, 100),
    one("circular", "Circular arrow", ["circle", "cycle", "repeat", "refresh", "loop", "rotate"], "M50 12A42 42 0 1 1 10.5 68.4L27.4 62.2A24 24 0 1 0 50 30V40L30 21L50 2Z", 100, 100),
    one("curved-right", "Curved arrow right", ["curve", "swoosh", "bend", "arc"], "M0 100C0 50 30 26 66 24V8L100 38L66 68V50C40 52 22 70 22 100Z", 120, 100),
    one("curved-left", "Curved arrow left", ["curve", "swoosh", "bend", "arc"], "M100 100C100 50 70 26 34 24V8L0 38L34 68V50C60 52 78 70 78 100Z", 120, 100),
    one("return", "Return arrow", ["enter", "back", "reply", "undo"], "M100 0V52C100 62 94 68 84 68H32V86L0 58L32 30V48H80V0Z", 110, 90),
    one("diagonal-ne", "Diagonal arrow up right", ["diagonal", "north east", "growth", "trend up"], P(100, 0, 100, 52, 82, 34, 18, 98, 2, 82, 66, 18, 48, 0), 90, 90),
    one("diagonal-se", "Diagonal arrow down right", ["diagonal", "south east", "decline", "trend down"], P(100, 100, 48, 100, 66, 82, 2, 18, 18, 2, 82, 66, 100, 48), 90, 90),
    one("split", "Split arrow", ["fork", "branch", "diverge", "y"], P(0, 40, 44, 40, 66, 18, 58, 10, 100, 0, 90, 42, 82, 34, 62, 50, 82, 66, 90, 58, 100, 100, 58, 90, 66, 82, 44, 60, 0, 60), 120, 100),
    one("merge", "Merge arrow", ["join", "converge", "combine", "funnel"], P(0, 8, 14, 0, 50, 36, 76, 36, 76, 20, 100, 50, 76, 80, 76, 64, 50, 64, 14, 100, 0, 92, 38, 50), 130, 100),
    one("zigzag", "Zigzag arrow", ["lightning", "zig zag", "path", "erratic"], P(0, 30, 34, 66, 52, 46, 74, 66, 74, 50, 100, 82, 66, 100, 66, 82, 50, 68, 34, 90, 0, 52), 130, 100),
    one("trend-up", "Trend arrow", ["trend", "growth", "progress", "chart", "rising"], P(0, 80, 34, 46, 54, 66, 76, 44, 66, 34, 100, 24, 92, 58, 82, 48, 54, 76, 34, 56, 10, 90), 130, 100),
    one("refresh", "Two circular arrows", ["sync", "refresh", "reload", "exchange", "cycle"], join("M14 44A38 38 0 0 1 82 30L92 20V50H62L74 38A24 24 0 0 0 28 44Z", "M86 56A38 38 0 0 1 18 70L8 80V50H38L26 62A24 24 0 0 0 72 56Z"), 100, 100),
    one("dashed-right", "Dashed arrow", ["dashed", "dotted", "optional", "future"], join(P(0, 42, 14, 42, 14, 58, 0, 58), P(22, 42, 36, 42, 36, 58, 22, 58), P(44, 42, 58, 42, 58, 58, 44, 58), P(66, 26, 100, 50, 66, 74)), 140, 60),
    one("line-right", "Line arrow", ["connector", "pointer", "line", "simple"], join(L(0, 50, 92, 50), P(100, 50, 80, 36, 80, 64)), 140, 30),
  ],
};
