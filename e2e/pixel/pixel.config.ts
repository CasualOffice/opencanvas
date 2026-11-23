// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SCALE-01 pixel suite: the main screens at 100% zoom and the default 16 px root font,
// light and dark, desktop and 390 px phone, compared pixel for pixel against a baseline
// taken from another build. It proves a refactor (px → rem) leaves the default look alone.
// Not part of `npm run e2e`: baselines are per machine (fonts, GPU), so they are taken and
// compared on the same machine, in one sitting:
//
//   # 1. baseline from the old build (a copy of web/packages/editor/dist)
//   PIXEL_DIST=/path/dist-before PIXEL_SNAPS=/path/snaps npx playwright test -c pixel/pixel.config.ts --update-snapshots
//   # 2. the new build against it (maxDiffPixels 0)
//   PIXEL_DIST=../web/packages/editor/dist PIXEL_SNAPS=/path/snaps npx playwright test -c pixel/pixel.config.ts
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const dist = path.resolve(process.env.PIXEL_DIST ?? path.join(import.meta.dirname, "../../web/packages/editor/dist"));
const snaps = path.resolve(process.env.PIXEL_SNAPS ?? path.join(import.meta.dirname, "../test-results/pixel-snaps"));

const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } };
const phone = { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } };

export default defineConfig({
  testDir: ".",
  testMatch: /pixel\.spec\.ts$/,
  workers: 2,
  retries: 0,
  timeout: 60_000,
  reporter: "list",
  snapshotPathTemplate: `${snaps}/{projectName}/{arg}{ext}`,
  expect: { toHaveScreenshot: { maxDiffPixels: 0, threshold: 0, animations: "disabled", caret: "hide" } },
  use: { baseURL: "http://127.0.0.1:4290", actionTimeout: 10_000 },
  webServer: {
    command: `node ${JSON.stringify(path.join(import.meta.dirname, "serve-dist.mjs"))} ${JSON.stringify(dist)} 4290`,
    url: "http://127.0.0.1:4290/healthz",
    reuseExistingServer: false,
  },
  projects: [
    { name: "desktop-light", use: { ...desktop, colorScheme: "light" } },
    { name: "desktop-dark", use: { ...desktop, colorScheme: "dark" } },
    { name: "phone-light", use: { ...phone, colorScheme: "light" } },
    { name: "phone-dark", use: { ...phone, colorScheme: "dark" } },
  ],
});
