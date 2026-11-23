// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DGM-14: diagram mode in the browser. Its own config (no server stack): the built editor is
// served statically and opened in `#demo` mode (the production bundle with a local Y.Doc), so it
// runs next to other agents' suites without the shared ports.
//
//   cd e2e && npx playwright test -c diagram/playwright.config.ts
//   E2E_SKIP_BUILD=1 reuses web/packages/editor/dist
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /\.spec\.ts$/,
  globalSetup: "./setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "desktop", testIgnore: /\.phone\.spec\.ts$/, use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    // S11: a 390 px phone (Chromium with touch, so it runs next to the desktop project without WebKit).
    { name: "phone", testMatch: /\.phone\.spec\.ts$/, use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
  ],
});
