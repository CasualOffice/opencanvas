// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Re-deriving SDK block fallbacks in the editor (BSDK-02, docs/15 §4.2). Kept out of model.ts so
// the template engine loads only where a block is edited (BSDK-03), not with the first paint.
import { parseTemplate, renderTemplate, mdEscape } from "./template";
import type { BlockPackage } from "./model";

/** The `fallback` a client keeps up to date (docs/27 §3.2): the package's templates over the
 *  current attrs and data; null when it has none (the server re-derives it on its writes). */
export function deriveFallback(pkg: BlockPackage, attrs: Record<string, unknown>, data: Record<string, unknown>) {
  const ex = pkg.export;
  if (!ex?.markdown && !ex?.text) return null;
  const ctx = { ...attrs, data } as never;
  const text = ex.text ? renderTemplate(parseTemplate(ex.text), ctx, "text") : null;
  const markdown = ex.markdown ? renderTemplate(parseTemplate(ex.markdown), ctx, "markdown") : mdEscape(text ?? "");
  return { markdown, text: text ?? markdown };
}

