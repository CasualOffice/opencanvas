// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Wireframe basics (DGM-14.7): generic device frames and controls, low fidelity, drawn by us.
// Each outline is authored at its default size (`at(w, h)`), so corners and circles are true there.
import { at, join, type Item, type LibraryData } from "./geo";

/** A control authored at w × h board units. */
const ui = (name: string, label: string, keywords: string[], w: number, h: number, draw: (g: ReturnType<typeof at>) => string, text = label, box?: (g: ReturnType<typeof at>) => [number, number, number, number], extra: Partial<Item> = {}): Item => {
  const g = at(w, h);
  return { name, label, base: "rect", keywords, ...extra, look: { path: draw(g), w, h, text, ...(box ? { box: box(g) } : {}) } };
};
const C = { container: true };

export const WIREFRAME: LibraryData = {
  id: "wireframe",
  name: "Wireframe",
  icon: "layout-template",
  items: [
    ui("browser", "Browser window", ["web page", "website", "desktop", "window", "chrome", "container"], 480, 320, (g) => join(g.RR(0, 0, 480, 320, 8), g.L(0, 36, 480, 36), g.E(18, 18, 5), g.E(34, 18, 5), g.E(50, 18, 5), g.RR(72, 9, 380, 18, 9)), "example.com", (g) => g.box(80, 9, 360, 18), C),
    ui("phone", "Phone frame", ["mobile", "smartphone", "ios", "android", "screen", "container"], 200, 400, (g) => join(g.RR(0, 0, 200, 400, 26), g.R(10, 40, 180, 320), g.RR(80, 18, 40, 6, 3), g.E(100, 380, 9)), "", (g) => g.box(10, 40, 180, 40), C),
    ui("tablet", "Tablet frame", ["ipad", "tablet", "device", "screen", "container"], 400, 300, (g) => join(g.RR(0, 0, 400, 300, 18), g.R(24, 20, 352, 260), g.E(388, 150, 5)), "", (g) => g.box(24, 20, 352, 40), C),
    ui("button", "Button", ["cta", "submit", "action", "primary", "click"], 120, 40, (g) => g.RR(0, 0, 120, 40, 8), "Button", undefined, {}),
    ui("input", "Text field", ["input", "text box", "form", "field", "textbox", "entry"], 220, 40, (g) => join(g.RR(0, 0, 220, 40, 6), g.L(14, 12, 14, 28)), "Placeholder"),
    ui("checkbox", "Checkbox", ["check", "tick", "option", "toggle", "form"], 160, 30, (g) => join(g.RR(4, 6, 18, 18, 3), g.T(8, 15, 12, 19, 18, 10)), "Checkbox", (g) => g.box(28, 0, 132, 30)),
    ui("radio", "Radio button", ["radio", "option", "choice", "select one", "form"], 160, 30, (g) => join(g.E(13, 15, 9), g.E(13, 15, 4)), "Option", (g) => g.box(28, 0, 132, 30)),
    ui("toggle", "Toggle", ["switch", "on off", "setting", "boolean"], 160, 30, (g) => join(g.RR(2, 5, 38, 20, 10), g.E(30, 15, 7)), "Setting", (g) => g.box(46, 0, 114, 30)),
    ui("dropdown", "Dropdown", ["select", "combo box", "menu", "picker", "list"], 200, 40, (g) => join(g.RR(0, 0, 200, 40, 6), g.T(172, 17, 179, 24, 186, 17)), "Select", (g) => g.box(0, 0, 164, 40)),
    ui("slider", "Slider", ["range", "volume", "track", "scrubber"], 200, 30, (g) => join(g.RR(0, 13, 200, 4, 2), g.E(80, 15, 9)), ""),
    ui("image", "Image placeholder", ["picture", "photo", "media", "img", "placeholder"], 160, 120, (g) => join(g.R(0, 0, 160, 120), g.P(14, 104, 60, 52, 90, 82, 108, 64, 146, 104), g.E(112, 34, 12)), ""),
    ui("navbar", "Navigation bar", ["header", "nav", "top bar", "menu", "app bar"], 480, 56, (g) => join(g.R(0, 0, 480, 56), g.RR(16, 18, 60, 20, 4), g.L(300, 28, 340, 28), g.L(356, 28, 396, 28), g.L(412, 28, 452, 28)), "", undefined),
    ui("tabbar", "Tab bar", ["tabs", "bottom navigation", "segments", "tab"], 360, 56, (g) => join(g.R(0, 0, 360, 56), g.E(45, 22, 8), g.E(135, 22, 8), g.E(225, 22, 8), g.E(315, 22, 8), g.L(30, 42, 60, 42), g.L(120, 42, 150, 42), g.L(210, 42, 240, 42), g.L(300, 42, 330, 42)), ""),
    ui("card", "Card", ["tile", "panel", "content", "item"], 200, 220, (g) => join(g.RR(0, 0, 200, 220, 10), g.L(0, 110, 200, 110), g.P(20, 96, 60, 56, 88, 80, 110, 62, 180, 96)), "Card title", (g) => g.box(0, 116, 200, 40)),
    ui("modal", "Modal dialog", ["dialog", "popup", "overlay", "alert", "window", "container"], 360, 220, (g) => join(g.RR(0, 0, 360, 220, 10), g.L(0, 48, 360, 48), g.L(330, 18, 342, 30), g.L(342, 18, 330, 30), g.RR(196, 168, 70, 32, 6), g.RR(274, 168, 70, 32, 6)), "Dialog title", (g) => g.box(0, 0, 320, 48), C),
  ],
};
