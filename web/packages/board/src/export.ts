// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Board export: a standalone SVG (and a PNG rendered from it) fitted to the content.
// Uses a fixed light palette so the file looks the same whatever theme the exporter had.
// Keep in step with the Rust port (`crates/oc-model/src/board.rs`): both must produce
// `crates/oc-model/tests/fixtures/board.web.svg` byte for byte (see export.test.ts).
import * as Y from "yjs";
import { exportResolvedArrows } from "./connectors";
import { contentBounds, getBoardMap, readShapes, smooth, type Pt, type Shape } from "./model";
import { STICKY_TEXT, stickyHeight, wrapText } from "./ops";
import { ICON_LABEL, iconGlyphBox, iconLabelLayout, iconPathsOf } from "./icons";

export const EXPORT_PALETTE = {
  bg: "#ffffff",
  fg: "#18181b",
  fg2: "#55555e",
  fg3: "#8b8b95",
  app: "#ffffff",
  panel: "#fbfbfa",
  /** `--line-2` (rgba(24,24,32,.15)) as a colour + opacity, which every SVG renderer reads. */
  line2: "#181820",
  line2Opacity: "0.15",
  accent: "#2a5ad7",
  stickyFg: "#29251a",
  sticky: { y: "#fdeaa0", p: "#fbd0de", b: "#cfe3fb", g: "#d3f0dd" } as Record<string, string>,
  swatch: { accent: "#2a5ad7", amber: "#8f5300", green: "#17703f", pink: "#ad2c66", purple: "#6538c4", red: "#b12424", blue: "#2350c8" } as Record<string, string>,
  /** rect / ellipse / diamond fills: `[--<tone>-bg, --<tone>-fg]` (the outline follows the tone). */
  tone: {
    gray: ["#efefed", "#55555c"],
    blue: ["#e6eefd", "#2350c8"],
    green: ["#e2f3e8", "#17703f"],
    amber: ["#fcf0d9", "#8f5300"],
    red: ["#fde6e6", "#b12424"],
    purple: ["#efe8fd", "#6538c4"],
    pink: ["#fce6f0", "#ad2c66"],
  } as Record<string, [string, string]>,
};
const P = EXPORT_PALETTE;
const FONT = `Geist, ui-sans-serif, -apple-system, 'Segoe UI', system-ui, sans-serif`;
const PAD = 32;
/** Connector labels: 12.5 px text wrapped to 180 px, 16 px lines, in a pill. */
const LABEL = { size: 12.5, wrap: 180, lh: 16 };

// Characters XML 1.0 can't carry are dropped and lone surrogates become U+FFFD, so the file
// always parses and matches the Rust renderer (which works on UTF-8) byte for byte.
const esc = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const n = (v: number) => (Math.round(v * 100) / 100).toString();
/** Palette lookup by a stored id (own keys only, so "constructor" is just unknown). */
const pick = <T>(rec: Record<string, T>, k: string | undefined): T | undefined => (k !== undefined && Object.hasOwn(rec, k) ? rec[k] : undefined);

function lines(ls: string[], x: number, y: number, lh: number, o: { anchor?: boolean; size?: number; weight?: number; fill: string }): string {
  return ls
    .map(
      (l, i) =>
        `<text x="${n(x)}" y="${n(y + i * lh)}" font-size="${n(o.size ?? 14)}"${o.weight ? ` font-weight="${o.weight}"` : ""}${o.anchor ? ` text-anchor="middle"` : ""} fill="${o.fill}">${esc(l)}</text>`,
    )
    .join("");
}

/** Text of a rect / ellipse / diamond, wrapped and centred as on screen (`BoardBlock` `centered`). */
function boxText(s: Shape, cx: number, size: number, lh: number, wrap: number, weight?: number): string {
  const ls = wrapText(String(s.text ?? ""), wrap, size);
  const y = (s.y ?? 0) + (s.h ?? 0) / 2 + size * 0.36 - ((ls.length - 1) * lh) / 2;
  return lines(ls, cx, y, lh, { anchor: true, size, weight, fill: P.fg });
}

