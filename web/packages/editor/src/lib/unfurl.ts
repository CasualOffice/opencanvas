// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Link-card previews (UNF-01). The server fetches the page (SSRF-safe, `GET
// /v1/unfurl`) and proxies its image (`GET /v1/unfurl/image`), so the browser never talks to
// the linked site and the CSP stays as it is. Only cards a person inserted in this tab are
// unfurled (ADR-035: agent-inserted links stay inert until a person acts); the result is
// written into the card's attributes once, so every viewer and every export sees it.

import { getAssetTicket } from "./assets";
import { hostOf } from "./embeds";

let enabled = false;

/** `session.unfurl` (server switch and host flag); off in `#demo`. */
export function setUnfurl(on: boolean) {
  enabled = on;
}

export const unfurlOn = () => enabled && !!getAssetTicket();

export interface Preview {
  title: string;
  description: string;
  siteName: string;
  image: string;
}

const pending = new Set<string>();
const inflight = new Map<string, Promise<Preview | null>>();

/** A person just inserted a card for `url`: its node view may unfurl it. */
export function markPending(url: string) {
  pending.add(url);
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const httpUrl = (v: unknown) => (typeof v === "string" && v.length <= 2048 && /^https?:\/\//i.test(v) ? v : "");

/** Asks the server for `url`'s preview; `null` on any failure (the card keeps the hostname). */
export async function fetchPreview(url: string, f: typeof fetch = fetch): Promise<Preview | null> {
  const ticket = getAssetTicket();
  if (!ticket) return null;
  try {
    const q = new URLSearchParams({ ticket, url });
    const r = await f(`/v1/unfurl?${q}`, { headers: { Accept: "application/json" }, credentials: "omit" });
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, unknown>;
    return { title: str(j.title, 200), description: str(j.description, 500), siteName: str(j.siteName, 100), image: httpUrl(j.image) };
  } catch {
    return null;
  }
}

/** The preview for a card a person inserted, once per URL (shared by re-mounts); otherwise null. */
export function unfurlFor(url: string, f: typeof fetch = fetch): Promise<Preview | null> | null {
  const running = inflight.get(url);
  if (running) return running;
  if (!unfurlOn() || !pending.has(url)) return null;
  pending.delete(url);
  const p = fetchPreview(url, f).finally(() => setTimeout(() => inflight.delete(url), 0));
  inflight.set(url, p);
  return p;
}

/** The card attributes for a preview, falling back to the hostname. */
export function previewAttrs(url: string, p: Preview) {
  const site = hostOf(url);
  return { title: p.title || site, description: p.description, site: p.siteName || site, image: p.image };
}

/** Same-origin proxy URL for a card image, or undefined (no image, unfurl off, not http(s)). */
export function cardImageSrc(image: string | null | undefined): string | undefined {
  const ticket = getAssetTicket();
  if (!enabled || !ticket || !httpUrl(image)) return undefined;
  return `/v1/unfurl/image?${new URLSearchParams({ ticket, url: image as string })}`;
}
