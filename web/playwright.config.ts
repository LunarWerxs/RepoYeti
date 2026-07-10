import { defineConfig, devices } from "@playwright/test";

// End-to-end config. Targets a running web dev server (Vite on :4319) that proxies /api + /oauth to
// a live daemon — start BOTH before `bun run test:e2e`, since the SSE live-update flow needs the
// real daemon (one-time browser install: `bunx playwright install chromium`). baseURL is overridable
// via PLAYWRIGHT_BASE_URL. Kept out of the Vitest run (vitest.config.ts excludes test/e2e).
export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:4319",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
