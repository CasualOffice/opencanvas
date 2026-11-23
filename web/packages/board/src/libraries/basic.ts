// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Basic shapes (DGM-14.7). Our own geometry; data only once built (ADR-045 §3).
import { at, G, join, turn, type LibraryData } from "./geo";

const { R, E, P, T, L } = G;

/** Shared outlines, reused by other libraries. */
export const CYLINDER = "M0 12C0 -4 100 -4 100 12V88C100 104 0 104 0 88Z M0 12C0 28 100 28 100 12";
export const CLOUD = "M25 85C8 85 0 72 4 60C-2 45 10 30 25 34C28 15 50 8 62 20C72 8 95 15 92 35C104 40 102 62 90 66C94 80 80 88 70 85Z";
export const DOCUMENT = "M0 0H100V85C75 70 50 100 25 92C15 89 8 86 0 85Z";
export const TAPE = "M0 10C25 25 75 -5 100 10V90C75 75 25 105 0 90Z";
export const NOTE = "M0 0H80L100 20V100H0Z M80 0V20H100";
export const HEART = "M50 25C50 10 30 0 15 5C0 10 -3 35 10 50L50 95L90 50C103 35 100 10 85 5C70 0 50 10 50 25Z";

/** Scales absolute path data (M/L/C/Z with coordinate pairs only) into the box x, y, w, h. */
export function fit(d: string, x: number, y: number, w: number, h: number): string {
  let i = 0;
  return d.replace(/-?\d+(\.\d+)?/g, (v) => {
    const k = i++ % 2 ? y + (Number(v) * h) / 100 : x + (Number(v) * w) / 100;
    return String(Math.round(k * 100) / 100);
  });
}

const RIGHT = [0, 28, 62, 28, 62, 0, 100, 50, 62, 100, 62, 72, 0, 72];
const arrow = (dir: "right" | "left" | "up" | "down") => P(...turn(dir, ...RIGHT));
const sq = at(100, 100);

