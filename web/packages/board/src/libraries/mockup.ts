// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// UI controls (DGM-14.7): generic mobile and desktop mockup controls, low fidelity, drawn by us.
import { at, join, type Item, type LibraryData } from "./geo";

type Geo = ReturnType<typeof at>;
const ui = (name: string, label: string, keywords: string[], w: number, h: number, draw: (g: Geo) => string, text = label, box?: (g: Geo) => [number, number, number, number], tone?: string): Item => {
  const g = at(w, h);
  return { name, label, base: "rect", keywords, look: { path: draw(g), w, h, text, ...(box ? { box: box(g) } : {}), ...(tone ? { tone } : {}) } };
};
const chevronR = (g: Geo, x: number, y: number) => g.T(x, y - 5, x + 5, y, x, y + 5);
const lens = (g: Geo, x: number, y: number) => join(g.E(x, y, 6), g.L(x + 4.5, y + 4.5, x + 9, y + 9));

export const MOCKUP: LibraryData = {
  id: "mockup",
  name: "UI controls",
  icon: "square",
  items: [
    ui("status-bar", "Status bar", ["mobile", "time", "battery", "signal", "top"], 360, 24, (g) => join(g.R(0, 0, 360, 24), g.RR(322, 7, 22, 10, 2), g.R(344, 10, 2, 4), g.R(296, 14, 3, 4), g.R(302, 11, 3, 7), g.R(308, 8, 3, 10)), "9:41", (g) => g.box(0, 0, 60, 24)),
    ui("list-item", "List item", ["row", "cell", "list", "entry", "item"], 320, 56, (g) => join(g.R(0, 0, 320, 56), g.E(30, 28, 16), chevronR(g, 296, 28)), "List item", (g) => g.box(56, 0, 220, 56)),
    ui("search-bar", "Search bar", ["search", "find", "query", "filter", "lookup"], 280, 40, (g) => join(g.RR(0, 0, 280, 40, 20), lens(g, 22, 18)), "Search", (g) => g.box(36, 0, 220, 40)),
    ui("segmented", "Segmented control", ["segments", "tabs", "toggle group", "options", "switcher"], 270, 36, (g) => join(g.RR(0, 0, 270, 36, 8), g.RR(3, 3, 88, 30, 6), g.L(180, 8, 180, 28), g.L(30, 18, 64, 18), g.L(118, 18, 152, 18), g.L(208, 18, 242, 18)), ""),
    ui("stepper", "Stepper", ["number", "increment", "decrement", "quantity", "spinner"], 120, 36, (g) => join(g.RR(0, 0, 120, 36, 8), g.L(40, 0, 40, 36), g.L(80, 0, 80, 36), g.L(12, 18, 28, 18), g.L(92, 18, 108, 18), g.L(100, 10, 100, 26)), "1", (g) => g.box(40, 0, 40, 36)),
    ui("badge", "Badge", ["count", "notification", "pill", "label", "status"], 60, 26, (g) => g.RR(0, 0, 60, 26, 13), "New", undefined, "red"),
    ui("avatar", "Avatar", ["profile", "user", "photo", "picture", "person"], 56, 56, (g) => join(g.E(28, 28, 28), g.E(28, 22, 9), "M27.5 86.4C32.1 71.4 39.3 64.3 50 64.3C60.7 64.3 67.9 71.4 72.5 86.4"), ""),
    ui("toast", "Toast", ["snackbar", "notification", "message", "alert", "popup"], 300, 48, (g) => join(g.RR(0, 0, 300, 48, 8), g.L(270, 18, 282, 30), g.L(282, 18, 270, 30)), "Saved", (g) => g.box(0, 0, 256, 48), "gray"),
    ui("tooltip", "Tooltip", ["hint", "help", "hover", "popover", "info"], 160, 50, (g) => g.P(0, 0, 160, 0, 160, 38, 88, 38, 80, 50, 72, 38, 0, 38), "Tooltip", (g) => g.box(0, 0, 160, 38), "gray"),
    ui("scrollbar", "Scrollbar", ["scroll", "track", "thumb", "overflow"], 14, 200, (g) => join(g.RR(0, 0, 14, 200, 7), g.RR(3, 30, 8, 60, 4)), ""),
    ui("breadcrumb", "Breadcrumb", ["path", "trail", "navigation", "crumbs"], 280, 30, (g) => join(g.L(10, 15, 70, 15), chevronR(g, 84, 15), g.L(102, 15, 170, 15), chevronR(g, 184, 15), g.L(202, 15, 262, 15)), ""),
    ui("pagination", "Pagination", ["pages", "pager", "next", "previous", "paging"], 260, 36, (g) => join(g.T(16, 10, 10, 18, 16, 26), g.RR(36, 2, 32, 32, 6), g.RR(76, 2, 32, 32, 6), g.RR(116, 2, 32, 32, 6), g.RR(156, 2, 32, 32, 6), g.RR(196, 2, 32, 32, 6), chevronR(g, 244, 18), g.L(52, 12, 52, 24)), ""),
    ui("table-header", "Table header", ["table", "grid", "columns", "header", "data grid"], 400, 40, (g) => join(g.R(0, 0, 400, 40), g.L(130, 0, 130, 40), g.L(260, 0, 260, 40), g.T(376, 16, 382, 23, 388, 16), g.L(16, 20, 80, 20), g.L(146, 20, 200, 20), g.L(276, 20, 330, 20)), "", undefined, "gray"),
    ui("table-row", "Table row", ["table", "row", "record", "grid"], 400, 40, (g) => join(g.R(0, 0, 400, 40), g.L(130, 0, 130, 40), g.L(260, 0, 260, 40), g.L(16, 20, 100, 20), g.L(146, 20, 210, 20), g.L(276, 20, 320, 20)), ""),
    ui("sidebar", "Sidebar", ["side menu", "navigation", "drawer", "nav", "panel"], 200, 360, (g) => join(g.R(0, 0, 200, 360), g.RR(12, 60, 176, 32, 6), g.L(24, 120, 140, 120), g.L(24, 156, 120, 156), g.L(24, 192, 150, 192), g.L(24, 228, 110, 228), g.L(0, 300, 200, 300)), "App", (g) => g.box(0, 0, 200, 48)),
    ui("menu", "Menu", ["context menu", "dropdown menu", "options", "popup menu", "list"], 180, 150, (g) => join(g.RR(0, 0, 180, 150, 8), g.L(16, 28, 120, 28), g.L(16, 58, 140, 58), g.L(16, 88, 100, 88), g.L(0, 106, 180, 106), g.L(16, 128, 110, 128)), ""),
    ui("chip", "Chip", ["tag", "pill", "filter", "token", "label"], 100, 32, (g) => join(g.RR(0, 0, 100, 32, 16), g.L(78, 11, 88, 21), g.L(88, 11, 78, 21)), "Tag", (g) => g.box(0, 0, 76, 32), "blue"),
    ui("textarea", "Text area", ["multiline", "comment box", "message", "textarea", "notes"], 260, 110, (g) => join(g.RR(0, 0, 260, 110, 6), g.T(246, 96, 254, 88), g.T(250, 100, 256, 94)), "Write something…", (g) => g.box(0, 0, 260, 40)),
    ui("date-picker", "Date picker", ["calendar", "date", "day", "picker", "schedule"], 200, 40, (g) => join(g.RR(0, 0, 200, 40, 6), g.RR(170, 10, 20, 20, 3), g.L(170, 16, 190, 16), g.L(175, 6, 175, 12), g.L(185, 6, 185, 12)), "dd/mm/yyyy", (g) => g.box(0, 0, 164, 40)),
    ui("icon-button", "Icon button", ["icon", "button", "toolbar", "action"], 40, 40, (g) => join(g.RR(0, 0, 40, 40, 8), g.L(20, 12, 20, 28), g.L(12, 20, 28, 20)), ""),
    ui("fab", "Floating action button", ["fab", "add", "plus", "action", "compose"], 56, 56, (g) => join(g.E(28, 28, 28), g.L(28, 18, 28, 38), g.L(18, 28, 38, 28)), "", undefined, "blue"),
    ui("accordion", "Accordion", ["expand", "collapse", "disclosure", "faq", "panel"], 300, 130, (g) => join(g.R(0, 0, 300, 44), g.R(0, 44, 300, 86), g.T(272, 18, 279, 25, 286, 18), g.L(16, 70, 240, 70), g.L(16, 96, 200, 96)), "Section", (g) => g.box(0, 0, 260, 44)),
    ui("alert", "Alert banner", ["banner", "message", "warning", "notice", "info"], 360, 52, (g) => join(g.RR(0, 0, 360, 52, 8), g.E(26, 26, 10), g.L(26, 21, 26, 27), g.L(26, 31, 26, 32)), "Something needs your attention", (g) => g.box(44, 0, 300, 52), "amber"),
    ui("progress", "Progress bar", ["loading", "progress", "percent", "upload", "bar"], 220, 16, (g) => join(g.RR(0, 0, 220, 16, 8), g.RR(0, 0, 130, 16, 8)), "", undefined, "blue"),
    ui("spinner", "Spinner", ["loading", "busy", "wait", "activity indicator"], 40, 40, (g) => join(g.A(20, 20, 16, -90, 180), g.E(20, 4, 3)), ""),
    ui("divider", "Divider", ["separator", "rule", "line", "hr"], 300, 12, (g) => g.L(0, 6, 300, 6), ""),
  ],
};
