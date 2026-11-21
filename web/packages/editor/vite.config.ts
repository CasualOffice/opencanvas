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
    // Never inline font subsets into the render-blocking CSS: the browser only
    // fetches the unicode ranges a page actually uses.
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
    // Budget (docs/02 §7): the initial JS (entry + vendor chunks) stays under
    // 300 KB gzip. Database, board, gallery, comments, dialogs, exports, the
    // Markdown parser and the demo seed are dynamic imports.
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        // Stable vendor chunks that change less often than app code. Only
        // packages the entry needs anyway go here: putting a lazily used package
        // (lucide for the blocks, marked) in a manual chunk would pull it into
        // the initial load.
        manualChunks(id) {
          // Name the lazy block chunks after their packages.
          if (/[\\/]packages[\\/]database[\\/]src[\\/]/.test(id)) return "database";
          if (/[\\/]packages[\\/]board[\\/]src[\\/]/.test(id)) return "board";
          if (!id.includes("node_modules")) return undefined;
          // Loaded lazily: desktop editing chrome (chrome.tsx), table editing (table.ts)
          // and code highlighting (highlight.ts).
          if (/[\\/]node_modules[\\/](@floating-ui[\\/]|@tiptap[\\/]extension-code-block-lowlight[\\/]|lowlight[\\/]|highlight\.js[\\/]|@tiptap[\\/](extension-drag-handle|extension-drag-handle-react|extension-node-range|extension-bubble-menu|extension-floating-menu)[\\/]|@tiptap[\\/]react[\\/]dist[\\/]menus|prosemirror-tables[\\/]|@tiptap[\\/]pm[\\/]dist[\\/]tables)/.test(id)) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          if (/[\\/]node_modules[\\/](yjs|lib0|y-protocols|y-websocket|@tiptap[\\/]y-tiptap)[\\/]/.test(id)) return "yjs";
          if (/[\\/]node_modules[\\/](prosemirror-[^\\/]+|@tiptap[\\/](core|pm|react|starter-kit|extension-[^\\/]+|extensions|suggestion)|linkifyjs|@floating-ui[\\/][^\\/]+|orderedmap|rope-sequence|w3c-keyname|fast-equals|use-sync-external-store)[\\/]/.test(id)) return "tiptap";
          return undefined;
        },
      },
    },
  },
});
