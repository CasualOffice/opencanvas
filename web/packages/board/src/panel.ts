// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// What the shapes panel shows (DGM-14 S2), on top of the library content in libraries.ts (owned
// separately): connector presets, the BPMN flag and Beta mark, libraries that join later (the
// Icons library, DGM-17), lazily loaded libraries, and the size and text of a new shape.
// Data only; nothing here draws.
import type { Shape } from "./model";
import { CONTAINER } from "./kinds";
import { ALL_LIBRARIES, toLibrary, type Library } from "./libraries";
import type { ShapeDescriptor } from "./registry";

/** A preset's tile id prefix: `preset:<id>` (never a registered kind). */
export const PRESET = "preset:";

export interface ConnectorPreset {
  id: string;
  label: string;
  keywords?: string[];
  /** Library ids it shows under (the first one present wins). */
  library: string[];
  /** Fields of the new connector (route, dashed) and its `props` (arrows, cardinality, pattern). */
  fields: Partial<Pick<Shape, "route" | "dashed">>;
  props: Record<string, string>;
}

/** A library as the panel shows it. */
export interface PanelLibrary extends Library {
  /** Connector preset ids, shown after the shapes. */
  connectors?: string[];
  /** Shown only when the host turns this flag on (BPMN, 2f). */
  flag?: "bpmn";
  /** Marked "Beta" with an explanation (2f). */
  beta?: boolean;
  /** Number of tiles before `load` has run (a library kept in its own chunk). */
  count?: number;
  /**
   * Registers the library's kinds (registerShape) and returns them in panel order; called the
   * first time the library is opened or someone searches. Until then the panel shows `count`.
   */
  load?: () => Promise<string[]>;
}

const PRESET_DATA: ConnectorPreset[] = [
  { id: "flow-line", label: "Flow line", library: ["flow", "flowchart"], keywords: ["arrow", "connector", "next"], fields: { route: "elbow" }, props: { endArrow: "arrow" } },
  { id: "uml-inheritance", label: "Inheritance", library: ["uml"], keywords: ["extends", "generalization", "subclass"], fields: {}, props: { endArrow: "triangle" } },
  { id: "uml-realization", label: "Implements", library: ["uml"], keywords: ["realization", "interface"], fields: { dashed: true }, props: { endArrow: "triangle", pattern: "dashed" } },
  { id: "uml-association", label: "Association", library: ["uml"], keywords: ["link", "relation"], fields: {}, props: { endArrow: "none" } },
  { id: "uml-aggregation", label: "Aggregation", library: ["uml"], keywords: ["has", "part"], fields: {}, props: { startArrow: "diamond", endArrow: "none" } },
  { id: "uml-composition", label: "Composition", library: ["uml"], keywords: ["owns", "part"], fields: {}, props: { startArrow: "diamond-filled", endArrow: "none" } },
  { id: "uml-dependency", label: "Dependency", library: ["uml"], keywords: ["uses", "depends"], fields: { dashed: true }, props: { endArrow: "arrow", pattern: "dashed" } },
  { id: "erd-one-one", label: "One to one", library: ["erd"], keywords: ["relation", "1:1"], fields: { route: "elbow" }, props: { startCard: "one", endCard: "one" } },
  { id: "erd-one-many", label: "One to many", library: ["erd"], keywords: ["relation", "1:n", "crow"], fields: { route: "elbow" }, props: { startCard: "one", endCard: "many" } },
  { id: "erd-many-many", label: "Many to many", library: ["erd"], keywords: ["relation", "n:m", "crow"], fields: { route: "elbow" }, props: { startCard: "many", endCard: "many" } },
  { id: "erd-zero-many", label: "Zero or many", library: ["erd"], keywords: ["relation", "optional", "crow"], fields: { route: "elbow" }, props: { startCard: "one", endCard: "zero-many" } },
];
const PRESETS: ConnectorPreset[] = PRESET_DATA.map((p) => Object.freeze({ ...p, fields: Object.freeze({ ...p.fields }), props: Object.freeze({ ...p.props }) }));
const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

