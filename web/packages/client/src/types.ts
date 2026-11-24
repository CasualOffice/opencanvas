// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

/** A raw request body (import, convert). */
export type BinaryBody = Uint8Array | ArrayBuffer | Blob | string;

/** The tightest bucket of the `RateLimit` header: `"<policy>";r=<remaining>;t=<seconds>`. */
export interface RateLimitInfo {
  policy: string;
  remaining: number;
  /** Seconds until the bucket is full again. */
  resetSecs: number;
}

/** An answer with what the headers say about it. */
export interface ApiResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  /** The `ETag` without quotes: the document (or block) `rev`. */
  etag?: string;
  /** `Idempotency-Replayed: true`: the stored answer of an earlier request with this key. */
  replayed: boolean;
  rateLimit?: RateLimitInfo;
  /** The `Idempotency-Key` the request carried, if any. */
  idempotencyKey?: string;
}

/** Per-call options. */
export interface CallOptions {
  /**
   * The `Idempotency-Key` of a write. Writes get a fresh random key by default, reused for
   * every retry of that call; pass your own to make a retry across processes safe, or `false`
   * to send none.
   */
  idempotencyKey?: string | false;
  /** `If-Match`: the document `rev` a `batchBlocks` call expects (412 `STALE_BLOCK` if not). */
  ifMatch?: string;
  /** Overrides the client's `maxRetries` for this call (0: no retry). */
  maxRetries?: number;
  signal?: AbortSignal;
  /** Extra request headers. */
  headers?: Record<string, string>;
}
