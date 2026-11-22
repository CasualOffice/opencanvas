// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// pdf.js, loaded on first use with its worker from this origin (CSP `script-src 'self'`,
// `worker-src 'self'`): never part of the initial JS (docs/02 §7). No eval (fonts are drawn
// without `new Function`), no scripting, no external resources.
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

type PdfJs = typeof import("pdfjs-dist");
let lib: Promise<PdfJs> | null = null;

export function loadPdfJs(): Promise<PdfJs> {
  return (lib ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(
    ([m, w]) => {
      m.GlobalWorkerOptions.workerSrc = w.default;
      return m;
    },
    (e) => {
      lib = null;
      throw e;
    },
  ));
}

const docs = new Map<string, Promise<PDFDocumentProxy>>();

/** Opens (and caches, per URL) a PDF. Rejects when it can't be fetched or parsed. */
export function openPdf(src: string): Promise<PDFDocumentProxy> {
  let p = docs.get(src);
  if (!p) {
    p = loadPdfJs().then((m) => m.getDocument({ url: src, isEvalSupported: false, enableXfa: false, withCredentials: false }).promise);
    p.catch(() => docs.delete(src));
    docs.set(src, p);
    // Keep a handful of documents around (thumbnails + one open viewer).
    if (docs.size > 8) {
      const [k, old] = docs.entries().next().value as [string, Promise<PDFDocumentProxy>];
      docs.delete(k);
      void old.then((d) => d.destroy()).catch(() => undefined);
    }
  }
  return p;
}

export interface Rendered {
  width: number;
  height: number;
  cancel(): void;
  done: Promise<void>;
}

/**
 * Draws a page into `canvas` at `cssWidth` CSS pixels wide (sharp on HiDPI). With a
 * `textLayer` element, the page's text is laid over it for selection.
 */
export function renderPage(page: PDFPageProxy, canvas: HTMLCanvasElement, cssWidth: number, textLayer?: HTMLElement | null): Rendered {
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth / base.width;
  const vp = page.getViewport({ scale });
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = `${Math.floor(vp.width)}px`;
  canvas.style.height = `${Math.floor(vp.height)}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { width: vp.width, height: vp.height, cancel() {}, done: Promise.resolve() };
  const task = page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
  let cancelled = false;
  const done = task.promise.then(async () => {
    if (!textLayer || cancelled) return;
    const m = await loadPdfJs();
    textLayer.replaceChildren();
    textLayer.style.setProperty("--scale-factor", String(scale));
    textLayer.style.setProperty("--total-scale-factor", String(scale));
    await new m.TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport: vp }).render();
  });
  done.catch(() => undefined);
  return {
    width: vp.width,
    height: vp.height,
    cancel() {
      cancelled = true;
      task.cancel();
    },
    done,
  };
}