/** Point halfway along a polyline (`ops.midPoint`, with `sqrt` so both renderers agree to the bit). */
function midPoint(pts: Pt[]): Pt {
  const seg = pts.slice(1).map((p, i) => {
    const dx = p[0] - pts[i][0], dy = p[1] - pts[i][1];
    return Math.sqrt(dx * dx + dy * dy);
  });
  let half = seg.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < seg.length; i++) {
    if (half <= seg[i] || i === seg.length - 1) {
      const t = seg[i] ? Math.min(1, half / seg[i]) : 0;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
    }
    half -= seg[i];
  }
  return pts[0];
}

/** A connector's label: wrapped lines, midpoint and pill box, or null without a label. */
function labelBox(s: Shape): { ls: string[]; mx: number; box: [number, number, number, number] } | null {
  if (s.type !== "arrow" || !s.pts || s.pts.length < 2) return null;
  const label = String(s.text ?? "").trim();
  if (!label) return null;
  const [mx, my] = midPoint(s.pts);
  const ls = wrapText(label, LABEL.wrap, LABEL.size);
  const lw = Math.max(...ls.map((l) => l.length)) * LABEL.size * 0.56 + 14;
  const bh = ls.length * LABEL.lh + 6;
  return { ls, mx, box: [mx - lw / 2, my - bh / 2, mx + lw / 2, my + bh / 2] };
}

