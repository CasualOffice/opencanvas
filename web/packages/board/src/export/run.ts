// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Renders an export (BRD-20) from the dialog's choices; also the quick Copy as PNG / SVG.
import * as Y from "yjs";
import { exportBounds, exportShapesPng, shapesToSvg, type ExportLook } from "../export";
import { docIconUrls } from "../icons";
import type { Shape } from "../model";
import { copyImage, download } from "./clipboard";
import { readExportBg, type ExportBg } from "./prefs";

export type ExportFmt = "png" | "svg";
export interface ExportChoice {
  fmt: ExportFmt;
  bg: ExportBg;
  /** Colours drawn for a light or dark page, when the background is transparent. */
  ink: "light" | "dark";
  scale: 1 | 2 | 3;
}

export const lookOf = (c: Pick<ExportChoice, "bg" | "ink">): ExportLook =>
  c.bg === "transparent" ? { theme: c.ink, background: false } : { theme: c.bg, background: true };

/** The picture's size in pixels. */
export function pixelSize(list: Shape[], c: Pick<ExportChoice, "fmt" | "scale">): [number, number] {
  const [x0, y0, x1, y1] = exportBounds(list);
  const k = c.fmt === "png" ? c.scale : 1;
  return [Math.round(Math.ceil(x1 - x0) * k), Math.round(Math.ceil(y1 - y0) * k)];
}

export function render(doc: Y.Doc, list: Shape[], c: ExportChoice): Promise<Blob> {
  const look = lookOf(c);
  if (c.fmt === "svg") return Promise.resolve(new Blob([shapesToSvg(list, docIconUrls(doc), look)], { type: "image/svg+xml" }));
  return exportShapesPng(list, c.scale, look, docIconUrls(doc));
}

export const fileName = (name: string, ext: string) => `${(name.replace(/[^\p{L}\p{N} ._-]/gu, "_").trim() || "board").slice(0, 80)}.${ext}`;

export const describe = (c: ExportChoice) => `${c.fmt.toUpperCase()}${c.fmt === "png" ? `, ${c.scale}×` : ""}, ${c.bg === "transparent" ? "transparent" : c.bg + " background"}`;

/**
 * Copy as PNG / SVG from a menu or key (⇧⌘C): the remembered background, 2×. Returns false when
 * the browser can't copy images, so the caller can offer Download.
 */
export async function quickCopy(doc: Y.Doc, list: Shape[], fmt: ExportFmt): Promise<boolean> {
  const bg = readExportBg();
  const c: ExportChoice = { fmt, bg, ink: "light", scale: 2 };
  return copyImage(render(doc, list, c), fmt === "png" ? "image/png" : "image/svg+xml");
}

export async function quickDownload(doc: Y.Doc, list: Shape[], fmt: ExportFmt, name = "board") {
  const c: ExportChoice = { fmt, bg: readExportBg(), ink: "light", scale: 2 };
  download(await render(doc, list, c), fileName(name, fmt));
}
