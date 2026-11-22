// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// URL guards for attributes that come from the shared Y.Doc (docs/07 §2, docs/18 SEC-20).
// Any editor (or a crafted update, import or host patch) can put any string into a node's
// `url` / `src`, so node views must never hand one straight to `href` or `src`.

const WS = /[\0- \xA0\u1680\u180E\u2000-\u2029\u205F\u3000]/g;

/**
 * `href` for a link-like node: http(s), mailto, same-origin paths and fragments pass;
 * `javascript:`, `data:`, `vbscript:`, `blob:` and anything else become `undefined`
 * (React then renders no `href` at all).
 */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const u = url.replace(WS, "");
  if (/^(https?:|mailto:)/i.test(u)) return url.trim();
  if (/^\/(?![/\\])/.test(u) || u.startsWith("#")) return url.trim();
  return undefined;
}

/**
 * `src` for an image: http(s), same-origin paths, and inline raster `data:image/*` (never
 * `data:image/svg+xml`, never another scheme).
 */
export function safeImageSrc(src: string | null | undefined): string | undefined {
  if (!src) return undefined;
  const u = src.replace(WS, "");
  if (/^https?:/i.test(u) || /^\/(?![/\\])/.test(u) || /^blob:/i.test(u)) return src.trim();
  if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,/i.test(u)) return src.trim();
  return undefined;
}
