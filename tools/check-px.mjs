#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SCALE-01 lint guard (ADR-048): fails when px creeps back into the UI's type and spacing.
//
//   node tools/check-px.mjs
//
// 1. CSS (the files tools/px-to-rem.mjs converts): any px value the codemod would convert
//    (font sizes, spacing, control sizes, radii, ...; > 2 px) is an error. The fix is
//    `node tools/px-to-rem.mjs`, or a trailing `/* px */` on a declaration that must stay px.
// 2. Inline React styles in web/packages/{editor,database,board,ui}/src (*.tsx): a numeric or
//    px `fontSize`, or a px padding/margin/gap string, is an error. Use a rem string. A line
//    ending in `// px-ok` is allowed (board geometry, measured positions).
// Media queries in those CSS files must use em; a px one is an error too.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertCss, targets } from "./px-to-rem.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

for (const f of targets()) {
  const src = fs.readFileSync(f, "utf8");
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    const { converted } = convertCss(line);
    if (converted) errors.push(`${path.relative(ROOT, f)}:${i + 1}: px in type/spacing (${converted}); use rem (node tools/px-to-rem.mjs) or mark /* px */`);
  });
  if (/(^|[{;\s,])html\s*[,{][^}]*font-size/.test(src.replace(/\/\*[\s\S]*?\*\//g, ""))) errors.push(`${path.relative(ROOT, f)}: font-size on html; the root keeps the reader's default (ADR-048)`);
}

const INLINE = [
  [/fontSize:\s*(-?\d|["'`][^"'`]*\dpx)/, "numeric/px fontSize"],
  [/\b(padding|margin|gap)(Top|Right|Bottom|Left|Inline|Block)?:\s*["'`][^"'`]*([3-9]|\d\d+)px/, "px spacing"],
];
const walk = (d, out) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".tsx") && !e.name.includes(".test.")) out.push(p);
  }
  return out;
};
for (const pkg of ["editor", "database", "board", "ui"]) {
  for (const f of walk(path.join(ROOT, "web/packages", pkg, "src"), [])) {
    fs.readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/\/\/\s*px-ok\b/.test(line)) return;
        for (const [re, what] of INLINE) if (re.test(line)) errors.push(`${path.relative(ROOT, f)}:${i + 1}: ${what} in an inline style; use rem (or end the line with // px-ok)`);
      });
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  console.error(`check-px: ${errors.length} problem(s) (ADR-048)`);
  process.exit(1);
}
console.log("check-px: ok (type and spacing are rem; media queries are em)");
