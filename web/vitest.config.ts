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
    // Mirrors vite.config.ts: `@` is the app's own src, `@daemon` is the daemon's src tree (one
    // crossing: the identity-firewall mirror importing the daemon's glob matcher).
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@daemon": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
  test: {
    pool: 'forks',
    // 104 happy-dom files, most of their time in environment setup: paired on the shared box, 8 workers ran 40 s
    // at 2.2 GB peak where 4 ran 55 s at 1.7 GB and an unbounded pool 21-42 s at 4.8 GB with a timing flake.
    maxWorkers: 8,
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.{test,spec}.ts"],
    exclude: ["test/e2e/**", "test/browser-gate/**", "node_modules/**"],
    // `bun run test:coverage` (CI and the release gate). The daemon has had a line floor since 1.0;
    // the dashboard had none, so a PR could delete a component's every test and stay green (1.0
    // audit, delivery P2). Thresholds are a FLOOR set just under the measured baseline: they stop a
    // slide, they are not a target. Raise them when coverage rises; never lower one to pass a PR.
    // Excluded: the vendored kit (tested upstream in lunarwerx-ui), locale data, and the entry file.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,vue}"],
      // file-icons.ts is an icon lookup table the v8 remapper cannot parse; it has no logic to cover.
      exclude: ["src/components/ui/**", "src/locales/**", "src/**/*.d.ts", "src/main.ts", "src/lib/file-icons.ts"],
      reporter: ["text-summary"],
      // Measured 2026-09-22 at 627 tests: statements 57.6, branches 54.6, functions 47.5, lines 59.0.
      thresholds: { statements: 56.5, branches: 53.5, functions: 46.5, lines: 58 },
    },
  },
});
