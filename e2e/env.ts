// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** E2E_PORT_SHIFT moves every port of the stack (two suites on one machine). */
export const SHIFT = Number(process.env.E2E_PORT_SHIFT ?? 0) || 0;
export const port = (n: number) => n + SHIFT;
export const OC = `http://localhost:${port(8280)}`;
export const HOST = `http://localhost:${port(4200)}`;
export const HOST_RELOAD = `http://localhost:${port(4201)}`;
/** A host with `[host.editor] profile = "meeting"` (EDP-01, spec za). */
export const HOST_MEETING = `http://localhost:${port(4203)}`;
/** A plain host page that embeds the canvas with the SDK (spec q); a registered origin of "sample". */
export const SDK_HOST = `http://localhost:${port(4202)}`;
/** A host with `[host.offline]` on and `perms.offline` in its tokens (OFF-01..07, spec zf). */
export const HOST_OFFLINE = `http://localhost:${port(4204)}`;
/** A host with `[host.flags] partial_sync` (PSYNC-02/03, spec zh). */
export const HOST_PSYNC = `http://localhost:${port(4205)}`;
