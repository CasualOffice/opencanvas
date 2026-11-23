// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Floor plan (DGM-14.7): walls, openings and furniture seen from above, drawn by us at their
// default size (1 board unit ≈ 1 cm), so circles and corners are true there.
import { at, join, type Item, type LibraryData } from "./geo";

type Geo = ReturnType<typeof at>;
const fp = (name: string, label: string, keywords: string[], w: number, h: number, draw: (g: Geo) => string, extra: Partial<Item> = {}, tone?: string): Item => ({
  name, label, base: "rect", keywords, ...extra, look: { path: draw(at(w, h)), w, h, text: "", ...(tone ? { tone } : {}) },
});

export const FLOORPLAN: LibraryData = {
  id: "floorplan",
  name: "Floor plan",
  icon: "house",
  items: [
    fp("wall", "Wall", ["wall", "partition", "barrier"], 200, 12, (g) => g.R(0, 0, 200, 12), {}, "gray"),
    fp("wall-corner", "Wall corner", ["corner", "l wall", "angle"], 120, 120, (g) => g.P(0, 0, 120, 0, 120, 12, 12, 12, 12, 120, 0, 120), {}, "gray"),
    fp("door", "Door", ["door", "entrance", "swing", "opening"], 90, 90, (g) => join(g.R(0, 0, 4, 90), "M4.4 0A95.6 100 0 0 1 100 100H4.4Z"), {}),
    fp("double-door", "Double door", ["double door", "french door", "entrance"], 160, 80, (g) => join(g.R(0, 0, 4, 80), g.R(156, 0, 4, 80), "M2.5 0A47.5 100 0 0 1 50 100H2.5Z", "M97.5 0A47.5 100 0 0 0 50 100H97.5Z")),
    fp("sliding-door", "Sliding door", ["slider", "patio", "pocket door"], 160, 16, (g) => join(g.R(0, 0, 90, 7), g.R(70, 9, 90, 7))),
    fp("window", "Window", ["window", "glazing", "opening", "glass"], 120, 14, (g) => join(g.R(0, 0, 120, 14), g.L(0, 7, 120, 7))),
    fp("opening", "Opening", ["gap", "archway", "doorway", "passage"], 100, 12, (g) => join(g.R(0, 0, 10, 12), g.R(90, 0, 10, 12), g.DL(10, 6, 90, 6, 6, 5)), {}, "gray"),
    fp("stairs", "Stairs", ["staircase", "steps", "stairway", "flight"], 100, 220, (g) => join(g.R(0, 0, 100, 220), ...Array.from({ length: 10 }, (_, i) => g.L(0, 22 * (i + 1), 100, 22 * (i + 1))).slice(0, 9), g.L(50, 200, 50, 30), g.P(50, 16, 40, 34, 60, 34))),
    fp("room", "Room", ["room", "space", "area", "zone", "container"], 400, 300, (g) => join(g.R(0, 0, 400, 300), g.R(8, 8, 384, 284)), { container: true }),
    fp("bed", "Single bed", ["bed", "single", "bedroom", "sleep"], 100, 200, (g) => join(g.RR(0, 0, 100, 200, 4), g.RR(12, 10, 76, 34, 8), g.L(0, 60, 100, 60), g.T(0, 60, 60, 90, 100, 60))),
    fp("double-bed", "Double bed", ["bed", "double", "queen", "king", "bedroom"], 160, 200, (g) => join(g.RR(0, 0, 160, 200, 4), g.RR(10, 10, 64, 34, 8), g.RR(86, 10, 64, 34, 8), g.L(0, 60, 160, 60))),
    fp("table", "Table", ["dining table", "table", "rectangular"], 160, 90, (g) => g.RR(0, 0, 160, 90, 4)),
    fp("round-table", "Round table", ["table", "round", "dining", "meeting"], 120, 120, (g) => join(g.E(60, 60, 40), g.RR(50, 0, 20, 14, 3), g.RR(50, 106, 20, 14, 3), g.RR(0, 50, 14, 20, 3), g.RR(106, 50, 14, 20, 3))),
    fp("chair", "Chair", ["seat", "chair", "stool"], 50, 50, (g) => join(g.RR(4, 10, 42, 38, 4), g.RR(0, 0, 50, 10, 3))),
    fp("sofa", "Sofa", ["couch", "settee", "lounge", "living room"], 200, 90, (g) => join(g.RR(0, 0, 200, 90, 8), g.L(20, 24, 180, 24), g.L(20, 24, 20, 90), g.L(180, 24, 180, 90), g.L(100, 24, 100, 90))),
    fp("armchair", "Armchair", ["chair", "lounge chair", "seat"], 90, 90, (g) => join(g.RR(0, 0, 90, 90, 8), g.L(16, 22, 74, 22), g.L(16, 22, 16, 90), g.L(74, 22, 74, 90))),
    fp("desk", "Desk", ["desk", "workstation", "office", "table"], 140, 110, (g) => join(g.R(0, 0, 140, 70), g.RR(50, 76, 40, 34, 4), g.L(50, 82, 90, 82))),
    fp("sink", "Sink", ["basin", "washbasin", "kitchen sink", "tap"], 80, 60, (g) => join(g.R(0, 0, 80, 60), g.RR(10, 14, 60, 40, 8), g.E(40, 34, 3), g.L(40, 4, 40, 14))),
    fp("toilet", "Toilet", ["wc", "loo", "lavatory", "bathroom", "restroom"], 50, 80, (g) => join(g.RR(0, 0, 50, 20, 3), g.E(25, 50, 20, 28), g.E(25, 52, 13, 20))),
    fp("bath", "Bath", ["bathtub", "tub", "bathroom"], 170, 80, (g) => join(g.RR(0, 0, 170, 80, 6), g.RR(10, 10, 150, 60, 26), g.E(30, 40, 4))),
    fp("shower", "Shower", ["shower tray", "bathroom", "wet room"], 90, 90, (g) => join(g.R(0, 0, 90, 90), g.L(0, 0, 90, 90), g.E(45, 45, 5))),
    fp("stove", "Stove", ["cooker", "hob", "oven", "range", "kitchen"], 60, 60, (g) => join(g.R(0, 0, 60, 60), g.E(17, 17, 10), g.E(43, 17, 10), g.E(17, 43, 10), g.E(43, 43, 10))),
    fp("fridge", "Fridge", ["refrigerator", "freezer", "kitchen"], 70, 70, (g) => join(g.R(0, 0, 70, 70), g.L(0, 60, 70, 60), g.L(8, 52, 30, 52))),
    fp("wardrobe", "Wardrobe", ["closet", "cupboard", "storage", "cabinet"], 150, 60, (g) => join(g.R(0, 0, 150, 60), g.L(75, 0, 75, 60), g.DL(4, 30, 146, 30, 8, 6))),
    fp("plant", "Plant", ["tree", "pot", "greenery", "decor"], 60, 60, (g) => join(g.E(30, 30, 28), g.E(30, 30, 10), g.L(30, 2, 30, 20), g.L(30, 40, 30, 58), g.L(2, 30, 20, 30), g.L(40, 30, 58, 30)), {}, "green"),
  ],
};
