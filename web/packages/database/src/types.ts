// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import type { Tone } from "@opencanvas/ui";

/** Field types, as fixed by docs/15-BUILD-CONTRACT.md §4. */
export type FieldType =
  | "title"
  | "text"
  | "status"
  | "select"
  | "tags"
  | "person"
  | "date"
  | "number"
  | "checkbox"
  | "url"
  | "progress"
  /** ADR-078 (v0.4): computed from `formula`; nothing stored in cells. */
  | "formula"
  /** ADR-078: cells hold row ids of the database in `rel`. */
  | "relation"
  /** ADR-078: computed from `roll` over a relation; nothing stored in cells. */
  | "rollup";

/** Field types that need `[host.flags] formulas` to be added (ADR-078). */
export const ADV_TYPES: FieldType[] = ["formula", "relation", "rollup"];
/** Field types whose cells are computed, never typed into. */
export const COMPUTED_TYPES: FieldType[] = ["formula", "rollup"];

export const FIELD_TYPES: FieldType[] = ["title", "text", "status", "select", "tags", "person", "date", "number", "checkbox", "url", "progress"];

/** Option object: `{ "v": "In progress", "c": "blue" }`. */
export interface DbOption {
  v: string;
  c: Tone;
}

export interface DbField {
  id: string;
  name: string;
  type: FieldType;
  options?: DbOption[];
  /** Optional note on the field (what it means, how to fill it). Plain text, may be multi-line. */
  description?: string;
  /** `formula` fields: the expression (`prop("Price") * prop("Qty")`), ≤ 4 KB. */
  formula?: string;
  /** `relation` fields: the target database (docs/15 §4, ADR-078). */
  rel?: RelDef;
  /** `rollup` fields: relation field, field of the related rows, calculation. */
  roll?: RollDef;
}

export interface RelDef {
  db: string;
  /** Another canvas: the live block's file id (one-way, read under that file's ACL). */
  file?: string;
  /** Two-way: `back` is the paired relation field in the target database. */
  two?: boolean;
  back?: string;
  /** `YYYY-MM-DD` the target database was first seen missing; ids are kept 30 days. */
  goneAt?: string;
}

export type RollFn = "count" | "sum" | "percent" | "earliest" | "latest";

export interface RollDef {
  rel: string;
  f?: string;
  fn: RollFn;
}

export type ViewKind = "table" | "board" | "calendar" | "gallery";
export const VIEW_KINDS: ViewKind[] = ["table", "board", "calendar", "gallery"];

/** Per-view preferences, stored as JSON in the db's `views` Y.Map under the view name. */
export interface ViewPrefs {
  filter?: FilterRule | null;
  sort?: SortRule | null;
  q?: string;
  /** Calendar month shown, `YYYY-MM`. */
  cal?: string;
  /**
   * Several sort keys, applied in order. When present it wins over `sort`; writers keep
   * `sort` equal to the first key so older clients still sort by it.
   */
  sorts?: SortRule[];
  /** Several filters, all of which must match (AND). Wins over `filter`, which mirrors the first. */
  filters?: FilterRule[];
  /** Table: column widths in px by field id. */
  widths?: Record<string, number>;
  /** Board: field id to group columns by (status or select). */
  group?: string;
  /** Calendar: date field id the calendar places rows on. */
  date?: string;
  /** Gallery: what fills the card cover: "none", "color" (group colour, default) or a URL field id. */
  cover?: string;
  /**
   * Field ids in this view's order. Fields missing from the list (added later) follow in the
   * database's order. Reordering columns writes this, never the shared `fields` array.
   */
  fields?: string[];
  /** Field ids hidden in this view. The title field is always shown. */
  hidden?: string[];
}

export interface SortRule {
  f: string;
  dir: 1 | -1;
}

/**
 * Typed filter conditions. Option-like fields (status, select, tags, person, checkbox) use
 * `vals` (any of); the others use `op` with `v` (and `v2` for "between").
 * - text, title, url: `contains`, `is`, `empty`
 * - number, progress: `eq ne lt le gt ge between empty`
 * - date (`v` is `YYYY-MM-DD`, or a day count for `next` / `past`): `is before after next past empty`
 */
export type FilterOp = "contains" | "is" | "empty" | "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "between" | "before" | "after" | "next" | "past";

export interface FilterRule {
  f: string;
  vals?: string[];
  op?: FilterOp;
  v?: string | number | null;
  v2?: string | number | null;
}

export type CellValue = string | number | boolean | string[] | null;

export interface DbRow {
  id: string;
  v: Record<string, CellValue>;
}

/** Plain, immutable snapshot of one database, rebuilt from Yjs on every change. */
export interface DbSnapshot {
  id: string;
  name: string;
  icon: string;
  tone: Tone;
  fields: DbField[];
  /** Rows in `order` (deduplicated; rows missing from `order` appended). */
  rows: DbRow[];
  notes: Record<string, string>;
  view: ViewKind;
  views: Record<string, ViewPrefs>;
}
