// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OC = "http://localhost:8280";
export const HOST = "http://localhost:4200";
export const HOST_RELOAD = "http://localhost:4201";
/** A plain host page that embeds the canvas with the SDK (spec q); a registered origin of "sample". */
export const SDK_HOST = "http://localhost:4202";
