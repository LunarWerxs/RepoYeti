import { test, expect } from "@playwright/test";

// The dashboard opens an SSE stream to the daemon for live updates. This E2E proves that channel
// comes up end-to-end through a real browser → daemon.
//
// It does NOT assert the little live/offline dot: that indicator is scoped to the remote-access
// button and renders only when the daemon is in REMOTE mode (see AppHeader.vue — `v-if="store.mode
// === 'remote'"`). Against a local daemon it never exists, so an unconditional assertion on it
// fails for a reason that has nothing to do with SSE. The stream itself is checked directly, which
// holds in both modes; the dot is checked only where it is meant to exist.
test("dashboard connects to the live-update SSE stream", async ({ page }) => {
  // The EventSource handshake — the browser opened it and the daemon accepted it as a stream.
  const streamed = page.waitForResponse(
    (r) =>
      r.url().includes("/api/events") &&
      r.status() === 200 &&
      (r.headers()["content-type"] ?? "").includes("text/event-stream"),
    { timeout: 15_000 },
  );

  await page.goto("/");
  await streamed;

  // And the repo list rendered, which only happens after the API returned data.
  await expect(page.getByText(/\d+ repos?/)).toBeVisible();

  // In remote mode the header also shows a live/offline dot; assert it flips to connected there.
  const dot = page.getByRole("status", { name: "Connected: live updates" });
  const remote = await page
    .getByRole("button", { name: "Connection" })
    .evaluate((el) => el.querySelector(".text-info") !== null)
    .catch(() => false);
  if (remote) await expect(dot).toBeVisible();
});
