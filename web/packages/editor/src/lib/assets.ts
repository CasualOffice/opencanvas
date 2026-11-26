// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Room-served assets (WOPI mode stores uploads inside the .ocanvas and serves them at
// `/v1/assets/:id`, docs/15 §6). The document keeps the bare path; each viewer adds their own
// session ticket when displaying it, so no credential is ever written into the file.

let ticket: string | null = null;

export function setAssetTicket(t: string | null) {
  ticket = t;
}

export const getAssetTicket = () => ticket;

/** OFF-05: images added offline (`oc-pending:<id>`): this device shows its own copy; everyone
 *  else a placeholder until the device uploads it. */
export const pendingPreviews = new Map<string, string>();
const PENDING_SVG = `${import.meta.env.BASE_URL}pending.svg`;

export function resolveAsset(src: string): string;
export function resolveAsset(src: string | null | undefined): string | null | undefined;
export function resolveAsset(src: string | null | undefined) {
  if (src && src.startsWith("oc-pending:")) return pendingPreviews.get(src) ?? PENDING_SVG;
  if (!src || !ticket || !src.startsWith("/v1/assets/") || /[?&]ticket=/.test(src)) return src;
  return `${src}${src.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`;
}
