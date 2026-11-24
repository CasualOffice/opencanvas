// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @opencanvas/client: the TypeScript client of the OpenCanvas headless API (docs/05 §7d).

export { OpenCanvas, parseRateLimit } from "./client.js";
export type { ClientOptions, HostKeyAuth, TokenAuth } from "./client.js";
export * from "./errors.js";
export { EventStream, parseFrames } from "./events.js";
export type { EventsOptions } from "./events.js";
export { verifyWebhook } from "./webhooks.js";
export type { VerifyWebhookInput } from "./webhooks.js";
export * from "./generated.js";
export type * from "./types.js";
