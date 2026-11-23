// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The server serves the built editor at /app/ (docs/15 §1). In dev the SPA
// talks to the Rust server on :8080 through this proxy (docs/15 §8).
// OC_EDITOR_BASE overrides the base for a copy served elsewhere: the website's
// demo is built with OC_EDITOR_BASE=./ (relative, so it works at any path: the custom
// domain's /app/ and the local preview's /opencanvas/app/; .github/workflows/pages.yml).
// It must start and end with "/".
const base = process.env.OC_EDITOR_BASE || "/app/";
if (base !== "./" && !/^\/(.*\/)?$/.test(base)) throw new Error(`OC_EDITOR_BASE must be "./" or start and end with "/": ${base}`);

export default defineConfig({
  base,
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
    // scripts/check-budget.mjs reads it to sum the initial JS.
    manifest: true,
    // Every browser we support handles <link rel="modulepreload">; without it the
    // chunks still load, just without the preload hint.
    modulePreload: { polyfill: false },
    // Terser packs ~7 KB gzip tighter than esbuild on the initial JS (docs/02 §7).
    minify: "terser",
    terserOptions: { module: true, ecma: 2020, compress: { passes: 2 } },
    // Never inline font subsets into the render-blocking CSS: the browser only
    // fetches the unicode ranges a page actually uses.
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
    // Budget (docs/02 §7): the initial JS (entry + vendor chunks) stays under
    // 300 KB gzip; `pnpm build` fails over it (scripts/check-budget.mjs). Database,
    // board, gallery, comments, dialogs, exports, the Markdown parser, the demo
    // seed, menu icons, autolink, slash/mention suggestions and the drop/gap
    // cursors are dynamic imports.
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        // Stable vendor chunks that change less often than app code. Only
        // packages the entry needs anyway go here: putting a lazily used package
        // (lucide for the blocks, marked) in a manual chunk would pull it into
        // the initial load.
        manualChunks(id) {
          // Name the lazy block chunks after their packages.
          // Shared people helpers and types (docs/21): used at first paint, so never pulled
          // into the lazy database chunk as one of its dependencies.
          if (/[\\/]packages[\\/]ui[\\/]src[\\/]/.test(id)) return "ui";
          if (/[\\/]packages[\\/]database[\\/]src[\\/]/.test(id)) return "database";
          // Vite's preload helper goes with the entry's own chunk: when a lazy package chunk
          // has a dynamic import of its own (diagram mode), Rollup would otherwise put the
          // helper there and the entry would load that chunk eagerly.
          if (id.includes("vite/preload-helper")) return "ui";
          // Diagram mode (DGM-14): its own lazy chunk, loaded from the board chunk on open.
          if (/[\\/]packages[\\/]board[\\/]src[\\/]diagram[\\/]/.test(id)) return "diagram";
          if (/[\\/]packages[\\/]board[\\/]src[\\/]/.test(id)) return "board";
          if (!id.includes("node_modules")) return undefined;
          // Loaded lazily: desktop editing chrome (chrome.tsx), table editing (table.ts),
          // code highlighting (highlight.ts), autolink and the slash / @mention
          // suggestions (late.ts). They must not match a manual chunk below, or they
          // would be pulled into the initial load.
          if (/[\\/]node_modules[\\/](@floating-ui[\\/]|@tiptap[\\/]extension-code-block-lowlight[\\/]|lowlight[\\/]|highlight\.js[\\/]|@tiptap[\\/](extension-drag-handle|extension-drag-handle-react|extension-node-range|extension-bubble-menu|extension-floating-menu|extension-link|extension-mention|suggestion|starter-kit)[\\/]|linkifyjs[\\/]|@tiptap[\\/]react[\\/]dist[\\/]menus|prosemirror-(tables|gapcursor|dropcursor)[\\/]|@tiptap[\\/]pm[\\/]dist[\\/](tables|gapcursor|dropcursor))/.test(id)) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          if (/[\\/]node_modules[\\/](yjs|lib0|y-protocols|y-websocket)[\\/]/.test(id)) return "yjs";
          // y-tiptap binds ProseMirror to Yjs, so it lives with ProseMirror (in the yjs chunk
          // it made the circular chunk import tiptap -> yjs -> tiptap).
          if (/[\\/]node_modules[\\/](prosemirror-[^\\/]+|@tiptap[\\/](core|pm|react|y-tiptap|extension-[^\\/]+|extensions)|orderedmap|rope-sequence|w3c-keyname|fast-equals|use-sync-external-store)[\\/]/.test(id)) return "tiptap";
          return undefined;
        },
      },
    },
  },
});
