// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Exports (docs/15 §6): Markdown, HTML, JSON, Word and .ocanvas come from
// `GET /v1/export/:fmt?ticket=`. PDF asks the server first
// (`GET /v1/export/pdf`, rendered by its PDF sidecar); when the server has no
// renderer (501 PDF_RENDERER_NOT_CONFIGURED, or 404 from a server without the
// route) it falls back to the browser's print dialog over the print
// stylesheet in app.css.
import { toast } from "./store";

export type ExportFormat = "md" | "html" | "ocanvas" | "json" | "docx" | "pdf";

const LABEL: Record<ExportFormat, string> = { md: "Markdown", html: "Web page", ocanvas: "OpenCanvas file", json: "JSON", docx: "Word document", pdf: "PDF" };

function filenameFrom(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1].trim() : fallback;
}

async function save(r: Response, fmt: ExportFormat, baseName: string) {
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filenameFrom(r.headers.get("content-disposition"), `${baseName || "Canvas"}.${fmt}`);
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  toast(`Downloaded ${a.download}`, { icon: "download" });
}

/** The server can't render PDFs: no sidecar configured (501), or an older server without the route (404). */
async function noRenderer(r: Response): Promise<boolean> {
  if (r.status === 501) return true;
  if (r.status !== 404) return false;
  const body = await r.text().catch(() => "");
  return /FORMAT_UNSUPPORTED/.test(body);
}

export async function downloadExport(ticket: string, fmt: ExportFormat, baseName: string) {
  toast(`Preparing ${LABEL[fmt]}…`, { icon: "loader-circle" });
  try {
    const r = await fetch(`/v1/export/${fmt}?ticket=${encodeURIComponent(ticket)}`);
    if (fmt === "pdf" && (await noRenderer(r))) return printPdf();
    if (r.status === 403) return toast("Exports are turned off for this canvas", { icon: "lock" });
    if (!r.ok) throw new Error(String(r.status));
    await save(r, fmt, baseName);
  } catch {
    toast(`The ${LABEL[fmt]} export didn't work. Try again.`, { icon: "triangle-alert" });
  }
}

/** Print to PDF in light theme, whatever the screen theme is. */
export function printPdf() {
  const root = document.documentElement;
  const prev = root.dataset.theme;
  root.dataset.theme = "light";
  const restore = () => {
    if (prev) root.dataset.theme = prev;
    else delete root.dataset.theme;
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
  // Let the theme change paint before the dialog snapshots the page.
  requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
}
