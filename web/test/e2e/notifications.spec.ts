import { test, expect, type Page } from "@playwright/test";

// The two notification surfaces that only ever appear in reaction to a live SSE push: the
// "update available" offer and the "you're behind" bell entry. Both are unreachable from a
// normal browsing session (one needs a newer build to exist on the update remote, the other
// needs a repo to fall behind between background syncs), so here the daemon's SSE stream is
// stubbed and the real frames it would broadcast are replayed into a real browser. Everything
// downstream of the wire — store handler, bell, prompt, and the buttons — is the real app.
//
// Requires the same running daemon + Vite dev server as sse.spec.ts (see playwright.config.ts);
// every request other than /api/events still goes to the live daemon.

/** Replay canned SSE frames. `frames(n)` is the body for the n-th connection — VueUse reconnects
 *  when a stream ends, so returning "" for n > 0 announces exactly once, and returning the same
 *  frame every time re-announces on every reconnect (which is how the re-nag guard is tested). */
async function stubEvents(page: Page, frames: (connection: number) => string): Promise<void> {
  let n = 0;
  await page.route("**/api/events*", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: frames(n++),
    });
  });
}

const updateFrame = (canApply: boolean, reason: string | null, to = "2222222"): string =>
  `event: update_available\ndata: ${JSON.stringify({ from: "1111111", to, canApply, reason })}\n\n`;

const behindFrame = (repos: { id: string; name: string; behind: number }[]): string =>
  `event: repo_behind\ndata: ${JSON.stringify({ repos })}\n\n`;

test("an available update offers itself and installs only when asked", async ({ page }) => {
  // Nothing may install without a click — record whether the apply endpoint was ever hit.
  let applyCalls = 0;
  await page.route("**/api/updates/apply", async (route) => {
    applyCalls++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, message: "Updated.", restartRequired: true, output: [] }),
    });
  });
  await stubEvents(page, (n) => (n === 0 ? updateFrame(true, null) : ""));

  await page.goto("/");

  // The offer arrives on its own — this is the surface that never appeared in manual testing.
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Update available")).toBeVisible();
  await expect(dialog.getByText(/newer version of RepoYeti is ready/)).toBeVisible();
  expect(applyCalls, "showing the offer must not install anything").toBe(0);

  // "Later" is a deferral, not a decision: the prompt closes, the bell entry survives.
  await dialog.getByRole("button", { name: "Later" }).click();
  await expect(dialog).toBeHidden();
  expect(applyCalls, "declining must not install anything").toBe(0);

  const bell = page.getByRole("button", { name: "Notifications" });
  await bell.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByText("Update available")).toBeVisible();

  // …and it's a way back to the offer, so a "Later" is recoverable without waiting for the
  // next scheduled check.
  await menu.getByRole("button", { name: "Review update" }).click();
  await expect(dialog.getByText("Update available")).toBeVisible();

  // Only now does anything install.
  await dialog.getByRole("button", { name: "Update now" }).click();
  await expect.poll(() => applyCalls).toBe(1);
  await expect(dialog).toBeHidden();

  // A finished install retires the offer — the bell entry no longer describes reality.
  await bell.click();
  await expect(page.getByRole("menu").getByText("Update available")).toBeHidden();
});

