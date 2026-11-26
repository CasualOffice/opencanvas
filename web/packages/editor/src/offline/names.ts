// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Where an offline copy lives on the device (docs/15 §6, ADR-063). One IndexedDB database per
// host, person and file, beside the person's device key, the index of kept canvases and the
// upload queue; a registry per host lists the databases for browsers without
// `indexedDB.databases()`. Keep in sync with crates/oc-server/src/offline_clear.js.
export const ROOT = "oc-offline";
const RESERVED = new Set(["key", "index", "uploads"]);
const e = encodeURIComponent;

export const hostDb = (host: string) => `${ROOT}/${e(host)}`;
export const userPrefix = (host: string, user: string) => `${hostDb(host)}/${e(user)}/`;
export const keyDb = (host: string, user: string) => userPrefix(host, user) + "key";
export const indexDb = (host: string, user: string) => userPrefix(host, user) + "index";
export const uploadsDb = (host: string, user: string) => userPrefix(host, user) + "uploads";

/** A file's database. Ids that would read as one of the person's own databases get a `~`. */
export function fileDb(host: string, user: string, file: string): string {
  const x = e(file);
  return userPrefix(host, user) + (RESERVED.has(x) || x.startsWith("~") ? "~" + x : x);
}

/** The service worker's cache of the editor code (no content). */
export const SHELL_CACHE = "oc-shell";
