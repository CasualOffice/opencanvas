// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Workspace web app (ADR-085, docs/40): served by `opencanvas-workspace` at /ws/.
// In dev it talks to a running `opencanvas-workspace` on :8080 through this proxy.
export default defineConfig({
  base: "/ws/",
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:8080" },
      "/v1": { target: "http://localhost:8080", ws: true },
      "/app": { target: "http://localhost:8080" },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, target: "es2022" },
});
