// Room-served assets (WOPI mode stores uploads inside the .ocanvas and serves them at
// `/v1/assets/:id`, docs/15 §6). The document keeps the bare path; each viewer adds their own
// session ticket when displaying it, so no credential is ever written into the file.

let ticket: string | null = null;

export function setAssetTicket(t: string | null) {
  ticket = t;
}

export function resolveAsset(src: string): string;
export function resolveAsset(src: string | null | undefined): string | null | undefined;
export function resolveAsset(src: string | null | undefined) {
  if (!src || !ticket || !src.startsWith("/v1/assets/") || /[?&]ticket=/.test(src)) return src;
  return `${src}${src.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`;
}
