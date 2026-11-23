#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SCALE-01 (ADR-048): converts px to rem in the web UI's CSS so the chrome follows the
// reader's default font size. 16 px = 1 rem. Idempotent: it only touches px values, so
// re-running it after other work lands converts just the new ones.
//
//   node tools/px-to-rem.mjs            # rewrite the files in place, print counts
//   node tools/px-to-rem.mjs --check    # change nothing; exit 1 if anything would convert
//                                       # (the lint guard, tools/check-px.mjs, uses this)
//
// What converts (by property): font-size, font (shorthand), line-height, letter-spacing,
// padding*, margin*, gap/row-gap/column-gap, width/height and their min/max, top/right/
// bottom/left/inset*, border-radius*, flex/flex-basis, grid-template-*/grid-auto-*,
// scroll-margin*/scroll-padding*, text-indent, and custom properties whose whole value is
// one length (the token scales: --r-s, --r, --r-l, ...). Media queries: px → em.
//
// What stays px (ADR-048 lists why):
//   - any value of 2 px or less (borders, hairlines, 1-2 px nudges);
//   - borders, outlines, outline-offset, box-shadow, text-shadow, filters, transforms,
//     text-underline-offset, background-position/size, stroke widths;
//   - custom properties holding more than one value (shadows);
//   - a declaration marked with a trailing `/* px */` comment (hand-kept);
//   - files not listed below: board/whiteboard geometry (BoardBlock.tsx, connectors.ts,
//     ...), inline React styles, export renderers (crates/oc-model).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = path.join(ROOT, "web/packages");

/** The converted files. CSS files whole; the .ts files are CSS-in-a-template-string. */
export function targets() {
  const css = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".css")) css.push(p);
    }
  };
  walk(path.join(PKG, "editor/src"));
  walk(path.join(PKG, "ui/src"));
  return [...css, path.join(PKG, "database/src/styles.ts"), path.join(PKG, "board/src/styles.ts")];
}

const CONVERT = new RegExp(
  "^(" +
    [
      "font-size", "font", "line-height", "letter-spacing", "text-indent",
      "padding(-(top|right|bottom|left|inline|block)(-(start|end))?)?",
      "margin(-(top|right|bottom|left|inline|block)(-(start|end))?)?",
      "gap", "row-gap", "column-gap",
      "(min-|max-)?(width|height|inline-size|block-size)",
      "top", "right", "bottom", "left", "inset(-(inline|block)(-(start|end))?)?",
      "border(-(top|bottom)-(left|right))?-radius",
      "flex", "flex-basis",
      "grid-template-(columns|rows)", "grid-auto-(columns|rows)",
      "scroll-(margin|padding)(-(top|right|bottom|left))?",
    ].join("|") +
    ")$",
);

const PX = /(-?\d*\.?\d+)px\b/g;

/** 16 px = 1 rem, at most `digits` decimals, no leading zero (matches the house style). */
export function rem(px, digits = 4) {
  const v = Number((px / 16).toFixed(digits));
  return String(v).replace(/^(-?)0\./, "$1.") + "rem";
}

function convertValue(value, unit) {
  let n = 0;
  const out = value.replace(PX, (m, num) => {
    const v = Number(num);
    if (Math.abs(v) <= 2) return m;
    n++;
    return unit === "em" ? String(Number((v / 16).toFixed(4))).replace(/^0\./, ".") + "em" : rem(v);
  });
  return { out, n };
}

/** Converts one CSS text. Returns the new text and counts. */
export function convertCss(text) {
  let converted = 0;
  // Media queries: (max-width:640px) → (max-width:40em). em in a media query is the
  // reader's default font size, so breakpoints move with it.
  text = text.replace(/@media[^{]*\{/g, (q) => {
    const { out, n } = convertValue(q, "em");
    converted += n;
    return out;
  });
  // Declarations: `prop:value` up to `;` or `}`. Selectors never match (no px in them).
  text = text.replace(/(^|[{;\s])(--[\w-]+|-?[a-z][a-z-]*)(\s*:\s*)([^;{}]*?)(\s*)(\/\*\s*px\s*\*\/)?(?=[;}]|$)/gm, (m, pre, prop, colon, value, ws, keep) => {
    if (keep || !PX.test(value)) return m;
    PX.lastIndex = 0;
    let ok;
    if (prop.startsWith("--")) ok = /^\s*-?\d*\.?\d+px\s*$/.test(value);
    else ok = CONVERT.test(prop);
    if (!ok) return m;
    const { out, n } = convertValue(value, "rem");
    converted += n;
    return pre + prop + colon + out + ws + (keep ?? "");
  });
  return { text, converted };
}

/** px values left in a CSS text, by reason (for the report). */
export function keptPx(text) {
  return (text.match(PX) ?? []).length;
}

function main() {
  const check = process.argv.includes("--check");
  let total = 0;
  const rows = [];
  for (const f of targets()) {
    const src = fs.readFileSync(f, "utf8");
    const { text, converted } = convertCss(src);
    total += converted;
    rows.push([path.relative(ROOT, f), converted, keptPx(text)]);
    if (!check && text !== src) fs.writeFileSync(f, text);
  }
  for (const [f, c, k] of rows) console.log(`${String(c).padStart(5)} converted  ${String(k).padStart(4)} px kept  ${f}`);
  console.log(`${String(total).padStart(5)} converted in total${check ? " (check only, nothing written)" : ""}`);
  if (check && total) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
