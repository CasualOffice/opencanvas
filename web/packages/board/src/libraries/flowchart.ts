// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Flowchart (DGM-14.7): the standard flowchart symbol set (ISO 5807 / ANSI notation), drawn by us.
// Kind ids from step 1 (process … subprocess) are stored in documents and never change.
import { CYLINDER, DOCUMENT, fit, TAPE } from "./basic";
import { G, join, type LibraryData } from "./geo";

const { R, E, P, L } = G;
const D45 = 14.64, D55 = 85.36; // 45° points on the unit circle of radius 50

export const FLOWCHART: LibraryData = {
  id: "flowchart",
  name: "Flowchart",
  icon: "workflow",
  items: [
    { name: "process", label: "Process", base: "rect", keywords: ["step", "action", "task", "activity", "box"], look: { path: R(0, 0, 100, 100), w: 140, h: 70 } },
    { name: "alternate-process", label: "Alternate process", base: "rect", keywords: ["rounded", "alternative", "step", "process"], look: { w: 140, h: 70, text: "Process" } },
    { name: "decision", label: "Decision", base: "diamond", keywords: ["if", "branch", "condition", "question", "choice", "yes no"], look: { w: 140, h: 100 } },
    { name: "io", label: "Input or output", base: "rect", keywords: ["data", "input", "output", "read", "write", "io", "parallelogram"], look: { path: P(15, 0, 100, 0, 85, 100, 0, 100), w: 150, h: 70, text: "Data", box: [12, 0, 76, 100] } },
    { name: "subprocess", label: "Predefined process", base: "rect", keywords: ["subprocess", "predefined", "call", "routine", "function", "subroutine"], look: { path: join(R(0, 0, 100, 100), L(10, 0, 10, 100), L(90, 0, 90, 100)), w: 150, h: 70, text: "Subprocess", box: [10, 0, 80, 100] } },
    { name: "internal-storage", label: "Internal storage", base: "rect", keywords: ["memory", "ram", "storage", "variable"], look: { path: join(R(0, 0, 100, 100), L(14, 0, 14, 100), L(0, 18, 100, 18)), w: 140, h: 80, text: "Storage", box: [14, 18, 86, 82] } },
    { name: "document", label: "Document", base: "rect", keywords: ["file", "report", "paper", "print", "page"], look: { path: DOCUMENT, w: 140, h: 80, box: [0, 0, 100, 80] } },
    { name: "multi-document", label: "Multiple documents", base: "rect", keywords: ["documents", "files", "reports", "pages", "multi"], look: { path: join("M12 6V0H100V74H94", "M6 12V6H94V80H88", fit(DOCUMENT, 0, 12, 88, 88)), w: 150, h: 90, text: "Documents", box: [0, 12, 88, 66] } },
    { name: "terminator", label: "Start or end", base: "rect", keywords: ["start", "end", "begin", "stop", "terminal", "terminator", "finish"], look: { path: "M20 0H80A20 50 0 0 1 80 100H20A20 50 0 0 1 20 0Z", w: 140, h: 56, text: "Start", box: [12, 0, 76, 100] } },
    { name: "preparation", label: "Preparation", base: "rect", keywords: ["setup", "initialise", "initialize", "init", "hexagon", "loop"], look: { path: P(18, 0, 82, 0, 100, 50, 82, 100, 18, 100, 0, 50), w: 150, h: 70, box: [14, 0, 72, 100] } },
    { name: "manual-input", label: "Manual input", base: "rect", keywords: ["keyboard", "enter", "type", "user input", "form"], look: { path: P(0, 28, 100, 0, 100, 100, 0, 100), w: 140, h: 80, text: "Input", box: [0, 28, 100, 72] } },
    { name: "manual-operation", label: "Manual operation", base: "rect", keywords: ["manual", "human", "offline", "trapezoid", "by hand"], look: { path: P(0, 0, 100, 0, 82, 100, 18, 100), w: 150, h: 70, text: "Manual step", box: [14, 0, 72, 100] } },
    { name: "connector", label: "Connector", base: "ellipse", keywords: ["on-page", "reference", "jump", "circle", "link"], look: { w: 50, h: 50, text: "A" } },
    { name: "off-page", label: "Off-page connector", base: "rect", keywords: ["off page", "continue", "next page", "reference", "link"], look: { path: P(0, 0, 100, 0, 100, 62, 50, 100, 0, 62), w: 60, h: 64, text: "A", box: [0, 0, 100, 62] } },
    { name: "card", label: "Card", base: "rect", keywords: ["punched card", "record"], look: { path: P(20, 0, 100, 0, 100, 100, 0, 100, 0, 26), w: 140, h: 80 } },
    { name: "punched-tape", label: "Punched tape", base: "rect", keywords: ["tape", "paper tape", "wave"], look: { path: TAPE, w: 140, h: 80, text: "Tape", box: [0, 14, 100, 72] } },
    { name: "summing-junction", label: "Summing junction", base: "ellipse", keywords: ["and", "sum", "junction", "x"], look: { path: join(E(50, 50, 50), L(D45, D45, D55, D55), L(D55, D45, D45, D55)), w: 50, h: 50, text: "" } },
    { name: "or", label: "Or", base: "ellipse", keywords: ["or", "junction", "plus", "either"], look: { path: join(E(50, 50, 50), L(50, 0, 50, 100), L(0, 50, 100, 50)), w: 50, h: 50, text: "" } },
    { name: "collate", label: "Collate", base: "rect", keywords: ["hourglass", "organise", "gather", "order"], look: { path: "M0 0H100L0 100H100Z", w: 70, h: 80, text: "" } },
    { name: "sort", label: "Sort", base: "diamond", keywords: ["order", "arrange", "rank"], look: { path: join(P(50, 0, 100, 50, 50, 100, 0, 50), L(0, 50, 100, 50)), w: 80, h: 90, text: "" } },
    { name: "extract", label: "Extract", base: "rect", keywords: ["triangle", "split", "take"], look: { path: P(50, 0, 100, 100, 0, 100), w: 80, h: 70, text: "", box: [25, 50, 50, 46] } },
    { name: "merge", label: "Merge", base: "rect", keywords: ["triangle", "combine", "join", "storage"], look: { path: P(0, 0, 100, 0, 50, 100), w: 80, h: 70, text: "", box: [25, 4, 50, 46] } },
    { name: "stored-data", label: "Stored data", base: "rect", keywords: ["storage", "data", "save", "store"], look: { path: "M15 0H100C88 15 88 85 100 100H15C3 85 3 15 15 0Z", w: 140, h: 70, text: "Data", box: [10, 0, 80, 100] } },
    { name: "delay", label: "Delay", base: "rect", keywords: ["wait", "pause", "hold", "d shape", "timer"], look: { path: "M0 0H68A32 50 0 0 1 68 100H0Z", w: 130, h: 70, box: [0, 0, 86, 100] } },
    { name: "sequential-storage", label: "Sequential access storage", base: "ellipse", keywords: ["magnetic tape", "tape", "sequential", "backup"], look: { path: "M50 100A50 50 0 1 1 100 50V100Z", w: 80, h: 80, text: "Tape", box: [15, 15, 70, 70] } },
    { name: "magnetic-disk", label: "Magnetic disk", base: "rect", keywords: ["database", "db", "disk", "cylinder", "storage"], look: { path: CYLINDER, w: 110, h: 90, text: "Database", box: [0, 26, 100, 66] } },
    { name: "direct-storage", label: "Direct access storage", base: "rect", keywords: ["drum", "hard disk", "storage", "cylinder"], look: { path: "M12 0H88C104 0 104 100 88 100H12C-4 100 -4 0 12 0Z M88 0C72 0 72 100 88 100", w: 150, h: 70, text: "Storage", box: [4, 0, 76, 100] } },
    { name: "display", label: "Display", base: "rect", keywords: ["screen", "monitor", "show", "output"], look: { path: "M16 0H80C94 0 100 30 100 50C100 70 94 100 80 100H16L0 50Z", w: 150, h: 70, box: [12, 0, 76, 100] } },
    { name: "loop-limit", label: "Loop limit", base: "rect", keywords: ["loop", "for", "while", "repeat", "iteration"], look: { path: P(16, 0, 84, 0, 100, 24, 100, 100, 0, 100, 0, 24), w: 140, h: 70, text: "Loop", box: [0, 10, 100, 90] } },
    { name: "loop-end", label: "Loop end", base: "rect", keywords: ["loop", "end", "repeat", "until"], look: { path: P(0, 0, 100, 0, 100, 76, 84, 100, 16, 100, 0, 76), w: 140, h: 70, text: "End loop", box: [0, 0, 100, 90] } },
  ],
};
