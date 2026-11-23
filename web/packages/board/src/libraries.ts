// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Shape libraries for the diagram shapes panel (DGM-14 S2, DGM-14.7). Declarative registry data
// only (ADR-045 §3): each kind is a legacy base type plus an optional outline path in a 100 × 100
// box, a default size, tone, text and label box. One module per library (`libraries/*.ts`), all
// our own drawings. Registered when the board package loads (a lazy chunk, never the editor's
// initial bundle), so every client draws them, in diagram mode or not (1f); older clients and
// the exporters draw the base type with its text (ADR-045 §5).
import { registeredKinds, registerShape } from "./registry";
import type { ConnectorPreset, LibraryData } from "./libraries/geo";
import { BASIC } from "./libraries/basic";
import { FLOWCHART } from "./libraries/flowchart";
import { UML } from "./libraries/uml";
import { ERD } from "./libraries/erd";
import { NETWORK } from "./libraries/network";
import { BPMN } from "./libraries/bpmn";
import { MINDMAP, ORG } from "./libraries/maps";
import { WIREFRAME } from "./libraries/wireframe";
import { MOCKUP } from "./libraries/mockup";
import { ARROWS } from "./libraries/arrows";
import { SIGNS } from "./libraries/signs";

export type { ConnectorPreset } from "./libraries/geo";

/** Drag data type of a shapes-panel tile (the kind id). */
export const KIND_MIME = "application/x-opencanvas-kind";

export interface Library {
  id: string;
  name: string;
  /** Lucide icon name for the panel header and the rail. */
  icon: string;
  kinds: string[];
}

/** Every bundled library, in panel order, including flagged ones. */
export const ALL_LIBRARIES: readonly LibraryData[] = [
  BASIC, FLOWCHART, UML, ERD, NETWORK, BPMN, MINDMAP, ORG, WIREFRAME, MOCKUP, ARROWS, SIGNS,
];

const toLibrary = (l: LibraryData): Library => ({ id: l.id, name: l.name, icon: l.icon, kinds: l.items.map((i) => `${l.id}:${i.name}`) });

/** Libraries off by default (BPMN): their kinds still draw, but the panel lists them only when on. */
export const FLAGGED_LIBRARIES: readonly string[] = ALL_LIBRARIES.filter((l) => l.flag).map((l) => l.id);
const enabled = new Set<string>();

/**
 * The libraries the shapes panel lists, in order. A live array: `setLibraryEnabled` updates it in
 * place, so the panel (which reads it on render) picks the change up on its next render.
 */
export const LIBRARIES: readonly Library[] = [];
function rebuild() {
  const list = LIBRARIES as Library[];
  list.splice(0, list.length, ...ALL_LIBRARIES.filter((l) => !l.flag || enabled.has(l.id)).map(toLibrary));
}
rebuild();

/** Turns a flagged library (e.g. `bpmn`) on or off in the panel. Its kinds always draw. */
export function setLibraryEnabled(id: string, on: boolean): void {
  if (!FLAGGED_LIBRARIES.includes(id)) return;
  if (on) enabled.add(id);
  else enabled.delete(id);
  rebuild();
}

/** Connector presets per library id (crow's foot, Chen, BPMN flows, mind-map branches, org lines). */
export const CONNECTOR_PRESETS: Readonly<Record<string, readonly ConnectorPreset[]>> = Object.freeze(
  Object.fromEntries(ALL_LIBRARIES.filter((l) => l.connectors?.length).map((l) => [l.id, Object.freeze([...l.connectors!])])),
);

const have = new Set(registeredKinds());
for (const l of ALL_LIBRARIES) {
  for (const { name, ...d } of l.items) {
    const kind = `${l.id}:${name}`;
    if (!have.has(kind)) registerShape({ ...d, kind, version: 1, library: l.id });
  }
}
