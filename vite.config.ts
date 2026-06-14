import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [svelte()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // 4. Resolve aliases for src/lib
  resolve: {
    alias: {
      $lib: "/src/lib",
    },
  },

  // 5. Bundle splitting for legible chunk report (T3.3 — WS-A-owned, additive).
  //
  //    manualChunks groups highlight.js core + its language files into a single
  //    named "hljs" chunk, and mermaid into a named "mermaid" chunk, so the
  //    chunk report clearly shows the size of each lazy-loaded renderer.
  //
  //    NOTE: mermaid's per-diagram lazy chunks (flowDiagram-*, classDiagram-*,
  //    etc.) are produced by mermaid's own internal dynamic import() calls and
  //    are NOT further re-grouped here — they already have readable names from
  //    the mermaid source. Only the mermaid.core entry itself is named.
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // highlight.js/lib/core + all language files → single "hljs" chunk.
          if (id.includes("highlight.js")) {
            return "hljs";
          }
          // mermaid entry chunk → named "mermaid" chunk (diagram sub-chunks
          // remain split by mermaid's own dynamic imports).
          if (
            id.includes("node_modules/mermaid/") &&
            !id.includes("/chunks/mermaid")
          ) {
            return "mermaid";
          }
        },
      },
    },
  },
}));
