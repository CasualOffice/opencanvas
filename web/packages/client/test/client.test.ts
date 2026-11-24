// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Unit tests of the client core against a scripted fetch: no server, no timers (the retry
// clock is injected).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ApiError,
  CursorExpiredError,
  IdempotencyInProgressError,
  NetworkError,
  OpenCanvas,
  RateLimitedError,
  StaleBlockError,
  StreamClosedError,
  operations,
  parseFrames,
  parseRateLimit,
  toApiError,
} from "../src/index.js";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

type Answer = Response | Error | (() => Response);

/** A fetch that answers from a script and records requests. */
function scripted(answers: Answer[]) {
  const seen: Seen[] = [];
  const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const a = answers.shift();
    if (!a) throw new Error("no scripted answer left");
    if (a instanceof Error) throw a;
    return typeof a === "function" ? a() : a;
  };
  return { fetch: f as typeof fetch, seen };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const problem = (status: number, code: string, headers: Record<string, string> = {}, extra: object = {}) =>
  new Response(JSON.stringify({ type: `urn:opencanvas:problem:${code.toLowerCase()}`, title: "t", status, code, detail: "d", ...extra }), {
    status,
    headers: { "content-type": "application/problem+json", ...headers },
  });

function client(answers: Answer[], extra: Partial<ConstructorParameters<typeof OpenCanvas>[0]> = {}) {
  const s = scripted(answers);
  const slept: number[] = [];
  let keys = 0;
  const oc = new OpenCanvas({
    baseUrl: "https://oc.example/",
    auth: { hostId: "acme", key: "k1", author: "u_7" },
    fetch: s.fetch,
    sleep: async (ms) => {
      slept.push(ms);
    },
    idempotencyKey: () => `key-${++keys}`,
    ...extra,
  });
  return { oc, seen: s.seen, slept };
}

