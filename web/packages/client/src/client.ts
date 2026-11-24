// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The hand-written core of @opencanvas/client (HAPI-06): credentials, Idempotency-Key on
// writes, RateLimit-aware retries, RFC 9457 errors, cursor paging and the events stream. The
// operation methods and types are generated from the OpenAPI document (generated.ts).

import { ApiError, NetworkError, toApiError } from "./errors.js";
import { EventStream, type EventsOptions } from "./events.js";
import {
  GeneratedApi,
  operations,
  type OperationId,
  type Operations,
  type PagedOperationId,
  type Params,
} from "./generated.js";
import type { ApiResponse, BinaryBody, CallOptions, RateLimitInfo } from "./types.js";

/** Server-to-server: the host key (full access to the host's files). */
export interface HostKeyAuth {
  hostId: string;
  key: string;
  /** `X-OpenCanvas-Author`: the user changes are attributed to (default `svc:<hostId>`). */
  author?: string;
  /** `X-OpenCanvas-Callback-Token`: the bearer OpenCanvas passes on your callbacks. */
  callbackToken?: string;
}

/** A user-scoped token your host minted (docs/05 §7b). A function is called before every
 * request, so it can refresh a token that is about to expire. */
export interface TokenAuth {
  token: string | (() => string | Promise<string>);
}

export interface ClientOptions {
  /** The OpenCanvas server, e.g. `https://canvas.example.com`. */
  baseUrl: string;
  auth?: HostKeyAuth | TokenAuth;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** How the client waits between retries; inject a fake clock in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Retries of a 429, a 503, a 409 `IDEMPOTENCY_IN_PROGRESS` or a network error; default 3. */
  maxRetries?: number;
  /** Backoff without `Retry-After`: base doubled per attempt (default 500 ms), capped (30 s). */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Makes Idempotency-Key values; default `crypto.randomUUID()`. */
  idempotencyKey?: () => string;
  /** Headers sent on every request. */
  headers?: Record<string, string>;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parses `RateLimit: "subject";r=29;t=1` (the tightest bucket). */
export function parseRateLimit(v: string | null): RateLimitInfo | undefined {
  if (!v) return undefined;
  const m = /^\s*"?([^";]+)"?\s*;(.*)$/.exec(v);
  if (!m) return undefined;
  const params = new Map(
    m[2].split(";").map((p) => {
      const [k, x] = p.split("=");
      return [k.trim(), Number(x)] as const;
    }),
  );
  const r = params.get("r");
  const t = params.get("t");
  if (r === undefined || t === undefined || !Number.isFinite(r) || !Number.isFinite(t)) return undefined;
  return { policy: m[1], remaining: r, resetSecs: t };
}