test("an update that can't be installed says why and refuses to install", async ({ page }) => {
  let applyCalls = 0;
  await page.route("**/api/updates/apply", async (route) => {
    applyCalls++;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  const reason = "local changes must be committed or stashed before updating";
  await stubEvents(page, (n) => (n === 0 ? updateFrame(false, reason) : ""));

  await page.goto("/");

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/can't be installed right now/)).toBeVisible();
  await expect(dialog.getByText(reason)).toBeVisible();
  // The button is the gate: a dirty tree is the owner's to resolve, and the update waits.
  await expect(dialog.getByRole("button", { name: "Update now" })).toBeDisabled();
  expect(applyCalls).toBe(0);
});

test("the Settings version badge is a second way in to the same offer", async ({ page }) => {
  // Issue #20: on an installed PWA, Settings is often the only interface there is — being told an
  // update exists with nothing to click beside it means waiting hours for the scheduled apply,
  // with no terminal to fall back on. Worth an E2E because the offer is a MODAL raised from
  // inside the Settings push panel, which no unit test lays out.
  //
  // The Version row is drawn from /api/updates, and it compares the installed version against the
  // running daemon's — a stub inventing a currentVersion reads as "Restart to finish" instead, a
  // different (and equally real) state. So take the version from the daemon that's answering.
  const { version } = (await (await page.request.get("/api/status")).json()) as { version: string };
  await page.route("**/api/updates", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        service: "repoyeti",
        currentVersion: version,
        currentCommit: "1111111",
        remoteCommit: "2222222",
        branch: "main",
        upstream: "origin/main",
        remote: "origin",
        dirty: false,
        updateAvailable: true,
        canApply: true,
        checkedAt: 0,
        reason: null,
      }),
    });
  });
  await stubEvents(page, (n) => (n === 0 ? updateFrame(true, null) : ""));

  await page.goto("/");

  // Dismiss the offer that arrives on its own — Settings is the way BACK to it under test here.
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Later" }).click();
  await expect(dialog).toBeHidden();

  // Header ⋮ → Settings, which opens on General (where the Version row lives).
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();

  const badge = page.getByTestId("update-available");
  await expect(badge).toBeVisible();
  await badge.click();

  // It opens the existing offer rather than installing — the dialog still owns that decision.
  await expect(dialog.getByRole("button", { name: "Update now" })).toBeVisible();

  // And the changelog is reachable from the same row, so "what changed?" is answerable here too.
  await expect(page.getByTestId("changelog-link")).toHaveAttribute(
    "href",
    "https://github.com/LunarWerxs/RepoYeti/blob/main/CHANGELOG.md",
  );
});

test("a re-announced update doesn't reopen a prompt that was dismissed", async ({ page }) => {
  // Every reconnect re-announces — the scheduled check running again a few hours later.
  //
  // The commit varies per announcement DELIBERATELY. A byte-identical frame never reaches the
  // store at all: the SSE payload lands in a ref that a `watch` reacts to, and re-assigning the
  // same string isn't a change, so the handler is never invoked. A test built on identical
  // frames therefore passes even with the re-nag guard deleted (confirmed by mutation) — it
  // proves VueUse dedupes, not that the app behaves. Varying the SHA puts the guard itself
  // under test, and is the harder case besides: a genuinely new build, still not a reason to
  // reopen a modal the owner already dismissed.
  await stubEvents(page, (n) => updateFrame(true, null, `222222${n}`));

  await page.goto("/");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Update available")).toBeVisible();
  await dialog.getByRole("button", { name: "Later" }).click();
  await expect(dialog).toBeHidden();

  // Reconnect delay is 2500ms, so this spans several re-announcements. A build the owner
  // declined must not pop a modal at them every few hours.
  await page.waitForTimeout(8000);
  await expect(dialog).toBeHidden();

  // The bell entry is still there, though — declining doesn't lose the update.
  await page.getByRole("button", { name: "Notifications" }).click();
  await expect(page.getByRole("menu").getByText("Update available")).toBeVisible();
});

test("falling behind raises a bell entry that can pull right there", async ({ page }) => {
  let pullCalls = 0;
  await page.route("**/api/repos/*/pull", async (route) => {
    pullCalls++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, code: "OK", message: "pulled" }),
    });
  });
  await stubEvents(page, (n) =>
    n === 0 ? behindFrame([{ id: "demo-repo", name: "demo", behind: 3 }]) : "",
  );

  await page.goto("/");

  // The bell is where this LIVES — a persistent entry, not just a toast that expires.
  const bell = page.getByRole("button", { name: "Notifications" });
  await bell.click();
  const menu = page.getByRole("menu");
  // The REPO names the entry; the description says what happened to it. A generic "Behind
  // remote" title left the one unguessable fact — which repo — buried in the body.
  await expect(menu.getByText("demo", { exact: true })).toBeVisible();
  await expect(menu.getByText(/3 commits behind its remote/)).toBeVisible();

  // …and it's actionable without leaving the flyout.
  await menu.getByRole("button", { name: "Pull now" }).click();
  await expect.poll(() => pullCalls).toBe(1);

  // A successful pull resolves the entry: there's nothing left to act on.
  await expect(page.getByText("Pulled 1 repo")).toBeVisible();
  await bell.click();
  await expect(page.getByRole("menu").getByText("Behind remote")).toBeHidden();
});
