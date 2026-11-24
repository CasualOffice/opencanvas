// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Migrating and re-deriving SDK block content in the editor (BSDK-05, docs/15 §4.2). Kept out of
// model.ts so the template and migration engines load only where a block is edited (BSDK-03),
// not with the editor's first paint.
import { migrate } from "./migrate";
import { parseTemplate, renderTemplate, mdEscape } from "./template";
import { installedBlock, statusOf, type BlockPackage, type ExtAttrs } from "./model";

/** Attrs and data brought to the installed version (BSDK-05), or null when the block is
 *  missing, newer, or its migration runs in the sandbox. */
export function currentOf(a: ExtAttrs, data: Record<string, unknown>, pkg = installedBlock(a.type)) {
  const s = statusOf(a, pkg);
  if (!pkg || s === "missing" || s === "newer") return null;
  if (s === "current") return { attrs: a.attrs ?? {}, data };
  try {
    return migrate(pkg.migrations, Number(a.v) || 1, pkg.v, a.attrs ?? {}, data);
  } catch {
    return null;
  }
}

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

