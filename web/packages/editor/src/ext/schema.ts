// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The JSON Schema 2020-12 subset of `oc_model::ext::schema` (docs/15 §4.2), for the bridge's
// write checks (BSDK-03): a block's setAttrs / data.set is validated here before it reaches
// Yjs, and again by the server. Same keywords, same refusals; shared cases in
// crates/oc-model/tests/fixtures/ext.json (`schemas`). Patterns use the browser's RegExp with
// the `u` flag; the package was already checked at install on a linear-time engine.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type S = boolean | { [k: string]: unknown };

const TYPES = ["null", "boolean", "integer", "number", "string", "array", "object"];
const SUPPORTED = new Set([
  "type", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "items", "prefixItems", "minItems", "maxItems", "uniqueItems", "contains",
  "properties", "required", "additionalProperties", "patternProperties", "propertyNames", "minProperties", "maxProperties",
  "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "$ref", "$defs",
  "$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly", "format",
]);
const MAX_ERRORS = 20;
const MAX_REF_DEPTH = 64;

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);

export function jsonEq(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => jsonEq(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && jsonEq(a[k], b[k]));
  }
  return a === b;
}

function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case "null": return v === null;
    case "boolean": return typeof v === "boolean";
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "number": return typeof v === "number";
    case "string": return typeof v === "string";
    case "array": return Array.isArray(v);
    case "object": return isObj(v);
  }
  return false;
}

const esc = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : String(x));

export class Schema {
  private constructor(private root: S, private defs: Record<string, S>) {}

