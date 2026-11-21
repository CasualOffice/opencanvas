// Image layout attributes (ADR-023): width in % of the text column, alignment.

/** Image width as a whole percent of the text column (20–100), or null for full width. */
export function clampWidth(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(20, Math.min(100, Math.round(n)));
}
