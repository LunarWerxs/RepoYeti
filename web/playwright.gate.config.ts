import { defineConfig, devices } from "@playwright/test";

/**
 * The RELEASE browser gate: small, isolated, and safe to run anywhere.
 *
 * playwright.config.ts (test/e2e) is the developer suite. It points at a Vite dev server on
 * :4319 and expects a live daemon with the owner's real repositories, so it can neither run in
 * CI nor be pointed at a release candidate without writing into the owner's database. This
 * config is the opposite: test/browser-gate/global-setup.ts builds the entire world — an
 * isolated daemon on an ephemeral port with a throwaway state directory, three scratch git
 * repositories, and a second loopback origin — and tears it down afterwards.
 *
 * It covers only the behaviours that a browser is the ONLY witness to (see the header of
 * global-setup.ts): the exact-origin refusal, reconnect hydration, and menus landing on screen.
 * Deliberately not a general end-to-end suite: a broad flaky one that nobody trusts is worse
 * than the three unit-invisible facts this holds.
 *
 * No baseURL. Every spec navigates to an absolute origin from the handoff, because which origin
 * a request comes from is the subject of the first spec rather than an ambient default.
 */
export default defineConfig({
  testDir: "./test/browser-gate",
  globalSetup: "./test/browser-gate/global-setup.ts",
  // One daemon, one dashboard, shared state: the specs register repositories and take the page
  // offline, so they must not interleave.
  fullyParallel: false,
  workers: 1,
  // Generous, because the first spec waits on a real daemon boot behind it, and CI runners are
  // slower than a developer machine by more than the usual margin on process startup.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // A gate that passes on a retry is not a gate. If one of these three is flaky, that is the
  // finding.
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  use: { trace: process.env.CI ? "retain-on-failure" : "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
