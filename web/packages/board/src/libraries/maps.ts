// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Mind map and org chart (DGM-14.7): topics, cards and their connector presets. Drawn by us.
import { CLOUD } from "./basic";
import { at, G, join, type LibraryData } from "./geo";

const { R, L } = G;
const card = at(220, 80);
const role = at(180, 70);
const team = at(200, 90);

export const MINDMAP: LibraryData = {
  id: "mindmap",
  name: "Mind map",
  icon: "git-fork",
  items: [
    { name: "central", label: "Central topic", base: "ellipse", keywords: ["main idea", "root", "centre", "center", "core", "theme"], look: { w: 200, h: 90, tone: "purple", text: "Central topic" } },
    { name: "main", label: "Main topic", base: "rect", keywords: ["branch", "topic", "primary", "idea"], look: { w: 150, h: 54, tone: "blue", text: "Main topic" } },
    { name: "subtopic", label: "Subtopic", base: "rect", keywords: ["child", "leaf", "detail", "sub", "underline"], look: { path: L(0, 100, 100, 100), w: 120, h: 34, text: "Subtopic" } },
    { name: "floating", label: "Floating topic", base: "rect", keywords: ["free", "loose", "unattached", "floating", "note"], look: { path: G.DR(0, 0, 100, 100, 4, 3), w: 140, h: 50, tone: "amber", text: "Floating topic" } },
    { name: "idea", label: "Idea cloud", base: "rect", keywords: ["cloud", "thought", "brainstorm", "idea"], look: { path: CLOUD, w: 150, h: 90, tone: "green", text: "Idea", box: [16, 30, 70, 50] } },
    { name: "callout", label: "Callout topic", base: "rect", keywords: ["comment", "note", "speech", "callout", "aside"], look: { path: "M10 0H90A10 14 0 0 1 100 14V61A10 14 0 0 1 90 75H50L24 100L32 75H10A10 14 0 0 1 0 61V14A10 14 0 0 1 10 0Z", w: 140, h: 70, tone: "pink", text: "Note", box: [0, 0, 100, 75] } },
  ],
  connectors: [
    { id: "branch", label: "Branch", keywords: ["link", "child", "curve"], route: "straight", ends: ["none", "none"] },
    { id: "branch-elbow", label: "Elbow branch", keywords: ["tree", "orthogonal", "link"], route: "elbow", ends: ["none", "none"] },
    { id: "relation", label: "Relation", keywords: ["cross link", "dashed", "related"], route: "straight", dashed: true, ends: ["none", "arrow"] },
  ],
};

export const ORG: LibraryData = {
  id: "org",
  name: "Org chart",
  icon: "users",
  items: [
    { name: "person", label: "Person card", base: "rect", keywords: ["employee", "person", "people", "staff", "member", "name", "photo"], look: { path: join(card.RR(0, 0, 220, 80, 8), card.E(40, 40, 24), card.E(40, 33, 8), card.PL(26, 56, 30, 47, 50, 47, 54, 56)), w: 220, h: 80, text: "Name\nJob title", box: card.box(72, 0, 144, 80) } },
    { name: "role", label: "Role", base: "rect", keywords: ["position", "job", "title", "manager", "head"], look: { path: join(R(0, 0, 100, 100), role.R(0, 0, 180, 8)), w: 180, h: 70, tone: "blue", text: "Role", box: role.box(0, 8, 180, 62) } },
    { name: "team", label: "Team", base: "rect", keywords: ["group", "department", "unit", "squad", "division"], look: { path: join(team.T(12, 10, 12, 0, 200, 0, 200, 78, 188, 78), team.T(6, 16, 6, 6, 194, 6, 194, 84, 188, 84), team.R(0, 12, 188, 78)), w: 200, h: 90, text: "Team", box: team.box(0, 12, 188, 78) } },
    { name: "assistant", label: "Assistant", base: "rect", keywords: ["assistant", "support", "staff", "aide", "helper"], look: { path: join(R(0, 0, 100, 100), role.L(14, 70, 14, 0)), w: 180, h: 70, text: "Assistant", box: role.box(14, 0, 166, 70) } },
    { name: "vacancy", label: "Open position", base: "rect", keywords: ["vacancy", "hiring", "open role", "tbd", "empty", "dashed"], look: { path: role.DR(0, 0, 180, 70, 7, 5), w: 180, h: 70, text: "Open position" } },
    { name: "department", label: "Department", base: "rect", keywords: ["division", "business unit", "org", "container"], container: true, look: { path: join(R(0, 0, 100, 100), L(0, 14, 100, 14)), w: 420, h: 260, text: "Department", box: [0, 0, 100, 14] } },
  ],
  connectors: [
    { id: "reports-to", label: "Reports to", keywords: ["manager", "line", "hierarchy"], route: "elbow", ends: ["none", "none"] },
    { id: "dotted-line", label: "Dotted line", keywords: ["matrix", "indirect", "dashed"], route: "elbow", dashed: true, ends: ["none", "none"] },
  ],
};