describe("requests", () => {
  it("builds URLs from the operation table and sends host-key headers", async () => {
    const { oc, seen } = client([json(200, { rev: "r1" }, { etag: '"r1"', ratelimit: '"subject";r=29;t=1' })]);
    const res = await oc.call("readFile", { fileId: "a b/c", query: { format: "markdown" } });
    expect(seen[0].url).toBe("https://oc.example/api/v1/files/a%20b%2Fc?format=markdown");
    expect(seen[0].method).toBe("GET");
    expect(seen[0].headers["x-opencanvas-host"]).toBe("acme");
    expect(seen[0].headers["x-opencanvas-key"]).toBe("k1");
    expect(seen[0].headers["x-opencanvas-author"]).toBe("u_7");
    expect(seen[0].headers["idempotency-key"]).toBeUndefined();
    expect(res.etag).toBe("r1");
    expect(res.replayed).toBe(false);
    expect(res.rateLimit).toEqual({ policy: "subject", remaining: 29, resetSecs: 1 });
  });

  it("calls a token function before every request", async () => {
    let n = 0;
    const s = scripted([json(200, {}), json(200, {})]);
    const oc = new OpenCanvas({ baseUrl: "https://oc.example", auth: { token: async () => `t${++n}` }, fetch: s.fetch });
    await oc.listDatabases({ fileId: "f" });
    await oc.listDatabases({ fileId: "f" });
    expect(s.seen.map((r) => r.headers.authorization)).toEqual(["Bearer t1", "Bearer t2"]);
  });

  it("joins list query values and JSON-encodes object values", async () => {
    const { oc, seen } = client([json(200, { rows: [] })]);
    await oc.call("queryRows", { fileId: "f", dbId: "d", query: { filter: [{ f: "Status", op: "eq", v: "Done" }] as never, fields: "a,b" } });
    const u = new URL(seen[0].url);
    expect(JSON.parse(u.searchParams.get("filter")!)).toEqual([{ f: "Status", op: "eq", v: "Done" }]);
    expect(u.searchParams.get("fields")).toBe("a,b");
  });

  it("sends a generated Idempotency-Key on writes, the same one on every retry", async () => {
    const { oc, seen, slept } = client([problem(503, "UNAVAILABLE", { "retry-after": "2" }), json(200, { applied: 1 })]);
    const res = await oc.call("batchBlocks", { fileId: "f", body: { ops: [{ op: "append", markdown: "x" }] } }, { ifMatch: "r9" });
    expect(seen).toHaveLength(2);
    expect(seen[0].headers["idempotency-key"]).toBe("key-1");
    expect(seen[1].headers["idempotency-key"]).toBe("key-1");
    expect(seen[0].headers["if-match"]).toBe('"r9"');
    expect(JSON.parse(seen[0].body!)).toEqual({ ops: [{ op: "append", markdown: "x" }] });
    expect(slept).toEqual([2000]);
    expect(res.idempotencyKey).toBe("key-1");
  });

  it("takes an explicit key, or none", async () => {
    const { oc, seen } = client([json(200, {}, { "idempotency-replayed": "true" }), json(200, {})]);
    const r = await oc.call("addComment", { fileId: "f", body: { text: "hi" } }, { idempotencyKey: "mine" });
    expect(r.replayed).toBe(true);
    await oc.call("addComment", { fileId: "f", body: { text: "hi" } }, { idempotencyKey: false });
    expect(seen[0].headers["idempotency-key"]).toBe("mine");
    expect(seen[1].headers["idempotency-key"]).toBeUndefined();
  });

  it("retries 429 after Retry-After, then gives up with a typed error", async () => {
    const { oc, slept } = client([
      problem(429, "RATE_LIMITED", { "retry-after": "1" }),
      problem(429, "RATE_LIMITED", { "retry-after": "3" }),
      problem(429, "RATE_LIMITED", { "retry-after": "1" }),
    ]);
    const err = await oc.call("readFile", { fileId: "f" }, { maxRetries: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterSecs).toBe(1);
    expect(slept).toEqual([1000, 3000]);
  });

  it("backs off exponentially without Retry-After, capped", async () => {
    const { oc, slept } = client(
      [problem(503, "UNAVAILABLE"), problem(503, "UNAVAILABLE"), problem(503, "UNAVAILABLE"), json(200, {})],
      { retryBaseMs: 100, retryMaxMs: 300 },
    );
    await oc.readFile({ fileId: "f" });
    expect(slept).toEqual([100, 200, 300]);
  });

  it("retries 409 IDEMPOTENCY_IN_PROGRESS with the same key", async () => {
    const { oc, seen } = client([problem(409, "IDEMPOTENCY_IN_PROGRESS", { "retry-after": "1" }), json(200, { applied: 1 })]);
    await oc.batchBlocks({ fileId: "f", body: { ops: [{ op: "append", markdown: "x" }] } });
    expect(seen.map((s) => s.headers["idempotency-key"])).toEqual(["key-1", "key-1"]);
  });

  it("retries a network error for reads and keyed writes, never for an unkeyed write", async () => {
    const a = client([new TypeError("socket hang up"), json(200, {})]);
    await a.oc.readFile({ fileId: "f" });
    expect(a.seen).toHaveLength(2);
    const b = client([new TypeError("socket hang up"), json(200, {})]);
    const err = await b.oc
      .call("batchBlocks", { fileId: "f", body: { ops: [{ op: "append" }] } }, { idempotencyKey: false })
      .catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(b.seen).toHaveLength(1);
    // A 503 on an unkeyed write is not retried either: it may have run.
    const c = client([problem(503, "UNAVAILABLE"), json(200, {})]);
    const e2 = await c.oc
      .call("batchBlocks", { fileId: "f", body: { ops: [{ op: "append" }] } }, { idempotencyKey: false })
      .catch((e) => e);
    expect(e2.kind).toBe("Unavailable");
    expect(c.seen).toHaveLength(1);
  });

  it("refuses a call without its path parameters", async () => {
    const { oc } = client([]);
    await expect(oc.call("readFile", { fileId: "" })).rejects.toThrow(/fileId is required/);
  });
});

describe("errors", () => {
  it("maps problems to typed exceptions by code, then status", () => {
    const h = new Headers();
    const stale = toApiError(412, { type: "x", title: "t", status: 412, code: "STALE_BLOCK", fresh: { rev: "r2" } }, h);
    expect(stale).toBeInstanceOf(StaleBlockError);
    expect((stale as StaleBlockError).fresh).toEqual({ rev: "r2" });
    expect(toApiError(410, { code: "CURSOR_EXPIRED" }, h)).toBeInstanceOf(CursorExpiredError);
    expect(toApiError(409, { code: "IDEMPOTENCY_IN_PROGRESS" }, h)).toBeInstanceOf(IdempotencyInProgressError);
    expect(toApiError(404, { code: "BLOCK_NOT_FOUND" }, h).kind).toBe("NotFound");
    expect(toApiError(403, { code: "ROLE_FORBIDDEN" }, h).kind).toBe("Forbidden");
    expect(toApiError(500, { code: "INTERNAL" }, h).kind).toBe("Server");
    const html = toApiError(502, "<html>bad gateway</html>", h);
    expect(html).toBeInstanceOf(ApiError);
    expect(html.code).toBe("HTTP_502");
    expect(html.kind).toBe("Server");
  });

  it("parses RateLimit headers", () => {
    expect(parseRateLimit('"file-writes";r=0;t=2')).toEqual({ policy: "file-writes", remaining: 0, resetSecs: 2 });
    expect(parseRateLimit(null)).toBeUndefined();
    expect(parseRateLimit("garbage")).toBeUndefined();
  });
});

describe("paging", () => {
  it("follows next_cursor until it is null", async () => {
    const { oc, seen } = client([
      json(200, { blocks: [{ blockId: "a" }, { blockId: "b" }], has_more: true, next_cursor: "c1" }),
      json(200, { blocks: [{ blockId: "c" }], has_more: false, next_cursor: null }),
    ]);
    const ids: string[] = [];
    for await (const b of oc.paginate("listBlocks", { fileId: "f", query: { limit: 2 } })) ids.push((b as { blockId: string }).blockId);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(new URL(seen[1].url).searchParams.get("cursor")).toBe("c1");
    expect(new URL(seen[1].url).searchParams.get("limit")).toBe("2");
    expect(operations.queryRows.paged).toBe("rows");
  });
});

/** A streaming SSE answer from text chunks. */
function sse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const ev = (id: string, type = "edited") =>
  `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ id, type, fileId: "f", at: 1, data: {} })}\n\n`;

describe("events", () => {
  it("parses frames split across chunks, CRLF and comments", () => {
    const { frames, rest } = parseFrames(": keep-alive\r\n\r\nid: 1\r\nevent: saved\r\ndata: {\"a\":1}\r\n\r\nid: 2\nda");
    expect(frames).toEqual([{ id: "1", event: "saved", data: '{"a":1}' }]);
    expect(rest).toBe("id: 2\nda");
  });

  it("resumes with Last-Event-ID after the stream drops, and reconnects after 4008", async () => {
    const { oc, seen, slept } = client([
      sse([ev("ev_1").slice(0, 10), ev("ev_1").slice(10), ": ping\n\n"]),
      sse([ev("ev_2"), 'event: close\ndata: {"code":4008,"reason":"lagged"}\n\n']),
      sse([ev("ev_3", "saved")]),
    ]);
    const s = oc.events({ fileId: "f", types: ["edited", "saved"], lastEventId: "ev_0", maxReconnects: 2 });
    const got: string[] = [];
    for await (const e of s) {
      got.push(e.id);
      if (got.length === 3) break;
    }
    expect(got).toEqual(["ev_1", "ev_2", "ev_3"]);
    expect(seen.map((r) => r.headers["last-event-id"])).toEqual(["ev_0", "ev_1", "ev_2"]);
    expect(new URL(seen[0].url).searchParams.get("types")).toBe("edited,saved");
    expect(seen[0].headers.accept).toBe("text/event-stream");
    expect(slept).toEqual([1000]);
    expect(s.lastEventId).toBe("ev_3");
  });

  it("ends with StreamClosedError on 4001 and 4003", async () => {
    const { oc } = client([sse([ev("ev_1"), 'event: close\ndata: {"code":4003,"reason":"revoked"}\n\n'])]);
    const s = oc.events({ fileId: "f" });
    expect((await s.next()).value.id).toBe("ev_1");
    const err = await s.next().catch((e) => e);
    expect(err).toBeInstanceOf(StreamClosedError);
    expect(err.code).toBe(4003);
    expect((await s.next()).done).toBe(true);
  });

  it("stops after maxReconnects drops without an event", async () => {
    const { oc, slept } = client([sse([]), sse([]), sse([])]);
    const s = oc.events({ fileId: "f", maxReconnects: 2 });
    expect((await s.next()).done).toBe(true);
    expect(slept).toEqual([1000, 2000]);
  });

  it("raises a problem when the stream is refused", async () => {
    const { oc } = client([problem(403, "SCOPE_REQUIRED")]);
    const err = await oc.events({ fileId: "f" }).next().catch((e) => e);
    expect(err.kind).toBe("Forbidden");
  });
});

describe("package", () => {
  it("has no runtime dependencies", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.engines.node).toBe(">=20");
  });

  it("uses web platform APIs only (runs in browsers, Node 20+, Deno, edge)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const f of ["client.ts", "errors.ts", "events.ts", "webhooks.ts", "types.ts", "index.ts", "generated.ts"]) {
      const src = readFileSync(join(here, "../src", f), "utf8");
      expect(src, f).not.toMatch(/from "node:|require\(|process\.|Buffer\b/);
    }
  });
});
