// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Server rack (DGM-14.7): generic rack-mounted units, front view, no vendor faceplates. A unit is
// 240 board units wide and 24 per rack unit (U); the cabinet is a container that holds them.
import { at, join, type Item, type LibraryData } from "./geo";

type Geo = ReturnType<typeof at>;
const W = 240, U = 24;
const unit = (name: string, label: string, keywords: string[], u: number, draw: (g: Geo, h: number) => string, text = label, tone?: string): Item => {
  const h = u * U, g = at(W, h);
  return { name, label, base: "rect", keywords: [...keywords, "rack", `${u}u`], look: { path: join(g.R(0, 0, W, h), g.E(7, h / 2, 2.5), g.E(W - 7, h / 2, 2.5), draw(g, h)), w: W, h, text, box: g.box(44, 0, 96, h), ...(tone ? { tone } : {}) } };
};
const leds = (g: Geo, y: number, n = 3) => join(...Array.from({ length: n }, (_, i) => g.E(22 + i * 8, y, 2)));
const bays = (g: Geo, h: number, n: number) => join(...Array.from({ length: n }, (_, i) => g.R(184 + (i % 2) * 22, 4 + Math.floor(i / 2) * ((h - 8) / Math.ceil(n / 2)), 18, (h - 8) / Math.ceil(n / 2) - 2)));

const cab = at(280, 520);

export const RACK: LibraryData = {
  id: "rack",
  name: "Server rack",
  icon: "server",
  items: [
    { name: "cabinet", label: "Rack cabinet", base: "rect", keywords: ["rack", "cabinet", "42u", "enclosure", "frame", "container"], container: true, look: { path: join(cab.R(0, 0, 280, 520), cab.R(12, 28, 256, 480), cab.L(20, 28, 20, 508), cab.L(260, 28, 260, 508)), w: 280, h: 520, text: "Rack", box: cab.box(0, 0, 280, 28) } },
    unit("server-1u", "Server 1U", ["server", "pizza box", "compute", "1u"], 1, (g) => join(leds(g, 12), bays(g, 24, 2))),
    unit("server-2u", "Server 2U", ["server", "compute", "host", "2u"], 2, (g, h) => join(leds(g, h / 2), bays(g, h, 4))),
    unit("server-4u", "Server 4U", ["server", "storage server", "gpu", "4u"], 4, (g, h) => join(leds(g, 20), bays(g, h, 8))),
    unit("switch", "Switch 1U", ["switch", "network", "ethernet", "ports", "top of rack", "tor"], 1, (g) => join(...Array.from({ length: 12 }, (_, i) => g.R(150 + (i % 6) * 12, i < 6 ? 3 : 13, 9, 8))), "Switch"),
    unit("patch-panel", "Patch panel", ["patch", "cabling", "ports", "keystone"], 1, (g) => join(...Array.from({ length: 16 }, (_, i) => g.R(28 + i * 12, 8, 8, 8))), ""),
    unit("storage", "Storage shelf", ["disk shelf", "jbod", "san", "nas", "drives", "storage"], 2, (g) => join(...Array.from({ length: 12 }, (_, i) => g.R(24 + i * 16, 6, 12, 36))), "", "green"),
    unit("ups", "UPS", ["ups", "battery", "power", "backup", "uninterruptible"], 2, (g, h) => join(g.R(186, 10, 34, h - 20), g.L(190, h / 2, 216, h / 2), leds(g, h / 2, 2)), "UPS", "amber"),
    unit("pdu", "PDU", ["pdu", "power strip", "power distribution", "sockets"], 1, (g) => join(...Array.from({ length: 8 }, (_, i) => g.RR(144 + i * 11, 6, 8, 12, 2))), "PDU"),
    unit("console", "Console drawer", ["kvm", "console", "keyboard", "monitor", "drawer"], 1, (g) => join(g.RR(160, 9, 48, 6, 3)), "Console"),
    unit("blank", "Blank panel", ["blank", "filler", "empty", "cover"], 1, () => "", "", "gray"),
    unit("cable-manager", "Cable manager", ["cable", "management", "brush", "organiser"], 1, (g) => join(g.R(20, 8, 200, 8), ...Array.from({ length: 9 }, (_, i) => g.L(30 + i * 22, 8, 30 + i * 22, 16))), ""),
  ],
};
