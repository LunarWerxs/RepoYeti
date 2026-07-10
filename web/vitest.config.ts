import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";

// Dedicated test config (kept separate from vite.config.ts so the PWA / proxy / icon plugins —
// none of which the unit + component tests need — stay out of the test pipeline). The `@` alias
// mirrors vite.config.ts. Playwright E2E specs live under test/e2e and run via `playwright test`,
// so they're excluded here.
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
    exclude: ["test/e2e/**", "node_modules/**"],
  },
});
