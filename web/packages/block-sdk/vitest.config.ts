// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "jsdom" },
});
