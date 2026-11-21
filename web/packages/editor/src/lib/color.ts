// Text colour for labels drawn on a person's colour (avatars, caret labels,
// mention chips). User colours come from the host, so they can be anything:
// pick white or near-black, whichever reaches the higher WCAG contrast.

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of `#rgb` / `#rrggbb`; null for anything else (CSS names, var()). */
export function luminance(color: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const n = parseInt(h, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const DARK = "#000";
const DARK_L = luminance(DARK)!;

/** `#fff` or a near-black, whichever reads better on `bg`. */
export function readableOn(bg: string): string {
  const l = luminance(bg);
  if (l === null) return "#fff";
  return contrast(l, 1) >= contrast(l, DARK_L) ? "#fff" : DARK;
}
