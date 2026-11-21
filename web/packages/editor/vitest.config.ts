// Unit tests only; kept apart from vite.config.ts (build chunking, terser).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "jsdom" },
});
