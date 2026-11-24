// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DGM-10: browser frame times for large boards. Not part of the e2e suite (its own config, no
// server stack): the built editor is served statically and opened in `#demo` mode, which is the
// production bundle with a local Y.Doc.
//
//   cd e2e && npx playwright test -c perf/playwright.config.ts
//
//   E2E_SKIP_BUILD=1   reuse web/packages/editor/dist (else `pnpm --filter @opencanvas/editor build`)
//   PERF_DIST=<dir>    serve another build (e.g. a copy of the "before" dist)
//   PERF_SIZES=1000,5000,10000   node counts (edges = 1.5 × nodes, bench/fixtures.ts)
//   PERF_LABEL=<name>  results/frames-<name>.json
//   PERF_TRACE=1       also save a Chromium performance trace per scenario under results/traces
//   PERF_ONLY=fit      only the fit-view scenarios (panFit, zoomFit, drag1Fit)
//   PERF_SHOT=1        also save a screenshot of the fit view under results/shots
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /\.perf\.ts$/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30 * 60_000,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
});
