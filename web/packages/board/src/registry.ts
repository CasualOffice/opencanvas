// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Shape registry (DGM-03, ADR-045). Declarative descriptors only: data, never code, so a
// document or a stencil package can't run anything in the editor's origin.
//
// A diagram shape is stored as one of the nine legacy `type`s (its *base*) plus a namespaced
// `kind` such as `uml:class`. Older clients and the Rust exporter only read `type`, so they draw
// the base shape with its text and keep `kind`, `kindVersion`, `props` and `ports` untouched.
// Lookup order for a shape:
//   1. its `kind`, when that kind is registered;
//   2. the core descriptor of its legacy `type` (a kind whose plugin is missing: `missing` says
//      which, the raw fields stay as they are);
//   3. the generic fallback `core:unknown` for a `type` this client doesn't know (written by a
//      newer client or another tool): a bindable box with the five legacy ports.
import type { Shape, ShapeType } from "./model";
import { readPorts, type Port } from "./ports";

export interface ShapeDescriptor {
  /** Namespaced id `<namespace>:<name>`, lowercase, e.g. `uml:class`. Core kinds are `core:<type>`. */
  kind: string;
  /** Legacy type written in `type`: what 0.1.x clients and the Rust exporter draw. */
  base: ShapeType;
  /** Schema version of the kind's `props` (written as `kindVersion`). */
  version: number;
  /** Human name, for labels and announcements. */
  label?: string;
  /** Connector ends can attach to it. */
  bindable?: boolean;
  /** Ports in addition to the five legacy anchors. */
  ports?: Port[];
  /**
   * How the shape looks and its defaults (DGM-14 S2): data only. `path` is SVG path data in a
   * 100 × 100 box, stretched to the shape (letters, digits, spaces, commas, dots, minus only);
   * without it the base type is drawn. Exporters and 0.1.x clients draw the base type.
   */
  look?: ShapeLook;
  /** Library the kind belongs to in the shapes panel (e.g. `flowchart`). */
  library?: string;
  /** Search words besides the label. */
  keywords?: string[];
}

export interface ShapeLook {
  path?: string;
  /** Default size of a new shape, board units. */
  w?: number;
  h?: number;
  /** Default fill tone (`blue`, `green`, …). */
  tone?: string;
  /** Default text of a new shape (else the label). */
  text?: string;
  /** A built-in icon (`icons/generic.json` id) drawn inside the box, left of the text (DGM-17). */
  icon?: string;
}

const PATH_RE = /^[MLHVCSQTAZmlhvcsqtaz0-9 ,.\-]{1,2000}$/;
const TONE_RE = /^[a-z]{1,16}$/;

/** A well-formed look, frozen, or an error message. */
function readLook(v: unknown): Readonly<ShapeLook> | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "look must be an object";
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["path", "w", "h", "tone", "text", "icon"].includes(k)) return `unexpected look.${k}`;
  if (o.path !== undefined && (typeof o.path !== "string" || !PATH_RE.test(o.path))) return "look.path must be SVG path data";
  for (const k of ["w", "h"] as const) if (o[k] !== undefined && !(typeof o[k] === "number" && o[k] > 0 && o[k] <= 4000)) return `look.${k} must be a size`;
  if (o.tone !== undefined && (typeof o.tone !== "string" || !TONE_RE.test(o.tone))) return "look.tone must be a tone name";
  if (o.text !== undefined && (typeof o.text !== "string" || o.text.length > 200)) return "look.text must be a short string";
  if (o.icon !== undefined && (typeof o.icon !== "string" || !/^[a-z0-9-]{1,64}$/.test(o.icon))) return "look.icon must be an icon id";
  return Object.freeze({ ...o }) as Readonly<ShapeLook>;
}

/** What `descriptorOf` returns: the descriptor used, and the kind/type it stood in for. */
export type ResolvedDescriptor = Readonly<ShapeDescriptor> & { missing?: string };

export const LEGACY_TYPES: readonly ShapeType[] = ["sticky", "rect", "ellipse", "diamond", "text", "arrow", "pen", "swatch", "image"];
const BOX_TYPES: readonly ShapeType[] = ["sticky", "rect", "ellipse", "diamond", "text", "swatch", "image"];
const LABELS: Record<ShapeType, string> = { sticky: "Sticky note", rect: "Rectangle", ellipse: "Ellipse", diamond: "Diamond", text: "Text", arrow: "Connector", pen: "Drawing", swatch: "Colour swatch", image: "Image" };

const KIND_RE = /^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9-]{0,63}$/;

/** A well-formed namespaced kind id. */
export const isKind = (k: unknown): k is string => typeof k === "string" && KIND_RE.test(k);

const freeze = (d: ShapeDescriptor): Readonly<ShapeDescriptor> =>
  Object.freeze({ ...d, ...(d.ports ? { ports: Object.freeze(d.ports.map((p) => Object.freeze({ ...p }))) as Port[] } : {}) });

