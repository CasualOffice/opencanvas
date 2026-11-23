// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// BPMN basics (DGM-14.7), from the public OMG BPMN 2.0 notation, drawn by us. Off by default:
// listed in the panel only after `setLibraryEnabled("bpmn", true)`; its kinds always draw.
import { CYLINDER } from "./basic";
import { at, G, join, type LibraryData } from "./geo";

const { R, E, P, L, T } = G;
const sub = at(160, 100);
const envelope = join(R(28, 34, 44, 32), T(28, 34, 50, 52, 72, 34));
const clock = join(E(50, 50, 30), T(50, 30, 50, 50, 64, 58));
const DIAMOND = P(50, 0, 100, 50, 50, 100, 0, 50);

export const BPMN: LibraryData = {
  id: "bpmn",
  name: "BPMN",
  icon: "git-branch",
  flag: true,
  items: [
    { name: "task", label: "Task", base: "rect", keywords: ["activity", "step", "work", "action"], look: { w: 140, h: 80, text: "Task" } },
    { name: "subprocess", label: "Sub-process", base: "rect", keywords: ["subprocess", "collapsed", "activity", "call"], look: { path: join(sub.RR(0, 0, 160, 100, 12), sub.R(72, 80, 16, 16), sub.L(76, 88, 84, 88), sub.L(80, 84, 80, 92)), w: 160, h: 100, text: "Sub-process", box: [0, 0, 100, 78] } },
    { name: "start", label: "Start event", base: "ellipse", keywords: ["start", "begin", "event", "trigger", "none"], look: { w: 44, h: 44, tone: "green", text: "" } },
    { name: "start-message", label: "Message start event", base: "ellipse", keywords: ["start", "message", "email", "event", "receive"], look: { path: join(E(50, 50, 50), envelope), w: 44, h: 44, tone: "green", text: "" } },
    { name: "start-timer", label: "Timer start event", base: "ellipse", keywords: ["start", "timer", "schedule", "clock", "cron", "event"], look: { path: join(E(50, 50, 50), clock), w: 44, h: 44, tone: "green", text: "" } },
    { name: "intermediate", label: "Intermediate event", base: "ellipse", keywords: ["intermediate", "event", "catch", "throw", "double circle"], look: { path: join(E(50, 50, 50), E(50, 50, 42)), w: 44, h: 44, tone: "amber", text: "" } },
    { name: "intermediate-message", label: "Message event", base: "ellipse", keywords: ["intermediate", "message", "email", "catch", "event"], look: { path: join(E(50, 50, 50), E(50, 50, 42), envelope), w: 44, h: 44, tone: "amber", text: "" } },
    { name: "intermediate-timer", label: "Timer event", base: "ellipse", keywords: ["intermediate", "timer", "wait", "delay", "clock", "event"], look: { path: join(E(50, 50, 50), E(50, 50, 42), clock), w: 44, h: 44, tone: "amber", text: "" } },
    { name: "end", label: "End event", base: "ellipse", keywords: ["end", "finish", "stop", "terminate", "event"], look: { path: join(E(50, 50, 50), E(50, 50, 44), E(50, 50, 40)), w: 44, h: 44, tone: "red", text: "" } },
    { name: "end-message", label: "Message end event", base: "ellipse", keywords: ["end", "message", "send", "email", "event"], look: { path: join(E(50, 50, 50), E(50, 50, 44), E(50, 50, 40), envelope), w: 44, h: 44, tone: "red", text: "" } },
    { name: "exclusive", label: "Exclusive gateway", base: "diamond", keywords: ["xor", "gateway", "decision", "if", "branch", "or"], look: { path: join(DIAMOND, L(36, 36, 64, 64), L(64, 36, 36, 64)), w: 56, h: 56, tone: "amber", text: "" } },
    { name: "parallel", label: "Parallel gateway", base: "diamond", keywords: ["and", "gateway", "fork", "join", "parallel", "concurrent"], look: { path: join(DIAMOND, L(50, 30, 50, 70), L(30, 50, 70, 50)), w: 56, h: 56, tone: "amber", text: "" } },
    { name: "inclusive", label: "Inclusive gateway", base: "diamond", keywords: ["or", "gateway", "inclusive", "any"], look: { path: join(DIAMOND, E(50, 50, 18)), w: 56, h: 56, tone: "amber", text: "" } },
    { name: "event-gateway", label: "Event-based gateway", base: "diamond", keywords: ["event", "gateway", "race", "wait"], look: { path: join(DIAMOND, E(50, 50, 22), E(50, 50, 18), G.REG(5, 50, 51, 11)), w: 56, h: 56, tone: "amber", text: "" } },
    { name: "data-object", label: "Data object", base: "rect", keywords: ["document", "data", "file", "artifact", "input", "output"], look: { path: "M0 0H72L100 22V100H0Z M72 0V22H100", w: 50, h: 64, text: "" } },
    { name: "data-store", label: "Data store", base: "rect", keywords: ["database", "db", "storage", "persist", "store"], look: { path: CYLINDER, w: 64, h: 60, text: "" } },
    { name: "pool", label: "Pool", base: "rect", keywords: ["participant", "organisation", "organization", "swimlane", "container"], container: true, look: { path: join(R(0, 0, 100, 100), L(0, 12, 100, 12)), w: 640, h: 260, text: "Pool", box: [0, 0, 100, 12] } },
    { name: "lane", label: "Lane", base: "rect", keywords: ["swimlane", "role", "department", "actor", "container"], container: true, look: { path: join(R(0, 0, 100, 100), L(0, 16, 22, 16), L(22, 0, 22, 16)), w: 600, h: 140, text: "Lane", box: [0, 0, 22, 16] } },
    { name: "group", label: "Group", base: "rect", keywords: ["group", "category", "dashed", "container"], container: true, look: { path: G.DR(0, 0, 100, 100, 3, 2.5), w: 300, h: 200, text: "Group", box: [0, 0, 100, 14] } },
  ],
  connectors: [
    { id: "sequence-flow", label: "Sequence flow", keywords: ["flow", "next", "arrow"], route: "elbow", ends: ["none", "arrow"] },
    { id: "message-flow", label: "Message flow", keywords: ["message", "dashed", "communication"], route: "elbow", dashed: true, ends: ["circle", "open-arrow"] },
    { id: "association", label: "Association", keywords: ["dotted", "annotation", "link"], route: "straight", dashed: true, ends: ["none", "none"] },
  ],
};
