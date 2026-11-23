// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Shape libraries for the diagram shapes panel (DGM-14 S2). Declarative registry data only
// (ADR-045 §3): each kind is a legacy base type plus an optional outline path in a 100 × 100 box,
// a default size, tone and text. Registered when the board package loads, so every client draws
// them, in diagram mode or not (1f); older clients and the exporters draw the base type.
import { registeredKinds, registerShape, type ShapeDescriptor } from "./registry";

/** Drag data type of a shapes-panel tile (the kind id). */
export const KIND_MIME = "application/x-opencanvas-kind";

export interface Library {
  id: string;
  name: string;
  /** Lucide icon name for the panel header and the rail. */
  icon: string;
  kinds: string[];
}

type Item = Omit<ShapeDescriptor, "kind" | "version" | "library"> & { name: string };

const CYLINDER = "M0 12C0 -4 100 -4 100 12V88C100 104 0 104 0 88Z M0 12C0 28 100 28 100 12";
const COMPARTMENTS = "M0 0H100V100H0Z M0 30H100 M0 65H100";

const DATA: { id: string; name: string; icon: string; items: Item[] }[] = [
  {
    id: "flowchart",
    name: "Flowchart",
    icon: "workflow",
    items: [
      { name: "process", label: "Process", base: "rect", keywords: ["step", "action", "task"], look: { w: 140, h: 70 } },
      { name: "decision", label: "Decision", base: "diamond", keywords: ["if", "branch", "condition", "question"], look: { w: 140, h: 100 } },
      { name: "terminator", label: "Start or end", base: "rect", keywords: ["start", "end", "begin", "stop", "terminal"], look: { path: "M20 0H80A20 50 0 0 1 80 100H20A20 50 0 0 1 20 0Z", w: 140, h: 56 } },
      { name: "document", label: "Document", base: "rect", keywords: ["file", "report", "paper"], look: { path: "M0 0H100V85C75 70 50 100 25 92C15 89 8 86 0 85Z", w: 140, h: 80 } },
      { name: "io", label: "Input or output", base: "rect", keywords: ["input", "output", "data", "read", "write"], look: { path: "M15 0H100L85 100H0Z", w: 150, h: 70 } },
      { name: "stored-data", label: "Stored data", base: "rect", keywords: ["storage", "data", "save"], look: { path: "M15 0H100C88 15 88 85 100 100H15C3 85 3 15 15 0Z", w: 140, h: 70 } },
      { name: "subprocess", label: "Subprocess", base: "rect", keywords: ["predefined", "call", "routine"], look: { path: "M0 0H100V100H0Z M10 0V100 M90 0V100", w: 150, h: 70 } },
    ],
  },
  {
    id: "uml",
    name: "UML",
    icon: "boxes",
    items: [
      { name: "class", label: "Class", base: "rect", keywords: ["object", "type"], look: { path: COMPARTMENTS, w: 180, h: 120, text: "Class" } },
      { name: "interface", label: "Interface", base: "rect", keywords: ["contract", "protocol"], look: { path: COMPARTMENTS, w: 180, h: 100, text: "«interface»\nName" } },
      { name: "enumeration", label: "Enumeration", base: "rect", keywords: ["enum", "values"], look: { path: COMPARTMENTS, w: 160, h: 110, text: "«enumeration»\nName" } },
      { name: "package", label: "Package", base: "rect", keywords: ["namespace", "module", "folder"], look: { path: "M0 15H100V100H0Z M0 0H40V15", w: 200, h: 140, text: "package" } },
      { name: "note", label: "Note", base: "rect", keywords: ["comment", "annotation"], look: { path: "M0 0H82L100 18V100H0Z M82 0V18H100", w: 160, h: 80, tone: "amber", text: "" } },
    ],
  },
  {
    id: "network",
    name: "Network",
    icon: "network",
    items: [
      { name: "server", label: "Server", base: "rect", keywords: ["host", "machine", "vm", "node"], look: { path: "M0 0H100V100H0Z M8 18H30 M8 30H30", w: 150, h: 70 } },
      { name: "database", label: "Database", base: "rect", keywords: ["db", "sql", "postgres", "mysql", "storage", "data"], look: { path: CYLINDER, w: 120, h: 90, tone: "green" } },
      { name: "load-balancer", label: "Load balancer", base: "rect", keywords: ["lb", "proxy", "ingress", "traffic"], look: { path: "M0 0H100V100H0Z M50 15V40 M50 40L25 85 M50 40L75 85", w: 150, h: 70, tone: "purple" } },
      { name: "service", label: "Service", base: "rect", keywords: ["microservice", "app", "api", "pod"], look: { w: 150, h: 70, tone: "blue" } },
      { name: "api-gateway", label: "API gateway", base: "rect", keywords: ["gateway", "api", "edge", "ingress"], look: { path: "M10 0H90L100 50L90 100H10L0 50Z", w: 160, h: 70, tone: "blue" } },
      { name: "cloud", label: "Cloud", base: "rect", keywords: ["internet", "external", "saas", "vpc"], look: { path: "M25 85C8 85 0 72 4 60C-2 45 10 30 25 34C28 15 50 8 62 20C72 8 95 15 92 35C104 40 102 62 90 66C94 80 80 88 70 85Z", w: 160, h: 100 } },
      { name: "queue", label: "Queue", base: "rect", keywords: ["topic", "kafka", "stream", "message", "bus", "events"], look: { path: "M12 0H88C104 0 104 100 88 100H12C-4 100 -4 0 12 0Z M88 0C72 0 72 100 88 100", w: 160, h: 60, tone: "amber" } },
      { name: "cache", label: "Cache", base: "rect", keywords: ["redis", "memcached", "memory", "data"], look: { path: "M25 0H75L100 50L75 100H25L0 50Z", w: 140, h: 70, tone: "red" } },
      { name: "client", label: "Client", base: "rect", keywords: ["browser", "user", "app", "device", "web", "mobile"], look: { path: "M0 0H100V78H0Z M35 100H65 M50 78V100", w: 140, h: 90 } },
    ],
  },
];

export const LIBRARIES: readonly Library[] = DATA.map((l) => ({ id: l.id, name: l.name, icon: l.icon, kinds: l.items.map((i) => `${l.id}:${i.name}`) }));

const have = new Set(registeredKinds());
for (const l of DATA) {
  for (const { name, ...d } of l.items) {
    const kind = `${l.id}:${name}`;
    if (!have.has(kind)) registerShape({ ...d, kind, version: 1, library: l.id });
  }
}
