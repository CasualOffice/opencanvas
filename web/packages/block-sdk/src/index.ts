// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @opencanvas/block-sdk (BSDK-04; docs/32, docs/15 §4.2-4.3).
//
// A block is a browser bundle that calls `defineBlock` once. OpenCanvas runs it in a sandboxed
// iframe on a separate origin; everything it can do goes through the `BlockContext` the frame
// runtime hands to `render`: read its attrs and data, write them (checked against the
// manifest's JSON Schemas, at most 60 writes a second, only when the person may edit), follow
// the editor's theme, report its height, open links and, with `members: "read"`, list the
// canvas's people. Older data is migrated by `defineMigrations` (a `migrations` script in the
// manifest) or by declarative steps in `block.json`.

/** The editor's theme, sent at start and whenever it changes. Tokens are also set as CSS custom
 *  properties `--oc-<name>` on the frame's root: fg, fg-2, fg-3, app, panel, sunk, line, line-2,
 *  accent, accent-soft, accent-fg, red-fg, green-fg, amber-fg, blue-fg, font, mono, r-s, r, r-l. */
export interface Theme {
  scheme: "light" | "dark";
  tokens: Record<string, string>;
}

/** What this block may do on this host: the manifest's ask, narrowed by the host. */
export interface Permissions {
  network: string[];
  members: "read" | "none";
}

/** A person in the canvas: names and pictures only, never e-mail. */
export interface Member {
  id: string;
  name: string;
  avatar: string | null;
}

export type Role = "edit" | "comment" | "view";

export interface BlockData<D> {
  get<K extends keyof D>(key: K): D[K] | undefined;
  all(): Partial<D>;
  /** Sets fields (each its own key: concurrent edits of different fields both survive);
   *  `null` removes one. Rejects when refused (role, rate, schema). */
  set(fields: { [K in keyof D]?: D[K] | null }): Promise<true>;
  /** Called with all fields after any change, local or remote; returns the unsubscribe. */
  observe(fn: (data: Partial<D>) => void): () => void;
}

export interface BlockContext<A = Record<string, unknown>, D = Record<string, unknown>> {
  readonly type: string;
  /** The data version this package writes (its major). */
  readonly v: number;
  /** The block's attrs (a copy; read it again after `update`). */
  readonly attrs: A;
  readonly role: Role;
  /** True unless the person may edit: hide your own controls. */
  readonly readOnly: boolean;
  readonly theme: Theme;
  readonly permissions: Permissions;
  /** Merges a patch into the attrs (`null` removes a key). Resolves with the new attrs; rejects
   *  with the reason when refused (read only, rate limited, or the schema says no). */
  setAttrs(patch: { [K in keyof A]?: A[K] | null }): Promise<A>;
  readonly data: BlockData<D>;
  /** The frame follows its content's height by itself; call this to force one. */
  resize(height: number): void;
  /** Asks the editor to open a link (its own link rules apply). */
  openLink(url: string): void;
  readonly members: { list(): Promise<Member[]> };
}

export interface BlockDefinition<A = Record<string, unknown>, D = Record<string, unknown>> {
  /** Draws the block into `el` once. */
  render(el: HTMLElement, ctx: BlockContext<A, D>): void;
  /** Attrs, data, role or theme changed (another person, undo, the theme). */
  update?(ctx: BlockContext<A, D>): void;
  destroy?(): void;
}

/** One step per data version: version N's data → version N + 1's. Pure functions only. */
export type Migrations = Record<number, (attrs: Record<string, unknown>, data: Record<string, unknown>) => { attrs: Record<string, unknown>; data: Record<string, unknown> }>;

interface Runtime {
  define(def: BlockDefinition<never, never>): void;
  defineMigrations(m: Migrations): void;
}

function runtime(): Runtime {
  const rt = (globalThis as unknown as { OpenCanvasBlock?: Runtime }).OpenCanvasBlock;
  if (!rt) throw new Error("@opencanvas/block-sdk: not running in an OpenCanvas block frame (use createHarness in tests)");
  return rt;
}

/** Registers the block. Call it once, at the top level of the bundle. */
export function defineBlock<A = Record<string, unknown>, D = Record<string, unknown>>(def: BlockDefinition<A, D>): BlockDefinition<A, D> {
  runtime().define(def as unknown as BlockDefinition<never, never>);
  return def;
}

/** Registers script migrations (the manifest's `"migrations": "migrations.js"`). */
export function defineMigrations(m: Migrations): Migrations {
  runtime().defineMigrations(m);
  return m;
}

/** A tiny DOM helper for blocks: `h("button", {onclick}, "Add")`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], "style">> & { style?: string; attrs?: Record<string, string> } = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { style, attrs, ...rest } = props;
  Object.assign(el, rest);
  if (style) el.setAttribute("style", style);
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
