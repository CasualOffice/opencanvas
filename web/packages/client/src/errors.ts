// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// RFC 9457 problems as typed exceptions. The kind comes from the machine `code` first, then
// the HTTP status, the same way in the Rust client (`ProblemKind`).

/** An `application/problem+json` body. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  /** Machine code: `BLOCK_NOT_FOUND`, `STALE_BLOCK`, `ROLE_FORBIDDEN`, `RATE_LIMITED`, … */
  code: string;
  [key: string]: unknown;
}

export type ProblemKind =
  | "BadRequest"
  | "Unauthorized"
  | "Forbidden"
  | "NotFound"
  | "Conflict"
  | "Gone"
  | "PreconditionFailed"
  | "StaleBlock"
  | "TooLarge"
  | "Unprocessable"
  | "IdempotencyKeyReused"
  | "IdempotencyInProgress"
  | "CursorExpired"
  | "RateLimited"
  | "Unavailable"
  | "Server"
  | "Problem";

const BY_CODE: Record<string, ProblemKind> = {
  STALE_BLOCK: "StaleBlock",
  IDEMPOTENCY_KEY_REUSED: "IdempotencyKeyReused",
  IDEMPOTENCY_IN_PROGRESS: "IdempotencyInProgress",
  CURSOR_EXPIRED: "CursorExpired",
  RATE_LIMITED: "RateLimited",
};

const BY_STATUS: Record<number, ProblemKind> = {
  400: "BadRequest",
  401: "Unauthorized",
  403: "Forbidden",
  404: "NotFound",
  409: "Conflict",
  410: "Gone",
  412: "PreconditionFailed",
  413: "TooLarge",
  422: "Unprocessable",
  429: "RateLimited",
  503: "Unavailable",
};

/** The kind of a problem: by `code` when it has its own, else by status. */
export function problemKind(status: number, code: string): ProblemKind {
  return BY_CODE[code] ?? BY_STATUS[status] ?? (status >= 500 ? "Server" : "Problem");
}

/** Base of every error this client throws. */
export class OpenCanvasError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The request never got an answer (DNS, connection, TLS, abort). */
export class NetworkError extends OpenCanvasError {}

/** The server answered with an error (an RFC 9457 problem). */
export class ApiError extends OpenCanvasError {
  readonly status: number;
  readonly code: string;
  readonly kind: ProblemKind;
  readonly problem: ProblemDetails;
  readonly headers: Headers;
  /** `Retry-After` in seconds, when the server sent one. */
  readonly retryAfterSecs?: number;

  constructor(problem: ProblemDetails, headers: Headers) {
    super(`${problem.status} ${problem.code}: ${problem.detail ?? problem.title}`);
    this.status = problem.status;
    this.code = problem.code;
    this.kind = problemKind(problem.status, problem.code);
    this.problem = problem;
    this.headers = headers;
    const ra = Number(headers.get("retry-after"));
    if (headers.has("retry-after") && Number.isFinite(ra)) this.retryAfterSecs = ra;
  }

  get type(): string {
    return this.problem.type;
  }
  get title(): string {
    return this.problem.title;
  }
  get detail(): string | undefined {
    return this.problem.detail;
  }
}

export class BadRequestError extends ApiError {}
export class UnauthorizedError extends ApiError {}
export class ForbiddenError extends ApiError {}
export class NotFoundError extends ApiError {}
export class ConflictError extends ApiError {}
export class GoneError extends ApiError {}
export class CursorExpiredError extends GoneError {}
export class PreconditionFailedError extends ApiError {}
/** A block (or the document) changed since it was read; `fresh` is the current state. */
export class StaleBlockError extends PreconditionFailedError {
  get fresh(): unknown {
    return this.problem.fresh;
  }
}
export class TooLargeError extends ApiError {}
export class UnprocessableError extends ApiError {}
export class IdempotencyKeyReusedError extends UnprocessableError {}
export class IdempotencyInProgressError extends ConflictError {}
export class RateLimitedError extends ApiError {}
export class UnavailableError extends ApiError {}
export class ServerError extends ApiError {}

const CLASSES: Record<ProblemKind, new (p: ProblemDetails, h: Headers) => ApiError> = {
  BadRequest: BadRequestError,
  Unauthorized: UnauthorizedError,
  Forbidden: ForbiddenError,
  NotFound: NotFoundError,
  Conflict: ConflictError,
  Gone: GoneError,
  CursorExpired: CursorExpiredError,
  PreconditionFailed: PreconditionFailedError,
  StaleBlock: StaleBlockError,
  TooLarge: TooLargeError,
  Unprocessable: UnprocessableError,
  IdempotencyKeyReused: IdempotencyKeyReusedError,
  IdempotencyInProgress: IdempotencyInProgressError,
  RateLimited: RateLimitedError,
  Unavailable: UnavailableError,
  Server: ServerError,
  Problem: ApiError,
};

/** The typed error for an error answer. A body that is not a problem (a proxy's HTML page)
 * becomes one with code `HTTP_<status>`. */
export function toApiError(status: number, body: unknown, headers: Headers): ApiError {
  let problem: ProblemDetails;
  if (body && typeof body === "object" && typeof (body as ProblemDetails).code === "string") {
    problem = { ...(body as ProblemDetails), status };
  } else {
    problem = {
      type: "about:blank",
      title: `HTTP ${status}`,
      status,
      code: `HTTP_${status}`,
      detail: typeof body === "string" ? body.slice(0, 500) : undefined,
    };
  }
  return new CLASSES[problemKind(status, problem.code)](problem, headers);
}

/** An events stream ended for good: 4001 (token expired), 4003 (access revoked), or another
 * close code the client does not reconnect after. */
export class StreamClosedError extends OpenCanvasError {
  constructor(
    readonly code: number,
    readonly reason: string,
  ) {
    super(`events stream closed (${code}): ${reason}`);
  }
}
