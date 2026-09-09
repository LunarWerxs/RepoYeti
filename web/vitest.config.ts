import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";

// Dedicated test config (kept separate from vite.config.ts so the PWA / proxy / icon plugins —
// none of which the unit + component tests need — stay out of the test pipeline). The `@` alias
// mirrors vite.config.ts. Playwright specs live under test/e2e (the developer suite, needs a
// dev server + a live daemon) and test/browser-gate (the release gate, boots its own isolated
// daemon), both run via `playwright test`, so both are excluded here. Leaving browser-gate in
// would hand its `.spec.ts` files to happy-dom, where `@playwright/test` is not a thing.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.{test,spec}.ts"],
    exclude: ["test/e2e/**", "test/browser-gate/**", "node_modules/**"],
  },
});
