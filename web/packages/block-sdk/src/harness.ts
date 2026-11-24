// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Test harness for block authors (BSDK-04): runs a block definition in the test's DOM with a
// context that behaves like the frame runtime's (copies on read, `null` removes, refused
// writes when read only, an optional schema check), and records every write. No iframe, no
// editor: unit tests of a block's own logic.
//
//   const t = createHarness(okr, { attrs: { objective: "Ship" }, role: "edit" });
//   t.el.querySelector("button")!.click();
//   expect(t.attrs().krs).toHaveLength(1);
import type { BlockContext, BlockDefinition, Member, Permissions, Role, Theme } from "./index";

type Obj = Record<string, unknown>;

export interface HarnessOptions {
  attrs?: Obj;
  data?: Obj;
  role?: Role;
  theme?: Theme;
  permissions?: Permissions;
  members?: Member[];
  type?: string;
  v?: number;
  /** Return an error message to refuse a write (e.g. a JSON Schema check). */
  validate?: (kind: "attrs" | "data", next: Obj) => string | null;
}

export interface Harness {
  el: HTMLElement;
  ctx: BlockContext<Obj, Obj>;
  attrs(): Obj;
  data(): Obj;
  /** Every accepted write, in order. */
  writes: { kind: "attrs" | "data"; value: Obj }[];
  /** Links the block asked to open; heights it reported. */
  links: string[];
  heights: number[];
  /** Simulates a change from elsewhere (another person, undo) and calls `update`. */
  change(next: { attrs?: Obj; data?: Obj; role?: Role; theme?: Theme }): void;
  destroy(): void;
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));

function merge(base: Obj, patch: Obj): Obj {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = copy(v);
  }
  return out;
}

export function createHarness<A = Obj, D = Obj>(def: BlockDefinition<A, D>, o: HarnessOptions = {}): Harness {
  let attrs: Obj = copy(o.attrs ?? {});
  let data: Obj = copy(o.data ?? {});
  let role: Role = o.role ?? "edit";
  let theme: Theme = o.theme ?? { scheme: "light", tokens: {} };
  const observers = new Set<(d: Obj) => void>();
  const el = document.createElement("div");
  document.body.append(el);
  const writes: Harness["writes"] = [];
  const links: string[] = [];
  const heights: number[] = [];
  const write = (kind: "attrs" | "data", patch: Obj) => {
    if (role !== "edit") return Promise.reject(new Error("read only: this person can't edit the canvas"));
    const next = merge(kind === "attrs" ? attrs : data, patch);
    const bad = o.validate?.(kind, next);
    if (bad) return Promise.reject(new Error(bad));
    if (kind === "attrs") attrs = next;
    else data = next;
    writes.push({ kind, value: copy(next) });
    if (kind === "data") for (const f of observers) f(copy(data));
    return Promise.resolve(copy(next));
  };
  const ctx: BlockContext<Obj, Obj> = {
    get type() { return o.type ?? "test.block"; },
    get v() { return o.v ?? 1; },
    get attrs() { return copy(attrs); },
    get role() { return role; },
    get readOnly() { return role !== "edit"; },
    get theme() { return copy(theme); },
    get permissions(): Permissions { return copy(o.permissions ?? { network: [], members: "none" }); },
    setAttrs: (patch) => write("attrs", patch as Obj),
    data: {
      get: (k) => copy(data[k as string]) as never,
      all: () => copy(data),
      set: (fields) => write("data", fields as Obj).then(() => true as const),
      observe: (fn) => (observers.add(fn as (d: Obj) => void), () => observers.delete(fn as (d: Obj) => void)),
    },
    resize: (h) => void heights.push(h),
    openLink: (url) => void links.push(url),
    members: {
      list: () => ((o.permissions?.members ?? "none") === "read" ? Promise.resolve(copy(o.members ?? [])) : Promise.reject(new Error("this block may not see the member list"))),
    },
  };
  def.render(el, ctx as unknown as BlockContext<A, D>);
  return {
    el,
    ctx,
    attrs: () => copy(attrs),
    data: () => copy(data),
    writes,
    links,
    heights,
    change(next) {
      if (next.attrs) attrs = copy(next.attrs);
      if (next.data) data = copy(next.data);
      if (next.role) role = next.role;
      if (next.theme) theme = copy(next.theme);
      def.update?.(ctx as unknown as BlockContext<A, D>);
      if (next.data) for (const f of observers) f(copy(data));
    },
    destroy() {
      def.destroy?.();
      el.remove();
    },
  };
}
