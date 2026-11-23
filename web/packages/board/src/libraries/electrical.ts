// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Basic electrical (DGM-14.7): schematic symbols (IEC/ANSI conventions) and logic gates, drawn by
// us. Line symbols are bare strokes (no fill); gates have input and output ports.
import { at, join, type Item, type LibraryData } from "./geo";
import type { Port } from "../ports";

type Geo = ReturnType<typeof at>;
const IN2: Port[] = [{ id: "in1", side: "left", x: 0, y: 0.3 }, { id: "in2", side: "left", x: 0, y: 0.7 }, { id: "out", side: "right", x: 1, y: 0.5 }];
const IN1: Port[] = [{ id: "in", side: "left", x: 0, y: 0.5 }, { id: "out", side: "right", x: 1, y: 0.5 }];
const TWO: Port[] = [{ id: "a", side: "left", x: 0, y: 0.5 }, { id: "b", side: "right", x: 1, y: 0.5 }];

const el = (name: string, label: string, keywords: string[], w: number, h: number, draw: (g: Geo) => string, ports: Port[] = TWO): Item => ({
  name, label, base: "rect", keywords, ports, look: { path: draw(at(w, h)), w, h, text: "" },
});

/** Gate bodies for a 100 × 60 gate (raw path data already in the 100 × 100 box), with input leads. */
const AND = (g: Geo) => join("M20 0H50A30 50 0 0 1 50 100H20Z", g.L(0, 18, 20, 18), g.L(0, 42, 20, 42));
const OR = (g: Geo, xor = false) => join("M18 0C40 0 62 10 80 50C62 90 40 100 18 100C28 73.3 28 26.7 18 0Z", g.L(0, 18, 24, 18), g.L(0, 42, 24, 42), ...(xor ? ["M10 0C20 26.7 20 73.3 10 100C20 73.3 20 26.7 10 0Z"] : []));

