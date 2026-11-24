// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Declarative export templates for SDK blocks (BSDK-02, docs/15 §4.2): the same logic-less
// Mustache subset and fixed filters as `oc_model::ext::template` in Rust. Templates are data:
// no partials, lambdas, delimiter changes or unescaped output, so rendering one never runs
// code. `crates/oc-model/tests/fixtures/ext.json` holds cases both engines must render
// identically (template.test.ts and the Rust test `ext_fixtures`).

export const MAX_SOURCE = 4 * 1024;
export const MAX_OUTPUT = 64 * 1024;
const MAX_NEST = 8;
const MAX_ITERATIONS = 1000;

export const FILTERS = ["percent", "number", "date", "upper", "lower", "trim", "truncate", "default", "join", "count", "yesno"] as const;

export type Target = "markdown" | "text";
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface Filter {
  name: string;
  arg: string | null;
}
type Part = { t: "text"; s: string } | { t: "var"; name: string; filters: Filter[] } | { t: "section"; name: string; inverted: boolean; body: Part[] };

export interface Template {
  parts: Part[];
}

const validName = (n: string) => n === "." || (n.length > 0 && n.split(".").every((s) => /^[A-Za-z0-9_-]+$/.test(s)));

function parseFilter(src: string): Filter {
  const i = src.indexOf(":");
  const name = (i < 0 ? src : src.slice(0, i)).trim();
  const raw = i < 0 ? null : src.slice(i + 1).trim();
  if (!(FILTERS as readonly string[]).includes(name)) throw new Error(`unknown filter ${JSON.stringify(name)}`);
  let arg: string | null = null;
  if (raw !== null) {
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) arg = raw.slice(1, -1);
    else if (raw.length > 0 && !/["{}|]/.test(raw)) arg = raw;
    else throw new Error(`bad argument ${JSON.stringify(raw)} for ${name}`);
  }
  if (name === "truncate" && !(arg !== null && /^\d+$/.test(arg))) throw new Error("truncate needs a length (truncate:40)");
  if ((name === "percent" || name === "number") && arg !== null && !(/^\d+$/.test(arg) && Number(arg) <= 6)) throw new Error(`${name} takes a number of digits 0-6`);
  return { name, arg };
}

export function parseTemplate(src: string): Template {
  if (new TextEncoder().encode(src).length > MAX_SOURCE) throw new Error(`a template is at most ${MAX_SOURCE} bytes`);
  const stack: { name: string; inverted: boolean; outer: Part[] }[] = [];
  let parts: Part[] = [];
  let rest = src;
  for (;;) {
    const open = rest.indexOf("{{");
    if (open < 0) break;
    if (open > 0) parts.push({ t: "text", s: rest.slice(0, open) });
    const after = rest.slice(open + 2);
    const close = after.indexOf("}}");
    if (close < 0) throw new Error("a tag is not closed with }}");
    const tag = after.slice(0, close).trim();
    rest = after.slice(close + 2);
    const c = tag[0];
    const sigil = c && "#^/!{&>=<$".includes(c) ? c : null;
    const body = sigil ? tag.slice(1).trim() : tag;
    if (sigil === "!") continue;
    if (sigil === "#" || sigil === "^") {
      if (!validName(body)) throw new Error(`bad section name ${JSON.stringify(body)}`);
      if (stack.length >= MAX_NEST) throw new Error(`sections nest more than ${MAX_NEST} levels`);
      stack.push({ name: body, inverted: sigil === "^", outer: parts });
      parts = [];
    } else if (sigil === "/") {
      const top = stack.pop();
      if (!top) throw new Error(`{{/${body}}} closes nothing`);
      if (top.name !== body) throw new Error(`{{/${body}}} closes {{#${top.name}}}`);
      const inner = parts;
      parts = top.outer;
      parts.push({ t: "section", name: top.name, inverted: top.inverted, body: inner });
    } else if (sigil) {
      throw new Error(`{{${sigil}…}} is not supported: templates have no partials, raw output or delimiter changes`);
    } else {
      const [name0, ...fs] = body.split("|");
      const name = (name0 ?? "").trim();
      if (!validName(name)) throw new Error(`bad name ${JSON.stringify(name)}`);
      parts.push({ t: "var", name, filters: fs.map(parseFilter) });
    }
  }
  if (rest.length) parts.push({ t: "text", s: rest });
  if (stack.length) throw new Error(`{{#${stack[stack.length - 1].name}}} is not closed`);
  return { parts };
}

function lookup(stack: Json[], name: string): Json | undefined {
  if (name === ".") return stack[stack.length - 1];
  const [first, ...segs] = name.split(".");
  let v: Json | undefined;
  for (let i = stack.length - 1; i >= 0; i--) {
    const c = stack[i];
    if (c && typeof c === "object" && !Array.isArray(c) && Object.prototype.hasOwnProperty.call(c, first)) {
      v = c[first];
      break;
    }
  }
  if (v === undefined) return undefined;
  for (const s of segs) {
    if (Array.isArray(v)) {
      if (!/^\d+$/.test(s)) return undefined;
      v = v[Number(s)];
    } else if (v && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, s)) v = v[s];
    else return undefined;
    if (v === undefined) return undefined;
  }
  return v;
}