let clipSeq = 0;
function shapeSvg(s: Shape): string {
  const x = s.x ?? 0, y = s.y ?? 0, w = s.w ?? 0, h = s.h ?? 0;
  const text = s.text ?? "";
  const stroke = s.stroke === "accent" ? P.accent : P.fg2;
  const tone = pick(P.tone, s.fill);
  const bg = tone?.[0] ?? P.app, line = tone?.[1] ?? stroke;
  switch (s.type) {
    case "sticky":
      return `<g><rect x="${n(x + 1)}" y="${n(y + 4)}" width="${n(w)}" height="${n(h)}" rx="6" fill="#000" opacity="0.07"/><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="6" fill="${pick(P.sticky, s.fill ?? "y") ?? P.sticky.y}"/>${lines(
        wrapText(String(text), w - STICKY_TEXT.pad * 2, STICKY_TEXT.size),
        x + STICKY_TEXT.pad,
        y + STICKY_TEXT.top,
        STICKY_TEXT.lh,
        { size: STICKY_TEXT.size, fill: P.stickyFg },
      )}</g>`;
    case "rect": {
      // An icon shape (DGM-17): tinted tile, the glyph as inline paths, the label outside.
      const icon = iconPathsOf(s);
      if (icon) {
        const g = iconGlyphBox(s);
        const lb = iconLabelLayout(s);
        return `<g><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="12" fill="${bg}"/><g transform="translate(${n(g.x)} ${n(g.y)}) scale(${n(g.size / 24)})" fill="none" stroke="${line}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon
          .map((d) => `<path d="${esc(d)}"/>`)
          .join("")}</g>${lb ? lines(lb.lines, lb.x, lb.y, ICON_LABEL.lh, { anchor: lb.middle, size: ICON_LABEL.size, weight: 600, fill: P.fg }) : ""}</g>`;
      }
      const size = s.size ?? 14;
      return `<g><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="12" fill="${s.dashed ? "none" : bg}" stroke="${s.dashed ? P.fg3 : line}" stroke-width="1.5"${s.dashed ? ` stroke-dasharray="6 5"` : ""}/>${
        s.label ? `<text x="${n(x + 14)}" y="${n(y + 24)}" font-size="11.5" font-weight="600" fill="${P.fg3}" letter-spacing=".6">${esc(String(s.label).toUpperCase())}</text>` : ""
      }${text ? boxText(s, x + w / 2, size, Math.round(size * 1.3), Math.max(20, w - 16)) : ""}</g>`;
    }
    case "ellipse": {
      const size = s.size ?? 15;
      return `<g><ellipse cx="${n(x + w / 2)}" cy="${n(y + h / 2)}" rx="${n(w / 2)}" ry="${n(h / 2)}" fill="${bg}" stroke="${line}" stroke-width="1.5"/>${
        text ? boxText(s, x + w / 2, size, Math.round(size * 1.27), Math.max(20, w * 0.72), 600) : ""
      }</g>`;
    }
    case "diamond": {
      const cx = x + w / 2, cy = y + h / 2;
      const size = s.size ?? 14;
      return `<g><path d="M${n(cx)} ${n(y)} L${n(x + w)} ${n(cy)} L${n(cx)} ${n(y + h)} L${n(x)} ${n(cy)} Z" fill="${bg}" stroke="${line}" stroke-width="1.5" stroke-linejoin="round"/>${
        text ? boxText(s, cx, size, Math.round(size * 1.3), Math.max(20, w * 0.6)) : ""
      }</g>`;
    }
    case "swatch":
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="12" fill="${pick(P.swatch, s.fill ?? "accent") ?? P.swatch.accent}" opacity="0.85"/>`;
    case "text": {
      const size = s.size || 18;
      return lines(String(text || "").split("\n"), x, y, size * 1.3, { size, weight: 600, fill: P.fg });
    }
    case "image": {
      if (!s.src) return "";
      const id = `ocbd-x-clip-${++clipSeq}`;
      return `<g><clipPath id="${id}"><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="8"/></clipPath><image href="${esc(s.src)}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/></g>`;
    }
    case "arrow": {
      if (!s.pts || s.pts.length < 2) return "";
      const path = `<path d="M${s.pts.map((q) => n(q[0]) + " " + n(q[1])).join(" L")}" stroke="${P.fg2}" stroke-width="1.6" fill="none" stroke-linejoin="round" stroke-linecap="round" marker-end="url(#ocbd-x-ah)"/>`;
      const lb = labelBox(s);
      if (!lb) return path;
      const [bx0, by0, bx1, by1] = lb.box;
      return `<g>${path}<rect x="${n(bx0)}" y="${n(by0)}" width="${n(bx1 - bx0)}" height="${n(by1 - by0)}" rx="6" fill="${P.panel}" stroke="${P.line2}" stroke-opacity="${P.line2Opacity}"/>${lb.ls
        .map((l, i) => `<text x="${n(lb.mx)}" y="${n(by0 + 3 + LABEL.lh * (i + 1) - 4)}" font-size="${n(LABEL.size)}" font-weight="500" text-anchor="middle" fill="${P.fg2}">${esc(l)}</text>`)
        .join("")}</g>`;
    }
    case "pen":
      if (!s.pts?.length) return "";
      return `<path d="${smooth(s.pts)}" stroke="${stroke}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  // A type this client doesn't know (a newer client, a missing plugin; ADR-045): a shape with a
  // box and no points draws as a rect with its text and label, as the Rust exporter does, so its
  // content is not silently left out of exports. Anything else draws nothing.
  if (!s.pts?.length && w > 0 && h > 0) return shapeSvg({ ...s, type: "rect" });
  return "";
}

/** Sticky notes grow to fit their text, as the editor does when the text is committed. */
const grown = (shapes: Shape[]) =>
  shapes.map((s) => {
    if (s.type !== "sticky") return s;
    const h = s.h ?? 0;
    const need = stickyHeight(String(s.text ?? ""), s.w ?? 0, h);
    return need > h ? { ...s, h: need } : s;
  });

/** Shapes as drawn: grown stickies, then connectors resolved against them. */
const prepared = (shapes: Shape[]) => exportResolvedArrows(grown(shapes));

function boundsOf(list: Shape[]): [number, number, number, number] {
  const b = contentBounds(list);
  if (!b) return [0, 0, 320, 200];
  for (const s of list) {
    const box = labelBox(s)?.box ?? (iconPathsOf(s) ? iconLabelLayout(s)?.box : undefined);
    if (!box) continue;
    b[0] = Math.min(b[0], box[0]);
    b[1] = Math.min(b[1], box[1]);
    b[2] = Math.max(b[2], box[2]);
    b[3] = Math.max(b[3], box[3]);
  }
  return [b[0] - PAD, b[1] - PAD, b[2] + PAD, b[3] + PAD];
}

/** Size of the exported picture in board units (content, grown stickies and connector labels). */
export function exportBounds(shapes: Shape[]): [number, number, number, number] {
  return boundsOf(prepared(shapes));
}

/** Render shapes to a standalone SVG document string. */
export function shapesToSvg(shapes: Shape[]): string {
  const list = prepared(shapes);
  const [x0, y0, x1, y1] = boundsOf(list);
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
  return exportShapesPng(m ? readShapes(m) : [], scale);
}

/** PNG of the given shapes (a selection), fitted to them. */
export async function exportShapesPng(list: Shape[], scale = 2): Promise<Blob> {
  const shapes = await inlineImages(list);
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
