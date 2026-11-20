import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The server serves the built editor at /app/ (docs/15 §1). In dev the SPA
// talks to the Rust server on :8080 through this proxy (docs/15 §8).
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/v1": { target: "http://localhost:8080", changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1400,
  },
});
