#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Builds the sample block packages (BSDK-04) from samples/<name>/{main.ts, block.json}:
//   oc.progress → crates/oc-server/blocks/oc.progress/ (first-party, compiled into the server)
//   acme.okr    → examples/blocks/acme.okr/            (a third-party package for OC_BLOCKS_DIR)
// Each package gets block.js (one IIFE bundle, the SDK included), block.json with the bundle's
// sha384 `integrity`, and, when the manifest names one, a generated preview.png.
//
//   node scripts/build-samples.mjs          write the packages
//   node scripts/build-samples.mjs --check  fail when a committed package differs from a build
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const ROOT = path.resolve(PKG, "../../..");
const SAMPLES = [
  { name: "progress", out: "crates/oc-server/blocks/oc.progress" },
  { name: "okr", out: "examples/blocks/acme.okr" },
];
const check = process.argv.includes("--check");

const BANNER = "// SPDX-License-Identifier: Apache-2.0\n// Copyright 2026 CasualOffice\n// Built by web/packages/block-sdk/scripts/build-samples.mjs; do not edit.";

/** A small PNG preview (decision 7): a card with a title bar and three progress rows. */
function previewPng(w = 320, h = 200) {
  const px = Buffer.alloc(w * h * 4);
  const fill = (x0, y0, x1, y1, [r, g, b]) => {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
      }
  };
  fill(0, 0, w, h, [251, 251, 250]);
  fill(20, 22, 200, 36, [24, 24, 27]);
  fill(250, 22, 300, 36, [42, 90, 215]);
  [0.62, 0.4, 0.85].forEach((p, i) => {
    const y = 64 + i * 40;
    fill(20, y, 150, y + 10, [85, 85, 92]);
    fill(170, y, 300, y + 10, [236, 241, 253]);
    fill(170, y, 170 + Math.round(130 * p), y + 10, [42, 90, 215]);
  });
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

let bad = 0;
for (const s of SAMPLES) {
  const dir = path.join(PKG, "samples", s.name);
  const res = await build({
    entryPoints: [path.join(dir, "main.ts")],
    bundle: true,
    format: "iife",
    target: "es2020",
    minify: true,
    legalComments: "none",
    banner: { js: BANNER },
    write: false,
    logLevel: "error",
  });
  const js = Buffer.from(res.outputFiles[0].text);
  const sri = "sha384-" + crypto.createHash("sha384").update(js).digest("base64");
  const manifestText = fs.readFileSync(path.join(dir, "block.json"), "utf8").replace("@SRI@", sri);
  const files = { "block.js": js, "block.json": Buffer.from(manifestText) };
  if (JSON.parse(manifestText).preview) files["preview.png"] = previewPng();
  const out = path.join(ROOT, s.out);
  for (const [f, bytes] of Object.entries(files)) {
    const p = path.join(out, f);
    if (check) {
      if (!fs.existsSync(p) || !fs.readFileSync(p).equals(bytes)) {
        console.error(`build-samples: ${path.relative(ROOT, p)} is out of date; run node web/packages/block-sdk/scripts/build-samples.mjs`);
        bad++;
      }
    } else {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(p, bytes);
    }
  }
  if (!check) console.log(`build-samples: ${s.out} (${js.length} bytes, ${sri})`);
}
process.exit(bad ? 1 : 0);
