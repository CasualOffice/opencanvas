// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// UML (DGM-14.7): class, component, deployment, use case, sequence, state and activity notation
// (OMG UML), drawn by us. Kind ids from step 1 (class … note) never change.
import { NOTE } from "./basic";
import { at, G, join, type LibraryData } from "./geo";

const { R, E, P, L } = G;
const COMPARTMENTS = join(R(0, 0, 100, 100), L(0, 30, 100, 30), L(0, 65, 100, 65));
const NAME_BOX: [number, number, number, number] = [0, 0, 100, 30];

const actor = at(60, 100);
const life = at(120, 300);
const frame = at(360, 240);
const comp = at(180, 90);

export const UML: LibraryData = {
  id: "uml",
  name: "UML",
  icon: "boxes",
  items: [
    { name: "class", label: "Class", base: "rect", keywords: ["object", "type", "attributes", "methods"], look: { path: COMPARTMENTS, w: 180, h: 120, text: "Class", box: NAME_BOX } },
    { name: "abstract-class", label: "Abstract class", base: "rect", keywords: ["abstract", "class", "base class"], look: { path: COMPARTMENTS, w: 180, h: 120, text: "«abstract»\nName", box: NAME_BOX } },
    { name: "interface", label: "Interface", base: "rect", keywords: ["contract", "protocol"], look: { path: COMPARTMENTS, w: 180, h: 100, text: "«interface»\nName", box: [0, 0, 100, 30] } },
    { name: "enumeration", label: "Enumeration", base: "rect", keywords: ["enum", "values"], look: { path: COMPARTMENTS, w: 160, h: 110, text: "«enumeration»\nName", box: NAME_BOX } },
    { name: "object", label: "Object", base: "rect", keywords: ["instance", "object diagram"], look: { path: join(R(0, 0, 100, 100), L(0, 36, 100, 36)), w: 170, h: 90, text: "obj : Class", box: [0, 0, 100, 36] } },
    { name: "package", label: "Package", base: "rect", keywords: ["namespace", "module", "folder"], look: { path: "M0 0H40V15H100V100H0Z M0 15H40", w: 200, h: 140, text: "package", box: [0, 15, 100, 85] } },
    { name: "component", label: "Component", base: "rect", keywords: ["module", "service", "library", "part"], look: { path: join(R(0, 0, 100, 100), comp.R(154, 10, 16, 20), comp.R(149, 14, 10, 4), comp.R(149, 22, 10, 4)), w: 180, h: 90, text: "«component»\nName", box: [0, 0, 84, 100] } },
    { name: "node", label: "Node", base: "rect", keywords: ["deployment", "device", "server", "execution environment", "3d box"], look: { path: join(P(0, 16, 86, 16, 86, 100, 0, 100), P(0, 16, 14, 0, 100, 0, 86, 16), P(86, 16, 100, 0, 100, 84, 86, 100)), w: 180, h: 110, text: "«device»\nNode", box: [0, 16, 86, 84] } },
    { name: "artifact", label: "Artifact", base: "rect", keywords: ["file", "deployable", "jar", "binary", "build"], look: { path: join(R(0, 0, 100, 100), comp.P(150, 10, 162, 10, 168, 16, 168, 32, 150, 32), comp.L(162, 10, 162, 16), comp.L(162, 16, 168, 16)), w: 180, h: 90, text: "«artifact»\napp.jar", box: [0, 0, 82, 100] } },
    { name: "actor", label: "Actor", base: "rect", keywords: ["user", "person", "role", "stick figure", "human", "people"], look: { path: join(actor.E(30, 11, 9), actor.L(30, 20, 30, 50), actor.L(6, 30, 54, 30), actor.L(30, 50, 10, 74), actor.L(30, 50, 50, 74)), w: 60, h: 100, text: "Actor", box: [0, 78, 100, 22] } },
    { name: "use-case", label: "Use case", base: "ellipse", keywords: ["usecase", "feature", "goal", "scenario"], look: { w: 160, h: 80, text: "Use case" } },
    { name: "system-boundary", label: "System boundary", base: "rect", keywords: ["system", "subject", "boundary", "scope", "container"], container: true, look: { path: R(0, 0, 100, 100), w: 300, h: 360, text: "System", box: [0, 0, 100, 11] } },
    { name: "note", label: "Note", base: "rect", keywords: ["comment", "annotation"], look: { path: NOTE, w: 160, h: 80, tone: "amber", text: "", box: [0, 18, 100, 82] } },
    { name: "lifeline", label: "Lifeline", base: "rect", keywords: ["sequence", "participant", "object", "timeline"], look: { path: join(life.R(0, 0, 120, 44), life.DL(60, 44, 60, 300, 8, 6)), w: 120, h: 300, text: ":Object", box: life.box(0, 0, 120, 44) } },
    { name: "activation", label: "Activation", base: "rect", keywords: ["execution", "sequence", "focus", "bar"], look: { path: R(0, 0, 100, 100), w: 16, h: 80, text: "" } },
    { name: "state", label: "State", base: "rect", keywords: ["status", "state machine", "mode"], look: { w: 140, h: 70, text: "State" } },
    { name: "initial", label: "Initial state", base: "ellipse", keywords: ["start", "begin", "initial", "entry", "dot"], look: { w: 30, h: 30, tone: "gray", text: "" } },
    { name: "final", label: "Final state", base: "ellipse", keywords: ["end", "stop", "final", "exit", "bullseye"], look: { path: join(E(50, 50, 50), E(50, 50, 30)), w: 34, h: 34, tone: "gray", text: "" } },
    { name: "choice", label: "Choice", base: "diamond", keywords: ["branch", "if", "condition", "pseudostate"], look: { w: 40, h: 40, text: "" } },
    { name: "fork", label: "Fork or join", base: "rect", keywords: ["fork", "join", "bar", "parallel", "synchronise", "synchronize"], ports: [{ id: "t1", side: "top", x: 0.2, y: 0 }, { id: "t2", side: "top", x: 0.8, y: 0 }, { id: "b1", side: "bottom", x: 0.2, y: 1 }, { id: "b2", side: "bottom", x: 0.8, y: 1 }], look: { path: R(0, 0, 100, 100), w: 160, h: 10, tone: "gray", text: "" } },
    { name: "history", label: "History", base: "ellipse", keywords: ["history", "shallow", "deep", "resume"], look: { w: 36, h: 36, text: "H" } },
    { name: "action", label: "Action", base: "rect", keywords: ["activity", "step", "task", "do"], look: { w: 140, h: 60, text: "Action" } },
    { name: "decision", label: "Decision or merge", base: "diamond", keywords: ["if", "branch", "condition", "merge", "guard"], look: { w: 50, h: 50, text: "" } },
    { name: "swimlane", label: "Swimlane", base: "rect", keywords: ["lane", "partition", "column", "responsibility", "container"], container: true, look: { path: join(R(0, 0, 100, 100), L(0, 10, 100, 10)), w: 240, h: 400, text: "Lane", box: [0, 0, 100, 10] } },
    { name: "frame", label: "Frame", base: "rect", keywords: ["sd", "sequence diagram", "interaction", "fragment", "container"], container: true, look: { path: join(R(0, 0, 100, 100), frame.T(0, 30, 100, 30, 112, 18, 112, 0)), w: 360, h: 240, text: "sd Name", box: frame.box(0, 0, 108, 30) } },
    { name: "alt", label: "Alternative fragment", base: "rect", keywords: ["alt", "if else", "combined fragment", "condition", "container"], container: true, look: { path: join(R(0, 0, 100, 100), frame.T(0, 30, 60, 30, 72, 18, 72, 0), frame.DL(0, 130, 360, 130, 8, 6)), w: 360, h: 240, text: "alt", box: frame.box(0, 0, 68, 30) } },
    { name: "loop", label: "Loop fragment", base: "rect", keywords: ["loop", "repeat", "combined fragment", "while", "container"], container: true, look: { path: join(R(0, 0, 100, 100), frame.T(0, 30, 60, 30, 72, 18, 72, 0)), w: 360, h: 200, text: "loop", box: frame.box(0, 0, 68, 30) } },
    { name: "send-signal", label: "Send signal", base: "rect", keywords: ["signal", "send", "event", "emit", "message"], look: { path: P(0, 0, 80, 0, 100, 50, 80, 100, 0, 100), w: 140, h: 60, text: "Send", box: [0, 0, 84, 100] } },
    { name: "receive-signal", label: "Receive signal", base: "rect", keywords: ["signal", "receive", "accept", "event", "message"], look: { path: P(0, 0, 100, 0, 100, 100, 0, 100, 20, 50), w: 140, h: 60, text: "Receive", box: [16, 0, 84, 100] } },
  ],
};