function unquote(etag: string | null): string | undefined {
  if (!etag) return undefined;
  return etag.replace(/^W\//, "").replace(/^"|"$/g, "");
}

function queryValue(v: unknown): string {
  if (Array.isArray(v)) return v.every((x) => typeof x !== "object") ? v.join(",") : JSON.stringify(v);
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function isRetriable(err: ApiError): boolean {
  return err.status === 429 || err.status === 503 || err.code === "IDEMPOTENCY_IN_PROGRESS";
}

/** The OpenCanvas headless API client. */
export class OpenCanvas extends GeneratedApi {
  readonly baseUrl: string;
  private readonly opts: ClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ClientOptions) {
    super();
    this.opts = opts;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error("@opencanvas/client needs fetch (Node 20+, a browser, or pass `fetch`)");
    this.fetchImpl = f.bind(globalThis);
    this.sleep = opts.sleep ?? sleepReal;
  }

  /** The URL of an operation with its path parameters and query. */
  url<K extends OperationId>(op: K, params: Params<K>): string {
    const info = operations[op];
    const p = params as Record<string, unknown>;
    let path = info.path;
    for (const name of info.pathParams) {
      const v = p[name];
      if (v === undefined || v === null || v === "") throw new TypeError(`${op}: ${name} is required`);
      path = path.replace(`{${name}}`, encodeURIComponent(String(v)));
    }
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries((p.query ?? {}) as Record<string, unknown>)) {
      if (v !== undefined && v !== null) q.append(k, queryValue(v));
    }
    const qs = q.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const a = this.opts.auth;
    if (!a) return {};
    if ("token" in a) {
      const t = typeof a.token === "function" ? await a.token() : a.token;
      return { authorization: `Bearer ${t}` };
    }
    const h: Record<string, string> = { "x-opencanvas-host": a.hostId, "x-opencanvas-key": a.key };
    if (a.author) h["x-opencanvas-author"] = a.author;
    if (a.callbackToken) h["x-opencanvas-callback-token"] = a.callbackToken;
    return h;
  }

  private backoff(attempt: number): number {
    const base = this.opts.retryBaseMs ?? 500;
    return Math.min(this.opts.retryMaxMs ?? 30_000, base * 2 ** attempt);
  }

  /**
   * Sends one operation and answers the body with what the headers say (ETag, replay, rate
   * limit). Throws an {@link ApiError} subclass for an error answer, after retrying the
   * retriable ones.
   */
  async call<K extends OperationId>(
    op: K,
    params: Params<K>,
    options: CallOptions = {},
  ): Promise<ApiResponse<Operations[K]["response"]>> {
    const info = operations[op];
    if (!info) throw new TypeError(`unknown operation ${String(op)}`);
    const url = this.url(op, params);
    const headers: Record<string, string> = { accept: "application/json, application/problem+json", ...this.opts.headers };
    let body: BodyInit | undefined;
    const raw = (params as { body?: unknown }).body;
    if (info.body === "json") {
      headers["content-type"] = "application/json";
      body = JSON.stringify(raw ?? {});
    } else if (info.body === "binary" && raw !== undefined) {
      headers["content-type"] = "application/octet-stream";
      body = raw as BinaryBody as BodyInit;
    }
    let key: string | undefined;
    if (info.idempotent && options.idempotencyKey !== false) {
      key = options.idempotencyKey || (this.opts.idempotencyKey ?? (() => crypto.randomUUID()))();
      headers["idempotency-key"] = key;
    }
    if (options.ifMatch !== undefined) headers["if-match"] = `"${options.ifMatch.replace(/^"|"$/g, "")}"`;
    Object.assign(headers, options.headers);
    // A write without a key may have run when the answer is lost: never resend it.
    const safe = info.method === "GET" || key !== undefined;
    const max = options.maxRetries ?? this.opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: info.method,
          headers: { ...headers, ...(await this.authHeaders()) },
          body,
          signal: options.signal,
        });
      } catch (e) {
        if (options.signal?.aborted || !safe || attempt >= max) {
          throw new NetworkError(`${info.method} ${url}: ${(e as Error)?.message ?? e}`, { cause: e });
        }
        await this.sleep(this.backoff(attempt));
        continue;
      }
      if (res.ok) {
        const data =
          info.response === "json"
            ? res.status === 204
              ? undefined
              : await res.json()
            : new Uint8Array(await res.arrayBuffer());
        return {
          data: data as Operations[K]["response"],
          status: res.status,
          headers: res.headers,
          etag: unquote(res.headers.get("etag")),
          replayed: res.headers.get("idempotency-replayed") === "true",
          rateLimit: parseRateLimit(res.headers.get("ratelimit")),
          idempotencyKey: key,
        };
      }
      const err = await this.errorOf(res);
      if (isRetriable(err) && (safe || err.status === 429) && attempt < max) {
        await this.sleep(err.retryAfterSecs !== undefined ? err.retryAfterSecs * 1000 : this.backoff(attempt));
        continue;
      }
      throw err;
    }
  }

  private async errorOf(res: Response): Promise<ApiError> {
    const text = await res.text().catch(() => "");
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return toApiError(res.status, body, res.headers);
  }

  /**
   * Every page of a paged operation (`listBlocks`, `queryRows`), following `next_cursor`.
   */
  async *pages<K extends PagedOperationId>(
    op: K,
    params: Params<K>,
    options?: CallOptions,
  ): AsyncGenerator<Operations[K]["response"]> {
    let cursor: string | null | undefined = (params.query as { cursor?: string } | undefined)?.cursor;
    for (;;) {
      const query = { ...(params.query ?? {}), ...(cursor ? { cursor } : {}) };
      const page = (await this.call(op, { ...params, query } as Params<K>, options)).data as {
        has_more?: boolean;
        next_cursor?: string | null;
      };
      yield page as Operations[K]["response"];
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  /** Every item of a paged operation, page after page. */
  async *paginate<K extends PagedOperationId>(
    op: K,
    params: Params<K>,
    options?: CallOptions,
  ): AsyncGenerator<unknown> {
    const items = operations[op].paged as string;
    for await (const page of this.pages(op, params, options)) {
      yield* ((page as Record<string, unknown>)[items] as unknown[]) ?? [];
    }
  }

  /** The change events of one file (SSE), resuming after `lastEventId` on reconnects. */
  events(opts: EventsOptions): EventStream {
    const open = async (lastEventId: string | undefined, signal: AbortSignal): Promise<Response> => {
      const query: Record<string, string> = {};
      if (opts.types?.length) query.types = opts.types.join(",");
      const url = this.url("streamEvents", { fileId: opts.fileId, query } as Params<"streamEvents">);
      const headers: Record<string, string> = {
        accept: "text/event-stream",
        ...this.opts.headers,
        ...(await this.authHeaders()),
      };
      if (lastEventId) headers["last-event-id"] = lastEventId;
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await this.fetchImpl(url, { method: "GET", headers, signal });
        } catch (e) {
          throw new NetworkError(`GET ${url}: ${(e as Error)?.message ?? e}`, { cause: e });
        }
        if (res.ok) return res;
        const err = await this.errorOf(res);
        if (isRetriable(err) && attempt < (this.opts.maxRetries ?? 3)) {
          await this.sleep(err.retryAfterSecs !== undefined ? err.retryAfterSecs * 1000 : this.backoff(attempt));
          continue;
        }
        throw err;
      }
    };
    return new EventStream(open, this.sleep, opts);
  }
}
