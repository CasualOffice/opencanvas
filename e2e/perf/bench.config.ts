// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// BENCH-03: the browser benchmarks (first-screen.bench.ts). Not part of the e2e suite: it
// starts its own release server and mock host on 9211/9212 (+ E2E_PORT_SHIFT).
//
//   cd e2e && npx playwright test -c perf/bench.config.ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /\.bench\.ts$/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60 * 60_000,
  reporter: "list",
  use: { ...devices["Desktop Chrome"] },
});