/** A connector preset by id (`preset:<id>` or `<id>`). */
export const presetOf = (id: string): ConnectorPreset | undefined => PRESET_BY_ID.get(id.startsWith(PRESET) ? id.slice(PRESET.length) : id);

/** Libraries added after the content (the Icons library, DGM-17), with their place. */
const extra: { lib: PanelLibrary; before?: string }[] = [];
let version = 0;
const listeners = new Set<() => void>();
const bump = () => {
  version++;
  listeners.forEach((f) => f());
};
/** Panel libraries change (one registered or loaded): for `useSyncExternalStore`. */
export const subscribeLibraries = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
export const librariesVersion = () => version;

/**
 * Add a library to the panel: the Icons library (DGM-17) joins here. Placed before `before` (a
 * library id), else at the end. A library kept in its own chunk gives `count` and `load`.
 */
export function registerLibrary(lib: PanelLibrary, before?: string) {
  if (panelLibraries().some((l) => l.id === lib.id)) throw new Error(`library ${lib.id} is already registered`);
  extra.push({ lib: { ...lib, kinds: [...lib.kinds] }, before });
  bump();
}

/** Load a library's data if it has a loader that hasn't run (lazy chunks). */
const loading = new Map<string, Promise<void>>();
const loaded = new Map<string, string[]>();
export function loadLibrary(l: PanelLibrary): Promise<void> {
  if (!l.load) return Promise.resolve();
  let p = loading.get(l.id);
  if (!p) {
    p = l.load().then(
      (kinds) => {
        loaded.set(l.id, [...kinds]);
        bump();
      },
      () => void loading.delete(l.id), // try again next time it is opened
    );
    loading.set(l.id, p);
  }
  return p;
}

/** Every library in panel order, with its presets and flags. */
export function panelLibraries(): PanelLibrary[] {
  // Every library, flagged ones included (BPMN): the panel decides what to show from the host's
  // flag or the code switch (`setLibraryEnabled`), see `availableLibraries`.
  const out: PanelLibrary[] = ALL_LIBRARIES.map((d) => ({
    ...(d.flag ? { flag: "bpmn" as const, beta: true } : {}),
    ...toLibrary(d),
  }));
  for (const { lib, before } of extra) {
    const i = before ? out.findIndex((x) => x.id === before) : -1;
    out.splice(i < 0 ? out.length : i, 0, lib);
  }
  const ids = new Set(out.map((l) => l.id));
  return out.map((l) => (loaded.has(l.id) ? { ...l, kinds: loaded.get(l.id)! } : l)).map((l) => {
    const mine = PRESETS.filter((p) => p.library.find((id) => ids.has(id)) === l.id).map((p) => p.id);
    return mine.length ? { ...l, connectors: [...(l.connectors ?? []), ...mine.filter((id) => !l.connectors?.includes(id))] } : l;
  });
}

/** Size, text and fill of a new shape of `kind` added from the panel. */
export function newShapeFields(kind: string, d: Readonly<ShapeDescriptor>): Partial<Shape> {
  switch (kind) {
    case "core:sticky":
      return { w: 150, h: 110, fill: "y", text: "" };
    case "core:text":
      return { w: 120, h: 30, text: "Text", size: 18 };
    case "core:ellipse":
      return { w: 120, h: 80, text: "" };
    case "core:diamond":
      return { w: 120, h: 100, text: "" };
    case "core:rect":
      return { w: 140, h: 70, text: "" };
    case CONTAINER:
      return { w: 320, h: 200, label: "Container" };
  }
  return { w: d.look?.w ?? 140, h: d.look?.h ?? 70, text: d.look?.text ?? d.label ?? "", ...(d.look?.tone ? { fill: d.look.tone } : {}) };
}
