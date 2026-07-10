import { test, expect } from "@playwright/test";

// The dashboard opens an SSE stream to the daemon for live updates; the header shows
// "Connected — live updates" once the EventSource is open. This E2E proves that live-update channel
// comes up end-to-end through a real browser → Vite proxy → daemon SSE. Requires a running daemon +
// Vite dev server on the baseURL (see playwright.config.ts).
test("dashboard connects to the live-update SSE stream", async ({ page }) => {
  await page.goto("/");

  // The connection status is a role="status" node whose aria-label flips to this once the
  // EventSource handshake completes (driven by the daemon over the proxied /api SSE endpoint).
  await expect(page.getByRole("status", { name: "Connected — live updates" })).toBeVisible();

  // And the repo list rendered, which only happens after the proxied API + SSE returned data.
  await expect(page.getByText(/\d+ repos?/)).toBeVisible();
});