export const CORE_KINDS: readonly Readonly<ShapeDescriptor>[] = LEGACY_TYPES.map((t) =>
  freeze({ kind: `core:${t}`, base: t, version: 1, label: LABELS[t], bindable: BOX_TYPES.includes(t) }),
);

/** Generic fallback for a `type` this client doesn't know: a bindable box. */
export const FALLBACK: Readonly<ShapeDescriptor> = freeze({ kind: "core:unknown", base: "rect", version: 1, label: "Shape", bindable: true });

const registry = new Map<string, Readonly<ShapeDescriptor>>(CORE_KINDS.map((d) => [d.kind, d]));
const coreOf = (t: ShapeType) => registry.get(`core:${t}`)!;

/**
 * Register a stencil's shape kind. Throws on a malformed or duplicate kind, a `core:` kind, a
 * base that isn't a box type, a bad version, or anything that isn't plain data.
 */
export function registerShape(d: ShapeDescriptor): Readonly<ShapeDescriptor> {
  if (!isKind(d.kind)) throw new Error(`invalid kind ${JSON.stringify(d.kind)} (want namespace:name, lowercase)`);
  if (d.kind.startsWith("core:")) throw new Error("the core namespace is reserved");
  if (registry.has(d.kind)) throw new Error(`kind ${d.kind} is already registered`);
  if (!BOX_TYPES.includes(d.base)) throw new Error(`base must be one of ${BOX_TYPES.join(", ")}`);
  if (!Number.isInteger(d.version) || d.version < 1) throw new Error("version must be a positive integer");
  const allowed = new Set(["kind", "base", "version", "label", "bindable", "ports", "look", "library", "keywords"]);
  for (const [k, v] of Object.entries(d)) {
    if (!allowed.has(k) || typeof v === "function") throw new Error(`descriptors are declarative: unexpected ${k}`);
  }
  const ports = d.ports === undefined ? undefined : readPorts(d.ports);
  if (d.ports && ports!.length !== d.ports.length) throw new Error("invalid or duplicate ports");
  const look = d.look === undefined ? undefined : readLook(d.look);
  if (typeof look === "string") throw new Error(look);
  if (d.library !== undefined && !(typeof d.library === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(d.library))) throw new Error("library must be a short lowercase id");
  if (d.keywords !== undefined && !(Array.isArray(d.keywords) && d.keywords.every((k) => typeof k === "string" && k.length <= 40))) throw new Error("keywords must be short strings");
  const out = freeze({
    kind: d.kind, base: d.base, version: d.version, label: d.label, bindable: d.bindable ?? true,
    ...(ports ? { ports } : {}),
    ...(look ? { look } : {}),
    ...(d.library ? { library: d.library } : {}),
    ...(d.keywords ? { keywords: Object.freeze([...d.keywords]) as string[] } : {}),
  });
  registry.set(d.kind, out);
  return out;
}

/** Remove a registered kind (stencil unloaded). Core kinds stay. */
export function unregisterShape(kind: string): boolean {
  return !kind.startsWith("core:") && registry.delete(kind);
}

export function registeredKinds(): string[] {
  return [...registry.keys()];
}

/** The shape's kind: its `kind` when well-formed, else `core:<type>`, else a namespaced `type`, else `core:unknown`. */
export function kindOf(s: Partial<Shape> & Pick<Shape, "type">): string {
  if (isKind(s.kind)) return s.kind;
  if (LEGACY_TYPES.includes(s.type)) return `core:${s.type}`;
  if (isKind(s.type)) return s.type;
  return FALLBACK.kind;
}

/** The descriptor a shape is handled with (see the lookup order at the top). */
export function descriptorOf(s: Partial<Shape> & Pick<Shape, "type">): ResolvedDescriptor {
  const k = kindOf(s);
  const d = registry.get(k);
  if (d) return d;
  if (LEGACY_TYPES.includes(s.type)) return { ...coreOf(s.type), missing: k };
  return { ...FALLBACK, missing: typeof s.type === "string" && s.type ? s.type : k };
}

/**
 * Fields for a new shape of a registered kind (core kinds give a plain legacy shape). `props` is
 * given as a plain object; `addShape` stores it as a per-field Y.Map (ADR-045). The kind's
 * default ports are written into `ports` unless `init` gives its own.
 */
export function makeNode(kind: string, init: Partial<Omit<Shape, "id" | "type" | "kind" | "kindVersion">>): Omit<Shape, "id"> {
  const d = registry.get(kind);
  if (!d) throw new Error(`unknown kind ${kind}`);
  if (kind.startsWith("core:")) return { type: d.base, ...init };
  // The kind's default ports are stored on the shape, so every renderer (the Rust one has no
  // registry) draws bindings to them at the port (DGM-12). Given `ports` replace them.
  const ports = d.ports?.length && !("ports" in init) ? { ports: d.ports.map((p) => ({ ...p })) } : {};
  return { type: d.base, kind: d.kind, kindVersion: d.version, ...ports, ...init };
}
