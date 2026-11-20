// Board export: a standalone SVG (and a PNG rendered from it) fitted to the content.
// Uses a fixed light palette so the file looks the same whatever theme the exporter had.
import * as Y from "yjs";
import { withResolvedArrows } from "./connectors";
import { contentBounds, getBoardMap, readShapes, smooth, type Shape } from "./model";

export const EXPORT_PALETTE = {
  bg: "#ffffff",
  fg: "#18181b",
  fg2: "#55555e",
  fg3: "#8b8b95",
  app: "#ffffff",
  accent: "#2a5ad7",
  stickyFg: "#29251a",
  sticky: { y: "#fdeaa0", p: "#fbd0de", b: "#cfe3fb", g: "#d3f0dd" } as Record<string, string>,
  swatch: { accent: "#2a5ad7", amber: "#8f5300", green: "#17703f", pink: "#ad2c66", purple: "#6538c4", red: "#b12424", blue: "#2350c8" } as Record<string, string>,
};
const P = EXPORT_PALETTE;
const FONT = `Geist, ui-sans-serif, -apple-system, 'Segoe UI', system-ui, sans-serif`;
const PAD = 32;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v: number) => (Math.round(v * 100) / 100).toString();

function lines(text: string, x: number, y: number, lh: number, o: { anchor?: boolean; size?: number; weight?: number; fill: string }): string {
  return String(text || "")
    .split("\n")
    .map(
      (l, i) =>
        `<text x="${n(x)}" y="${n(y + i * lh)}" font-size="${o.size ?? 14}"${o.weight ? ` font-weight="${o.weight}"` : ""}${o.anchor ? ` text-anchor="middle"` : ""} fill="${o.fill}">${esc(l)}</text>`,
    )
    .join("");
}
const centered = (s: Shape, lh: number) => (s.y ?? 0) + (s.h ?? 0) / 2 + 5 - ((String(s.text ?? "").split("\n").length - 1) * lh) / 2;

