// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Unit tests only; kept apart from vite.config.ts (build chunking, terser).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "jsdom" },
});