function truthy(v: Json | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "number") return v !== 0;
  return true;
}

/** As Rust's `number_text`: no trailing `.0`, at most 6 decimals with trailing zeros dropped. */
export function numberText(x: number): string {
  if (!Number.isFinite(x)) return "";
  if (Number.isInteger(x) && Math.abs(x) < 1e15) return String(x);
  const s = x.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

function fixed(x: number, digits: number): string {
  const s = x.toFixed(digits);
  return /^-[0.]+$/.test(s) ? s.slice(1) : s;
}

const scalar = (x: Json) => x !== null && typeof x !== "object";

export function valueText(v: Json | undefined): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return numberText(v);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.filter(scalar).map(valueText).join(", ");
  return "";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** As Rust's `export::date_text`: `Dec 4, 2026` for a valid ISO date, else "". */
export function dateText(d: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return "";
  const m = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  if (m < 1 || m > 12 || day < 1 || day > 31) return "";
  return `${MONTHS[m - 1]} ${day}, ${d.slice(0, 4)}`;
}

function apply(v: Json | undefined, f: Filter): Json {
  const arg = f.arg;
  const num = typeof v === "number" ? v : null;
  switch (f.name) {
    case "percent":
      return num === null ? "" : `${fixed(num * 100, arg === null ? 0 : Number(arg))}%`;
    case "number":
      return num === null ? "" : arg === null ? numberText(num) : fixed(num, Number(arg));
    case "date":
      return dateText(typeof v === "string" ? v : "");
    case "upper":
      return valueText(v).toUpperCase();
    case "lower":
      return valueText(v).toLowerCase();
    case "trim":
      return valueText(v).trim();
    case "truncate": {
      const n = Number(arg ?? 0);
      const chars = Array.from(valueText(v));
      return chars.length > n ? chars.slice(0, n).join("") + "…" : chars.join("");
    }
    case "default":
      return valueText(v) === "" ? (arg ?? "") : (v ?? null);
    case "join":
      return Array.isArray(v) ? v.filter(scalar).map(valueText).join(arg ?? ", ") : valueText(v);
    case "count":
      return Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : typeof v === "string" ? Array.from(v).length : 0;
    case "yesno": {
      const i = arg ? arg.indexOf(",") : -1;
      const [yes, no] = arg && i >= 0 ? [arg.slice(0, i), arg.slice(i + 1)] : ["yes", "no"];
      return truthy(v) ? yes : no;
    }
  }
  return v ?? null;
}

/** Escapes text for Markdown (as Rust's `md_escape`): no link, image, HTML, emphasis, table or
 *  block can start inside a value, and a value stays on one line. */
export function mdEscape(t: string): string {
  let out = "";
  for (const c of t) {
    if ("\\`*_[]<>|~!#".includes(c)) out += "\\" + c;
    else if (c === "\n" || c === "\r" || c === "\t") out += " ";
    else if (/[\u0000-\u001f\u007f-\u009f]/.test(c)) continue;
    else out += c;
  }
  return out;
}

export function renderTemplate(t: Template, ctx: Json, target: Target): string {
  let out = "";
  let iterations = 0;
  const push = (s: string) => {
    if (out.length <= MAX_OUTPUT) out += s;
  };
  const walk = (parts: Part[], stack: Json[]): boolean => {
    for (const p of parts) {
      if (out.length > MAX_OUTPUT) return false;
      if (p.t === "text") push(p.s);
      else if (p.t === "var") {
        let v: Json | undefined = lookup(stack, p.name) ?? null;
        for (const f of p.filters) v = apply(v, f);
        const text = valueText(v);
        push(target === "markdown" ? mdEscape(text) : text);
      } else {
        const v = lookup(stack, p.name);
        if (p.inverted) {
          if (!truthy(v) && !walk(p.body, stack)) return false;
          continue;
        }
        if (!truthy(v)) continue;
        if (Array.isArray(v)) {
          for (const item of v) {
            if (++iterations > MAX_ITERATIONS) return false;
            if (!walk(p.body, [...stack, item])) return false;
          }
        } else if (v && typeof v === "object") {
          if (!walk(p.body, [...stack, v])) return false;
        } else if (!walk(p.body, stack)) return false;
      }
    }
    return true;
  };
  walk(t.parts, [ctx]);
  return out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) : out;
}
