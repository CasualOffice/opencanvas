#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Generates src/generated.ts (types, the operation table and one typed method per operation)
// from the OpenAPI document crates/oc-server/api/openapi.json (HAPI-06). A small generator on
// purpose: the document uses a narrow JSON Schema subset ($ref, type and type lists, enum,
// properties/required, items, additionalProperties), and anything else becomes `unknown`.
//
//   node scripts/gen.mjs           write src/generated.ts
//   node scripts/gen.mjs --check   exit 1 when src/generated.ts is not what the document gives
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = join(here, "../../../../crates/oc-server/api/openapi.json");
const OUT = join(here, "../src/generated.ts");

const ident = (s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
const key = (s) => (ident(s) ? s : JSON.stringify(s));
const doc = (text, indent) =>
  text ? `${indent}/** ${String(text).replace(/\*\//g, "*\\/").replace(/\s*\n\s*/g, " ")} */\n` : "";

/** A TypeScript type for a JSON Schema. */
function tsType(s, indent = "") {
  if (!s || typeof s !== "object") return "unknown";
  if (s.$ref) return s.$ref.split("/").pop();
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (types.length === 0) return "unknown";
  return types.map((t) => one(t, s, indent)).join(" | ");
}

function one(t, s, indent) {
  switch (t) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${tsType(s.items, indent)}>`;
    case "object": {
      const props = s.properties ?? {};
      const names = Object.keys(props);
      if (names.length === 0) return "Record<string, unknown>";
      const req = new Set(s.required ?? []);
      const inner = indent + "  ";
      let out = "{\n";
      for (const n of names) {
        out += doc(props[n].description, inner);
        out += `${inner}${key(n)}${req.has(n) ? "" : "?"}: ${tsType(props[n], inner)};\n`;
      }
      if (s.additionalProperties === true) out += `${inner}[key: string]: unknown;\n`;
      return out + `${indent}}`;
    }
    default:
      return "unknown";
  }
}

function resolve(spec, x) {
  while (x && x.$ref && x.$ref.startsWith("#/components/parameters/")) {
    x = spec.components.parameters[x.$ref.split("/").pop()];
  }
  return x;
}

/** The operations the client exposes: every `/api/v1` operation (not the 0.1 aliases). */
function operations(spec) {
  const out = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    if (!path.startsWith("/api/v1/")) continue;
    for (const [method, op] of Object.entries(item)) {
      if (method === "parameters") continue;
      const params = (op.parameters ?? []).map((p) => resolve(spec, p));
      const pathParams = params.filter((p) => p.in === "path");
      const query = params.filter((p) => p.in === "query");
      const reqContent = op.requestBody?.content ?? {};
      const body = reqContent["application/json"]
        ? "json"
        : reqContent["application/octet-stream"]
          ? "binary"
          : null;
      const okCode = Object.keys(op.responses ?? {}).find((c) => /^2\d\d$/.test(c));
      const ok = op.responses?.[okCode]?.content ?? {};
      const response = ok["application/json"] ? "json" : ok["text/event-stream"] ? "stream" : "binary";
      let resSchema = ok["application/json"]?.schema;
      if (resSchema?.$ref) resSchema = spec.components.schemas[resSchema.$ref.split("/").pop()];
      // A paged operation takes `cursor` and answers `next_cursor` beside one array of items.
      let paged = null;
      if (query.some((q) => q.name === "cursor") && resSchema?.properties?.next_cursor) {
        const items = Object.entries(resSchema.properties).find(
          ([, v]) => v.type === "array" || (Array.isArray(v.type) && v.type.includes("array")),
        );
        if (items) paged = items[0];
      }
      out.push({
        id: op.operationId,
        method: method.toUpperCase(),
        path,
        summary: op.summary,
        scope: op["x-opencanvas-scope"] ?? null,
        pathParams,
        query,
        body,
        bodySchema: reqContent["application/json"]?.schema ?? null,
        bodyRequired: !!op.requestBody?.required,
        response,
        responseSchema: ok["application/json"]?.schema ?? null,
        paged,
        // Writes are the POST/DELETE operations under /files (they take Idempotency-Key).
        idempotent: params.some((p) => p.name === "Idempotency-Key"),
      });
    }
  }
  return out;
}

export function generate(spec) {
  const ops = operations(spec);
  let s = `// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// GENERATED by scripts/gen.mjs from crates/oc-server/api/openapi.json. Do not edit; run
// \`node scripts/gen.mjs\` after changing the document (CI runs it with --check).
/* eslint-disable */
import type { ApiResponse, BinaryBody, CallOptions } from "./types.js";

/** The OpenAPI document version these types come from. */
export const API_VERSION = ${JSON.stringify(spec.info.version)};

`;
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    s += doc(schema.description, "");
    const t = tsType(schema, "");
    s += t.startsWith("{") ? `export interface ${name} ${t}\n\n` : `export type ${name} = ${t};\n\n`;
  }
  s += `/** Path parameters, query, body and answer of every operation. */\nexport interface Operations {\n`;
  for (const o of ops) {
    s += doc(`${o.method} ${o.path}${o.summary ? `: ${o.summary}` : ""}`, "  ");
    s += `  ${o.id}: {\n    path: {`;
    s += o.pathParams.map((p) => ` ${key(p.name)}: string;`).join("");
    s += o.pathParams.length ? " };\n" : "};\n";
    s += `    query: {`;
    if (o.query.length) {
      s += "\n";
      for (const q of o.query) {
        s += doc(q.description, "      ");
        s += `      ${key(q.name)}${q.required ? "" : "?"}: ${tsType(q.schema, "      ")};\n`;
      }
      s += "    };\n";
    } else s += "};\n";
    const body =
      o.body === "json" ? tsType(o.bodySchema, "    ") : o.body === "binary" ? "BinaryBody" : "never";
    s += `    body: ${body};\n`;
    const res =
      o.response === "json" ? tsType(o.responseSchema, "    ") : o.response === "binary" ? "Uint8Array" : "never";
    s += `    response: ${res};\n  };\n`;
  }
  s += `}

export type OperationId = keyof Operations;

/** How the client sends one operation. */
export interface OperationInfo {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** The least scope a user token needs (\`x-opencanvas-scope\`); null when none. */
  scope: string | null;
  pathParams: readonly string[];
  query: readonly string[];
  body: "json" | "binary" | null;
  response: "json" | "binary" | "stream";
  /** Paged operations: the array the items come in. */
  paged: string | null;
  /** Takes Idempotency-Key (the client sends one on every call). */
  idempotent: boolean;
}

export const operations: { readonly [K in OperationId]: OperationInfo } = {
`;
  for (const o of ops) {
    const info = {
      method: o.method,
      path: o.path,
      scope: o.scope,
      pathParams: o.pathParams.map((p) => p.name),
      query: o.query.map((q) => q.name),
      body: o.body,
      response: o.response,
      paged: o.paged,
      idempotent: o.idempotent,
    };
    s += `  ${o.id}: ${JSON.stringify(info).replace(/,"/g, ', "').replace(/":/g, '": ')},\n`;
  }
  s += `};

/** The arguments of an operation: its path parameters, plus \`query\` and \`body\` when it has them. */
export type Params<K extends OperationId> = Operations[K]["path"] &
  ({} extends Operations[K]["query"] ? { query?: Operations[K]["query"] } : { query: Operations[K]["query"] }) &
  ([Operations[K]["body"]] extends [never] ? { body?: never } : { body: Operations[K]["body"] });

/** The operations whose answers are pages (\`next_cursor\`). */
export type PagedOperationId = ${ops.filter((o) => o.paged).map((o) => JSON.stringify(o.id)).join(" | ") || "never"};

/** One typed method per operation (the events stream has its own helper). */
export abstract class GeneratedApi {
  abstract call<K extends OperationId>(
    op: K,
    params: Params<K>,
    options?: CallOptions,
  ): Promise<ApiResponse<Operations[K]["response"]>>;
`;
  for (const o of ops) {
    if (o.response === "stream") continue;
    const optional = o.pathParams.length === 0 && !o.body && !o.query.some((q) => q.required);
    s += `\n${doc(`${o.summary ?? o.id} (\`${o.method} ${o.path}\`${o.scope ? `, ${o.scope}` : ""}).`, "  ")}`;
    s += `  async ${o.id}(params${optional ? "?" : ""}: Params<${JSON.stringify(o.id)}>, options?: CallOptions): Promise<Operations[${JSON.stringify(o.id)}]["response"]> {\n`;
    s += `    return (await this.call(${JSON.stringify(o.id)}, ${optional ? `(params ?? {}) as Params<${JSON.stringify(o.id)}>` : "params"}, options)).data;\n  }\n`;
  }
  s += "}\n";
  return s;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const out = generate(JSON.parse(readFileSync(SPEC, "utf8")));
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(OUT, "utf8");
    } catch {}
    if (current !== out) {
      console.error("client: src/generated.ts is out of date with openapi.json; run `node web/packages/client/scripts/gen.mjs`");
      process.exit(1);
    }
    console.log("client: src/generated.ts matches openapi.json");
  } else {
    writeFileSync(OUT, out);
    console.log(`client: wrote ${OUT}`);
  }
}
