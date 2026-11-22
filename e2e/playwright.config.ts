import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  globalSetup: "./global-setup.ts",
  // One shared server and host: run the specs one at a time so the 2 s
  // propagation budgets aren't measured on a starved machine.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /phone\.spec/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "webkit-phone",
      testMatch: /phone\.spec/,
      use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } },
    },
    {
      // docs/23 Mobile: the acceptance spec again on a small Android-like Chromium phone.
      name: "android-chromium",
      testMatch: /(s-mobile|t-mobile-blocks)\.phone\.spec/,
      use: { ...devices["Pixel 5"], viewport: { width: 360, height: 760 } },
    },
  ],
});