export const ELECTRICAL: LibraryData = {
  id: "electrical",
  name: "Electrical",
  icon: "zap",
  items: [
    el("resistor", "Resistor", ["resistance", "ohm", "r", "load"], 100, 24, (g) => g.T(0, 12, 24, 12, 28, 2, 36, 22, 44, 2, 52, 22, 60, 2, 68, 22, 72, 12, 100, 12)),
    el("capacitor", "Capacitor", ["capacitance", "c", "farad", "condenser"], 100, 40, (g) => join(g.L(0, 20, 44, 20), g.L(44, 4, 44, 36), g.L(56, 4, 56, 36), g.L(56, 20, 100, 20))),
    el("capacitor-polarized", "Polarised capacitor", ["electrolytic", "polarized", "capacitor"], 100, 40, (g) => join(g.L(0, 20, 44, 20), g.L(44, 4, 44, 36), g.T(60, 4, 54, 20, 60, 36), g.L(55, 20, 100, 20), g.L(30, 6, 38, 6), g.L(34, 2, 34, 10))),
    el("inductor", "Inductor", ["coil", "choke", "henry", "l"], 100, 24, (g) => join(g.L(0, 16, 20, 16), g.A(28, 16, 8, 180, 360), g.A(44, 16, 8, 180, 360), g.A(60, 16, 8, 180, 360), g.A(76, 16, 8, 180, 360), g.L(84, 16, 100, 16))),
    el("diode", "Diode", ["rectifier", "d", "one way"], 100, 40, (g) => join(g.L(0, 20, 34, 20), g.P(34, 4, 62, 20, 34, 36), g.L(62, 4, 62, 36), g.L(62, 20, 100, 20))),
    el("led", "LED", ["light emitting diode", "light", "indicator", "lamp"], 100, 50, (g) => join(g.L(0, 30, 34, 30), g.P(34, 14, 62, 30, 34, 46), g.L(62, 14, 62, 46), g.L(62, 30, 100, 30), g.L(52, 10, 62, 0), g.P(64, -2 + 2, 58, 2, 62, 6), g.L(62, 12, 72, 2), g.P(74, 0, 68, 4, 72, 8))),
    el("battery", "Battery", ["cell", "dc", "power", "source", "voltage"], 100, 40, (g) => join(g.L(0, 20, 42, 20), g.L(42, 2, 42, 38), g.R(52, 10, 4, 20), g.L(56, 20, 100, 20), g.L(28, 4, 34, 4), g.L(31, 1, 31, 7))),
    el("voltage-source", "Voltage source", ["ac", "dc", "supply", "generator", "power"], 100, 50, (g) => join(g.L(0, 25, 28, 25), g.E(50, 25, 22), g.L(72, 25, 100, 25), g.T(38, 25, 44, 18, 50, 25, 56, 32, 62, 25))),
    el("ground", "Ground", ["earth", "gnd", "0v", "common"], 50, 50, (g) => join(g.L(25, 0, 25, 22), g.L(5, 22, 45, 22), g.L(12, 32, 38, 32), g.L(19, 42, 31, 42)), [{ id: "a", side: "top", x: 0.5, y: 0 }]),
    el("switch", "Switch", ["toggle", "spst", "breaker", "on off"], 100, 40, (g) => join(g.L(0, 30, 30, 30), g.E(32, 30, 3), g.L(34, 28, 66, 8), g.E(68, 30, 3), g.L(70, 30, 100, 30))),
    el("push-button", "Push button", ["button", "momentary", "key", "contact"], 100, 40, (g) => join(g.L(0, 32, 30, 32), g.E(32, 32, 3), g.E(68, 32, 3), g.L(70, 32, 100, 32), g.L(28, 22, 72, 22), g.L(50, 22, 50, 4), g.L(42, 4, 58, 4))),
    el("lamp", "Lamp", ["bulb", "light", "indicator", "globe"], 100, 50, (g) => join(g.L(0, 25, 28, 25), g.E(50, 25, 22), g.L(72, 25, 100, 25), g.L(34.4, 9.4, 65.6, 40.6), g.L(65.6, 9.4, 34.4, 40.6))),
    el("fuse", "Fuse", ["protection", "breaker", "overcurrent"], 100, 24, (g) => join(g.L(0, 12, 20, 12), g.R(20, 4, 60, 16), g.L(20, 12, 80, 12), g.L(80, 12, 100, 12))),
    el("transistor", "Transistor (NPN)", ["npn", "bjt", "amplifier", "switch", "transistor"], 80, 90, (g) => join(g.E(44, 45, 30), g.L(0, 45, 32, 45), g.L(32, 25, 32, 65), g.T(32, 36, 60, 18, 60, 0), g.T(32, 54, 60, 72, 60, 90), g.P(60, 72, 50, 70, 55, 63)), [{ id: "b", side: "left", x: 0, y: 0.5 }, { id: "c", side: "top", x: 0.75, y: 0 }, { id: "e", side: "bottom", x: 0.75, y: 1 }]),
    el("op-amp", "Op-amp", ["operational amplifier", "amplifier", "comparator", "opamp"], 100, 80, (g) => join(g.P(18, 0, 86, 40, 18, 80), g.L(0, 20, 18, 20), g.L(0, 60, 18, 60), g.L(86, 40, 100, 40), g.L(24, 20, 34, 20), g.L(24, 60, 34, 60), g.L(29, 55, 29, 65)), [{ id: "in1", side: "left", x: 0, y: 0.25 }, { id: "in2", side: "left", x: 0, y: 0.75 }, { id: "out", side: "right", x: 1, y: 0.5 }]),
    el("and", "AND gate", ["and", "logic", "gate", "conjunction", "digital"], 100, 60, (g) => join(AND(g), g.L(80, 30, 100, 30)), IN2),
    el("nand", "NAND gate", ["nand", "logic", "gate", "not and", "digital"], 100, 60, (g) => join(AND(g), g.E(85, 30, 5), g.L(90, 30, 100, 30)), IN2),
    el("or", "OR gate", ["or", "logic", "gate", "disjunction", "digital"], 100, 60, (g) => join(OR(g), g.L(80, 30, 100, 30)), IN2),
    el("nor", "NOR gate", ["nor", "logic", "gate", "not or", "digital"], 100, 60, (g) => join(OR(g), g.E(85, 30, 5), g.L(90, 30, 100, 30)), IN2),
    el("xor", "XOR gate", ["xor", "exclusive or", "logic", "gate", "digital"], 100, 60, (g) => join(OR(g, true), g.L(80, 30, 100, 30)), IN2),
    el("not", "NOT gate", ["not", "inverter", "logic", "gate", "digital"], 100, 60, (g) => join(g.P(20, 6, 74, 30, 20, 54), g.E(79, 30, 5), g.L(0, 30, 20, 30), g.L(84, 30, 100, 30)), IN1),
    el("buffer", "Buffer", ["buffer", "driver", "repeater", "logic", "gate"], 100, 60, (g) => join(g.P(20, 6, 80, 30, 20, 54), g.L(0, 30, 20, 30), g.L(80, 30, 100, 30)), IN1),
  ],
};
