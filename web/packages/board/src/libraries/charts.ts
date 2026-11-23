// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Charts and infographics (DGM-14.7): illustrative chart glyphs for diagrams (not data-bound),
// drawn by us at their default size.
import { at, join, type Item, type LibraryData } from "./geo";

type Geo = ReturnType<typeof at>;
const ch = (name: string, label: string, keywords: string[], w: number, h: number, draw: (g: Geo) => string, text = "", tone?: string, box?: (g: Geo) => [number, number, number, number]): Item => {
  const g = at(w, h);
  return { name, label, base: "rect", keywords: [...keywords, "chart"], look: { path: draw(g), w, h, text, ...(tone ? { tone } : {}), ...(box ? { box: box(g) } : {}) } };
};
const axes = (g: Geo, w: number, h: number) => g.T(6, 4, 6, h - 6, w - 4, h - 6);

export const CHARTS: LibraryData = {
  id: "charts",
  name: "Charts and infographics",
  icon: "chart-column",
  items: [
    ch("column", "Column chart", ["bar", "column", "vertical", "histogram", "graph"], 160, 110, (g) => join(axes(g, 160, 110), g.R(20, 54, 22, 50), g.R(52, 24, 22, 80), g.R(84, 64, 22, 40), g.R(116, 38, 22, 66)), "", "blue"),
    ch("bar", "Bar chart", ["bar", "horizontal", "ranking", "graph"], 160, 110, (g) => join(axes(g, 160, 110), g.R(6, 12, 110, 16), g.R(6, 36, 140, 16), g.R(6, 60, 70, 16), g.R(6, 84, 96, 14)), "", "blue"),
    ch("stacked", "Stacked column", ["stacked", "column", "composition", "graph"], 160, 110, (g) => join(axes(g, 160, 110), g.R(24, 40, 26, 64), g.L(24, 70, 50, 70), g.R(66, 20, 26, 84), g.L(66, 62, 92, 62), g.R(108, 52, 26, 52), g.L(108, 80, 134, 80)), "", "purple"),
    ch("line", "Line chart", ["line", "trend", "time series", "graph", "growth"], 160, 110, (g) => join(axes(g, 160, 110), g.T(14, 86, 44, 60, 74, 72, 104, 34, 148, 18), g.E(44, 60, 3), g.E(74, 72, 3), g.E(104, 34, 3)), "", "blue"),
    ch("area", "Area chart", ["area", "trend", "volume", "graph", "filled"], 160, 110, (g) => join(axes(g, 160, 110), g.P(6, 104, 6, 80, 44, 54, 80, 66, 114, 30, 156, 20, 156, 104)), "", "green"),
    ch("scatter", "Scatter plot", ["scatter", "dots", "correlation", "points", "xy"], 160, 110, (g) => join(axes(g, 160, 110), g.E(28, 82, 4), g.E(46, 70, 4), g.E(60, 76, 4), g.E(78, 52, 4), g.E(96, 58, 4), g.E(110, 36, 4), g.E(132, 28, 4)), "", "purple"),
    ch("pie", "Pie chart", ["pie", "share", "proportion", "percentage", "slices"], 100, 100, (g) => join(g.PIE(50, 50, 48, -90, 30), g.PIE(50, 50, 48, 30, 150), g.PIE(50, 50, 48, 150, 270)), "", "amber"),
    ch("donut", "Donut chart", ["donut", "doughnut", "ring", "share", "percentage"], 100, 100, (g) => join(g.BAND(50, 50, 28, 48, -90, 60), g.BAND(50, 50, 28, 48, 60, 180), g.BAND(50, 50, 28, 48, 180, 270)), "", "blue"),
    ch("gauge", "Gauge", ["meter", "speedometer", "dial", "kpi", "score"], 140, 80, (g) => join(g.BAND(70, 74, 40, 64, 180, 360),g.P(68, 74, 72, 74, 98, 30), g.E(70, 74, 6)), "", "green"),
    ch("progress", "Progress bar", ["progress", "completion", "percent", "status", "loading"], 200, 24, (g) => join(g.RR(0, 0, 200, 24, 12), g.RR(0, 0, 128, 24, 12)), "64%", "blue"),
    ch("rating", "Rating", ["stars", "review", "score", "rating", "feedback"], 150, 30, (g) => join(...[15, 45, 75, 105, 135].map((x) => g.STAR(5, x, 16, 13, 0.42))), "", "amber"),
    ch("timeline", "Timeline marker", ["timeline", "milestone", "event", "date", "roadmap"], 120, 80, (g) => join(g.L(0, 60, 120, 60), g.E(60, 60, 8), g.L(60, 52, 60, 36), g.RR(20, 0, 80, 32, 6)), "Milestone", "purple", (g) => g.box(20, 0, 80, 32)),
    ch("step", "Numbered step", ["step", "number", "sequence", "stage", "process", "1"], 56, 56, (g) => g.E(28, 28, 28), "1", "blue"),
    ch("funnel", "Funnel", ["funnel", "conversion", "pipeline", "sales", "stages"], 140, 120, (g) => join(g.P(0, 0, 140, 0, 120, 38, 20, 38), g.P(24, 42, 116, 42, 100, 78, 40, 78), g.P(44, 82, 96, 82, 84, 120, 56, 120)), "", "purple"),
    ch("pyramid", "Pyramid", ["pyramid", "hierarchy", "levels", "triangle", "maslow"], 140, 120, (g) => join(g.P(70, 0, 96, 38, 44, 38), g.P(42, 42, 98, 42, 122, 78, 18, 78), g.P(16, 82, 124, 82, 140, 120, 0, 120)), "", "amber"),
    ch("venn", "Venn diagram", ["venn", "overlap", "intersection", "sets", "circles"], 150, 100, (g) => join(g.E(52, 50, 46), g.E(98, 50, 46)), "", "green"),
    ch("kpi", "KPI card", ["metric", "number", "stat", "kpi", "scorecard", "tile"], 160, 90, (g) => join(g.RR(0, 0, 160, 90, 8), g.T(16, 74, 46, 66, 76, 70, 106, 60, 144, 56)), "1,284", "", (g) => g.box(0, 8, 160, 48)),
    ch("harvey", "Harvey ball", ["harvey ball", "quarter", "completion", "half", "maturity"], 50, 50, (g) => join(g.E(25, 25, 24), g.PIE(25, 25, 24, -90, 90)), "", "blue"),
    ch("sparkline", "Sparkline", ["sparkline", "mini chart", "trend", "inline"], 140, 40, (g) => join(g.T(2, 30, 20, 22, 36, 28, 54, 12, 72, 20, 90, 8, 108, 18, 126, 6, 138, 10), g.E(138, 10, 3)), "", "green"),
  ],
};
