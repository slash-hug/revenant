import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte({ hot: !process.env.VITEST })],
  test: {
    // Use jsdom as the test environment for Svelte components
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/tests/setup.ts"],
    include: ["src/tests/**/*.test.ts", "src/**/*.test.ts"],
    alias: {
      $lib: "/src/lib",
    },
  },
  resolve: {
    alias: {
      $lib: "/src/lib",
    },
  },
});
