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
  | "progress";

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
}

export type ViewKind = "table" | "board" | "calendar" | "gallery";
export const VIEW_KINDS: ViewKind[] = ["table", "board", "calendar", "gallery"];

/** Per-view preferences, stored as JSON in the db's `views` Y.Map under the view name. */
export interface ViewPrefs {
  filter?: { f: string; vals: string[] } | null;
  sort?: { f: string; dir: 1 | -1 } | null;
  q?: string;
  /** Calendar month shown, `YYYY-MM`. */
  cal?: string;
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
