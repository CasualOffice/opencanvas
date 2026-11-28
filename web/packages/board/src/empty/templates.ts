// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Starter templates for an empty board (board UX prototype 9a, decision 11). They are ordinary
// shapes and frames (`diagram:container` with `props.parent` members, BRD-21), inserted in one
// Undo step, centred on the view.
import { nid, type Shape } from "../model";
import { CONTAINER } from "../kinds";

export interface Template {
  id: "retro" | "flow" | "brain";
  name: string;
  /** The shapes, centred on (cx, cy), with fresh ids. */
  build: (cx: number, cy: number) => Shape[];
}

const frame = (x: number, y: number, w: number, h: number, label: string): Shape => ({ id: nid("s"), type: "rect", kind: CONTAINER, kindVersion: 1, x, y, w, h, label });
const sticky = (x: number, y: number, fill: string, text: string, parent?: string): Shape => ({ id: nid("s"), type: "sticky", x, y, w: 150, h: 110, fill, text, ...(parent ? { props: { parent } } : {}) });
const link = (a: Shape, b: Shape, text?: string): Shape => ({ id: nid("s"), type: "arrow", start: { shapeId: a.id, anchor: "center" }, end: { shapeId: b.id, anchor: "center" }, pts: [[(a.x ?? 0) + (a.w ?? 0) / 2, (a.y ?? 0) + (a.h ?? 0) / 2], [(b.x ?? 0) + (b.w ?? 0) / 2, (b.y ?? 0) + (b.h ?? 0) / 2]], ...(text ? { text } : {}) });

export const TEMPLATES: Template[] = [
  {
    id: "retro",
    name: "Retrospective",
    build: (cx, cy) => {
      const w = 300, h = 380, gap = 40, x0 = cx - (w * 3 + gap * 2) / 2, y0 = cy - h / 2;
      const cols: [string, string, string][] = [["Went well", "g", "What helped us"], ["To improve", "p", "What slowed us down"], ["Actions", "b", "What we try next"]];
      return cols.flatMap(([label, fill, hint], i) => {
        const f = frame(x0 + i * (w + gap), y0, w, h, label);
        return [f, sticky((f.x ?? 0) + 24, (f.y ?? 0) + 32, fill, hint, f.id)];
      });
    },
  },
  {
    id: "flow",
    name: "Flowchart",
    build: (cx, cy) => {
      const y = cy - 40;
      const start: Shape = { id: nid("s"), type: "ellipse", x: cx - 430, y, w: 140, h: 80, text: "Start", fill: "green" };
      const step: Shape = { id: nid("s"), type: "rect", x: cx - 210, y, w: 150, h: 80, text: "Do something" };
      const ask: Shape = { id: nid("s"), type: "diamond", x: cx + 10, y: y - 10, w: 150, h: 100, text: "Done?", fill: "amber" };
      const end: Shape = { id: nid("s"), type: "ellipse", x: cx + 250, y, w: 140, h: 80, text: "End", fill: "red" };
      return [start, step, ask, end, link(start, step), link(step, ask), link(ask, end, "Yes")];
    },
  },
  {
    id: "brain",
    name: "Brainstorm",
    build: (cx, cy) => {
      const topic: Shape = { id: nid("s"), type: "ellipse", x: cx - 100, y: cy - 50, w: 200, h: 100, text: "Topic", fill: "blue" };
      const fills = ["y", "p", "b", "g", "y", "p"];
      const ideas = fills.map((fill, i) => {
        const a = (i / fills.length) * Math.PI * 2 - Math.PI / 2;
        return sticky(Math.round(cx + Math.cos(a) * 320 - 75), Math.round(cy + Math.sin(a) * 220 - 55), fill, `Idea ${i + 1}`);
      });
      return [topic, ...ideas];
    },
  },
];
