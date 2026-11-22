// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// What an attachment is and where its bytes can be read from (FILE-01). Tiny and eager:
// the file card uses it at first paint; everything that renders previews is lazy.
import { getAssetTicket, resolveAsset } from "../../lib/assets";

export type FileKind = "pdf" | "image" | "text" | "video" | "audio" | "other";
export type FileDisplay = "card" | "preview";

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|toml|xml|log|ini|sql|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|css|scss|html?)$/i;

export function fileKind(mime: string, name: string): FileKind {
  const m = (mime || "").toLowerCase();
  if (m === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (/^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/.test(m) || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(name)) return "image";
  if (/^video\//.test(m) || /\.(mp4|webm|mov|m4v|ogv)$/i.test(name)) return "video";
  if (/^audio\//.test(m) || /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i.test(name)) return "audio";
  if (/^text\//.test(m) || /(json|xml|yaml|toml|javascript|typescript|csv|markdown|x-sh|sql)/.test(m) || TEXT_EXT.test(name)) return "text";
  return "other";
}

/** `display` attr, with PDFs shown as an inline preview unless someone chose the card. */
export function fileDisplay(attr: unknown, kind: FileKind): FileDisplay {
  if (attr === "card" || attr === "preview") return kind === "pdf" || attr === "card" ? attr : "card";
  return kind === "pdf" ? "preview" : "card";
}

/** Whether the bytes can be shown in this browser at all (there is a URL to read). */
export const hasBytes = (url: string) => !!url && !/^javascript:/i.test(url);

/**
 * A same-origin URL for the bytes, for pdf.js, text and media previews. Room assets and
 * same-origin / data / blob URLs are used as they are; the host's files go through
 * `GET /v1/assets/fetch` (the browser can't read another origin, docs/05 §5). Downloads and
 * "Open in new tab" keep the original link ({@link openUrl}).
 */
export function previewUrl(url: string): string {
  if (!url) return url;
  if (/^(data|blob):/i.test(url) || url.startsWith("/v1/assets/")) return resolveAsset(url);
  let abs: URL;
  try {
    abs = new URL(url, window.location.href);
  } catch {
    return url;
  }
  if (abs.origin === window.location.origin) return abs.toString();
  const t = getAssetTicket();
  if (!t || !/^https?:$/.test(abs.protocol)) return url;
  return `/v1/assets/fetch?ticket=${encodeURIComponent(t)}&url=${encodeURIComponent(abs.toString())}`;
}

/** The link a person opens or downloads. */
export const openUrl = (url: string) => resolveAsset(url);

export function fmtSize(n: number): string {
  if (!n) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

export function kindIcon(kind: FileKind, mime: string, name: string): string {
  if (kind === "image") return "file-image";
  if (kind === "video") return "file-video";
  if (kind === "audio") return "file-audio";
  if (/sheet|csv|excel/.test(mime) || /\.(xlsx?|csv)$/i.test(name)) return "file-spreadsheet";
  if (/zip|compressed|tar|gzip/.test(mime)) return "file-archive";
  if (kind === "text" && !/\.(md|txt)$/i.test(name)) return "file-code";
  return "file-text";
}

/** DOM event the block menu sends to a file card: `preview`, `expand`, `rename`, `menu`. */
export const FILE_EVENT = "oc:file";