let clipSeq = 0;
function shapeSvg(s: Shape): string {
  const x = s.x ?? 0, y = s.y ?? 0, w = s.w ?? 0, h = s.h ?? 0;
  const text = s.text ?? "";
  const stroke = s.stroke === "accent" ? P.accent : P.fg2;
  switch (s.type) {
    case "sticky":
      return `<g><rect x="${n(x + 1)}" y="${n(y + 4)}" width="${n(w)}" height="${n(h)}" rx="6" fill="#000" opacity="0.07"/><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="6" fill="${P.sticky[s.fill ?? "y"] ?? P.sticky.y}"/>${lines(text, x + 14, y + 30, 20, { fill: P.stickyFg })}</g>`;
    case "rect":
      return `<g><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="12" fill="${s.dashed ? "none" : P.app}" stroke="${s.dashed ? P.fg3 : stroke}" stroke-width="1.5"${s.dashed ? ` stroke-dasharray="6 5"` : ""}/>${
        s.label ? `<text x="${n(x + 14)}" y="${n(y + 24)}" font-size="11.5" font-weight="600" fill="${P.fg3}" letter-spacing=".6">${esc(s.label.toUpperCase())}</text>` : ""
      }${text ? lines(text, x + w / 2, centered(s, 18), 18, { anchor: true, fill: P.fg }) : ""}</g>`;
    case "ellipse":
      return `<g><ellipse cx="${n(x + w / 2)}" cy="${n(y + h / 2)}" rx="${n(w / 2)}" ry="${n(h / 2)}" fill="${P.app}" stroke="${stroke}" stroke-width="1.5"/>${
        text ? lines(text, x + w / 2, centered(s, 19), 19, { anchor: true, size: 15, weight: 600, fill: P.fg }) : ""
      }</g>`;
    case "diamond": {
      const cx = x + w / 2, cy = y + h / 2;
      return `<g><path d="M${n(cx)} ${n(y)} L${n(x + w)} ${n(cy)} L${n(cx)} ${n(y + h)} L${n(x)} ${n(cy)} Z" fill="${P.app}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>${
        text ? lines(text, cx, centered(s, 18), 18, { anchor: true, fill: P.fg }) : ""
      }</g>`;
    }
    case "swatch":
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="12" fill="${P.swatch[s.fill ?? "accent"] ?? P.swatch.accent}" opacity="0.85"/>`;
    case "text": {
      const size = s.size || 18;
      return lines(text, x, y, size * 1.3, { size, weight: 600, fill: P.fg });
    }
    case "image": {
      if (!s.src) return "";
      const id = `ocbd-x-clip-${++clipSeq}`;
      return `<g><clipPath id="${id}"><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="8"/></clipPath><image href="${esc(s.src)}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/></g>`;
    }
    case "arrow": {
      if (!s.pts || s.pts.length < 2) return "";
      return `<path d="M${s.pts.map((q) => n(q[0]) + " " + n(q[1])).join(" L")}" stroke="${P.fg2}" stroke-width="1.6" fill="none" stroke-linejoin="round" stroke-linecap="round" marker-end="url(#ocbd-x-ah)"/>`;
    }
    case "pen":
      if (!s.pts?.length) return "";
      return `<path d="${smooth(s.pts)}" stroke="${stroke}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return "";
}

/** Size of the exported picture in board units. */
export function exportBounds(shapes: Shape[]): [number, number, number, number] {
  const b = contentBounds(withResolvedArrows(shapes));
  if (!b) return [0, 0, 320, 200];
  return [b[0] - PAD, b[1] - PAD, b[2] + PAD, b[3] + PAD];
}

/** Render shapes to a standalone SVG document string. */
export function shapesToSvg(shapes: Shape[]): string {
  const list = withResolvedArrows(shapes);
  const [x0, y0, x1, y1] = exportBounds(shapes);
  const W = Math.max(1, Math.ceil(x1 - x0)), H = Math.max(1, Math.ceil(y1 - y0));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="${n(x0)} ${n(y0)} ${W} ${H}" font-family="${FONT}">` +
    `<defs><marker id="ocbd-x-ah" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1.5 L9 5 L1 8.5" fill="none" stroke="${P.fg2}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>` +
    `<rect x="${n(x0)}" y="${n(y0)}" width="${W}" height="${H}" fill="${P.bg}"/>` +
    list.map(shapeSvg).join("") +
    `</svg>`
  );
}

/** Export a board as an SVG string, fitted to its content, in the light palette. */
export function exportBoardSvg(doc: Y.Doc, boardId: string): string {
  const m = getBoardMap(doc, boardId);
  return shapesToSvg(m ? readShapes(m) : []);
}

async function inlineImages(shapes: Shape[]): Promise<Shape[]> {
  return Promise.all(
    shapes.map(async (s) => {
      if (s.type !== "image" || !s.src || s.src.startsWith("data:")) return s;
      try {
        const r = await fetch(s.src, { credentials: "include" });
        if (!r.ok) throw new Error(String(r.status));
        const blob = await r.blob();
        const src = await new Promise<string>((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result));
          fr.onerror = () => rej(fr.error);
          fr.readAsDataURL(blob);
        });
        return { ...s, src };
      } catch {
        // Unreachable (or cross-origin) images would taint the canvas; leave them out.
        return { ...s, src: undefined };
      }
    }),
  );
}

/** Export a board as a PNG (fitted to content, light palette). `scale` defaults to 2. */
export async function exportBoardPng(doc: Y.Doc, boardId: string, scale = 2): Promise<Blob> {
  const m = getBoardMap(doc, boardId);
  const shapes = await inlineImages(m ? readShapes(m) : []);
  const svg = shapesToSvg(shapes);
  const [x0, y0, x1, y1] = exportBounds(shapes);
  const W = Math.ceil(x1 - x0), H = Math.ceil(y1 - y0);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("Couldn't render the board"));
      img.src = url;
    });
    const s = Math.max(0.1, Math.min(scale, 16384 / Math.max(W, H)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(W * s);
    canvas.height = Math.round(H * s);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available");
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("PNG encoding failed"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}
