// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Properties panel helpers (DGM-14 S4, prototype 4a-4d). No rendering. Every field the panel edits
// is one key: a shape key (`text`, `fill`, `route`, ...) or one `props` key, written through
// `updateShape`, which merges `props` per field (ADR-045), so two people editing different fields
// of one shape both keep their change.
import * as Y from "yjs";
import { updateShape, type Shape } from "../../model";

export const MIXED = Symbol("mixed");
export type Shared<T> = T | typeof MIXED | undefined;

/** The value all `shapes` share for `get`, `MIXED` where they differ (multi-select). */
export function shared<T>(shapes: Shape[], get: (s: Shape) => T | undefined): Shared<T> {
  if (!shapes.length) return undefined;
  const first = get(shapes[0]!);
  const key = (v: unknown) => JSON.stringify(v ?? null);
  return shapes.every((s) => key(get(s)) === key(first)) ? first : MIXED;
}

/** Moves item `i` one place up (-1) or down (+1); the same array when it can't move. */
export function moveItem<T>(list: readonly T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list as T[];
  const out = list.slice();
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** Moves item `from` to index `to` (drag and drop). */
export function moveTo<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list as T[];
  const out = list.slice();
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x!);
  return out;
}

export const propOf = <T = unknown,>(s: Shape, k: string): T | undefined => (s.props ? (s.props[k] as T) : undefined);

/** Writes one `props` key on each shape (merged per field). */
export function setProp(doc: Y.Doc, boardId: string, ids: string[], k: string, v: unknown, origin?: unknown) {
  doc.transact(() => ids.forEach((id) => updateShape(doc, boardId, id, { props: { [k]: v } }, origin)), origin);
}

/** Writes shape keys on each shape (one key per field). */
export function setField(doc: Y.Doc, boardId: string, ids: string[], patch: Partial<Shape>, origin?: unknown) {
  doc.transact(() => ids.forEach((id) => updateShape(doc, boardId, id, patch, origin)), origin);
}

/* ---- kinds the panel knows (namespaces of the bundled libraries) ---- */

export type Vis = "+" | "-" | "#" | "~";
export const VIS: Vis[] = ["+", "-", "#", "~"];
export const VIS_NAME: Record<Vis, string> = { "+": "public", "-": "private", "#": "protected", "~": "package" };
export interface Member { vis: Vis; name: string; type: string }
export type KeyMark = "" | "pk" | "fk";
export interface Column { key: KeyMark; name: string; type: string; ref?: string; nullable?: boolean }

export const NETWORK_KINDS: [string, string][] = [
  ["net:server", "Server"], ["net:database", "Database"], ["net:load-balancer", "Load balancer"], ["net:service", "Service"],
  ["net:api-gateway", "API gateway"], ["net:cloud", "Cloud"], ["net:queue", "Queue"], ["net:cache", "Cache"],
];

const LIBS: Record<string, string> = { uml: "UML", erd: "Entity relationship", net: "Network", flow: "Flowchart", bpmn: "BPMN", core: "General" };
export const libraryOf = (kind: string | undefined) => (kind ? LIBS[kind.split(":")[0]!] : undefined);

export type Panel = "uml-class" | "erd-entity" | "network" | "connector" | "shape";
export function panelOf(s: Shape): Panel {
  if (s.type === "arrow") return "connector";
  if (s.kind === "uml:class" || s.kind === "uml:interface" || s.kind === "uml:enumeration") return "uml-class";
  if (s.kind === "erd:entity") return "erd-entity";
  if (s.kind?.startsWith("net:")) return "network";
  return "shape";
}

/** Plain list of objects from a `props` value (anything else reads as empty). */
export function listOf<T extends object>(v: unknown): T[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as T[]) : [];
}

export const touchesErd = (c: Shape, byId: (id: string) => Shape | undefined) =>
  [c.start?.shapeId, c.end?.shapeId].some((id) => !!id && !!byId(id)?.kind?.startsWith("erd:"));

export const CARDINALITY: [string, string][] = [["one", "Exactly one"], ["zero-one", "Zero or one"], ["many", "One or many"], ["zero-many", "Zero or many"]];
export const ARROWS: [string, string][] = [["none", "None"], ["arrow", "Arrow"], ["triangle", "Triangle"], ["diamond", "Diamond"], ["circle", "Circle"]];

/** "many to one" etc. for a relationship seen from `selfId` (ERD relationships list, 4b). */
export function relation(c: Shape, selfId: string): string {
  const card = (v: unknown) => (v === "many" || v === "zero-many" ? "many" : "one");
  const a = card(propOf(c, "startCard")), b = card(propOf(c, "endCard"));
  return c.start?.shapeId === selfId ? `${a} to ${b}` : `${b} to ${a}`;
}

/** Display name of a shape (its text, else its kind's label). */
export const nameOf = (s: Shape | undefined) => (s ? (s.text?.split("\n")[0] || s.label || s.kind?.split(":")[1] || s.type) : "");
