// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Diagram-scale measurements (DGM-02). Not part of `pnpm test`: run `pnpm --filter @opencanvas/board bench`.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: fileURLToPath(new URL("..", import.meta.url)),
    include: ["bench/**/*.measure.ts", "bench/**/*.measure.tsx"],
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
    pool: "forks",
    fileParallelism: false,
    execArgv: ["--expose-gc", "--max-old-space-size=8192"],
  },
});