  /** Compiles (checks) a schema; throws on what the Rust validator refuses. */
  static compile(v: unknown): Schema {
    if (isObj(v) && v.$schema !== undefined && v.$schema !== "https://json-schema.org/draft/2020-12/schema") throw new Error("$schema must be 2020-12");
    const defs = isObj(v) && isObj(v.$defs) ? (v.$defs as Record<string, S>) : {};
    const check = (s: unknown, at: string, depth: number) => {
      if (depth > 32) throw new Error(`${at}: the schema nests too deeply`);
      if (typeof s === "boolean") return;
      if (!isObj(s)) throw new Error(`${at}: a schema must be an object or a boolean`);
      for (const [k, x] of Object.entries(s)) {
        if (!SUPPORTED.has(k)) throw new Error(`${at}: keyword ${JSON.stringify(k)} is not supported`);
        if (k === "$defs" && depth > 0) throw new Error(`${at}/$defs: only the root may define $defs`);
        if (k === "type") for (const t of Array.isArray(x) ? x : [x]) if (!TYPES.includes(String(t))) throw new Error(`${at}/type: unknown type ${t}`);
        if (k === "pattern") new RegExp(String(x), "u");
        if (k === "$ref" && x !== "#" && !(typeof x === "string" && /^#\/\$defs\/[^/]+$/.test(x) && x.slice(8) in defs)) throw new Error(`${at}/$ref ${JSON.stringify(x)}: only local references`);
        if (["items", "contains", "additionalProperties", "propertyNames", "not", "if", "then", "else"].includes(k)) check(x, `${at}/${k}`, depth + 1);
        if (["prefixItems", "allOf", "anyOf", "oneOf"].includes(k)) (x as unknown[]).forEach((y, i) => check(y, `${at}/${k}/${i}`, depth + 1));
        if (k === "properties" || k === "patternProperties") for (const [n, y] of Object.entries(x as object)) check(y, `${at}/${k}/${n}`, depth + 1);
      }
    };
    for (const [n, d] of Object.entries(defs)) check(d, `/$defs/${n}`, 1);
    check(v, "", 0);
    return new Schema(v as S, defs);
  }

  /** Findings as `[pointer, message]`; empty when valid. */
  validate(v: unknown): [string, string][] {
    const out: [string, string][] = [];
    this.check(this.root, v, "", out, 0);
    return out.slice(0, MAX_ERRORS);
  }

  private ok(s: S, v: unknown, depth: number): boolean {
    const out: [string, string][] = [];
    this.check(s, v, "", out, depth);
    return out.length === 0;
  }

  private check(s: S, v: unknown, at: string, out: [string, string][], depth: number): void {
    if (out.length >= MAX_ERRORS) return;
    if (s === true) return;
    if (s === false) return void out.push([at, "no value is allowed here"]);
    const o = s as Record<string, unknown>;
    if (typeof o.$ref === "string") {
      if (depth >= MAX_REF_DEPTH) return void out.push([at, "$ref nests too deeply"]);
      this.check(o.$ref === "#" ? this.root : this.defs[o.$ref.slice(8)], v, at, out, depth + 1);
    }
    if (o.type !== undefined) {
      const types = (Array.isArray(o.type) ? o.type : [o.type]) as string[];
      if (!types.some((t) => typeOk(t, v))) return void out.push([at, `must be ${types.join(" or ")}`]);
    }
    if (Array.isArray(o.enum) && !o.enum.some((x) => jsonEq(x, v))) out.push([at, "must be one of the allowed values"]);
    if ("const" in o && !jsonEq(o.const, v)) out.push([at, `must be ${JSON.stringify(o.const)}`]);
    if (typeof v === "number") {
      if (typeof o.minimum === "number" && v < o.minimum) out.push([at, `must be at least ${fmt(o.minimum)}`]);
      if (typeof o.maximum === "number" && v > o.maximum) out.push([at, `must be at most ${fmt(o.maximum)}`]);
      if (typeof o.exclusiveMinimum === "number" && v <= o.exclusiveMinimum) out.push([at, `must be more than ${fmt(o.exclusiveMinimum)}`]);
      if (typeof o.exclusiveMaximum === "number" && v >= o.exclusiveMaximum) out.push([at, `must be less than ${fmt(o.exclusiveMaximum)}`]);
      if (typeof o.multipleOf === "number") {
        const q = v / o.multipleOf;
        if (!Number.isFinite(q) || Math.abs(q - Math.round(q)) > 1e-9) out.push([at, `must be a multiple of ${fmt(o.multipleOf)}`]);
      }
    } else if (typeof v === "string") {
      const n = Array.from(v).length;
      if (typeof o.minLength === "number" && n < o.minLength) out.push([at, `must be at least ${o.minLength} characters`]);
      if (typeof o.maxLength === "number" && n > o.maxLength) out.push([at, `must be at most ${o.maxLength} characters`]);
      if (typeof o.pattern === "string" && !new RegExp(o.pattern, "u").test(v)) out.push([at, `must match ${o.pattern}`]);
    } else if (Array.isArray(v)) {
      if (typeof o.minItems === "number" && v.length < o.minItems) out.push([at, `needs at least ${o.minItems} items`]);
      if (typeof o.maxItems === "number" && v.length > o.maxItems) out.push([at, `takes at most ${o.maxItems} items`]);
      if (o.uniqueItems === true && v.some((x, i) => v.slice(i + 1).some((y) => jsonEq(x, y)))) out.push([at, "items must be unique"]);
      const prefix = (o.prefixItems as S[] | undefined) ?? [];
      v.forEach((item, i) => {
        if (i < prefix.length) this.check(prefix[i], item, `${at}/${i}`, out, depth);
        else if (o.items !== undefined) this.check(o.items as S, item, `${at}/${i}`, out, depth);
      });
      if (o.contains !== undefined && !v.some((x) => this.ok(o.contains as S, x, depth))) out.push([at, "contains no matching item"]);
    } else if (isObj(v)) {
      const keys = Object.keys(v).sort();
      if (typeof o.minProperties === "number" && keys.length < o.minProperties) out.push([at, `needs at least ${o.minProperties} properties`]);
      if (typeof o.maxProperties === "number" && keys.length > o.maxProperties) out.push([at, `takes at most ${o.maxProperties} properties`]);
      for (const r of (o.required as string[] | undefined) ?? []) if (!(r in v)) out.push([`${at}/${esc(r)}`, "is required"]);
      const props = (o.properties as Record<string, S> | undefined) ?? {};
      const pats = Object.entries((o.patternProperties as Record<string, S> | undefined) ?? {});
      for (const k of keys) {
        const p = `${at}/${esc(k)}`;
        if (o.propertyNames !== undefined && !this.ok(o.propertyNames as S, k, depth)) out.push([p, "is not an allowed property name"]);
        let matched = false;
        if (Object.prototype.hasOwnProperty.call(props, k)) {
          matched = true;
          this.check(props[k], v[k], p, out, depth);
        }
        for (const [re, s] of pats)
          if (new RegExp(re, "u").test(k)) {
            matched = true;
            this.check(s, v[k], p, out, depth);
          }
        if (!matched && o.additionalProperties !== undefined) {
          if (o.additionalProperties === false) out.push([p, "is not an allowed property"]);
          else this.check(o.additionalProperties as S, v[k], p, out, depth);
        }
      }
    }
    for (const s2 of (o.allOf as S[] | undefined) ?? []) this.check(s2, v, at, out, depth);
    if (Array.isArray(o.anyOf) && !o.anyOf.some((s2) => this.ok(s2 as S, v, depth))) out.push([at, "matches none of anyOf"]);
    if (Array.isArray(o.oneOf)) {
      const n = o.oneOf.filter((s2) => this.ok(s2 as S, v, depth)).length;
      if (n !== 1) out.push([at, `must match exactly one of oneOf (matches ${n})`]);
    }
    if (o.not !== undefined && this.ok(o.not as S, v, depth)) out.push([at, "matches a schema it must not match"]);
    if (o.if !== undefined) {
      const branch = this.ok(o.if as S, v, depth) ? o.then : o.else;
      if (branch !== undefined) this.check(branch as S, v, at, out, depth);
    }
  }
}