export const BASIC: LibraryData = {
  id: "basic",
  name: "Basic shapes",
  icon: "shapes",
  items: [
    { name: "rectangle", label: "Rectangle", base: "rect", keywords: ["box", "square", "rect"], look: { path: R(0, 0, 100, 100), w: 140, h: 80, text: "" } },
    { name: "rounded", label: "Rounded rectangle", base: "rect", keywords: ["rounded", "box", "pill", "card"], look: { w: 140, h: 80, text: "" } },
    { name: "ellipse", label: "Ellipse", base: "ellipse", keywords: ["oval", "round"], look: { w: 140, h: 90, text: "" } },
    { name: "circle", label: "Circle", base: "ellipse", keywords: ["round", "dot", "oval"], look: { w: 90, h: 90, text: "" } },
    { name: "triangle", label: "Triangle", base: "rect", keywords: ["delta", "pyramid", "warning"], look: { path: P(50, 0, 100, 100, 0, 100), w: 110, h: 100, text: "", box: [25, 50, 50, 45] } },
    { name: "right-triangle", label: "Right triangle", base: "rect", keywords: ["triangle", "corner", "angle"], look: { path: P(0, 0, 100, 100, 0, 100), w: 100, h: 100, text: "", box: [4, 55, 50, 40] } },
    { name: "diamond", label: "Diamond", base: "diamond", keywords: ["rhombus", "decision", "lozenge"], look: { w: 110, h: 110, text: "" } },
    { name: "parallelogram", label: "Parallelogram", base: "rect", keywords: ["slant", "skew", "input"], look: { path: P(20, 0, 100, 0, 80, 100, 0, 100), w: 150, h: 80, text: "", box: [16, 0, 68, 100] } },
    { name: "trapezoid", label: "Trapezoid", base: "rect", keywords: ["trapezium", "manual"], look: { path: P(20, 0, 80, 0, 100, 100, 0, 100), w: 150, h: 80, text: "", box: [16, 0, 68, 100] } },
    { name: "pentagon", label: "Pentagon", base: "rect", keywords: ["five", "polygon"], look: { path: P(50, 0, 100, 38, 81, 100, 19, 100, 0, 38), w: 100, h: 96, text: "", box: [18, 30, 64, 62] } },
    { name: "hexagon", label: "Hexagon", base: "rect", keywords: ["six", "polygon", "honeycomb"], look: { path: P(25, 0, 75, 0, 100, 50, 75, 100, 25, 100, 0, 50), w: 120, h: 100, text: "", box: [16, 0, 68, 100] } },
    { name: "octagon", label: "Octagon", base: "rect", keywords: ["eight", "polygon", "stop"], look: { path: P(30, 0, 70, 0, 100, 30, 100, 70, 70, 100, 30, 100, 0, 70, 0, 30), w: 100, h: 100, text: "", box: [10, 10, 80, 80] } },
    { name: "star", label: "Star", base: "rect", keywords: ["five", "favourite", "favorite", "rating"], look: { path: sq.STAR(5, 50, 53, 51, 0.42), w: 100, h: 100, text: "", box: [30, 38, 40, 32] } },
    { name: "star-6", label: "Six-point star", base: "rect", keywords: ["star", "hexagram", "six"], look: { path: sq.STAR(6, 50, 50, 50, 0.58), w: 100, h: 100, text: "", box: [24, 30, 52, 40] } },
    { name: "plus", label: "Cross", base: "rect", keywords: ["plus", "add", "cross", "medical"], look: { path: P(34, 0, 66, 0, 66, 34, 100, 34, 100, 66, 66, 66, 66, 100, 34, 100, 34, 66, 0, 66, 0, 34, 34, 34), w: 90, h: 90, text: "", box: [0, 34, 100, 32] } },
    { name: "cylinder", label: "Cylinder", base: "rect", keywords: ["database", "db", "can", "storage", "drum"], look: { path: CYLINDER, w: 110, h: 110, text: "", box: [0, 26, 100, 66] } },
    { name: "cube", label: "Cube", base: "rect", keywords: ["box", "3d", "block"], look: { path: join(P(0, 20, 80, 20, 80, 100, 0, 100), P(0, 20, 20, 0, 100, 0, 80, 20), P(80, 20, 100, 0, 100, 80, 80, 100)), w: 110, h: 110, text: "", box: [0, 20, 80, 80] } },
    { name: "cloud", label: "Cloud", base: "rect", keywords: ["sky", "weather", "internet"], look: { path: CLOUD, w: 150, h: 100, text: "", box: [16, 30, 70, 50] } },
    { name: "heart", label: "Heart", base: "rect", keywords: ["love", "like", "favourite"], look: { path: HEART, w: 100, h: 90, text: "", box: [20, 18, 60, 40] } },
    { name: "lightning", label: "Lightning", base: "rect", keywords: ["bolt", "flash", "power", "energy", "fast"], look: { path: P(42, 0, 82, 0, 60, 38, 88, 38, 26, 100, 42, 54, 14, 54), w: 70, h: 100, text: "" } },
    { name: "moon", label: "Moon", base: "rect", keywords: ["crescent", "night", "dark"], look: { path: "M62 2A49 49 0 1 0 98 72A38 38 0 1 1 62 2Z", w: 90, h: 90, text: "" } },
    { name: "document", label: "Document", base: "rect", keywords: ["page", "paper", "file", "wave"], look: { path: DOCUMENT, w: 120, h: 90, text: "", box: [0, 0, 100, 80] } },
    { name: "note", label: "Folded corner", base: "rect", keywords: ["note", "dog ear", "page", "memo", "comment"], look: { path: NOTE, w: 120, h: 100, text: "", box: [0, 18, 100, 82] } },
    { name: "callout", label: "Callout", base: "rect", keywords: ["speech", "bubble", "comment", "say", "balloon"], look: { path: P(0, 0, 100, 0, 100, 75, 45, 75, 25, 100, 30, 75, 0, 75), w: 140, h: 100, text: "", box: [0, 0, 100, 75] } },
    { name: "callout-rounded", label: "Rounded callout", base: "rect", keywords: ["speech", "bubble", "chat", "comment", "say"], look: { path: "M10 0H90A10 14 0 0 1 100 14V61A10 14 0 0 1 90 75H50L24 100L32 75H10A10 14 0 0 1 0 61V14A10 14 0 0 1 10 0Z", w: 140, h: 100, text: "", box: [0, 0, 100, 75] } },
    { name: "callout-cloud", label: "Thought bubble", base: "rect", keywords: ["think", "thought", "cloud", "idea", "bubble"], look: { path: join(fit(CLOUD, 0, 0, 100, 80), E(22, 88, 6, 5), E(10, 96, 3.5, 3)), w: 150, h: 110, text: "", box: [16, 22, 70, 42] } },
    { name: "arrow-right", label: "Arrow right", base: "rect", keywords: ["block arrow", "next", "forward", "direction"], look: { path: arrow("right"), w: 140, h: 80, text: "", box: [0, 28, 66, 44] } },
    { name: "arrow-left", label: "Arrow left", base: "rect", keywords: ["block arrow", "back", "previous", "direction"], look: { path: arrow("left"), w: 140, h: 80, text: "", box: [34, 28, 66, 44] } },
    { name: "arrow-up", label: "Arrow up", base: "rect", keywords: ["block arrow", "increase", "raise", "direction"], look: { path: arrow("up"), w: 80, h: 140, text: "", box: [28, 34, 44, 66] } },
    { name: "arrow-down", label: "Arrow down", base: "rect", keywords: ["block arrow", "decrease", "lower", "direction"], look: { path: arrow("down"), w: 80, h: 140, text: "", box: [28, 0, 44, 66] } },
    { name: "arrow-double", label: "Double arrow", base: "rect", keywords: ["block arrow", "both", "two way", "exchange", "left right"], look: { path: P(0, 50, 25, 0, 25, 28, 75, 28, 75, 0, 100, 50, 75, 100, 75, 72, 25, 72, 25, 100), w: 160, h: 80, text: "", box: [22, 28, 56, 44] } },
    { name: "arrow-curved", label: "Curved arrow", base: "rect", keywords: ["block arrow", "turn", "bend", "return"], look: { path: "M0 100V55A45 45 0 0 1 45 10H66V0L100 25L66 50V40H45A15 15 0 0 0 30 55V100Z", w: 120, h: 110, text: "" } },
    { name: "chevron", label: "Chevron", base: "rect", keywords: ["arrow", "process", "stage", "next"], look: { path: P(0, 0, 72, 0, 100, 50, 72, 100, 0, 100, 28, 50), w: 140, h: 70, text: "", box: [26, 0, 50, 100] } },
    { name: "step", label: "Step", base: "rect", keywords: ["pentagon arrow", "home plate", "stage", "phase", "milestone"], look: { path: P(0, 0, 80, 0, 100, 50, 80, 100, 0, 100), w: 150, h: 70, text: "", box: [0, 0, 84, 100] } },
    { name: "brackets", label: "Brackets", base: "rect", keywords: ["bracket", "square", "group", "annotation"], look: { path: join(T(18, 0, 0, 0, 0, 100, 18, 100), T(82, 0, 100, 0, 100, 100, 82, 100)), w: 140, h: 90, text: "", box: [6, 0, 88, 100] } },
    { name: "braces", label: "Braces", base: "rect", keywords: ["brace", "curly", "group", "annotation"], look: { path: join("M20 0C8 0 10 4 10 16V40C10 46 6 50 0 50C6 50 10 54 10 60V84C10 96 8 100 20 100C8 100 10 96 10 84V60C10 54 6 50 0 50C6 50 10 46 10 40V16C10 4 8 0 20 0Z", "M80 0C92 0 90 4 90 16V40C90 46 94 50 100 50C94 50 90 54 90 60V84C90 96 92 100 80 100C92 100 90 96 90 84V60C90 54 94 50 100 50C94 50 90 46 90 40V16C90 4 92 0 80 0Z"), w: 140, h: 90, text: "", box: [12, 0, 76, 100] } },
    { name: "brace-left", label: "Left brace", base: "rect", keywords: ["brace", "curly", "annotation", "group"], look: { path: "M100 0C70 0 72 6 72 20V40C72 46 60 50 40 50C60 50 72 54 72 60V80C72 94 70 100 100 100C70 100 72 94 72 80V60C72 54 60 50 40 50C60 50 72 46 72 40V20C72 6 70 0 100 0Z", w: 30, h: 120, text: "" } },
    { name: "frame", label: "Frame", base: "rect", keywords: ["border", "picture", "outline", "panel"], look: { path: join(R(0, 0, 100, 100), R(7, 7, 86, 86)), w: 140, h: 100, text: "", box: [7, 7, 86, 86] } },
    { name: "plaque", label: "Plaque", base: "rect", keywords: ["badge", "label", "sign", "concave"], look: { path: "M12 0H88A12 12 0 0 0 100 12V88A12 12 0 0 0 88 100H12A12 12 0 0 0 0 88V12A12 12 0 0 0 12 0Z", w: 150, h: 80, text: "" } },
    { name: "donut", label: "Donut", base: "ellipse", keywords: ["ring", "doughnut", "circle", "hole"], look: { path: join(E(50, 50, 50), E(50, 50, 26, 26, true)), w: 90, h: 90, text: "" } },
    { name: "arc", label: "Block arc", base: "rect", keywords: ["arc", "arch", "half ring", "rainbow"], look: { path: "M0 100A50 100 0 0 1 100 100H76A26 52 0 0 0 24 100Z", w: 120, h: 60, text: "" } },
    { name: "pie", label: "Pie", base: "ellipse", keywords: ["slice", "sector", "pacman", "chart"], look: { path: sq.PIE(50, 50, 50, 0, 270), w: 90, h: 90, text: "" } },
    { name: "tape", label: "Tape", base: "rect", keywords: ["banner", "ribbon", "wave", "flag"], look: { path: TAPE, w: 140, h: 80, text: "", box: [0, 14, 100, 72] } },
    { name: "half-circle", label: "Half circle", base: "rect", keywords: ["semicircle", "dome", "half"], look: { path: "M0 100A50 100 0 0 1 100 100Z", w: 120, h: 60, text: "", box: [15, 40, 70, 60] } },
    { name: "line", label: "Line", base: "rect", keywords: ["divider", "rule", "separator", "horizontal"], look: { path: L(0, 50, 100, 50), w: 160, h: 20, text: "" } },
  ],
};
